"""M2：Modbus 主站事务引擎（假传输，无硬件）。

判据（计划 §5.8）：
· 单飞行：一条应答只结一条事务，多出来的字节不串台；
· 超时按 `retries` 重发，异常应答**不重试**（从站已经明确回答了）；
· 广播写不等应答；CRC 坏帧算错并重试；线上噪声被丢且计入 noise；
· 轮询组按间隔跑起来，合并相邻点成一条请求，`scale` 只影响展示值；
· 关闭会话时在途事务立刻结账为 `port`，调用方不会干等到超时；
· 映射校验：重名/越界/32 位未给字序/组引用不存在的点 —— 全部当场拒绝。
"""

from __future__ import annotations

import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, "services")

from elab import modbus as mb  # noqa: E402
from elab import modbusmaster as mm  # noqa: E402


# ══════════════════════════════════════════════════════════════════
#  假从站 + 假会话
# ══════════════════════════════════════════════════════════════════
class FakeSlave:
    """够用的 RTU 从站：保持寄存器/线圈 + 三种坏行为。"""

    def __init__(self, unit=1):
        self.unit = unit
        self.holding = {i: 0 for i in range(64)}
        self.coils = {i: 0 for i in range(16)}
        self.silent = False
        self.bad_crc = False
        self.noise = b""
        self.requests = []

    def reply(self, adu: bytes) -> bytes | None:
        # ★ 坏的是**应答**的 CRC，不是请求的：请求坏了从站会静默丢帧（那测的是超时）
        self.requests.append(adu)
        mb.check_crc(adu)
        unit, fc = adu[0], adu[1]
        if unit != self.unit:
            return None
        body = adu[2:-2]
        if fc in (mb.FC_READ_HOLDING, mb.FC_READ_INPUT):
            addr, count = struct.unpack(">HH", body)
            if addr + count > 64:
                return self._exc(fc, 0x02)
            words = b"".join(struct.pack(">H", self.holding.get(addr + i, 0))
                             for i in range(count))
            return self._ok(unit, fc, bytes([len(words)]) + words)
        if fc in (mb.FC_READ_COILS, mb.FC_READ_DISCRETE):
            addr, count = struct.unpack(">HH", body)
            bits = bytearray((count + 7) // 8)
            for i in range(count):
                if self.coils.get(addr + i):
                    bits[i // 8] |= 1 << (i % 8)
            return self._ok(unit, fc, bytes([len(bits)]) + bytes(bits))
        if fc == mb.FC_WRITE_REGISTER:
            addr, val = struct.unpack(">HH", body)
            self.holding[addr] = val
            return self._ok(unit, fc, body)
        if fc == mb.FC_WRITE_COIL:
            addr, val = struct.unpack(">HH", body)
            self.coils[addr] = 1 if val == 0xFF00 else 0
            return self._ok(unit, fc, body)
        if fc == mb.FC_WRITE_REGISTERS:
            addr, count, bc = struct.unpack(">HHB", body[:5])
            for i in range(count):
                self.holding[addr + i] = struct.unpack(">H", body[5 + 2 * i:7 + 2 * i])[0]
            return self._ok(unit, fc, struct.pack(">HH", addr, count))
        if fc == mb.FC_WRITE_COILS:
            addr, count, bc = struct.unpack(">HHB", body[:5])
            payload = body[5:]
            for i in range(count):
                self.coils[addr + i] = (payload[i // 8] >> (i % 8)) & 1
            return self._ok(unit, fc, struct.pack(">HH", addr, count))
        return self._exc(fc, 0x01)

    @staticmethod
    def _ok(unit, fc, body: bytes) -> bytes:
        head = bytes((unit, fc)) + body
        return head + mb.crc_bytes(head)

    def _exc(self, fc, code) -> bytes:
        head = bytes((self.unit, fc | 0x80, code))
        return head + mb.crc_bytes(head)


class FakeSession:
    """最小会话面：write + RX 观察者。引擎只认这两个。"""

    project = "fake"
    port = "FAKE0"
    baud = 115200
    epoch = 1

    def __init__(self, slave: FakeSlave, *, dead=False):
        self.slave = slave
        self.dead = dead
        self.sinks = []
        self.tx = []

    def add_rx_sink(self, fn):
        if fn not in self.sinks:
            self.sinks.append(fn)

    def remove_rx_sink(self, fn):
        if fn in self.sinks:
            self.sinks.remove(fn)

    def write(self, data: bytes) -> int:
        if self.dead:
            return 0
        self.tx.append(bytes(data))
        if self.slave.silent:
            return len(data)
        try:
            resp = self.slave.reply(bytes(data))
        except mb.ModbusError:
            return len(data)            # 帧坏：从站静默丢弃
        if resp:
            if self.slave.bad_crc:
                resp = resp[:-1] + bytes([resp[-1] ^ 0xFF])
            payload = self.slave.noise + resp
            self.slave.noise = b""
            for fn in self.sinks:
                fn(payload)
        return len(data)


def _engine(slave=None, **kw):
    slave = slave or FakeSlave()
    sess = FakeSession(slave, dead=kw.pop("dead", False))
    eng = mm.Engine(sess, unit_id=kw.pop("unit_id", 1),
                    timeout_ms=kw.pop("timeout_ms", 40),
                    retries=kw.pop("retries", 1),
                    mapping=kw.pop("mapping", None))
    eng.start()
    return eng, sess, slave


class ReadWriteTest(unittest.TestCase):
    def tearDown(self):
        mm.close_engine("test")

    def test_read_holding(self):
        eng, sess, slave = _engine()
        slave.holding.update({0: 1, 1: 2, 2: 3})
        res = eng.read(mb.FC_READ_HOLDING, 0, 3)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["values"], [1, 2, 3])
        self.assertEqual(res["attempts"], 1)
        self.assertEqual(res["request"]["hex"], "01 03 00 00 00 03 05 CB")

    def test_write_single_register_lands(self):
        eng, sess, slave = _engine()
        res = eng.write(mb.FC_WRITE_REGISTER, 0x10, [0x1234])
        self.assertTrue(res["ok"], res)
        self.assertEqual(slave.holding[0x10], 0x1234)
        self.assertEqual(res["response"]["echo_address"], 0x10)

    def test_write_multiple_registers(self):
        eng, sess, slave = _engine()
        res = eng.write(mb.FC_WRITE_REGISTERS, 0x20, [7, 8, 9])
        self.assertTrue(res["ok"], res)
        self.assertEqual([slave.holding[0x20 + i] for i in range(3)], [7, 8, 9])

    def test_read_coils(self):
        eng, sess, slave = _engine()
        slave.coils.update({0: 1, 1: 0, 2: 1, 3: 1})
        res = eng.read(mb.FC_READ_COILS, 0, 4)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["values"], [1, 0, 1, 1])

    def test_broadcast_does_not_wait(self):
        eng, sess, slave = _engine()
        t0 = time.time()
        res = eng.write(mb.FC_WRITE_REGISTER, 5, [3], broadcast=True)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["broadcast"])
        self.assertLess(time.time() - t0, 0.2)   # 不等超时


class ErrorTest(unittest.TestCase):
    def tearDown(self):
        mm.close_engine("test")

    def test_timeout_retries_then_fails(self):
        eng, sess, slave = _engine(retries=2, timeout_ms=30)
        slave.silent = True
        res = eng.read(mb.FC_READ_HOLDING, 0, 1)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["kind"], "timeout")
        self.assertEqual(res["attempts"], 3)      # 1 + retries
        self.assertEqual(len(sess.tx), 3)
        self.assertEqual(eng.stats["retry"], 2)

    def test_exception_is_not_retried(self):
        eng, sess, slave = _engine(retries=2)
        res = eng.read(mb.FC_READ_HOLDING, 60, 8)   # 越界 → 02
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["kind"], "exception")
        self.assertEqual(res["error"]["code"], 0x02)
        self.assertEqual(res["attempts"], 1)
        self.assertEqual(eng.stats["exception"], 1)

    def test_bad_crc_retried_then_crc_error(self):
        eng, sess, slave = _engine(retries=1, timeout_ms=30)
        slave.bad_crc = True
        res = eng.read(mb.FC_READ_HOLDING, 0, 1)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["kind"], "crc")
        self.assertEqual(res["attempts"], 2)

    def test_noise_bytes_are_dropped(self):
        eng, sess, slave = _engine()
        slave.noise = b"\x99\x88"                 # 总线上别的东西
        res = eng.read(mb.FC_READ_HOLDING, 0, 1)
        self.assertTrue(res["ok"], res)
        self.assertGreaterEqual(eng.stats["noise"], 2)

    def test_dead_port(self):
        eng, sess, slave = _engine(dead=True)
        res = eng.read(mb.FC_READ_HOLDING, 0, 1)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["kind"], "port")

    def test_stop_fails_inflight_as_port(self):
        eng, sess, slave = _engine()
        slave.silent = True
        eng.timeout_ms = 2000
        out = {}
        import threading
        t = threading.Thread(target=lambda: out.update(eng.read(mb.FC_READ_HOLDING, 0, 1)))
        t.start()
        time.sleep(0.1)
        eng.stop("测试关闭")
        t.join(timeout=3)
        self.assertFalse(out["ok"])
        self.assertEqual(out["error"]["kind"], "port")


class PollTest(unittest.TestCase):
    def tearDown(self):
        mm.close_engine("test")

    def _map(self, interval=80):
        return {
            "rev": 1, "unit_id": 1, "timeout_ms": 40, "retries": 0,
            "points": [
                {"name": "id", "fc": 3, "address": 0, "type": "u16"},
                {"name": "tick", "fc": 3, "address": 2, "type": "u16"},
                {"name": "temp", "fc": 3, "address": 0x30, "type": "f32",
                 "word_order": "big", "scale": 1, "unit": "°C"},
                {"name": "runtime", "fc": 3, "address": 0x20, "type": "u32",
                 "word_order": "big"},
            ],
            "groups": [{"name": "fast", "interval_ms": interval,
                        "points": ["id", "tick", "temp", "runtime"]}],
        }

    def test_poll_updates_points(self):
        eng, sess, slave = _engine(mapping=self._map())
        slave.holding[0] = 0x0007
        slave.holding[2] = 1234
        slave.holding.update({0x30: 0x41CC, 0x31: 0x0000})   # 25.5f
        slave.holding.update({0x20: 0x0001, 0x21: 0x0002})   # 65538
        eng.start_polling()
        time.sleep(0.4)
        eng.stop_polling()
        snap = {p["name"]: p for p in eng.snapshot()["points"]}
        self.assertEqual(snap["id"]["value"], 7)
        self.assertEqual(snap["tick"]["value"], 1234)
        self.assertAlmostEqual(snap["temp"]["value"], 25.5, places=3)
        self.assertEqual(snap["runtime"]["value"], 65538)
        self.assertGreater(eng.stats["ok"], 0)

    def test_contiguous_points_are_merged(self):
        """id/tick(0,2) 与 temp(0x30) 不相邻 → 至少 2 条请求，不该 4 条。"""
        eng, sess, slave = _engine(mapping=self._map())
        plan = eng._plan_group(eng.map["groups"][0])
        self.assertTrue(len(plan) <= 3, f"合并失败：{len(plan)} 条请求")
        # 相邻的两点应落在同一条请求里
        merged = [owners for _req, owners in plan
                  if any(n == "id" for n, _ in owners)]
        self.assertEqual(len(merged[0]), 2)

    def test_scale_only_affects_display(self):
        m = self._map()
        m["points"][0]["scale"] = 0.1
        eng, sess, slave = _engine(mapping=m)
        slave.holding[0] = 235
        res = eng.sample("id")
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["point"]["raw"], 235)
        self.assertAlmostEqual(res["point"]["value"], 23.5, places=6)

    def test_poll_requires_groups(self):
        eng, sess, slave = _engine()
        with self.assertRaises(ValueError):
            eng.start_polling()


class MapTest(unittest.TestCase):
    def _valid(self, **over):
        raw = {"rev": 0, "unit_id": 1, "points": [
            {"name": "id", "fc": 3, "address": 0, "type": "u16"}],
            "groups": [{"name": "g", "interval_ms": 200, "points": ["id"]}]}
        raw.update(over)
        return raw

    def test_accepts_valid(self):
        m = mm.normalize_map(self._valid())
        self.assertEqual(m["points"][0]["type"], "u16")
        self.assertFalse(m["points"][0]["writable"])

    def test_rejects(self):
        bad = [
            self._valid(points=[{"name": "a", "fc": 3, "address": 0, "type": "u32"}]),  # 缺字序
            self._valid(points=[{"name": "a", "fc": 3, "address": 0, "type": "bit"}]),   # 类型错配
            self._valid(points=[{"name": "a", "fc": 6, "address": 0, "type": "u16"}]),   # 写码当读点
            self._valid(points=[{"name": "a", "fc": 3, "address": 0, "type": "u16"},
                                {"name": "a", "fc": 3, "address": 1, "type": "u16"}]),  # 重名
            self._valid(groups=[{"name": "g", "interval_ms": 10, "points": ["id"]}]),    # 间隔太短
            self._valid(groups=[{"name": "g", "interval_ms": 200, "points": ["nope"]}]), # 引用缺失
            self._valid(unit_id=0),                                                      # 广播当从站
        ]
        for raw in bad:
            with self.assertRaises(ValueError):
                mm.normalize_map(raw)

    def test_save_uses_rev_optimistic_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = _Cfg(Path(tmp))
            m1 = mm.save_map(cfg, "demo", self._valid(), rev=0)
            self.assertEqual(m1["rev"], 1)
            with self.assertRaises(ValueError):
                mm.save_map(cfg, "demo", self._valid(), rev=0)   # 旧 rev
            m2 = mm.save_map(cfg, "demo", self._valid(), rev=1)
            self.assertEqual(m2["rev"], 2)
            self.assertEqual(mm.load_map(cfg, "demo")["rev"], 2)

    def test_missing_file_is_empty_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = mm.load_map(_Cfg(Path(tmp)), "nothing")
            self.assertEqual(m["rev"], 0)
            self.assertEqual(m["points"], [])


class _Cfg:
    def __init__(self, root: Path):
        self.root = root

    def resolved_project(self, name):
        return {"_path": str(self.root / "projects" / f"{name}.yaml")}


class StatsTest(unittest.TestCase):
    def tearDown(self):
        mm.close_engine("test")

    def test_transactions_ring_and_stats(self):
        eng, sess, slave = _engine()
        for _ in range(3):
            eng.read(mb.FC_READ_HOLDING, 0, 1)
        tr = eng.transactions()
        self.assertEqual(len(tr["transactions"]), 3)
        self.assertEqual(tr["transactions"][-1]["seq"], 3)
        self.assertIn("01 03 00 00 00 01", tr["transactions"][0]["tx_hex"])
        self.assertTrue(tr["transactions"][0]["rx_hex"].startswith("01 03 02"))
        st = eng.snapshot()["stats"]
        self.assertEqual(st["tx"], 3)
        self.assertEqual(st["ok"], 3)
        self.assertIsNotNone(st["last_ok_ms_ago"])

    def test_after_cursor(self):
        eng, sess, slave = _engine()
        eng.read(mb.FC_READ_HOLDING, 0, 1)
        seq = eng.transactions()["seq"]
        eng.read(mb.FC_READ_HOLDING, 0, 1)
        tr = eng.transactions(after=seq)
        self.assertEqual(len(tr["transactions"]), 1)


if __name__ == "__main__":
    unittest.main()
