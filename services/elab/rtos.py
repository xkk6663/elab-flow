"""elab.rtos —— FreeRTOS 运行态内省（P3 RTOS 页签）。

只做**栈水位检测**（用户要求），不做 LiveWatch / RTT。

实现路径（全部走 gdb 表达式 + 目标内存读，不依赖厂商包、不 import 固件）：

1. ``pxCurrentTCB`` 存在 → 认为 FreeRTOS 可用（会话 open 时已探过一次）。
2. 用 ``&((TCB_t *)0)->field`` 取结构体字段偏移（**不**解引用空指针）。
3. 遍历 ``pxReadyTasksLists`` / ``xDelayedTaskList1`` / ``xDelayedTaskList2`` /
   ``xPendingReadyList`` / ``xSuspendedTaskList``（缺哪个跳哪个），
   每个 ListItem 的 ``pvOwner`` 就是 TCB。
4. 水位优先级：TCB ``usStackHighWaterMark``（若存在）→ 否则从 ``pxStack``
   向上扫 FreeRTOS 填充字节 ``0xA5``。
5. 栈总大小只在 ``pxEndOfStack`` 存在时能算准（Cortex-M 默认不记录），
   否则 ``stack_size_bytes/used_pct`` 返回 null —— **不猜**。

``collect(reader)`` 是纯逻辑；``reader`` 只需实现 ``ev(expr)`` / ``mem(addr, size)``，
单测用 fake reader（见 ``tests/test_rtos.py``）。
"""

from __future__ import annotations

FILL_BYTE = 0xA5

#: 水位阈值（FreeRTOS 的 high water mark = 历史最小剩余**字**数）
WARN_FREE_WORDS = 16
CRIT_FREE_WORDS = 4

_MAX_ITEMS = 64


class RtosUnavailable(RuntimeError):
    """ELF 里没有可用的 FreeRTOS 符号 / 调试类型。"""


def _num(v) -> int | None:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        return int(s, 0)
    except ValueError:
        # gdb 有时回 ``1 '\\001'`` 之类，取第一段
        try:
            return int(s.split()[0], 0)
        except ValueError:
            return None


def _off(reader, field: str, type_name: str = "TCB_t") -> int | None:
    # ★ 表达式里**不能有空格**（多词类型也不行）：gdb MI 会按空格切参数（实测 2026-11-03）
    return _num(reader.ev(f"(long)&(({type_name}*)0)->{field}"))


def _ptr(reader, addr: int) -> int | None:
    data = reader.mem(addr, 4)
    if not data or len(data) < 4:
        return None
    return int.from_bytes(data[:4], "little")


def _u32(reader, addr: int) -> int | None:
    return _ptr(reader, addr)


def _u16(reader, addr: int) -> int | None:
    data = reader.mem(addr, 2)
    if not data or len(data) < 2:
        return None
    return int.from_bytes(data[:2], "little")


def _task_name(reader, addr: int) -> str:
    data = reader.mem(addr, 16)
    if not data:
        return ""
    raw = bytes(data[:16])
    cut = raw.find(b"\x00")
    if cut >= 0:
        raw = raw[:cut]
    text = raw.decode("latin-1", "replace").strip()
    return text or "(unnamed)"


def _scan_free_words(reader, stack: int, cap_words: int = 256) -> tuple[int, bool]:
    """从栈底向上数连续 0xA5 字；返回 (free_words, 是否触顶)。"""
    free = 0
    while free < cap_words:
        chunk = reader.mem(stack + free * 4, 4)
        if not chunk or len(chunk) < 4:
            break
        if any(b != FILL_BYTE for b in chunk[:4]):
            break
        free += 1
    return free, free >= cap_words


def _health(free_words: int, used_pct: float | None) -> str:
    if used_pct is not None:
        if used_pct >= 90.0:
            return "critical"
        if used_pct >= 75.0:
            return "warn"
        return "ok"
    if free_words <= CRIT_FREE_WORDS:
        return "critical"
    if free_words <= WARN_FREE_WORDS:
        return "warn"
    return "ok"


def _list_offsets(reader) -> dict | None:
    """结构体偏移只算一次（每个 GDB 表达式 ~几十 ms，32 张就绪表不能重复问）。"""
    off_items = _off(reader, "uxNumberOfItems", "List_t")
    off_index = _off(reader, "pxIndex", "List_t")
    off_next = _off(reader, "pxNext", "ListItem_t")
    off_owner = _off(reader, "pvOwner", "ListItem_t")
    if None in (off_items, off_index, off_next, off_owner):
        return None
    return {"items": off_items, "index": off_index,
            "next": off_next, "owner": off_owner,
            "list_size": _num(reader.ev("sizeof(List_t)")) or 20}


def _u32_at(buf: bytes, off: int) -> int | None:
    if not buf or len(buf) < off + 4:
        return None
    return int.from_bytes(buf[off:off + 4], "little")


def _list_tasks(reader, header: bytes, state: str,
                offs: dict | None) -> list[tuple[int, str]]:
    """遍历一个 FreeRTOS List_t（header 已读），回 [(tcb_addr, state)]。"""
    if offs is None:
        return []
    n = _u32_at(header, offs["items"]) or 0
    if n <= 0:
        return []
    n = min(n, _MAX_ITEMS)
    item = _u32_at(header, offs["index"])
    if not item:
        return []
    # pxIndex 在延迟表 / 只有一个成员的链表里可能指向哨兵 xListEnd
    # （pvOwner = 0）。从哨兵起按 n 次遍历会少一个真实项 —— 先跳到第一项。
    if not _ptr(reader, item + offs["owner"]):
        item = _ptr(reader, item + offs["next"])
        if not item:
            return []
    out, seen = [], set()
    for _ in range(n):
        if item in seen:
            break
        seen.add(item)
        owner = _ptr(reader, item + offs["owner"])
        if owner:
            out.append((owner, state))
        nxt = _ptr(reader, item + offs["next"])
        if not nxt:
            break
        item = nxt
    return out


def _tcb_fields(reader) -> dict:
    return {"name": _off(reader, "pcTaskName"),
            "prio": _off(reader, "uxPriority"),
            "stack": _off(reader, "pxStack"),
            "hwm": _off(reader, "usStackHighWaterMark"),
            "end": _off(reader, "pxEndOfStack")}


def _task_record(reader, tcb: int, state: str, current: int,
                 fields: dict) -> dict:
    off_name = fields["name"]
    off_prio = fields["prio"]
    off_stack = fields["stack"]
    off_hwm = fields["hwm"]
    off_end = fields["end"]
    if off_stack is None:
        raise RtosUnavailable("TCB 缺少 pxStack（调试信息不完整）")

    name = _task_name(reader, tcb + off_name) if off_name is not None else ""
    prio = _u32(reader, tcb + off_prio) if off_prio is not None else None
    stack = _ptr(reader, tcb + off_stack)
    if not stack:
        return {}
    end = _ptr(reader, tcb + off_end) if off_end is not None else None

    free_words = _u16(reader, tcb + off_hwm) if off_hwm is not None else None
    scanned = False
    if free_words is None:
        free_words, scanned = _scan_free_words(reader, stack)

    size = None
    if end and end > stack:
        size = end - stack + 4
    free_bytes = free_words * 4
    used_bytes = None
    used_pct = None
    if size:
        used_bytes = max(0, size - free_bytes)
        used_pct = round(used_bytes * 100.0 / size, 1)
    return {
        "name": name,
        "priority": prio,
        "state": state,
        "current": tcb == current,
        "tcb": hex(tcb),
        "stack_start": hex(stack),
        "stack_end": hex(end) if end else None,
        "stack_size_bytes": size,
        "free_words": free_words,
        "free_bytes": free_bytes,
        "high_water_mark": free_words,
        "used_bytes": used_bytes,
        "used_pct": used_pct,
        "health": _health(free_words, used_pct),
        "scanned": scanned,
    }


def collect(reader) -> dict:
    """枚举任务 + 栈水位；无 FreeRTOS 符号 → :class:`RtosUnavailable`。"""
    cur_raw = reader.ev("pxCurrentTCB")
    if cur_raw is None:
        inner = getattr(reader, "last_error", "")
        raise RtosUnavailable(
            "找不到 pxCurrentTCB（工程未使用 FreeRTOS 或符号被裁剪）"
            + (f"：{inner}" if inner else ""))
    cur = _num(cur_raw) or 0
    if not cur:
        # 符号存在但还没调度（停在 main / 调度器未启动）：不是错误，只是没有任务
        return {"tasks": [], "count": 0, "current_tcb": "0x0",
                "note": "调度器尚未启动（pxCurrentTCB = 0）"}

    tasks: list[tuple[str, int]] = []
    offs = _list_offsets(reader)
    stride = offs["list_size"] if offs else 0

    # 就绪表：pxReadyTasksLists[configMAX_PRIORITIES] —— 整块读一次（最多 32×20B）
    size_ready = _num(reader.ev("sizeof(pxReadyTasksLists)"))
    ready_addr = _num(reader.ev("&pxReadyTasksLists"))
    if size_ready and stride and ready_addr and offs:
        block = reader.mem(ready_addr, size_ready)
        if block:
            for i in range(min(size_ready // stride, 32)):
                hdr = block[i * stride:(i + 1) * stride]
                for tcb, _st in _list_tasks(reader, hdr, "ready", offs):
                    tasks.append(("ready", tcb))

    for sym, state in (("xDelayedTaskList1", "delayed"),
                       ("xDelayedTaskList2", "delayed"),
                       ("xPendingReadyList", "pending"),
                       ("xSuspendedTaskList", "suspended"),
                       ("xTasksWaitingTermination", "terminated")):
        addr = _num(reader.ev(f"&{sym}"))
        if not addr or not offs:
            continue
        hdr = reader.mem(addr, stride or 20)
        for tcb, _st in _list_tasks(reader, hdr or b"", state, offs):
            tasks.append((state, tcb))

    # 去重（同一 TCB 只属于一个表）；当前任务的 state 以所在表为准
    uniq: dict[int, str] = {}
    for state, tcb in tasks:
        uniq.setdefault(tcb, state)
    if cur not in uniq:
        uniq[cur] = "running"

    fields = _tcb_fields(reader)
    rows = []
    for tcb, state in sorted(uniq.items(), key=lambda kv: (
            0 if kv[0] == cur else 1, kv[1], kv[0])):
        rec = _task_record(reader, tcb, state, cur, fields)
        if rec:
            rows.append(rec)
    return {"tasks": rows, "count": len(rows), "current_tcb": hex(cur)}
