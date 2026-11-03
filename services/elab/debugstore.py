"""elab.debugstore —— 工程级调试配置（断点 / 监视）持久化。

设计依据：``docs/design/技术方案_调试面板复刻cortex-debug.md`` §7.7 / §11 P1。

落点：``projects/<name>.debug.json``（与 ``projects/<name>.yaml`` 同目录，**不**进 state）。
形状::

    {"rev": 3,
     "breakpoints": [{"id":"bp-1","kind":"func","location":"HAL_Delay",
                      "condition":"i > 3","enabled":true,"hardware":false}],
     "watches": [{"id":"w-1","expr":"i","format":"natural"}]}

``rev`` 是**乐观锁**：客户端带旧 rev 写入 → ``debug-rev-conflict``（409）。
本模块只管文件读写与整形，不认识 GDB；会话层负责把条目灌进 gdb。
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

_LOCK = threading.RLock()


def _err_conflict(cur: int, base: int):
    # 延迟导入：debugsession 会 import 本模块，模块顶层反向 import 会成环。
    from .debugsession import DebugError

    return DebugError("debug-rev-conflict",
                      f"调试配置已被其它会话修改（当前 rev={cur}，提交 rev={base}）",
                      "重新 GET /api/debug/breakpoints 拿最新 rev 后重试")


def path_for(cfg, project: str) -> Path:
    return Path(cfg.root) / "projects" / f"{project}.debug.json"


def empty() -> dict:
    return {"rev": 0, "breakpoints": [], "watches": []}


def load(cfg, project: str) -> dict:
    """读工程调试配置；坏文件/缺失一律降级为空白（不阻塞调试）。"""
    path = path_for(cfg, project)
    with _LOCK:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return empty()
    if not isinstance(raw, dict):
        return empty()
    out = empty()
    try:
        out["rev"] = int(raw.get("rev") or 0)
    except (TypeError, ValueError):
        out["rev"] = 0
    for bp in raw.get("breakpoints") or []:
        if isinstance(bp, dict) and str(bp.get("location") or ""):
            out["breakpoints"].append({
                "id": str(bp.get("id") or ""),
                "kind": str(bp.get("kind") or "func"),
                "location": str(bp.get("location") or ""),
                "condition": str(bp.get("condition") or ""),
                "enabled": bool(bp.get("enabled", True)),
                "hardware": bool(bp.get("hardware", False)),
            })
    for w in raw.get("watches") or []:
        if isinstance(w, dict) and str(w.get("expr") or ""):
            out["watches"].append({
                "id": str(w.get("id") or ""),
                "expr": str(w.get("expr") or ""),
                "format": str(w.get("format") or "natural"),
            })
    return out


def save(cfg, project: str, data: dict, *, base_rev: int | None = None) -> dict:
    """原子写回；``base_rev`` 非空时做乐观锁校验，成功后 rev + 1。"""
    path = path_for(cfg, project)
    with _LOCK:
        cur = load(cfg, project)
        if base_rev is not None and int(base_rev) != cur["rev"]:
            raise _err_conflict(cur["rev"], int(base_rev))
        payload = {
            "rev": cur["rev"] + 1,
            "breakpoints": [dict(b) for b in data.get("breakpoints") or []],
            "watches": [dict(w) for w in data.get("watches") or []],
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
        os.replace(tmp, path)
        return payload
