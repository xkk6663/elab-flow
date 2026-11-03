"""elab.gdbmi —— GDB/MI 记录解析与会话（零依赖）。

设计依据：``docs/design/技术方案_调试面板复刻cortex-debug.md`` §7.2。

这一层只做两件事：
  ① 把 GDB 的 MI 行协议解析成 ``dict``；
  ② 给一个长驻 ``gdb --interpreter=mi2`` 进程加 token/超时/中断的薄封装。

**不做**任何业务判断（谁是断点、下一步停在哪个函数）—— 那是
``debugsession.py`` / ``debugdata.py`` 的事。
"""

from __future__ import annotations

import concurrent.futures as cf
import re
import subprocess
import threading
import time

from ._winproc import proc_kwargs

_ESC = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "e": "\x1b",
        "a": "\a", "f": "\f", "v": "\v", "0": "\0"}

_MI_LEAD = {"^": "result", "+": "status", "*": "exec", "=": "notify",
            "~": "console", "@": "target", "&": "log"}
_MI_RE = re.compile(r"^(\d+)?([\^+*=~@&])(.*)$", re.S)


class MiError(RuntimeError):
    """MI 命令失败 / 解析失败 / 超时。``record`` 保留原始 MI 记录便于审计。"""

    def __init__(self, msg: str, record: dict | None = None, *, code: str = "mi-error"):
        super().__init__(msg)
        self.record = record or {}
        self.code = code


def _cstr(s: str, i: int) -> tuple[str, int]:
    """从 ``i``（指向开引号）解析一个 MI c-string，返回 (文本, 下一个下标)。"""
    i += 1
    out: list[str] = []
    n = len(s)
    while i < n:
        c = s[i]
        if c == '"':
            return "".join(out), i + 1
        if c == "\\":
            if i + 1 >= n:
                break
            nxt = s[i + 1]
            if nxt in "01234567":                    # 八进制转义
                j, dig = i + 1, ""
                while j < n and len(dig) < 3 and s[j] in "01234567":
                    dig += s[j]
                    j += 1
                out.append(chr(int(dig, 8)))
                i = j
                continue
            out.append(_ESC.get(nxt, nxt))
            i += 2
            continue
        out.append(c)
        i += 1
    raise MiError(f"未闭合的 c-string：{s[:60]}")


def _skip_ws(s: str, i: int) -> int:
    while i < len(s) and s[i] in " ,":
        i += 1
    return i


#: 裸键里允许出现的字符（MI 的 result 变量名不强制加引号：``stack=[...]``、
#: ``thread-id="1"``、``asm_insns=[...]``）。把它当成"读到 = 或结构符为止"。
_KEY_STOP = set("=,{}[]")


def _key(s: str, i: int) -> tuple[str, int]:
    i = _skip_ws(s, i)
    if i < len(s) and s[i] == '"':
        return _cstr(s, i)
    j = i
    while j < len(s) and s[j] not in _KEY_STOP:
        j += 1
    key = s[i:j].strip()
    if not key:
        raise MiError(f"缺变量名：{s[i:i + 24]}")
    return key, j


def _value(s: str, i: int):
    """解析 MI value：c-string / tuple(``{}``) / list(``[]``) / 裸字面量。"""
    i = _skip_ws(s, i)
    if i >= len(s):
        raise MiError(f"value 意外结束：{s[:60]}")
    c = s[i]
    if c == '"':
        return _cstr(s, i)
    if c == "{":
        i += 1
        out: dict = {}
        while True:
            i = _skip_ws(s, i)
            if i >= len(s):
                raise MiError(f"tuple 未闭合：{s[:60]}")
            if s[i] == "}":
                return out, i + 1
            k, i = _key(s, i)
            i = _skip_ws(s, i)
            if i >= len(s) or s[i] != "=":
                raise MiError(f"tuple 缺 '='：{s[i:i + 20]}")
            out[k], i = _value(s, i + 1)
    if c == "[":
        i += 1
        out: list = []
        while True:
            i = _skip_ws(s, i)
            if i >= len(s):
                raise MiError(f"list 未闭合：{s[:60]}")
            if s[i] == "]":
                return out, i + 1
            if s[i] == '"':
                k, i = _cstr(s, i)
                j = i
                while j < len(s) and s[j] == " ":
                    j += 1
                if j < len(s) and s[j] == "=":       # 无花括号的 result
                    v, i = _value(s, j + 1)
                    out.append({k: v})
                else:
                    out.append(k)
                continue
            if s[i] not in "{[":                    # 裸键的 result（frame={...}）
                k, j = _key(s, i)
                j = _skip_ws(s, j)
                if j < len(s) and s[j] == "=":
                    v, i = _value(s, j + 1)
                    out.append({k: v})
                    continue
            v, i = _value(s, i)
            out.append(v)
    # 未加引号的裸字面量（少数 MI 实现会把数字/枚举裸写；容错为字符串）
    j = i
    while j < len(s) and s[j] not in ",]}{":
        j += 1
    return s[i:j].strip(), j


def parse_record(line: str) -> dict:
    """解析一行 MI 记录；非法抛 :class:`MiError`（调用方可降级为日志）。"""
    line = line.rstrip("\r\n")
    if not line:
        raise MiError("空行")
    if line.startswith("("):                          # prompt: (gdb)
        return {"token": None, "kind": "prompt", "cls": None,
                "text": line, "results": {}}
    m = _MI_RE.match(line)
    if not m:
        raise MiError(f"不是 MI 记录：{line[:60]}")
    token, lead, rest = m.group(1), m.group(2), m.group(3)
    kind = _MI_LEAD[lead]
    if lead in "~@&":
        text, _ = _cstr(rest, 0)
        return {"token": token, "kind": kind, "cls": None, "text": text,
                "results": {}}
    head, _, tail = rest.partition(",")
    results: dict = {}
    i = 0
    while i < len(tail):
        i = _skip_ws(tail, i)
        if i >= len(tail):
            break
        k, i = _key(tail, i)
        i = _skip_ws(tail, i)
        if i >= len(tail) or tail[i] != "=":
            raise MiError(f"result 缺 '='：{tail[i:i + 20]}")
        results[k], i = _value(tail, i + 1)
    return {"token": token, "kind": kind, "cls": head.strip(),
            "text": None, "results": results}


class MiSession:
    """一个长驻 ``gdb --interpreter=mi2`` 会话。

    线程模型（§7.4）：
      - **唯一读者**：``_read_loop`` 线程独占 stdout；
      - 调用方线程只写 stdin 并等 token 对应的 Future；
      - ``on_async`` / ``on_stream`` 在读者线程里被调用，**必须**是短的、不阻塞的
        （通常只是把记录塞进事件队列）。
    """

    def __init__(self, argv: list[str], *, cwd: str | None = None,
                 env: dict | None = None, log=print):
        self._argv = argv
        self._cwd = cwd
        self._env = env
        self._log = log
        self._proc: subprocess.Popen | None = None
        self._pending: dict[str, tuple[cf.Future, float]] = {}
        self._expired: set[str] = set()               # 迟到 token（上限 1000）
        self._lock = threading.Lock()
        self._seq = 0
        self._read_thread: threading.Thread | None = None
        self.on_async = lambda rec: None              # *stopped / *running / =notify
        self.on_stream = lambda rec: None             # ~ / @ / &

    # ── 生命周期 ────────────────────────────────────────────────
    def start(self, timeout: float = 10.0) -> None:
        self._proc = subprocess.Popen(
            self._argv, cwd=self._cwd, env=self._env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, encoding="utf-8",
            errors="replace", bufsize=1, **proc_kwargs(),
        )
        self._read_thread = threading.Thread(target=self._read_loop, daemon=True,
                                             name="elab-gdb-mi")
        self._read_thread.start()
        # 首个命令只用于确认 gdb 已经能应答（超时 → 上层报 debug-gdb-missing/超时）
        self.command("-gdb-version", timeout=timeout)

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def close(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        try:
            proc.stdin.close()                        # gdb 收到 EOF 会退出
        except Exception:                             # noqa: BLE001
            pass
        try:
            proc.terminate()
            proc.wait(5)
        except Exception:                             # noqa: BLE001
            try:
                proc.kill()
            except Exception:                        # noqa: BLE001
                pass

    # ── 命令 ────────────────────────────────────────────────────
    def command(self, cmd: str, timeout: float = 5.0) -> dict:
        """发一条 MI 命令并等它的结果记录（``^done`` / ``^running`` / ``^error``）。"""
        proc = self._proc
        if proc is None or proc.poll() is not None:
            raise MiError("gdb 不在运行", code="gdb-dead")
        with self._lock:
            self._seq += 1
            token = str(self._seq)
            fut: cf.Future = cf.Future()
            self._pending[token] = (fut, time.monotonic() + max(0.1, timeout))
        try:
            proc.stdin.write(f"{token}{cmd}\n")
            proc.stdin.flush()
        except Exception as exc:                      # noqa: BLE001
            with self._lock:
                self._pending.pop(token, None)
            raise MiError(f"写入 gdb 失败：{exc}", code="gdb-dead")
        try:
            return fut.result(timeout=timeout)
        except cf.TimeoutError:
            with self._lock:
                self._pending.pop(token, None)
                if len(self._expired) > 1000:
                    self._expired.clear()
                self._expired.add(token)
            raise MiError(f"MI 命令超时（{timeout}s）：{cmd}", code="mi-timeout")

    def send(self, cmd: str) -> None:
        """发命令但**不等结果**（``-exec-continue`` / ``-exec-interrupt`` 用）。"""
        proc = self._proc
        if proc is None or proc.poll() is not None:
            raise MiError("gdb 不在运行", code="gdb-dead")
        with self._lock:
            self._seq += 1
            token = str(self._seq)
        proc.stdin.write(f"{token}{cmd}\n")
        proc.stdin.flush()

    # ── 读者线程 ────────────────────────────────────────────────
    def _read_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        for line in proc.stdout:
            try:
                rec = parse_record(line)
            except MiError:
                # 启动警告 / 非 MI 杂散行 → 当 log 流交给上层（不崩会话）
                self._safe(self.on_stream, {"kind": "log", "text": line})
                continue
            if rec["kind"] in ("console", "target", "log"):
                self._safe(self.on_stream, rec)
                continue
            if rec["kind"] == "prompt":
                continue
            tok = rec["token"]
            if tok is not None and rec["kind"] != "result":
                # +download / =notify 也可能带 token（进度记录）：
                # ★ 绝不能拿它 resolve 对应的命令 Future —— 否则 `-target-download`
                #   会在第一条进度记录处就"完成"，调用方以为镜像已烧完。
                self._safe(self.on_async, rec)
                continue
            if tok is not None:
                with self._lock:
                    hit = self._pending.pop(tok, None)
                    if hit is None:
                        # 迟到的结果：token 已因超时出队 → 丢弃，绝不能当异步事件
                        if tok in self._expired:
                            self._expired.discard(tok)
                            continue
                if hit is not None:
                    fut, _deadline = hit
                    if rec["cls"] == "error":
                        msg = str(rec["results"].get("msg") or "").strip()
                        fut.set_exception(MiError(msg or f"MI 命令失败：{line.strip()}",
                                                    rec, code="mi-error"))
                    else:
                        fut.set_result(rec)
                    continue
            # 无 token（或 token 已过期）的异步 / 通知
            self._safe(self.on_async, rec)
        # stdout 关闭 = gdb 退出
        self._safe(self.on_async, {"kind": "exit", "cls": "exit",
                                   "text": None, "results": {}, "token": None})

    def _safe(self, cb, rec: dict) -> None:
        try:
            cb(rec)
        except Exception as exc:                      # noqa: BLE001
            self._log(f"[gdbmi] 回调异常：{exc!r}")
