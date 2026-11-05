"""elab.debugsource —— 源码页签的数据面（路径沙箱 / 行读取 / 断点定位串）。

设计依据：``docs/design/执行计划_调试P3_源码单步与多会话与寄存器组.md`` §5.2。

**纯函数模块**：只做路径解析与文件读，不碰 gdb/HTTP。三条硬规则：

1. **沙箱**：任何 ``file`` 解析后必须仍在 ``plan.source_dir`` 之内（防 ``..`` 与符号链接）；
2. **只用文本**：非 UTF-8 用 ``errors="replace"`` 降级，二进制/超大直接截断；
3. **不猜**：basename 索引匹配到多个同名文件时返回空 —— 猜错文件比不显示更糟。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

#: 单次读取上限（§5.2 A1）
MAX_BYTES = 512 * 1024
MAX_LINES = 400

#: basename 索引规模上限与跳过目录（构建产物里同名头文件极多，全是噪声）
INDEX_LIMIT = 5000
_SKIP_DIRS = {".git", ".svn", ".hg", "build", "Build", "out", "node_modules",
              ".work", "Debug", "Release", "__pycache__", ".venv", "venv"}
_SKIP_SUFFIX = {".o", ".d", ".obj", ".elf", ".bin", ".hex", ".map", ".a", ".lib",
                ".pyc", ".cmake", ".su"}


class SourceError(ValueError):
    """路径越界 / 非法参数。HTTP 层映射 ``400 debug-bad-request``。"""


class SourceUnavailable(LookupError):
    """文件不存在（源码已移动 / ELF 无调试信息）。HTTP 层映射 ``404``。"""


def _posix(p: str) -> str:
    return str(p).replace("\\", "/")


def resolve_in_sandbox(source_dir: str, file: str) -> Path:
    """把 ``file``（绝对或相对 source_dir）解析成真实路径，越界即抛。

    用 ``Path.resolve()``（会解开符号链接）后再比对 —— 先比父路径字符串是防不住
    ``link -> ../../etc/passwd`` 这种的。
    """
    if not str(file or "").strip():
        raise SourceError("缺少 file 参数")
    root_raw = str(source_dir or "").strip()
    if not root_raw:
        raise SourceError("工程未声明 source_dir，无法定位源码")
    root = Path(root_raw).resolve()
    raw = str(file).strip().strip('"')
    cand = Path(raw)
    if not cand.is_absolute():
        cand = root / raw
    try:
        real = cand.resolve()
    except (OSError, RuntimeError) as exc:              # 循环链接等
        raise SourceError(f"路径不可解析：{raw!r}（{exc}）")
    try:
        real.relative_to(root)
    except ValueError:
        raise SourceError(f"路径越界（必须在工程源码根内）：{raw!r}")
    return real


def to_rel(source_dir: str, path: str | Path) -> str:
    """绝对路径 → 相对 source_dir 的 POSIX 串（不在根内则原样 POSIX 化）。"""
    try:
        root = Path(str(source_dir)).resolve()
        p = Path(str(path)).resolve()
    except (OSError, RuntimeError):
        return _posix(path)
    try:
        return _posix(p.relative_to(root))
    except ValueError:
        return _posix(p)


def read_lines(source_dir: str, file: str, *, start: int = 1, count: int = 120) -> dict:
    """读源码行（1-based，含 ``start`` 起 ``count`` 行）。

    返回 ``{ok,file,rel,start,end,total,lines:[{no,text}],mtime,truncated}``。
    ``truncated`` 覆盖三种情况：行数超限、字节超限、请求窗口未到文件尾。
    """
    path = resolve_in_sandbox(source_dir, file)
    if not path.exists() or not path.is_file():
        raise SourceUnavailable(f"源码文件不存在：{to_rel(source_dir, path)}")
    start = max(1, int(start or 1))
    count = max(1, min(int(count or 120), MAX_LINES))
    try:
        size = path.stat().st_size
        mtime = int(path.stat().st_mtime)
    except OSError as exc:
        raise SourceUnavailable(f"源码不可读：{exc}")
    if size > MAX_BYTES:
        # 超大文件只读前 MAX_BYTES 字节（生成代码/合并头文件常见），不整读进内存
        with path.open("rb") as fh:
            blob = fh.read(MAX_BYTES)
        text = blob.decode("utf-8", errors="replace")
        byte_truncated = True
    else:
        text = path.read_text(encoding="utf-8", errors="replace")
        byte_truncated = False
    all_lines = text.splitlines()
    total = len(all_lines)          # splitlines 已按行切；末尾换行不会多出一行空行
    lo = start - 1
    hi = min(len(all_lines), lo + count)
    rows = [{"no": i + 1, "text": all_lines[i].replace("\t", "    ")}
            for i in range(lo, min(hi, len(all_lines)))]
    return {
        "ok": True,
        "file": _posix(path),
        "rel": to_rel(source_dir, path),
        "start": start,
        "end": rows[-1]["no"] if rows else start,
        "total": total,
        "lines": rows,
        "mtime": mtime,
        # truncated 只表示"因上限丢掉了文件内容"；窗口后面还有行用 has_more 表达，
        # 两件事混在一起 UI 会把正常翻页误报成"文件被截断"。
        "truncated": bool(byte_truncated),
        "has_more": bool(rows) and rows[-1]["no"] < total,
    }


def basename_index(source_dir: str, *, limit: int = INDEX_LIMIT) -> dict[str, list[str]]:
    """``basename → [绝对路径…]``（跳过构建目录/二进制，最多 ``limit`` 个文件）。"""
    root_raw = str(source_dir or "").strip()
    if not root_raw:
        return {}
    root = Path(root_raw)
    if not root.is_dir():
        return {}
    index: dict[str, list[str]] = {}
    seen = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if Path(name).suffix.lower() in _SKIP_SUFFIX:
                continue
            index.setdefault(name, []).append(_posix(Path(dirpath) / name))
            seen += 1
            if seen >= limit:
                return index
    return index


def resolve_hint(source_dir: str, file: str, index: dict[str, list[str]] | None = None) -> str:
    """无 ``fullname`` 时按 basename 反查绝对路径；**多解不猜**（返回空串）。"""
    name = _posix(file or "").rsplit("/", 1)[-1]
    if not name:
        return ""
    idx = index if index is not None else basename_index(source_dir)
    hits = idx.get(name) or []
    return hits[0] if len(hits) == 1 else ""


# ── 断点定位串 ──────────────────────────────────────────────────
#: gdb 的 ``file:line`` 里路径含空格/逗号时整串必须加引号；反斜杠在 Linux 上是转义符，
#: 所以统一先转 POSIX 分隔符再决定是否加引号（D1 spike 结论，见 plan §9）。
_NEEDS_QUOTE = re.compile(r"[\s\"']")


def breakpoint_spec(source_dir: str, file: str, line: int) -> dict:
    """``kind=source`` 断点 → ``{spec, abs, rel, quoted}``。

    ``spec`` 是直接喂给 ``-break-insert`` 的字符串：``"<posix abs>:<line>"``，
    需要时整体加双引号。Windows 盘符路径（``C:/a/b.c:12``）gdb 能接受。
    """
    if not file:
        raise SourceError("源码断点需要 file")
    try:
        n = int(line)
    except (TypeError, ValueError):
        raise SourceError(f"源码断点需要行号（收到 {line!r}）")
    if n <= 0:
        raise SourceError("行号必须 ≥ 1")
    path = resolve_in_sandbox(source_dir, file)
    abs_posix = _posix(path)
    base = f"{abs_posix}:{n}"
    quoted = f'"{base}"' if _NEEDS_QUOTE.search(base) else base
    return {"spec": base, "quoted": quoted, "abs": abs_posix,
            "rel": to_rel(source_dir, path), "line": n}
