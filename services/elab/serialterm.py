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

import threading
import time

from . import serialport as sp
from .config import Config

#: 写完之后收回显的默认窗口（ms）。理由见模块 docstring。
DEFAULT_READ_MS = 600
#: 写出去时附加的行结束符。串口 CLI 普遍认 CR，Windows 终端惯例是 CRLF。
DEFAULT_EOL = "\r\n"

#: 进程内串行锁：一次只允许一个往返持有串口。
#: ★ 跨进程的互斥（与 `elab run` 的 monitor 步骤）由 **调用方**负责 —— 本模块不
#:   认识 run 概念，让它去查 RunManager 是把"传输"和"调度"焊死。
_LOCK = threading.Lock()
#: 等锁上限（s）。拿不到说明"有人在用串口"，**报错比排队好**：
#: 排队会让用户以为自己的操作被吞了。
_LOCK_WAIT_S = 2.0


def resolve_target(cfg: Config, name: str, *, port: str = "",
                   baud: int = 0) -> dict:
    """解析出「这条命令发给谁」。

    返回 ``{spec, port, baud, reason, backend, ports}``；``port`` 为空表示选不出来
    （理由在 ``reason`` 里，**不猜**）。
    """
    proj = cfg.resolved_project(name) if name else {}
    ser = (proj.get("serial") or {}) if isinstance(proj, dict) else {}
    host_ser = (cfg.host or {}).get("serial") or {}

    spec = port or ser.get("port") or host_ser.get("default") or "auto"
    try:
        b = int(baud or ser.get("baud") or host_ser.get("baud") or 115200)
    except (TypeError, ValueError):
        b = 115200

    ports, backend = sp.list_ports()
    chosen, why, _cands = sp.select_port(spec, ports)
    return {"spec": spec, "port": chosen, "baud": b, "reason": why,
            "backend": backend, "ports": ports}


def build_payload(data: str, *, newline: bool = True, hex_: bool = False
                  ) -> tuple[bytes, str]:
    """把用户输入编成待发字节。返回 ``(payload, error)``；``error`` 非空即失败。

    ``hex_`` 模式下按十六进制解析（``"01 A0 FF"`` 与 ``"01A0FF"`` 都收），
    此时**不加**行结束符 —— 发的是二进制帧，多一个 CR 就是多一个字节。

    ★ 空输入**先于**加行结束符判定：否则 ``""`` 会变成 ``b"\\r\\n"`` 被当成有效
      载荷发出去（一个"空回车"照样能打断固件的行解析器）。
    """
    if not (data or "").strip():
        return b"", "内容为空 —— 没有可发送的字节"
    if hex_:
        try:
            return bytes.fromhex("".join((data or "").split())), ""
        except ValueError as exc:
            return b"", f"不是合法十六进制（{exc}）：{data!r}"
    payload = (data or "").encode("utf-8")
    if newline:
        payload += DEFAULT_EOL.encode("utf-8")
    return payload, ""


def _roundtrip(cfg: Config, name: str, *, data: str, port: str = "", baud: int = 0,
               read_ms: int = DEFAULT_READ_MS, newline: bool = True,
               hex_: bool = False, log=print) -> dict:
    """写一条出去、读一小段回显、关掉。返回值可直接 JSON 化。

    无论成功失败都返回**同一个形状**（``ok`` 区分），因为前端要渲染的字段一样 ——
    错误也应当带上 ``port``/``baud``，否则用户不知道"是发到哪个口失败了"。
    """
    try:
        read_ms = max(0, min(int(read_ms), 10000))     # 兜底夹取，防呆
    except (TypeError, ValueError):
        read_ms = DEFAULT_READ_MS

    res: dict = {
        "ok": False, "port": "", "baud": 0, "backend": "", "layer": "",
        "written": 0, "payload_bytes": 0, "echoed": [], "bytes_read": 0,
        "read_ms": read_ms, "elapsed_s": 0.0,
        "eol": DEFAULT_EOL if (newline and not hex_) else "",
        "error": None,
    }

    payload, perr = build_payload(data, newline=newline, hex_=hex_)
    if perr:
        res["error"] = perr
        return res
    if not payload:
        res["error"] = "内容为空 —— 没有可发送的字节"
        return res
    res["payload_bytes"] = len(payload)

    caps = sp.capabilities()
    res["layer"] = caps["layer"]
    if not caps["available"]:
        res["error"] = f"串口后端不可用（layer={caps['layer']}）：{caps.get('hint')}"
        return res

    t = resolve_target(cfg, name, port=port, baud=baud)
    res["port"], res["baud"], res["backend"] = t["port"], t["baud"], t["backend"]
    if not t["port"]:
        res["error"] = t["reason"]
        return res

    if not _LOCK.acquire(timeout=_LOCK_WAIT_S):
        res["error"] = (f"另一个串口操作仍在进行（等了 {_LOCK_WAIT_S:g}s）—— "
                        f"串口是独占资源，请稍后重试")
        return res
    t0 = time.time()
    try:
        with sp.SerialIO(t["port"], t["baud"], for_write=True) as s:
            res["backend"] = s.backend
            n = s.write(payload)
            res["written"] = n
            if n != len(payload):
                # 写了一半也算失败：半条命令对固件的解析器比不写更糟。
                res["error"] = (f"只写出 {n}/{len(payload)} 字节"
                                f"（写超时或流控阻塞）")
                return res
            log(f"[serialterm] → {t['port']}@{t['baud']} 写出 {n} B，"
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
              hex_: bool = False, journal=None, log=print) -> dict:
    """`_roundtrip` + **可选落盘**（M3-b2）。

    ``journal(rec)`` 是调用方给的落盘回调 —— 本模块**不认识文件**，落到哪由调用方决定
    （驾驶舱与 CLI 指向**同一份** console 日志）。日志异常**不吞、但也不许改变主结果**：
    "日志没写成"不该让"命令已经发出去了"变成失败。
    """
    res = _roundtrip(cfg, name, data=data, port=port, baud=baud, read_ms=read_ms,
                     newline=newline, hex_=hex_, log=log)
    _journal(journal, res, data=data, hex_=hex_, newline=newline, log=log)
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
