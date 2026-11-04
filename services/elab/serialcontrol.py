"""elab.serialcontrol —— DTR/RTS 手动控制与复位/下载预设（M1）。

为什么要做成「数据驱动的序列」
------------------------------
"拉一下 DTR 就复位"这套时序其实是**板级电路**的事实（ESP32 的 EN/IO0 交叉接法、
Arduino 的 100nF 自动复位、某些板子 DTR/RTS 根本没接）。把它写进内核的
``if vendor == "espressif"`` 就是分层违规（AGENTS.md 规则 5）。
所以：**内核只执行** ``pack.yaml: serial.reset_presets`` 里的步骤序列，
厂商给什么就做什么；包里没有预设时，只保留原始 DTR/RTS 开关。

证据纪律
--------
DTR/RTS 是**物理线路动作**：不进字节环、不算 TX、不写 console 日志
（否则"TX 计数"会被莫名其妙的脉冲污染）。本模块只在监视快照里留
``control``（谁在什么时候把线拉成什么），供面板显示。
"""

from __future__ import annotations

import threading
import time

from . import serialmon
from . import serialtransport as tp
from .config import Config

#: 单个预设的步骤上限（防 YAML 写死循环式长序列）。
MAX_STEPS = 8
#: 单步保持时长上限（ms）。再长就是"故意卡住"，不该在 UI 线程里做。
MAX_HOLD_MS = 500
#: 整个序列的时长上限（ms）。
MAX_TOTAL_MS = 2000
_DEFAULT_HOLD_MS = 100

#: 序列状态（只保留最近一次；异步线程写，接口读）。
_SEQ: dict = {"state": "idle", "preset": "", "error": "", "started": 0.0,
              "finished": 0.0, "by": "", "steps": 0}
_SEQ_LOCK = threading.Lock()      # 保护 _SEQ 与「序列独占串口」
_TOKEN = 0                        # 取消用：每次启动 +1，旧线程在下一步前退出


def _project_pack(cfg: Config, project: str):
    """项目固定的包（优先）或当前启用包。返回 ``(record 或 None, 提示)``。"""
    proj = cfg.resolved_project(project) if project else {}
    pinned = str(proj.get("pack") or "").strip()
    if pinned:
        rec = cfg.packs.get(pinned)
        return (rec, "") if rec else (None, f"项目固定包未安装：{pinned}")
    rec = cfg.active_pack
    return (rec, "") if rec else (
        None, "没有启用的适配包 —— 复位预设来自 pack.yaml（先 elab pkg install / use）")


def _presets_source(cfg: Config, project: str):
    """取预设原始数据的落点：**项目 yaml 覆盖** → 项目包 → 启用包。

    返回 ``(raw, source, pack_name, hint)``。``source`` ∈ project / pack / none。
    """
    proj = cfg.resolved_project(project) if project else {}
    ser = (proj.get("serial") or {}) if isinstance(proj, dict) else {}
    if isinstance(ser.get("reset_presets"), list):
        return ser["reset_presets"], "project", str(proj.get("pack") or ""), ""
    rec, hint = _project_pack(cfg, project)
    raw = None
    if rec:
        raw = ((rec.get("manifest") or {}).get("serial") or {}).get("reset_presets")
    return raw, ("pack" if rec else "none"), (rec or {}).get("name", ""), hint


def _norm_presets(raw) -> tuple[list[dict], list[str]]:
    """校验 ``serial.reset_presets``。坏条目**跳过并报错**，不拖垮整份清单。"""
    out: list[dict] = []
    errors: list[str] = []
    if raw is None:
        return out, errors
    if not isinstance(raw, list):
        return out, ["serial.reset_presets 必须是列表"]
    for i, item in enumerate(raw):
        where = f"serial.reset_presets[{i}]"
        if not isinstance(item, dict):
            errors.append(f"{where} 必须是映射")
            continue
        name = str(item.get("id") or item.get("name") or "").strip()
        if not name:
            errors.append(f"{where} 缺少 id")
            continue
        steps_raw = item.get("steps")
        if not isinstance(steps_raw, list) or not steps_raw:
            errors.append(f"{where}（{name}）缺少 steps")
            continue
        if len(steps_raw) > MAX_STEPS:
            errors.append(f"{where}（{name}）steps 超过 {MAX_STEPS} 步")
            continue
        steps: list[dict] = []
        bad = ""
        for j, st in enumerate(steps_raw):
            if not isinstance(st, dict):
                bad = f"{where}（{name}）steps[{j}] 必须是映射"
                break
            step: dict = {}
            for key in ("dtr", "rts"):
                if key in st:
                    if not isinstance(st[key], bool):
                        bad = f"{where}（{name}）steps[{j}].{key} 必须是布尔"
                        break
                    step[key] = st[key]
            if bad:
                break
            if not step:
                bad = f"{where}（{name}）steps[{j}] 既没有 dtr 也没有 rts"
                break
            hold = st.get("hold_ms", _DEFAULT_HOLD_MS)
            if not isinstance(hold, (int, float)) or not (0 <= hold <= MAX_HOLD_MS):
                bad = (f"{where}（{name}）steps[{j}].hold_ms 必须是 "
                       f"0..{MAX_HOLD_MS} 的数字")
                break
            step["hold_ms"] = float(hold)
            steps.append(step)
        if bad:
            errors.append(bad)
            continue
        total = sum(s["hold_ms"] for s in steps)
        if total > MAX_TOTAL_MS:
            errors.append(f"{where}（{name}）序列总时长 {total:g}ms 超过 {MAX_TOTAL_MS}ms")
            continue
        out.append({"name": name, "label": str(item.get("label") or name),
                    "description": str(item.get("description") or ""),
                    "steps": steps})
    return out, errors


def presets(cfg: Config, project: str = "") -> dict:
    """可用的复位预设（项目 yaml 覆盖 → 项目包 → 启用包的 ``pack.yaml``）。"""
    raw, source, pack, hint = _presets_source(cfg, project)
    items, errors = _norm_presets(raw)
    return {"presets": items, "pack": pack, "source": source,
            "errors": errors, "hint": hint}


def _seq_view() -> dict:
    with _SEQ_LOCK:
        return dict(_SEQ)


def state(cfg: Config, project: str = "") -> dict:
    """面板一次性拿全：预设 + 当前会话的已知线状态 + 序列进度。"""
    sess = serialmon.current()
    live = sess is not None
    p = presets(cfg, project)
    return {
        "ok": True,
        # 两个后端（pyserial / ctypes）都能动 DTR/RTS；"supported" 说的是能力，
        # "source" 说的是**预设数据**从哪来（没有预设不等于不支持原始开关）。
        "supported": True,
        **p,
        "dtr": sess.control["dtr"] if live else None,
        "rts": sess.control["rts"] if live else None,
        "backend": (getattr(sess.io, "backend", "") or "") if live else "",
        "session": {"active": live,
                    "port": sess.port if live else "",
                    "line_text": sess.line.text if live else ""},
        "control": (dict(sess.control) if live else
                    {"dtr": None, "rts": None, "verified": False,
                     "preset": "", "by": "", "at": 0.0}),
        "sequence": _seq_view(),
    }


def apply(cfg: Config, project: str, *, dtr: bool | None = None,
          rts: bool | None = None, port: str = "", line=None,
          actor: str = "human", log=print) -> dict:
    """立即设置 DTR/RTS（``None`` = 不动那条线）。

    有监视会话时**复用同一句柄**（不抢口、不断流）；没有会话时临时开一次口
    ——并**明说**：某些 USB 转串口在 open 时会自己拉一次 DTR，可能顺带复位。
    """
    if dtr is None and rts is None:
        return {"ok": False, "error": "没有指定 dtr 或 rts"}
    sess = serialmon.current()
    if sess is not None:
        with sess.wlock:
            res = sess.io.set_control(dtr, rts)
        if res.get("ok"):
            applied = res.get("applied") or {}
            sess.control.update({
                "dtr": applied.get("dtr", sess.control.get("dtr")),
                "rts": applied.get("rts", sess.control.get("rts")),
                "verified": bool(res.get("verified")),
                "preset": "", "by": actor, "at": time.time()})
        res["port"] = sess.port
        res["line_text"] = sess.line.text
        res["actor"] = actor
        log(f"[serialcontrol] {'✓' if res.get('ok') else '—'} "
            f"{sess.port} DTR={dtr} RTS={rts}")
        return res

    t = tp.resolve(cfg, project, port=port, line=line)
    if t.errors or not t.label:
        return {"ok": False, "error": "；".join(t.errors) or t.reason}
    try:
        with tp.open(t, for_write=True) as io:
            res = io.set_control(dtr, rts)
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    res.update({"port": t.label, "line_text": t.line.text, "transient": True,
                "note": "未开监视，临时开户 —— 某些 USB 转串口 open 时自身会拉 DTR"})
    log(f"[serialcontrol] {'✓' if res.get('ok') else '—'} "
        f"{t.label}（临时）DTR={dtr} RTS={rts}")
    return res


def run_preset(cfg: Config, project: str, name: str, *, port: str = "",
               line=None, actor: str = "human", log=print) -> dict:
    """异步执行一个复位预设；再次触发会**取消旧序列**并按新的跑。"""
    global _TOKEN
    items = presets(cfg, project)["presets"]
    target = next((p for p in items if p["name"] == name), None)
    if target is None:
        return {"ok": False,
                "error": f"未知复位预设：{name!r}（可用：{[p['name'] for p in items]}）"}
    with _SEQ_LOCK:
        _TOKEN += 1
        token = _TOKEN
        _SEQ.update({"state": "running", "preset": name, "error": "",
                     "started": time.time(), "finished": 0.0, "by": actor,
                     "steps": len(target["steps"])})
    threading.Thread(target=_sequence, name="serialreset", daemon=True,
                     args=(token, cfg, project, target, port, line, actor, log)).start()
    log(f"[serialcontrol] ▶ 预设 {name}（{len(target['steps'])} 步）")
    return {"ok": True, "preset": name, "async": True, "sequence": _seq_view()}


def cancel() -> dict:
    """取消正在跑的序列（下一步之前退出；接口立即返回）。"""
    global _TOKEN
    with _SEQ_LOCK:
        running = _SEQ["state"] == "running"
        _TOKEN += 1
        if running:
            _SEQ.update({"state": "cancelled", "finished": time.time()})
    return {"ok": True, "cancelled": running, "sequence": _seq_view()}


def _cancelled(token: int) -> bool:
    with _SEQ_LOCK:
        return token != _TOKEN


def _sequence(token: int, cfg: Config, project: str, preset: dict,
              port: str, line, actor: str, log) -> None:
    """序列执行体。每步之间检查 token，取消时立即退出（不留半套线态）。"""
    sess = serialmon.current()
    known = dict(sess.control) if sess is not None else {
        "dtr": None, "rts": None, "verified": False}
    error = ""
    try:
        if sess is not None:
            for st in preset["steps"]:
                if _cancelled(token):
                    return
                with sess.wlock:
                    res = sess.io.set_control(st.get("dtr"), st.get("rts"))
                if not res.get("ok"):
                    raise OSError(res.get("error") or "设置 DTR/RTS 失败")
                applied = res.get("applied") or {}
                known.update(applied)
                sess.control.update({
                    "dtr": known.get("dtr"), "rts": known.get("rts"),
                    "verified": bool(res.get("verified")),
                    "preset": preset["name"], "by": actor, "at": time.time()})
                time.sleep(st["hold_ms"] / 1000.0)
        else:
            t = tp.resolve(cfg, project, port=port, line=line)
            if t.errors or not t.label:
                raise OSError("；".join(t.errors) or t.reason)
            with tp.open(t, for_write=True) as io:
                for st in preset["steps"]:
                    if _cancelled(token):
                        return
                    res = io.set_control(st.get("dtr"), st.get("rts"))
                    if not res.get("ok"):
                        raise OSError(res.get("error") or "设置 DTR/RTS 失败")
                    known.update(res.get("applied") or {})
                    time.sleep(st["hold_ms"] / 1000.0)
    except Exception as exc:                       # noqa: BLE001
        error = str(exc)
        log(f"[serialcontrol] — 预设 {preset['name']} 失败：{error}")
    finally:
        with _SEQ_LOCK:
            if token == _TOKEN:                    # 只有"最新一次"才落终态
                _SEQ.update({"state": ("error" if error else "done"),
                             "error": error, "finished": time.time()})
