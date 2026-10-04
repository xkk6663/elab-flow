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
        k32.BuildCommDCBW.argtypes = [wintypes.LPCWSTR, wintypes.LPVOID]
        k32.BuildCommDCBW.restype = wintypes.BOOL
        k32.SetCommState.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
        k32.SetCommState.restype = wintypes.BOOL
        k32.SetCommTimeouts.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
        k32.SetCommTimeouts.restype = wintypes.BOOL
        k32.PurgeComm.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k32.PurgeComm.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.CloseHandle.restype = wintypes.BOOL

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
        "hint": (None if layer != "L2" else
                 "未安装 pyserial 且非 Windows：串口闭环不可用（monitor 会判 inconclusive）。"
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
        r = subprocess.run(["pnputil", "/restart-device", inst],
                           capture_output=True, text=True, timeout=30,
                           errors="replace")
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


# ── 开一个口：统一 read/close 接口 ────────────────────────────────
class SerialIO:
    """只读串口。优先 pyserial，退到 ctypes。用法：``with SerialIO(p, 115200) as s``"""

    def __init__(self, port: str, baud: int = 115200):
        self.port = port
        self.baud = baud
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
            self._ser = mod.Serial(self.port, self.baud, timeout=0.2)
            self.backend = "pyserial"
            return
        env, err = _win32()
        if env is None:
            raise OSError(f"无法打开串口：本机既无 pyserial 也无 Win32 后端（{err}）")
        ctypes, wintypes, k32, _winreg = env
        GENERIC_READ, OPEN_EXISTING, INVALID = 0x80000000, 3, ctypes.c_void_p(-1).value
        # ERROR_ACCESS_DENIED = 5：刚跑完 openocd 时设备句柄可能还没释放完，
        # 短暂重试几次通常就好了 —— 直接报错对用户太不友好，死等又太蠢，折中。
        for k in range(max(1, attempts)):
            h = k32.CreateFileW(f"\\\\.\\{self.port}", GENERIC_READ, 0, None,
                                OPEN_EXISTING, 0, None)
            if h != INVALID:
                break
            if ctypes.get_last_error() != 5 or k == attempts - 1:
                break
            time.sleep(delay)
        if h == INVALID:
            raise OSError(f"CreateFileW(\\\\.\\{self.port}) 失败，"
                          f"GetLastError={ctypes.get_last_error()}\n          "
                          + diagnose_denied(self.port))
        # ★ 用 BuildCommDCBW 从字符串填 DCB，避免手写脆弱的位域布局；
        #   我们只需把 DCB 当不透明缓冲传下去（sizeof(DCB)=28，给 64 足够）。
        dcb = ctypes.create_string_buffer(64)
        if not k32.BuildCommDCBW(f"baud={self.baud} parity=N data=8 stop=1", dcb):
            k32.CloseHandle(h)
            raise OSError("BuildCommDCBW 失败：串口参数非法")
        if not k32.SetCommState(h, dcb):
            k32.CloseHandle(h)
            raise OSError(f"SetCommState 失败，GetLastError={ctypes.get_last_error()}")
        # COMMTIMEOUTS 恰好 5 个 DWORD，无填充
        to = (wintypes.DWORD * 5)()
        to[0] = 50        # ReadIntervalTimeout
        to[1] = 0         # ReadTotalTimeoutMultiplier
        to[2] = 200       # ReadTotalTimeoutConstant（阻塞上限 200ms）
        if not k32.SetCommTimeouts(h, to):
            k32.CloseHandle(h)
            raise OSError(f"SetCommTimeouts 失败，GetLastError={ctypes.get_last_error()}")
        k32.PurgeComm(h, 0x0008 | 0x0004)   # PURGE_TXCLEAR | PURGE_RXCLEAR
        self._h = h
        self.backend = "ctypes"

    def read(self, n: int = 4096) -> bytes:
        if self._ser is not None:
            return self._ser.read(n) or b""
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
            return b""
        return buf.raw[:got.value]

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
