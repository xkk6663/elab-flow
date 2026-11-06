"""M1：Modbus RTU PDU 编解码金向量（无硬件）。

判据（计划 §5.8）：
· CRC16/MODBUS 标准检查值 `123456789 → 0x4B37`，线上低字节在前；
· 请求/应答逐字节可复现（拿标准帧当金向量，不拿自己的输出当证据）；
· 五类错误各自归位：crc / exception / malformed（timeout/port 在事务层）；
· 类型与字序：u16/s16/u32/s32/f32/bit 双向一致，字序错误必须能看出来；
· 边界数量当场拒绝（宁可 build 抛错，也不发一帧非法请求）。
"""

from __future__ import annotations

import struct
import sys
import unittest

sys.path.insert(0, "services")

from elab import modbus as mb  # noqa: E402


def _resp(req, body: bytes) -> bytes:
    """按请求拼一帧"从站应答"（body 不含 unit/fc/crc）。"""
    head = bytes((req.unit, req.fc)) + body
    return head + mb.crc_bytes(head)


class CrcTest(unittest.TestCase):
    def test_check_value(self):
        # CRC-16/MODBUS 的通用检查值：任何实现都必须对上这一个数
        self.assertEqual(mb.crc16_modbus(b"123456789"), 0x4B37)

    def test_wire_order_low_first(self):
        head = bytes.fromhex("01 03 00 00 00 0A")
        crc = mb.crc16_modbus(head)
        self.assertEqual(mb.crc_bytes(head).hex(" ").upper(),
                         f"{crc & 0xFF:02X} {crc >> 8:02X}")

    def test_check_crc_reports_bad_frame(self):
        with self.assertRaises(mb.ModbusError) as ctx:
            mb.check_crc(bytes.fromhex("01 03 00 00 00 0A C5 CE"))
        self.assertEqual(ctx.exception.kind, "crc")


class EncodeTest(unittest.TestCase):
    def test_read_holding_golden_frame(self):
        """标准例：从站 1 读 0 起 10 个保持寄存器 → 01 03 00 00 00 0A C5 CD。"""
        req = mb.build(mb.FC_READ_HOLDING, 0, count=10, unit=1)
        self.assertEqual(req.encode().hex(" ").upper(),
                         "01 03 00 00 00 0A C5 CD")

    def test_write_single_register(self):
        req = mb.build(mb.FC_WRITE_REGISTER, 0x0010, values=[0x0001], unit=1)
        frame = req.encode()
        self.assertEqual(frame[:6], bytes.fromhex("01 06 00 10 00 01"))
        mb.check_crc(frame)                       # 自己产的帧必须自洽

    def test_write_coil_uses_ff00(self):
        req = mb.build(mb.FC_WRITE_COIL, 3, values=[1], unit=1)
        self.assertEqual(req.encode()[2:6], bytes.fromhex("00 03 FF 00"))
        off = mb.build(mb.FC_WRITE_COIL, 3, values=[0], unit=1)
        self.assertEqual(off.encode()[2:6], bytes.fromhex("00 03 00 00"))

    def test_write_coils_packs_lsb_first(self):
        bits = [1, 0, 1, 1, 0, 0, 1, 1, 1]        # 9 位 → 2 字节
        req = mb.build(mb.FC_WRITE_COILS, 0, values=bits, unit=1)
        body = req.encode()
        self.assertEqual(body[2:7], bytes.fromhex("00 00 00 09 02"))
        # 低位先：1,0,1,1,0,0,1,1 → 0b11001101 = 0xCD；第 9 位单独在下一字节
        self.assertEqual(body[7:9], bytes.fromhex("CD 01"))

    def test_write_registers_body(self):
        req = mb.build(mb.FC_WRITE_REGISTERS, 0x0020,
                       values=[0x1234, 0x5678], unit=1)
        frame = req.encode()
        self.assertEqual(frame[2:11], bytes.fromhex("00 20 00 02 04 12 34 56 78"))
        self.assertEqual(len(frame), 13)          # 1+1+2+2+1+4+2

    def test_broadcast_unit_zero(self):
        req = mb.build(mb.FC_WRITE_REGISTER, 0, values=[7], unit=0)
        self.assertTrue(req.broadcast)
        self.assertEqual(req.encode()[0], 0)

    def test_limits_rejected_before_wire(self):
        cases = [
            (mb.FC_READ_HOLDING, dict(count=126)),   # 上限 125
            (mb.FC_READ_COILS, dict(count=2001)),    # 上限 2000
            (mb.FC_READ_HOLDING, dict(count=0)),
            (mb.FC_WRITE_REGISTERS, dict(values=[0] * 124)),
            (mb.FC_WRITE_REGISTER, dict(values=[0x10000])),
        ]
        for fc, kw in cases:
            with self.assertRaises(mb.ModbusError, msg=f"{fc} {kw}"):
                mb.build(fc, 0, unit=1, **kw)

    def test_bad_unit_and_address(self):
        with self.assertRaises(mb.ModbusError):
            mb.build(mb.FC_READ_HOLDING, 0, count=1, unit=248)
        with self.assertRaises(mb.ModbusError):
            mb.build(mb.FC_READ_HOLDING, 0xFFFF, count=2, unit=1)


class ParseTest(unittest.TestCase):
    def test_read_holding_roundtrip(self):
        req = mb.build(mb.FC_READ_HOLDING, 0, count=3, unit=1)
        body = bytes([6]) + struct.pack(">HHH", 0x0001, 0x0002, 0x0003)
        resp = mb.parse(req, _resp(req, body))
        self.assertEqual(resp.values, [1, 2, 3])
        self.assertEqual(resp.fc, 3)

    def test_read_coils_unpacks(self):
        req = mb.build(mb.FC_READ_COILS, 0, count=10, unit=1)
        body = bytes([2]) + bytes([0b01001101, 0b00000011])
        resp = mb.parse(req, _resp(req, body))
        self.assertEqual(resp.values,
                         [1, 0, 1, 1, 0, 0, 1, 0, 1, 1])

    def test_exception_frame(self):
        req = mb.build(mb.FC_READ_HOLDING, 0xFFF0, count=4, unit=1)
        frame = _resp(mb.Request(unit=1, fc=0x83, address=0, count=0),
                      bytes([0x02]))
        with self.assertRaises(mb.ModbusError) as ctx:
            mb.parse(req, frame)
        self.assertEqual(ctx.exception.kind, "exception")
        self.assertEqual(ctx.exception.code, 0x02)
        self.assertIn("地址越界", ctx.exception.detail)

    def test_crc_error(self):
        req = mb.build(mb.FC_READ_HOLDING, 0, count=1, unit=1)
        frame = bytearray(_resp(req, bytes([2]) + struct.pack(">H", 7)))
        frame[-1] ^= 0xFF
        with self.assertRaises(mb.ModbusError) as ctx:
            mb.parse(req, bytes(frame))
        self.assertEqual(ctx.exception.kind, "crc")

    def test_wrong_length(self):
        req = mb.build(mb.FC_READ_HOLDING, 0, count=2, unit=1)
        body = bytes([2]) + struct.pack(">H", 7)      # 少一个寄存器
        with self.assertRaises(mb.ModbusError) as ctx:
            mb.parse(req, _resp(req, body))
        self.assertEqual(ctx.exception.kind, "malformed")

    def test_wrong_unit(self):
        req = mb.build(mb.FC_READ_HOLDING, 0, count=1, unit=1)
        frame = bytes([2, 3, 2, 0, 7]) + mb.crc_bytes(bytes([2, 3, 2, 0, 7]))
        with self.assertRaises(mb.ModbusError) as ctx:
            mb.parse(req, frame)
        self.assertEqual(ctx.exception.kind, "malformed")

    def test_write_echo_mismatch(self):
        req = mb.build(mb.FC_WRITE_REGISTER, 0x10, values=[1], unit=1)
        body = struct.pack(">HH", 0x10, 2)            # 值回显错
        with self.assertRaises(mb.ModbusError) as ctx:
            mb.parse(req, _resp(req, body))
        self.assertEqual(ctx.exception.kind, "malformed")

    def test_response_size(self):
        self.assertEqual(mb.response_size(mb.build(mb.FC_READ_HOLDING, 0, count=10)), 25)
        self.assertEqual(mb.response_size(mb.build(mb.FC_READ_COILS, 0, count=10)), 7)
        self.assertEqual(mb.response_size(mb.build(mb.FC_WRITE_REGISTER, 0,
                                                   values=[1])), 8)


class ValueTest(unittest.TestCase):
    def test_u32_word_order(self):
        # 同一个线上字串，两种字序必须给出不同结果 —— 写错字序是"数值离谱"的根因
        words = [0x1234, 0x5678]
        self.assertEqual(mb.decode_registers(words, "u32", "big"), 0x12345678)
        self.assertEqual(mb.decode_registers(words, "u32", "little"), 0x56781234)

    def test_signed(self):
        self.assertEqual(mb.decode_registers([0xFFFE], "s16"), -2)
        self.assertEqual(mb.decode_registers([0xFFFF, 0xFFFF], "s32"), -1)

    def test_float(self):
        words = mb.encode_registers(25.5, "f32", "big")
        self.assertEqual(words, [0x41CC, 0x0000])
        self.assertAlmostEqual(mb.decode_registers(words, "f32", "big"), 25.5, places=6)

    def test_roundtrip_all_types(self):
        cases = [("u16", 65535, 1), ("s16", -1234, 1), ("u32", 4000000000, 2),
                 ("s32", -70000, 2), ("f32", -0.125, 2)]
        for type_, value, nwords in cases:
            for order in ("big", "little"):
                words = mb.encode_registers(value, type_, order)
                self.assertEqual(len(words), nwords)
                self.assertEqual(mb.decode_registers(words, type_, order),
                                 value if type_ != "f32" else value)

    def test_bit(self):
        self.assertEqual(mb.decode_registers([7], "bit"), 1)
        self.assertEqual(mb.decode_registers([0], "bit"), 0)
        self.assertEqual(mb.encode_registers(True, "bit"), [1])

    def test_scaled(self):
        self.assertEqual(mb.scaled(235, scale=0.1), 23.5)
        self.assertEqual(mb.scaled(235, scale=0.1, bias=-10), 13.5)

    def test_unknown_type(self):
        with self.assertRaises(mb.ModbusError):
            mb.decode_registers([1], "u24")


class MetaTest(unittest.TestCase):
    def test_limits_are_machine_readable(self):
        lim = mb.limits()
        self.assertEqual(lim["max_read_regs"], 125)
        self.assertEqual({e["code"] for e in lim["exceptions"]},
                         {1, 2, 3, 4, 5, 6, 8, 10, 11})
        self.assertEqual(len(lim["fc"]), 8)

    def test_describe_marks_bad_crc(self):
        good = bytes.fromhex("01 03 00 00 00 0A C5 CD")
        self.assertTrue(mb.describe(good)["crc_ok"])
        self.assertFalse(mb.describe(good[:-1] + b"\x00")["crc_ok"])


if __name__ == "__main__":
    unittest.main()
