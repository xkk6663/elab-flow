"""elab.serialwidgets —— 工程级「串口自定义发送组件」（M2：序列 + 周期发送）。

一个 **SendWidget（发送组件）** = 名称 + 类型化参数 + 一串步骤。点一下按钮，
服务端校验参数、渲染字节、按步骤发送。设计见
``docs/design/技术方案_串口自定义发送组件.md``。

为什么渲染/校验只在服务端
------------------------
面板与 agent 都调同一个 ``preview`` / ``run``：前端只**展示**服务端算出的字节，
不自己拼模板 —— 否则"看的是 A，发的是 B"这种分叉迟早出现。

存储
----
``projects/<name>.widgets.json``（UTF-8、原子写、可提交）。文件带 ``rev``：
所有写请求必须带 ``rev``，不匹配返回 ``conflict`` —— 人机并发编辑时，
人的修改不会被 agent 的旧副本覆盖。

执行模型（M2）
--------------
``send`` / ``delay`` / ``wait`` 按顺序执行；``wait`` 必须已有监视会话（连续 RX）。
``repeat`` **重复整个组件**、固定节拍且不重叠：上一轮没跑完就从 ``next_at``
往后找最近一拍，错过的节拍计入 ``skipped``（只报告、不补发）。
任务在后台线程跑，HTTP 轮询 ``job_status``；``cancel`` / ``pause`` 只置标志位，
不杀线程。非周期任务最长 60s，周期任务最长 10min 后自动停。
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import threading
import time
from pathlib import Path

from . import serialmon as sm
from . import serialterm as st
from .config import Config, ElabError

WIDGETS_SUFFIX = ".widgets.json"
#: 单文件上限（64 KiB）与组件数上限。文件是工程配置，不是数据面，必须有界。
MAX_FILE_BYTES = 64 << 10
MAX_WIDGETS = 64
MAX_STEPS = 20
MAX_PARAMS = 32
MAX_TEMPLATE = 4096
MAX_LABEL = 24
MIN_REPEAT_MS = 20
#: 任务保留条数（内存里只留最近这些，重启即失 —— 它只是"这次跑得怎么样"）。
MAX_JOBS = 20
#: 任务记录上限：周期任务跑 10min 会产生大量步骤，超出只保留最近的（计数仍准确）。
MAX_JOB_STEPS = 2000
#: 单次任务时长上限（秒）：非周期 60s；周期 10min 后自动停。
MAX_RUN_S = 60
MAX_REPEAT_S = 600

PARAM_TYPES = ("int", "float", "bool", "enum", "string", "hex")
STEP_KINDS = ("send", "delay", "wait")
MATCH_KINDS = ("regex", "contains", "exact", "hex")

_ID_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
_PROJECT_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_PARAM_NAME_RE = re.compile(r"^[a-z0-9_]{1,32}$")

#: 进程内单任务：组件任务也是"占用串口"，不允许两串序列交错（N5 的同一条纪律）。
_JOB_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
_JOB_ORDER: list[str] = []
_JOBS_LOCK = threading.Lock()


# ══════════════════════════════════════════════════════════════════
#  路径与加载
# ══════════════════════════════════════════════════════════════════
def widgets_path(cfg: Config, project: str) -> Path:
    """``projects/<name>.widgets.json``。项目名先做白名单校验（防路径穿越）。"""
    name = str(project or "").strip()
    if not _PROJECT_RE.fullmatch(name):
        raise ElabError(f"工程名不合法：{project!r}")
    return Path(cfg.root) / "projects" / f"{name}{WIDGETS_SUFFIX}"


def _empty(project: str, path: Path) -> dict:
    return {"ok": True, "project": project, "rev": 0, "widgets": [],
            "warnings": [], "error": None, "path": str(path)}


def load(cfg: Config, project: str) -> dict:
    """读取并校验组件文件。

    ★ 坏文件**不抛异常**：串口功能不能被一份手改坏的 JSON 拖死。
      文件级错误进 ``error``，单组件错误进 ``warnings``，能读的都读出来。
    """
    path = widgets_path(cfg, project)
    out = _empty(project, path)
    if not path.exists():
        return out
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            out["error"] = (f"组件文件超过 {MAX_FILE_BYTES} B：{path}"
                            f"（请拆分工程或删掉无用组件）")
            return out
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        out["error"] = f"组件文件不可读：{exc}"
        return out
    if not isinstance(raw, dict):
        out["error"] = "组件文件顶层必须是对象（{version, rev, widgets}）"
        return out
    try:
        out["rev"] = max(0, int(raw.get("rev") or 0))
    except (TypeError, ValueError):
        out["warnings"].append("rev 不是整数 —— 按 0 处理")
    raw_widgets = raw.get("widgets")
    if raw_widgets is None:
        raw_widgets = []
    if not isinstance(raw_widgets, list):
        out["error"] = "widgets 必须是数组"
        return out

    seen: set[str] = set()
    for i, item in enumerate(raw_widgets):
        norm, errs = normalize_widget(item)
        if errs:
            out["warnings"].extend(f"widgets[{i}]：" + e for e in errs)
            continue
        assert norm is not None
        if norm["id"] in seen:
            out["warnings"].append(f"widgets[{i}]：id 重复 {norm['id']!r}，已忽略")
            continue
        if len(out["widgets"]) >= MAX_WIDGETS:
            out["warnings"].append(f"组件数超过上限 {MAX_WIDGETS}，其余已忽略")
            break
        seen.add(norm["id"])
        out["widgets"].append(norm)
    return out


def _write(cfg: Config, project: str, widgets: list[dict], rev: int) -> None:
    """原子写：临时文件 + ``os.replace``，进程崩溃也不会留下半个 JSON。"""
    path = widgets_path(cfg, project)
    doc = {"version": 1, "rev": int(rev), "widgets": widgets}
    text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    if len(text.encode("utf-8")) > MAX_FILE_BYTES:
        raise ElabError(f"保存后超过 {MAX_FILE_BYTES} B 上限 —— 请删减组件或模板")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _find(doc: dict, wid: str) -> dict | None:
    for w in doc.get("widgets") or []:
        if w.get("id") == wid:
            return w
    return None


# ══════════════════════════════════════════════════════════════════
#  校验 / 归一化
# ══════════════════════════════════════════════════════════════════
def _num(value) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _normalize_options(p: dict, errs: list[str]) -> list[dict]:
    out: list[dict] = []
    raw = p.get("options")
    if not isinstance(raw, list) or not raw:
        errs.append("enum 参数必须有非空 options")
        return out
    for o in raw:
        if isinstance(o, str):
            out.append({"label": o, "value": o})
        elif isinstance(o, dict) and "value" in o:
            val = str(o.get("value"))
            out.append({"label": str(o.get("label") or val), "value": val})
        else:
            errs.append(f"enum option 不合法：{o!r}（应为字符串或 {{label,value}}）")
    return out


def normalize_param(p: dict, index: int) -> tuple[dict | None, list[str]]:
    """校验并归一化一个参数定义。返回 ``(param, errors)``。"""
    errs: list[str] = []
    if not isinstance(p, dict):
        return None, [f"params[{index}] 必须是对象"]
    name = str(p.get("name") or "").strip()
    if not _PARAM_NAME_RE.fullmatch(name):
        errs.append(f"params[{index}].name 不合法：{name!r}（[a-z0-9_]{{1,32}}）")
    ptype = str(p.get("type") or "").strip()
    if ptype not in PARAM_TYPES:
        errs.append(f"参数 {name or index} 的类型未知：{ptype!r}"
                    f"（可选 {'/'.join(PARAM_TYPES)}）")
        return None, errs

    out: dict = {"name": name, "label": str(p.get("label") or name),
                 "type": ptype}
    if ptype in ("int", "float"):
        for key in ("min", "max", "step"):
            if key in p:
                v = _num(p.get(key))
                if v is None:
                    errs.append(f"参数 {name} 的 {key} 不是有限数字：{p.get(key)!r}")
                else:
                    out[key] = v
        if ptype == "float":
            dec = p.get("decimals", 3)
            try:
                dec = int(dec)
            except (TypeError, ValueError):
                dec = -1
            if not (0 <= dec <= 6):
                errs.append(f"参数 {name} 的 decimals 必须是 0..6：{p.get('decimals')!r}")
            out["decimals"] = max(0, min(dec, 6))
        if ptype == "int" and str(p.get("render") or "") == "hex":
            width = p.get("width", 2)
            try:
                width = int(width)
            except (TypeError, ValueError):
                width = -1
            if not (1 <= width <= 8):
                errs.append(f"参数 {name} 的 hex width 必须是 1..8 个十六进制位：{p.get('width')!r}")
            out["render"] = "hex"
            out["width"] = max(1, min(width, 8))
    elif ptype == "bool":
        out["true_value"] = str(p.get("true_value", "1"))
        out["false_value"] = str(p.get("false_value", "0"))
        for key in ("true_value", "false_value"):
            if "\r" in out[key] or "\n" in out[key]:
                errs.append(f"参数 {name} 的 {key} 不能包含换行")
    elif ptype == "enum":
        out["options"] = _normalize_options(p, errs)
    elif ptype == "string":
        max_len = p.get("max_len", 256)
        try:
            max_len = int(max_len)
        except (TypeError, ValueError):
            max_len = -1
        if not (1 <= max_len <= 4096):
            errs.append(f"参数 {name} 的 max_len 必须是 1..4096：{p.get('max_len')!r}")
        out["max_len"] = max(1, min(max_len, 4096))
        pat = p.get("pattern")
        if pat is not None:
            try:
                re.compile(str(pat))
            except re.error as exc:
                errs.append(f"参数 {name} 的 pattern 不是合法正则：{exc}")
            out["pattern"] = str(pat)
    elif ptype == "hex":
        width = p.get("width", 1)
        try:
            width = int(width)
        except (TypeError, ValueError):
            width = -1
        if not (1 <= width <= 8):
            errs.append(f"参数 {name} 的 width 必须是 1..8 字节：{p.get('width')!r}")
        out["width"] = max(1, min(width, 8))
        endian = str(p.get("endian") or "be").lower()
        if endian not in ("be", "le"):
            errs.append(f"参数 {name} 的 endian 必须是 be/le：{p.get('endian')!r}")
        out["endian"] = endian if endian in ("be", "le") else "be"

    # 默认值：缺省时给类型零值，但显式给出就必须过同一套校验。
    if "default" in p:
        try:
            out["default"] = _coerce_param(out, p["default"])
        except ValueError as exc:
            errs.append(f"参数 {name} 默认值不合法：{exc}")
    else:
        out["default"] = _zero_default(out)
    return (out if not errs else None), errs


def _zero_default(p: dict):
    t = p["type"]
    if t == "bool":
        return False
    if t == "enum":
        opts = p.get("options") or []
        return opts[0]["value"] if opts else ""
    if t == "string":
        return ""
    if t == "hex":
        return "00" * int(p.get("width") or 1)
    return 0


def normalize_widget(w) -> tuple[dict | None, list[str]]:
    """校验并归一化一个组件定义。返回 ``(widget, errors)``。"""
    errs: list[str] = []
    if not isinstance(w, dict):
        return None, ["组件必须是对象"]
    wid = str(w.get("id") or "").strip()
    if not _ID_RE.fullmatch(wid):
        errs.append(f"id 不合法：{wid!r}（[a-z0-9_-]{{1,32}}）")
    label = str(w.get("label") or wid)
    if len(label) > MAX_LABEL:
        errs.append(f"label 超过 {MAX_LABEL} 字：{label!r}")

    fmt = str(w.get("format") or "utf8").lower()
    if fmt not in st.SEND_FORMATS:
        errs.append(f"format 未知：{fmt!r}（可选 {'/'.join(st.SEND_FORMATS)}）")
    eol = str(w.get("eol") or ("none" if fmt == "hex" else "crlf")).lower()
    if eol not in st.EOLS:
        errs.append(f"eol 未知：{eol!r}（可选 {'/'.join(st.EOLS)}）")

    params: list[dict] = []
    names: set[str] = set()
    raw_params = w.get("params") or []
    if not isinstance(raw_params, list):
        errs.append("params 必须是数组")
        raw_params = []
    if len(raw_params) > MAX_PARAMS:
        errs.append(f"参数数超过上限 {MAX_PARAMS}")
        raw_params = raw_params[:MAX_PARAMS]
    for i, p in enumerate(raw_params):
        norm, perrs = normalize_param(p, i)
        errs.extend(perrs)
        if norm is None:
            continue
        if norm["name"] in names:
            errs.append(f"参数名重复：{norm['name']!r}")
            continue
        names.add(norm["name"])
        params.append(norm)

    steps: list[dict] = []
    raw_steps = w.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        errs.append("steps 必须是 1..%d 条的非空数组" % MAX_STEPS)
        raw_steps = []
    if len(raw_steps) > MAX_STEPS:
        errs.append(f"steps 超过上限 {MAX_STEPS}")
        raw_steps = raw_steps[:MAX_STEPS]
    for i, s in enumerate(raw_steps):
        if not isinstance(s, dict):
            errs.append(f"steps[{i}] 必须是对象")
            continue
        kind = str(s.get("kind") or "").strip()
        if kind not in STEP_KINDS:
            errs.append(f"steps[{i}].kind 未知：{kind!r}（可选 {'/'.join(STEP_KINDS)}）")
            continue
        if kind == "send":
            text = s.get("text")
            if not isinstance(text, str):
                errs.append(f"steps[{i}].text 必须是字符串")
                continue
            if len(text) > MAX_TEMPLATE:
                errs.append(f"steps[{i}].text 超过 {MAX_TEMPLATE} 字")
                continue
            sfmt = str(s.get("format") or fmt).lower()
            if sfmt not in st.SEND_FORMATS:
                errs.append(f"steps[{i}].format 未知：{sfmt!r}")
                continue
            seol = str(s.get("eol") or ("none" if sfmt == "hex" else eol)).lower()
            if seol not in st.EOLS:
                errs.append(f"steps[{i}].eol 未知：{seol!r}")
                continue
            steps.append({"kind": "send", "text": text,
                          "format": sfmt, "eol": seol})
        elif kind == "delay":
            ms = _num(s.get("ms"))
            if ms is None or ms < 0:
                errs.append(f"steps[{i}].ms 必须是 ≥0 的数字：{s.get('ms')!r}")
                continue
            steps.append({"kind": "delay", "ms": ms})
        else:                                       # wait
            within = _num(s.get("within_s", 1.0))
            if within is None or within <= 0:
                errs.append(f"steps[{i}].within_s 必须是 >0 的数字：{s.get('within_s')!r}")
                continue
            if within > MAX_RUN_S:
                errs.append(f"steps[{i}].within_s 不能超过 {MAX_RUN_S}s：{within!r}")
                continue
            match = s.get("match")
            if match is not None and not isinstance(match, dict):
                errs.append(f"steps[{i}].match 必须是对象")
                continue
            spec = dict(match or {"kind": "regex", "pattern": "."})
            kind = str(spec.get("kind") or "regex").lower()
            if kind not in MATCH_KINDS:
                errs.append(f"steps[{i}].match.kind 未知：{kind!r}"
                            f"（可选 {'/'.join(MATCH_KINDS)}）")
                continue
            # regex 惯用 `pattern`，其余惯用 `value`；两者都收 —— 归一化后
            # 步骤记录里统一是 `value`，写回配置文件时不该因方言再报错。
            raw_val = spec.get("pattern", spec.get("value")) if kind == "regex" else \
                spec.get("value", spec.get("pattern"))
            val = str(raw_val or "")
            if not val:
                errs.append(f"steps[{i}].match 缺少 pattern/value")
                continue
            if len(val) > MAX_TEMPLATE:
                errs.append(f"steps[{i}].match 超过 {MAX_TEMPLATE} 字")
                continue
            if kind == "regex":
                try:
                    re.compile(val)
                except re.error as exc:
                    errs.append(f"steps[{i}].match.pattern 不是合法正则：{exc}")
                    continue
            if kind == "hex":
                norm_hex = "".join(val.split()).upper()
                if not norm_hex or any(c not in "0123456789ABCDEF" for c in norm_hex):
                    errs.append(f"steps[{i}].match.value 不是合法十六进制：{val!r}")
                    continue
                val = norm_hex
            steps.append({"kind": "wait", "within_s": within,
                          "match": {"kind": kind, "value": val}})
    if not any(s["kind"] == "send" for s in steps):
        errs.append("至少需要一条 send 步骤")

    repeat = None
    if w.get("repeat") is not None:
        r = w.get("repeat")
        if not isinstance(r, dict):
            errs.append("repeat 必须是对象 {interval_ms, count}")
        else:
            try:
                interval = int(r.get("interval_ms", 0))
            except (TypeError, ValueError):
                interval = -1
            if interval < MIN_REPEAT_MS:
                errs.append(f"repeat.interval_ms 必须 ≥{MIN_REPEAT_MS}：{r.get('interval_ms')!r}")
            try:
                count = int(r.get("count", 0))
            except (TypeError, ValueError):
                count = -1
            if count < 0:
                errs.append(f"repeat.count 必须 ≥0（0 = 直到手动停止）：{r.get('count')!r}")
            repeat = {"interval_ms": max(MIN_REPEAT_MS, interval),
                      "count": max(0, count)}

    if errs:
        return None, errs
    out = {
        "id": wid, "label": label,
        "group": str(w.get("group") or ""),
        "confirm": bool(w.get("confirm")),
        "format": fmt, "eol": eol,
        "params": params, "steps": steps,
        "repeat": repeat,
    }
    return out, []


# ══════════════════════════════════════════════════════════════════
#  参数求值 / 模板渲染
# ══════════════════════════════════════════════════════════════════
def _coerce_param(p: dict, raw):
    """把一个用户输入值转成类型化值；不合法抛 ``ValueError``。"""
    name, t = p["name"], p["type"]
    if t == "int":
        if isinstance(raw, bool):
            raise ValueError("不接受布尔值")
        try:
            v = int(str(raw).strip(), 10) if isinstance(raw, str) else int(raw)
        except (TypeError, ValueError):
            raise ValueError(f"不是整数：{raw!r}")
        if "min" in p and v < p["min"]:
            raise ValueError(f"{v} < 最小值 {p['min']:g}")
        if "max" in p and v > p["max"]:
            raise ValueError(f"{v} > 最大值 {p['max']:g}")
        return v
    if t == "float":
        if isinstance(raw, bool):
            raise ValueError("不接受布尔值")
        try:
            v = float(raw)
        except (TypeError, ValueError):
            raise ValueError(f"不是数字：{raw!r}")
        if not math.isfinite(v):
            raise ValueError("不接受 NaN / Inf")
        if "min" in p and v < p["min"]:
            raise ValueError(f"{v:g} < 最小值 {p['min']:g}")
        if "max" in p and v > p["max"]:
            raise ValueError(f"{v:g} > 最大值 {p['max']:g}")
        return round(v, int(p.get("decimals", 3)))
    if t == "bool":
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, (int, float)) and raw in (0, 1):
            return bool(raw)
        s = str(raw).strip().lower()
        if s in ("1", "true", "yes", "on"):
            return True
        if s in ("0", "false", "no", "off"):
            return False
        raise ValueError(f"不是布尔值：{raw!r}（可为 1/0、true/false）")
    if t == "enum":
        s = str(raw)
        values = [o["value"] for o in p.get("options") or []]
        if s not in values:
            raise ValueError(f"{s!r} 不在可选项 {values} 内")
        return s
    if t == "string":
        if not isinstance(raw, str):
            raise ValueError("必须是字符串")
        if "\r" in raw or "\n" in raw:
            raise ValueError("不能包含 CR/LF（一条组件只发一行）")
        if len(raw) > int(p.get("max_len") or 256):
            raise ValueError(f"长度 {len(raw)} 超过上限 {p.get('max_len')}")
        pat = p.get("pattern")
        if pat and re.search(pat, raw) is None:
            raise ValueError(f"不匹配 pattern {pat!r}")
        return raw
    if t == "hex":
        s = "".join(str(raw).split())
        try:
            data = bytes.fromhex(s)
        except ValueError:
            raise ValueError(f"不是合法十六进制：{raw!r}")
        width = int(p.get("width") or 1)
        if len(data) != width:
            raise ValueError(f"需要 {width} 字节（{width * 2} 个十六进制位），实际 {len(data)} 字节")
        if p.get("endian") == "le":
            data = bytes(reversed(data))
        return "".join(f"{b:02X}" for b in data)
    raise ValueError(f"未知参数类型：{t}")


def resolve_params(widget: dict, values: dict | None) -> tuple[dict, list[str]]:
    """把请求里的参数值合并默认值并校验。返回 ``(typed_values, errors)``。"""
    vals: dict = {}
    errs: list[str] = []
    if values is None:
        values = {}
    if not isinstance(values, dict):
        return {}, ["params 必须是对象"]
    known = {p["name"] for p in widget.get("params") or []}
    for key in values:
        if key not in known:
            errs.append(f"未知参数：{key!r}")
    for p in widget.get("params") or []:
        name = p["name"]
        raw = values.get(name, p.get("default"))
        try:
            vals[name] = _coerce_param(p, raw)
        except ValueError as exc:
            errs.append(f"{p.get('label') or name}（{name}）：{exc}")
    return vals, errs


def _render_value(p: dict, value) -> str:
    t = p["type"]
    if t == "float":
        return f"{float(value):.{int(p.get('decimals', 3))}f}"
    if t == "int":
        if p.get("render") == "hex":
            return f"{int(value):0{int(p.get('width') or 2)}X}"
        return str(int(value))
    if t == "bool":
        return str(p.get("true_value", "1") if value else p.get("false_value", "0"))
    if t == "enum":
        return str(value)
    return str(value)                               # string / hex 已归一化


def render_text(template: str, vals: dict, params: list[dict]) -> tuple[str, str]:
    """``{{name}}`` 替换；``\\{{`` 是字面量 ``{{``。返回 ``(text, error)``。"""
    defs = {p["name"]: p for p in params}
    out: list[str] = []
    i, n = 0, len(template)
    while i < n:
        if template.startswith("\\{{", i):
            out.append("{{")
            i += 3
            continue
        if template.startswith("{{", i):
            j = template.find("}}", i + 2)
            if j < 0:
                return "", f"模板占位符未闭合：{template[i:i + 20]!r}"
            name = template[i + 2:j].strip()
            p = defs.get(name)
            if p is None:
                return "", f"未声明的占位符 {{{{{name}}}}}"
            out.append(_render_value(p, vals[name]))
            i = j + 2
            continue
        out.append(template[i])
        i += 1
    return "".join(out), ""


# ══════════════════════════════════════════════════════════════════
#  预览 / 执行
# ══════════════════════════════════════════════════════════════════
def _plan(widget: dict, params: dict | None) -> dict:
    """把组件展开成待执行步骤。只渲染，不写口（预览与执行共用这一处）。"""
    vals, errs = resolve_params(widget, params)
    if errs:
        return {"ok": False, "stage": "validate", "error": "；".join(errs)}
    exec_steps: list[dict] = []
    send_steps: list[dict] = []
    deferred: list[dict] = []
    total = 0
    for i, s in enumerate(widget["steps"]):
        if s["kind"] == "send":
            text, rerr = render_text(s["text"], vals, widget["params"])
            if rerr:
                return {"ok": False, "stage": "validate",
                        "error": f"第 {i + 1} 步：{rerr}"}
            payload, perr = st.build_payload(text, format=s["format"], eol=s["eol"])
            if perr:
                return {"ok": False, "stage": "validate",
                        "error": f"第 {i + 1} 步：{perr}"}
            step = {"i": i + 1, "kind": "send", "text": text,
                    "format": s["format"], "eol": s["eol"],
                    "payload": payload, "bytes": len(payload)}
            exec_steps.append(step)
            send_steps.append(step)
            total += len(payload)
            continue
        deferred.append({"i": i + 1, "kind": s["kind"]})
        if s["kind"] == "delay":
            exec_steps.append({"i": i + 1, "kind": "delay", "ms": s["ms"]})
        else:
            exec_steps.append({"i": i + 1, "kind": "wait",
                               "within_s": s["within_s"],
                               "match": dict(s["match"])})
    return {"ok": True, "params": vals, "steps": send_steps,
            "exec_steps": exec_steps, "deferred": deferred, "bytes": total}


def _public_steps(steps: list[dict]) -> list[dict]:
    return [{k: v for k, v in s.items() if k != "payload"} for s in steps]


def _preview_payload(plan: dict) -> dict:
    data = b"".join(s["payload"] for s in plan["steps"])
    return {"preview_b64": base64.b64encode(data).decode("ascii"),
            "bytes": len(data), "steps": _public_steps(plan["steps"])}


def preview(cfg: Config, project: str, wid: str, params: dict | None = None) -> dict:
    """``dry_run``：只渲染并返回字节，不占口、不写口。"""
    doc = load(cfg, project)
    if doc.get("error"):
        return {"ok": False, "stage": "validate", "error": doc["error"]}
    w = _find(doc, wid)
    if w is None:
        return {"ok": False, "stage": "validate",
                "error": f"组件不存在：{wid!r}（工程 {project}）"}
    plan = _plan(w, params)
    if not plan["ok"]:
        return plan
    return {"ok": True, "id": wid, "dry_run": True, **{
        k: plan[k] for k in ("params", "deferred")}, **_preview_payload(plan)}


# ══════════════════════════════════════════════════════════════════
#  任务（M2）：后台线程 + 轮询状态 + 取消 / 暂停
# ══════════════════════════════════════════════════════════════════
def _remember(job: dict) -> None:
    with _JOBS_LOCK:
        _JOBS[job["id"]] = job
        _JOB_ORDER.append(job["id"])
        # 只回收已经结束的任务：正在跑的任务被挤出，人就没法再查/取消了。
        while len(_JOB_ORDER) > MAX_JOBS:
            idx = next((i for i, jid in enumerate(_JOB_ORDER)
                        if _JOBS.get(jid, {}).get("state")
                        not in ("running", "paused", "cancelling")), None)
            if idx is None:
                break
            old = _JOB_ORDER.pop(idx)
            _JOBS.pop(old, None)


def _push_step(job: dict, rec: dict) -> None:
    """步骤记录有上限：超出丢最旧的，但丢了多少要能看见。"""
    job["steps"].append(rec)
    while len(job["steps"]) > MAX_JOB_STEPS:
        job["steps"].pop(0)
        job["steps_dropped"] = int(job.get("steps_dropped") or 0) + 1


def _paused(job: dict) -> bool:
    return bool(job.get("paused"))


def _sleep_step(job: dict, seconds: float) -> bool:
    """可取消 / 可暂停的延时。返回 ``False`` 表示被取消（暂停会延长剩余量）。"""
    remaining = max(0.0, float(seconds))
    while remaining > 0:
        if job["cancel"]:
            return False
        if _paused(job):
            time.sleep(0.05)
            continue
        slice_s = min(0.05, remaining)
        time.sleep(slice_s)
        remaining -= slice_s
    return True


def _text_matches(kind: str, value: str, text: str) -> bool:
    if kind == "regex":
        return re.search(value, text) is not None
    if kind == "contains":
        return value in text
    return text.strip() == value                      # exact


def _wait_step(job: dict, step: dict, cursors: dict) -> dict:
    """在监视流里等一行/一段字节。

    ★ 行与字节是**两套序号空间**（``tail`` 的 seq / ``tail_bytes`` 的 chunk_seq），
      各自推进各自游标；把行号当 chunk 游标用会直接漏掉回显。
    """
    spec = step["match"]
    kind, value = spec["kind"], spec["value"]
    deadline = time.monotonic() + float(step["within_s"])
    carried_hex = ""
    while True:
        now = time.monotonic()
        if now >= deadline:
            break
        if job["cancel"]:
            return {"ok": False, "matched": False, "error": "任务已取消"}
        if _paused(job):
            # 暂停不烧超时预算：睡多久就把 deadline 往后推多久。
            t0 = time.monotonic()
            time.sleep(0.05)
            deadline += time.monotonic() - t0
            continue
        if not sm.status().get("active"):
            return {"ok": False, "matched": False,
                    "error": "监视会话已结束 —— wait 需要连续的 RX 流"}
        if kind == "hex":
            tail = sm.tail_bytes(cursors["byte"], direction="rx")
            for c in tail.get("chunks") or []:
                cursors["byte"] = max(cursors["byte"], int(c.get("seq") or 0))
                raw = base64.b64decode(c.get("data_b64") or "")
                hexs = raw.hex().upper()
                if value in (carried_hex + hexs):
                    return {"ok": True, "matched": True,
                            "text": hexs, "pattern": value}
                carried_hex = (carried_hex + hexs)[-512:]
        else:
            tail = sm.tail(cursors["line"])
            for ln in tail.get("lines") or []:
                cursors["line"] = max(cursors["line"], int(ln.get("seq") or 0))
                text = str(ln.get("text") or "")
                if _text_matches(kind, value, text):
                    return {"ok": True, "matched": True,
                            "text": text, "pattern": value}
        time.sleep(0.05)
    return {"ok": False, "matched": False, "timeout": True, "pattern": value,
            "error": f"等待超时（{step['within_s']:g}s 内没有匹配 {kind}:{value}）"}


def _send_step(cfg: Config, project: str, via_label: str, params: dict,
               step: dict, journal, log) -> dict:
    """执行一条 send 步（与手写发送共用写穿 / 无状态往返两条路径）。"""
    t0 = time.perf_counter()
    err = None
    via = "monitor"
    port, baud = "", 0
    n = sm.write_through(step["payload"])
    if n is None:
        via = "roundtrip"
        res = st.roundtrip(
            cfg, project, data=step["text"], read_ms=0,
            format=step["format"], eol=step["eol"],
            journal=(None if journal is None else (lambda rec: journal({
                **rec, "via": via_label, "params": params}))),
            log=log)
        n = int(res.get("written") or 0)
        ok = bool(res.get("ok"))
        err = res.get("error")
        port, baud = res.get("port") or "", res.get("baud") or 0
    else:
        ok = n == len(step["payload"])
        st_ok = sm.status()
        port, baud = st_ok.get("port") or "", st_ok.get("baud") or 0
        if not ok:
            err = "只写出部分字节（口可能已失效，试试关闭重开监视）"
        if journal is not None:
            try:
                journal({"dir": "tx", "text": step["text"], "ok": ok,
                         "written": n, "payload_bytes": len(step["payload"]),
                         "via": via_label, "params": params,
                         "format": step["format"], "port": port,
                         "baud": baud, "error": err})
            except Exception as exc:        # noqa: BLE001
                log(f"[serialwidgets] 写 console 日志失败（不影响结果）：{exc}")
    return {"ok": ok, "n": n, "err": err, "via": via, "port": port, "baud": baud,
            "i": step["i"], "kind": "send", "text": step["text"],
            "t_ms": round((time.perf_counter() - t0) * 1000, 1)}


def _run_round(cfg: Config, project: str, via_label: str, plan: dict,
               job: dict, journal, log, rnd: int) -> bool:
    """跑一轮全部步骤。返回 ``False`` 表示失败或取消（错误已写进 job）。"""
    # 游标在**本轮发送之前**建立：wait 只看这一轮之后的 RX，不会命中旧数据。
    cursors = {"line": int(sm.tail(0).get("seq") or 0),
               "byte": int(sm.tail_bytes(0).get("chunk_seq") or 0)}
    for step in plan["exec_steps"]:
        if job["cancel"]:
            return False
        while _paused(job) and not job["cancel"]:
            time.sleep(0.05)
        if step["kind"] == "send":
            res = _send_step(cfg, project, via_label, job["params"], step, journal, log)
            rec = {k: res[k] for k in ("i", "kind", "ok", "t_ms", "text", "via")}
            rec.update({"round": rnd, "bytes": res["n"], "error": res["err"]})
            _push_step(job, rec)
            job["total_bytes"] += res["n"]
            job["last_port"] = res["port"]
            job["last_baud"] = res["baud"]
            job["last_via"] = res["via"]
            if not res["ok"]:
                job["error"] = res["err"] or "写口失败"
                return False
        elif step["kind"] == "delay":
            t0 = time.perf_counter()
            ok = _sleep_step(job, float(step["ms"]) / 1000)
            rec = {"i": step["i"], "kind": "delay", "round": rnd, "ok": ok,
                   "t_ms": round((time.perf_counter() - t0) * 1000, 1),
                   "ms": step["ms"],
                   "error": None if ok else "任务已取消"}
            _push_step(job, rec)
            if not ok:
                job["error"] = "任务已取消"
                return False
        else:
            t0 = time.perf_counter()
            wr = _wait_step(job, step, cursors)
            rec = {"i": step["i"], "kind": "wait", "round": rnd,
                   "ok": bool(wr.get("ok")), "matched": bool(wr.get("matched")),
                   "t_ms": round((time.perf_counter() - t0) * 1000, 1),
                   "text": wr.get("text"), "match": step["match"],
                   "error": wr.get("error")}
            _push_step(job, rec)
            if not wr.get("ok"):
                job["error"] = wr.get("error") or "等待失败"
                return False
    return True


def _job_main(cfg: Config, project: str, via_label: str, plan: dict, job: dict,
              repeat_cfg: dict | None, journal, log) -> None:
    state = "done"
    started = time.monotonic()
    max_s = MAX_REPEAT_S if repeat_cfg else MAX_RUN_S
    deadline = started + max_s
    interval = (repeat_cfg["interval_ms"] / 1000.0) if repeat_cfg else 0.0
    count = int(repeat_cfg["count"]) if repeat_cfg else 1
    rounds = 0
    next_at = started
    try:
        while True:
            if job["cancel"]:
                state = "cancelled"
                break
            now = time.monotonic()
            if now >= deadline:
                job["stop_reason"] = "max_duration"
                break
            if repeat_cfg:
                if now < next_at and not _sleep_step(job, next_at - now):
                    state = "cancelled"
                    break
                now = time.monotonic()
                # 固定节拍不重叠：上一轮超时 → 错过的节拍只记 skipped，不补发。
                # 只统计**严格早于 now** 的节拍；now 这一拍马上就要跑。
                if now >= next_at + interval:
                    missed = int((now - next_at) / interval)
                    job["skipped"] = int(job.get("skipped") or 0) + missed
                    next_at += missed * interval
            while _paused(job) and not job["cancel"]:
                time.sleep(0.05)
            if job["cancel"]:
                state = "cancelled"
                break
            ok = _run_round(cfg, project, via_label, plan, job, journal, log, rounds + 1)
            rounds += 1
            job["rounds"] = rounds
            if not ok:
                state = "cancelled" if job["cancel"] else "failed"
                break
            if not repeat_cfg:
                break
            if count and rounds >= count:
                break
            next_at += interval
    except Exception as exc:                            # noqa: BLE001
        job["error"] = f"{type(exc).__name__}: {exc}"
        state = "failed"
        log(f"[serialwidgets] 组件任务异常：{exc}")
    finally:
        job["state"] = state
        job["finished_at"] = round(time.time(), 3)
        _JOB_LOCK.release()


def _job_result(job: dict) -> dict:
    preview_steps = job.get("preview_steps") or []
    error = job.get("error")
    if job["state"] == "cancelled":
        error = error or "任务已取消"
    elif job["state"] != "done" and error is None:
        error = "执行失败"
    return {
        "ok": job["state"] in ("done", "running", "paused", "cancelling"),
        "accepted": job["state"] in ("running", "paused", "cancelling"),
        "id": job["widget"], "job_id": job["id"], "state": job["state"],
        "source": job.get("source") or "widget",
        "label": job.get("label") or "",
        "actor": job.get("actor"), "params": job.get("params") or {},
        "rounds": int(job.get("rounds") or 0),
        "skipped": int(job.get("skipped") or 0),
        "repeat": job.get("repeat"),
        "steps": list(job.get("steps") or []),
        "steps_dropped": int(job.get("steps_dropped") or 0),
        "total_bytes": int(job.get("total_bytes") or 0),
        "bytes": int(job.get("preview_bytes") or 0),
        "preview_b64": job.get("preview_b64") or "",
        "preview_steps": preview_steps,
        "port": job.get("last_port") or "", "baud": job.get("last_baud") or 0,
        "via": job.get("last_via") or "",
        "stop_reason": job.get("stop_reason"),
        "error": error,
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
    }


def run(cfg: Config, project: str, wid: str, params: dict | None = None, *,
        dry_run: bool = False, repeat: bool = False, confirm: bool = False,
        actor: str = "human", journal=None, log=print) -> dict:
    """启动组件任务。

    ``repeat=True`` 时按组件自带的 ``repeat`` 跑周期（没有配置则拒绝）；
    ``dry_run`` 只渲染。序列/周期在后台线程执行，HTTP 用 ``job_status`` 轮询；
    这里最多等 2s，快任务（单条发送）仍直接返回完整结果。
    """
    if dry_run:
        return preview(cfg, project, wid, params)
    doc = load(cfg, project)
    if doc.get("error"):
        return {"ok": False, "stage": "validate", "error": doc["error"]}
    w = _find(doc, wid)
    if w is None:
        return {"ok": False, "stage": "validate",
                "error": f"组件不存在：{wid!r}（工程 {project}）"}
    if w.get("confirm") and not confirm:
        return {"ok": False, "stage": "validate",
                "error": f"组件「{w['label']}」需要 confirm=true 才能执行"}
    repeat_cfg = w.get("repeat") if repeat else None
    if repeat and repeat_cfg is None:
        return {"ok": False, "stage": "validate",
                "error": f"组件「{w['label']}」没有配置 repeat，不能周期发送"}
    plan = _plan(w, params)
    if not plan["ok"]:
        return plan
    return _start_job(cfg, project, wid, w["label"], "widget", plan, repeat_cfg,
                      journal=journal, actor=actor, log=log)


def _start_job(cfg: Config, project: str, wid: str, label: str, source: str,
               plan: dict, repeat_cfg: dict | None, *, journal=None,
               actor: str = "human", log=print) -> dict:
    """组件任务与「发送框定时发送」共用的启动逻辑。

    ``source`` 只影响留档标签与 job 的 ``source`` 字段（``widget`` / ``raw``）；
    锁、节拍、暂停/取消、超时全部同一套 —— 两条发送入口不允许出现两套周期语义。
    """
    has_wait = any(s["kind"] == "wait" for s in plan["exec_steps"])
    if has_wait and not sm.status().get("active"):
        return {"ok": False, "stage": "validate",
                "error": ("组件含 wait 步，必须先在串口区打开监视（连续 RX 才能等到回显）；"
                          "单条/纯延时组件不需要")}
    if not _JOB_LOCK.acquire(blocking=False):
        return {"ok": False, "stage": "busy",
                "error": "已有周期/组件任务在跑 —— 它占用串口，等它结束或先取消"}

    meta = _preview_payload(plan)
    jid = f"{'r' if source == 'raw' else 'w'}{int(time.time() * 1000):x}-{wid}"
    job = {"id": jid, "widget": wid, "label": label, "source": source,
           "project": project, "state": "running", "actor": actor,
           "params": plan["params"], "started_at": round(time.time(), 3),
           "steps": [], "total_bytes": 0, "cancel": False, "paused": False,
           "skipped": 0, "rounds": 0,
           "repeat": repeat_cfg,
           "preview_b64": meta["preview_b64"], "preview_bytes": meta["bytes"],
           "preview_steps": meta["steps"], "last_port": "", "last_baud": 0,
           "last_via": ""}
    _remember(job)
    via_label = "raw-loop" if source == "raw" else f"widget:{wid}"
    th = threading.Thread(target=_job_main,
                          args=(cfg, project, via_label, plan, job, repeat_cfg,
                                journal, log), daemon=True, name=f"{source}-{jid}")
    th.start()
    th.join(2.0)
    return _job_result(job)


def run_raw(cfg: Config, project: str, data: str, *, newline: bool = True,
            hex_: bool = False, format: str | None = None,
            eol: str | None = None, encoding: str | None = None,
            interval_ms: int | None = None, count: int = 0,
            actor: str = "human", journal=None, log=print,
            dry_run: bool = False) -> dict:
    """「发送框定时发送」：把一段自由帧当成瞬态任务跑，**不落盘**。

    ``interval_ms`` 为空 = 单次发送；给了就是周期（``count=0`` 直到手动停止，
    仍受 ``MAX_REPEAT_S`` 上限约束）。编码/行尾与 ``POST /api/serial`` 共用
    ``serialterm.resolve_payload``，预览与实发因此天然一致。
    """
    payload, rfmt, reol, perr = st.resolve_payload(
        data, newline=newline, hex_=hex_, format=format, eol=eol,
        encoding=encoding)
    if perr:
        return {"ok": False, "stage": "validate", "error": perr}

    repeat_cfg = None
    if interval_ms is not None:
        try:
            interval_ms = int(interval_ms)
        except (TypeError, ValueError):
            return {"ok": False, "stage": "validate",
                    "error": f"interval_ms 必须是整数：{interval_ms!r}"}
        if interval_ms < MIN_REPEAT_MS:
            return {"ok": False, "stage": "validate",
                    "error": f"发送间隔不能小于 {MIN_REPEAT_MS}ms（当前 {interval_ms}ms）"}
        if interval_ms > MAX_REPEAT_S * 1000:
            return {"ok": False, "stage": "validate",
                    "error": f"发送间隔不能大于 {MAX_REPEAT_S * 1000}ms"}
        try:
            count = int(count)
        except (TypeError, ValueError):
            return {"ok": False, "stage": "validate",
                    "error": f"count 必须是整数：{count!r}"}
        if count < 0:
            return {"ok": False, "stage": "validate", "error": "count 不能为负数"}
        repeat_cfg = {"interval_ms": interval_ms, "count": count}

    step = {"i": 1, "kind": "send", "text": data, "format": rfmt, "eol": reol,
            "payload": payload, "bytes": len(payload)}
    plan = {"ok": True, "params": {}, "steps": [step], "exec_steps": [step],
            "deferred": [], "bytes": len(payload), "format": rfmt, "eol": reol}

    if dry_run:
        meta = _preview_payload(plan)
        return {"ok": True, "dry_run": True, "bytes": meta["bytes"],
                "preview_b64": meta["preview_b64"], "preview_hex": payload.hex(" ").upper(),
                "format": rfmt, "eol_key": reol,
                "steps": meta["steps"]}

    return _start_job(cfg, project, f"raw.{int(time.time() * 1000):x}",
                      "发送框", "raw", plan, repeat_cfg,
                      journal=journal, actor=actor, log=log)


def job_status(job_id: str = "") -> dict | None:
    """``job_id`` 为空时返回当前未结束的任务（面板刷新后也能找回）。

    ★ 与 ``run()`` 返回**同一形状**（``_job_result``）：面板/工具只认一套字段，
      不需要为"启动响应"和"轮询响应"写两套解析。
    """
    with _JOBS_LOCK:
        if not job_id:
            job_id = next((jid for jid in reversed(_JOB_ORDER)
                           if _JOBS.get(jid, {}).get("state")
                           in ("running", "paused", "cancelling")), "")
        job = _JOBS.get(job_id)
        if job is None:
            return None
        # ★ 持锁快照 steps：执行线程还在追加，直接给出去会让 json 编码撞上变动。
        snap = {**job, "steps": list(job.get("steps") or [])}
    return _job_result(snap)


def cancel(job_id: str) -> dict:
    """取消任务：只置标志位，线程在步间 / 延时 / 等待里自行退出。"""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return {"ok": False, "error": f"没有这个组件任务：{job_id!r}"}
        if job["state"] in ("running", "paused"):
            job["cancel"] = True
            job["paused"] = False
            job["state"] = "cancelling"
            return {"ok": True, "id": job_id, "state": "cancelling"}
        return {"ok": True, "id": job_id, "state": job["state"]}


def set_paused(job_id: str, paused: bool) -> dict:
    """暂停 / 恢复。暂停只挡发送（节拍照常走，停掉的节拍记 skipped）。"""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return {"ok": False, "error": f"没有这个组件任务：{job_id!r}"}
        if job["state"] not in ("running", "paused"):
            return {"ok": True, "id": job_id, "state": job["state"]}
        job["paused"] = bool(paused)
        job["state"] = "paused" if paused else "running"
        return {"ok": True, "id": job_id, "state": job["state"],
                "paused": bool(paused)}


def save(cfg: Config, project: str, widget: dict, rev: int) -> dict:
    """保存（新增或替换）一个组件。``rev`` 不匹配 → ``conflict``（调用方 409）。"""
    doc = load(cfg, project)
    if doc.get("error"):
        raise ElabError(f"组件文件当前不可写：{doc['error']}")
    if int(doc["rev"]) != int(rev):
        return {"ok": False, "conflict": True, "rev": doc["rev"],
                "widgets": doc["widgets"], "warnings": doc["warnings"],
                "error": (f"rev 不匹配（请求 {rev}，当前 {doc['rev']}）—— "
                          f"配置已被他人修改，请重读后再保存")}
    norm, errs = normalize_widget(widget)
    if errs:
        raise ElabError("组件不合法：" + "；".join(errs))
    assert norm is not None
    widgets = list(doc["widgets"])
    idx = next((i for i, w in enumerate(widgets) if w["id"] == norm["id"]), None)
    if idx is None:
        if len(widgets) >= MAX_WIDGETS:
            raise ElabError(f"组件数已达上限 {MAX_WIDGETS}")
        widgets.append(norm)
    else:
        widgets[idx] = norm
    _write(cfg, project, widgets, doc["rev"] + 1)
    return load(cfg, project)


def delete(cfg: Config, project: str, wid: str, rev: int) -> dict:
    """删除一个组件。正在运行的组件不可删（先 cancel）——避免"删了还在发"。"""
    doc = load(cfg, project)
    if doc.get("error"):
        raise ElabError(f"组件文件当前不可写：{doc['error']}")
    if int(doc["rev"]) != int(rev):
        return {"ok": False, "conflict": True, "rev": doc["rev"],
                "widgets": doc["widgets"], "warnings": doc["warnings"],
                "error": (f"rev 不匹配（请求 {rev}，当前 {doc['rev']}）—— "
                          f"配置已被他人修改，请重读后再删除")}
    if _find(doc, wid) is None:
        raise ElabError(f"组件不存在：{wid!r}")
    with _JOBS_LOCK:
        running = any(j["state"] in ("running", "paused", "cancelling")
                      and j["widget"] == wid for j in _JOBS.values())
    if running:
        raise ElabError(f"组件「{wid}」正在运行 —— 先取消任务再删除")
    widgets = [w for w in doc["widgets"] if w["id"] != wid]
    _write(cfg, project, widgets, doc["rev"] + 1)
    return load(cfg, project)


def meta() -> dict:
    """内核自描述：工具层/前端只渲染这里的词汇与限制。"""
    return {
        "schema": 1,
        "param_types": list(PARAM_TYPES),
        "step_kinds": list(STEP_KINDS),
        "match_kinds": list(MATCH_KINDS),
        "features": {"sequence": True, "repeat": True, "pause": True,
                     "agent": True, "preview": True,
                     # 发送框的瞬态周期任务（不落盘）：与组件共享同一个任务引擎
                     "raw_loop": True},
        "limits": {"max_widgets": MAX_WIDGETS, "max_steps": MAX_STEPS,
                   "max_params": MAX_PARAMS, "max_template": MAX_TEMPLATE,
                   "max_file_bytes": MAX_FILE_BYTES,
                   "min_repeat_ms": MIN_REPEAT_MS,
                   "max_job_steps": MAX_JOB_STEPS,
                   "max_run_s": MAX_RUN_S, "max_repeat_s": MAX_REPEAT_S},
    }
