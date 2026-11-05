"""P4：抓包学习 / round-trip 校验 / 自动匹配 / C 头文件生成（无硬件）。

判据（执行计划 §6）：
· learn 从一段抓包学出**能解出帧**的草稿，并把证据/置信度一起给出来；
· learn 只产草稿，不写任何文件（保存仍走 save 的 rev 乐观锁）；
· verify 对"能解"的 profile 必须 100% 逐字节还原，改错一个字节要如实失败；
· auto 只推荐不静默：分数不够或前两名接近时明确拒绝；
· codegen 产物是合法 C（有编译器就真的编一遍），偏移表与 profile 一致。
"""

from __future__ import annotations

import base64
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, "services")

from elab import framelearn as fl  # noqa: E402
from elab import serialcodec as codec  # noqa: E402
from elab import serialframes as sf  # noqa: E402


def _frame_var(i: int) -> bytes:
    """变长 + CRC16/Modbus：AA 55 | type | len(=total) | data... | crc16(le)"""
    body = bytes([0xAA, 0x55, 0x01, 0x00, i, (i * 3) & 0xFF, 0x33, 0x44])
    total = len(body) + 2
    body = body[:3] + bytes([total]) + body[4:]
    return body + codec.crc16modbus(body).to_bytes(2, "little")


def _frame_fixed(i: int) -> bytes:
    """定长无校验：3A | a | b | 0D 0A"""
    return bytes([0x3A, i, (i + 1) & 0xFF, 0x0D, 0x0A])


VAR_FRAMES = [_frame_var(i) for i in range(1, 9)]
FIXED_FRAMES = [_frame_fixed(i) for i in range(1, 9)]


class LearnTests(unittest.TestCase):
    def test_variable_length_with_crc(self):
        blob = b"".join(VAR_FRAMES)
        r = fl.learn(hex=blob.hex(), name="learned_telemetry")
        self.assertTrue(r["ok"], r.get("error"))
        draft = r["draft"]
        self.assertEqual(draft["frame"]["head_hex"], "aa55")   # 不是 AA55010A
        self.assertEqual(draft["frame"]["length"], 10)
        self.assertEqual(draft["checksum"]["kind"], "crc16modbus")
        self.assertGreaterEqual(r["confidence"], 0.9)
        self.assertEqual(r["decode_rate"], 1.0)
        self.assertTrue(any("AA55" in e for e in r["evidence"]))
        # 学到的草稿必须真能解出全部帧
        dec = codec.decode(blob, "profile:learned_telemetry", profile=draft)
        self.assertEqual(dec["total_frames"], len(VAR_FRAMES))

    def test_fixed_length_without_checksum(self):
        r = fl.learn(frames=[f.hex() for f in FIXED_FRAMES], name="fixed_tail")
        self.assertTrue(r["ok"], r.get("error"))
        self.assertEqual(r["draft"]["frame"]["length"], 5)
        self.assertEqual(r["draft"]["checksum"]["kind"], "none")
        self.assertEqual(r["decode_rate"], 1.0)

    def test_capture_jsonl_input(self):
        lines = "\n".join(
            json.dumps({"t_us": i * 1000, "dir": "rx",
                        "bytes_b64": base64.b64encode(f).decode()})
            for i, f in enumerate(VAR_FRAMES))
        r = fl.learn(capture=lines, name="from_capture")
        self.assertTrue(r["ok"], r.get("error"))
        self.assertEqual(r["draft"]["checksum"]["kind"], "crc16modbus")

    def test_capture_ignores_tx(self):
        """TX 是我们自己发出去的：学协议不能把它当设备输出。"""
        tx = "\n".join(
            json.dumps({"t_us": i, "dir": "tx",
                        "bytes_b64": base64.b64encode(b"\x01\x02").decode()})
            for i in range(10))
        with self.assertRaises(fl.LearnError):
            fl.learn(capture=tx)

    def test_hints_head(self):
        blob = b"".join(VAR_FRAMES)
        r = fl.learn(hex=blob.hex(), name="hinted",
                     hints={"heads": ["AA55"]})
        self.assertTrue(r["ok"], r.get("error"))
        self.assertEqual(r["draft"]["frame"]["head_hex"], "aa55")

    def test_too_short_raises(self):
        with self.assertRaises(fl.LearnError):
            fl.learn(hex="aabb")

    def test_no_input_raises(self):
        with self.assertRaises(fl.LearnError):
            fl.learn(name="x")

    def test_does_not_write_files(self):
        """learn 是纯函数式的：跑一遍不该在工程里留下任何东西。"""
        with tempfile.TemporaryDirectory() as tmp:
            before = sorted(Path(tmp).rglob("*"))
            fl.learn(hex=b"".join(VAR_FRAMES).hex(), name="pure")
            self.assertEqual(before, sorted(Path(tmp).rglob("*")))

    def test_confidence_drops_without_checksum(self):
        a = fl.learn(hex=b"".join(VAR_FRAMES).hex(), name="a")
        b = fl.learn(hex=b"".join(FIXED_FRAMES).hex(), name="b")
        self.assertGreater(a["confidence"], b["confidence"])

    def test_bad_id_is_slugified(self):
        r = fl.learn(hex=b"".join(VAR_FRAMES).hex(), name="My Sensor #1")
        self.assertTrue(r["ok"], r.get("error"))
        self.assertRegex(r["draft"]["id"], r"^[a-z0-9_-]{1,32}$")


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.draft = fl.learn(hex=b"".join(VAR_FRAMES).hex(),
                              name="verify_me")["draft"]

    def test_roundtrip_all_pass(self):
        v = fl.verify(self.draft, hex=b"".join(VAR_FRAMES).hex())
        self.assertTrue(v["ok"], v)
        self.assertEqual(v["pass_rate"], 1.0)

    def test_explicit_vectors(self):
        v = fl.verify(self.draft, vectors=[f.hex() for f in VAR_FRAMES])
        self.assertTrue(v["ok"], v)
        self.assertEqual(v["total"], len(VAR_FRAMES))

    def test_wrong_profile_fails(self):
        bad = sf.normalize_profile({
            "id": "wrong", "frame": {"head_hex": "aa55", "length": 10},
            "checksum": {"kind": "none"},
            "fields": [{"name": "x", "offset": 2, "type": "u8"}]})
        v = fl.verify(bad, hex=b"".join(VAR_FRAMES).hex())
        # 只描述了一个字节 → 拼回去必然和原始帧不同
        self.assertFalse(v["ok"])
        self.assertGreater(v["failed"], 0)
        self.assertIsNotNone(v["failures"][0].get("first_diff"))

    def test_no_frames_is_error(self):
        wrong = sf.normalize_profile({
            "id": "nomatch", "frame": {"head_hex": "ffff", "length": 4},
            "checksum": {"kind": "none"}, "fields": []})
        v = fl.verify(wrong, hex=b"".join(VAR_FRAMES).hex())
        self.assertFalse(v["ok"])
        self.assertEqual(v["total"], 0)


class AutoTests(unittest.TestCase):
    def test_picks_matching_profile(self):
        blob = b"".join(VAR_FRAMES)
        good = fl.learn(hex=blob.hex(), name="good")["draft"]
        other = sf.normalize_profile({
            "id": "mavlink", "frame": {"head_hex": "fe", "max_bytes": 256,
                                       "length_field": {"offset": 1, "type": "u8",
                                                        "mul": 1, "add": 8}},
            "checksum": {"kind": "none"}, "fields": []})
        out = fl.auto([other, good], blob)
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["decoder"], "profile:good")
        self.assertGreaterEqual(out["score"], fl.AUTO_MIN_SCORE)

    def test_no_match_does_not_guess(self):
        blob = b"".join(VAR_FRAMES)
        other = sf.normalize_profile({
            "id": "mavlink", "frame": {"head_hex": "fe", "max_bytes": 256,
                                       "length_field": {"offset": 1, "type": "u8",
                                                        "mul": 1, "add": 8}},
            "checksum": {"kind": "none"}, "fields": []})
        out = fl.auto([other], blob)
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "no-match")

    def test_ambiguous_reports_ambiguous(self):
        blob = b"".join(VAR_FRAMES)
        a = fl.learn(hex=blob.hex(), name="twin_a")["draft"]
        b = fl.learn(hex=blob.hex(), name="twin_b")["draft"]
        out = fl.auto([a, b], blob)
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "ambiguous")

    def test_score_uses_coverage(self):
        blob = b"".join(VAR_FRAMES)
        good = fl.learn(hex=blob.hex(), name="cov")["draft"]
        s = fl.score_profile(good, blob)
        self.assertEqual(s["coverage"], 1.0)
        self.assertEqual(s["frames"], len(VAR_FRAMES))


class CodegenTests(unittest.TestCase):
    def setUp(self):
        self.draft = fl.learn(hex=b"".join(FIXED_FRAMES).hex(),
                              name="cg")["draft"]

    def test_bad_guard_falls_back_to_default(self):
        # guard 会被原样拼进 #ifndef —— 非法字符/换行不能漏进头文件
        out = fl.codegen(self.draft, guard="X\n#endif\nint evil;")
        self.assertTrue(out["ok"])
        self.assertIn("#ifndef ELAB_FRAME_CG_H", out["text"])
        self.assertNotIn("int evil;", out["text"])
        self.assertTrue(out["warnings"])

    def test_field_name_is_c_identifier(self):
        # profile 的字段名允许中文/连字符（schema 只要求非空不重复），
        # 但拼进 C 源码必须变成合法标识符，否则生成的头文件编不过
        prof = dict(self.draft)
        prof["fields"] = [
            {"name": "温度", "type": "u16", "offset": 2, "endian": "le"},
            {"name": "3-phase", "type": "u8", "offset": 4},
        ]
        out = fl.codegen(prof)
        self.assertTrue(out["ok"])
        text = out["text"]
        self.assertNotIn("温度", text)
        self.assertNotIn("3-phase", text)
        self.assertIn("_3_phase", text)

    def test_header_shape(self):
        out = fl.codegen(self.draft)
        self.assertTrue(out["ok"])
        text = out["text"]
        self.assertIn("#ifndef ELAB_FRAME_CG_H", text)
        self.assertIn("#pragma pack(push, 1)", text)
        self.assertIn("} ELAB_FRAME_CG_t;", text)
        self.assertIn("_OFF_B1", text)
        self.assertIn("stdint.h", text)

    def test_compiles_if_cc_available(self):
        cc = shutil.which("gcc") or shutil.which("cc") or shutil.which("clang")
        if not cc:
            self.skipTest("本机没有 C 编译器")
        out = fl.codegen(self.draft)
        with tempfile.TemporaryDirectory() as tmp:
            h = Path(tmp) / "cg.h"
            h.write_text(out["text"], encoding="utf-8")
            c = Path(tmp) / "main.c"
            c.write_text('#include "cg.h"\nint main(void){ return (int)sizeof(ELAB_FRAME_CG_t); }\n',
                         encoding="utf-8")
            proc = subprocess.run([cc, "-std=c99", "-Wall", "-Werror", "-c",
                                   str(c), "-o", str(Path(tmp) / "main.o")],
                                  capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)


class PrivateProtoLearn(unittest.TestCase):
    """真机私有协议形状：5A A5 | id | v1(le) | v2(le) | seq | flags | crc8_maxim。

    这一段同时是**回归测试**：``learn`` 的形参叫 ``hex``（业务名），会遮蔽内置
    ``hex()`` —— 消息 id 的取证行曾经因此直接 TypeError，而只有"样本里真有 id
    字段"才会走到那一行，靠无 id 的样本永远测不出来。
    """

    @staticmethod
    def _frame(seq: int) -> bytes:
        f = bytearray(10)
        f[0], f[1] = 0x5A, 0xA5
        f[2] = 1 if seq % 2 == 0 else 2
        v1 = (200 + (seq * 3) % 150) if seq % 2 == 0 else (3300 + seq % 200)
        v2 = (450 + (seq * 7) % 200) if seq % 2 == 0 else (120 + (seq * 5) % 80)
        f[3], f[4] = v1 & 0xFF, (v1 >> 8) & 0xFF
        f[5], f[6] = v2 & 0xFF, (v2 >> 8) & 0xFF
        f[7] = seq & 0xFF
        f[8] = 0x01 if seq % 2 == 0 else 0x02
        f[9] = codec.crc_compute(bytes(f[:9]), width=8, poly=0x31, init=0,
                                 xorout=0, refin=True, refout=True)
        return bytes(f)

    def test_hex_input_detects_id_field(self):
        blob = b"".join(self._frame(i) for i in range(40))
        r = fl.learn(hex=blob.hex(), name="private_proto")
        self.assertTrue(r["ok"], r.get("error"))
        draft = r["draft"]
        self.assertEqual(draft["frame"]["head_hex"], "5aa5")
        self.assertEqual(draft["frame"]["length"], 10)
        # 声明式校验：kind 是宽度档（crc8/crc16/crc32），算法在 preset 里
        self.assertEqual(draft["checksum"]["kind"], "crc8")
        self.assertEqual(draft["checksum"]["preset"], "crc8_maxim")
        self.assertEqual(draft["frame"]["id_field"]["offset"], 2)
        self.assertEqual(len(draft.get("variants") or []), 2)
        self.assertTrue(any("消息 id" in e for e in r["evidence"]), r["evidence"])
        self.assertEqual(r["decode_rate"], 1.0)
        dec = codec.decode(blob, "profile:private_proto", profile=draft)
        self.assertEqual(dec["total_frames"], 40)

    def test_real_capture_prefix_noise_is_survived(self):
        """真机录制的两种噪声：开头上一组演示帧 + 与二进制帧交错的 ASCII 日志行。

        心跳日志（"\\r\\n[alive] tick=…"）每 20 帧插一行，会让 split_by_head
        切出长度不一的片段 —— 按"长度全等"判定就会误判成变长帧、字段全错位。
        """
        noise = (b"\xAA\x55\x33\x05\x5D\x01\x01\x01\xB1\x04\x96\xD5\x0D\x0A"
                 + b"\xFE\x02\x01\x01\x01\x1E\x6D\x04\x00\x00"
                 + b"\x7E\x7E\x01\x6D\x04\x21\x00"
                 + b"[cmd] LEARN -> 200 frames\r\n")
        parts = [noise]
        for i in range(60):
            if i and i % 20 == 0:
                parts.append(b"[alive] test tick=%d cmds=1 led=1Hz\r\n" % i)
            parts.append(self._frame(i))
        r = fl.learn(hex=b"".join(parts).hex(), name="noisy")
        self.assertTrue(r["ok"], r.get("error"))
        draft = r["draft"]
        self.assertEqual(draft["frame"]["head_hex"], "5aa5")   # 不是 5A，也不是 0A5AA501
        self.assertEqual(draft["frame"]["length"], 10)
        self.assertEqual(draft["checksum"]["preset"], "crc8_maxim")
        self.assertEqual(draft["frame"]["id_field"]["offset"], 2)
        self.assertGreaterEqual(r["decode_rate"], 0.9)
        self.assertTrue(any("长度不符" in e for e in r["evidence"]), r["evidence"])


class ScaleGuards(unittest.TestCase):
    """大样本的规模闸门（2026-11-05 健壮性复查）。

    没有这几道闸时 ``learn`` 是「预设数 × 帧数」的乘法：实测 58 KB / 6.5k 帧
    要跑 30 s，1 MB 量级的录制能把内核请求拖到分钟级（前端/agent 都超时）。
    这里只看"有闸 + 结果还对"，具体耗时留给 ``tests/bench_serialcodec.py``。
    """

    @staticmethod
    def _frame(i: int) -> bytes:
        body = bytes([1 if i % 2 else 2]) + struct.pack("<HHB", 2000 + i % 50, 45, i & 0xFF)
        f = b"\x5a\xa5" + body
        return f + bytes([sum(f) & 0xFF])

    @classmethod
    def _blob(cls, n_frames: int) -> bytes:
        return b"".join(cls._frame(i) for i in range(n_frames))

    def test_huge_sample_is_truncated_with_warning(self):
        blob = self._blob(20000)          # ≈180 KB，超过 MAX_ANALYZE_BYTES
        self.assertGreater(len(blob), fl.MAX_ANALYZE_BYTES)
        r = fl.learn(hex=blob.hex(), name="big")
        self.assertTrue(r["ok"], r.get("error"))
        self.assertTrue(any("只分析前" in w for w in r["warnings"]), r["warnings"])
        # 结论不能被截断改坏
        self.assertEqual(r["draft"]["frame"]["head_hex"], "5aa5")
        self.assertEqual(r["draft"]["frame"]["length"], 9)
        self.assertEqual(r["draft"]["checksum"]["kind"], "sum8")
        self.assertEqual(r["draft"]["frame"]["id_field"]["offset"], 2)

    def test_frame_list_is_capped(self):
        frames = [self._frame(i) for i in range(fl.MAX_LEARN_FRAMES + 500)]
        r = fl.learn(frames=frames, name="many")
        self.assertTrue(r["ok"], r.get("error"))
        self.assertLessEqual(r["sample_frames"], fl.MAX_LEARN_FRAMES)
        self.assertTrue(any("只分析前" in w for w in r["warnings"]), r["warnings"])

    def test_detect_probe_is_bounded(self):
        # 探测函数自己也要封顶：learn 之外（verify/auto）也走这条路
        frames = [self._frame(i) for i in range(2000)]
        ok = fl.detect_checksum(frames, 2, 0)
        self.assertIsNotNone(ok)
        self.assertEqual(ok["kind"], "sum8")


if __name__ == "__main__":
    unittest.main()
