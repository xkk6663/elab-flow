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

数据平面（P1 起）
-----------------
**原文为真**：每次 ``read()`` 的原始字节是一条 **RX 批次**，每次 ``write()``
成功的字节是一条 **TX 批次**；行文本只是字节流的投影。批次带：

    seq        会话内单调的批次序号（与行的 ``seq`` 独立）
    dir        rx / tx
    t_us       采集时刻（微秒，前端可做时间轴）
    data       原始字节（HTTP 出口转 base64）

另有三样老接口没有、但"看得懂"必需的语义：

    epoch            连接纪元：每次 open 自增；前端发现变化必须重置游标
    covered_chunks   环形缓冲挤掉的批次数（gap 的证据）
    paused           暂停入环（仍继续读口，避免把设备侧缓冲撑爆）

输出走哪条道
------------
**不进 run 事件流**（不属于任何 run —— C17 单写者与 C28 同源的理由）；
**也不落 console 留档**（留档是"我敲过什么"的 TX/RX 历史，监视输出是设备
喋喋不休的心跳，落盘只会把留档撑爆）。只活在**服务端环形缓冲**与浏览器本地
缓冲里，服务重启即失。它是"看"，不是"证据"；要证据走闭环的 monitor 步骤
（有 verdict、有事件流、有 .jsonl）。

Agent 租约
---------
Agent 打开的监视会话可以带 ``lease_s``：``tail`` / ``tail_bytes`` 每次访问都会
续租；租约到期 → 读线程自行收摊，``error="lease_expired"``。这样"Agent 忘关"
不会把串口一直占死（N5）。
"""

from __future__ import annotations

import base64
import json
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

from . import serialcodec as codec
from . import logdecode as ld
from . import serialframes as sf
from . import serialport as sp
from . import serialtransport as tp
from .config import Config

#: 行环形缓冲上限。浏览器轮询一次，正常永远追得上；
#: 真追不上（页面挂后台被节流）时用 ``gap`` 显式告诉前端"缺了行"，不抹平。
MAX_LINES = 2000
#: 字节环上限：双上限防"1 字节批次"把内存撑爆（1 MiB / 4096 批）。
MAX_BYTES = 1 << 20
MAX_CHUNKS = 4096
#: 残留半行的冲刷时限：设备只发提示符不发 ``\n`` 时（如 ``> ``），
#: 靠"静默超过这么久就把残留当一行"让它可见。
PARTIAL_FLUSH_S = 1.0
#: 录制文件上限（K5）：**有界**是硬要求 —— 不设上限的录制迟早把磁盘写满，
#: 而串口是设备喋喋不休的心跳。到顶就停录并标 ``truncated``，不静默继续。
CAP_MAX_BYTES = 5 << 20
#: 会话级解码帧环上限。波形页只画最近一段；agent 用游标增量读。
#: 与行/字节环同款：**有界 + gap 如实报告**，不在内存里无限攒帧。
MAX_DEC_FRAMES = 1024
#: 半帧上限。正常半帧 = 一帧以内（几十字节）；长时间解不出尾标记说明
#: 流里混了不属于该解码器的字节 —— 到顶就丢弃并计入 ``skipped``，不让它无限长。
MAX_DEC_PENDING = 64 << 10

#: 速率统计窗口（秒）与事件环上限。**服务端算、前端只渲染**（方案 §4.6）。
#: 高速率下 1.2s 窗口事件数可能上千 —— 有界 deque 保证读线程不被统计拖慢。
RATE_WINDOW_S = 1.0
RATE_MAX_EVENTS = 2048

#: 重连默认值（附录 B）：开、200ms → 5s 封顶、无限次。
RECONNECT_DEFAULT = {"enabled": True, "min_ms": 200, "max_ms": 5000,
                     "max_attempts": 0}


def _reconnect_cfg(raw=None) -> dict:
    """解析重连配置（请求 > 项目 > 默认）；错误项回落到默认值。"""
    out = dict(RECONNECT_DEFAULT)
    if isinstance(raw, dict):
        if raw.get("enabled") is not None:
            out["enabled"] = bool(raw["enabled"])
        for k in ("min_ms", "max_ms", "max_attempts"):
            if raw.get(k) is not None:
                try:
                    out[k] = max(0, int(raw[k]))
                except (TypeError, ValueError):
                    pass
    elif raw is False:
        out["enabled"] = False
    out["min_ms"] = max(50, out["min_ms"])
    out["max_ms"] = max(out["min_ms"], out["max_ms"])
    return out


def _now() -> tuple[float, int, str]:
    """(unix 秒, 微秒时间戳, HH:MM:SS.mmm)。"""
    t = time.time()
    dt = datetime.fromtimestamp(t)
    return t, int(t * 1_000_000), dt.strftime("%H:%M:%S.%f")[:-3]


class _Session:
    """一次监视会话：一个口、一个读线程、行环 + 字节环。"""

    def __init__(self, project: str, port: str, baud: int, io: "sp.SerialIO",
                 *, epoch: int = 1, opened_by: str = "human",
                 lease_s: float = 0.0, allow_agent_write: bool = False,
                 line: "sp.LineConfig | None" = None, port_spec: str = "",
                 kind: str = "serial", reconnect: dict | None = None,
                 opener=None, target: "tp.Target | None" = None):
        self.project = project
        self.port = port
        self.baud = baud
        self.io = io
        self.line = line or sp.LineConfig()
        self.port_spec = port_spec or port
        self.kind = kind
        self.target = target
        #: 重开闭包：``() -> (io, target|None)``。默认由 ``open_session`` 按
        #: ``serialtransport.resolve`` 生成；单测可注入假 IO（FakeIO 抛 TransportLost）。
        self.opener = opener
        self.backend = ""
        self.epoch = epoch
        self.opened_by = opened_by
        self.allow_agent_write = allow_agent_write

        # ── 连接态（M2）：重连是**同一逻辑会话**，不 bump epoch、不清环 ──
        self.reconnect = _reconnect_cfg(reconnect)
        self.state = "live"             # live | reconnecting | suspended | closed
        self.conn = 1                   # 成功连接次数（open 算第 1 次）
        self.reconnects = 0             # 掉线后自动重连成功的次数
        self.down_s = 0.0               # 最近一次掉线持续时间（秒）
        self._lost_at = 0.0             # 掉线时刻（unix 秒；0 = 没掉过）
        self.port_changed: dict | None = None
        self.last_error: str | None = None
        self.resume_error: str | None = None
        self.suspended_by_run = False   # 只有「因 run 让位」才允许自动回归
        self.suspend_reason = ""
        # ── 日志诊断（M6）：会话级 profile + 有界 issue 环 ──
        self.log_profile: dict | None = None
        self.log_profile_id = ""
        self.issues: deque = deque(maxlen=ld.MAX_ISSUES)
        self.issue_seq = 0
        self.issue_covered = 0
        self._after_reset = False
        # ── 帧协议（M5）：profile 解码的字段元数据 + 记录环 ──
        self.frame_profile: dict | None = None
        self.dec_fields: list = []
        self.dec_records: deque = deque(maxlen=20)

        # ── 行投影 ──
        self.lines: deque[dict] = deque(maxlen=MAX_LINES)
        self.seq = 0                    # 行序号（旧接口的游标）
        self.covered = 0                # 行环挤掉的总行数（gap 的证据）

        # ── 字节真值 ──
        self.chunks: deque[dict] = deque()
        self.chunk_seq = 0
        self.covered_chunks = 0
        self.bytes_total = 0
        self.dlock = threading.Lock()   # 行/批次/计数器/录制的互斥
        # 显式录制（K5）：None = 从未录过；active=False 表示已停/已到顶。
        self.cap: dict | None = None

        # ── 会话级解码（共享）──
        # ★ 解码器是**会话属性**，不是调用方的私有选项：agent 选定后，人在面板
        #   波页看到的必须是同一套帧（"agent 驱动可视化结论"的落点）。
        self.decoder = ""               # '' = 未启用解码
        self.decoder_by = ""            # human / agent（谁最后选定）
        self.dec_frames: deque[dict] = deque(maxlen=MAX_DEC_FRAMES)
        self.dec_seq = 0                # 帧序号（单调；clear/换解码器也不回退）
        self.dec_covered = 0            # 帧环挤掉的总帧数（gap 的证据）
        self.dec_pending = b""          # 半帧（下一批续解）
        self.dec_total = 0              # 已解出的总帧数（当前解码器）
        self.dec_skipped = 0            # 被跳过的候选帧/坏行数
        self.dec_channels = 0           # 已推断出的通道数
        self.dec_updated = 0.0
        self.dec_error: str | None = None

        self.stop = threading.Event()
        self.error: str | None = None
        self.alive = True
        self.paused = False
        self.lease_s = max(0.0, float(lease_s or 0))
        self.lease_deadline = (time.time() + self.lease_s) if self.lease_s else 0.0
        # DTR/RTS 的**已知状态**（None = 没动过/未知）。它不进字节环、不算 TX
        # —— 物理线路动作不是数据证据（方案 §4.2）。
        self.control = {"dtr": None, "rts": None, "verified": False,
                        "preset": "", "by": "", "at": 0.0}
        #: 速率统计（方案 §4.6）：只保留最近 1.2s 的事件，服务端算、前端只渲染。
        self.started_us = int(time.time() * 1_000_000)
        self.rx_bytes_total = 0
        self.tx_bytes_total = 0
        self.rate_events: deque[tuple[int, str, int]] = deque(maxlen=RATE_MAX_EVENTS)
        self.frame_events: deque[int] = deque(maxlen=RATE_MAX_EVENTS)
        self.thread = None              # 由 _start_reader 创建（suspend/resume 可重启）
        self.wlock = threading.Lock()   # write() 与读线程收尾（close io）互斥

    # ── 读线程 ──────────────────────────────────────────────────
    def start(self) -> None:
        self.io.open()                  # 可能抛 OSError —— 调用方接住
        self._start_reader()

    def _start_reader(self) -> None:
        self.backend = self.io.backend
        self.stop = threading.Event()
        self.alive = True
        self.thread = threading.Thread(target=self._reader, name="serialmon",
                                       daemon=True)
        self.thread.start()

    def _lease_due(self) -> bool:
        return bool(self.lease_s) and time.time() > self.lease_deadline

    def _reader(self) -> None:
        buf = b""
        last_data = time.time()
        # 夹具会把 sm.sp 换成 SimpleNamespace（没有 TransportLost）—— 此时
        # 用 OSError 兜底：读口抛 OSError 一律视为链路断了，不是"暂时没数据"。
        lost_cls = getattr(sp, "TransportLost", OSError)
        try:
            # ★ io 已在 start() 里 open 过 —— 绝不再走 `with`（__enter__ 会二次
            #   open 同一个口，撞上自己持有的独占句柄 → ACCESS_DENIED，
            #   真机首测即抓出）。收口统一在 finally / shutdown()。
            s = self.io
            while not self.stop.is_set():
                if self._lease_due():
                    # Agent 忘了关 → 租约到期自愈，不把口一直占死（N5）。
                    self.error = "lease_expired"
                    self.state = "closed"
                    break
                try:
                    chunk = s.read(4096)
                except lost_cls as exc:
                    # 拔线 / 驱动卸载 / 端口被抢：先如实标记，再按策略重连。
                    if not self._on_transport_lost(exc):
                        return
                    s, buf = self.io, b""
                    last_data = time.time()
                    continue
                if not chunk:
                    # 静默期：残留半行放久了也要可见（提示符型设备）
                    if buf and not self.paused and \
                            time.time() - last_data > PARTIAL_FLUSH_S:
                        self._push_line(buf.decode("utf-8", errors="replace").rstrip("\r"))
                        buf = b""
                    time.sleep(0.02)
                    continue
                last_data = time.time()
                # 原文先入字节环（暂停也不丢"已经读过"的字节 —— 暂停只表示
                # 不再展示/入环；这里等待，故先判断）。
                if not self.paused:
                    self._push_chunk(chunk, "rx")
                buf += chunk
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    if not self.paused:
                        self._push_line(raw.decode("utf-8", errors="replace").rstrip("\r"))
        except Exception as exc:                     # noqa: BLE001
            # 口被抢 / 驱动报错 —— 记下、收摊。绝不带着死口挂着。
            self.error = f"{type(exc).__name__}: {exc}"
            if self.state != "suspended":
                self.state = "closed"
        finally:
            self.alive = False
            with self.wlock:
                try:
                    self.io.close()      # 二次关闭无害（SerialIO.close 幂等）
                except Exception:        # noqa: BLE001
                    pass

    # ── 掉线处理 / 重连（M2 §4.3）──────────────────────────────
    def _on_transport_lost(self, exc: Exception) -> bool:
        """链路断了。返回 True = 已重连成功（读线程可继续），False = 收摊。"""
        self.last_error = f"{type(exc).__name__}: {exc}"
        if not self.reconnect["enabled"]:
            self.error = self.last_error
            self.state = "closed"
            return False
        self.state = "reconnecting"
        self._lost_at = time.time()
        self.down_s = 0.0
        # 断线前的半帧不可续 —— 否则重连后的第一帧会拼上旧协议残留。
        self.dec_pending = b""
        delay = self.reconnect["min_ms"] / 1000.0
        attempt = 0
        max_attempts = int(self.reconnect.get("max_attempts") or 0)
        while not self.stop.is_set():
            if max_attempts and attempt >= max_attempts:
                break
            attempt += 1
            # 可中断的退避等待：suspend/close 必须立刻生效，不能睡满 5s。
            if self.stop.wait(delay):
                return False
            try:
                opened = self.opener() if self.opener else (None, None)
                if isinstance(opened, tuple):
                    new_io, new_t = opened
                else:
                    new_io, new_t = opened, None
                if new_io is None:
                    raise OSError("没有可用的重开方式（opener 为空）")
                new_io.open()
            except Exception as again:                 # noqa: BLE001
                self.last_error = f"{type(again).__name__}: {again}"
                delay = min(delay * 2, self.reconnect["max_ms"] / 1000.0)
                continue
            # 成功：同一逻辑会话，epoch/环不变；只累计 conn/reconnects。
            old_port = self.port
            if new_t is not None:
                if new_t.label and new_t.label != old_port:
                    self.port_changed = {"from": old_port, "to": new_t.label}
                self.port = new_t.label or old_port
                self.port_spec = new_t.port_spec or self.port_spec
                self.line = new_t.line
                self.target = new_t
            old_io = self.io
            with self.wlock:
                self.io = new_io
            try:
                old_io.close()                   # 旧句柄已失效，关掉不留垃圾
            except Exception:                    # noqa: BLE001
                pass
            self.backend = new_io.backend
            self.down_s = round(time.time() - self._lost_at, 1)
            self._lost_at = 0.0
            self.conn += 1
            self.reconnects += 1
            self.state = "live"
            self.error = None
            return True
        self.down_s = round(time.time() - self._lost_at, 1) if self._lost_at else self.down_s
        self._lost_at = 0.0
        self.state = "closed"
        self.error = f"重连失败（{attempt} 次）：{self.last_error}"
        return False

    def suspend(self, reason: str = "", *, by_run: bool = False) -> dict:
        """让出串口（闭环要用了）：停读线程、关 IO，但**保留环与 epoch**。"""
        if self.state == "closed":
            return {"ok": False, "error": "会话已结束"}
        self.stop.set()
        t = self.thread
        if t is not None and t.is_alive():
            t.join(timeout=2)
        with self.wlock:
            try:
                self.io.close()
            except Exception:                        # noqa: BLE001
                pass
        self.alive = False
        self.state = "suspended"
        self.suspend_reason = reason or "suspended"
        self.suspended_by_run = bool(by_run)
        return {"ok": True, "state": self.state, "reason": self.suspend_reason}

    def restore(self) -> dict:
        """闭环跑完自动回归：用同一 target 重开（不 bump epoch、不清环）。

        命名避开 ``resume`` —— 后者是「解除暂停展示」（``paused``），两件事不同。
        """
        if self.state != "suspended":
            return {"ok": False, "error": f"会话不在 suspended 状态（{self.state}）"}
        try:
            opened = self.opener() if self.opener else (None, None)
            if isinstance(opened, tuple):
                new_io, new_t = opened
            else:
                new_io, new_t = opened, None
            if new_io is None:
                raise OSError("没有可用的重开方式（opener 为空）")
            new_io.open()
        except Exception as exc:                     # noqa: BLE001
            self.resume_error = f"{type(exc).__name__}: {exc}"
            return {"ok": False, "error": self.resume_error, "state": self.state}
        if new_t is not None:
            if new_t.label and new_t.label != self.port:
                self.port_changed = {"from": self.port, "to": new_t.label}
            self.port = new_t.label or self.port
            self.port_spec = new_t.port_spec or self.port_spec
            self.line = new_t.line
            self.target = new_t
        with self.wlock:
            self.io = new_io
        self.dec_pending = b""
        self.conn += 1
        self.state = "live"
        self.suspended_by_run = False
        self.suspend_reason = ""
        self.resume_error = None
        self._start_reader()
        return {"ok": True, "state": self.state, "conn": self.conn}

    def _push_line(self, text: str) -> None:
        with self.dlock:
            if len(self.lines) == self.lines.maxlen:
                self.covered += 1    # deque 自动挤掉最旧的 —— 这里留个证据
            self.seq += 1
            t, t_us, hms = _now()
            self.lines.append({"seq": self.seq, "text": text,
                               "t": hms[:8], "t_us": t_us})
            self._analyze_line(text, t_us, hms)

    def _analyze_line(self, text: str, t_us: int, hms: str) -> None:
        """按会话 log_profile 解析 panic / 复位 / 回溯行（M6）。**已持 dlock**。"""
        if not self.log_profile:
            return
        ev = ld.parse_line(text, self.log_profile, after_reset=self._after_reset)
        if not ev:
            return
        if ev["kind"] == "reset":
            self._after_reset = True
            self._append_issue("reset", ev, t_us, hms)
            return
        if ev["kind"] == "backtrace":
            if self.issues and self.issues[-1]["kind"] in ("panic", "assert", "hardfault"):
                cur = self.issues[-1]
                cur["backtrace"] = list(dict.fromkeys(
                    list(cur.get("backtrace") or []) + list(ev["addrs"])))
            return
        self._append_issue(ev["kind"], ev, t_us, hms)
        if ev["kind"] in ("panic", "assert", "hardfault"):
            self._after_reset = False

    def _append_issue(self, kind: str, ev: dict, t_us: int, hms: str) -> None:
        if len(self.issues) == self.issues.maxlen:
            self.issue_covered += 1
        self.issue_seq += 1
        self.issues.append({
            "seq": self.issue_seq, "kind": kind, "core": ev.get("core"),
            "reason": ev.get("reason"), "line": ev.get("line", ""),
            "t": hms[:8], "t_us": t_us,
            "backtrace": list(dict.fromkeys(ev.get("backtrace") or [])),
            "after_reset": bool(ev.get("after_reset")),
            "symbols": None,
        })

    def _push_chunk(self, data: bytes, direction: str) -> None:
        if not data:
            return
        t, t_us, hms = _now()
        with self.dlock:
            self.chunk_seq += 1
            rec = {"seq": self.chunk_seq, "dir": direction, "t_us": t_us,
                   "t": hms, "data": bytes(data)}
            self.chunks.append(rec)
            self.bytes_total += len(rec["data"])
            # 速率事件（rx/tx 同记；服务端算 stats，前端只渲染）
            self.rate_events.append((t_us, direction, len(rec["data"])))
            if direction == "rx":
                self.rx_bytes_total += len(rec["data"])
            else:
                self.tx_bytes_total += len(rec["data"])
            # 双上限：批次太多或字节总量超限时挤掉最旧的（只报告，不抹平）。
            while self.chunks and (len(self.chunks) > MAX_CHUNKS
                                  or self.bytes_total > MAX_BYTES):
                old = self.chunks.popleft()
                self.bytes_total -= len(old["data"])
                self.covered_chunks += 1
            # 录制在**入环之后**：环会挤出旧批次，录像不会（它的语义是"证据"）。
            self._cap_emit(rec["seq"], t_us, direction, rec["data"])
            # 会话级解码只吃 **RX**（设备输出）。TX 是我们自己写的命令，
            # 混进波形会把"设备在说什么"变成"我们刚才问了什么"。
            if direction == "rx" and self.decoder:
                self._decode_locked(rec["data"], t_us, hms)

    # ── 会话级解码（共享帧环）──────────────────────────────────
    def _decode_locked(self, data: bytes, t_us: int, hms: str) -> None:
        """增量解码一批 RX 字节。**调用方已持 dlock**。

        半帧不丢：``dec_pending`` 原样带到下一批（与 ``serialcodec`` 的语义
        同源）。解码失败不拖死读线程 —— 只记 ``dec_error``，下一批再试。
        """
        try:
            res = codec.decode(self.dec_pending + bytes(data), self.decoder,
                               channels=self.dec_channels or None,
                               profile=self.frame_profile)
        except Exception as exc:                   # noqa: BLE001
            self.dec_error = f"{type(exc).__name__}: {exc}"
            return
        if not res.get("ok"):
            self.dec_error = str(res.get("error") or "解码失败")
            return
        self.dec_error = None
        self.dec_channels = int(res.get("channels") or self.dec_channels or 0)
        self.dec_skipped += int(res.get("skipped") or 0)
        if res.get("fields"):
            self.dec_fields = list(res["fields"])
        records = res.get("records") or []
        if records:
            for rec in records[-20:]:
                self.dec_records.append(rec)
        pending_b64 = str(res.get("pending_b64") or "")
        self.dec_pending = (base64.b64decode(pending_b64) if pending_b64 else b"")
        if len(self.dec_pending) > MAX_DEC_PENDING:
            # 混了不属于该解码器的字节：半帧不可能这么长 —— 丢掉并如实计跳过。
            self.dec_skipped += 1
            self.dec_pending = b""
        for vals in res.get("frames") or []:
            self.dec_seq += 1
            self.dec_total += 1
            if len(self.dec_frames) == self.dec_frames.maxlen:
                self.dec_covered += 1
            self.dec_frames.append({"seq": self.dec_seq, "t": hms,
                                    "t_us": t_us, "values": list(vals)})
            self.frame_events.append(t_us)
        self.dec_updated = time.time()

    def _decode_view_locked(self) -> dict:
        """解码状态投影（给快照 / 动作返回值用）。**调用方已持 dlock**。"""
        return {"decoder": self.decoder, "decoder_by": self.decoder_by,
                "channels": self.dec_channels, "total_frames": self.dec_total,
                "profile": (self.frame_profile or {}).get("id", ""),
                "fields": list(self.dec_fields),
                "records": list(self.dec_records),
                "skipped": self.dec_skipped,
                "pending_bytes": len(self.dec_pending),
                "covered": self.dec_covered,
                "updated_at": round(self.dec_updated, 3),
                "error": self.dec_error}

    def set_decoder(self, decoder: str, *, actor: str = "human",
                    profile: dict | None = None) -> dict:
        """会话级选定/清除解码器（agent 与人都走这一处）。

        换解码器 = 清空帧环与半帧，但**帧序号保持单调**（clear 也不回退）：
        前端/agent 手里的游标不会因为"换了个解码器"而突然读到旧帧。
        """
        dec = str(decoder or "").strip()
        builtin = ("", "justfloat", "firewater")
        is_profile = dec == "profile" or dec.startswith("profile:")
        if dec not in builtin and not is_profile:
            return {"ok": False, "error": f"未知解码器：{dec!r}"}
        if is_profile and not isinstance(profile, dict):
            return {"ok": False, "error": "profile 解码器缺少帧协议配置"}
        with self.dlock:
            self.dec_covered += len(self.dec_frames)
            self.dec_frames.clear()
            self.dec_pending = b""
            self.dec_fields = []
            self.dec_records.clear()
            self.dec_total = 0
            self.dec_skipped = 0
            self.dec_channels = 0
            self.dec_error = None
            self.decoder = dec
            self.frame_profile = dict(profile) if is_profile else None
            self.decoder_by = actor if dec else ""
            self.dec_updated = time.time()
            return {"ok": True, "active": self.alive, "epoch": self.epoch,
                    **self._decode_view_locked()}

    def tail_decoded(self, after: int = 0) -> dict:
        """增量读回共享解码帧（``seq > after``）。返回下一游标与 gap。"""
        with self.dlock:
            frames = [dict(f) for f in self.dec_frames if f["seq"] > after]
            gap = max(0, frames[0]["seq"] - after - 1) if frames else 0
            return {"active": self.alive, "epoch": self.epoch,
                    "next_after": self.dec_seq, "frames": frames, "gap": gap,
                    **self._decode_view_locked()}


    # ── 速率统计（M2 §4.6）─────────────────────────────────────
    def _compute_stats(self, now_us: int) -> dict:
        """最近 1s 的 RX/TX 速率、帧率与缓冲占用。**调用方已持 dlock**。

        窗口不足 1s（刚开会话）时按实际跨度折算并标 ``warmup:true`` ——
        不假装是满窗速率；一次性收 1 KiB 后停，事件滑出窗口即回 0。
        """
        cutoff = now_us - int(RATE_WINDOW_S * 1_000_000)
        while self.rate_events and self.rate_events[0][0] < cutoff:
            self.rate_events.popleft()
        rx = sum(n for _t, d, n in self.rate_events if d == "rx")
        tx = sum(n for _t, d, n in self.rate_events if d == "tx")
        while self.frame_events and self.frame_events[0] < cutoff:
            self.frame_events.popleft()
        frames = len(self.frame_events)
        elapsed = min(RATE_WINDOW_S, max(0.0, (now_us - self.started_us) / 1_000_000))
        warmup = elapsed < RATE_WINDOW_S
        denom = max(elapsed, 0.05)          # 避免刚开会话时除零/巨大假峰值
        return {
            "rx_bps": round(rx / denom, 1),
            "tx_bps": round(tx / denom, 1),
            "rx_bytes_total": self.rx_bytes_total,
            "tx_bytes_total": self.tx_bytes_total,
            "frames_per_s": round(frames / denom, 1) if self.decoder else None,
            "frames_total": self.dec_total,
            "warmup": warmup,
            "buffer": {
                "lines": round(len(self.lines) / MAX_LINES, 3),
                "chunks": round(len(self.chunks) / MAX_CHUNKS, 3),
                "bytes": round(self.bytes_total / MAX_BYTES, 3),
                "frames": round(len(self.dec_frames) / MAX_DEC_FRAMES, 3),
            },
            "covered": {"lines": self.covered, "chunks": self.covered_chunks,
                        "frames": self.dec_covered},
        }

    # ── 录制（K5）──────────────────────────────────────────────
    def _cap_emit(self, seq: int, t_us: int, direction: str,
                  data: bytes) -> None:
        """把一条批次写进录制文件。**调用方已持 dlock。**

        只存字节（``bytes_b64``），不存文本投影 —— 行是投影，可随时重建；
        录进去反而是把一份已经丢失信息的东西当证据。
        """
        cap = self.cap
        if not cap or not cap["active"]:
            return
        line = json.dumps({"seq": seq, "t_us": t_us, "dir": direction,
                           "bytes_b64": base64.b64encode(data).decode("ascii")},
                          ensure_ascii=False) + "\n"
        if cap["bytes"] + len(line.encode("utf-8")) > cap["max_bytes"]:
            # 到顶：停录 + 记 truncated。**不截半条**（半条 JSON 不可回放）。
            cap["truncated"] = True
            self._cap_close(cap)
            return
        try:
            cap["fh"].write(line)
        except Exception:                    # noqa: BLE001
            # 磁盘写失败（被拔 U 盘、权限）→ 停录并记录原因，绝不拖死读线程
            cap["error"] = "录制写盘失败"
            self._cap_close(cap)
            return
        cap["bytes"] += len(line.encode("utf-8"))
        cap["chunks"] += 1

    def _cap_close(self, cap: dict) -> None:
        """收口（幂等）。调用方已持 dlock。"""
        cap["active"] = False
        fh = cap.pop("fh", None)
        if fh is not None:
            try:
                fh.close()
            except Exception:                # noqa: BLE001
                pass

    def start_capture(self, out_dir: Path, *, max_bytes: int = CAP_MAX_BYTES) -> dict:
        """开始录制到 ``out_dir``。已在录则拒绝（不静默换文件）。"""
        with self.dlock:
            if self.cap and self.cap["active"]:
                return {"ok": False, "error": "录制已在进行",
                        "path": self.cap["path"], "bytes": self.cap["bytes"]}
            if not self.alive:
                return {"ok": False, "error": "监视已结束（读线程已收摊）"}
            out_dir.mkdir(parents=True, exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            path = out_dir / f"serial-capture-e{self.epoch}-{ts}.jsonl"
            try:
                fh = path.open("a", encoding="utf-8", buffering=1)
            except OSError as exc:
                return {"ok": False, "error": f"无法创建录制文件：{exc}",
                        "path": str(path)}
            self.cap = {"active": True, "path": str(path), "fh": fh,
                        "bytes": 0, "chunks": 0, "max_bytes": int(max_bytes),
                        "truncated": False, "error": None, "epoch": self.epoch}
            return {"ok": True, "path": str(path), "epoch": self.epoch,
                    "max_bytes": int(max_bytes)}

    def stop_capture(self) -> dict:
        """停止录制并返回统计。没在录也返回 ok（幂等）。"""
        with self.dlock:
            cap = self.cap
            if not cap:
                return {"ok": True, "note": "没有进行中的录制"}
            self._cap_close(cap)
            return {"ok": True, "path": cap["path"], "bytes": cap["bytes"],
                    "chunks": cap["chunks"], "truncated": cap["truncated"],
                    "error": cap["error"]}

    # ── 对外操作 ────────────────────────────────────────────────
    def write(self, data: bytes) -> int:
        with self.wlock:
            if not self.alive or self.state != "live":
                # 重连中 / 已让位：写不出去。调用方（HTTP）返回 200 + ok:false
                # 并提示"正在重连，暂不可写"，不假装成功。
                return 0
            n = self.io.write(data)
        if n:
            # TX 进入数据面：写成功的字节与 RX 同构入环（P1 的关键一条）。
            self._push_chunk(bytes(data)[:n], "tx")
        return n

    def set_log_profile(self, profile: dict | None) -> dict:
        """会话级日志 profile（M6）：换 profile 只重置解析态，不清 issue 历史。"""
        with self.dlock:
            self.log_profile = dict(profile) if profile else None
            self.log_profile_id = (profile or {}).get("id", "") if profile else ""
            self._after_reset = False
        return {"ok": True, "profile": self.log_profile_id}

    def tail_issues(self, after: int = 0) -> dict:
        """增量读回 issue（seq > after）。gap 只报告不抹平。**已持 dlock**。"""
        items = [dict(x) for x in self.issues if x["seq"] > after]
        gap = max(0, items[0]["seq"] - after - 1) if items else 0
        return {"issues": items, "issue_total": self.issue_seq,
                "issue_covered": self.issue_covered, "gap": gap,
                "profile": self.log_profile_id}

    def clear(self) -> dict:
        """清空行/批次环，但**保持 seq/epoch 单调**（被清内容计入 covered）。"""
        with self.dlock:
            nl, nc = len(self.lines), len(self.chunks)
            self.covered += nl
            self.covered_chunks += nc
            self.lines.clear()
            self.chunks.clear()
            self.bytes_total = 0
            # 解码帧环同样清空（序号仍单调；清掉的帧计入 covered）。
            self.dec_covered += len(self.dec_frames)
            self.dec_frames.clear()
            self.dec_pending = b""
            self.dec_total = 0
            self.dec_skipped = 0
            self.dec_error = None
        return {"cleared_lines": nl, "cleared_chunks": nc}

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def touch_lease(self) -> None:
        if self.lease_s:
            self.lease_deadline = time.time() + self.lease_s

    def shutdown(self) -> None:
        self.stop.set()
        t = self.thread
        if t is not None and t.is_alive():
            t.join(timeout=3)
        self.state = "closed"
        self.suspended_by_run = False
        with self.dlock:
            if self.cap and self.cap["active"]:
                self._cap_close(self.cap)   # 会话收摊 = 录制收摊（不留半截文件句柄）
        with self.wlock:
            self.io.close()          # 读线程的 finally 已关；这里关第二次无害


# ══════════════════════════════════════════════════════════════════
#  进程内单例（驾驶舱服务一次只有一个口被监视 —— 串口独占，本就该只有一个）
# ══════════════════════════════════════════════════════════════════
_LOCK = threading.Lock()
_SESS: _Session | None = None
_EPOCH = 0                          # 连接纪元：每次成功 open 自增


def _snapshot(s: _Session | None) -> dict:
    if s is None:
        return {"active": False}
    with s.dlock:
        now = time.time()
        now_us = int(now * 1_000_000)
        down_s = (round(now - s._lost_at, 1) if s._lost_at else s.down_s)
        return {"active": s.state in ("live", "reconnecting", "suspended"),
                "state": s.state, "project": s.project, "port": s.port,
                "baud": s.baud, "backend": s.backend, "seq": s.seq,
                "line": s.line.as_dict(), "line_text": s.line.text,
                "kind": s.kind, "port_spec": s.port_spec,
                # 网络传输（M4）：kind != serial 时这里是本次会话的绑定/目标
                "net": dict(s.target.net) if s.target else {},
                "control": dict(s.control),
                "conn": s.conn, "reconnects": s.reconnects,
                "down_s": down_s, "port_changed": s.port_changed,
                "last_error": s.last_error,
                "suspended_by_run": s.suspended_by_run,
                "suspend_reason": s.suspend_reason,
                "resume_error": s.resume_error,
                "reconnect": dict(s.reconnect),
                "covered": s.covered, "error": s.error, "epoch": s.epoch,
                "chunk_seq": s.chunk_seq, "covered_chunks": s.covered_chunks,
                "bytes_total": s.bytes_total, "paused": s.paused,
                "stats": s._compute_stats(now_us),
                "issues": {"profile": s.log_profile_id,
                           "total": s.issue_seq,
                           "covered": s.issue_covered,
                           "last_seq": s.issue_seq},
                "opened_by": s.opened_by,
                "allow_agent_write": s.allow_agent_write,
                "lease_s": s.lease_s,
                "lease_remaining_s": (max(0.0, round(s.lease_deadline - now, 1))
                                      if s.lease_s else 0.0),
                "capture": (None if s.cap is None else {
                    "active": s.cap["active"], "path": s.cap["path"],
                    "bytes": s.cap["bytes"], "chunks": s.cap["chunks"],
                    "truncated": s.cap["truncated"],
                    "error": s.cap["error"], "max_bytes": s.cap["max_bytes"]}),
                # 会话级解码投影：agent 与人读的是同一份（'' = 未启用）
                "decode": s._decode_view_locked()}


def _same_target(s: "_Session", t, project: str) -> bool:
    """``open`` 请求是否就是**当前这条会话**（同工程 / 同传输 / 同目标 / 同波特率）。

    ``Target.label`` 是解析后的**实际目标**（串口 = COMx；网络 = 规范化后的
    地址），所以这里比对 label 就足够 —— 不用再各自猜 host/bind 的等价性。
    """
    if project and s.project and project != s.project:
        return False
    if (t.kind or "serial") != (s.kind or "serial"):
        return False
    if (t.label or "") != (s.port or ""):
        return False
    if t.kind == "serial" and int(t.baud or 0) != int(s.baud or 0):
        return False
    return True


def current() -> "_Session | None":
    """当前会话句柄（活着才返回）。给 DTR/RTS 控制等"复用同一串口"的场景用。

    ★ 调用方不要直接改会话内部状态；写口一律经 ``_Session.wlock``。
    """
    with _LOCK:
        s = _SESS
        return s if (s is not None and s.alive) else None


def open_session(cfg: Config, project: str, *, port: str = "", baud: int = 0,
                 opened_by: str = "human", lease_s: float = 0.0,
                 allow_agent_write: bool = False, decoder: str = "",
                 line=None, reconnect=None, log_profile: str = "",
                 transport: str = "", net: dict | None = None,
                 log=print) -> dict:
    """打开（或拒绝重复打开）监视会话。返回值可直接 JSON 化。

    端口/波特率/线参数解析与 ``serialterm.resolve_target`` **同一份实现**
    （``serialtransport.resolve``）—— "预览说 COM10、监视却开了别的口"这种分叉，
    一个都不许有。

    ``decoder`` 是**跨会话记忆**的落点：面板把上次选的解码器随 open 带上来，
    从第一批 RX 就按同一协议解码（不用先开一次空会话再补选）。
    """
    global _SESS, _EPOCH
    dec = str(decoder or "").strip()
    is_profile_dec = dec == "profile" or dec.startswith("profile:")
    if dec not in ("", "justfloat", "firewater") and not is_profile_dec:
        return {"ok": False, "error": f"未知解码器：{dec!r}"}
    frame_profile = None
    if is_profile_dec:
        pid = dec.split(":", 1)[1].strip() if ":" in dec else ""
        frame_profile = sf.get(cfg, project, pid) if pid else None
        if frame_profile is None:
            return {"ok": False, "error": f"未找到帧协议 profile：{pid!r}"}
    lp = str(log_profile or "").strip()
    if not lp:
        # 工程/包里有 profile 就**默认启用第一份**：panic 结构化是"接上就能用"
        # 的能力，不该要求用户先知道有个下拉框。
        try:
            profiles = ld.load_profiles(cfg, project) if project else []
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        lp = profiles[0]["id"] if profiles else ""
    profile = None
    if lp:
        profile = ld.get_profile(cfg, project, lp)
        if profile is None:
            return {"ok": False, "error": f"未找到日志 profile：{lp!r}"}
    with _LOCK:
        cur = _SESS
        caps = sp.capabilities()
        # 网络传输（M4）不走串口后端：没有 pyserial 也能开 TCP/UDP。
        kind_hint = str(transport or "").strip().lower()
        if not kind_hint:
            try:
                kind_hint = str(((cfg.resolved_project(project) or {}).get("serial")
                                 or {}).get("transport") or "serial").lower()
            except Exception:                        # noqa: BLE001
                kind_hint = "serial"
        if kind_hint == "serial" and not caps["available"]:
            return {"ok": False,
                    "error": f"串口后端不可用（layer={caps['layer']}）：{caps.get('hint')}"}
        t = tp.resolve(cfg, project, port=port, baud=baud, line=line,
                       transport=transport, net=net)
        if t.errors:
            return {"ok": False, "error": "传输配置不合法：" + "；".join(t.errors),
                    "port": t.label, "baud": t.baud,
                    "line": t.line.as_dict(), "line_text": t.line.text}
        if not t.label:
            return {"ok": False, "error": t.reason,
                    "port": "", "baud": t.baud,
                    "line": t.line.as_dict(), "line_text": t.line.text}
        if cur is not None and cur.state != "closed":
            # ★ 幂等（不是"重复打开"）：同工程 / 同传输 / 同目标的 open 就是
            #   **接上这条已有会话**。闭环让位回归后内核会自己把会话开回来
            #   （opened_by="auto"，面板不一定知道），此时点「打开监视」若被
            #   拒成"监视已在进行"，界面就卡在**怎么都打不开**的死局（对方还
            #   占着口，也不能再开第二条）。真正换口/换工程仍按原样拒绝。
            if _same_target(cur, t, project):
                # open 携带的「跨会话记忆」仍要生效（解码器 / 日志 profile）：
                # 否则复用的会话不会按面板当前选的协议画波形、也不做 panic 解析。
                if dec and dec != cur.decoder:
                    cur.set_decoder(dec, actor=opened_by, profile=frame_profile)
                if profile and (profile.get("id") or "") != cur.log_profile_id:
                    cur.set_log_profile(profile)
                log(f"[serialmon] ⇄ 复用已有会话 {cur.port}@{cur.baud}"
                    f"（state={cur.state}，by={cur.opened_by}）")
                return {"ok": True, "adopted": True, **_snapshot(cur)}
            extra = "（当前因闭环让位处于暂停，run 结束后会自动恢复）" \
                if cur.state == "suspended" else ""
            return {"ok": False, "error": (
                f"监视已在进行（{cur.port}@{cur.baud}，state={cur.state}）{extra} —— "
                f"先关闭当前监视再换口/换工程")}
        try:
            proj = cfg.resolved_project(project) if project else {}
        except Exception:                            # noqa: BLE001
            proj = {}        # 未知工程（夹具/已删工程）→ 用宿主默认，不在开会话时抛
        ser = (proj.get("serial") or {}) if isinstance(proj, dict) else {}
        raw_rec = reconnect if reconnect is not None else ser.get("reconnect")
        rec = _reconnect_cfg(raw_rec)

        def _opener(t0=t):
            """重开闭包：每次都重新解析（auto 会重新选口，显式口优先）。"""
            t2 = tp.resolve(cfg, project, port=t0.port_spec, baud=t0.baud,
                            transport=t0.kind, line=t0.line,
                            net=dict(t0.net or {}) or None)
            if t2.errors:
                raise OSError("传输配置不合法：" + "；".join(t2.errors))
            if not t2.label:
                raise OSError(t2.reason or "端口名为空 —— 请先解析 serial.port")
            return tp.open(t2, for_write=True), t2

        io = tp.open(t, for_write=True)
        _EPOCH += 1
        sess = _Session(project, t.label, t.baud, io, epoch=_EPOCH,
                        opened_by=opened_by, lease_s=lease_s,
                        allow_agent_write=allow_agent_write,
                        line=t.line, port_spec=t.port_spec, kind=t.kind,
                        reconnect=rec, opener=_opener, target=t)
        # 跨会话记忆的解码器：在 start() 之前挂上，第一批 RX 就按同一协议解码。
        sess.decoder = dec
        sess.decoder_by = opened_by if dec else ""
        sess.frame_profile = frame_profile
        sess.log_profile = dict(profile) if profile else None
        sess.log_profile_id = (profile or {}).get("id", "") if profile else ""
        try:
            sess.start()
        except OSError as exc:
            return {"ok": False, "error": str(exc),
                    "port": t.label, "baud": t.baud}
        _SESS = sess
    log(f"[serialmon] ▶ {sess.port}@{sess.baud} {sess.line.text}"
        f"（project={project or '-'}，backend={sess.backend}，epoch={sess.epoch}，by={opened_by}"
        + (f"，lease={sess.lease_s}s" if sess.lease_s else "")
        + (f"，decoder={dec}" if dec else "")
        + (f"，log_profile={lp}" if lp else "") + "）")
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
    log(f"[serialmon] ■ 关闭 {s.port}@{s.baud}（收 {s.seq} 行 / {s.chunk_seq} 批"
        + (f"，error={s.error}" if s.error else "") + "）")
    return {"ok": True, "closed": {"port": s.port, "baud": s.baud,
                                   "lines": s.seq, "chunks": s.chunk_seq,
                                   "epoch": s.epoch, "error": s.error}}


def suspend(reason: str = "闭环占用串口", *, by_run: bool = True) -> dict:
    """让出串口（闭环要用了）。保留行/字节环与 epoch，run 结束可回归。"""
    s = _SESS
    if s is None:
        return {"ok": False, "error": "没有进行中的监视"}
    out = s.suspend(reason, by_run=by_run)
    return {**out, **_snapshot(s)}


def resume() -> dict:
    """恢复被闭环让位的会话（不 bump epoch、不清环）。"""
    s = _SESS
    if s is None:
        return {"ok": False, "error": "没有进行中的监视"}
    out = s.restore()
    return {**out, **_snapshot(s)}


def limits() -> dict:
    """缓冲上限（内核自描述 ``SERIAL_META.buffer`` 的唯一来源）。"""
    return {"max_lines": MAX_LINES, "max_chunks": MAX_CHUNKS,
            "max_bytes": MAX_BYTES, "max_dec_frames": MAX_DEC_FRAMES,
            "rate_window_s": RATE_WINDOW_S}


def tail(after: int) -> dict:
    """增量读回：``seq > after`` 的行 + 会话状态。``gap``=浏览器错过的行数下限。

    ★ gap 只报告、**不抹平**：环形缓冲挤掉了行就必须说出来，否则"后台标签页
      被节流的浏览器"会以为自己看到的是全部。``after=0``（浏览器什么都不知道）
      同样参与计算 —— 它错过的就是被挤掉的那几行。
    """
    s = _SESS
    if s is None:
        return {"active": False, "lines": [], "seq": 0, "gap": 0}
    s.touch_lease()
    with s.dlock:
        lines = [dict(x) for x in s.lines if x["seq"] > after]
        gap = max(0, lines[0]["seq"] - after - 1) if lines else 0
    return {**_snapshot(s), "lines": lines, "gap": gap}


def tail_bytes(after: int, *, direction: str = "all", limit: int = 0) -> dict:
    """增量读回原始字节批次（``seq > after``）。

    ``direction`` ∈ all / rx / tx。``gap`` 只对 all 有意义（过滤后的序号不连续
    会让 gap 变成噪声，故过滤时明确置 0 并在 ``filtered`` 里说明）。
    """
    s = _SESS
    if s is None:
        return {"active": False, "epoch": 0, "chunk_seq": 0, "chunks": [],
                "gap": 0, "covered": 0}
    s.touch_lease()
    direction = direction if direction in ("all", "rx", "tx") else "all"
    limit = max(0, min(int(limit or 0), MAX_CHUNKS)) if limit else 0
    with s.dlock:
        raw = [c for c in s.chunks if c["seq"] > after]
        if direction != "all":
            raw = [c for c in raw if c["dir"] == direction]
        gap = 0
        if direction == "all" and raw:
            gap = max(0, raw[0]["seq"] - after - 1)
        if limit and len(raw) > limit:
            raw = raw[-limit:]
        chunks = [{"seq": c["seq"], "dir": c["dir"], "t": c["t"],
                   "t_us": c["t_us"], "len": len(c["data"]),
                   "data_b64": base64.b64encode(c["data"]).decode("ascii")}
                  for c in raw]
    return {**_snapshot(s), "chunks": chunks, "gap": gap,
            "filtered": direction != "all",
            "covered": s.covered_chunks}


def status() -> dict:
    """给 capabilities / 初始渲染用的轻量快照。"""
    return _snapshot(_SESS)


def set_decoder(decoder: str, *, actor: str = "human",
                cfg: Config | None = None, project: str = "") -> dict:
    """会话级选定解码器（POST /api/serial/monitor action=decoder）。

    ``decoder="profile:<id>"`` 需要工程上下文（``cfg`` + ``project``）来装载
    frames 配置；内置解码器不需要。
    """
    s = _SESS
    if s is None:
        return {"ok": False, "error": "没有进行中的监视"}
    dec = str(decoder or "").strip()
    prof = None
    if dec == "profile" or dec.startswith("profile:"):
        pid = dec.split(":", 1)[1].strip() if ":" in dec else ""
        if not pid:
            return {"ok": False, "error": "profile 解码器需要 profile id"}
        if cfg is None:
            return {"ok": False, "error": "profile 解码器需要工程上下文"}
        prof = sf.get(cfg, project or s.project, pid)
        if prof is None:
            return {"ok": False, "error": f"未找到帧协议 profile：{pid!r}"}
    return s.set_decoder(dec, actor=actor, profile=prof)


def set_log_profile(cfg: Config, project: str, pid: str) -> dict:
    """会话级日志 profile（M6）：``pid`` 空 = 关闭诊断。"""
    s = _SESS
    if s is None:
        return {"ok": False, "error": "没有进行中的监视"}
    pid = str(pid or "").strip()
    prof = None
    if pid:
        prof = ld.get_profile(cfg, project or s.project, pid)
        if prof is None:
            return {"ok": False, "error": f"未找到日志 profile：{pid!r}"}
    out = s.set_log_profile(prof)
    return {**out, **_snapshot(s)}


def tail_issues(after: int = 0) -> dict:
    """增量读回结构化 issue（GET /api/serial/monitor/issues）。"""
    s = _SESS
    if s is None:
        return {"active": False, "issues": [], "issue_total": 0,
                "issue_covered": 0, "gap": 0, "profile": ""}
    with s.dlock:
        out = s.tail_issues(after)
    return {**_snapshot(s), **out}


def tail_decoded(after: int = 0) -> dict:
    """增量读回共享解码帧（GET /api/serial/monitor/decoded）。"""
    s = _SESS
    if s is None:
        return {"active": False, "epoch": 0, "decoder": "", "decoder_by": "",
                "channels": 0, "frames": [], "next_after": 0, "gap": 0,
                "skipped": 0, "pending_bytes": 0, "covered": 0,
                "updated_at": 0.0, "error": None}
    s.touch_lease()
    return s.tail_decoded(int(after or 0))


def clear() -> dict:
    s = _SESS
    if s is None:
        return {"ok": False, "error": "没有进行中的监视"}
    return {"ok": True, **s.clear()}


def set_paused(paused: bool) -> dict:
    s = _SESS
    if s is None:
        return {"ok": False, "error": "没有进行中的监视"}
    if paused:
        s.pause()
    else:
        s.resume()
    return {"ok": True, "paused": s.paused}


def capture_start(cfg: Config, *, project: str = "",
                  max_bytes: int = 0) -> dict:
    """开始显式录制（K5）。文件落在 ``.work/.cockpit/``，**有界**、只存字节。

    与 console 留档的区别（C28）：capture 是"证据"（完整、有界、可回放），
    console 是"我敲过什么"（会滚动）。
    """
    s = _SESS
    if s is None:
        return {"ok": False, "error": "没有进行中的监视（先 open 再录制）"}
    cap_dir: Path = Path(cfg.root) / ".work" / ".cockpit"
    return s.start_capture(cap_dir, max_bytes=max_bytes or CAP_MAX_BYTES)


def capture_stop() -> dict:
    s = _SESS
    if s is None:
        return {"ok": False, "error": "没有进行中的监视"}
    return s.stop_capture()


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
