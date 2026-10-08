"""version —— 固件版本三层模型（双槽方案 §9.1）的 elab 侧实现。

声明层（semver，projects/*.yaml `version:`，人控 major/minor）
    → 嵌入层（构建期经 ota_layout_gen.h 注入 OTA_VER_MAJOR/MINOR/PATCH/BUILD）。

自动层（build 号）在这里：``.work/versions.json`` 按**工程名**记单调整数，
builder 真跑构建前分配（``alloc_build``）。语义约定（§9.1）：
build 号只做产物追溯，**不参与升级决策**（同源码重编也 +1，比较它没有意义）
——升级判据只比 semver。失败构建会消耗一个号，无害（计数器而已）。
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import ElabError


def parse_version(raw: object, proj_name: str = "") -> tuple[int, int, int] | None:
    """解析 projects yaml 的 ``version:``（"1.2.3" 或 [1,2,3]）。

    未声明 → None（版本机制是可选能力，不强制所有工程携带）。
    格式非法 → ElabError（plan 阶段 fail-fast）。
    """
    if raw is None or raw == "":
        return None
    if isinstance(raw, (list, tuple)):
        if len(raw) == 3 and all(isinstance(x, int) for x in raw):
            return (raw[0], raw[1], raw[2])
        raise ElabError(f"version 必须是 [major, minor, patch]：{proj_name}")
    if isinstance(raw, str):
        parts = raw.strip().split(".")
        if len(parts) == 3 and all(p.isdigit() for p in parts):
            return (int(parts[0]), int(parts[1]), int(parts[2]))
        raise ElabError(f"version 必须是 major.minor.patch 三段数字：{raw!r}（{proj_name}）")
    raise ElabError(f"version 必须是 \"1.2.3\" 字符串：{proj_name}")


def _record_path(root: str | Path) -> Path:
    return Path(root) / ".work" / "versions.json"


def _load(root: Path) -> dict:
    try:
        return json.loads(_record_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def alloc_build(root: str | Path, proj_name: str) -> int:
    """分配下一个 build 号并持久化（builder 真跑构建前调用；dry-run 不经过这里）。"""
    root_p = Path(root)
    rec = _load(root_p)
    nxt = int(rec.get(proj_name, 0)) + 1
    rec[proj_name] = nxt
    path = _record_path(root_p)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return nxt


def peek_build(root: str | Path, proj_name: str) -> int:
    """只读查询（doctor/展示用，不递增）。"""
    return int(_load(Path(root)).get(proj_name, 0))
