"""elab.serialmon —— 驾驶舱常驻串口监视会话（「打开监视 / 关闭监视」）。

与既有两位兄弟的职责边界
------------------------
    monitor.py    闭环**判据**：run 内开一次口、收一段、判 ok/failed/inconclusive，
                  落 run 事件流（serial/* 域事件）
    serialterm.py **无状态往返**：写一条、收一小段回显、立刻关口（M3-b）
    serialmon.py  **常驻监视**：人在界面点「打开监视」→ 口一直开着，设备输出
                  实时流进串口 Tab；「关闭监视」收摊

M3-b 曾裁定"不做常驻会话"，那个结论**没有被推翻**——串口独占（N5）、
持口线程僵死没人释放的物理事实至今成立。所以本模块的常驻会话带着三道防身：

    ① 进程内**单例**，且必须能被显式关闭（按钮一键关；有任何异常自动收摊）；
    ② 读线程只做 ``read`` 超时循环（阻塞上限 200ms），任何异常 → 记入 ``error``、
       ``alive=False``，**绝不带着死口挂着**；
    ③ 会话期间，手写通道**路由进会话**（同一个口直接 write，不再重开口）——
       不破坏 N5，也让"边看输出边敲命令"成为自然的体验。

代价（物理事实，写进 UI 提示）：监视开着时，``elab run`` 的
flash/debug_verify/monitor 步骤与 CLI ``elab serial`` **打不开口** ——
服务端会 409 指名道姓（"串口监视正占用 COM10，先关闭监视"），而不是让用户
对着一串 ``ERROR_ACCESS_DENIED`` 去拔插。

输出走哪条道
------------
**不进 run 事件流**（不属于任何 run —— C17 单写者与 C28 同源的理由）；
**也不落 console 留档**（留档是"我敲过什么"的 TX/RX 历史，监视输出是设备
喋喋不休的心跳，落盘只会把留档撑爆）。只活在**服务端环形缓冲**（MAX_LINES）
与浏览器本地缓冲里，服务重启即失。它是"看"，不是"证据"；要证据走闭环的
monitor 步骤（有 verdict、有事件流、有 .jsonl）。
"""

from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime

from . import serialport as sp
from . import serialterm as st
from .config import Config

#: 服务端环形缓冲上限。浏览器 600ms 轮询一次，正常永远追得上；
#: 真追不上（页面挂后台被节流）时用 ``gap`` 显式告诉前端"缺了行"，不抹平。
MAX_LINES = 2000
#: 残留半行的冲刷时限：设备只发提示符不发 ``\\n`` 时（如 ``> ``），
#: 靠"静默超过这么久就把残留当一行"让它可见。
PARTIAL_FLUSH_S = 1.0


class _Session:
    """一次监视会话：一个口、一个读线程、一个环形缓冲。"""

    def __init__(self, project: str, port: str, baud: int, io: "sp.SerialIO"):
        self.project = project
        self.port = port
        self.baud = baud
        self.io = io
        self.backend = ""
        self.lines: deque[dict] = deque(maxlen=MAX_LINES)
        self.seq = 0                    # 会话内单调，浏览器用它做增量游标
        self.covered = 0                # 环形缓冲挤掉的总行数（gap 的证据）
        self.stop = threading.Event()
        self.error: str | None = None
        self.alive = True
        self.thread = threading.Thread(target=self._reader, name="serialmon",
                                       daemon=True)
        self.wlock = threading.Lock()   # write() 与读线程收尾（close io）互斥

    # ── 读线程 ──────────────────────────────────────────────────
    def start(self) -> None:
        self.io.open()                  # 可能抛 OSError —— 调用方接住
        self.backend = self.io.backend
        self.thread.start()

    def _reader(self) -> None:
        buf = b""
        last_data = time.time()
        try:
            # ★ io 已在 start() 里 open 过 —— 绝不再走 `with`（__enter__ 会二次
            #   open 同一个口，撞上自己持有的独占句柄 → ACCESS_DENIED，
            #   真机首测即抓出）。收口统一在 shutdown()。
            s = self.io
            while not self.stop.is_set():
                chunk = s.read(4096)
                if not chunk:
                    # 静默期：残留半行放久了也要可见（提示符型设备）
                    if buf and time.time() - last_data > PARTIAL_FLUSH_S:
                        self._push(buf.decode("utf-8", errors="replace").rstrip("\r"))
                        buf = b""
                    time.sleep(0.02)
                    continue
                last_data = time.time()
                buf += chunk
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    self._push(raw.decode("utf-8", errors="replace").rstrip("\r"))
        except Exception as exc:                     # noqa: BLE001
            # 拔线 / 口被抢 / 驱动报错 —— 记下、收摊。绝不带着死口挂着。
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.alive = False

    def _push(self, text: str) -> None:
        if len(self.lines) == self.lines.maxlen:
            self.covered += 1        # deque 自动挤掉最旧的 —— 这里留个证据
        self.seq += 1
        self.lines.append({"seq": self.seq, "text": text,
                           "t": datetime.now().strftime("%H:%M:%S")})

    # ── 对外操作 ────────────────────────────────────────────────
    def write(self, data: bytes) -> int:
        with self.wlock:
            if not self.alive:
                return 0
            return self.io.write(data)

    def shutdown(self) -> None:
        self.stop.set()
        self.thread.join(timeout=3)
        with self.wlock:
            self.io.close()          # 读线程的 with 兜底已关；这里关第二次无害


# ══════════════════════════════════════════════════════════════════
#  进程内单例（驾驶舱服务一次只有一个口被监视 —— 串口独占，本就该只有一个）
# ══════════════════════════════════════════════════════════════════
_LOCK = threading.Lock()
_SESS: _Session | None = None


def _snapshot(s: _Session | None) -> dict:
    if s is None:
        return {"active": False}
    return {"active": s.alive, "project": s.project, "port": s.port,
            "baud": s.baud, "backend": s.backend, "seq": s.seq,
            "covered": s.covered, "error": s.error}


def open_session(cfg: Config, project: str, *, port: str = "", baud: int = 0,
                 log=print) -> dict:
    """打开（或拒绝重复打开）监视会话。返回值可直接 JSON 化。

    端口/波特率解析与 ``serialterm.resolve_target`` **同一份实现** ——
    "预览说 COM10、监视却开了别的口"这种分叉，一个都不许有。
    """
    global _SESS
    with _LOCK:
        cur = _SESS
        if cur is not None and cur.alive:
            return {"ok": False, "error": (
                f"监视已在进行（{cur.port}@{cur.baud}）—— "
                f"先关闭当前监视再换口/换工程")}
        caps = sp.capabilities()
        if not caps["available"]:
            return {"ok": False,
                    "error": f"串口后端不可用（layer={caps['layer']}）：{caps.get('hint')}"}
        t = st.resolve_target(cfg, project, port=port, baud=baud)
        if not t["port"]:
            return {"ok": False, "error": t["reason"],
                    "port": "", "baud": t["baud"]}
        io = sp.SerialIO(t["port"], t["baud"], for_write=True)
        sess = _Session(project, t["port"], t["baud"], io)
        try:
            sess.start()
        except OSError as exc:
            return {"ok": False, "error": str(exc),
                    "port": t["port"], "baud": t["baud"]}
        _SESS = sess
    log(f"[serialmon] ▶ {sess.port}@{sess.baud}（project={project or '-'}，"
        f"backend={sess.backend}）")
    return {"ok": True, **_snapshot(sess)}


def close_session(*, log=print) -> dict:
    """关闭会话。**幂等**：没有会话也返回 ok（按钮连点、双标签页都安全）。"""
    global _SESS
    with _LOCK:
        s = _SESS
        _SESS = None
    if s is None:
        return {"ok": True, "note": "没有进行中的监视"}
    s.shutdown()
    log(f"[serialmon] ■ 关闭 {s.port}@{s.baud}（收 {s.seq} 行"
        + (f"，error={s.error}" if s.error else "") + "）")
    return {"ok": True, "closed": {"port": s.port, "baud": s.baud, "lines": s.seq}}


def tail(after: int) -> dict:
    """增量读回：``seq > after`` 的行 + 会话状态。``gap``=浏览器错过的行数下限。

    ★ gap 只报告、**不抹平**：环形缓冲挤掉了行就必须说出来，否则"后台标签页
      被节流的浏览器"会以为自己看到的是全部。``after=0``（浏览器什么都不知道）
      同样参与计算 —— 它错过的就是被挤掉的那几行。
    """
    s = _SESS
    if s is None:
        return {"active": False, "lines": [], "seq": 0, "gap": 0}
    lines = [x for x in s.lines if x["seq"] > after]
    gap = max(0, lines[0]["seq"] - after - 1) if lines else 0
    return {**_snapshot(s), "lines": lines, "gap": gap}


def status() -> dict:
    """给 capabilities / 初始渲染用的轻量快照。"""
    return _snapshot(_SESS)


def write_through(data: bytes) -> int | None:
    """监视中把一行写出口。

    返回 ``None`` = 没有会话（调用方走原往返通道）；返回字节数 ——
    **会话已死也返回 0**（而不是 None）：服务端据此路由进"写失败"分支并
    提示"关闭重开监视"，而不是静默回落到往返通道去重开一个可能已失效的口。
    """
    s = _SESS
    if s is None:
        return None
    return s.write(data)
