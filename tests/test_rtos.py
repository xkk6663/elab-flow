"""FreeRTOS 栈水位内省（elab.rtos）离线单测。

    python -m unittest tests.test_rtos

用一个**纯内存 fake reader** 模拟 TCB/List/栈，验证：
- pxReadyTasksLists 枚举 → pvOwner → TCB
- 任务名 / 优先级 / pxStack / usStackHighWaterMark
- pxEndOfStack 存在时 used_pct 计算；缺失时 null
- 无 pxCurrentTCB → RtosUnavailable
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab import rtos                                         # noqa: E402

# ── fake 结构体布局 ─────────────────────────────────────────────
TCB = {"top": 0, "name": 8, "prio": 24, "stack": 28, "hwm": 32, "end": 36}
TCB_SIZE = 40
LIST = {"items": 0, "index": 4, "size": 16}
ITEM = {"next": 0, "prev": 4, "owner": 8, "size": 16}

READY = 0x20000000          # 8 × List_t
READY_COUNT = 8
DL1, DL2, PEND, SUSP = 0x20000080, 0x20000090, 0x200000A0, 0x200000B0

CUR_TCB, OTHER_TCB = 0x20001000, 0x20001100
ITEM_A, ITEM_B = 0x20003000, 0x20003100
STACK_A, STACK_B = 0x20002000, 0x20002100


class FakeReader:
    def __init__(self, mem, truth):
        self.mem_map = mem
        self.truth = truth

    def ev(self, expr):
        return self.truth.get(expr)

    def mem(self, addr, size):
        out = bytearray()
        for i in range(size):
            out.append(self.mem_map.get(addr + i, 0))
        return bytes(out)


def _put(mem, addr, data):
    for i, b in enumerate(data):
        mem[addr + i] = b


def _ptr(mem, addr, value):
    _put(mem, addr, int(value).to_bytes(4, "little"))


def build_world(*, with_end=True):
    mem: dict[int, int] = {}
    truth: dict[str, str] = {}

    for name, key in (("pcTaskName", "name"), ("uxPriority", "prio"),
                      ("pxStack", "stack"), ("usStackHighWaterMark", "hwm"),
                      ("pxEndOfStack", "end")):
        truth[f"(long)&((TCB_t*)0)->{name}"] = str(TCB[key])
    truth["(long)&((List_t*)0)->uxNumberOfItems"] = str(LIST["items"])
    truth["(long)&((List_t*)0)->pxIndex"] = str(LIST["index"])
    for name, key in (("pxNext", "next"), ("pxPrevious", "prev"),
                      ("pvOwner", "owner")):
        truth[f"(long)&((ListItem_t*)0)->{name}"] = str(ITEM[key])
    truth["sizeof(List_t)"] = str(LIST["size"])
    truth["sizeof(pxReadyTasksLists)"] = str(READY_COUNT * LIST["size"])
    truth["&pxReadyTasksLists"] = hex(READY)
    truth["&xDelayedTaskList1"] = hex(DL1)
    truth["&xDelayedTaskList2"] = hex(DL2)
    truth["&xPendingReadyList"] = hex(PEND)
    truth["&xSuspendedTaskList"] = hex(SUSP)
    truth["pxCurrentTCB"] = hex(CUR_TCB)

    # TCB A（当前任务）与 B
    _put(mem, CUR_TCB + TCB["name"], b"heartbeat\x00\x00\x00\x00\x00\x00\x00")
    _ptr(mem, CUR_TCB + TCB["prio"], 2)
    _ptr(mem, CUR_TCB + TCB["stack"], STACK_A)
    _put(mem, CUR_TCB + TCB["hwm"], (20).to_bytes(2, "little"))
    if with_end:
        _ptr(mem, CUR_TCB + TCB["end"], STACK_A + 0x80)

    _put(mem, OTHER_TCB + TCB["name"], b"idle\x00\x00\x00\x00")
    _ptr(mem, OTHER_TCB + TCB["prio"], 0)
    _ptr(mem, OTHER_TCB + TCB["stack"], STACK_B)
    _put(mem, OTHER_TCB + TCB["hwm"], (5).to_bytes(2, "little"))
    if with_end:
        _ptr(mem, OTHER_TCB + TCB["end"], STACK_B + 0x80)

    # 就绪表 0：A → B → A（pxIndex 指向 A，pxNext 取 B）
    _ptr(mem, READY + LIST["items"], 2)
    _ptr(mem, READY + LIST["index"], ITEM_A)
    _ptr(mem, ITEM_A + ITEM["next"], ITEM_B)
    _ptr(mem, ITEM_A + ITEM["owner"], CUR_TCB)
    _ptr(mem, ITEM_B + ITEM["next"], ITEM_A)
    _ptr(mem, ITEM_B + ITEM["owner"], OTHER_TCB)

    # 其余表空
    for addr in (READY + LIST["size"], DL1, DL2, PEND, SUSP):
        _ptr(mem, addr + LIST["items"], 0)
    return FakeReader(mem, truth)


class RtosCollectTest(unittest.TestCase):
    def test_enumerates_tasks_and_watermarks(self):
        out = rtos.collect(build_world())
        self.assertEqual(out["count"], 2)
        names = {t["name"] for t in out["tasks"]}
        self.assertEqual(names, {"heartbeat", "idle"})
        cur = next(t for t in out["tasks"] if t["current"])
        self.assertEqual(cur["name"], "heartbeat")
        self.assertEqual(cur["priority"], 2)
        self.assertEqual(cur["free_words"], 20)
        self.assertEqual(cur["free_bytes"], 80)
        self.assertEqual(cur["stack_size_bytes"], 0x80 + 4)
        self.assertEqual(cur["used_bytes"], 0x84 - 80)
        self.assertGreater(cur["used_pct"], 0)
        self.assertEqual(cur["health"], "ok")
        idle = next(t for t in out["tasks"] if not t["current"])
        self.assertEqual(idle["free_words"], 5)
        self.assertEqual(idle["health"], "warn")

    def test_missing_end_keeps_pct_null(self):
        out = rtos.collect(build_world(with_end=False))
        for t in out["tasks"]:
            self.assertIsNone(t["stack_size_bytes"])
            self.assertIsNone(t["used_pct"])
            self.assertIsNotNone(t["free_words"])

    def test_sentinel_px_index_does_not_drop_item(self):
        """pxIndex 指向哨兵 xListEnd 时（延迟表/单成员表常见）不能漏掉任务。"""
        reader = build_world()
        mem = reader.mem_map
        tcb_c, stack_c = 0x20001200, 0x20002200
        item_sent, item_c = 0x20003200, 0x20003300
        _put(mem, tcb_c + TCB["name"], b"timer\x00\x00\x00\x00\x00\x00")
        _ptr(mem, tcb_c + TCB["prio"], 1)
        _ptr(mem, tcb_c + TCB["stack"], stack_c)
        _put(mem, tcb_c + TCB["hwm"], (30).to_bytes(2, "little"))
        _ptr(mem, DL1 + LIST["items"], 1)
        _ptr(mem, DL1 + LIST["index"], item_sent)
        _ptr(mem, item_sent + ITEM["next"], item_c)
        _ptr(mem, item_sent + ITEM["owner"], 0)
        _ptr(mem, item_c + ITEM["next"], item_sent)
        _ptr(mem, item_c + ITEM["owner"], tcb_c)
        out = rtos.collect(reader)
        names = {t["name"] for t in out["tasks"]}
        self.assertIn("timer", names)
        self.assertEqual(out["count"], 3)

    def test_no_freertos(self):
        with self.assertRaises(rtos.RtosUnavailable):
            rtos.collect(FakeReader({}, {}))


if __name__ == "__main__":
    unittest.main()
