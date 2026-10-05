"""cockpit.server —— L7 驾驶舱后端：零依赖 HTTP + SSE。

设计依据：``docs/技术方案_闭环驾驶舱.md`` §5.5/§5.6/§17、``docs/ICD_cockpit_events.md``。

**为什么必须零第三方依赖**（§5.6 / N3）：
"clone 下来只装 Python 也能跑"是 README 的卖点。驾驶舱不能把它吃掉，
所以 HTTP 用 ``http.server``、推送用 SSE、JSON 用 ``json``。
前端另有一份 ``dist/``（构建产物已入仓），**运行时**同样不需要 Node。

**第一硬约束（§5.1，K1）**：长任务绝不能在本进程里跑。
``builder._run()`` 是 ``subprocess.run(capture_output=True)``，塞进服务端线程会把
HTTP 服务拖死、SSE 推不出去（``flash.debug`` 起 openocd 时还要阻塞 20s 等端口）。
故：**spawn 一个 ``elab run --emit-events`` 子进程，本进程只做"跟读只追加文件 + 转发 SSE + 取消"**。
"""

from __future__ import annotations

import json
import mimetypes
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
if str(_ROOT / "services") not in sys.path:
    sys.path.insert(0, str(_ROOT / "services"))

from elab import run as run_mod                      # noqa: E402
from elab import serialconsole as serialconsole_mod  # noqa: E402
from elab import serialport as serialport_mod        # noqa: E402
from elab import serialterm as serialterm_mod        # noqa: E402
from elab.config import Config, ElabError, to_fwd     # noqa: E402
from elab.kernel import events as ev_mod              # noqa: E402

HOST = "127.0.0.1"            # ★ 只监听本地（§5.6：本地工具，不做远程暴露）
DEFAULT_PORT = 3333
SSE_HEARTBEAT_S = 15.0        # §17.3
PROC_BATCH_S = 0.10           # §17.3：proc 行 100ms 合并，事件数降 1~2 个数量级
QUEUE_MAX = 2000              # §17.3：每连接有界队列
MAX_SSE_CONNS = 8
DIST_DIR = _HERE / "web" / "dist"
COCKPIT_VERSION = "0.1.0-m1"

#: 服务端可能通过 SSE 发出的**命名事件**全集（跨端契约的镜像）。
#:
#: ★ 为什么必须在这里再列一遍（而不是"从代码里自然得到"）：
#:   SSE 用的是**命名事件**，`EventSource.onmessage` 只接收**没有** `event:`
#:   字段的帧，所以前端必须为每个 topic 显式 `addEventListener`。漏一个，
#:   该 topic 的全部事件在浏览器里**静默消失** —— 不报错、`onerror` 不触发、
#:   服务端日志也一切正常（ICD §6.1）。
#:   实测事故：前端白名单漏了 `proc/stdout-batch`，于是 **run 跑起来之后所有
#:   实时编译日志都不可见**；而同一个 run 结束后再看（走按 seq 重放分支、
#:   逐条 `proc/stdout`）却是全的 —— 这个"历史有、实时没有"的不对称极难归因。
#:
#: 谁在守它：
#:   ① `_sse_warn_unknown()` —— 真发出未登记 topic 时打一条 WARN（把静默变有声）；
#:   ② `tests/it_cockpit_server.py::test_known_topics_covers_server_emitted`
#:      —— 与前端 `KNOWN_TOPICS` 做集合比对，CI 层拦截。
SSE_TOPICS = frozenset({
    "run/start", "run/step-enter", "run/step-exit", "run/end", "run/cancel",
    "proc/stdout", "proc/stderr", "proc/stdout-batch", "proc/exit",
    "serial/open", "serial/line", "serial/close", "serial/error",
    "serial/closed-loop",
    "stream/overrun", "stream/closed",
})


#: 服务端**合成**（不写事件日志）的 topic。它们不在 ``kernel.events`` 里，
#: 因为它们是"父进程对这条流的观察"，不是 run 自己的事实。
SYNTHETIC_TOPICS = frozenset({"stream/closed", "stream/overrun"})

#: 其中**绝不可丢**的那一个。
#:
#: ★ ``stream/closed`` 的 ``is_activity()`` 是 **True**（它前缀是 ``stream/``，
#:   非 ``run/``），于是队列一满它就会被当成"可丢的活动事件"丢掉 ——
#:   而它恰恰是浏览器**唯一**的"run 结束了、可以收尾了"信号
#:   （``sse.ts`` 收到它才 ``es.close()`` + 回调 ``onClosed``）。
#:   丢掉它的后果：``markStreamClosed`` 永不触发，界面**永远显示"运行中"**、
#:   取消按钮永远亮着，而进程早就没了。
#:   唯一的兜底是心跳分支（``heartbeats > 8`` ≈ 2 分钟）后断开连接，
#:   让浏览器重连走"已结束 run 的重放分支" —— 也就是说：
#:   **恢复要两分钟，且表现为"卡住"而不是"报错"**。
#:   故把它明确划进"不可丢"（与 ``run/*`` 同级）。
CONTROL_TOPICS = frozenset({"stream/closed"})


# ══════════════════════════════════════════════════════════════════
#  Run 管理：spawn / 跟读 / 取消（§5.1）
# ══════════════════════════════════════════════════════════════════
@dataclass
class ActiveRun:
    #: 以下四个是**临时占位**：``run/start`` 一落盘就以日志为准（见 ``list_active``）。
    #: 留着它们只是为了覆盖"子进程刚 spawn、首行还没刷出来"的那几百毫秒窗口。
    run_id: str
    project: str
    steps: list[str]
    actor: str
    #: 以下三个只有进程内拿得到 —— 日志里没有也不该有，故**必须**留在内存。
    proc: subprocess.Popen
    started_at: float
    subscribers: set = field(default_factory=set)
    lock: threading.Lock = field(default_factory=threading.Lock)
    #: 背压统计：给 UI 显示"日志已截断"用（§17.3）。
    #: ★ 这是**run 级**计数（跨订阅者累加），`/api/runs.active` 直接读它。
    dropped: int = 0
    last_seq: int = 0
    #: 每个订阅者队列的溢出状态：``id(q) -> {"armed": bool, "marker": dict|None}``。
    #: 键用 ``id(q)`` 是安全的 —— q 在整个订阅期都被 ``subscribers`` 持有，
    #: 期间地址不会变也不会被回收（``unsubscribe`` 会同步清掉这条）。
    sub_state: dict = field(default_factory=dict)

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None


class RunManager:
    """run 登记簿 + 事件扇出。

    登记簿（``_active``）记的是**本进程起过的 run**；子进程退出、follower 收尾后
    会把自己摘掉，故它长期看只包含"在跑的"。对外报"活动 run"的是
    :meth:`list_active`，它还会再过滤一次 ``alive``（见该方法的说明）。

    一个 run 一个 follower 线程：它用 ``kernel.events.follow`` 跟读
    ``<id>.jsonl`` + ``<id>.proc.jsonl``（**按 seq 归并**），再推给所有订阅者。
    子进程退出后，follower 补发一条 ``stream/closed`` 让浏览器**主动断开**
    （否则 EventSource 会不停重连一个已结束的 run）。

    ★ 登记簿**不是**真相：真相是事件日志（契约 §5.3）。``_active`` 里除
      ``proc``/``alive``/``last_seq`` 这几个"只有进程内才有"的句柄之外，
      其余元数据都在 ``run/start`` 里逐字存在，且以那份为准（见 :meth:`list_active`）。
      这条纪律是 N9 换来的：两份真相迟早会分叉。
    """

    def __init__(self, cfg: Config, *, log=print):
        self.cfg = cfg
        self.runs_dir = run_mod.runs_dir_for(cfg)
        self.log = log
        self._active: dict[str, ActiveRun] = {}
        self._lock = threading.Lock()

    # ── 查询 ────────────────────────────────────────────────────
    def active(self, run_id: str) -> ActiveRun | None:
        with self._lock:
            return self._active.get(run_id)

    def list_active(self) -> list[dict]:
        """**只在跑的** run，按 ``started_at`` 倒序（最新在前）。

        ★ 为什么必须过滤 ``alive``（实测踩过的缺陷）：
          ``_active`` 的语义不是"活动 run 列表"，而是"本进程起过的 run 的登记簿" ——
          子进程退出后条目仍要在（SSE 靠它判定"已结束 → 重放完就收尾"）。
          早先把登记簿**原样**当成活动列表返回，于是 ``/api/runs.active``
          ①永远不为空、②无界增长，而且前端 ``active.find(project)`` 取到的是
          **最早**那条已结束的 run。真实症状：新起一个 build-only run，
          界面却显示上一条 ``doctor+build`` 的 36 行日志，
          并且 300ms 内就"跑完了"（那其实是旧 run 的重放）。
          过滤之后 ``active`` 才配得上它的名字，前端也因此能正确回退到
          "没有在跑的 → 显示最近一次的留档"。

        ★ **元数据以事件日志为准**（契约 §5.3）。``project``/``steps``/``actor``/
          ``started_at`` 在 ``run/start`` 里**逐字都有**，而 ``_active`` 里那份是
          ``spawn()`` 按自己的理解记下的 —— 两份真相必然有一天对不上
          （实测 N9：取消/重跑之后界面显示的步骤序列与日志里的不一致）。
          故这里一律**回读 ``run/start``**，内存那份退化为"子进程还没把首行刷出来"
          那几百毫秒的**临时占位**，并用 ``meta_source`` 把这件事**标出来**，
          而不是让人以为它同样权威。
          剩下的 ``pid``/``alive`` 只存在于进程内、日志里没有也不该有 —— 那才是
          ``_active`` 该独占的东西。
        """
        with self._lock:
            live = [a for a in self._active.values() if a.alive]
        out = []
        for a in live:
            st = self._start_event(a.run_id)
            if st is not None:
                meta = {
                    "project": st.get("project") or a.project,
                    "steps": list(st.get("steps") or a.steps),
                    "actor": st.get("actor") or a.actor,
                    "started_at": st.get("ts") or a.started_at,
                    "meta_source": "event-log",
                }
            else:
                meta = {"project": a.project, "steps": list(a.steps),
                        "actor": a.actor, "started_at": a.started_at,
                        "meta_source": "provisional"}
            out.append({
                "run": a.run_id, **meta,
                # 下面两个是**进程内**的事实，日志里没有也不该有：
                "pid": a.proc.pid, "alive": True,
                "dropped": a.dropped, "last_seq": a.last_seq,
            })
        out.sort(key=lambda x: x["started_at"], reverse=True)
        return out

    def _start_event(self, run_id: str) -> dict | None:
        """回读该 run 的**首条** ``run/start``（``seq`` 恒为 1，也就是文件第一行）。

        只 peek 一次、**不缓存**：事件文件是只追加的，首行永不改变，
        故"每次重读"与"缓存一份"结果必然相同 —— 那就不必再引入第二个
        需要保持同步的东西（本文件反复在为"少一个同步点"付代价）。
        """
        state = self.runs_dir / f"{run_id}.jsonl"
        try:
            for e in ev_mod.replay(state, 0):
                return e if e.get("topic") == ev_mod.RUN_START else None
        except OSError:
            return None
        return None

    # ── spawn ───────────────────────────────────────────────────
    def spawn(self, *, project: str, steps: list[str] | None = None,
              clean: bool = False, jobs: int | None = None, verbose: bool = False,
              actor: str = "human") -> dict:
        """起一个 ``elab run --emit-events`` 子进程，并立刻开始跟读。

        ★ run id **由父进程分配**并显式传给子进程（``--run-id``）：
          否则父进程无法在"文件还没出现"时就知道该跟读哪个文件 —— 那是一个必然的竞态。
        """
        steps = list(steps or run_mod.DEFAULT_STEPS)
        bad = [s for s in steps if s not in run_mod.ALL_STEPS]
        if bad:
            raise ElabError(f"未知步骤：{', '.join(bad)}")

        self.runs_dir.mkdir(parents=True, exist_ok=True)
        run_id = ev_mod.allocate_run_id(self.runs_dir)

        argv = [sys.executable, "-m", "elab", "run",
                "-p", project, "--steps", ",".join(steps),
                "--emit-events", "--run-id", run_id,
                "--events-dir", to_fwd(self.runs_dir),
                "--actor", actor, "-q"]
        if clean:
            argv.append("--clean")
        if jobs:
            argv += ["-j", str(jobs)]
        if verbose:
            argv.append("-v")

        env = dict(os.environ)
        # 让子进程能 import elab（与 ./elab 启动器同一手法）
        env["PYTHONPATH"] = str(_ROOT / "services") + os.pathsep + env.get("PYTHONPATH", "")
        env["PYTHONUNBUFFERED"] = "1"

        # ★ 独立进程组：cmake→ninja→gcc 是一棵树，取消时要整棵杀掉（K10）
        kwargs: dict = {"cwd": str(_ROOT), "env": env,
                        "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True

        proc = subprocess.Popen(argv, **kwargs)
        ar = ActiveRun(run_id=run_id, project=project, steps=steps, actor=actor,
                       proc=proc, started_at=time.time())
        with self._lock:
            self._active[run_id] = ar

        threading.Thread(target=self._follow_loop, args=(ar,),
                         name=f"follow-{run_id}", daemon=True).start()
        self.log(f"[cockpit] ▶ run {run_id} project={project} steps={','.join(steps)} pid={proc.pid}")
        return {"run": run_id, "project": project, "steps": steps,
                "pid": proc.pid, "actor": actor}

    # ── 跟读 + 扇出 ─────────────────────────────────────────────
    def _follow_loop(self, ar: ActiveRun) -> None:
        paths = ev_mod.run_paths(self.runs_dir, ar.run_id)
        rc = None
        try:
            for e in ev_mod.follow(paths, 0,
                                   stop=lambda: ar.proc.poll() is not None,
                                   poll=0.05, max_idle_s=60 * 30,
                                   drain_after_stop=0.4):
                ar.last_seq = e.get("seq", ar.last_seq)
                self._fanout(ar, e)
            rc = ar.proc.wait()
        except Exception as exc:                      # noqa: BLE001 —— 后台线程不能炸掉服务
            self.log(f"[cockpit] follower 异常（{ar.run_id}）：{exc}")
        finally:
            try:
                rc = ar.proc.wait(timeout=5)
            except Exception:                          # noqa: BLE001
                pass
            self._fanout(ar, {"run": ar.run_id, "topic": "stream/closed",
                              "seq": ar.last_seq, "ts": time.time(),
                              "actor": "agent", "reason": "run-finished", "rc": rc})
            self.log(f"[cockpit] ■ run {ar.run_id} 结束 rc={rc}")
            # ★ 收尾后把自己从登记簿摘掉（否则跑一夜就是几百个僵尸条目）。
            #   注意顺序：必须**先** fanout `stream/closed` 再 pop —— 已经挂在
            #   `ar.subscribers` 上的 SSE 连接是靠那条事件收尾的，与登记簿无关。
            #   摘掉之后 `active(run_id)` 变 None，而 SSE 对"未知/已结束 run"的
            #   处理本来就是同一条重放分支（`ar is None or not ar.alive`），
            #   所以行为不变、只是内存有界。
            with self._lock:
                self._active.pop(ar.run_id, None)

    def _fanout(self, ar: ActiveRun, ev: dict) -> None:
        """把一条事件推给所有 SSE 订阅者；**队列满时按契约丢弃并留痕**。

        丢谁（ICD §3.2）：``proc/*`` 等 activity 类可丢，``run/*`` 绝不丢
        （``run/*`` 是界面状态的唯一真相，丢了界面就再也回不到正确状态）。

        ★ 旧实现只 ``ar.dropped += 1`` 然后 continue —— 于是"丢了多少"只有
          服务端自己知道，界面上什么都没有。这正是本仓库反复出现的
          **静默丢事件**形态：服务端全对、HTTP 全 200、日志无一行报错，
          只有那块 UI 少了内容。修法就是契约 §17.3 早就写好的那句
          "并发 `stream/overrun` 让 UI 提示'日志已截断'"。
        """
        with ar.lock:
            subs = list(ar.subscribers)
        topic = ev.get("topic", "")
        # `stream/closed` 虽属 activity 通道，却是控制帧 → 与 run/* 同级不可丢
        droppable = ev_mod.is_activity(topic) and topic not in CONTROL_TOPICS
        for q in subs:
            try:
                q.put_nowait(ev)
                # 队列不再满 → 结束了一个溢出 episode，下一轮可以再报一次
                ar.sub_state.pop(id(q), None)
                continue
            except queue.Full:
                pass

            if droppable:
                ar.dropped += 1
                self._signal_overrun(ar, q, scope="proc/*")
                continue

            # ── run/* 不可丢 → 挤掉队首（队首多半是最老的 activity 行）──
            evicted = None
            try:
                evicted = q.get_nowait()
            except queue.Empty:
                pass
            if evicted is not None:
                ar.dropped += 1          # 无论它是哪一类，订阅者都收不到了
            try:
                q.put_nowait(ev)
            except queue.Full:
                # 挤了还是满（队列里全是 run/*）→ 这一次的 run/* 只能丢，
                # 但**必须留痕**：界面据此知道"状态可能不完整，需要重载"。
                self._signal_overrun(ar, q, scope="run/*")
                continue
            if evicted is not None:
                self._signal_overrun(ar, q, scope="proc/*")

    def _signal_overrun(self, ar: ActiveRun, q: queue.Queue, *, scope: str) -> None:
        """把一个**合成的** ``stream/overrun`` 塞进该订阅者队列（同一 episode 只塞一个）。

        为什么是合成事件而不是 ``emit()`` —— 这条很关键：

        - ``stream/overrun`` 描述的是**这一条 SSE 流**丢了多少，不是 run 自己的事实。
          写进 ``<id>.proc.jsonl`` 会同时破两件事：① 单写者模型（父进程去写子进程的
          日志文件）；②"删掉 ``.proc.jsonl`` 只损失日志、不影响状态重建"的通道判据。
        - 真相**一条没少**地躺在文件里，浏览器断线重连即可按 ``seq`` 补齐
          （``_sse`` 的重放分支就是干这个的）。这条事件的作用只是把
          "你此刻看到的不是全部"**当场说出来**，而不是等用户自己发现日志断了。
        - 于是它对 DSH 那条硬约束是**不违逆**的：可观测性、重建都仍从日志派生；
          这里交付的是一个关于"传输"的瞬时事实，丢失它不影响任何状态重建。

        ★ 同一个溢出 episode 只报一次：队列满时若每条丢的事件都塞一个标记，
          队列里会全是标记、把真实内容彻底挤出去，UI 反而更瞎。
          标记里的 ``dropped`` 是**同一个 dict 对象**，后续每次丢弃都就地更新，
          故 SSE 真正读到它时拿到的是最新数字，而不是"标记诞生那一刻"的旧值。
        """
        st = ar.sub_state.setdefault(id(q), {"armed": False, "marker": None})
        if st["armed"] and st["marker"] is not None:
            st["marker"]["dropped"] = ar.dropped
            st["marker"]["ts"] = time.time()
            return
        marker = {
            "ts": time.time(), "run": ar.run_id, "topic": "stream/overrun",
            # 不带新 seq：它不是 run 的事实，不该消耗 run 的计数器。
            # 用"当前已推进到的 seq"当定位锚点；SSE 侧也不会把它写进 Last-Event-ID。
            "seq": ar.last_seq, "actor": "agent",
            # ★ 与 `/api/runs.active[].dropped` **同一个数**（run 级）。
            #   刻意不做 per-connection 计数：两个都叫 dropped 的数字含义不同，
            #   迟早会有人在界面上把它们并列显示，然后对不上。
            "dropped": ar.dropped, "topic_scope": scope,
            "reason": "sse-queue-full",
        }
        st["marker"] = marker
        try:
            q.put_nowait(marker)
            st["armed"] = True
        except queue.Full:
            # 满到连标记都放不下 → 让队首一条活动行让位（性质不变：仍是丢活动事件）
            try:
                q.get_nowait()
                q.put_nowait(marker)
                st["armed"] = True
            except (queue.Empty, queue.Full):
                pass

    # ── 订阅（SSE 用）───────────────────────────────────────────
    def subscribe(self, run_id: str) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=QUEUE_MAX)
        ar = self.active(run_id)
        if ar is not None:
            with ar.lock:
                ar.subscribers.add(q)
        return q

    def unsubscribe(self, run_id: str, q: queue.Queue) -> None:
        ar = self.active(run_id)
        if ar is not None:
            with ar.lock:
                ar.subscribers.discard(q)
            # ★ 必须一起清：sub_state 用 id(q) 当键，留着就是"地址将被复用"的隐患
            #   （新队列可能落到同一地址，于是它一上来就被判成"已报过溢出"，
            #    真正的溢出反而报不出来 —— 又是一次静默丢事件）。
            ar.sub_state.pop(id(q), None)

    # ── 取消 ────────────────────────────────────────────────────
    def cancel(self, run_id: str, *, reason: str = "用户取消") -> dict:
        """杀掉整棵进程树，然后**由父进程补一条 ``run/cancel``**。

        ★ 这是契约"单写者"的**唯一豁免**（ICD §5.4）：子进程是被 ``taskkill /F``
          硬杀的，没有机会自己写收尾事件。补写的**前置条件是写者已死**（我们
          ``wait()`` 过），故不存在并发写。
        """
        ar = self.active(run_id)
        if ar is None:
            return {"ok": False, "error": f"没有活动的 run：{run_id}"}
        if not ar.alive:
            return {"ok": False, "error": f"run 已结束：{run_id}"}

        pid = ar.proc.pid
        if os.name == "nt":
            # /T 连带子树（cmake → ninja → gcc），/F 强制。
            # ★ 必须 errors="replace"：中文 Windows 上 taskkill 输出的是 GBK
            #   （"成功: 已终止 PID …"），按 UTF-8 解码会在 subprocess 的读线程里
            #   抛 UnicodeDecodeError —— 取消反而刷一屏假栈，掩盖真正的取消结果。
            #   本仓库其余的 subprocess 调用都带这个参数，这里不能例外。
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, text=True, errors="replace", check=False)
        else:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except OSError:
                pass
            try:
                ar.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except OSError:
                    pass

        try:
            rc = ar.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            rc = None

        appended = ev_mod.append_event(
            self.runs_dir, run_id, "run/cancel", actor="human",
            project=ar.project, by="human", reason=reason,
        )
        if appended is not None:
            ar.last_seq = appended["seq"]
            self._fanout(ar, appended)
        self.log(f"[cockpit] ■ 已取消 {run_id}（rc={rc}）")
        return {"ok": True, "run": run_id, "rc": rc, "pid": pid}


# ══════════════════════════════════════════════════════════════════
#  数据投影：projects / capabilities
# ══════════════════════════════════════════════════════════════════
def project_cards(cfg: Config) -> dict:
    """工程卡片数据。

    ★ 要求（§6 / M1.6）：**100% 来自 `projects/*.yaml`，不新增任何元数据**。
      下面所有字段要么是 YAML 原值，要么是它 + ``chips/*.yaml`` 的直读，
      要么是由"文件是否存在"推导出来的状态位（明确标注）。
    """
    host = cfg.host or {}
    probes = ((host.get("probes") or {}).get("list") or {})
    caps = serialport_mod.capabilities()

    cards = []
    for name, raw in sorted(cfg.projects.items()):
        proj = cfg.resolved_project(name)          # 完成 ${...} 插值
        chip_ref = proj.get("chip", "")
        chip = cfg.chips.get(chip_ref) or {}
        build = proj.get("build") or {}
        work_dir = build.get("work_dir", "")
        art = proj.get("artifacts") or {}

        # 派生状态位（**非**新元数据，只是"文件在不在"）
        elf = art.get("elf", "")
        built = bool(elf) and Path(elf).exists()

        probe = (proj.get("debug") or {}).get("probe", "")
        monitor = proj.get("monitor") or {}
        has_rules = bool(monitor.get("close_on") or [])

        avail: dict[str, dict] = {s: {"ok": True, "reason": ""} for s in run_mod.ALL_STEPS}
        if not (probe and probe in probes):
            reason = (f"未声明可用探针（debug.probe={probe or '空'}）"
                      if not probe else f"探针 {probe!r} 不在 elab.host.yaml: probes.list 中")
            avail["flash"] = {"ok": False, "reason": reason}
            avail["debug_verify"] = {"ok": False, "reason": reason}
        if not has_rules:
            avail["monitor"] = {"ok": False,
                                "reason": "未声明 monitor.close_on → 只能判 inconclusive"}
        elif not caps.get("available"):
            avail["monitor"] = {"ok": False,
                                "reason": f"串口后端不可用（layer={caps.get('layer')}）"}

        cards.append({
            "name": name,
            "chip": chip_ref,
            "archetype": proj.get("archetype", ""),
            "root": proj.get("root", ""),
            "work_dir": work_dir,
            "project_name": build.get("project_name", name),
            "generator": build.get("generator", ""),
            "build_type": build.get("build_type", ""),
            "linker_script": build.get("linker_script", ""),
            "artifacts": {k: v for k, v in art.items()},
            "probe": probe,
            "serial": proj.get("serial") or {},
            "monitor": {"close_on": len(monitor.get("close_on") or []),
                        "fail_on": len(monitor.get("fail_on") or []),
                        "idle_timeout_s": monitor.get("idle_timeout_s")},
            "provenance": proj.get("provenance") or {},
            # ↓ 以下为派生状态位，不是新元数据
            "derived": {"built": built, "work_dir_exists": bool(work_dir) and Path(work_dir).is_dir()},
            "steps": avail,
            "chip_info": {
                "id": chip.get("id", ""), "vendor": chip.get("vendor", ""),
                "family": chip.get("family", ""), "part": chip.get("part", ""),
                "package": chip.get("package", ""), "frequency": chip.get("frequency", ""),
                "core": chip.get("core") or {}, "memory": chip.get("memory") or {},
                "debug": chip.get("debug") or {},
            },
        })

    return {
        "projects": cards,
        "steps": {
            "all": list(run_mod.ALL_STEPS),
            "default": list(run_mod.DEFAULT_STEPS),
            "onhw": sorted(run_mod.ONHW_STEPS),
        },
    }


def capabilities(cfg: Config, mgr: RunManager) -> dict:
    caps = serialport_mod.capabilities()
    ports, backend = ("[]", "")
    try:
        plist, backend = serialport_mod.list_ports()
        ports = [{"name": p.name, "kind": p.kind, "device": p.device, "desc": p.desc}
                 for p in plist]
    except Exception as exc:                          # noqa: BLE001
        ports = []
        backend = f"枚举失败：{exc}"
    host = cfg.host or {}
    return {
        "cockpit": {"version": COCKPIT_VERSION, "dist": to_fwd(DIST_DIR),
                    "dist_ready": (DIST_DIR / "index.html").exists(),
                    "sse_heartbeat_s": SSE_HEARTBEAT_S,
                    "proc_batch_s": PROC_BATCH_S},
        "schema_version": ev_mod.EVENT_SCHEMA_VERSION,
        "python": {"version": sys.version.split()[0], "executable": sys.executable},
        "root": to_fwd(cfg.root),
        "runs_dir": to_fwd(mgr.runs_dir),
        "serial": {**caps, "backend": backend, "ports": ports,
                   "host_default": (host.get("serial") or {}).get("default", "auto"),
                   "host_baud": (host.get("serial") or {}).get("baud", 115200),
                   # 写能力与读能力同后端（ctypes L1 也已支持写，见 SerialIO.for_write）。
                   # 单列一个字段是因为前端要据此决定输入框是否可写 —— 不该让它去
                   # 猜"available 是不是也包括写"。
                   "write_available": bool(caps["available"]),
                   # TX/RX 的 console 日志（M3-b2）—— 界面据此提示"服务端存有 N 条历史"
                   "console": _console_info(cfg)},
        "active_runs": mgr.list_active(),
        "steps": {"all": list(run_mod.ALL_STEPS),
                  "default": list(run_mod.DEFAULT_STEPS),
                  "onhw": sorted(run_mod.ONHW_STEPS)},
    }


def _console_info(cfg: Config) -> dict:
    """手写通道 console 日志的位置与条数。

    ★ 为什么值得进 capabilities：那里是界面判断"要不要提示/提示什么"的唯一来源。
      没有它，前端只能猜"服务端到底存了多少历史"。
    """
    try:
        clog = serialconsole_mod.ConsoleLog(serialconsole_mod.console_path_for(cfg))
        return {"path": to_fwd(clog.path), "count": clog.count(),
                "max_records": clog.max_records, "error": None}
    except Exception as exc:                          # noqa: BLE001
        return {"path": "", "count": 0, "max_records": 0, "error": str(exc)}


def _plan_preview(cfg: Config, qs: dict) -> dict:
    """``GET /api/plan`` —— 只读命令预览（M2「先看命令再执行」，§14.4）。

    ★ 为什么是 **GET** 而不是 POST：它**没有副作用**（不 spawn、不写盘、
      不发射事件），语义上是一个纯查询。做成 GET 的收益是可 `curl` 直接验、
      可被浏览器/代理按幂等处理；做成 POST 则会让人以为"点了就动手了"。

    ★ 命令**不在这里拼**：整份预览来自 ``run.preview()``，而它复用各模块
      自己的 dry-run/print 分支。服务端只负责把 query 参数翻译过去 ——
      任何"在这里顺手拼一条命令"都是给未来埋分叉。
    """
    project = (qs.get("project") or [""])[0]
    if not project:
        raise ElabError("缺少 project")
    steps = (qs.get("steps") or [None])[0]
    clean = (qs.get("clean") or ["0"])[0].lower() in ("1", "true", "yes", "on")
    jobs_raw = (qs.get("jobs") or [""])[0]
    jobs = int(jobs_raw) if jobs_raw.strip().isdigit() else None
    return run_mod.preview(cfg, project, steps=steps, clean=clean, jobs=jobs)


#: 会占用串口 / SWD 的步骤 —— 它们运行期间，手写通道必须让路。
#:   flash/debug_verify 起 openocd（占 SWD → N5 会连带锁住 VCP）；
#:   monitor 自己就握着串口。
_SERIAL_STEPS = frozenset({"flash", "debug_verify", "monitor"})


def _serial_blocker(mgr: "RunManager") -> dict | None:
    """有没有「会用到串口的闭环」正在跑？有就返回它，否则 None。

    ★ 为什么**提前**拦，而不是让写入自己失败：openocd 占着 SWD 时，VCP 会以
      ``ERROR_ACCESS_DENIED`` 打不开，用户只看到"端口被拒"，却不知道是自己刚点的
      闭环占着 —— 于是去拔插、去杀进程。在这里拦下就能**指名道姓**地说清楚。
    """
    for a in mgr.list_active():
        if not a.get("alive"):
            continue
        if set(a.get("steps") or []) & _SERIAL_STEPS:
            return a
    return None


# ══════════════════════════════════════════════════════════════════
#  HTTP
# ══════════════════════════════════════════════════════════════════
class CockpitHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"elab-cockpit/{COCKPIT_VERSION}"

    # 由 make_server 注入
    cfg: Config
    mgr: RunManager
    dist: Path
    sse_sem: threading.Semaphore

    # ── 小工具 ──────────────────────────────────────────────────
    #: 已经写出过响应头。★ 必须有它：SSE 是"边写边推"的，一旦中途出错
    #: （客户端断开最常见），再去 send_response 会写第二份响应头，
    #: 抛出的次生异常会盖掉真正的根因（实测踩过：WinError 10053 被
    #: 一层 `end_headers()` 的 ConnectionAbortedError 覆盖，日志里看不出真正原因）。
    _sent_headers = False

    def handle_one_request(self):                      # noqa: N802
        """★ 每条请求都必须重置 ``_sent_headers``（keep-alive 下的命门）。

        一个 handler **实例**服务的是一整条**连接**，不是一条请求。HTTP/1.1
        默认 keep-alive，浏览器会在同一条连接上连发
        ``/`` → ``/assets/index.css`` → ``/assets/index.js``。

        ``_sent_headers`` 原来只在 ``_send()`` 里置 True、从不重置，于是**从第二条
        请求起** ``_send()`` 直接 return —— **一个字节都不写**。客户端既拿不到响应，
        也收不到错误，只能挂到超时。实测症状极具迷惑性：

        - `GET /` 200、`index.css` 200，唯独 `index.js` 永远 pending；
        - 页面 ``readyState`` 卡在 ``interactive``，``#root`` 永远 0 个子节点；
        - **控制台一个报错都没有**（因为根本没有 JS 执行过）；
        - 而 `curl`（每次新进程=新连接）与服务端日志**一切正常**。

        为什么测试没抓到：``_Client`` 与 curl 都是"一请求一连接"，从未复用连接。
        回归用例见 ``test_keep_alive_same_connection``。
        """
        self._sent_headers = False
        super().handle_one_request()

    def log_message(self, fmt, *args):                 # 静音默认 access log
        if self.server.verbose:                        # type: ignore[attr-defined]
            sys.stderr.write("[cockpit] " + (fmt % args) + "\n")

    def _send(self, code: int, body: bytes, ctype: str, *, extra: dict | None = None):
        if self._sent_headers:
            return
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self._sent_headers = True
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _err(self, code: int, msg: str):
        self._json({"error": msg}, code)

    def _fail(self, exc: Exception):
        """统一的失败出口。

        ``ConnectionError`` 家族（``BrokenPipeError`` / ``ConnectionResetError`` /
        ``ConnectionAbortedError``）**全部**是"客户端走了"，属于正常事件，
        不该记成服务端错误 —— 尤其是 ``--noproxy`` 的 curl + ``head`` 这种用法
        会在读够行数后直接关连接。只有真正的异常才回 500，且仅当响应头尚未发出。
        """
        if isinstance(exc, ConnectionError):
            return
        if self._sent_headers:
            sys.stderr.write(f"[cockpit] 响应已开始后出错（无法回错）：{exc!r}\n")
            return
        self._err(500, f"{type(exc).__name__}: {exc}")

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ElabError("请求体不是合法 JSON")

    # ── 路由 ────────────────────────────────────────────────────
    def do_GET(self):                                  # noqa: N802
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)
        try:
            if path == "/api/capabilities":
                return self._json(capabilities(self.cfg, self.mgr))
            if path == "/api/projects":
                return self._json(project_cards(self.cfg))
            if path == "/api/runs":
                return self._json({"runs": ev_mod.list_runs(self.mgr.runs_dir),
                                   "active": self.mgr.list_active()})
            if path == "/api/plan":
                return self._json(_plan_preview(self.cfg, qs))
            if path == "/api/events":
                return self._sse(qs)
            if path == "/api/run-events":
                run_id = (qs.get("run") or [""])[0]
                after = int((qs.get("from") or ["0"])[0])
                return self._json({"events": ev_mod.read_run(self.mgr.runs_dir, run_id, after_seq=after)})
            if path == "/api/serial/console":
                # 手写通道的 TX/RX 历史（M3-b2）。**独立的** console 日志，
                # 不是 run 事件流（写通道不属于任何 run，见 ICD §3.5）。
                raw = (qs.get("limit") or [""])[0]
                try:
                    limit = int(raw) if raw else serialconsole_mod.DEFAULT_TAIL
                except ValueError:
                    raise ElabError(f"limit 必须是整数：{raw!r}")
                limit = max(1, min(limit, serialconsole_mod.MAX_RECORDS))
                clog = serialconsole_mod.ConsoleLog(serialconsole_mod.console_path_for(self.cfg))
                recs = clog.tail(limit)
                return self._json({"records": recs, "count": clog.count(),
                                   "requested": limit, "path": to_fwd(clog.path)})
            if path.startswith("/api/"):
                return self._err(404, f"未知 API：{path}")
            return self._static(path)
        except ElabError as exc:
            return self._err(400, str(exc))
        except Exception as exc:                       # noqa: BLE001
            return self._fail(exc)

    def do_HEAD(self):                                 # noqa: N802
        return self.do_GET()

    def do_POST(self):                                 # noqa: N802
        u = urlparse(self.path)
        try:
            if u.path == "/api/run":
                body = self._body()
                project = body.get("project") or ""
                if not project:
                    return self._err(400, "缺少 project")
                res = self.mgr.spawn(
                    project=project,
                    steps=body.get("steps"),
                    clean=bool(body.get("clean")),
                    jobs=body.get("jobs"),
                    verbose=bool(body.get("verbose")),
                    actor=body.get("actor") or "human",
                )
                return self._json(res, 202)
            if u.path == "/api/cancel":
                body = self._body()
                run_id = body.get("run") or ""
                if not run_id:
                    return self._err(400, "缺少 run")
                res = self.mgr.cancel(run_id, reason=body.get("reason") or "用户取消")
                return self._json(res, 200 if res.get("ok") else 409)
            if u.path == "/api/serial":
                # 手写通道（M3-b）：写一条出去、收一小段回显，一次请求内闭环。
                # ★ 返回 **200 + ok:false**（而不是 5xx）承载"执行了但没成功"：
                #   前端要渲染的字段在两种结果下完全一样（port/baud/error），
                #   用 5xx 只会让它走异常分支、丢掉这些结构化信息。
                #   400 只留给"请求本身不合法"，409 留给"串口正被闭环占着"。
                body = self._body()
                data = body.get("data")
                if not isinstance(data, str) or not data.strip():
                    return self._err(400, "缺少 data（要发送的内容）")
                busy = _serial_blocker(self.mgr)
                if busy:
                    return self._err(409, (
                        f"有闭环正在跑（run={busy.get('run')}，"
                        f"步骤 {'/'.join(busy.get('steps') or [])}）—— 它要用串口/SWD，"
                        f"手写通道已在让路（约束 N5）。等它跑完，或先取消它。"))
                project = body.get("project") or ""
                res = serialterm_mod.roundtrip(
                    self.cfg,
                    project,
                    data=data,
                    port=body.get("port") or "",
                    baud=body.get("baud") or 0,
                    read_ms=body.get("read_ms") or serialterm_mod.DEFAULT_READ_MS,
                    newline=bool(body.get("newline", True)),
                    hex_=bool(body.get("hex")),
                    # ★ 落盘：写通道**不属于任何 run**，所以落到独立的 console 日志，
                    #   绝不写进 run 的 .jsonl（那会破坏单写者模型，约束 C17）。
                    journal=serialconsole_mod.journal_for(self.cfg, project=project),
                )
                return self._json(res, 200)
            return self._err(404, f"未知 API：{u.path}")
        except ElabError as exc:
            return self._err(400, str(exc))
        except Exception as exc:                       # noqa: BLE001
            return self._fail(exc)

    # ── 静态 ────────────────────────────────────────────────────
    def _static(self, path: str):
        if not (self.dist / "index.html").exists():
            return self._send(200, _NO_DIST_HTML.encode("utf-8"),
                              "text/html; charset=utf-8")
        rel = path.lstrip("/") or "index.html"
        target = (self.dist / rel).resolve()
        # 目录穿越防护：解析后必须仍在 dist 内
        try:
            target.relative_to(self.dist.resolve())
        except ValueError:
            return self._err(403, "路径越界")
        if not target.is_file():
            # SPA 回退：无扩展名 → index.html（前端用 history 路由）
            if "." not in Path(rel).name:
                target = self.dist / "index.html"
            else:
                return self._err(404, f"找不到：{rel}")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",
                                                  "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    # ── SSE ─────────────────────────────────────────────────────
    def _sse(self, qs: dict):
        run_id = (qs.get("run") or [""])[0]
        after = int((qs.get("from") or ["0"])[0])
        # 断线续传：浏览器重连会自动带 Last-Event-ID（§17.2）
        leid = self.headers.get("Last-Event-ID")
        if leid:
            try:
                after = max(after, int(leid))
            except ValueError:
                pass
        if not run_id:
            return self._err(400, "缺少 run")

        if not self.sse_sem.acquire(blocking=False):
            return self._err(503, f"SSE 连接数已达上限（{MAX_SSE_CONNS}）")

        ar = self.mgr.active(run_id)
        sub = self.mgr.subscribe(run_id)          # 非活动 run 也能拿（subscribe 会返回空队列）
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            # ★ 用 chunked 而不是"靠关连接断句"：HTTP/1.1 下没有 Content-Length
            #   就必须显式分块，否则浏览器会一直等自己的缓冲，日志"不动"。
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self._sent_headers = True

            last_sent = after
            last_beat = time.time()
            pending: list[str] = []
            pending_step = ""
            last_flush = time.time()

            def chunk(data: str) -> None:
                self._chunk(data)

            def flush_proc() -> None:
                nonlocal pending, last_flush
                if pending:
                    self._sse_frame("proc/stdout-batch",
                                    {"topic": "proc/stdout-batch", "run": run_id,
                                     "seq": last_sent, "ts": time.time(),
                                     "actor": "agent", "step": pending_step,
                                     "lines": pending},
                                    eid=last_sent)
                    pending = []
                last_flush = time.time()

            # ① 先把 after_seq 之后的存量重放掉（覆盖"断线期间"与"run 已结束"两种情况）
            for e in ev_mod.read_run(self.mgr.runs_dir, run_id, after_seq=after):
                if e.get("seq", 0) <= last_sent:
                    continue
                self._sse_write(e)
                last_sent = e.get("seq", last_sent)

            # ② 已结束（或未知）的 run：重放完就收尾。
            #    ★ 无论哪种情况都**必须**发出 stream/closed + chunked 终止块：
            #      否则客户端只看到"连接被关"，分不清"run 结束了"和"服务端出错"，
            #      而 EventSource 还会傻傻地不停重连。
            if ar is None or not ar.alive:
                flush_proc()
                if ar is None and not self._run_exists(run_id):
                    self._sse_frame("stream/closed",
                                    {"run": run_id, "reason": "unknown-run"})
                else:
                    self._sse_frame("stream/closed",
                                    {"run": run_id, "reason": "run-finished"})
                chunk("0\r\n\r\n")
                return

            # ③ 活动 run：跟读队列
            heartbeats = 0
            while True:
                try:
                    e = sub.get(timeout=PROC_BATCH_S)
                except queue.Empty:
                    now = time.time()
                    if pending and (now - last_flush) >= PROC_BATCH_S:
                        flush_proc()
                    if (now - last_beat) >= SSE_HEARTBEAT_S:
                        chunk(": ping\n\n")             # §17.3 注释行心跳
                        last_beat = now
                        heartbeats += 1
                        if heartbeats > 8 and not self.mgr.active(run_id):
                            break
                    continue

                topic = e.get("topic", "")
                if topic == "stream/closed":
                    flush_proc()
                    self._sse_frame("stream/closed",
                                    {"run": run_id, "reason": e.get("reason", ""),
                                     "rc": e.get("rc")})
                    break

                # ★ `stream/overrun` 必须在**去重之前**处理，理由有两条：
                #   ① 它的 topic 前缀是 `stream/`（非 `run/`）→ `is_activity()` 为真，
                #      会落进下面的 activity 分支被当成"一行普通输出"。而它没有
                #      `line` 字段 → 界面收到一个**空字符串行**，什么提示都没有。
                #      契约里"补一条 stream/overrun 让 UI 提示日志已截断"就是被这里吞掉的。
                #   ② 它带的是 `ar.last_seq`（**定位锚点**，不是新序号），
                #      必然 `<= last_sent` → 走下面的去重就会被当成"与重放重叠"丢掉。
                #      即"刚发出的告警被自己的去重逻辑吃掉"，是最隐蔽的那种丢法。
                if topic == "stream/overrun":
                    flush_proc()
                    self._sse_frame(
                        "stream/overrun",
                        {"run": run_id, "topic": "stream/overrun",
                         "seq": e.get("seq", 0), "ts": e.get("ts") or time.time(),
                         "actor": e.get("actor") or "agent",
                         "dropped": e.get("dropped", 0),
                         "topic_scope": e.get("topic_scope", ""),
                         "reason": e.get("reason", "")},
                        eid=None)     # ★ 刻意不带 id：它是"传输"的事实，不是 run 的序号；
                                      #   写进 Last-Event-ID 会让重连游标越过它自己
                    last_beat = time.time()
                    continue

                seq = e.get("seq", 0)
                if seq and seq <= last_sent:
                    continue                            # 与重放重叠 → 去重
                if ev_mod.is_batched(topic):
                    # 100ms 合并（§17.3）；**只有进程输出**进这里 ——
                    # 见 `events.is_batched()`：`serial/*` 曾被 `is_activity()`
                    # 误判进合并，于是 serial/closed-loop 变成一行空文本、
                    # 「串口闭环」UI 永远是死的，且只在**实时**路径上复现。
                    step = e.get("step", "")
                    if pending and step != pending_step:
                        flush_proc()
                    pending_step = step
                    pending.append(str(e.get("line", "")))
                    last_sent = max(last_sent, seq)
                    if (time.time() - last_flush) >= PROC_BATCH_S:
                        flush_proc()
                    continue
                flush_proc()
                self._sse_write(e)
                last_sent = max(last_sent, seq)
                last_beat = time.time()

            flush_proc()
            chunk("0\r\n\r\n")                          # chunked 终止块
        except ConnectionError:
            return                                      # 客户端走了（head / 关标签页），常态
        except Exception as exc:                        # noqa: BLE001
            sys.stderr.write(f"[cockpit] SSE 异常（{run_id}）：{exc!r}\n")
            return
        finally:
            self.mgr.unsubscribe(run_id, sub)
            self.sse_sem.release()

    def _run_exists(self, run_id: str) -> bool:
        return (self.mgr.runs_dir / f"{run_id}.jsonl").exists()

    # ── SSE 写帧 ────────────────────────────────────────────────
    #: 已经告警过的越界 topic（进程级共享）。只提示一次，避免日志被刷爆。
    _warned_topics: set[str] = set()

    def _sse_warn_unknown(self, topic: str) -> None:
        """发出的 topic 不在 ``SSE_TOPICS`` 登记表里 → 打一条 WARN。

        ★ 为什么值得单独做这件事：这个缺陷是**完全静默**的 —— 服务端 HTTP 200、
        帧格式正确、日志正常；浏览器不报错也不触发 `onerror`，只是那块 UI 永远
        不更新。没有这行 WARN，"新增了 topic 但忘了同步前端白名单"只能靠人肉发现。
        """
        if topic in SSE_TOPICS or topic in CockpitHandler._warned_topics:
            return
        CockpitHandler._warned_topics.add(topic)
        self.mgr.log(
            f"[cockpit] ⚠ SSE topic 未登记：{topic!r} —— 若前端 `KNOWN_TOPICS`"
            f" 也没同步，浏览器会**静默丢弃**该 topic 的全部事件（ICD §6.1）。"
            f" 两端都要改：cockpit/server.py 的 SSE_TOPICS + web 的 KNOWN_TOPICS。")

    # ★ 这三处**必须**统一走 chunk 分块。教训：曾把状态帧用裸 write 直接写出去，
    #   而响应头声明了 `Transfer-Encoding: chunked` → 客户端把 `id: 1` 当成
    #   chunk-size 行去解析（`id:` 不是十六进制）→ **立刻判定流结束**。
    #   症状极具迷惑性：状态码 200、Content-Type/Transfer-Encoding 全对、
    #   服务端日志一切正常，但客户端**一行都收不到**。
    def _chunk(self, data: str) -> None:
        raw = data.encode("utf-8")
        self.wfile.write(f"{len(raw):X}\r\n".encode("ascii") + raw + b"\r\n")
        self.wfile.flush()

    def _sse_frame(self, event: str, data: dict, eid: int | None = None) -> None:
        """命名事件帧。``eid`` 为 None 时**不**写 ``id:``。

        ★ 为什么 ``proc/stdout-batch`` 也必须带 ``id``（实测发现的缺陷）：
          浏览器只用 ``id:`` 维护 ``Last-Event-ID``。合并帧若不带 ``id``，
          客户端记录的游标会停在**上一个 run\\* 事件**上，于是重连时服务端从
          那个旧游标重放 —— 已经通过合并帧交付过的日志行**会再发一遍**，
          证据轨里出现重复行（且只在"断过线"时才复现，极难归因）。
          合并帧里的事件 seq 天然连续（非活动事件写入前必先冲刷 pending），
          故用其最大 seq 当 ``id`` 是精确且单调的。
        """
        self._sse_warn_unknown(event)
        head = f"id: {eid}\n" if eid is not None else ""
        self._chunk(f"{head}event: {event}\ndata: "
                    + json.dumps(data, ensure_ascii=False) + "\n\n")

    def _sse_write(self, e: dict) -> None:
        """一条事件 → 一个 SSE 帧。``id:`` 即 ``seq``，浏览器重连时自动回传。"""
        topic = e.get("topic", "message")
        self._sse_warn_unknown(topic)
        self._chunk(f"id: {e.get('seq', 0)}\n"
                    f"event: {topic}\n"
                    "data: " + json.dumps(e, ensure_ascii=False) + "\n\n")


_NO_DIST_HTML = """<!doctype html><meta charset="utf-8">
<title>elab cockpit · 前端未构建</title>
<style>body{font:15px/1.7 system-ui;max-width:46rem;margin:3rem auto;padding:0 1.2rem;color:#1a1a1a}
code{background:#f1efe8;padding:.15rem .4rem;border-radius:4px}pre{background:#f8f7f4;padding:1rem;border-radius:8px;overflow:auto}</style>
<h1>驾驶舱后端已在运行，但前端产物缺失</h1>
<p>后端是零依赖的（HTTP + SSE 都是 stdlib），但界面本身需要一份构建产物
<code>cockpit/web/dist/</code>。它**已随仓库提交**，所以正常 clone 下来不该看到本页。</p>
<p>若你确实处在"还没构建前端"的状态，执行：</p>
<pre>npm --prefix cockpit/web install
npm --prefix cockpit/web run build</pre>
<p>构建一次之后刷新本页即可。<b>最终用户不需要装 Node</b> —— 只需要这份 <code>dist/</code>。</p>
<p>此刻可以先用 API 验证后端：</p>
<pre>curl -s http://127.0.0.1:3333/api/capabilities
curl -s http://127.0.0.1:3333/api/projects</pre>
"""


class CockpitServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    verbose = False

    def handle_error(self, request, client_address):
        """客户端断开**不是**服务端错误，别打一堆吓人的栈。

        典型的无害场景：``http.client`` 用完后直接关连接，而服务端还在
        keep-alive 地等同一个连接上的下一个请求 → ``ConnectionAbortedError``。
        本地单用户工具里这几乎是常态，掩盖真实错误才是代价。
        """
        exc = sys.exc_info()[1]
        if isinstance(exc, ConnectionError):
            return
        super().handle_error(request, client_address)


def make_server(cfg: Config, *, host: str = HOST, port: int = DEFAULT_PORT,
                dist: Path | None = None, verbose: bool = False,
                log=print) -> CockpitServer:
    mgr = RunManager(cfg, log=log)
    handler = type("BoundCockpitHandler", (CockpitHandler,), {})
    handler.cfg = cfg
    handler.mgr = mgr
    handler.dist = Path(dist) if dist else DIST_DIR
    handler.sse_sem = threading.Semaphore(MAX_SSE_CONNS)
    srv = CockpitServer((host, port), handler)
    srv.verbose = verbose                                # type: ignore[attr-defined]
    srv.run_manager = mgr                                # type: ignore[attr-defined]
    return srv


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="cockpit.server",
                                 description="elab-Flow 闭环驾驶舱后端（零依赖 HTTP + SSE）")
    ap.add_argument("--root", help="覆盖 ELAB_ROOT")
    ap.add_argument("--host", default=HOST, help=f"监听地址（默认 {HOST}，只监听本地）")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"端口（默认 {DEFAULT_PORT}）")
    ap.add_argument("--dist", help="覆盖前端产物目录（默认 cockpit/web/dist）")
    ap.add_argument("--reload", action="store_true", help="不使用 dist/，仅提供 API")
    ap.add_argument("-v", "--verbose", action="store_true", help="打印访问日志")
    args = ap.parse_args(argv)

    cfg = Config(args.root)
    dist = None if args.reload else (Path(args.dist) if args.dist else None)
    srv = make_server(cfg, host=args.host, port=args.port, dist=dist,
                      verbose=args.verbose)
    ready = (Path(dist) if dist else DIST_DIR) / "index.html"
    print(f"[cockpit] ELAB_ROOT = {cfg.root}")
    print(f"[cockpit] 监听 http://{args.host}:{args.port}/")
    print(f"[cockpit] 前端产物 {'✓ ' + to_fwd(ready) if ready.exists() else '✗ 缺失（见页面提示）'}")
    print(f"[cockpit] 运行产物 {to_fwd(srv.run_manager.runs_dir)}")
    print("[cockpit] Ctrl-C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[cockpit] 退出中…")
    finally:
        srv.shutdown()
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
