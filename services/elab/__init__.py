"""elab —— elab-Flow 命令行服务层（L3）。

零第三方依赖：仅标准库。任何装了 python3 的主机都能直接运行。
"""

import sys as _sys

__all__ = ["__version__"]
__version__ = "0.1.0"

# ── stdout/stderr 编码守卫（真机抓出的坑，见 cockpit 启动器事故）──────────
#
# Windows 上 stdout **被重定向**（> 日志文件 / 管道）时，Python 按区域设置取
# 编码 —— 中文 Windows 是 GBK。本项目的 CLI 与驾驶舱横幅大量使用 ✓/✗/▶ 等
# 字符，GBK 编不动 → `UnicodeEncodeError` **直接把进程打崩**。实测事故：
# 驾驶舱被 `cockpit.cmd` 以 `> log 2>&1` 拉起，打印启动横幅一行就死 ——
# 端口永远起不来，桌面启动器等 20s 超时、UI 不弹（用户症状："起服务后不自动开 UI"）。
#
# 为什么放包入口：elab CLI 与 cockpit.server 都经 `import elab`，这里是
# **单一修点**（C26 同精神：不复制流程）。交互式控制台本就走 UTF-16 API
# （PEP 528，encoding 已是 utf-8），此处不会动它；只改"被重定向成 GBK"的那类。
for _s in (_sys.stdout, _sys.stderr):
    try:
        if _s is not None and (_s.encoding or "").lower().replace("-", "") != "utf8":
            _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                     # noqa: BLE001 —— 编码守卫绝不反向杀进程
        pass
del _s
