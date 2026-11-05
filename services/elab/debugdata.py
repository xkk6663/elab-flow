"""elab.debugdata —— 把 MI 结果整形为面板/Agent 直接可渲染的 JSON。

设计依据：``docs/design/技术方案_调试面板复刻cortex-debug.md`` §6.5 / §7.1。

**纯函数为主**：输入是 :mod:`elab.gdbmi` 解析后的记录，输出是普通 dict。
需要多步 MI 的整形（变量树）放在 ``DebugSession`` 里编排，这里只做单步解析。
"""

from __future__ import annotations

import re
import struct

#: FPU 寄存器名（**白名单**，不是"以 s/d/q/f/v 开头"—— 否则 ``faultmask`` 这种
#: Cortex-M 系统寄存器会被错分到 FPU 组，M3 上就凭空多出一个 FPU 页签）。
_FPU_NAME_RE = re.compile(
    r"^(?:s(?:[0-9]|[12][0-9]|3[01])|d(?:[0-9]|1[0-5])|q(?:[0-9]|1[0-5])"
    r"|fpscr|fpsr|fpcr)$", re.I)


def is_fpu_register(name: str) -> bool:
    return bool(_FPU_NAME_RE.match(str(name or "")))


def _hex(v: object) -> str:
    try:
        return hex(int(str(v), 0))
    except (TypeError, ValueError):
        return ""


def _num(v: object) -> int | None:
    try:
        return int(str(v), 0)
    except (TypeError, ValueError):
        return None


def _signed32(n: int) -> int:
    return struct.unpack("<i", struct.pack("<I", n & 0xFFFFFFFF))[0]


# ── 调用栈 ──────────────────────────────────────────────────────
def stack(payload: dict) -> list[dict]:
    """``-stack-list-frames`` → ``[{level,addr,func,file,fullname,line,arch}]``。

    ``fullname`` 是 MI 给的绝对路径（源码页签据此读文件）；老 gdb 可能没有该字段，
    此时留给调用方用 ``plan.source_dir`` 建索引兜底（见 ``debugsource.resolve_hint``）。
    """
    frames = []
    for fr in payload.get("stack") or []:
        if not isinstance(fr, dict):
            continue
        f = fr.get("frame") if isinstance(fr.get("frame"), dict) else fr
        line = None
        try:
            line = int(f["line"]) if f.get("line") is not None else None
        except (TypeError, ValueError):
            line = None
        frames.append({
            "level": int(f.get("level", len(frames))),
            "addr": _hex(f.get("addr")),
            "func": str(f.get("func") or "??"),
            "file": str(f.get("file") or ""),
            "fullname": str(f.get("fullname") or ""),
            "line": line,
            "arch": str(f.get("arch") or ""),
            "pc": _hex(f.get("addr")) == _hex(payload.get("_pc")),
        })
    return frames


def threads(payload: dict) -> list[dict]:
    ids = []
    if payload.get("current-thread-id") is not None:
        ids.append(int(payload["current-thread-id"]))
    out = []
    for t in payload.get("threads") or []:
        if not isinstance(t, dict):
            continue
        tid = t.get("id")
        out.append({
            "id": int(tid) if tid is not None else 0,
            "name": str(t.get("name") or t.get("target-id") or ""),
            "target_id": str(t.get("target-id") or ""),
            "current": tid is not None and int(tid) in ids,
        })
    return out


def stop_frame(record: dict) -> dict:
    """``*stopped`` 记录 → ``{reason,thread,frame,pc,bkptno}``。"""
    res = record.get("results") or {}
    frame_raw = res.get("frame") or {}
    if not isinstance(frame_raw, dict):
        frame_raw = {}
    stop = {
        "reason": str(res.get("reason") or ""),
        "thread": str(res.get("thread-id") or ""),
        "frame": {
            "func": str(frame_raw.get("func") or ""),
            "file": str(frame_raw.get("file") or ""),
            "fullname": str(frame_raw.get("fullname") or ""),
            "line": int(frame_raw["line"]) if str(frame_raw.get("line") or "").isdigit() else None,
            "addr": _hex(frame_raw.get("addr")),
        },
        "pc": _hex(res.get("frame", {}).get("addr") if isinstance(res.get("frame"), dict) else ""),
        "bkptno": str(res.get("bkptno") or ""),
    }
    if not stop["pc"] and stop["frame"]["addr"]:
        stop["pc"] = stop["frame"]["addr"]
    return stop


# ── 寄存器 ──────────────────────────────────────────────────────
_XPSR_BITS = (("N", 31), ("Z", 30), ("C", 29), ("V", 28), ("T", 24))
_CORE_LABELS = {
    "r0": "r0", "sp": "sp", "lr": "lr", "pc": "pc", "xpsr": "xPSR",
}
_ARM_CORE = (
    "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9",
    "r10", "r11", "r12", "sp", "lr", "pc", "xpsr",
)


def xpsr_flags(n: int) -> dict:
    return {name: (n >> bit) & 1 for name, bit in _XPSR_BITS}


def registers(names_rec: dict, values_rec: dict, *, mode: str = "hex",
              editable_fn=None, width_fn=None) -> list[dict]:
    """``-data-list-register-names`` + ``-data-list-register-values`` → 分组。

    ``editable_fn`` / ``width_fn`` 由调用方注入（白名单是**内核策略**，不在这里重复定义）；
    缺省保持 P2 行为：只读 ``xpsr/pc/lr``，宽度一律 32 位。
    """
    editable_fn = editable_fn or (lambda n: n not in ("xpsr", "pc", "lr"))
    width_fn = width_fn or (lambda n: 32)
    names = [str(x) for x in (names_rec.get("register-names") or [])]
    vals = values_rec.get("register-values") or []
    by_num: dict[int, str] = {}
    for item in vals:
        if not isinstance(item, dict):
            continue
        try:
            by_num[int(item.get("number"))] = str(item.get("value"))
        except (TypeError, ValueError):
            continue

    groups: list[dict] = []
    core: list[dict] = []
    fpu: list[dict] = []
    # 先按 ARM 标准序（保证“r0–r15 + xPSR”永远在最前），再补其余
    ordered = [n for n in _ARM_CORE if n in names]
    ordered += [n for n in names if n and n not in _ARM_CORE]
    for idx, name in enumerate(names):
        if not name:
            continue
        value = by_num.get(idx, "")
        if not value:
            continue
        width = int(width_fn(name))
        editable = bool(editable_fn(name))
        reg = {"name": name, "hex": _hex(value), "natural": str(_signed32(_num(value) or 0)),
               "editable": editable, "width": width}
        if not editable:
            # UI 只读原因（§7.3）：pc/lr/xpsr 与 64/128 位寄存器给出明确标注
            reg["readonly"] = ("wide" if width > 32
                               else "core-fixed")
        if name == "pc":
            reg["pc"] = True
        if name == "xpsr":
            reg["flags"] = xpsr_flags(_num(value) or 0)
        (fpu if (is_fpu_register(name) and name not in _ARM_CORE)
         else core).append(reg)
    # 若 names 表里没有 sp/lr/pc/xpsr 的别名（部分 gdb 版本用 r13/r14/r15），补映射
    if not any(r["name"] == "sp" for r in core):
        for r in core:
            if r["name"] == "r13":
                r["name"] = "sp"
            elif r["name"] == "r14":
                r["name"] = "lr"
            elif r["name"] == "r15":
                r["name"] = "pc"
                r["pc"] = True
    if core:
        groups.append({"name": "core", "label": "内核寄存器", "regs": core})
    if fpu:
        groups.append({"name": "fpu", "label": "FPU 寄存器", "regs": fpu})
    return groups


# ── 变量 ────────────────────────────────────────────────────────
def var_node(item: dict, *, obj: str = "") -> dict:
    """一个 MI 变量/子节点 → §6.5 变量节点。"""
    name = str(item.get("name") or item.get("exp") or "")
    value = str(item.get("value") or "")
    typ = str(item.get("type") or "")
    numchild = item.get("numchild")
    try:
        children = int(numchild) if numchild is not None else 0
    except (TypeError, ValueError):
        children = 0
    node = {
        "name": name,
        "type": typ or "",
        "value": value,
        "hex": _hex(value) if value else "",
        "has_children": children > 0 or str(item.get("dynamic") or "") == "1",
        "addr": "",
    }
    if obj:
        node["obj"] = obj
    return node


def variables(items: list, *, obj_map: dict[str, str] | None = None) -> list[dict]:
    """``-stack-list-variables --all-values`` → 节点列表。"""
    obj_map = obj_map or {}
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        node = var_node(item, obj=obj_map.get(name, ""))
        out.append(node)
    return out


def varobjs(created: dict, children: list) -> list[dict]:
    """``-var-create`` + ``-var-list-children --all-values`` → 子节点列表。"""
    out = []
    for item in children or []:
        if not isinstance(item, dict):
            continue
        child = item.get("child") if isinstance(item.get("child"), dict) else item
        name = str(child.get("exp") or child.get("name") or "")
        node = var_node(child, obj=str(child.get("name") or ""))
        node["name"] = name
        out.append(node)
    return out


def evaluate(record: dict) -> dict:
    res = record.get("results") or {}
    value = str(res.get("value") or "")
    return {"value": value, "type": str(res.get("type") or ""),
            "hex": _hex(value) if value else "", "natural": str(_signed32(_num(value) or 0))}


# ── 断点 ────────────────────────────────────────────────────────
def breakpoints(record: dict, *, id_map: dict[str, str] | None = None) -> list[dict]:
    """``-break-list`` → §6.5 断点列表。``id_map`` 把 gdb_id 映射回工程级稳定 id。"""
    id_map = id_map or {}
    table = (record.get("results") or {}).get("BreakpointTable") or {}
    out = []
    for item in table.get("body") or []:
        if not isinstance(item, dict):
            continue
        bk = item.get("bkpt") if isinstance(item.get("bkpt"), dict) else item
        gdb_id = str(bk.get("number") or "")
        out.append({
            "id": id_map.get(gdb_id, f"gdb-{gdb_id}"),
            "gdb_id": gdb_id,
            "kind": "func" if bk.get("func") else ("addr" if bk.get("addr") else "loc"),
            "location": str(bk.get("func") or bk.get("addr") or ""),
            "enabled": str(bk.get("enabled") or "y").lower() in ("y", "yes", "1", "true"),
            "condition": str(bk.get("cond") or ""),
            "hit_count": int(str(bk.get("times") or "0")) if str(bk.get("times") or "0").isdigit() else 0,
            "verified": True,
            "temporary": str(bk.get("disp") or "") == "del",
            "hardware": False,
        })
    return out


# ── 内存 ────────────────────────────────────────────────────────
def memory(record: dict, *, addr: str, count: int) -> dict:
    """``-data-read-memory-bytes`` → 十六进制串 + ASCII + 下一页地址。"""
    blocks = (record.get("results") or {}).get("memory") or []
    raw = ""
    for b in blocks:
        if isinstance(b, dict):
            raw += str(b.get("contents") or "")
    raw = raw.replace(" ", "")
    data = bytes.fromhex(raw) if raw and len(raw) % 2 == 0 else b""
    base = _num(addr) or 0
    nxt = hex(base + max(1, count))
    return {
        "addr": _hex(addr),
        "count": len(data),
        "bytes": " ".join(f"{b:02x}" for b in data),
        "ascii": "".join(chr(b) if 32 <= b < 127 else "." for b in data),
        "width": 4,
        "next": nxt,
    }


# ── 反汇编 ──────────────────────────────────────────────────────
def _asm_line(item: dict, pc: str) -> dict:
    addr = _hex(item.get("address") or item.get("addr"))
    inst = str(item.get("inst") or "").strip()
    parts = inst.split(None, 1)
    return {
        "addr": addr,
        "mnemonic": parts[0] if parts else "",
        "operands": parts[1] if len(parts) > 1 else "",
        "symbol": (f"{item.get('func-name')}+{item.get('offset')}"
                   if item.get("func-name") else ""),
        "pc": bool(pc) and addr == pc,
    }


def disasm(record: dict, *, mode: int = 2,
           breakpoints_by_addr: dict[str, str] | None = None) -> list[dict]:
    """``-data-disassemble`` → 指令列表（mode 2 = 纯汇编；mode 0 = 含源码行）。"""
    bp = breakpoints_by_addr or {}
    res = record.get("results") or {}
    out = []
    if mode == 0:
        for block in res.get("src_and_asm_line") or []:
            if not isinstance(block, dict):
                continue
            for ins in block.get("line_asm_insn") or []:
                if isinstance(ins, dict):
                    line = _asm_line(ins, "")
                    line["line"] = block.get("line")
                    line["file"] = block.get("file")
                    if line["addr"] in bp:
                        line["bp"] = bp[line["addr"]]
                    out.append(line)
        return out
    for item in res.get("asm_insns") or []:
        if isinstance(item, dict):
            line = _asm_line(item, "")   # pc 由调用方标（避免解析空 addr）
            if line["addr"] in bp:
                line["bp"] = bp[line["addr"]]
            out.append(line)
    return out
