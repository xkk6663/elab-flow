"""M5：帧协议 profile 的校验/存储/切帧解码（无硬件）。

判据（方案 §4.5）：
· 配置错误在保存时一次说清（id/字段/越界/切帧依据）；
· rev 乐观锁挡住并发覆盖，文件原子写；
· 通用解码引擎覆盖 head+tail / head+length / length、四种校验和、
  scale/bias/enum/ascii/bytes、坏帧与半帧；
· 预览与实际会话解码共用同一引擎（同一段字节结果一致）。
"""

from __future__ import annotations

import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, "services")

from elab import serialcodec as codec  # noqa: E402
from elab import serialframes as sf  # noqa: E402


class FakeCfg:
    def __init__(self, root: Path):
        self.root = root

    def resolved_project(self, name):
        return {"_path": str(Path(self.root) / "projects" / f"{name}.yaml")}


def _profile(pid="x-status", **over):
    raw = {
        "id": pid, "label": "X 状态帧", "kind": "binary",
        "frame": {"head_hex": "A5 5A", "tail_hex": "0D 0A", "length": 11},
        "checksum": {"kind": "crc16modbus", "at": "tail"},
        "fields": [
            {"name": "rpm", "offset": 2, "type": "u16", "endian": "le",
             "scale": 0.1, "unit": "RPM"},
            {"name": "temp", "offset": 4, "type": "i16", "endian": "le",
             "scale": 0.01, "unit": "C"},
            {"name": "mode", "offset": 6, "type": "u8",
             "enum": {"0": "IDLE", "1": "RUN"}},
        ],
    }
    raw.update(over)
    return sf.normalize_profile(raw)


def _frame(rpm=1000, temp=-100, mode=1, ck="crc16modbus", bad_ck=False) -> bytes:
    body = (b"\xA5\x5A" + struct.pack("<H", rpm) + struct.pack("<h", temp)
            + bytes([mode]))
    if ck == "crc16modbus":
        v = codec.crc16modbus(body) ^ (0xFFFF if bad_ck else 0)
        tail = struct.pack("<H", v)
    elif ck == "sum8":
        tail = bytes([(sum(body) + (1 if bad_ck else 0)) & 0xFF])
    elif ck == "xor8":
        x = 0
        for b in body:
            x ^= b
        tail = bytes([(x ^ (1 if bad_ck else 0)) & 0xFF])
    else:
        tail = b""
    return body + tail + b"\x0D\x0A"


class Validate(unittest.TestCase):
    def test_bad_id_and_unknown_type(self):
        with self.assertRaises(ValueError):
            sf.normalize_profile({"id": "Bad ID!", "frame": {"length": 4}})
        with self.assertRaises(ValueError):
            sf.normalize_profile({"id": "p", "frame": {"length": 4},
                                  "fields": [{"name": "a", "offset": 0,
                                              "type": "u64"}]})

    def test_need_head_or_length(self):
        with self.assertRaises(ValueError) as ctx:
            sf.normalize_profile({"id": "p", "frame": {"tail_hex": "0A"}})
        self.assertIn("head_hex 或 length", str(ctx.exception))

    def test_field_over_frame_is_rejected(self):
        with self.assertRaises(ValueError) as ctx:
            sf.normalize_profile({"id": "p", "frame": {"length": 4},
                                  "fields": [{"name": "a", "offset": 0,
                                              "type": "u16"},
                                             {"name": "b", "offset": 3,
                                              "type": "u16"}]})
        self.assertIn("越过帧长", str(ctx.exception))

    def test_duplicate_field_and_enum_on_float(self):
        with self.assertRaises(ValueError):
            sf.normalize_profile({"id": "p", "frame": {"length": 8}, "fields": [
                {"name": "a", "offset": 0, "type": "u8"},
                {"name": "a", "offset": 1, "type": "u8"}]})
        with self.assertRaises(ValueError):
            sf.normalize_profile({"id": "p", "frame": {"length": 8}, "fields": [
                {"name": "a", "offset": 0, "type": "f32",
                 "enum": {"0": "x"}}]})

    def test_defaults(self):
        p = sf.normalize_profile({"id": "p", "frame": {"length": 4}, "fields": [
            {"name": "a", "offset": 0, "type": "u16"}]})
        self.assertEqual(p["checksum"], {"kind": "none", "at": "tail"})
        self.assertEqual(p["frame"]["head_hex"], "")
        self.assertEqual(p["fields"][0]["scale"], 1.0)
        self.assertTrue(p["fields"][0]["plot"])


class Store(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = FakeCfg(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_file_is_rev0_empty(self):
        res = sf.load(self.cfg, "p1")
        self.assertTrue(res["ok"])
        self.assertEqual(res["rev"], 0)
        self.assertEqual(res["profiles"], [])

    def test_save_conflict_then_success(self):
        p = sf.normalize_profile({"id": "p", "frame": {"length": 4}})
        ok = sf.save(self.cfg, "p1", 0, p)
        self.assertTrue(ok["ok"], ok)
        self.assertEqual(ok["rev"], 1)
        stale = sf.save(self.cfg, "p1", 0, dict(p, label="改"))
        self.assertFalse(stale["ok"])
        self.assertTrue(stale.get("conflict"))
        self.assertEqual(stale["rev"], 1)
        ok2 = sf.save(self.cfg, "p1", 1, dict(p, label="改"))
        self.assertTrue(ok2["ok"], ok2)
        self.assertEqual(sf.load(self.cfg, "p1")["rev"], 2)
        self.assertEqual(sf.get(self.cfg, "p1", "p")["label"], "改")

    def test_delete_and_missing_profile(self):
        p = sf.normalize_profile({"id": "p", "frame": {"length": 4}})
        sf.save(self.cfg, "p1", 0, p)
        gone = sf.delete(self.cfg, "p1", 1, "nope")
        self.assertFalse(gone["ok"])
        self.assertEqual(len(sf.load(self.cfg, "p1")["profiles"]), 1)
        ok = sf.delete(self.cfg, "p1", 1, "p")
        self.assertTrue(ok["ok"])
        self.assertEqual(sf.load(self.cfg, "p1")["profiles"], [])

    def test_broken_json_does_not_crash(self):
        path = sf.frames_path(self.cfg, "p1")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        res = sf.load(self.cfg, "p1")
        self.assertFalse(res["ok"])
        self.assertIn("不是合法 JSON", res["error"])
        self.assertFalse(sf.save(self.cfg, "p1", 0, {"id": "p"})["ok"])


class Decode(unittest.TestCase):
    def test_head_length_tail_with_crc(self):
        p = _profile()
        res = codec.decode(_frame(), "profile:x-status", profile=p)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["total_frames"], 1)
        self.assertEqual(res["channels"], 2)
        rec = res["records"][0]["fields"]
        self.assertAlmostEqual(rec["rpm"], 100.0, places=4)
        self.assertAlmostEqual(rec["temp"], -1.0, places=4)
        self.assertEqual(rec["mode"], "RUN")
        self.assertEqual([f["name"] for f in res["fields"]],
                         ["rpm", "temp", "mode"])

    def test_sum8_and_xor8(self):
        for kind in ("sum8", "xor8"):
            # head2 + data3 + ck1 + tail2 = 8? 这里 data 是 rpm2+temp2+mode1=5
            # → 2 + 5 + 1 + 2 = 10
            p = sf.normalize_profile({
                "id": "x", "frame": {"head_hex": "A5 5A", "tail_hex": "0D 0A",
                                     "length": 10},
                "checksum": {"kind": kind, "at": "tail"},
                "fields": [{"name": "mode", "offset": 6, "type": "u8"}]})
            res = codec.decode(_frame(mode=1, ck=kind), "profile:x", profile=p)
            self.assertTrue(res["ok"], res)
            self.assertEqual(res["records"][0]["fields"]["mode"], 1)
            self.assertEqual(res["checksum_fail"], 0)

    def test_bad_checksum_counted_not_silent(self):
        p = _profile()
        res = codec.decode(_frame(bad_ck=True), "profile:x", profile=p)
        self.assertEqual(res["total_frames"], 0)
        self.assertEqual(res["checksum_fail"], 1)
        self.assertIn("校验失败", " ".join(res["errors"]))
        self.assertEqual(res["skipped"], 1)

    def test_half_frame_is_pending(self):
        p = _profile()
        full = _frame()
        head, rest = full[:5], full[5:]
        r1 = codec.decode(head, "profile:x", profile=p)
        self.assertEqual(r1["total_frames"], 0)
        self.assertEqual(r1["pending_bytes"], 5)
        # 调用方把 pending 拼进下一批（与监视会话同款）
        import base64
        pending = base64.b64decode(r1["pending_b64"])
        r2 = codec.decode(pending + rest, "profile:x", profile=p)
        self.assertEqual(r2["total_frames"], 1)

    def test_length_only(self):
        p = sf.normalize_profile({
            "id": "fixed", "frame": {"length": 4},
            "fields": [{"name": "a", "offset": 0, "type": "u16"},
                       {"name": "b", "offset": 2, "type": "u16"}]})
        data = struct.pack("<HH", 1, 2) + struct.pack("<HH", 3, 4)
        res = codec.decode(data, "profile:fixed", profile=p)
        self.assertEqual(res["total_frames"], 2)
        self.assertEqual([r["fields"] for r in res["records"]],
                         [{"a": 1, "b": 2}, {"a": 3, "b": 4}])

    def test_head_tail_without_length(self):
        p = sf.normalize_profile({
            "id": "ht", "frame": {"head_hex": "AA", "tail_hex": "55"},
            "fields": [{"name": "v", "offset": 1, "type": "u8"}]})
        res = codec.decode(b"\xAA\x01\x55\xAA\x02\x55", "profile:ht", profile=p)
        self.assertEqual([r["fields"]["v"] for r in res["records"]], [1, 2])

    def test_ascii_and_bytes_fields(self):
        p = sf.normalize_profile({
            "id": "ab", "frame": {"length": 10},
            "fields": [{"name": "name", "offset": 0, "type": "ascii",
                        "length": 6},
                       {"name": "raw", "offset": 6, "type": "bytes",
                        "length": 4}]})
        res = codec.decode(b"hello\x00" + b"\x01\x02\x03\x04", "profile:ab",
                           profile=p)
        rec = res["records"][0]["fields"]
        self.assertEqual(rec["name"], "hello\x00")
        self.assertEqual(rec["raw"], "01020304")
        self.assertEqual(res["channels"], 0)       # 非数值字段不进波形

    def test_unknown_decoder_and_missing_profile(self):
        self.assertFalse(codec.decode(b"", "nope")["ok"])
        res = codec.decode(b"\x01", "profile:x")
        self.assertFalse(res["ok"])
        self.assertIn("需要 profile", res["error"])


if __name__ == "__main__":
    unittest.main()
