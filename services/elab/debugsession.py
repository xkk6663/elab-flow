"""elab.debugsession —— 长驻调试会话：openocd + gdb(MI) 的编排与状态机。

设计依据：``docs/design/技术方案_调试面板复刻cortex-debug.md`` §7.3–§7.8。

职责边界：
  - 本层负责**进程/端口/状态**与固定白名单 MI 动作；
  - 数据整形走 :mod:`elab.debugdata`；
  - HTTP/SSE/租约/审计/互斥走 ``cockpit/server.py`` 的 ``DebugManager``。

关闭语义（D8 / C36 延伸）：默认 ``monitor reset run``，绝不允许把板子留在 halt
（否则后续串口闭环会假失败）。
"""

from __future__ import annotations

import re
import socket
import subprocess
import threading
import time
from pathlib import Path

from . import flash as flash_mod
from . import debugdata as dd
from . import debugsource as dsrc
from . import debugstore as dstore
from . import svd as svd_mod
from . import rtos as rtos_mod
from ._winproc import spawn
from .config import to_fwd
from .gdbmi import MiError, MiSession
from .plan import Plan

GDB_LISTEN_RE = re.compile(r"Listening on port (\d+) for gdb connections")

#: 合法的寄存器名（写寄存器只允许这些；pc/lr/xpsr 只读，与 UI 对齐 —— D8）
_REG_WRITE_RE = re.compile(r"^(r(?:[0-9]|1[0-2])|sp|s(?:[12]?[0-9]|3[01]))$")
#: 只读寄存器（UI/后端都拒绝，需要跳转时用 run_to_line）
_REG_READONLY = ("pc", "lr", "xpsr", "r13", "r14", "r15")
#: FPU 寄存器只读原因（P3 不开放 64/128 位写）
_REG_WIDE_RE = re.compile(r"^[dq](?:[0-9]|1[0-5])$")


def register_width(name: str) -> int:
    """``s*`` / ``r*`` / ``sp`` = 32；``d*`` = 64；``q*`` = 128（后者暂只读）。"""
    n = str(name or "").lower()
    if _REG_WIDE_RE.match(n):
        return 64 if n.startswith("d") else 128
    return 32


def register_writable(name: str) -> bool:
    n = str(name or "").lower()
    return bool(_REG_WRITE_RE.match(n)) and n not in _REG_READONLY


class DebugError(RuntimeError):
    """带错误码的调试异常（HTTP 层据此映射 §6.3 错误码表）。"""

    def __init__(self, code: str, message: str, hint: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint

    def as_dict(self) -> dict:
        d = {"code": self.code, "message": self.message}
        if self.hint:
            d["hint"] = self.hint
        return d


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def port_in_use(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), 0.3):
            return True
    except OSError:
        return False


def _hex(v: object) -> str:
    try:
        return hex(int(str(v), 0))
    except (TypeError, ValueError):
        return ""


def _mi_expr(expr: str) -> str:
    """去掉表达式里**引号外**的空白。

    gdb MI 不把 ``-data-evaluate-expression "a + b"`` 当单个参数（实测 2026-11-03 报
    ``Usage``），所以只能送压缩后的表达式；字符串字面量内部的空格保留。
    """
    out: list[str] = []
    quote = ""
    for ch in str(expr):
        if quote:
            out.append(ch)
            if ch == quote:
                quote = ""
        elif ch in ("'", '"'):
            quote = ch
            out.append(ch)
        elif not ch.isspace():
            out.append(ch)
    return "".join(out)


def _bp_index(bid: str) -> int:
    try:
        return int(str(bid).rsplit("-", 1)[-1])
    except (TypeError, ValueError):
        return 0


def _w_index(wid: str) -> int:
    try:
        return int(str(wid).rsplit("-", 1)[-1])
    except (TypeError, ValueError):
        return 0


class _GdbReader:
    """给 :mod:`elab.rtos` 的极薄 gdb 适配层（表达式 + 内存读）。"""

    def __init__(self, sess: "DebugSession"):
        self._s = sess

    def ev(self, expr: str):
        # ★ 复用会话的 evaluate（同一条已实机验证的求值路径），避免两套 MI 拼接逻辑漂移
        self.last_error = ""
        try:
            return self._s.evaluate(expr=expr).get("value")
        except DebugError as exc:
            self.last_error = str(exc)
            return None

    def mem(self, addr: int, size: int) -> bytes | None:
        gdb = self._s._gdb
        if gdb is None:
            return None
        try:
            rec = gdb.command(f"-data-read-memory-bytes {hex(addr)} {int(size)}",
                              timeout=5.0)
        except MiError:
            return None
        out = dd.memory(rec, addr=hex(addr), count=size)
        try:
            return bytes.fromhex(str(out.get("bytes") or "").replace(" ", ""))
        except ValueError:
            return None


class DebugSession:
    """单会话（``max_sessions=1``）。生命周期由 ``DebugManager`` 持有。

    线程纪律（§7.4）：HTTP 线程只发 MI 命令；GDB stdout 只有一个读者
    （:class:`MiSession` 的读者线程），本类只在回调里更新状态并 emit 事件。
    """

    def __init__(self, plan: Plan, *, actor: str = "human", lease_s: int = 0,
                 options: dict | None = None, open_seq: int = 0,
                 emit=None, log=print):
        self.plan = plan
        self.profile = plan.debug_profile()
        self.actor = actor
        self.owner = actor
        self.lease_s = max(0, int(lease_s or 0))
        self.started_at = time.time()
        self.last_active = self.started_at
        self.options = dict(options or {})
        self.open_seq = open_seq
        self._emit_cb = emit or (lambda topic, data: None)
        self.log = log

        self.session_id = "dbg-" + format(int(time.time() * 1000) % 0xFFFFFFFF, "08x")
        self.state = "starting"
        self.stop: dict | None = None
        self.stop_seq = 0
        self.port = 0
        self.error: dict | None = None
        self.resumed_on_close: bool | None = None

        self._gdb: MiSession | None = None
        self._openocd: subprocess.Popen | None = None
        self._openocd_reader: threading.Thread | None = None
        self._openocd_tail: list[str] = []
        self._port_ready = threading.Event()
        self._port_error: str = ""
        self._stop_cond = threading.Condition()
        self._op_lock = threading.RLock()

        self._reg_names: list[str] = []
        self._breakpoints: list[dict] = []
        self._bp_seq = 0
        self._bp_id_map: dict[str, str] = {}          # gdb_id -> stable id
        self._varobjs: dict[str, str] = {}            # exp -> gdb varobj name
        self._varobj_owner: list[str] = []
        self._varobjs_dirty = False                   # ★ 只在非读者线程清理（见 _maybe_clear_varobjs）
        self._mi_async = True
        self._closed = False

        # 工程级持久化（§11 P1）：断点 / 监视 + 乐观锁 rev
        self._bp_entries: dict[str, dict] = {}
        self._store_rev = 0
        self._watches: list[dict] = []
        self._watch_seq = 0
        # FreeRTOS 内省可用性（P3）：open 时探测一次，快照 features 据此渲染页签
        self._rtos_available: bool | None = None
        # 源码页签：basename 索引只在缺 fullname 时才建，一次会话建一次
        self._src_index: dict[str, list[str]] | None = None

    # ── 事件 ────────────────────────────────────────────────────
    def bind_emit(self, cb) -> None:
        """重绑事件出口（多会话：DebugManager 按 session_id 扇出，见 §6.2）。"""
        self._emit_cb = cb or (lambda topic, data: None)

    def emit(self, topic: str, data: dict) -> None:
        try:
            self._emit_cb(topic, data)
        except Exception as exc:                      # noqa: BLE001
            self.log(f"[debug] 事件回调异常：{exc!r}")

    def _state(self, state: str, reason: str = "") -> None:
        prev, self.state = self.state, state
        if prev != state:
            self.emit("debug/state", {"state": state, "prev": prev,
                                      **({"reason": reason} if reason else {})})

    # ── 打开 ────────────────────────────────────────────────────
    def open(self) -> dict:
        t0 = time.time()
        try:
            self._validate()
            self._start_openocd()
            self._start_gdb()
            self._connect_and_prepare()
            self._finish_stop_at()
        except DebugError:
            self._teardown(resume=False)
            self.state = "error"
            raise
        except Exception as exc:                      # noqa: BLE001
            self._teardown(resume=False)
            self.state = "error"
            raise DebugError("debug-error", f"调试会话启动失败：{exc}")
        self.started_at = t0
        self.last_active = time.time()
        self.emit("debug/opened", {"open_seq": self.open_seq,
                                   "project": self.plan.name,
                                   "actor": self.actor, "focus": True})
        return self.snapshot()

    def _validate(self) -> None:
        elf = self.profile.get("elf") or ""
        if not elf:
            raise DebugError("debug-elf-missing", f"工程 {self.plan.name} 未声明 artifacts.elf",
                             "先在面板跑 build")
        if not Path(elf).exists():
            raise DebugError("debug-elf-missing", f"ELF 不存在：{elf}", "先跑 build")
        gdb = self.profile.get("gdb") or ""
        if not gdb or not Path(gdb).exists():
            raise DebugError("debug-gdb-missing", f"gdb 不可用：{gdb or '(未配置)'}",
                             "检查 elab.host.yaml 的 tools.gdb / 安装 arm-none-eabi-gdb")
        if not self.profile.get("openocd"):
            raise DebugError("debug-unavailable", "elab.host.yaml 未声明 tools.openocd.path",
                             "跑 elab.cmd doctor")
        if not self.profile.get("target"):
            raise DebugError("debug-unavailable", "芯片未声明 debug.openocd_target",
                             "检查适配包 chips/*.yaml")

    def _start_openocd(self) -> None:
        pre = ["gdb_port %d" % free_port(), "telnet_port disabled", "tcl_port disabled"]
        # 端口分配后仍要预检占用（§7.5）；三次都失败 → 明确提示清理残留进程
        for attempt in range(3):
            port = int(pre[0].split()[-1])
            if not port_in_use(port):
                break
            pre[0] = "gdb_port %d" % free_port()
        else:
            raise DebugError("debug-port-hijacked", "连续 3 次分配的端口都被占用",
                             "清理残留 openocd/gdb 进程后重试")
        self.port = int(pre[0].split()[-1])
        argv = flash_mod._openocd_argv(self.plan, "", pre_commands=pre)
        env = self.plan.host.build_env()
        try:
            # spawn = Popen + 进「句柄关闭即终止」作业：内核被强杀（TerminateProcess /
            # 关窗口）时 openocd 会被系统带走，不再留孤儿占着 CMSIS-DAP（§7.5）。
            self._openocd = spawn(
                argv, cwd=str(self.plan.cfg.root), env=env,
                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                bufsize=1,
            )
        except OSError as exc:
            raise DebugError("debug-openocd-dead", f"无法启动 openocd：{exc}")
        self._openocd_reader = threading.Thread(target=self._read_openocd, daemon=True,
                                                name="elab-openocd")
        self._openocd_reader.start()
        if not self._port_ready.wait(20.0):
            tail = self.openocd_tail()
            raise DebugError("debug-openocd-dead" if self._openocd.poll() is not None
                             else "debug-timeout",
                             self._port_error or f"openocd 未在 20s 内监听 gdb 端口 {self.port}",
                             tail)
        if self._port_error:
            raise DebugError("debug-port-hijacked", self._port_error,
                             "清理残留 openocd（taskkill /IM openocd.exe）后重试")

    def _read_openocd(self) -> None:
        """唯一读者：从日志确认实际监听端口（RSP 端口，不是 MI 端口）。"""
        proc = self._openocd
        if proc is None or proc.stdout is None:
            return
        for line in proc.stdout:
            text = line.rstrip()
            self._openocd_tail.append(text)
            if len(self._openocd_tail) > 40:
                del self._openocd_tail[: len(self._openocd_tail) - 40]
            self.log(f"[openocd] {text}")
            m = GDB_LISTEN_RE.search(text)
            if m:
                got = int(m.group(1))
                if got != self.port:
                    self._port_error = (f"openocd 实际监听 {got}，期望 {self.port}"
                                        "（gdb_port 下发顺序错误？）")
                self._port_ready.set()
        self._port_ready.set()                      # 进程退出：让等待方醒来并判定失败

    def openocd_tail(self) -> str:
        return "\n".join(self._openocd_tail[-12:])[-300:]

    def _start_gdb(self) -> None:
        argv = [self.profile["gdb"], "-q", "--interpreter=mi2", to_fwd(self.profile["elf"])]
        self._gdb = MiSession(argv, cwd=str(self.plan.cfg.root),
                              env=self.plan.host.build_env(), log=self.log)
        self._gdb.on_async = self._on_async
        self._gdb.on_stream = self._on_stream
        try:
            self._gdb.start(timeout=10.0)
        except MiError as exc:
            raise DebugError("debug-gdb-missing", f"gdb 启动失败：{exc}")
        for cmd in ("-gdb-set mi-async on", "-gdb-set confirm off",
                    "-gdb-set pagination off", "-gdb-set print elements 200",
                    "-enable-pretty-printing"):
            try:
                self._gdb.command(cmd, timeout=3.0)
            except MiError:
                if cmd.endswith("mi-async on"):
                    self._mi_async = False

    def _connect_and_prepare(self) -> None:
        assert self._gdb is not None
        try:
            self._gdb.command(f"-target-select extended-remote 127.0.0.1:{self.port}",
                              timeout=10.0)
        except MiError as exc:
            raise DebugError("debug-gdb-missing", f"连接 gdb server 失败：{exc}",
                             self.openocd_tail())
        try:
            self._gdb.command('-interpreter-exec console "monitor reset halt"', timeout=10.0)
        except MiError:
            try:
                self._gdb.command('-interpreter-exec console "reset halt"', timeout=10.0)
            except MiError as exc:
                raise DebugError("debug-error", f"复位并暂停失败：{exc}")
        self._state("stopped", "reset-halt")
        self._note_stop({"reason": "reset", "thread": "", "frame": {}, "pc": "", "bkptno": ""},
                        emit_stop=False)
        if bool(self.options.get("load", self.profile.get("load", True))):
            try:
                self._gdb.command("-target-download", timeout=35.0)
            except MiError as exc:
                raise DebugError("debug-error", f"下载 ELF 失败：{exc}")
        try:
            self._reg_names = [str(x) for x in
                               (self._gdb.command("-data-list-register-names", timeout=5.0)
                                .get("results", {}).get("register-names") or [])]
        except MiError:
            self._reg_names = []
        self._load_store()

    def _finish_stop_at(self) -> None:
        assert self._gdb is not None
        stop_at = str(self.options.get("stop_at") or "main")
        if stop_at == "reset":
            self._refresh_stop_frame()
            return
        if stop_at == "none":
            self._state("running", "started")
            self._send_continue()
            return
        seq = self.stop_seq
        try:
            self._gdb.command("-break-insert -t main", timeout=8.0)
        except MiError:
            # main 符号缺失 → 降级为 reset，并在 stop 里带 warn（§7.3）
            self._refresh_stop_frame()
            self.stop = {**(self.stop or {}), "warn": "未找到 main 符号，已停在复位向量"}
            self.emit("debug/stop", self.stop)
            return
        self._state("running", "run-to-main")
        self._send_continue()
        if not self.wait_stop(seq, 15.0):
            self._refresh_stop_frame()
            self.stop = {**(self.stop or {}), "warn": "15s 内未命中 main，已停在当前位置"}
            self.emit("debug/stop", self.stop)

    def _refresh_stop_frame(self) -> None:
        """复位/降级时补一个栈顶帧（没有 *stopped 也要让 UI 有位置）。"""
        frames = self._top_frames()
        # ``monitor reset halt`` 之后 gdb 的 frame 信息有几十~几百毫秒延迟；
        # 不重试的话 stop.frame 会是空的，位置条只剩 "??"（实测 2026-11-03）。
        for _ in range(3):
            # 复位刚停住时偶尔会回一帧只有 addr、没有 func 的残缺结果，也要继续等
            if frames and frames[0].get("func"):
                break
            time.sleep(0.2)
            frames = self._top_frames()
        frame = frames[0] if frames else {}
        stop = {"reason": "reset", "thread": "", "frame": {
            "func": frame.get("func", ""), "file": frame.get("file", ""),
            "fullname": self._frame_fullname(frame),
            "line": frame.get("line"), "addr": frame.get("addr", ""),
        }, "pc": frame.get("addr", ""), "bkptno": ""}
        self._note_stop(stop, emit_stop=False)
        self.emit("debug/stop", self.stop)
        if not frame.get("func"):
            # reset halt 的符号解析偶发要 2s+：让补拉线程继续等，别阻塞用户动作
            threading.Thread(target=self._fill_stop_frame, daemon=True).start()

    def _fill_stop_frame(self) -> None:
        """``*stopped`` 不带 frame 时的补拉：就地补字段，**不**新增 stop_seq。"""
        if self._gdb is None or self.state != "stopped" or not self.stop:
            return
        frames = self._top_frames()
        # reset halt 后 gdb 重新解析符号可能要好几秒（实测 >2s）；后台慢慢补，别挡动作
        for _ in range(16):
            if frames and frames[0].get("func"):
                break
            time.sleep(0.3)
            frames = self._top_frames()
        if not frames:
            return
        frame = frames[0]
        self.stop["frame"] = {"func": frame.get("func", ""), "file": frame.get("file", ""),
                             "fullname": self._frame_fullname(frame),
                             "line": frame.get("line"), "addr": frame.get("addr", "")}
        if not self.stop.get("pc"):
            self.stop["pc"] = frame.get("addr", "")
        self.emit("debug/stop", self.stop)

    def _frame_fullname(self, frame: dict) -> str:
        """帧的绝对源码路径：优先 MI 的 ``fullname``，缺失时按 basename 唯一匹配。

        多解**不猜**（返回空串）——猜错文件会让 gutter 断点打到别的文件里。
        """
        fn = str(frame.get("fullname") or "")
        if fn:
            return fn
        name = str(frame.get("file") or "")
        if not name:
            return ""
        if not self.plan.source_dir:
            return ""
        if self._src_index is None:
            self._src_index = dsrc.basename_index(self.plan.source_dir)
        return dsrc.resolve_hint(self.plan.source_dir, name, self._src_index)

    def _top_frames(self) -> list[dict]:
        if self._gdb is None:
            return []
        try:
            # 与 HTTP /stack 保持同一条命令：reset halt 后带 --start-frame 的变体
            # 常回残缺帧（只有 addr），完整形式才稳定带 func。
            rec = self._gdb.command("-stack-list-frames", timeout=5.0)
            return dd.stack(rec.get("results") or {})
        except MiError:
            return []

    # ── GDB 回调（读者线程）─────────────────────────────────────
    def _on_stream(self, rec: dict) -> None:
        kind = rec.get("kind", "log")
        stream = "console" if kind == "console" else ("target" if kind == "target" else "log")
        text = str(rec.get("text") or "").rstrip("\n")
        if text:
            self.emit("debug/output", {"stream": stream, "text": text})

    def _on_async(self, rec: dict) -> None:
        kind = rec.get("kind")
        if kind == "exec":
            cls = rec.get("cls")
            if cls == "running":
                self._note_running()
            elif cls == "stopped":
                stop = dd.stop_frame(rec)
                self._note_stop(stop)
                if not stop.get("frame", {}).get("func"):
                    # 部分 server 不在 *stopped 里带 frame → 补拉一次（不改 seq）
                    threading.Thread(target=self._fill_stop_frame, daemon=True).start()
            return
        if kind == "notify":
            cls = str(rec.get("cls") or "")
            if cls.startswith("breakpoint"):
                res = rec.get("results") or {}
                bk = res.get("bkpt") or {}
                gdb_id = str(bk.get("number") or res.get("id") or "")
                deleted = cls.endswith("deleted") or str(res.get("id") or "") != "" and not bk
                self.emit("debug/breakpoint", {
                    "id": self._bp_id_map.get(gdb_id, f"gdb-{gdb_id}"),
                    "gdb_id": gdb_id,
                    "verified": not deleted,
                    "hit_count": int(str(bk.get("times") or 0)) if str(bk.get("times") or 0).isdigit() else 0,
                    "enabled": str(bk.get("enabled") or "y") == "y" and not deleted,
                    "cls": cls,
                    **({"deleted": True} if deleted else {}),
                })
            return
        if kind == "exit":
            if not self._closed:
                self._state("error", "gdb-exited")
                self.emit("debug/error", {"code": "debug-gdb-missing",
                                          "message": "gdb 进程已退出"})

    def _note_running(self) -> None:
        self._state("running", "continue")

    def _note_stop(self, stop: dict, *, emit_stop: bool = True) -> None:
        with self._stop_cond:
            self.stop_seq += 1
            self.stop = {**stop, "seq": self.stop_seq}
            self._stop_cond.notify_all()
        # ★ 绝不能在这里发 MI 命令：本方法运行在 GDB **读者线程**里，
        #   发命令再等 Future 会把唯一的读者堵死（自己等自己）。
        #   只置脏标记，真正清理由下一个 HTTP 数据请求在调用方线程做。
        self._varobjs_dirty = True
        self._state("stopped", str(stop.get("reason") or "stop"))
        if emit_stop:
            self.emit("debug/stop", self.stop)

    def wait_stop(self, after_seq: int, timeout: float) -> bool:
        deadline = time.monotonic() + max(0.0, timeout)
        with self._stop_cond:
            while self.stop_seq <= after_seq and self.state != "error":
                remain = deadline - time.monotonic()
                if remain <= 0:
                    return False
                self._stop_cond.wait(remain)
            return self.stop_seq > after_seq

    # ── 控制 ────────────────────────────────────────────────────
    def control(self, action: str, *, addr: str = "", confirm: bool = False,
                file: str = "", line: int | str = 0) -> dict:
        with self._op_lock:
            if self.state in ("closed", "error"):
                raise DebugError("debug-no-session", "会话已结束",
                                 "重新 elab_debug_open")
            self.last_active = time.time()
            if action == "continue":
                seq = self.stop_seq
                if self.state != "running":
                    self._state("running", "continue")
                    self._send_continue()
                return {"state": self.state, "stop": self.stop}
            if action == "pause":
                self._pause()
                self.wait_stop(self.stop_seq, 3.0)
                return {"state": self.state, "stop": self.stop}
            if action in ("step_over", "step_in", "step_out", "stepi"):
                cmd = {"step_over": "-exec-next", "step_in": "-exec-step",
                       "step_out": "-exec-finish", "stepi": "-exec-next-instruction"}[action]
                seq = self.stop_seq
                self._exec(cmd)
                self.wait_stop(seq, 15.0)
                return {"state": self.state, "stop": self.stop}
            if action == "reset":
                if not confirm:
                    raise DebugError("debug-bad-request", "reset 需要 confirm=true",
                                     "传 confirm=true 后再试（会复位目标）")
                self._reset_halt()
                return {"state": self.state, "stop": self.stop}
            if action == "restart":
                self._reset_halt()
                if bool(self.options.get("load", self.profile.get("load", True))):
                    self._gdb.command("-target-download", timeout=35.0)
                return {"state": self.state, "stop": self.stop}
            if action == "run_to":
                if not addr:
                    raise DebugError("debug-bad-request", "run_to 需要 addr")
                seq = self.stop_seq
                tmp = self._gdb.command(f"-break-insert -t *{addr}", timeout=8.0)
                self._state("running", "run-to")
                self._send_continue()
                self.wait_stop(seq, 15.0)
                gdb_id = str(((tmp.get("results") or {}).get("bkpt") or {}).get("number") or "")
                if gdb_id:
                    try:
                        self._gdb.command(f"-break-delete {gdb_id}", timeout=5.0)
                    except MiError:
                        pass
                return {"state": self.state, "stop": self.stop}
            if action == "run_to_line":
                # 与 run_to 同构，只是定位方式换成 file:line（A4）
                quoted = self._source_quoted(file, line)
                seq = self.stop_seq
                tmp = self._gdb.command(f"-break-insert -t {quoted}", timeout=8.0)
                self._state("running", "run-to-line")
                self._send_continue()
                self.wait_stop(seq, 15.0)
                gdb_id = str(((tmp.get("results") or {}).get("bkpt") or {}).get("number") or "")
                if gdb_id:
                    try:
                        self._gdb.command(f"-break-delete {gdb_id}", timeout=5.0)
                    except MiError:
                        pass
                return {"state": self.state, "stop": self.stop}
            raise DebugError("debug-bad-request", f"未知控制动作：{action!r}")

    def _send_continue(self) -> None:
        if self._gdb is None:
            raise DebugError("debug-no-session", "gdb 不在运行")
        if self._mi_async:
            try:
                self._gdb.command("-exec-continue", timeout=5.0)
                return
            except MiError as exc:
                raise DebugError("debug-error", f"continue 失败：{exc}")
        self._gdb.send("-exec-continue")            # 非异步：不等结果，用 wait_stop 兜底

    def _exec(self, cmd: str) -> None:
        assert self._gdb is not None
        try:
            self._gdb.command(cmd, timeout=15.0)
        except MiError as exc:
            raise DebugError("debug-timeout" if exc.code == "mi-timeout" else "debug-error",
                             f"{cmd} 失败：{exc}")

    def _pause(self) -> None:
        assert self._gdb is not None
        try:
            self._gdb.command("-exec-interrupt", timeout=5.0)
        except MiError:
            try:
                self._gdb.command('-interpreter-exec console "monitor halt"', timeout=10.0)
            except MiError as exc:
                raise DebugError("debug-error", f"暂停失败：{exc}")

    def _reset_halt(self) -> None:
        assert self._gdb is not None
        try:
            self._gdb.command('-interpreter-exec console "monitor reset halt"', timeout=10.0)
        except MiError as exc:
            raise DebugError("debug-error", f"复位失败：{exc}")
        self._refresh_stop_frame()

    # ── 数据 ────────────────────────────────────────────────────
    def _require_stopped(self) -> None:
        if self.state == "running":
            raise DebugError("debug-target-running", "目标正在运行，停止态数据不可用",
                             "先 pause")
        if self.state in ("closed", "error"):
            raise DebugError("debug-no-session", "会话已结束", "重新 elab_debug_open")

    def stack(self, *, thread: int | None = None) -> dict:
        with self._op_lock:
            self._require_stopped()
            assert self._gdb is not None
            if thread is not None:
                self._gdb.command(f"-thread-select {int(thread)}", timeout=5.0)
            rec = self._gdb.command("-stack-list-frames", timeout=5.0)
            payload = dict(rec.get("results") or {})
            pc = (self.stop or {}).get("pc") or ""
            payload["_pc"] = pc
            frames = dd.stack(payload)
            return {"ok": True, "stop_seq": self.stop_seq, "frames": frames,
                    "threads": self._threads()}

    def _threads(self) -> list[dict]:
        if self._gdb is None:
            return []
        try:
            rec = self._gdb.command("-thread-info", timeout=5.0)
            return dd.threads(rec.get("results") or {})
        except MiError:
            return []

    def registers(self, *, group: str = "core", fmt: str = "natural") -> dict:
        with self._op_lock:
            self._require_stopped()
            assert self._gdb is not None
            names_rec = {"register-names": self._reg_names}
            if not self._reg_names:
                names_rec = self._gdb.command("-data-list-register-names",
                                              timeout=5.0).get("results") or {}
                self._reg_names = [str(x) for x in (names_rec.get("register-names") or [])]
            values = self._gdb.command("-data-list-register-values x",
                                       timeout=5.0).get("results") or {}
            groups = dd.registers(names_rec, values, mode="hex",
                                  editable_fn=register_writable,
                                  width_fn=register_width)
            if group and group != "all":
                groups = [g for g in groups if g.get("name") == group]
            return {"ok": True, "stop_seq": self.stop_seq, "groups": groups,
                    "format": "natural" if fmt == "natural" else "hex"}

    def variables(self, *, frame: int = 0, scope: str = "locals", var: str = "") -> dict:
        with self._op_lock:
            self._require_stopped()
            assert self._gdb is not None
            self._maybe_clear_varobjs()
            self._gdb.command(f"-stack-select-frame {int(frame)}", timeout=5.0)
            if var:
                return self._var_children(var)
            if scope == "args":
                rec = self._gdb.command("-stack-list-arguments --all-values", timeout=5.0)
                frames = (rec.get("results") or {}).get("stack-args") or []
                items: list = []
                for fr in frames:
                    if isinstance(fr, dict) and int(fr.get("level", -1)) == int(frame):
                        items = fr.get("args") or []
                        break
                nodes = dd.variables(items)
            else:
                rec = self._gdb.command("-stack-list-variables --all-values", timeout=5.0)
                items = (rec.get("results") or {}).get("variables") or []
                nodes = dd.variables(items)
                for node in nodes:
                    if node["name"] and node["name"] not in self._varobjs:
                        obj = self._var_create(node["name"])
                        if obj:
                            node["obj"] = obj
                            node["has_children"] = node["has_children"] or self._has_children(obj)
            return {"ok": True, "frame": int(frame), "scope": scope,
                    "stop_seq": self.stop_seq, "nodes": nodes, "truncated": False}

    def _var_create(self, exp: str) -> str:
        assert self._gdb is not None
        try:
            rec = self._gdb.command(f"-var-create - * {exp}", timeout=5.0)
            name = str((rec.get("results") or {}).get("name") or "")
            if name:
                self._varobjs[exp] = name
                self._varobj_owner.append(name)
            return name
        except MiError:
            return ""

    def _has_children(self, obj: str) -> bool:
        assert self._gdb is not None
        try:
            rec = self._gdb.command(f"-var-list-children --all-values {obj}", timeout=5.0)
            return bool((rec.get("results") or {}).get("children"))
        except MiError:
            return False

    def _var_children(self, exp: str) -> dict:
        assert self._gdb is not None
        obj = self._varobjs.get(exp)
        if not obj:
            obj = self._var_create(exp)
        if not obj:
            raise DebugError("debug-bad-request", f"无法展开表达式：{exp}")
        rec = self._gdb.command(f"-var-list-children --all-values {obj}", timeout=5.0)
        children = (rec.get("results") or {}).get("children") or []
        return {"ok": True, "frame": 0, "scope": "children", "var": exp,
                "stop_seq": self.stop_seq, "nodes": dd.varobjs({}, children),
                "truncated": False}

    def _clear_varobjs(self) -> None:
        gdb = self._gdb
        names = list(self._varobj_owner)
        self._varobj_owner = []
        self._varobjs = {}
        if gdb is None or not names:
            return
        for name in names:
            try:
                gdb.command(f"-var-delete {name}", timeout=2.0)
            except MiError:
                pass

    def _maybe_clear_varobjs(self) -> None:
        """调用方线程在发数据命令前调用（见 ``_note_stop`` 的线程纪律）。"""
        if self._varobjs_dirty:
            self._varobjs_dirty = False
            self._clear_varobjs()

    # ── 工程级持久化（断点 / 监视，§11 P1）───────────────────────
    def _load_store(self) -> None:
        """open 时把 ``projects/<name>.debug.json`` 灌回 gdb（失败逐条降级）。"""
        data = dstore.load(self.plan.cfg, self.plan.name)
        self._store_rev = int(data["rev"])
        self._bp_entries = {}
        for entry in data["breakpoints"]:
            bid = str(entry.get("id") or "")
            if not bid:
                self._bp_seq += 1
                bid = f"bp-{self._bp_seq}"
            entry["id"] = bid
            self._bp_entries[bid] = entry
            self._bp_seq = max(self._bp_seq, _bp_index(bid))
            if entry.get("enabled", True):
                self._insert_stored(entry)
        self._watches = data["watches"]
        for w in self._watches:
            if not w.get("id"):
                self._watch_seq += 1
                w["id"] = f"w-{self._watch_seq}"
            self._watch_seq = max(self._watch_seq, _w_index(w["id"]))

    def _insert_stored(self, entry: dict) -> None:
        assert self._gdb is not None
        kind = str(entry.get("kind") or "func")
        try:
            loc = self._bp_spec(kind, str(entry["location"]))
        except (DebugError, KeyError) as exc:
            self.emit("debug/output", {"stream": "log",
                                       "text": f"断点恢复跳过：{entry.get('location','')}（{exc}）"})
            return
        cmd = "-break-insert -h" if entry.get("hardware") else "-break-insert"
        try:
            rec = self._gdb.command(f"{cmd} {loc}", timeout=8.0)
        except MiError as exc:
            self.emit("debug/output", {"stream": "log",
                                       "text": f"断点恢复失败：{entry['location']}（{exc}）"})
            return
        bk = (rec.get("results") or {}).get("bkpt") or {}
        gdb_id = str(bk.get("number") or "")
        if not gdb_id:
            return
        self._bp_id_map[gdb_id] = entry["id"]
        cond = str(entry.get("condition") or "")
        if cond:
            try:
                self._gdb.command(f"-break-condition {gdb_id} {cond}", timeout=5.0)
            except MiError:
                pass

    def _persist(self) -> None:
        saved = dstore.save(self.plan.cfg, self.plan.name,
                            {"breakpoints": self._bp_sorted_entries(),
                             "watches": self._watches},
                            base_rev=self._store_rev)
        self._store_rev = int(saved["rev"])

    def _bp_sorted_entries(self) -> list[dict]:
        return [self._bp_entries[k] for k in
                sorted(self._bp_entries, key=_bp_index)]

    def _check_rev(self, rev: int | None) -> None:
        """客户端带了旧 rev → 409（乐观锁；不带则不校验，便于 CLI/agent 快手）。"""
        if rev is None:
            return
        if int(rev) != self._store_rev:
            raise DebugError("debug-rev-conflict",
                             f"调试配置已被修改（当前 rev={self._store_rev}，提交 rev={rev}）",
                             "重新读取断点/监视列表拿最新 rev 后重试")

    def store_rev(self) -> int:
        return self._store_rev

    # ── 监视（P1）───────────────────────────────────────────────
    def watch(self) -> dict:
        """列出监视表达式并（停止态）求值；持久条目是配置事实源。"""
        with self._op_lock:
            stopped = self.state == "stopped" and self._gdb is not None
            out = []
            for w in self._watches:
                item = {"id": w["id"], "expr": w["expr"],
                        "format": w.get("format") or "natural",
                        "value": "", "type": "", "hex": "", "natural": ""}
                if not stopped:
                    item["error"] = "target-running"
                else:
                    try:
                        rec = self._gdb.command(
                            f"-data-evaluate-expression {_mi_expr(w['expr'])}",
                            timeout=8.0)
                        item.update(dd.evaluate(rec))
                    except MiError as exc:
                        item["error"] = str(exc)
                out.append(item)
            return {"ok": True, "stop_seq": self.stop_seq, "rev": self._store_rev,
                    "watches": out, "state": self.state}

    def watch_add(self, *, expr: str, fmt: str = "natural",
                  rev: int | None = None) -> dict:
        with self._op_lock:
            self._check_rev(rev)
            exp = expr.strip()
            if not exp:
                raise DebugError("debug-bad-request", "监视需要 expr")
            if any(w["expr"] == exp for w in self._watches):
                return self.watch()
            self._watch_seq += 1
            wid = f"w-{self._watch_seq}"
            entry = {"id": wid, "expr": exp, "format": fmt or "natural"}
            self._watches.append(entry)
            try:
                self._persist()
            except DebugError:
                self._watches.remove(entry)
                raise
            return self.watch()

    def watch_update(self, *, wid: str, expr: str | None = None,
                     fmt: str | None = None, rev: int | None = None) -> dict:
        with self._op_lock:
            self._check_rev(rev)
            entry = next((w for w in self._watches if w["id"] == wid), None)
            if entry is None:
                raise DebugError("debug-bad-request", f"未知监视 id：{wid}")
            if expr is not None:
                if not expr.strip():
                    raise DebugError("debug-bad-request", "监视 expr 不能为空")
                entry["expr"] = expr.strip()
            if fmt is not None:
                entry["format"] = fmt or "natural"
            self._persist()
            return self.watch()

    def watch_remove(self, *, wid: str, rev: int | None = None) -> dict:
        with self._op_lock:
            self._check_rev(rev)
            entry = next((w for w in self._watches if w["id"] == wid), None)
            if entry is None:
                raise DebugError("debug-bad-request", f"未知监视 id：{wid}")
            self._watches.remove(entry)
            self._persist()
            return self.watch()

    # ── 断点 ────────────────────────────────────────────────────
    def breakpoints(self) -> list[dict]:
        with self._op_lock:
            assert self._gdb is not None
            rec = self._gdb.command("-break-list", timeout=5.0)
            rows = dd.breakpoints(rec, id_map=self._bp_id_map)
            for row in rows:
                if row["gdb_id"] not in self._bp_id_map:
                    # 临时断点/会话外新增 → 补一个稳定 id，保持列表自洽
                    self._bp_seq += 1
                    stable = f"bp-{self._bp_seq}"
                    self._bp_id_map[row["gdb_id"]] = stable
                    row["id"] = stable
                entry = self._bp_entries.get(row["id"])
                if entry is not None:
                    # 工程持久条目是配置事实源：条件/硬件/启用态以它为准
                    row["condition"] = entry.get("condition") or row["condition"]
                    row["hardware"] = entry.get("hardware", False)
                    row["kind"] = entry.get("kind") or row["kind"]
                    row["location"] = entry.get("location") or row["location"]
                    row["enabled"] = entry.get("enabled", row["enabled"])
            # 持久化但本次没能插进 gdb 的（符号缺失等）也要在列表里可见
            seen = {row["id"] for row in rows}
            for bid in sorted(self._bp_entries, key=_bp_index):
                if bid in seen:
                    continue
                entry = self._bp_entries[bid]
                rows.append({"id": bid, "gdb_id": "", "kind": entry.get("kind", "func"),
                             "location": entry.get("location", ""),
                             "enabled": bool(entry.get("enabled", True)),
                             "condition": entry.get("condition", ""), "hit_count": 0,
                             "verified": False, "temporary": False,
                             "hardware": bool(entry.get("hardware", False))})
            self._breakpoints = rows
            return rows

    def _bp_spec(self, kind: str, location: str) -> str:
        """断点 kind + location → 喂给 ``-break-insert`` 的定位串。

        ``source`` 会把 ``<file>:<line>`` 绝对化并**按需整体加引号**：Windows 路径含空格时
        ``-break-insert C:/a b/main.c:12`` 会被 MI 拆成两个参数（D1 spike 结论）。
        """
        k = str(kind or "func")
        if k == "addr":
            return f"*{location}"
        if k == "source":
            head, _, tail = str(location or "").rpartition(":")
            return self._source_quoted(head, tail)
        return location

    def breakpoint_add(self, *, kind: str = "func", location: str = "",
                       condition: str = "", hardware: bool = False,
                       temporary: bool = False, rev: int | None = None) -> dict:
        with self._op_lock:
            assert self._gdb is not None
            self._check_rev(rev)
            if not location:
                raise DebugError("debug-bad-request", "断点需要 location（函数名或地址）")
            loc = self._bp_spec(kind, location)
            stored_loc = location
            if kind == "source":
                head, _, tail = str(location).rpartition(":")
                stored_loc = self._source_rel(head, tail)
            cmd = "-break-insert"
            if hardware:
                cmd += " -h"
            if temporary:
                cmd += " -t"
            try:
                rec = self._gdb.command(f"{cmd} {loc}", timeout=8.0)
            except MiError as exc:
                raise DebugError("debug-bad-request", f"插入断点失败：{exc}")
            bk = (rec.get("results") or {}).get("bkpt") or {}
            gdb_id = str(bk.get("number") or "")
            self._bp_seq += 1
            stable = f"bp-{self._bp_seq}"
            self._bp_id_map[gdb_id] = stable
            if condition and gdb_id:
                try:
                    self._gdb.command(f"-break-condition {gdb_id} {condition}", timeout=5.0)
                except MiError as exc:
                    raise DebugError("debug-bad-request", f"条件断点失败：{exc}")
            if not temporary:
                self._bp_entries[stable] = {
                    "id": stable, "kind": kind, "location": stored_loc,
                    "condition": condition, "enabled": True, "hardware": hardware,
                }
                self._persist()
            self.emit("debug/breakpoint", {"id": stable, "gdb_id": gdb_id,
                                           "verified": True, "hit_count": 0,
                                           "enabled": True})
            return {"breakpoints": self.breakpoints(), "rev": self._store_rev}

    def breakpoint_update(self, *, bp_id: str, condition: str | None = None,
                          enabled: bool | None = None, rev: int | None = None) -> dict:
        with self._op_lock:
            assert self._gdb is not None
            self._check_rev(rev)
            gdb_id = self._gdb_id_of(bp_id)
            if condition is not None and gdb_id:
                self._gdb.command(f"-break-condition {gdb_id} {condition}", timeout=5.0)
            if enabled is not None and gdb_id:
                op = "-break-enable" if enabled else "-break-disable"
                self._gdb.command(f"{op} {gdb_id}", timeout=5.0)
            entry = self._bp_entries.get(bp_id)
            if entry is not None:
                if condition is not None:
                    entry["condition"] = condition
                if enabled is not None:
                    entry["enabled"] = bool(enabled)
                self._persist()
            return {"breakpoints": self.breakpoints(), "rev": self._store_rev}

    def breakpoint_remove(self, *, bp_id: str, rev: int | None = None) -> dict:
        with self._op_lock:
            assert self._gdb is not None
            self._check_rev(rev)
            try:
                gdb_id = self._gdb_id_of(bp_id)
            except DebugError:
                gdb_id = ""
            if gdb_id:
                self._gdb.command(f"-break-delete {gdb_id}", timeout=5.0)
                self._bp_id_map.pop(gdb_id, None)
            if bp_id in self._bp_entries:
                self._bp_entries.pop(bp_id, None)
                self._persist()
            self.emit("debug/breakpoint", {"id": bp_id, "gdb_id": gdb_id,
                                           "verified": False, "hit_count": 0,
                                           "enabled": False, "deleted": True})
            return {"breakpoints": self.breakpoints(), "rev": self._store_rev}

    def breakpoint_toggle(self, *, bp_id: str, rev: int | None = None) -> dict:
        with self._op_lock:
            self._check_rev(rev)
            cur = next((b for b in self._breakpoints if b.get("id") == bp_id), None)
            if cur is None:
                self.breakpoints()
                cur = next((b for b in self._breakpoints if b.get("id") == bp_id), None)
            enabled = bool(cur.get("enabled")) if cur else bool(
                self._bp_entries.get(bp_id, {}).get("enabled", True))
            return self.breakpoint_update(bp_id=bp_id, enabled=not enabled)

    def _gdb_id_of(self, bp_id: str) -> str:
        for gid, sid in self._bp_id_map.items():
            if sid == bp_id:
                return gid
        if bp_id.startswith("gdb-"):
            return bp_id[4:]
        raise DebugError("debug-bad-request", f"未知断点 id：{bp_id}")

    # ── 源码（P3-A）────────────────────────────────────────────
    def _source_quoted(self, file: str, line: int | str) -> str:
        """``file``+``line`` → gdb 可用的 ``-break-insert`` 参数（已按需加引号）。"""
        try:
            return dsrc.breakpoint_spec(self.plan.source_dir, file, int(line or 0))["quoted"]
        except dsrc.SourceError as exc:
            raise DebugError("debug-bad-request", str(exc),
                             "file 必须在工程源码根内；行号 ≥ 1")

    def _source_rel(self, file: str, line: int | str) -> str:
        """持久化用的 ``<相对路径>:<行>``（POSIX 分隔符，换机可复用）。"""
        try:
            spec = dsrc.breakpoint_spec(self.plan.source_dir, file, int(line or 0))
        except dsrc.SourceError as exc:
            raise DebugError("debug-bad-request", str(exc))
        return f"{spec['rel']}:{spec['line']}"

    def source(self, *, file: str = "", start: int = 1, count: int = 120) -> dict:
        """源码行读取（路径受限，单次 ≤400 行 / 512 KB）。

        ``file`` 省略时用当前停止帧（``stop.frame.fullname``）兜底，方便 UI「刷新本页」。
        """
        with self._op_lock:
            target = str(file or "").strip()
            if not target:
                fr = (self.stop or {}).get("frame") or {}
                target = str(fr.get("fullname") or "")
                if not target:
                    raise DebugError("debug-source-unavailable",
                                     "当前停止点没有源码信息",
                                     "ELF 需带 -g 调试信息；或在源码页签手动选择文件")
            try:
                out = dsrc.read_lines(self.plan.source_dir, target,
                                      start=start, count=count)
            except dsrc.SourceError as exc:
                raise DebugError("debug-bad-request", str(exc),
                                 "路径必须是工程源码根内的文件")
            except dsrc.SourceUnavailable as exc:
                raise DebugError("debug-source-unavailable", str(exc),
                                 "ELF 无调试信息或源码已移动（改 -g / 重新构建）")
            fr = (self.stop or {}).get("frame") or {}
            out["stop_seq"] = self.stop_seq
            out["stop_line"] = fr.get("line")
            out["stop_file"] = fr.get("fullname") or fr.get("file") or ""
            return out

    # ── 内存 / 反汇编 / 求值 / 写 ─────────────────────────────────
    def memory(self, *, addr: str, count: int = 256) -> dict:
        with self._op_lock:
            self._require_stopped()
            if count <= 0 or count > 4096:
                raise DebugError("debug-limit", "单次内存读取 1–4096 字节", "分页请求")
            assert self._gdb is not None
            rec = self._gdb.command(f"-data-read-memory-bytes {addr} {int(count)}", timeout=5.0)
            out = dd.memory(rec, addr=addr, count=count)
            out["ok"] = True
            out["stop_seq"] = self.stop_seq
            return out

    def disasm(self, *, addr: str = "", count: int = 32, mode: int = 2) -> dict:
        with self._op_lock:
            self._require_stopped()
            if count <= 0 or count > 128:
                raise DebugError("debug-limit", "反汇编窗口 1–128 条", "减小 count")
            assert self._gdb is not None
            start = addr or (self.stop or {}).get("pc") or (self.stop or {}).get("frame", {}).get("addr", "")
            if not start:
                raise DebugError("debug-bad-request", "缺少 addr（且没有当前 PC）")
            try:
                base = int(str(start), 0)
            except ValueError:
                raise DebugError("debug-bad-request", f"非法地址：{start!r}")
            end = hex(base + 4 * int(count))
            rec = self._gdb.command(f"-data-disassemble -s {hex(base)} -e {end} -- {2 if mode == 2 else 0}",
                                    timeout=5.0)
            insns = dd.disasm(rec, mode=2 if mode == 2 else 0)
            pc = (self.stop or {}).get("pc") or ""
            for ins in insns:
                if pc and ins.get("addr") == pc:
                    ins["pc"] = True
            return {"ok": True, "addr": hex(base), "instructions": insns,
                    "stop_seq": self.stop_seq}

    def evaluate(self, *, expr: str, frame: int | None = None) -> dict:
        with self._op_lock:
            self._require_stopped()
            assert self._gdb is not None
            if frame is not None:
                self._gdb.command(f"-stack-select-frame {int(frame)}", timeout=5.0)
            try:
                rec = self._gdb.command(
                    f"-data-evaluate-expression {_mi_expr(expr)}", timeout=8.0)
            except MiError as exc:
                raise DebugError("debug-bad-request", f"表达式求值失败：{exc}")
            out = dd.evaluate(rec)
            out.update({"ok": True, "expr": expr, "stop_seq": self.stop_seq})
            return out

    # ── 外设（SVD，P2）───────────────────────────────────────────
    def peripherals(self, *, path: str = "", read: bool = False) -> dict:
        with self._op_lock:
            self._require_stopped()
            svd_path = str(self.profile.get("svd") or "")
            if not svd_path:
                raise DebugError("debug-svd-missing",
                                 "当前芯片/工程没有可用的 SVD 描述文件",
                                 "在芯片包 debug.svd 声明，或在 elab.host.yaml 的 svd_roots 放置 SVD")
            try:
                model = svd_mod.load(svd_path)
            except (OSError, ValueError) as exc:
                raise DebugError("debug-svd-missing", f"SVD 读取失败：{exc}",
                                 "检查 debug.svd 指向的文件是否存在、是否合法 CMSIS-SVD")
            assert self._gdb is not None

            def read_bytes(addr: int, size: int) -> bytes | None:
                rec = self._gdb.command(f"-data-read-memory-bytes {hex(addr)} {int(size)}",
                                        timeout=5.0)
                out = dd.memory(rec, addr=hex(addr), count=size)
                try:
                    return bytes.fromhex(str(out.get("bytes") or "").replace(" ", ""))
                except ValueError:
                    return b""

            try:
                out = svd_mod.tree(model, path=path,
                                   read_bytes=read_bytes if read else None)
            except KeyError as exc:
                raise DebugError("debug-bad-request", str(exc.args[0]),
                                 "路径形如 GPIOA 或 GPIOA.ODR")
            out.update({"ok": True, "stop_seq": self.stop_seq,
                        "svd": {"file": svd_path, "name": model["name"]}})
            return out

    # ── RTOS 栈水位（P3）────────────────────────────────────────
    def rtos(self) -> dict:
        with self._op_lock:
            self._require_stopped()
            assert self._gdb is not None
            try:
                data = rtos_mod.collect(_GdbReader(self))
            except rtos_mod.RtosUnavailable as exc:
                self._rtos_available = False
                raise DebugError("debug-rtos-unavailable", str(exc),
                                 "确认 ELF 含 FreeRTOS 调试信息（-g3）")
            data.update({"ok": True, "stop_seq": self.stop_seq})
            return data

    def write_memory(self, *, addr: str, value: str) -> dict:
        """写内存（调用方必须已完成 allow_write + confirm 闸门）。"""
        with self._op_lock:
            self._require_stopped()
            assert self._gdb is not None
            raw = value[2:] if value.lower().startswith("0x") else value
            raw = raw.replace(" ", "")
            if len(raw) % 2 != 0 or len(raw) > 64:
                raise DebugError("debug-bad-request", "value 必须是 1–32 字节的十六进制")
            try:
                bytes.fromhex(raw)
            except ValueError:
                raise DebugError("debug-bad-request", "value 不是合法十六进制")
            before = self.memory(addr=addr, count=len(raw) // 2)
            self._gdb.command(f'-data-write-memory-bytes {addr} "{raw}"', timeout=5.0)
            after = self.memory(addr=addr, count=len(raw) // 2)
            self.emit("debug/output", {"stream": "log",
                                       "text": f"write {addr} <- 0x{raw}"})
            return {"ok": True, "before": before["bytes"], "after": after["bytes"]}

    def write_register(self, *, name: str, value: str) -> dict:
        with self._op_lock:
            self._require_stopped()
            assert self._gdb is not None
            word = self._reg_word(name, value)
            try:
                self._gdb.command(f'-interpreter-exec console "set ${name} = 0x{word}"',
                                  timeout=5.0)
            except MiError as exc:
                raise DebugError("debug-write-denied", f"写寄存器失败：{exc}")
            after = self._reg_value(name)
            return {"ok": True, "register": name, "after": after}

    @staticmethod
    def _reg_word(name: str, value: object) -> str:
        """校验寄存器名 + 值，返回纯 HEX 串（含宽度校验）。"""
        n = str(name or "").strip().lstrip("$")
        if n.lower() in _REG_READONLY:
            raise DebugError("debug-write-denied", f"{n} 是只读寄存器（pc/lr/xpsr）",
                             "要改 pc 位置请用 run_to_line / run_to")
        if not register_writable(n):
            if _REG_WIDE_RE.match(n.lower()):
                raise DebugError("debug-write-denied", f"{n} 是 64/128 位寄存器，P3 只读",
                                 "s0–s31 已开放；d/q 待 P3b")
            raise DebugError("debug-bad-request", f"寄存器名不在白名单：{name!r}")
        word = str(value).strip()
        if word.lower().startswith("0x"):
            word = word[2:]
        width = register_width(n)
        max_digits = width // 4
        if (not word or len(word) > max_digits
                or any(c not in "0123456789abcdefABCDEF" for c in word)):
            raise DebugError("debug-bad-request",
                             f"{n} 的值必须是 1–{max_digits} 位十六进制（{width} 位宽）")
        return word

    def _reg_value(self, name: str) -> dict:
        """读单个寄存器当前值（复用整表读，避免两套解析）。"""
        groups = self.registers(group="all")["groups"]
        return next((r for g in groups for r in g["regs"] if r["name"] == name), {})

    def write_registers(self, *, items: list[dict]) -> dict:
        """按组批量写（§7.2）：**先整批校验**，任何一项不合法则一条都不写。

        无事务回滚：中途 gdb 失败时把已应用的与失败项都返回，UI 明说不假装原子。
        """
        with self._op_lock:
            self._require_stopped()
            assert self._gdb is not None
            if not isinstance(items, list) or not items:
                raise DebugError("debug-bad-request", "items 不能为空")
            if len(items) > 16:
                raise DebugError("debug-limit", "单次最多写 16 个寄存器",
                                 "分批提交")
            prepared: list[tuple[str, str]] = []
            seen: set[str] = set()
            for raw in items:
                if not isinstance(raw, dict):
                    raise DebugError("debug-bad-request", "items 每项必须是 {name,value}")
                name = str(raw.get("name") or "").strip().lstrip("$")
                if name in seen:
                    raise DebugError("debug-bad-request", f"重复的寄存器：{name}")
                seen.add(name)
                prepared.append((name, self._reg_word(name, raw.get("value"))))
            before_map = {r["name"]: r.get("hex", "") for g in self.registers(group="all")["groups"]
                          for r in g["regs"]}
            applied: list[dict] = []
            failed: dict | None = None
            for name, word in prepared:
                try:
                    self._gdb.command(
                        f'-interpreter-exec console "set ${name} = 0x{word}"', timeout=5.0)
                except MiError as exc:
                    failed = {"name": name, "code": "debug-write-denied", "message": str(exc)}
                    break
                applied.append({"name": name, "before": before_map.get(name, ""),
                                "after": f"0x{int(word, 16):08x}" if len(word) <= 8 else f"0x{word.lower()}"})
            actual = {r["name"]: r.get("hex", "") for g in self.registers(group="all")["groups"]
                      for r in g["regs"]}
            for row in applied:
                row["after"] = actual.get(row["name"], row["after"])
            out = {"ok": failed is None, "applied": applied,
                   "stop_seq": self.stop_seq}
            if failed:
                out["failed"] = failed
            self.emit("debug/output", {
                "stream": "log",
                "text": "registers <- " + ", ".join(f"{a['name']}={a['after']}" for a in applied)
                        + (f"（失败：{failed['name']}）" if failed else "")})
            return out

    # ── 关闭 ────────────────────────────────────────────────────
    def snapshot(self) -> dict:
        lease_remaining = 0
        if self.lease_s and self.owner == "agent":
            lease_remaining = max(0, int(self.lease_s - (time.time() - self.last_active)))
        return {
            "id": self.session_id,
            "open_seq": self.open_seq,
            "project": self.plan.name,
            "chip": self.profile.get("chip") or self.profile.get("part") or "",
            "elf": self.profile.get("elf") or "",
            "state": self.state,
            "actor": self.actor,
            "owner": self.owner,
            "started_at": self.started_at,
            "lease_s": self.lease_s,
            "lease_remaining_s": lease_remaining,
            "port": self.port,
            "gdb": self.profile.get("gdb") or "",
            "stop": self.stop,
            "threads": self._threads() if self.state == "stopped" else [],
            "svd": {"available": bool(self.profile.get("svd")),
                    "file": self.profile.get("svd_name") or ""},
            "features": self._features(),
            "error": self.error,
        }

    def _features(self) -> list[str]:
        """面板渲染白名单（§6.1）：没有的能力**不得**列出，否则页签会开出空屏。"""
        feats = ["session", "control", "stack", "variables",
                 "registers", "breakpoints", "memory", "disasm", "watch", "source"]
        if self.profile.get("svd"):
            feats.append("svd")
        # RTOS 能力**乐观**声明：只有端点真正报不可用后才置 false 并隐藏页签
        # （open 时探符号在个别 gdb/固件组合下会误判，见实测 2026-11-03）。
        if self._rtos_available is not False:
            feats.append("rtos")
        return feats

    def close(self, *, resume: bool = True, reason: str = "user-closed") -> dict:
        resumed = False
        with self._op_lock:
            if self._gdb is not None and self.state not in ("closed", "error"):
                if self.state == "stopped" and resume:
                    try:
                        self._gdb.command('-interpreter-exec console "monitor reset run"',
                                          timeout=10.0)
                        resumed = True
                    except MiError:
                        try:
                            self._gdb.command("-exec-continue", timeout=5.0)
                            resumed = True
                        except MiError:
                            resumed = False
                elif self.state == "running":
                    resumed = True
        self._teardown(resume=resume)
        self.resumed_on_close = resumed
        self._state("closed", reason)
        self.emit("debug/closed", {"reason": reason, "resumed": resumed})
        return {"closed": True, "resumed": resumed}

    def _teardown(self, *, resume: bool) -> None:
        self._closed = True
        if self._gdb is not None:
            try:
                self._gdb.close()
            except Exception:                        # noqa: BLE001
                pass
            self._gdb = None
        proc = self._openocd
        self._openocd = None
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(5)
            except Exception:                        # noqa: BLE001
                try:
                    proc.kill()
                except Exception:                    # noqa: BLE001
                    pass
