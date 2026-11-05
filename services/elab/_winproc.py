"""
Windows 子进程的两件事：**不弹窗** + **不残留**。

## 一、不弹窗（2026-10-08）

背景（实测坑）：cockpit.cmd 改用 pythonw 无窗口运行服务后，服务进程**没有
控制台**可供子进程继承——于是每个控制台程序（elab run / python / cmake /
ninja / gcc / openocd / gdb / pnputil）被 spawn 时都会**新弹一个黑色命令行
窗口**（用户报告"一手动按命令就会出现命令行的框框"）。以前服务跑在 /MIN
控制台里，子进程继承父控制台，所以从不弹窗。

修法：Windows 下所有 Popen/run 统一 OR 上 CREATE_NO_WINDOW(0x08000000)——
子进程拿到一个**隐藏**控制台，其孙进程（ninja→gcc 树）继承之，全树无窗口。
非 Windows 平台是 no-op（标志位为 0 且不进 kwargs）。

## 二、不残留（2026-11-05）

背景（实测坑）：调试探针被占、或用户强杀内核（关掉驾驶舱窗口 / TerminateProcess）
之后，openocd 变成**孤儿**继续握着 CMSIS-DAP，下一次「开始调试」永远
`debug-gdb-missing`，只能手动 `taskkill /IM openocd.exe`。

这类泄漏没法用 finally / atexit 收：强杀时用户态收尾代码**一行都不执行**。
只能在操作系统层兜底 —— 作业对象（Job Object）+ `KILL_ON_JOB_CLOSE`：

    内核启动 → CreateJobObject + 设 KILL_ON_JOB_CLOSE
    派生每个子进程 → AssignProcessToJobObject
    内核死亡（任何方式，含 TerminateProcess）→ 系统关闭句柄
    → 作业内所有进程被终止（含 openocd 的子孙）

这条链路由**内核对象引用计数**驱动，不依赖任何用户态代码，所以强杀也有效。

已知边界（如实说明）：

- 从 Popen 返回到 assign 之间有个**微秒级**窗口，这段时间内被杀仍会漏。要
  彻底消除得用 CREATE_SUSPENDED + 手工 ResumeThread，代价大于收益；
- 内核自己若已被放进别的作业（受限环境 / CI），Win8+ 靠嵌套作业共存，
  Win7 会 assign 失败 —— 失败一律**降级为原行为**（返回 False），绝不因为
  作业建不起来就让调试不可用；
- 作业句柄**故意不显式关闭**：只挂在模块级变量上，进程结束时由系统回收。
  这正是"父进程怎么死都带走子进程"的前提，注册 atexit 去 CloseHandle 反而
  会在正常退出路径上抢跑。
"""

import ctypes
import subprocess
import sys

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def proc_kwargs(**extra):
    """给 subprocess.run/Popen 的 kwargs 追加 CREATE_NO_WINDOW（仅 Windows）。

    已带 creationflags 的调用点（如 server.py 的 CREATE_NEW_PROCESS_GROUP）
    会被正确合并（OR），不会覆盖。"""
    if sys.platform == "win32":
        extra["creationflags"] = extra.get("creationflags", 0) | CREATE_NO_WINDOW
    return extra


# ── 作业对象 ─────────────────────────────────────────────────────────

_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_PROCESS_TERMINATE = 0x0001
_PROCESS_SET_QUOTA = 0x0100

#: 默认作业句柄：``None`` 表示还没尝试建过；``0`` 表示建不出来（别再试）；
#: 其它值即有效句柄。全局唯一，随进程退出被系统关闭 → 杀光所有成员。
_JOB: int | None = None

if sys.platform == "win32":  # pragma: no cover - 结构体定义无分支可测
    from ctypes import wintypes

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class _BASIC_LIMIT(ctypes.Structure):
        # LARGE_INTEGER 用 c_longlong 表达：x64 上 8 字节对齐，与 C 一致
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BASIC_LIMIT),
            ("IoInfo", _IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _k32.CreateJobObjectW.restype = wintypes.HANDLE
    _k32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    _k32.SetInformationJobObject.restype = wintypes.BOOL
    _k32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    _k32.AssignProcessToJobObject.restype = wintypes.BOOL
    _k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _k32.CloseHandle.restype = wintypes.BOOL
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
else:  # pragma: no cover - 非 Windows 只走降级分支
    _k32 = None


def new_job() -> int:
    """新建一个「句柄一关就杀光成员」的作业对象；失败返回 ``0``。

    独立于默认作业，方便测试里自建自关（关掉只影响它自己的成员）。"""
    if _k32 is None:
        return 0
    handle = _k32.CreateJobObjectW(None, None)
    if not handle:
        return 0
    info = _EXTENDED_LIMIT()
    info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not _k32.SetInformationJobObject(
            handle, _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info), ctypes.sizeof(info)):
        _k32.CloseHandle(handle)
        return 0
    return int(handle)


def default_job() -> int:
    """进程内共享的作业句柄（懒建）。返回 ``0`` 表示这台机器上用不了作业对象。"""
    global _JOB
    if _JOB is None:
        _JOB = new_job()
    return _JOB


def adopt(proc: subprocess.Popen, job: int | None = None) -> bool:
    """把已启动的子进程挂进作业；成功返回 True。

    ``job`` 省略时用 :func:`default_job`。任何失败（非 Windows / 作业建不出来 /
    受限环境不允许 assign）都只返回 False，**不抛异常** —— 这是纯兜底能力，
    绝不能因为它让正常流程失败。"""
    if _k32 is None or proc is None:
        return False
    hjob = default_job() if job is None else int(job)
    if not hjob:
        return False
    hproc = _k32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, proc.pid)
    if not hproc:
        return False
    try:
        return bool(_k32.AssignProcessToJobObject(hjob, hproc))
    finally:
        _k32.CloseHandle(hproc)


def spawn(argv, **kwargs) -> subprocess.Popen:
    """``Popen`` + 自动进作业。

    用于「父进程死了会留下麻烦」的子进程：openocd / gdb / 固件运行进程。
    返回值和 :class:`subprocess.Popen` 完全一致，进不进得了作业不影响启动。"""
    proc = subprocess.Popen(argv, **proc_kwargs(**kwargs))
    adopt(proc)
    return proc


def close_job(job: int) -> None:
    """关闭作业句柄（成员随即被终止）。仅供测试或显式收尾使用。"""
    if _k32 is not None and job:
        _k32.CloseHandle(job)
