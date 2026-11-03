"""elab.svd —— CMSIS-SVD 解析（P2 外设视图）。

★ 分层：这里**只有**通用 SVD 协议知识，**不认识**任何厂商/芯片。文件路径由
:class:`elab.plan.DebugProfile` 从 ``chip.debug.svd`` + host ``svd_roots`` 解析后传入。

对外形状（ICD）：``GET /api/debug/peripherals``

- ``path=""``      → 外设清单（不含寄存器，避免一次吐几十 KB）
- ``path="GPIOA"`` → 该外设寄存器清单
- ``path="GPIOA.ODR"`` + ``read=1`` → 寄存器值 + 字段解码

``tree()`` 是纯函数；读目标内存在回调 ``read_bytes(addr, size)`` 里完成，
便于单测用合成 XML 覆盖（见 ``tests/test_svd.py``）。
"""

from __future__ import annotations

import os
import threading
import xml.etree.ElementTree as ET
from collections import OrderedDict

_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_CACHE_MAX = 4
_LOCK = threading.RLock()


def _tag(e) -> str:
    return e.tag.rsplit("}", 1)[-1] if isinstance(e.tag, str) else ""


def _find(e, name: str):
    for child in e:
        if _tag(child) == name:
            return child
    return None


def _findall(e, name: str) -> list:
    return [c for c in e if _tag(c) == name]


def _p_register_box(p):
    box = _find(p, "registers")
    return p if box is None else box


def _text(e, name: str, default: str = "") -> str:
    node = _find(e, name)
    if node is None or node.text is None:
        return default
    return node.text.strip()


def _desc(e) -> str:
    return " ".join(_text(e, "description").split())


def _int(v: str, default: int = 0) -> int:
    try:
        return int(str(v).strip(), 0)
    except (TypeError, ValueError):
        return default


def parse(path: str) -> dict:
    """解析 SVD XML（不认厂商；derivedFrom 仅做寄存器继承）。"""
    root = ET.parse(path).getroot()
    dev_node = _find(root, "device")
    device = root if dev_node is None else dev_node
    name = _text(device, "name") or os.path.basename(path)
    periphs: list[dict] = []
    raw: dict[str, dict] = {}
    periph_box = _find(device, "peripherals")
    for p in _findall(device if periph_box is None else periph_box, "peripheral"):
        pname = _text(p, "name")
        if not pname:
            continue
        item = {
            "name": pname,
            "base": _int(_text(p, "baseAddress")),
            "group": _text(p, "groupName") or pname,
            "description": _desc(p),
            "derivedFrom": p.get("derivedFrom") or "",
            "registers": [_register(r) for r in
                          _findall(_p_register_box(p), "register")],
        }
        raw[pname] = item
        periphs.append(item)
    # derivedFrom：只继承 registers（STM32 系列常见 GPIOB..E derivedFrom GPIOA）
    for item in periphs:
        src = item.get("derivedFrom") or ""
        guard = 0
        while src and not item["registers"] and src in raw and guard < 8:
            item["registers"] = [dict(r) for r in raw[src]["registers"]]
            src = raw[src].get("derivedFrom") or ""
            guard += 1
    for item in periphs:
        item.pop("derivedFrom", None)
        item["registers"].sort(key=lambda r: r["offset"])
    return {"name": name, "file": path, "peripherals": periphs,
            "by_name": {p["name"]: p for p in periphs}}


def _register(r) -> dict:
    fields = []
    fgroup = _find(r, "fields")
    if fgroup is not None:
        for f in _findall(fgroup, "field"):
            enums = []
            ev = _find(f, "enumeratedValues")
            if ev is not None:
                for val in _findall(ev, "enumeratedValue"):
                    enums.append({"name": _text(val, "name"),
                                  "value": _int(_text(val, "value"), -1),
                                  "description": _desc(val)})
            offset = _int(_text(f, "bitOffset", ""), -1)
            if offset < 0:
                offset = _int(_text(f, "lsb", ""), -1)
            width = _int(_text(f, "bitWidth", ""), -1)
            if width < 0:
                width = _int(_text(f, "msb", ""), -1) - offset + 1 if offset >= 0 else 0
            fields.append({"name": _text(f, "name"), "offset": max(0, offset),
                           "width": max(0, width), "description": _desc(f),
                           "enums": enums})
    return {
        "name": _text(r, "name"),
        "offset": _int(_text(r, "addressOffset")),
        "size": _int(_text(r, "size"), 32),
        "access": _text(r, "access") or "read-write",
        "description": _desc(r),
        "reset": _text(r, "resetValue"),
        "fields": fields,
    }


def load(path: str) -> dict:
    """按 (绝对路径, mtime, size) 缓存 4 份；文件变化自动失效。"""
    ap = os.path.abspath(path)
    try:
        st = os.stat(ap)
    except OSError:
        raise FileNotFoundError(path)
    key = (ap, st.st_mtime_ns, st.st_size)
    with _LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    try:
        model = parse(ap)
    except ET.ParseError as exc:
        raise ValueError(f"非法 CMSIS-SVD：{exc}")
    with _LOCK:
        _CACHE[key] = model
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return model


def _field_value(raw: int, field: dict) -> int:
    return (raw >> field["offset"]) & ((1 << field["width"]) - 1)


def _decode_fields(raw: int, fields: list[dict]) -> list[dict]:
    out = []
    for f in fields:
        w = f["width"]
        if w <= 0:
            continue
        val = _field_value(raw, f)
        enum = None
        for e in f["enums"]:
            if e["value"] == val:
                enum = {"name": e["name"], "value": val,
                        "description": e["description"]}
                break
        out.append({"name": f["name"], "bits": f"{f['offset'] + w - 1}-{f['offset']}",
                    "offset": f["offset"], "width": w, "value": val,
                    "hex": hex(val), "enum": enum,
                    "description": f["description"]})
    return out


def tree(model: dict, path: str = "", *, read_bytes=None) -> dict:
    """懒加载树：外设 → 寄存器 → （读值时）字段。

    ``read_bytes(addr, size) -> bytes|None``；只读取寄存器本身，不越界。
    找不到 path → ``KeyError``（端点转 ``debug-bad-request``）。
    """
    path = (path or "").strip().strip(".")
    if not path:
        return {"device": model["name"], "level": "device", "peripherals": [
            {"name": p["name"], "base": hex(p["base"]), "group": p["group"],
             "description": p["description"],
             "registers_count": len(p["registers"])}
            for p in model["peripherals"]]}

    parts = path.split(".")
    pname = parts[0]
    periph = model["by_name"].get(pname)
    if periph is None:
        raise KeyError(f"未知外设：{pname}")
    base = periph["base"]

    if len(parts) == 1:
        return {"device": model["name"], "level": "peripheral", "peripheral": {
            "name": periph["name"], "base": hex(base), "group": periph["group"],
            "description": periph["description"],
            "registers": [{"name": r["name"], "offset": hex(r["offset"]),
                           "addr": hex(base + r["offset"]), "size": r["size"],
                           "access": r["access"], "description": r["description"],
                           "fields_count": len(r["fields"])}
                          for r in periph["registers"]]}}

    if len(parts) != 2:
        raise KeyError(f"路径必须为 PERIPH 或 PERIPH.REG：{path!r}")
    rname = parts[1]
    reg = next((r for r in periph["registers"] if r["name"] == rname), None)
    if reg is None:
        raise KeyError(f"未知寄存器：{pname}.{rname}")
    size_bytes = max(1, min(4, (reg["size"] + 7) // 8))
    addr = base + reg["offset"]
    value = None
    if read_bytes is not None:
        data = read_bytes(addr, size_bytes)
        if data:
            value = int.from_bytes(data[:size_bytes], "little")
    reg_out = {"name": reg["name"], "offset": hex(reg["offset"]),
               "addr": hex(addr), "size": reg["size"], "access": reg["access"],
               "description": reg["description"], "reset": reg["reset"],
               "value": None if value is None else hex(value),
               "fields": _decode_fields(value, reg["fields"]) if value is not None else []}
    return {"device": model["name"], "level": "register", "peripheral": {
        "name": periph["name"], "base": hex(base)}, "register": reg_out}
