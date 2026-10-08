"""
Windows 无窗口子进程 —— 驾驶舱 pythonw 化的配套修复（2026-10-08）。

背景（实测坑）：cockpit.cmd 改用 pythonw 无窗口运行服务后，服务进程**没有
控制台**可供子进程继承——于是每个控制台程序（elab run / python / cmake /
ninja / gcc / openocd / gdb / pnputil）被 spawn 时都会**新弹一个黑色命令行
窗口**（用户报告"一手动按命令就会出现命令行的框框"）。以前服务跑在 /MIN
控制台里，子进程继承父控制台，所以从不弹窗。

修法：Windows 下所有 Popen/run 统一 OR 上 CREATE_NO_WINDOW(0x08000000)——
子进程拿到一个**隐藏**控制台，其孙进程（ninja→gcc 树）继承之，全树无窗口。
非 Windows 平台是 no-op（标志位为 0 且不进 kwargs）。
"""

import sys

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def proc_kwargs(**extra):
    """给 subprocess.run/Popen 的 kwargs 追加 CREATE_NO_WINDOW（仅 Windows）。

    已带 creationflags 的调用点（如 server.py 的 CREATE_NEW_PROCESS_GROUP）
    会被正确合并（OR），不会覆盖。"""
    if sys.platform == "win32":
        extra["creationflags"] = extra.get("creationflags", 0) | CREATE_NO_WINDOW
    return extra
