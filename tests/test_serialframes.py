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


class ValidateEnhanced(unittest.TestCase):
    def test_old_profile_shape_is_unchanged(self):
        p = sf.normalize_profile({"id": "p", "frame": {"length": 4}})
        self.assertNotIn("length_field", p["frame"])
        self.assertNotIn("id_field", p["frame"])
        self.assertNotIn("variants", p)

    def test_length_and_length_field_are_exclusive(self):
        with self.assertRaises(ValueError):
            sf.normalize_profile({
                "id": "p",
                "frame": {"length": 8,
                          "length_field": {"offset": 0, "type": "u8"}}})

    def test_bit_field_rules(self):
        with self.assertRaises(ValueError):
            sf.normalize_profile({"id": "p", "frame": {"length": 4}, "fields": [
                {"name": "a", "offset": 0, "type": "f32",
                 "bit_offset": 0, "bit_length": 3}]})
        with self.assertRaises(ValueError):
            sf.normalize_profile({"id": "p", "frame": {"length": 4}, "fields": [
                {"name": "a", "offset": 0, "type": "u8", "bit_offset": 2}]})
        with self.assertRaises(ValueError):
            sf.normalize_profile({"id": "p", "frame": {"length": 1}, "fields": [
                {"name": "a", "offset": 0, "type": "u8",
                 "bit_offset": 4, "bit_length": 8}]})

    def test_variants_need_id_field_and_unique_ids(self):
        base = {"id": "p", "frame": {"head_hex": "AA", "tail_hex": "55"}}
        with self.assertRaises(ValueError):
            sf.normalize_profile(dict(base, variants=[
                {"id": 1, "fields": []}]))
        with self.assertRaises(ValueError):
            sf.normalize_profile({
                **base,
                "frame": {"head_hex": "AA", "tail_hex": "55",
                          "id_field": {"offset": 1, "type": "u8"}},
                "variants": [{"id": 1}, {"id": 1}]})

    def test_variant_field_semantics_must_match(self):
        with self.assertRaises(ValueError):
            sf.normalize_profile({
                "id": "p",
                "frame": {"head_hex": "AA", "tail_hex": "55",
                          "id_field": {"offset": 1, "type": "u8"}},
                "variants": [
                    {"id": 1, "fields": [
                        {"name": "v", "offset": 2, "type": "u16"}]},
                    {"id": 2, "fields": [
                        {"name": "v", "offset": 2, "type": "u8"}]},
                ]})


class DecodeEnhanced(unittest.TestCase):
    def test_bit_fields_lsb0_and_msb0(self):
        lsb = sf.normalize_profile({
            "id": "bits-lsb", "frame": {"length": 1},
            "fields": [
                {"name": "lo", "offset": 0, "type": "u8",
                 "bit_offset": 0, "bit_length": 3, "bit_order": "lsb0"},
                {"name": "hi", "offset": 0, "type": "u8",
                 "bit_offset": 3, "bit_length": 5, "bit_order": "lsb0"}]})
        res = codec.decode(b"\xA5", "profile:bits-lsb", profile=lsb)
        self.assertEqual(res["records"][0]["fields"], {"lo": 5, "hi": 20})
        msb = sf.normalize_profile({
            "id": "bits-msb", "frame": {"length": 1},
            "fields": [
                {"name": "lo", "offset": 0, "type": "u8",
                 "bit_offset": 0, "bit_length": 3, "bit_order": "msb0"},
                {"name": "hi", "offset": 0, "type": "u8",
                 "bit_offset": 3, "bit_length": 5, "bit_order": "msb0"}]})
        res = codec.decode(b"\xA5", "profile:bits-msb", profile=msb)
        self.assertEqual(res["records"][0]["fields"], {"lo": 5, "hi": 5})

    def test_signed_bit_field_is_sign_extended(self):
        p = sf.normalize_profile({
            "id": "sbits", "frame": {"length": 1},
            "fields": [{"name": "v", "offset": 0, "type": "i8",
                        "bit_offset": 0, "bit_length": 4}]})
        res = codec.decode(b"\x0F", "profile:sbits", profile=p)
        self.assertEqual(res["records"][0]["fields"]["v"], -1)

    def test_length_field_splits_variable_frames(self):
        p = sf.normalize_profile({
            "id": "var", "frame": {"head_hex": "AA",
                                   "length_field": {"offset": 1,
                                                    "type": "u8", "add": 2}},
            "fields": [{"name": "v", "offset": 2, "type": "u8"}]})
        data = b"\xAA\x03\x11\x22\x33" + b"\xAA\x01\x44"
        res = codec.decode(data, "profile:var", profile=p)
        self.assertEqual(res["total_frames"], 2)
        self.assertEqual([r["fields"]["v"] for r in res["records"]], [17, 68])
        self.assertEqual(res["pending_bytes"], 0)

    def test_invalid_length_field_skips_and_resyncs(self):
        p = sf.normalize_profile({
            "id": "var", "frame": {"head_hex": "AA",
                                   "length_field": {"offset": 1,
                                                    "type": "u8", "add": 2}}})
        res = codec.decode(b"\xAA\xFF\xAA\x01\x00", "profile:var", profile=p)
        self.assertEqual(res["total_frames"], 1)
        self.assertEqual(res["skipped"], 1)
        self.assertIn("长度字段非法", " ".join(res["errors"]))

    def test_variants_dispatch_and_union_channels(self):
        p = sf.normalize_profile({
            "id": "multi",
            "frame": {"head_hex": "AA", "tail_hex": "55",
                      "id_field": {"offset": 1, "type": "u8"}},
            "variants": [
                {"id": 1, "label": "speed", "fields": [
                    {"name": "speed", "offset": 2, "type": "u16"}]},
                {"id": 2, "label": "temp", "fields": [
                    {"name": "temp", "offset": 2, "type": "i16"}]},
            ]})
        data = (b"\xAA\x01\x64\x00\x55" + b"\xAA\x02\x9C\xFF\x55")
        res = codec.decode(data, "profile:multi", profile=p)
        self.assertEqual(res["total_frames"], 2)
        self.assertEqual(res["channels"], 2)
        self.assertEqual([f["name"] for f in res["fields"]], ["speed", "temp"])
        self.assertEqual(res["frames"], [[100.0, None], [None, -100.0]])
        self.assertEqual([r["id"] for r in res["records"]], [1, 2])
        self.assertEqual([r["variant"] for r in res["records"]],
                         ["speed", "temp"])
        self.assertEqual(res["unknown_id"], 0)

    def test_unknown_id_without_default_fields(self):
        p = sf.normalize_profile({
            "id": "multi",
            "frame": {"head_hex": "AA", "tail_hex": "55",
                      "id_field": {"offset": 1, "type": "u8"}},
            "variants": [{"id": 1, "fields": [
                {"name": "v", "offset": 2, "type": "u8"}]}]})
        res = codec.decode(b"\xAA\x09\x00\x55", "profile:multi", profile=p)
        self.assertEqual(res["total_frames"], 0)
        self.assertEqual(res["unknown_id"], 1)
        self.assertEqual(res["skipped"], 1)


class Encode(unittest.TestCase):
    def test_fixed_frame_roundtrip(self):
        p = _profile()
        enc = codec.encode(p, {"rpm": 100, "temp": -1, "mode": "RUN"})
        self.assertTrue(enc["ok"], enc)
        self.assertEqual(enc["bytes"], 11)
        self.assertEqual(enc["hex"], _frame().hex())
        dec = codec.decode(bytes.fromhex(enc["hex"]), "profile:x", profile=p)
        self.assertEqual(dec["records"][0]["fields"]["mode"], "RUN")

    def test_bitfield_roundtrip(self):
        p = sf.normalize_profile({
            "id": "bits", "frame": {"length": 2},
            "fields": [
                {"name": "lo", "offset": 0, "type": "u8",
                 "bit_offset": 0, "bit_length": 3},
                {"name": "hi", "offset": 0, "type": "u8",
                 "bit_offset": 3, "bit_length": 5},
                {"name": "n", "offset": 1, "type": "u8"}]})
        enc = codec.encode(p, {"lo": 5, "hi": 20, "n": 7})
        self.assertEqual(enc["hex"], "a507")
        dec = codec.decode(bytes.fromhex(enc["hex"]), "profile:bits",
                           profile=p)
        self.assertEqual(dec["records"][0]["fields"],
                         {"lo": 5, "hi": 20, "n": 7})

    def test_length_field_roundtrip(self):
        p = sf.normalize_profile({
            "id": "var", "frame": {"head_hex": "AA",
                                   "length_field": {"offset": 1,
                                                    "type": "u8", "add": 2}},
            "fields": [{"name": "v", "offset": 2, "type": "u8"}]})
        enc = codec.encode(p, {"v": 17})
        self.assertEqual(enc["hex"], "aa0111")
        self.assertEqual(enc["length_field"], 1)
        dec = codec.decode(bytes.fromhex(enc["hex"]), "profile:var", profile=p)
        self.assertEqual(dec["records"][0]["fields"]["v"], 17)

    def test_variant_encode_and_decode(self):
        p = sf.normalize_profile({
            "id": "multi",
            "frame": {"head_hex": "AA", "tail_hex": "55",
                      "id_field": {"offset": 1, "type": "u8"}},
            "variants": [
                {"id": 1, "label": "speed", "fields": [
                    {"name": "speed", "offset": 2, "type": "u16"}]}]})
        enc = codec.encode(p, {"speed": 100}, variant_id="0x01")
        self.assertEqual(enc["hex"], "aa01640055")
        dec = codec.decode(bytes.fromhex(enc["hex"]), "profile:multi",
                           profile=p)
        self.assertEqual(dec["records"][0]["variant"], "speed")

    def test_encode_errors_are_reported(self):
        p = sf.normalize_profile({
            "id": "multi",
            "frame": {"head_hex": "AA", "tail_hex": "55",
                      "id_field": {"offset": 1, "type": "u8"}},
            "variants": [{"id": 1, "fields": []}]})
        self.assertIn("必须给 variant", codec.encode(p, {})["error"])
        p2 = sf.normalize_profile({"id": "p", "frame": {"length": 2},
                                   "fields": [{"name": "a", "offset": 0,
                                               "type": "u8"}]})
        self.assertIn("范围", codec.encode(p2, {"a": 999})["error"])


class Templates(unittest.TestCase):
    def test_repo_templates_validate(self):
        cfg = FakeCfg(Path(__file__).resolve().parents[1])
        res = sf.list_templates(cfg)
        self.assertTrue(res["ok"], res["errors"])
        self.assertEqual([t["id"] for t in res["templates"]],
                         ["dlt645_read", "mavlink_v1", "modbus_rtu",
                          "telemetry_u16"])

    def test_import_template_saves_with_rev(self):
        import json
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            src = (Path(__file__).resolve().parents[1]
                   / "templates" / "frames" / "modbus_rtu.json")
            dst = root / "templates" / "frames"
            dst.mkdir(parents=True)
            shutil.copy(src, dst / "modbus_rtu.json")
            cfg = FakeCfg(root)
            res = sf.import_template(cfg, "p1", 0, "modbus_rtu",
                                     new_id="mb-demo")
            self.assertTrue(res["ok"], res)
            self.assertEqual(res["imported"], "mb-demo")
            self.assertEqual(sf.get(cfg, "p1", "mb-demo")["label"],
                             "Modbus RTU 响应（多 ID）")
            stale = sf.import_template(cfg, "p1", 0, "modbus_rtu")
            self.assertFalse(stale["ok"])
            self.assertTrue(stale.get("conflict"))

    def test_broken_template_does_not_block_others(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dst = root / "templates" / "frames"
            dst.mkdir(parents=True)
            (dst / "bad.json").write_text("{not json", encoding="utf-8")
            (dst / "ok.json").write_text(json.dumps({
                "id": "ok", "frame": {"length": 1}}), encoding="utf-8")
            res = sf.list_templates(FakeCfg(root))
            self.assertFalse(res["ok"])
            self.assertEqual([t["id"] for t in res["templates"]], ["ok"])
            self.assertIn("bad.json", res["errors"][0])


if __name__ == "__main__":
    unittest.main()
