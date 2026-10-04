"""elab.kernel.events —— 事件模型：只追加 JSONL + 内存环形缓冲 + 跟读/重放。

契约是 ``docs/ICD_cockpit_events.md``（**version 1**），本文件是它的唯一实现。
改字段/改语义前先读那份文档的 §7「兼容性承诺汇总」。

设计要点（每条都对应一个真实会踩的坑）：

1. **`seq` 一个 run 内全局单调**，跨所有 topic 共用一支计数器。
   → 因为 SSE 的 ``id:`` 只能是单个游标；按 topic 分游标会让重放立刻复杂化。
2. **计数器与写盘在同一把锁里**。这条不只是"线程安全"——它保证了
   "已写入的事件集合恒为 seq 的**连续前缀**"，于是 ``follow()`` 可以在
   不看任何全局状态的情况下按 seq 合并两个文件（见 ``follow`` 的注释）。
3. **每行 ``flush()``**。父进程按行跟读，缓冲会让界面"卡住不动"。
4. **``newline="\\n"``**。否则 Windows 下写 CRLF、Linux 下写 LF，
   同一个 run 的 JSONL 在不同 OS 上字节不同 → 破坏 CI 的产物一致性守卫。
5. **`proc/*` 单独一个文件**（``.proc.jsonl``）。编译输出几 MB，
   混进 state 日志会让"重建界面状态"被迫读一个巨大文件，违背其职责。
   判据：删掉 ``*.proc.jsonl`` 只允许损失"日志"，不得影响状态重建。
"""

from __future__ import annotations

import json
import secrets
import threading
import time
from collections import deque
from pathlib import Path

# ── 契约版本 ─────────────────────────────────────────────────────
# 与 docs/ICD_cockpit_events.md 描述的版本一致；前端从 /api/capabilities 读到后比对。
EVENT_SCHEMA_VERSION = 1

# ── topic 常量（禁止在别处写字符串字面量，防拼写漂移）────────────
RUN_START = "run/start"
RUN_STEP_ENTER = "run/step-enter"
RUN_STEP_EXIT = "run/step-exit"
RUN_END = "run/end"
RUN_CANCEL = "run/cancel"

PROC_STDOUT = "proc/stdout"
PROC_STDERR = "proc/stderr"
PROC_EXIT = "proc/exit"
STREAM_OVERRUN = "stream/overrun"

SERIAL_OPEN = "serial/open"
SERIAL_LINE = "serial/line"
SERIAL_CLOSE = "serial/close"
SERIAL_ERROR = "serial/error"
SERIAL_CLOSED_LOOP = "serial/closed-loop"

#: 已知 topic。emit 不强制校验（保持前向兼容），但测试与 lint 用它查拼写。
KNOWN_TOPICS = frozenset({
    RUN_START, RUN_STEP_ENTER, RUN_STEP_EXIT, RUN_END, RUN_CANCEL,
    PROC_STDOUT, PROC_STDERR, PROC_EXIT, STREAM_OVERRUN,
    SERIAL_OPEN, SERIAL_LINE, SERIAL_CLOSE, SERIAL_ERROR, SERIAL_CLOSED_LOOP,
})

#: actor 取值（契约 §2.1 第 4 条：不允许空字符串）
ACTOR_AGENT = "agent"
ACTOR_HUMAN = "human"


# ── 通道分类 ─────────────────────────────────────────────────────
def channel_of(topic: str) -> str:
    """topic → 落盘通道。**只有两个通道**，这是刻意的：

      ``state`` —— ``run/*``        → ``<run-id>.jsonl``
                   界面状态的唯一真相。小、必经、**背压下绝不可丢**。
      ``proc``  —— 其余全部          → ``<run-id>.proc.jsonl``
                   （``proc/*``、``stream/*``、``serial/*``、``fs/*``）
                   活动/证据。大、可丢、可修剪；**丢了只损失日志，不影响状态重建**。

    把 ``serial/*`` 也归进活动通道，是为了让前端能用**一条** SSE 流拿到
    串口事件（带 ``step``/``seq`` 元数据）；而``<run-id>.serial.log``
    另存**原始文本行**，因为它的用途是"闭环证据 + grep"，JSON 化反而碍事。
    """
    return "state" if topic.startswith("run/") else "proc"


def is_persisted(topic: str) -> bool:
    """是否属于"丢了就无法重建界面状态"的那一类（契约 §3.1）。"""
    return channel_of(topic) == "state"


def is_activity(topic: str) -> bool:
    """是否属于可被背压丢弃的那一类（契约 §3.2）。"""
    return not is_persisted(topic)


# ── 工具 ─────────────────────────────────────────────────────────
def _now() -> float:
    return round(time.time(), 3)


class RingBuffer:
    """有界环形缓冲。溢出不报错——旧行自己掉出去，这正是"环形"的意思。"""

    def __init__(self, capacity: int = 2000):
        self._buf: deque = deque(maxlen=capacity)
        self._lock = threading.Lock()

    def append(self, item) -> None:
        with self._lock:
            self._buf.append(item)

    def extend(self, items) -> None:
        with self._lock:
            self._buf.extend(items)

    def snapshot(self) -> list:
        with self._lock:
            return list(self._buf)

    def __len__(self) -> int:
        with self._lock:
            return len(self._buf)


def allocate_run_id(runs_dir) -> str:
    """取一个**未被占用**的 run id：``r-<8位小写 hex>``。

    契约 §5.3：新 run = 新文件、绝不复写，所以冲突必须重取，
    **不允许**靠覆盖解决。8 位 hex（4G 组合）+ 存在性检查足够。
    """
    runs_dir = Path(runs_dir)
    for _ in range(64):
        rid = "r-" + secrets.token_hex(4)
        if not (runs_dir / f"{rid}.jsonl").exists():
            return rid
    raise RuntimeError("无法分配 run id：连续 64 次都撞已有文件（目录被污染？）")


# ── 写侧 ─────────────────────────────────────────────────────────
class EventLog:
    """一个 run 的事件写入器。**单写者模型**（只有本进程写），故不加文件锁。

    多线程（proc 读线程 vs 主线程）安全：``emit`` 全程持锁，
    并保证"计数器 + 写盘"原子 → 已写入集合恒为 seq 的连续前缀。
    """

    def __init__(self, runs_dir, *, run_id: str | None = None, project: str = "",
                 ring_capacity: int = 4000, log=None):
        self.runs_dir = Path(runs_dir)
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.run_id = run_id or allocate_run_id(self.runs_dir)
        self.project = project

        # 路径在本模块内集中定义，别处不许拼（防止两处命名漂移）
        self.state_path = self.runs_dir / f"{self.run_id}.jsonl"
        self.proc_path = self.runs_dir / f"{self.run_id}.proc.jsonl"
        self.log_path = self.runs_dir / f"{self.run_id}.log"
        self.serial_path = self.runs_dir / f"{self.run_id}.serial.log"

        self._seq = 0
        self._lock = threading.RLock()
        self._handles: dict[str, object] = {}
        self._t0 = time.time()
        self._ring = RingBuffer(ring_capacity)          # 全部事件（含 proc）
        self._subs: list = []                            # 进程内订阅者
        self._external_log = log                         # 兼容既有 log= seam

    # ── 文件句柄 ────────────────────────────────────────────────
    def _h(self, key: str):
        h = self._handles.get(key)
        if h is None:
            path = {
                "state": self.state_path,
                "proc": self.proc_path,
                "serial": self.serial_path,
                "log": self.log_path,
            }[key]
            # newline="\n"：跨 OS 字节一致，见模块 docstring 第 4 条
            h = open(path, "a", encoding="utf-8", newline="\n")
            self._handles[key] = h
        return h

    def _write_line(self, key: str, text: str) -> None:
        h = self._h(key)
        h.write(text + "\n")
        h.flush()      # 见模块 docstring 第 3 条

    # ── 发射 ────────────────────────────────────────────────────
    def emit(self, topic: str, *, actor: str = ACTOR_AGENT, **fields) -> dict:
        """发一条事件：① 追加到对应通道 ② 进环形缓冲 ③ 通知进程内订阅者。

        字段顺序刻意与契约样例一致（ts, run, topic, seq, actor, ...）——
        JSONL 是给人看的，字段顺序稳定能省很多眼力。
        """
        if not actor:
            raise ValueError("actor 不可为空（契约 §2.1 第 4 条）")
        with self._lock:
            self._seq += 1
            ev = {
                "ts": _now(),
                "run": self.run_id,
                "topic": topic,
                "seq": self._seq,
                "actor": actor,
            }
            ev.update(fields)

            line = json.dumps(ev, ensure_ascii=False, separators=(",", ":"))
            # ① 结构化事件：run/* → state，其余 → proc
            self._write_line(channel_of(topic), line)

            # ② 串口原始行另存纯文本（闭环证据，给人 grep）
            if topic == SERIAL_LINE:
                self._write_line("serial", str(ev.get("line", "")))

            # ③ 人读合并日志：供 grep（契约 §5.1 承诺 .log 存在）
            self._log_hr(ev)

            self._ring.append(ev)
            subs = list(self._subs)
        for fn in subs:
            try:
                fn(ev)
            except Exception:               # 订阅者异常绝不能影响发射
                pass
        return ev

    def _log_hr(self, ev: dict) -> None:
        """人读合并日志（``.log``）。

        ``.log`` 是拿去 ``grep`` 的，**噪声要少**：没有正文的事件不能只把 topic
        原文写进去（``run/step-enter`` 这种行对 grep 毫无价值）。故只给**状态迁移**
        留一条短标记，其余无正文事件直接不写。
        """
        topic = ev["topic"]
        dt = ev["ts"] - self._t0
        step = ev.get("step", "-")
        body = ev.get("line") or ev.get("detail") or ev.get("message") or ""
        if not body:
            if topic == RUN_STEP_ENTER:
                body = f"▶▶ 进入 {step}"
            elif topic == RUN_START:
                body = (f"▶▶ run 开始 project={ev.get('project', '')} "
                        f"steps={','.join(ev.get('steps') or [])}")
            elif topic == RUN_END:
                body = (f"■■ run 结束 ok={ev.get('ok')} "
                        f"ok={ev.get('steps_ok')} failed={ev.get('steps_failed')}")
            elif topic == RUN_CANCEL:
                body = f"■■ run 取消 by={ev.get('by', '')} {ev.get('reason', '')}"
            else:
                return
        self._write_line("log", f"[+{dt:8.3f}s] [{step:<13}] {body}".rstrip())

    # ── 便捷方法（把契约里的"必填字段"变成函数签名，少一层记性）──
    def start(self, steps, *, project: str = "", actor: str = ACTOR_AGENT) -> dict:
        return self.emit(RUN_START, project=project or self.project,
                         steps=list(steps), actor=actor)

    def step_enter(self, step: str, index: int, total: int, *,
                   actor: str = ACTOR_AGENT) -> dict:
        return self.emit(RUN_STEP_ENTER, step=step, index=index, total=total,
                         project=self.project, actor=actor)

    def step_exit(self, step: str, ok: bool, detail: str = "",
                  duration_s: float = 0.0, *, actor: str = ACTOR_AGENT,
                  **extra) -> dict:
        return self.emit(RUN_STEP_EXIT, step=step, ok=bool(ok),
                         detail=detail or "", duration_s=round(duration_s, 3),
                         project=self.project, actor=actor, **extra)

    def end(self, ok: bool, steps_ok=(), steps_failed=(), *,
            actor: str = ACTOR_AGENT) -> dict:
        return self.emit(RUN_END, ok=bool(ok),
                         steps_ok=list(steps_ok), steps_failed=list(steps_failed),
                         project=self.project, actor=actor)

    def cancelled(self, *, by: str = "human", reason: str = "",
                  actor: str = ACTOR_HUMAN) -> dict:
        return self.emit(RUN_CANCEL, by=by, reason=reason,
                         project=self.project, actor=actor)

    def proc(self, step: str, text: str, *, stream: str = "stdout",
             actor: str = ACTOR_AGENT) -> dict:
        topic = PROC_STDERR if stream == "stderr" else PROC_STDOUT
        return self.emit(topic, step=step, line=text, project=self.project,
                         actor=actor)

    def proc_sink(self, step: str, *, echo: bool = True,
                  actor: str = ACTOR_AGENT):
        """造一个可直接喂给既有 ``log=`` seam 的回调（契约 §17.4）。

        ★ 这就是"CLI 人读输出与界面是同一份事件"的落地点：
          一次 emit 同时决定了 (a) 事件文件里的行、(b) 终端里看到的行。
          二者不可能漂移。
        """
        def sink(*args, **kwargs):
            text = " ".join(str(a) for a in args)
            self.proc(step, text, actor=actor)
            if echo:
                print(text, flush=True)
        return sink

    # ── 订阅（进程内）──────────────────────────────────────────
    def subscribe(self, fn) -> callable:
        with self._lock:
            self._subs.append(fn)

        def off():
            with self._lock:
                if fn in self._subs:
                    self._subs.remove(fn)
        return off

    # ── 快照 / 收尾 ─────────────────────────────────────────────
    @property
    def last_seq(self) -> int:
        with self._lock:
            return self._seq

    def tail(self, n: int = 200) -> list:
        """最近 n 条（含 proc）。给"进程内消费者"用；服务端走文件跟读。"""
        snap = self._ring.snapshot()
        return snap[-n:]

    def close(self) -> None:
        with self._lock:
            for h in self._handles.values():
                try:
                    h.close()
                except OSError:
                    pass
            self._handles.clear()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


# ── 读侧 ─────────────────────────────────────────────────────────
def replay(path, after_seq: int = 0):
    """重放只追加 JSONL 中 ``seq > after_seq`` 的事件（契约 §6.3）。

    只追加日志的直接红利：重放不需要额外机制，也不需要内存里保留历史。
    """
    path = Path(path)
    if not path.exists():
        return
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                ev = json.loads(raw)
            except ValueError:
                continue          # 半行（写到一半被读到）→ 跳过，下一轮会补齐
            if ev.get("seq", 0) > after_seq:
                yield ev


def _merge_sources(handles: dict):
    """把多个已打开文件的 pending 队列按 seq 归并产出。

    **为什么可以不看全局状态就直接比 seq**：
    写侧把"分配 seq"和"写盘"放在同一把锁内完成，因此任一时刻
    "已落盘的事件集合"恒为 seq 的**连续前缀**。于是跨文件比 seq 的大小
    就是全局正确顺序——不会出现"跨文件乱序"。
    """
    while True:
        best_key = None
        best_ev = None
        for key, st in handles.items():
            q = st["pending"]
            if q and (best_ev is None or q[0]["seq"] < best_ev["seq"]):
                best_key, best_ev = key, q[0]
        if best_ev is None:
            return
        handles[best_key]["pending"].popleft()
        yield best_ev


def follow(paths, after_seq: int = 0, *, stop=None, poll: float = 0.05,
           max_idle_s: float | None = None, drain_after_stop: float = 0.25):
    """跟读多个只追加 JSONL，**按 seq 归并**产出事件。

    :param paths: 要跟读的文件（通常 = [state.jsonl, proc.jsonl]，**顺序无关**）
    :param after_seq: 只产出 seq > 此值的事件（断线续传用）
    :param stop: 无参可调用；返回 True 表示"该结束了"（例如子进程已退出）
    :param poll: 无新行时的轮询间隔
    :param max_idle_s: 空闲超时兜底（防止忘了传 stop 时永久挂住）
    :param drain_after_stop: stop 判定成立后再多等这么久，把写者的最后一笔刷出来

    ★ 先 drain 再判 stop：否则"子进程刚退出、最后几行还没被读到"就会丢日志。
    """
    handles: dict = {}
    for p in paths:
        p = Path(p)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch(exist_ok=True)
        # 从 0 打开后自己按 seq 过滤：不做 seek 偏移推算（文件可能已被读过一半）
        handles[str(p)] = {
            "path": p,
            "fh": open(p, "r", encoding="utf-8", errors="replace"),
            "pending": deque(),
        }
    last_active = time.time()
    stopping_since = None
    try:
        while True:
            produced = False
            # ① 每个文件都读到 EOF，塞进各自 pending
            for st in handles.values():
                while True:
                    raw = st["fh"].readline()
                    if not raw:
                        break
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        ev = json.loads(raw)
                    except ValueError:
                        continue
                    if ev.get("seq", 0) > after_seq:
                        st["pending"].append(ev)
            # ② 归并产出
            for ev in _merge_sources(handles):
                produced = True
                last_active = time.time()
                yield ev
            # ③ 停止判定（放在 drain 之后）
            if stop is not None and stop():
                if stopping_since is None:
                    stopping_since = time.time()
                elif time.time() - stopping_since > drain_after_stop:
                    return
                time.sleep(poll)
                continue
            if max_idle_s is not None and (time.time() - last_active) > max_idle_s:
                return
            if not produced:
                time.sleep(poll)
    finally:
        for st in handles.values():
            try:
                st["fh"].close()
            except OSError:
                pass


def run_paths(runs_dir, run_id: str) -> list[Path]:
    """某 run 的跟读文件集。顺序无所谓（``follow`` 会按 seq 归并）。"""
    runs_dir = Path(runs_dir)
    return [runs_dir / f"{run_id}.jsonl", runs_dir / f"{run_id}.proc.jsonl"]


def append_event(runs_dir, run_id: str, topic: str, *, seq: int | None = None,
                 actor: str = ACTOR_HUMAN, **fields) -> dict | None:
    """给**已经结束**的 run 补写一条 ``run/*`` 事件（supervisor 观察到的终止）。

    ★ 这是契约 §5.4「单写者模型」的**唯一豁免**，且附硬条件：
      **调用方必须先确认原来的写者进程已经退出**（``RunManager.cancel`` 里
      ``wait()`` 过才调用）。否则就是两个进程并发写同一个文件。

    为什么需要它：取消是用 ``taskkill /T /F`` 硬杀子进程树的，子进程**没有机会**
    自己写收尾事件。若不补写，那个 run 会永远停在 ``status="running"``，
    界面也就永远显示"进行中"。

    :param seq: 省略则取磁盘上最后一个事件的 ``seq + 1``（保证单调）。
    :returns: 写好的事件；目标 run 文件不存在时返回 ``None``（不凭空造 run）。
    """
    if not topic.startswith("run/"):
        raise ValueError(f"append_event 只用于 run/* 事件，收到 {topic!r}")
    runs_dir = Path(runs_dir)
    state = runs_dir / f"{run_id}.jsonl"
    if not state.exists():
        return None
    if seq is None:
        seq = 0
        for e in replay(state, 0):
            seq = max(seq, e.get("seq", 0))
        seq += 1
    ev = {"ts": _now(), "run": run_id, "topic": topic, "seq": seq, "actor": actor}
    ev.update(fields)
    line = json.dumps(ev, ensure_ascii=False, separators=(",", ":"))
    with open(state, "a", encoding="utf-8", newline="\n") as fh:
        fh.write(line + "\n")
        fh.flush()
    return ev


def read_run(runs_dir, run_id: str, *, after_seq: int = 0) -> list:
    """一次性读全（回放/CLI/测试用），合并两个文件并按 seq 排序。"""
    out: list = []
    for p in run_paths(runs_dir, run_id):
        out.extend(replay(p, after_seq))
    out.sort(key=lambda e: e.get("seq", 0))
    return out


def list_runs(runs_dir) -> list[dict]:
    """列出所有 run 及其元数据。

    **刻意不写 ``index.json``**：索引一旦独立落盘就会与实际文件漂移，
    而它 100% 可由文件名 + 首/尾事件重建。少一个需要保持同步的东西。
    """
    runs_dir = Path(runs_dir)
    if not runs_dir.is_dir():
        return []
    out = []
    # ★ 必须排除 `*.proc.jsonl`：它们也匹配 `r-*.jsonl`，否则每个 run 都会
    #   多出一个名叫 `r-xxxx.proc` 的幻影 run（`Path.stem` 会把 `.proc` 吃进 stem）。
    files = [p for p in runs_dir.glob("r-*.jsonl") if not p.name.endswith(".proc.jsonl")]
    for p in sorted(files, key=lambda x: x.stat().st_mtime, reverse=True):
        rid = p.stem
        events = list(replay(p, 0))
        start = next((e for e in events if e.get("topic") == RUN_START), None)
        end = next((e for e in reversed(events) if e.get("topic") in (RUN_END, RUN_CANCEL)), None)
        if end is None:
            status = "running"
        elif end.get("topic") == RUN_CANCEL:
            status = "cancelled"
        else:
            status = "ok" if end.get("ok") else "failed"
        proc_file = runs_dir / f"{rid}.proc.jsonl"
        out.append({
            "run": rid,
            "project": start.get("project", "") if start else "",
            "steps": start.get("steps", []) if start else [],
            "started_at": start.get("ts") if start else p.stat().st_mtime,
            "status": status,
            "last_seq": events[-1]["seq"] if events else 0,
            "proc_bytes": proc_file.stat().st_size if proc_file.exists() else 0,
            "state_bytes": p.stat().st_size,
        })
    return out
