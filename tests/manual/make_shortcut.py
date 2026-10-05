"""创建「elab驾驶舱」桌面快捷方式（手动维护工具，不进 CI）。

用法（系统 Python，需带 pywin32）：
    C:/Users/xiao1/AppData/Local/Programs/Python/Python312/python.exe \
        tests/manual/make_shortcut.py

产物：<Desktop>/elab驾驶舱.lnk → 仓库根 cockpit.cmd，图标 cockpit.ico。
双击即可：3333 端口没起服务就最小化起一个（日志 %TEMP%\\elab-cockpit.log），
再打开默认浏览器 —— 幂等，重复双击只是多开一个标签页。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pythoncom
import win32com.client

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    # 直接问系统要桌面路径（规避 OneDrive 重定向猜错）
    import ctypes
    from ctypes import windll  # noqa: PLC0415

    CSIDL_DESKTOPDIRECTORY = 0x0010
    buf = ctypes.create_unicode_buffer(260)
    ok = windll.shell32.SHGetFolderPathW(None, CSIDL_DESKTOPDIRECTORY, None, 0, buf)
    if ok != 0:
        print(f"[FAIL] SHGetFolderPathW -> {ok}")
        return 1
    desktop = Path(buf.value)

    lnk_path = desktop / "elab驾驶舱.lnk"
    pythoncom.CoInitialize()
    ws = win32com.client.Dispatch("WScript.Shell")
    sc = ws.CreateShortcut(str(lnk_path))
    sc.TargetPath = str(ROOT / "cockpit.cmd")
    sc.WorkingDirectory = str(ROOT)
    sc.IconLocation = f"{ROOT / 'cockpit.ico'},0"
    sc.Description = "elab cockpit - one-click monitor"
    sc.Save()
    size = lnk_path.stat().st_size
    print(f"[ok] shortcut: {lnk_path} ({size} B) -> {sc.TargetPath}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
