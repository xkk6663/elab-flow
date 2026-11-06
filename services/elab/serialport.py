"""elab.serialport —— 串口后端：pyserial 优先 / ctypes 兜底 / 诚实降级。

设计（详见 docs/技术方案_闭环驾驶舱.md §18）
------------------------------------------
三层降级，任何一层可用都能跑，全不可用则**如实报告**而不是假装成功：

    L0  pyserial   若装了就用它（跨平台、最省心）
    L1  ctypes     Windows 上不依赖第三方，直接调 Win32 API（只读）
    L2  unavailable 两者皆无 → 调用方应把 monitor 判为 `inconclusive`（不是 `failed`）

`import serial` 是**惰性**的：没装 pyserial 的机器不会在 import 本模块时就炸。

Windows 选口规则（§16）
----------------------
    · 显式端口        → 直接用，**绝不静默改口**
    · auto + 唯一 USB → 选它
    · auto + 多个 USB → 报歧义，让人来选（不猜）
    · auto + 只有蓝牙 → 视为「没有可用串口」

判据是注册表 `HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM` 的**值**（设备路径）：
本机实测 `COM10 -> \\Device\\USBSER001`（USB CDC），而 `COM3..8 -> \\Device\\BthModem*`
（蓝牙虚拟口，必须排除 —— 否则 auto 会挑中一个永远没数据的口）。
"""

from __future__ import annotations

import re
import sys
import time
from dataclasses import dataclass

# ── 蓝牙虚拟口标记：出现在设备路径里即排除 ───────────────────────
_BT_MARKERS = ("BthModem", "BTHMODEM", "Bluetooth")
_USB_MARKERS = ("USBSER", "VCP", "CDC", "USB")

# 同一个 COM 号在注册表里可能有**多条残留映射**（拔插后旧的 \Device\USBSER000
# 不会立刻消失，新的 \Device\USBSER001 又加进来 —— 实测拔插一次即复现）。
# 去重时按可信度保留：usb > other > bluetooth。
_KIND_RANK = {"usb": 0, "other": 1, "bluetooth": 2}


def _kind_rank(kind: str) -> int:
    return _KIND_RANK.get(kind, 1)


@dataclass
class Port:
    name: str        # "COM10"
    device: str      # r"\Device\USBSER001"（ctypes 后端才有；pyserial 后端留空）
    kind: str        # usb | bluetooth | other
    desc: str = ""

    def __str__(self) -> str:
        d = f"  {self.desc}" if self.desc else (f"  {self.device}" if self.device else "")
        return f"{self.name} [{self.kind}]{d}"


# ── L0：pyserial（惰性加载，缓存结果）─────────────────────────────
_PS_LOADED = False
_PS_MOD = None
_PS_PORTS = None


def _pyserial():
    """返回 (serial 模块, list_ports 模块) 或 (None, None)。惰性 + 缓存。"""
    global _PS_LOADED, _PS_MOD, _PS_PORTS
    if not _PS_LOADED:
        _PS_LOADED = True
        try:
            import serial as _s
            import serial.tools.list_ports as _lp
            _PS_MOD, _PS_PORTS = _s, _lp
        except Exception:          # ImportError，或安装损坏 —— 都当「没有」
            _PS_MOD, _PS_PORTS = None, None
    return _PS_MOD, _PS_PORTS


# ── L1：ctypes / Win32 ───────────────────────────────────────────
def _win32():
    """惰性加载 kernel32 + winreg；非 Windows 或加载失败返回 (None, None)。"""
    if not sys.platform.startswith("win"):
        return None, None
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)

        k32.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        k32.CreateFileW.restype = wintypes.HANDLE
        k32.ReadFile.argtypes = [
            wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        k32.ReadFile.restype = wintypes.BOOL
        k32.WriteFile.argtypes = [
            wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        k32.WriteFile.restype = wintypes.BOOL
        k32.BuildCommDCBW.argtypes = [wintypes.LPCWSTR, wintypes.LPVOID]
        k32.BuildCommDCBW.restype = wintypes.BOOL
        k32.SetCommState.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
        k32.SetCommState.restype = wintypes.BOOL
        k32.SetCommTimeouts.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
        k32.SetCommTimeouts.restype = wintypes.BOOL
        k32.PurgeComm.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k32.PurgeComm.restype = wintypes.BOOL
        k32.EscapeCommFunction.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k32.EscapeCommFunction.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.CloseHandle.restype = wintypes.BOOL
        # 查"已到货多少字节"（SerialIO.in_waiting 的 ctypes 实现）。
        # COMSTAT 的第一个字段是一整块位域（1 个 DWORD），按 DWORD 传即可 ——
        # 我们只读 cbInQue，位域内容不看。
        k32.ClearCommError.argtypes = [wintypes.HANDLE, wintypes.LPDWORD, wintypes.LPVOID]
        k32.ClearCommError.restype = wintypes.BOOL

        import winreg
        return (ctypes, wintypes, k32, winreg), None
    except Exception as exc:       # pragma: no cover
        return None, str(exc)


def _ctypes_ports() -> list[Port]:
    """从注册表枚举串口，并用设备路径判 USB / 蓝牙。"""
    env, _err = _win32()
    if env is None:
        return []
    _ctypes, _wintypes, _k32, winreg = env
    out: dict[str, Port] = {}
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                             r"HARDWARE\DEVICEMAP\SERIALCOMM")
    except OSError:
        return []
    try:
        i = 0
        while True:
            try:
                val, data, _t = winreg.EnumValue(key, i)
            except OSError:
                break
            i += 1
            # ★ SERIALCOMM 是「设备名 → COM 号」的映射：
            #   值名 val = r"\Device\BthModem0"（设备路径），值数据 data = "COM3"。
            #   两者别搞反 —— 判 USB/蓝牙要看**设备路径**，选口要用 **COM 号**。
            dev = str(val)
            com = str(data)
            low = dev.lower()
            if any(m.lower() in low for m in _BT_MARKERS):
                kind = "bluetooth"
            elif any(m.lower() in low for m in _USB_MARKERS):
                kind = "usb"
            else:
                kind = "other"
            prev = out.get(com)
            if prev is None or _kind_rank(kind) < _kind_rank(prev.kind):
                out[com] = Port(name=com, device=dev, kind=kind)
    finally:
        winreg.CloseKey(key)
    return sorted(out.values(), key=lambda p: _com_sort(p.name))


def _com_sort(name: str):
    """COM10 要排在 COM9 之后（数值排序，不是字典序）。"""
    n = name.upper().removeprefix("COM")
    return (0, int(n)) if n.isdigit() else (1, name)


# ── 统一枚举 ─────────────────────────────────────────────────────
def list_ports() -> tuple[list[Port], str]:
    """返回 (端口列表, 后端名)。后端名 ∈ {pyserial, ctypes, none}。"""
    mod, lp = _pyserial()
    if mod is not None:
        try:
            dedup: dict[str, Port] = {}
            for p in lp.comports():
                dev = getattr(p, "device", p.name)
                desc = p.description or ""
                text = f"{dev} {desc}".lower()
                if any(m.lower() in text for m in _BT_MARKERS):
                    kind = "bluetooth"
                elif any(m.lower() in text for m in _USB_MARKERS):
                    kind = "usb"
                else:
                    kind = "other"
                prev = dedup.get(p.device)
                if prev is None or _kind_rank(kind) < _kind_rank(prev.kind):
                    dedup[p.device] = Port(name=p.device, device=dev, kind=kind, desc=desc)
            return sorted(dedup.values(), key=lambda p: _com_sort(p.name)), "pyserial"
        except Exception:
            pass                    # pyserial 坏了 → 退到 ctypes

    env, _err = _win32()
    if env is not None:
        return _ctypes_ports(), "ctypes"
    return [], "none"


def capabilities() -> dict:
    """能力探测（给 CLI / 未来的 cockpit `GET /api/capabilities` 用）。"""
    mod, _lp = _pyserial()
    env, err = _win32()
    layer = "L0" if mod is not None else ("L1" if env is not None else "L2")
    return {
        "pyserial": mod is not None,
        "pyserial_version": getattr(mod, "__version__", None) if mod else None,
        "win32_ctypes": env is not None,
        "win32_error": err,
        "layer": layer,
        "available": layer != "L2",
        # 线参数的默认与"哪些组合被支持"（面板只渲染，不写死业务名词）
        "line_defaults": LineConfig().as_dict(),
        "line_supported": {
            "pyserial": True,
            "ctypes": True,
            "note": "stop_bits=1.5 仅 data_bits=5；USB 转串口芯片可能按 1/2 取整",
        },
        "hint": (None if layer != "L2" else
                 "未安装 pyserial 且非 Windows：串口闭环不可用（monitor 会判 failed）。"
                 "安装：pip install pyserial"),
    }


def select_port(spec: str, ports: list[Port]) -> tuple[str, str, list[Port]]:
    """把 YAML 里的 `serial.port`（`auto` 或显式口）解析成具体端口。

    返回 (端口名或 "", 人类可读理由, 候选列表)。
    ★ 显式指定时**绝不**改成别的口 —— 宁可报错也不静默串到别的设备。
    """
    spec = (spec or "").strip()
    if spec and spec.lower() != "auto":
        hit = next((p for p in ports if p.name.lower() == spec.lower()), None)
        if hit:
            return hit.name, f"显式指定 {hit.name}（{hit.kind}）", [hit]
        return spec, (f"显式指定 {spec}（注册表中未枚举到，仍按指定使用 —— "
                      f"可能是驱动刚装、或设备未插）"), []

    usb = [p for p in ports if p.kind == "usb"]
    other = [p for p in ports if p.kind == "other"]
    bt = [p for p in ports if p.kind == "bluetooth"]
    cands = usb or other

    if len(cands) == 1:
        p = cands[0]
        note = f"auto → {p.name}（唯一的 {p.kind} 口）"
        if bt:
            note += f"；已排除 {len(bt)} 个蓝牙虚拟口"
        return p.name, note, cands
    if not cands:
        why = f"未发现可用串口（注册表里 {len(bt)} 个全是蓝牙虚拟口）" if bt else \
              "未发现任何串口（设备未插 / 驱动未装 / 被其它程序占用？）"
        return "", why, []
    return "", (f"auto 有歧义：发现 {len(cands)} 个候选 "
                f"{[p.name for p in cands]} —— 请在 YAML 里显式写 serial.port"), cands


# ── 线参数（数据位 / 校验 / 停止位 / 流控）─────────────────────────
#: 规范名 → DCB / pyserial 的单字母映射。
PARITIES = ("none", "even", "odd", "mark", "space")
_PARITY_CHAR = {"none": "N", "even": "E", "odd": "O", "mark": "M", "space": "S"}
STOP_BITS = (1.0, 1.5, 2.0)
FLOWS = ("none", "rtscts", "xonxoff", "dsrdtr")

#: 八个字节宽度（``5N1.5`` 这类文本形式的解析）。停止位允许 ``1.5``。
_LINE_TEXT_RE = re.compile(r"^([5-8])([NEOMS])(1\.5|1|2)(?:[-:/]([A-Z]+))?$")


@dataclass(frozen=True)
class LineConfig:
    """一条串口的线参数。默认 ``8N1`` = 今天的行为（缺省零回归）。"""

    data_bits: int = 8
    parity: str = "none"
    stop_bits: float = 1.0
    flow: str = "none"

    @property
    def parity_char(self) -> str:
        return _PARITY_CHAR.get(self.parity, "N")

    @property
    def text(self) -> str:
        """``8N1`` / ``7E1`` / ``5N1.5`` —— UI 与会话快照都显示这个。"""
        return f"{self.data_bits}{self.parity_char}{self.stop_bits:g}"

    def as_dict(self) -> dict:
        return {"data_bits": self.data_bits, "parity": self.parity,
                "stop_bits": self.stop_bits, "flow": self.flow,
                "text": self.text}

    def pyserial_kwargs(self) -> dict:
        """通过给 pyserial 的构造参数（`Serial` / `serial_for_url` 都认）。"""
        return {
            "bytesize": self.data_bits,
            "parity": self.parity_char,
            "stopbits": self.stop_bits,
            "rtscts": self.flow == "rtscts",
            "xonxoff": self.flow == "xonxoff",
            "dsrdtr": self.flow == "dsrdtr",
        }

    def dcb_tokens(self, baud: int) -> str:
        """``BuildCommDCBW`` 的基础串。流控开关不在串里，见 `_apply_dcb_flags`。"""
        return (f"baud={baud} parity={self.parity_char} "
                f"data={self.data_bits} stop={self.stop_bits:g}")


def line_config(raw=None) -> tuple[LineConfig, list[str]]:
    """解析线参数（``None`` / ``"8N1"`` / 映射）→ ``(cfg, errors)``。

    接受两种写法，缺省都是 ``8N1``：

        line: 7E1                       # 文本：数据位+校验+停止位，可带 `:rtscts`
        line: {data_bits: 7, parity: even, stop_bits: 1, flow: none}

    错误**一次性列出**（不静默吞掉拼写错误）；调用方必须在 ``errors`` 非空时拒绝开户。
    """
    errors: list[str] = []
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return LineConfig(), errors

    if isinstance(raw, LineConfig):
        # ★ 接受解析结果本身：`Target.line` 在重连时会被原样传回来。
        raw = {"data_bits": raw.data_bits, "parity": raw.parity,
               "stop_bits": raw.stop_bits, "flow": raw.flow}

    if isinstance(raw, str):
        s = raw.strip().upper().replace(" ", "")
        m = _LINE_TEXT_RE.match(s)
        if not m:
            return LineConfig(), [f"无法解析线参数 {raw!r}（应形如 8N1 / 7E1 / 5N1.5，"
                                  f"流控可加 :rtscts）"]
        cfg = LineConfig(int(m.group(1)), _parity_name(m.group(2)),
                         float(m.group(3)),
                         (m.group(4) or "none").lower())
    elif isinstance(raw, dict):
        data_bits = _as_int(raw, ("data_bits", "data", "databits", "bytesize"),
                            8, errors)
        parity = _parity_name(str(raw.get("parity", "none") or "none").lower(),
                              errors)
        stop_bits = _as_float(raw, ("stop_bits", "stop", "stopbits"), 1.0, errors)
        flow = str(raw.get("flow") or raw.get("flowcontrol") or "none").lower()
        known = {"data_bits", "data", "databits", "bytesize", "parity",
                 "stop_bits", "stop", "stopbits", "flow", "flowcontrol",
                 # `as_dict()` 的往返字段：派生值，不是输入
                 "text"}
        for k in raw:
            if str(k).lower() not in known:
                errors.append(f"未知线参数字段：{k!r}")
        cfg = LineConfig(data_bits, parity, stop_bits, flow)
    else:
        return LineConfig(), [f"线参数必须是字符串或映射，收到 {type(raw).__name__}"]

    if cfg.data_bits not in (5, 6, 7, 8):
        errors.append(f"data_bits={cfg.data_bits!r} 非法（可选 5/6/7/8）")
    if cfg.parity not in PARITIES:
        errors.append(f"parity={cfg.parity!r} 非法（可选 {'/'.join(PARITIES)}）")
    if cfg.stop_bits not in STOP_BITS:
        errors.append(f"stop_bits={cfg.stop_bits!r} 非法（可选 1/1.5/2）")
    if cfg.stop_bits == 1.5 and cfg.data_bits != 5:
        errors.append("stop_bits=1.5 只能配 data_bits=5（Win32 DCB 限制）")
    if cfg.flow not in FLOWS:
        errors.append(f"flow={cfg.flow!r} 非法（可选 {'/'.join(FLOWS)}）")
    return cfg, errors


def _parity_name(ch: str, errors: list[str] | None = None) -> str:
    """``N/E/O/M/S`` 或规范名（``even``…）→ 规范名；非法时记一条错误并回 ``none``。"""
    s = (ch or "none").strip().lower()
    if s in PARITIES:
        return s
    upper = s.upper()
    for name, letter in _PARITY_CHAR.items():
        if upper == letter:
            return name
    if errors is not None:
        errors.append(f"parity={ch!r} 非法（可选 N/E/O/M/S 或 {'/'.join(PARITIES)}）")
    return "none"


def _as_int(raw: dict, keys: tuple[str, ...], default: int,
            errors: list[str]) -> int:
    for k in keys:
        if k in raw:
            try:
                return int(raw[k])
            except (TypeError, ValueError):
                errors.append(f"{k}={raw[k]!r} 不是整数")
                return default
    return default


def _as_float(raw: dict, keys: tuple[str, ...], default: float,
              errors: list[str]) -> float:
    for k in keys:
        if k in raw:
            try:
                return float(raw[k])
            except (TypeError, ValueError):
                errors.append(f"{k}={raw[k]!r} 不是数字")
                return default
    return default


# DCB flags（Win32 DCB 结构偏移 8 的那个 DWORD）。
_F_PARITY = 1 << 1
_F_OUTXCTSFLOW = 1 << 2
_F_OUTXDSRFLOW = 1 << 3
_F_DTRCONTROL_MASK = 3 << 4
_F_DTRCONTROL_HANDSHAKE = 2 << 4
_F_DSRSENSITIVITY = 1 << 6
_F_OUTX = 1 << 8
_F_INX = 1 << 9
_F_RTSCONTROL_MASK = 3 << 12
_F_RTSCONTROL_HANDSHAKE = 2 << 12


def _apply_dcb_flags(dcb, line: LineConfig) -> None:
    """把流控/校验位写进 DCB 的 flags 字段。

    ``BuildCommDCBW`` 只填基础串（波特率/数据位/校验/停止位）；流控开关不在
    它的字符串语法里，所以这里按 DCB 的位域补 —— 比手写整份 DCB 位域安全，
    因为基础部分仍由系统解析，我们只动已知的几个位。
    """
    import ctypes

    flags = ctypes.c_uint32.from_buffer(dcb, 8)
    v = flags.value
    v &= ~(_F_PARITY | _F_OUTXCTSFLOW | _F_OUTXDSRFLOW | _F_DSRSENSITIVITY
           | _F_OUTX | _F_INX)
    if line.parity != "none":
        v |= _F_PARITY
    if line.flow == "rtscts":
        v |= _F_OUTXCTSFLOW
        v = (v & ~_F_RTSCONTROL_MASK) | _F_RTSCONTROL_HANDSHAKE
    elif line.flow == "xonxoff":
        v |= _F_OUTX | _F_INX
    elif line.flow == "dsrdtr":
        v |= _F_OUTXDSRFLOW | _F_DSRSENSITIVITY
        v = (v & ~_F_DTRCONTROL_MASK) | _F_DTRCONTROL_HANDSHAKE
    flags.value = v


# ── 传输断开（与普通 IO 错误分开：M2 的重连要靠它判断"该不该重开"）────
class TransportLost(OSError):
    """链路已断（拔线 / 驱动卸载 / 端口被抢），而不是"暂时没数据"。"""

    def __init__(self, message: str, *, code: int | None = None,
                 backend: str = ""):
        super().__init__(message)
        self.code = code
        self.backend = backend


#: ReadFile 失败里属于"链路没了"的 GetLastError。
_LOST_ERRORS = {
    5,      # ERROR_ACCESS_DENIED（口被别的进程抢走 / 设备卸下）
    6,      # ERROR_INVALID_HANDLE
    22,     # ERROR_BAD_COMMAND
    31,     # ERROR_GEN_FAILURE
    995,    # ERROR_OPERATION_ABORTED
    1117,   # ERROR_IO_DEVICE（USB 转串口拔线最常见）
    1167,   # ERROR_DEVICE_NOT_CONNECTED
    1617,   # ERROR_DEVICE_REMOVED
}


# ── 端口占用恢复（约束 N5：openocd 与 DAP-Link 虚拟串口互斥）────────
def _instance_id_for_com(com: str) -> str:
    """在注册表里找 ``PortName == com`` 的 USB 设备实例 ID。

    形如 ``USB\\VID_2E88&PID_0003\\6&1a2b3c4d&0&1`` —— pnputil /restart-device 要的就是它。
    """
    env, _e = _win32()
    if env is None:
        return ""
    _ctypes, _wintypes, _k32, winreg = env
    want = com.upper()
    try:
        bus = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                             r"SYSTEM\CurrentControlSet\Enum\USB")
    except OSError:
        return ""
    try:
        i = 0
        while True:
            try:
                vidpid = winreg.EnumKey(bus, i)
            except OSError:
                break
            i += 1
            try:
                vk = winreg.OpenKey(bus, vidpid)
            except OSError:
                continue
            try:
                j = 0
                while True:
                    try:
                        inst = winreg.EnumKey(vk, j)
                    except OSError:
                        break
                    j += 1
                    try:
                        dk = winreg.OpenKey(vk, inst + r"\Device Parameters")
                    except OSError:
                        continue
                    try:
                        pn, _t = winreg.QueryValueEx(dk, "PortName")
                        if str(pn).upper() == want:
                            return rf"USB\{vidpid}\{inst}"
                    except OSError:
                        pass
                    finally:
                        winreg.CloseKey(dk)
            finally:
                winreg.CloseKey(vk)
    finally:
        winreg.CloseKey(bus)
    return ""


def restart_device(com: str, *, log=print) -> tuple[bool, str]:
    """尽力做一次「软插拔」（等价于拔插一次 DAP-Link）。

    用 ``pnputil /restart-device <实例ID>`` —— **需要管理员权限**。
    失败时返回可操作的提示，而不是假装成功（管理权限拿不到是常态，
    那就老实说"请拔插"）。
    """
    inst = _instance_id_for_com(com)
    if not inst:
        return False, f"注册表里找不到 {com} 对应的 USB 实例 ID，无法软复位"
    log(f"[serial] 尝试软复位 {com}（实例 {inst}）…")
    try:
        import subprocess
        from ._winproc import proc_kwargs
        r = subprocess.run(["pnputil", "/restart-device", inst],
                           capture_output=True, text=True, timeout=30,
                           errors="replace", **proc_kwargs())
    except FileNotFoundError:
        return False, "本机没有 pnputil，无法软复位（请拔插一次 DAP-Link）"
    except Exception as exc:                      # pragma: no cover
        return False, f"调用 pnputil 失败：{exc}"
    out = ((r.stdout or "") + (r.stderr or "")).strip().replace("\n", " ")
    if r.returncode == 0:
        return True, f"已重启设备：{inst}"
    return False, (f"pnputil 退出码 {r.returncode}：{out[:300]}"
                   f" —— 该操作通常需要管理员权限；拿不到就拔插一次 DAP-Link")


def diagnose_denied(com: str) -> str:
    """ACCESS_DENIED 时的可操作提示（把 N5 讲清楚，别只说"占用中"）。"""
    return (f"打开 {com} 被拒（ERROR_ACCESS_DENIED）。两种常见原因：\n"
            f"          · DAP-Link/AT-Link 是**复合 USB 设备** —— openocd 占着 SWD 调试接口时，\n"
            f"            它的虚拟串口会被独占（约束 N5）。确认没有 openocd/gdb 残留进程。\n"
            f"          · 设备处于残留状态 —— 拔插一次 DAP-Link，或试 `elab monitor --reset-port`。")


def _open_error(com: str, err: int) -> str:
    """按 ``GetLastError`` 给**对症**的提示。

    ★ 必须区分错误码：原实现无条件拼上 `diagnose_denied()`，于是"COM 号写错/设备没插"
      （``ERROR_FILE_NOT_FOUND=2``）被报成"被 openocd 占用"—— 用户会照着错误提示去
      杀进程、拔插，而真正的问题是端口名。**错误提示指错方向比不提示更坏。**
    """
    head = f"CreateFileW(\\\\.\\{com}) 失败，GetLastError={err}"
    if err == 2:      # ERROR_FILE_NOT_FOUND
        return (f"{head}（ERROR_FILE_NOT_FOUND）\n"
                f"          {com} **不存在** —— 端口名写错了？设备没插？"
                f"拔插过（重新枚举后 COM 号会变）？")
    if err == 5:      # ERROR_ACCESS_DENIED
        return f"{head}（ERROR_ACCESS_DENIED）\n          " + diagnose_denied(com)
    return head


# ── 开一个口：统一 read/close 接口 ────────────────────────────────
class SerialIO:
    """串口 IO。**默认只读**（monitor 的语义）；``for_write=True`` 才请求写权限。

    ★ 为什么默认只读：monitor 是"旁观者"，只读能减少对目标的影响；而**写权限**
      意味着我们**有能力**打断固件 —— 那必须是一个**显式决定**，不该是顺手就有的
      能力。用法：``with SerialIO(p, 115200, for_write=True) as s: s.write(b"help\\r\\n")``

    优先 pyserial，退到 ctypes（约束 N5 的三层降级见模块 docstring）。
    """

    def __init__(self, port: str, baud: int = 115200, *, for_write: bool = False,
                 line: LineConfig | None = None):
        self.port = port
        self.baud = baud
        self.for_write = for_write
        self.line = line or LineConfig()
        self.backend = ""
        self._h = None
        self._ser = None

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def open(self, *, attempts: int = 4, delay: float = 0.6) -> None:
        if not self.port:
            raise OSError("端口名为空 —— 请先用 select_port() 把 serial.port 解析成具体 COM 号")
        mod, _lp = _pyserial()
        if mod is not None:
            # ★ 写超时必须给上限（与下面 ctypes 路径的 WriteTotalTimeout 逐字一致）。
            #   只读实例不需要；而**可写实例**一旦撞上"口还在、链路已经没了"
            #   （拔线、蓝牙 SPP 未连接），pyserial 的 write 会一直阻塞 —— 实测
            #   直接把 HTTP 请求挂死 10s+，界面表现为"点发送毫无反应"。
            wt = 2.0 if self.for_write else None
            # pyserial 的 **URL 端口**（loop://、socket:// 等）只能走 serial_for_url，
            # Serial() 不认。支持它的唯一目的是无硬件自测：loop:// 把写出的字节原样
            # 回读成 RX，整条数据面（TX 入环 / RX 投影 / 解码）都能端到端跑，不必为
            # 测试在生产代码里开特判分支。
            if "://" in self.port:
                self._ser = mod.serial_for_url(
                    self.port, self.baud, timeout=0.2, write_timeout=wt,
                    **self.line.pyserial_kwargs())
            else:
                self._ser = mod.Serial(
                    self.port, self.baud, timeout=0.2, write_timeout=wt,
                    **self.line.pyserial_kwargs())
            self.backend = "pyserial"
            return
        env, err = _win32()
        if env is None:
            raise OSError(f"无法打开串口：本机既无 pyserial 也无 Win32 后端（{err}）")
        ctypes, wintypes, k32, _winreg = env
        GENERIC_READ, GENERIC_WRITE = 0x80000000, 0x40000000
        OPEN_EXISTING, INVALID = 3, ctypes.c_void_p(-1).value
        # 只有显式声明写意图才申请 GENERIC_WRITE —— 见类 docstring。
        access = GENERIC_READ | (GENERIC_WRITE if self.for_write else 0)
        # ERROR_ACCESS_DENIED = 5：刚跑完 openocd 时设备句柄可能还没释放完，
        # 短暂重试几次通常就好了 —— 直接报错对用户太不友好，死等又太蠢，折中。
        for k in range(max(1, attempts)):
            h = k32.CreateFileW(f"\\\\.\\{self.port}", access, 0, None,
                                OPEN_EXISTING, 0, None)
            if h != INVALID:
                break
            if ctypes.get_last_error() != 5 or k == attempts - 1:
                break
            time.sleep(delay)
        if h == INVALID:
            raise OSError(_open_error(self.port, ctypes.get_last_error()))
        # ★ 用 BuildCommDCBW 从字符串填 DCB，避免手写脆弱的位域布局；
        #   我们只需把 DCB 当不透明缓冲传下去（sizeof(DCB)=28，给 64 足够）。
        dcb = ctypes.create_string_buffer(64)
        if not k32.BuildCommDCBW(self.line.dcb_tokens(self.baud), dcb):
            k32.CloseHandle(h)
            raise OSError("BuildCommDCBW 失败：串口参数非法"
                          f"（{self.line.dcb_tokens(self.baud)}）")
        _apply_dcb_flags(dcb, self.line)
        if not k32.SetCommState(h, dcb):
            k32.CloseHandle(h)
            raise OSError(f"SetCommState 失败，GetLastError={ctypes.get_last_error()}")
        # COMMTIMEOUTS 恰好 5 个 DWORD，无填充
        to = (wintypes.DWORD * 5)()
        to[0] = 50        # ReadIntervalTimeout
        to[1] = 0         # ReadTotalTimeoutMultiplier
        to[2] = 200       # ReadTotalTimeoutConstant（阻塞上限 200ms）
        # ★ 写超时：0/0 = 无上限，WriteFile 会一直阻塞到写完或出错。写通道是
        #   交互式的（用户正等着回显），**卡死比报错更糟** → 给 2s 上限。
        to[3] = 0         # WriteTotalTimeoutMultiplier
        to[4] = 2000 if self.for_write else 0   # WriteTotalTimeoutConstant
        if not k32.SetCommTimeouts(h, to):
            k32.CloseHandle(h)
            raise OSError(f"SetCommTimeouts 失败，GetLastError={ctypes.get_last_error()}")
        k32.PurgeComm(h, 0x0008 | 0x0004)   # PURGE_TXCLEAR | PURGE_RXCLEAR
        self._h = h
        self.backend = "ctypes"

    @property
    def in_waiting(self) -> int | None:
        """内核里**已经到货**多少字节；``None`` = 这个后端问不出来。

        ★ 为什么需要它（实测 298ms → 40ms）：pyserial 的 ``read(n)`` 语义是
          "凑够 n 个字节或超时"，不是"有多少给多少"。读线程用 ``read(4096)``
          时，一帧 11 字节的回包必须**再等满 200ms 超时**才返回 —— 在 Modbus
          这种"一问一答、下一问要等上一答"的协议里，那就是每条事务 +200ms。
          有了这个数，读线程可以"先问有多少，再按数读"，回包到手即返回。
        """
        ser = self._ser
        if ser is not None:
            try:
                return int(getattr(ser, "in_waiting", 0) or 0)
            except Exception:            # noqa: BLE001 —— 问不出来就当没有这能力
                return None
        if self._h is None:
            return None
        # ctypes 后端：ClearCommError 顺手带回 COMSTAT.cbInQue（输入队列字节数）。
        # 不查它的话，ReadFile 会在**收到 11 字节后继续等满 200ms** 超时：
        # 一问一答的协议为此每次都白等一个读超时。
        import ctypes
        from ctypes import wintypes
        env, _e = _win32()
        if env is None:
            return None
        _ctypes, _wintypes, k32, _winreg = env

        class _COMSTAT(ctypes.Structure):
            _fields_ = [("flags", wintypes.DWORD), ("cbInQue", wintypes.DWORD),
                        ("cbOutQue", wintypes.DWORD)]

        stat = _COMSTAT()
        errs = wintypes.DWORD(0)
        if not k32.ClearCommError(self._h, ctypes.byref(errs), ctypes.byref(stat)):
            return None
        return int(stat.cbInQue)

    def read(self, n: int = 4096) -> bytes:
        if self._ser is not None:
            # ★ 读异常**不能吞成 b""**：拔线后那和"200ms 没数据"不可区分，
            #   读线程会永远安静地空转（M2 的重连也就永远等不到触发条件）。
            try:
                return self._ser.read(n) or b""
            except Exception as exc:          # noqa: BLE001
                raise TransportLost(
                    f"{self.port} 读取失败（{type(exc).__name__}: {exc}）",
                    backend="pyserial") from exc
        if self._h is None:
            return b""
        import ctypes
        from ctypes import wintypes
        _env, _e = _win32()
        if _env is None:
            return b""
        _ctypes, _wintypes, k32, _winreg = _env
        buf = ctypes.create_string_buffer(n)
        got = wintypes.DWORD(0)
        if not k32.ReadFile(self._h, buf, n, ctypes.byref(got), None):
            err = ctypes.get_last_error()
            if err in _LOST_ERRORS:
                raise TransportLost(
                    f"{self.port} 链路已断开（GetLastError={err}）",
                    code=err, backend="ctypes")
            raise OSError(f"{self.port} 读取失败，GetLastError={err}")
        return buf.raw[:got.value]

    def write(self, data: bytes) -> int:
        """写字节，返回**实际写出**的字节数（写失败返回 0，不抛）。

        ★ 只读打开的实例**拒绝**写：pyserial 后端天然可写，若不加这道闸门，
          "只读"就只是个口号 —— 一次笔误就能把数据发给固件。
        """
        if not self.for_write:
            raise OSError("SerialIO 以只读方式打开（for_write=False）—— "
                          "写入必须显式声明写意图")
        if not data:
            return 0
        if self._ser is not None:
            # 契约是"写失败返回 0，不抛"：写超时（SerialTimeoutException）与
            # 链路断开（SerialException）都必须落在这条分支上，让 HTTP 层能
            # 如实回 `ok:false` —— 而不是把异常抛给请求线程。
            try:
                n = self._ser.write(data)
            except Exception:                 # noqa: BLE001
                return 0
            return int(n or 0)
        if self._h is None:
            return 0
        import ctypes
        from ctypes import wintypes
        env, _e = _win32()
        if env is None:
            return 0
        _ctypes, _wintypes, k32, _winreg = env
        buf = ctypes.create_string_buffer(bytes(data), len(data))
        put = wintypes.DWORD(0)
        if not k32.WriteFile(self._h, buf, len(data), ctypes.byref(put), None):
            return 0
        return int(put.value)

    # EscapeCommFunction 的功能码（Win32 API 常量）
    _SETDTR, _CLRDTR, _SETRTS, _CLRRTS = 6, 5, 8, 7

    def set_control(self, dtr: bool | None = None,
                    rts: bool | None = None) -> dict:
        """设置 DTR / RTS（``None`` = 保持原状）。返回结构化结果。

        ★ 这是**物理线路动作**：不进字节环、不算 TX（证据纪律见方案 §4.2）。
        ``applied`` 尽量回读**实际值**（pyserial 可回读；ctypes 只能回显请求值，
        故用 ``verified: false`` 明说"没有回读验证"，而不是假装确认过）。
        """
        if self._ser is not None:
            try:
                if dtr is not None:
                    self._ser.dtr = bool(dtr)
                if rts is not None:
                    self._ser.rts = bool(rts)
                applied = {"dtr": bool(self._ser.dtr), "rts": bool(self._ser.rts)}
                return {"ok": True, "applied": applied, "backend": "pyserial",
                        "verified": True}
            except Exception as exc:              # noqa: BLE001
                return {"ok": False, "backend": "pyserial", "verified": False,
                        "error": f"{type(exc).__name__}: {exc}"}
        if self._h is None:
            return {"ok": False, "error": "端口尚未打开"}
        env, _e = _win32()
        if env is None:
            return {"ok": False, "error": "本机没有 Win32 串口后端"}
        import ctypes
        _ctypes, _wintypes, k32, _winreg = env
        applied: dict = {}
        failed = ""
        for key, value, codes in (("dtr", dtr, (self._SETDTR, self._CLRDTR)),
                                  ("rts", rts, (self._SETRTS, self._CLRRTS))):
            if value is None:
                continue
            if not k32.EscapeCommFunction(self._h, codes[0 if value else 1]):
                failed = f"{key.upper()} 设置失败，GetLastError={ctypes.get_last_error()}"
                break
            applied[key] = bool(value)
        return ({"ok": False, "applied": applied, "backend": "ctypes",
                 "verified": False, "error": failed} if failed else
                {"ok": True, "applied": applied, "backend": "ctypes",
                 "verified": False})

    def close(self) -> None:
        if self._ser is not None:
            try:
                self._ser.close()
            finally:
                self._ser = None
        if self._h is not None:
            env, _e = _win32()
            if env is not None:
                env[2].CloseHandle(self._h)
            self._h = None
