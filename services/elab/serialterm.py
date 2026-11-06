"""elab.serialterm —— 串口交互式往返（M3-b 写通道）。

与 ``monitor.py`` 的职责边界
--------------------------
    monitor      自动化闭环**判据**：开一次口、收一段、判 ok/failed/inconclusive
    serialterm   人工**交互**：把一条命令写出去、收一小段回显、立刻返回

为什么是「无状态往返」而不是常驻会话
----------------------------------
串口是**独占资源**（约束 N5）。常驻会话会长期占着口，与 ``elab run`` 的 monitor
步骤互斥；更麻烦的是：一旦持口的线程僵死，**没人**会释放它，必须重启整个驾驶舱。
无状态往返（open → write → read → close）把占用窗口压到**一次请求之内** —— 代价是
每次重开（几十 ms），换来的是**没有可僵死的状态**，且天然与 monitor 串行。

回显窗口（``read_ms``）为什么必须存在
----------------------------------
"只写不读"对交互式调试没有意义（看不到设备回什么）。所以写完之后**必须**留一个
短窗口收回应，否则用户只能"盲发"。默认 600ms：够跑完一次「回显 + 一行结果」，
又不至于让请求卡太久（UI 可调）。

取配置的顺序与 ``monitor.run()`` **逐字一致**
------------------------------------------
``显式参数 → 工程 serial.{port,baud} → host.serial.{default,baud} → 硬默认``。
不一致的后果很隐蔽：预览里写着 COM10，真写的时候却按 ``auto`` 挑了口 —— 两边
都说"成功"，可数据发到了别的设备上。

★ 本模块**不发射事件**：写通道不属于任何 run（它与 monitor 天然互斥 —— monitor
  在跑时它根本写不进去），因此**没有**可挂的 run 上下文。TX/RX 的持久化走
  **独立的 console 日志**（`serialconsole.py`，M3-b2），由调用方通过 `journal=`
  回调接进来 —— 本模块只负责"发一条、收一段"，不认识文件与路径。
"""

from __future__ import annotations

import re
import threading
import time

from . import serialport as sp
from . import serialtransport as tp
from .config import Config

#: 写完之后收回显的默认窗口（ms）。理由见模块 docstring。
DEFAULT_READ_MS = 600
#: 进程内串行锁：一次只允许一个往返持有串口。
#: ★ 跨进程的互斥（与 `elab run` 的 monitor 步骤）由 **调用方**负责 —— 本模块不
#:   认识 run 概念，让它去查 RunManager 是把"传输"和"调度"焊死。
_LOCK = threading.Lock()
#: 等锁上限（s）。拿不到说明"有人在用串口"，**报错比排队好**：
#: 排队会让用户以为自己的操作被吞了。
_LOCK_WAIT_S = 2.0


def resolve_target(cfg: Config, name: str, *, port: str = "",
                   baud: int = 0, line=None) -> dict:
    """解析出「这条命令发给谁」。

    返回 ``{spec, port, baud, reason, backend, ports}`` 的**旧键不变**，另追加
    ``kind / line / line_text / net / errors``；``port`` 为空表示选不出来
    （理由在 ``reason`` 里，**不猜**）。

    ★ 实现已收口到 ``serialtransport.resolve`` —— 本函数只做「旧形状」的投影，
      避免与本模块的其它调用点再各写一套优先级。
    """
    t = tp.resolve(cfg, name, port=port, baud=baud, line=line)
    return {"spec": t.port_spec, "port": t.label, "baud": t.baud,
            "reason": t.reason, "backend": t.backend,
            "ports": list(t.ports), "kind": t.kind,
            "line": t.line.as_dict(), "line_text": t.line.text,
            "net": dict(t.net), "errors": list(t.errors),
            "error": "；".join(t.errors)}


#: 发送表示（P1 起）：旧参数 ``hex_``/``newline`` 是这里的别名。
SEND_FORMATS = ("ascii", "utf8", "gbk", "hex")
#: 行尾枚举（``eol`` 的新参数；旧 ``newline=True`` 等价于 ``crlf``）。
EOLS = {"none": b"", "lf": b"\n", "cr": b"\r", "crlf": b"\r\n", "tab": b"\t"}


#: 自动识别（面板的「自动」选项）—— 不放进 ``SEND_FORMATS``：
#: 它是「让内核替你选」，不是一个真正的编码。
AUTO_FORMAT = "auto"

#: 十六进制串里的分隔符（含中文逗号）。
_HEX_SEPS = (" ", "\t", "\n", "\r", ",", "，", ":", ";")
#: 一个十六进制「段」：可带 0x/\x 前缀，1–2 位。
_HEX_TOKEN_RE = re.compile(r"^(?:0x|\\x)?[0-9a-fA-F]{1,2}$", re.I)
_HEX_PREFIX_RE = re.compile(r"(?:0x|\\x)", re.I)


def normalize_hex(data: str) -> str:
    """把「人写的十六进制」归一成 ``bytes.fromhex`` 能吃的形式。

    支持 ``0A FF`` / ``0A,FF`` / ``0A:FF`` / ``0x0A 0xFF`` / ``\\x0A\\xFF``；
    前缀替换成空格而不是直接删掉，避免 ``0x0A0xFF`` 被粘成 5 位。
    """
    s = _HEX_PREFIX_RE.sub(" ", data or "")
    s = re.sub(r"[,，:;]", " ", s)
    return "".join(s.split())


def detect_format(data: str) -> str:
    """「自动」模式下判定这段输入按 HEX 还是文本发。

    ★ 保守是刻意的：HEX 需要**明确线索**（``0x``/``\\x`` 前缀，或分隔符 +
      每段都是十六进制、总位数为偶数）。裸 ``1234`` 一律按文本 ——
      固件命令里的 ``PING:42`` 这类数字绝不能因为"长得像十六进制"被发成二进制。
    """
    s = (data or "").strip()
    if not s:
        return "utf8"
    if _HEX_PREFIX_RE.search(s):
        return "hex"
    if any(sep in s for sep in _HEX_SEPS):
        tokens = [t for t in re.split(r"[\s,，:;]+", s) if t]
        if tokens and all(_HEX_TOKEN_RE.match(t) for t in tokens):
            digits = sum(len(_HEX_PREFIX_RE.sub("", t)) for t in tokens)
            if digits and digits % 2 == 0:
                return "hex"
    return "utf8"


def resolve_payload(data: str, *, newline: bool = True, hex_: bool = False,
                    format: str | None = None, eol: str | None = None,
                    encoding: str | None = None) -> tuple[bytes, str, str, str]:
    """把用户输入编成待发字节，并**回传解析后的格式与行尾**。

    返回 ``(payload, format, eol, error)``；``error`` 非空即失败。
    预览与真实发送共用这一个函数 —— 否则"预览看到的字节"和"实际发出去的字节"
    会在两条代码路径上慢慢漂移。

    ``format="auto"`` 走 :func:`detect_format`；HEX **不加**行结束符
    （发的是二进制帧，多一个 CR 就是多一个字节）。
    """
    if not (data or "").strip():
        return b"", "", "", "内容为空 —— 没有可发送的字节"
    fmt = (format or ("hex" if hex_ else "utf8")).lower()
    if fmt == AUTO_FORMAT:
        fmt = detect_format(data)
    if fmt not in SEND_FORMATS:
        return b"", fmt, "", (
            f"未知发送格式：{format!r}（可选 {'/'.join(SEND_FORMATS)} / {AUTO_FORMAT}）")
    if fmt == "hex":
        try:
            return bytes.fromhex(normalize_hex(data)), "hex", "none", ""
        except ValueError as exc:
            return b"", "hex", "none", (
                f"不是合法十六进制（{exc}）：{data!r}")
    eol_key = eol
    if eol_key is None:
        eol_key = "crlf" if newline else "none"
    eol_key = str(eol_key).lower()
    if eol_key not in EOLS:
        return b"", fmt, eol_key, (
            f"未知行尾：{eol!r}（可选 {'/'.join(EOLS)}）")
    enc = encoding or ("gbk" if fmt == "gbk" else ("ascii" if fmt == "ascii" else "utf-8"))
    try:
        payload = (data or "").encode(enc)
    except (LookupError, UnicodeEncodeError) as exc:
        return b"", fmt, eol_key, f"编码失败（encoding={enc}）：{exc}"
    payload += EOLS[eol_key]
    return payload, fmt, eol_key, ""


def build_payload(data: str, *, newline: bool = True, hex_: bool = False,
                  format: str | None = None, eol: str | None = None,
                  encoding: str | None = None) -> tuple[bytes, str]:
    """``resolve_payload`` 的旧签名薄封装：``(payload, error)``。

    保留它是为了 CLI / 旧调用方不用改；新代码请用 ``resolve_payload`` 拿
    解析后的 ``format``/``eol``（预览要显示它们）。
    """
    payload, _fmt, _eol, err = resolve_payload(
        data, newline=newline, hex_=hex_, format=format, eol=eol,
        encoding=encoding)
    return payload, err


def _roundtrip(cfg: Config, name: str, *, data: str, port: str = "", baud: int = 0,
               read_ms: int = DEFAULT_READ_MS, newline: bool = True,
               hex_: bool = False, format: str | None = None,
               eol: str | None = None, encoding: str | None = None,
               line=None, transport: str = "", net: dict | None = None,
               log=print) -> dict:
    """写一条出去、读一小段回显、关掉。返回值可直接 JSON 化。

    无论成功失败都返回**同一个形状**（``ok`` 区分），因为前端要渲染的字段一样 ——
    错误也应当带上 ``port``/``baud``，否则用户不知道"是发到哪个口失败了"。
    """
    try:
        read_ms = max(0, min(int(read_ms), 10000))     # 兜底夹取，防呆
    except (TypeError, ValueError):
        read_ms = DEFAULT_READ_MS

    payload, fmt, eol_key, perr = resolve_payload(
        data, newline=newline, hex_=hex_, format=format, eol=eol,
        encoding=encoding)
    res: dict = {
        "ok": False, "port": "", "baud": 0, "backend": "", "layer": "",
        "line": "", "line_text": "",
        "written": 0, "payload_bytes": 0, "echoed": [], "bytes_read": 0,
        "read_ms": read_ms, "elapsed_s": 0.0,
        "eol": EOLS.get(str(eol_key).lower(), b"").decode("ascii"),
        "format": fmt,
        "error": None,
    }

    if perr:
        res["error"] = perr
        return res
    if not payload:
        res["error"] = "内容为空 —— 没有可发送的字节"
        return res
    res["payload_bytes"] = len(payload)

    caps = sp.capabilities()
    res["layer"] = caps["layer"]

    t = tp.resolve(cfg, name, port=port, baud=baud, line=line,
                   transport=transport, net=net)
    # ★ 串口后端不可用只挡**串口传输**：网络传输（M4）不走 pyserial，
    #   在没有串口后端的机器上照样能用（例如 CI 里跑 TCP 回环）。
    if t.kind == "serial" and not caps["available"]:
        res["error"] = f"串口后端不可用（layer={caps['layer']}）：{caps.get('hint')}"
        return res
    res["port"], res["baud"], res["backend"] = t.label, t.baud, t.backend
    res["line"], res["line_text"] = t.line.as_dict(), t.line.text
    if t.errors:
        res["error"] = "传输配置不合法：" + "；".join(t.errors)
        return res
    if not t.label:
        res["error"] = t.reason
        return res

    if not _LOCK.acquire(timeout=_LOCK_WAIT_S):
        res["error"] = (f"另一个串口操作仍在进行（等了 {_LOCK_WAIT_S:g}s）—— "
                        f"串口是独占资源，请稍后重试")
        return res
    t0 = time.time()
    try:
        with tp.open(t, for_write=True) as s:
            res["backend"] = s.backend
            n = s.write(payload)
            res["written"] = n
            if n != len(payload):
                # 写了一半也算失败：半条命令对固件的解析器比不写更糟。
                res["error"] = (f"只写出 {n}/{len(payload)} 字节"
                                f"（写超时或流控阻塞）")
                return res
            log(f"[serialterm] → {t.label}@{t.baud} {t.line.text} 写出 {n} B，"
                f"收 {read_ms}ms 回显…")
            lines, total, buf = _drain(s, read_ms)
            if buf.strip():
                # 设备可能不发 \n（例如只回一个提示符）→ 残留也要带回去
                lines.append(buf.decode("utf-8", errors="replace").rstrip("\r"))
            res["echoed"], res["bytes_read"] = lines, total
            res["ok"] = True
            return res
    except OSError as exc:
        res["error"] = f"串口操作失败：{exc}"
        return res
    finally:
        res["elapsed_s"] = round(time.time() - t0, 3)
        _LOCK.release()


def _drain(s: "sp.SerialIO", read_ms: int) -> tuple[list[str], int, bytes]:
    """在 ``read_ms`` 窗口内尽量收行。返回 ``(完整行, 总字节, 未换行残留)``。"""
    deadline = time.time() + read_ms / 1000.0
    lines: list[str] = []
    buf = b""
    total = 0
    while time.time() < deadline:
        chunk = s.read(4096)
        if not chunk:
            time.sleep(0.01)
            continue
        total += len(chunk)
        buf += chunk
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            lines.append(raw.decode("utf-8", errors="replace").rstrip("\r"))
    return lines, total, buf


def roundtrip(cfg: Config, name: str, *, data: str, port: str = "", baud: int = 0,
              read_ms: int = DEFAULT_READ_MS, newline: bool = True,
              hex_: bool = False, format: str | None = None,
              eol: str | None = None, encoding: str | None = None,
              line=None, transport: str = "", net: dict | None = None,
              journal=None, log=print) -> dict:
    """`_roundtrip` + **可选落盘**（M3-b2）。

    ``journal(rec)`` 是调用方给的落盘回调 —— 本模块**不认识文件**，落到哪由调用方决定
    （驾驶舱与 CLI 指向**同一份** console 日志）。日志异常**不吞、但也不许改变主结果**：
    "日志没写成"不该让"命令已经发出去了"变成失败。
    """
    res = _roundtrip(cfg, name, data=data, port=port, baud=baud, read_ms=read_ms,
                     newline=newline, hex_=hex_, format=format, eol=eol,
                     encoding=encoding, line=line, transport=transport, net=net,
                     log=log)
    _journal(journal, res, data=data,
             hex_=(res.get("format") or "").lower() == "hex",
             newline=newline, log=log)
    return res


def _journal(journal, res: dict, *, data: str, hex_: bool, newline: bool,
             log=print) -> None:
    """把一次往返的结果落进 console 日志。

    ★ 从**结果**生成记录（而不是在 `_roundtrip` 内部插一堆回调）是有意的：
      无论成功失败、无论从哪条早退路径返回，都**恰好**落一对 (TX, RX*) ——
      不会漏，也不会因为将来多一条 `return` 就少记一笔。
    """
    if journal is None:
        return
    port, baud = res.get("port") or "", res.get("baud") or 0
    try:
        journal({"dir": "tx", "text": data, "ok": bool(res.get("ok")),
                 "written": res.get("written", 0),
                 "payload_bytes": res.get("payload_bytes", 0),
                 "hex": hex_, "newline": newline,
                 "port": port, "baud": baud, "error": res.get("error")})
        for line in res.get("echoed") or []:
            journal({"dir": "rx", "text": line, "ok": True,
                     "port": port, "baud": baud})
    except Exception as exc:                     # noqa: BLE001
        log(f"[serialterm] — 写 console 日志失败（不影响本次结果）：{exc}")


def render(res: dict) -> str:
    """CLI 版人读输出（``elab serial`` 用）。"""
    if not res.get("ok"):
        return (f"[serialterm] ✗ 发送失败：{res.get('error')}\n"
                f"            端口 {res.get('port') or '(未选到)'} / "
                f"backend={res.get('backend') or '-'}")
    L = [f"[serialterm] ✓ 已发送 {res['written']} B → "
         f"{res['port']}@{res['baud']}（backend={res['backend']}）"]
    if res["echoed"]:
        L.append(f"            收 {res['bytes_read']} B，{len(res['echoed'])} 行回显：")
        for ln in res["echoed"]:
            L.append(f"            ← {ln}")
    else:
        L.append(f"            窗口 {res['read_ms']}ms 内没有回显"
                 f"（设备不回应 → 正常；也可调大 --read-ms）")
    return "\n".join(L)
