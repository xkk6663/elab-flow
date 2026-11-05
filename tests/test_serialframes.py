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

    def test_save_reports_overwrite(self):
        # 新 id → overwritten=False；同名再存 → True（面板据此先问一句再覆盖）
        p = sf.normalize_profile({"id": "p", "frame": {"length": 4}})
        first = sf.save(self.cfg, "p1", 0, p)
        self.assertFalse(first["overwritten"])
        again = sf.save(self.cfg, "p1", 1, dict(p, label="改"))
        self.assertTrue(again["overwritten"])

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


class Compat(unittest.TestCase):
    """P2.2 的硬承诺：新字段全部可选，**旧 profile 的保存形状逐字不变**。"""

    def test_legacy_profile_shape_unchanged(self):
        raw = {
            "id": "legacy", "label": "旧配置",
            "frame": {"head_hex": "a55a", "tail_hex": "0d0a", "length": 11},
            "checksum": {"kind": "crc16modbus", "at": "tail"},
            "fields": [{"name": "rpm", "offset": 2, "type": "u16"}],
        }
        out = sf.normalize_profile(raw)
        self.assertEqual(out["frame"], {"head_hex": "a55a", "tail_hex": "0d0a",
                                        "length": 11, "max_bytes": 256})
        self.assertEqual(out["checksum"], {"kind": "crc16modbus", "at": "tail"})
        self.assertNotIn("escape", out)
        self.assertNotIn("allow_overlap", out)
        self.assertEqual(out["fields"],
                         [{"name": "rpm", "unit": "", "offset": 2, "type": "u16",
                           "endian": "le", "length": 2, "scale": 1.0,
                           "bias": 0.0, "enum": None, "plot": True}])

    def test_template_profiles_still_load(self):
        cfg = FakeCfg(Path("."))
        res = sf.list_templates(cfg)
        self.assertTrue(res["ok"], res["errors"])
        ids = {t["id"] for t in res["templates"]}
        self.assertIn("modbus_rtu", ids)
        self.assertIn("dlt645_read", ids)


class ChecksumDecl(unittest.TestCase):
    """校验声明化（P2.2-A）：预设 / 覆盖范围 / 位置。"""

    def _p(self, ck, length=6):
        return sf.normalize_profile({
            "id": "ck", "frame": {"head_hex": "a5", "length": length},
            "checksum": ck,
            "fields": [{"name": "v", "offset": 1, "type": "u16"}]})

    def test_preset_ccitt_roundtrip(self):
        p = self._p({"kind": "crc16", "preset": "crc16_ccitt_false",
                     "at": "tail", "endian": "be",
                     "cover": {"from": "after_head", "to": "before_checksum"}})
        enc = codec.encode(p, {"v": 0x1234})
        self.assertTrue(enc["ok"], enc.get("error"))
        body = bytes.fromhex(enc["hex"])
        want = codec.crc_compute(body[1:4], width=16, poly=0x1021, init=0xFFFF,
                                 xorout=0, refin=False, refout=False)
        self.assertEqual(int.from_bytes(body[4:6], "big"), want)
        dec = codec.decode(body, "profile:ck", profile=p)
        self.assertEqual(dec["total_frames"], 1)

    def test_crc8_maxim(self):
        p = self._p({"kind": "crc8", "preset": "crc8_maxim", "at": "tail"},
                    length=4)
        enc = codec.encode(p, {"v": 0x0102})
        self.assertTrue(enc["ok"], enc.get("error"))
        self.assertEqual(codec.decode(bytes.fromhex(enc["hex"]),
                                       "profile:ck", profile=p)["total_frames"], 1)

    def test_bad_preset_rejected_at_save(self):
        with self.assertRaises(ValueError):
            self._p({"kind": "crc16", "preset": "crc16_nope"})

    def test_cover_payload_excludes_head(self):
        p = self._p({"kind": "sum8", "at": "tail",
                     "cover": {"from": "after_head", "to": "before_checksum"}},
                    length=5)
        enc = codec.encode(p, {"v": 0x1122})
        body = bytes.fromhex(enc["hex"])
        self.assertEqual(body[-1], sum(body[1:-1]) & 0xFF)

    def test_offset_positions_checksum_mid_frame(self):
        p = sf.normalize_profile({
            "id": "mid", "frame": {"head_hex": "a5", "length": 6},
            "checksum": {"kind": "sum8", "offset": 1,
                         "cover": {"from": "frame", "to": "before_checksum"}},
            "fields": [{"name": "v", "offset": 2, "type": "u16"},
                       {"name": "t", "offset": 4, "type": "u8"}]})
        enc = codec.encode(p, {"v": 0x0102, "t": 0x09})
        self.assertTrue(enc["ok"], enc.get("error"))
        dec = codec.decode(bytes.fromhex(enc["hex"]), "profile:mid", profile=p)
        self.assertEqual(dec["total_frames"], 1)


class Escape(unittest.TestCase):
    """转义（P2.2-B）：帧体转义、定界符不转义、校验在转义前算。"""

    def _p(self):
        return sf.normalize_profile({
            "id": "esc", "frame": {"head_hex": "7e", "tail_hex": "7e"},
            "escape": {"escape_byte": "0x7D", "xor": "0x20",
                       "targets": ["0x7D", "0x7E"], "applies": "payload"},
            "fields": [{"name": "tag", "offset": 1, "type": "bytes", "length": 3},
                       {"name": "v", "offset": 4, "type": "u8"}]})

    def test_roundtrip(self):
        p = self._p()
        enc = codec.encode(p, {"tag": "7d7e01", "v": 0x42})
        self.assertTrue(enc["ok"], enc.get("error"))
        self.assertIn("7d5d", enc["hex"])       # 0x7D → 7D 5D
        self.assertIn("7d5e", enc["hex"])       # 0x7E → 7D 5E
        dec = codec.decode(bytes.fromhex(enc["hex"]), "profile:esc", profile=p)
        self.assertEqual(dec["records"][0]["fields"]["tag"], "7d7e01")
        self.assertEqual(dec["records"][0]["fields"]["v"], 0x42)

    def test_head_and_tail_not_escaped(self):
        p = self._p()
        enc = codec.encode(p, {"tag": "010203", "v": 0x7E})
        wire = bytes.fromhex(enc["hex"])
        self.assertEqual(wire[0], 0x7E)
        self.assertEqual(wire[-1], 0x7E)
        # 载荷里的 0x7E 必须变成 7D 5E（否则会被当成帧尾）
        self.assertEqual(wire.count(0x7E), 2)

    def test_escape_with_length_rejected(self):
        with self.assertRaises(ValueError):
            sf.normalize_profile({
                "id": "bad", "frame": {"length": 8},
                "escape": {"escape_byte": "0x7d"}})

    def test_checksum_computed_before_escape(self):
        p = sf.normalize_profile({
            "id": "esc-ck", "frame": {"head_hex": "7e", "tail_hex": "7e"},
            "escape": {"escape_byte": "0x7D", "xor": "0x20",
                       "targets": ["0x7D", "0x7E"]},
            "checksum": {"kind": "sum8", "at": "tail"},
            "fields": [{"name": "v", "offset": 1, "type": "u8"}]})
        enc = codec.encode(p, {"v": 0x7D})
        self.assertTrue(enc["ok"], enc.get("error"))
        dec = codec.decode(bytes.fromhex(enc["hex"]), "profile:esc-ck", profile=p)
        self.assertEqual(dec["total_frames"], 1)


class MultiHead(unittest.TestCase):
    def test_heads_longest_match(self):
        p = sf.normalize_profile({
            "id": "mh", "frame": {"heads": ["aa55", "aa56"], "length": 5},
            "fields": [{"name": "v", "offset": 4, "type": "u8"}]})
        data = bytes.fromhex("aa56010203" + "aa55020304" + "aa56030405")
        dec = codec.decode(data, "profile:mh", profile=p)
        self.assertEqual(dec["total_frames"], 3)
        self.assertEqual([r["fields"]["v"] for r in dec["records"]], [3, 4, 5])

    def test_heads_and_head_hex_are_exclusive(self):
        with self.assertRaises(ValueError):
            sf.normalize_profile({
                "id": "x", "frame": {"head_hex": "aa", "heads": ["bb"], "length": 2}})


class FieldModel(unittest.TestCase):
    """字段模型（P2.2-D）：数组 / 字符串 / f16 / 位标志 / 重叠。"""

    def test_array_expands_to_channels(self):
        p = sf.normalize_profile({
            "id": "arr", "frame": {"length": 10},
            "fields": [{"name": "ch", "type": "u16", "offset": 0,
                        "array": {"count": 4, "stride": 2}}]})
        data = struct.pack("<4H", 1, 2, 3, 4) + b"\x00\x00"
        dec = codec.decode(data, "profile:arr", profile=p)
        self.assertEqual(dec["records"][0]["fields"]["ch"], [1, 2, 3, 4])
        self.assertEqual(dec["channels"], 4)
        self.assertEqual(dec["records"][0]["values"], [1.0, 2.0, 3.0, 4.0])
        self.assertEqual([f["name"] for f in dec["fields"]],
                         ["ch[0]", "ch[1]", "ch[2]", "ch[3]"])
        enc = codec.encode(p, {"ch": [1, 2, 3, 4]})
        self.assertEqual(bytes.fromhex(enc["hex"]), data)

    def test_array_wrong_length_rejected(self):
        p = sf.normalize_profile({
            "id": "arr2", "frame": {"length": 4},
            "fields": [{"name": "ch", "type": "u16", "offset": 0,
                        "array": {"count": 2, "stride": 2}}]})
        enc = codec.encode(p, {"ch": [1]})
        self.assertFalse(enc["ok"])

    def test_string_gbk(self):
        p = sf.normalize_profile({
            "id": "str", "frame": {"length": 6},
            "fields": [{"name": "tag", "type": "str", "offset": 0,
                        "length": 6, "encoding": "gbk"}]})
        data = "电池电压".encode("gbk")[:6]
        data = data + b"\x00" * (6 - len(data))
        dec = codec.decode(data, "profile:str", profile=p)
        self.assertTrue(dec["records"][0]["fields"]["tag"].startswith("电池"))
        enc = codec.encode(p, {"tag": "电池"})
        self.assertEqual(bytes.fromhex(enc["hex"]), "电池".encode("gbk") + b"\x00" * 2)

    def test_half_float(self):
        p = sf.normalize_profile({
            "id": "f16", "frame": {"length": 2},
            "fields": [{"name": "f", "type": "f16", "offset": 0}]})
        dec = codec.decode(struct.pack("<e", 1.5), "profile:f16", profile=p)
        self.assertAlmostEqual(dec["records"][0]["fields"]["f"], 1.5, places=3)
        enc = codec.encode(p, {"f": 1.5})
        self.assertEqual(bytes.fromhex(enc["hex"]), struct.pack("<e", 1.5))

    def test_flag_bits(self):
        p = sf.normalize_profile({
            "id": "bits", "frame": {"length": 1},
            "fields": [{"name": "st", "type": "u8", "offset": 0,
                        "bits": {"0": "READY", "1": "FAULT"}}]})
        dec = codec.decode(b"\x03", "profile:bits", profile=p)
        rec = dec["records"][0]
        self.assertEqual(rec["fields"]["st"], 3)      # 原始值保留
        self.assertEqual(rec["flags"]["st"], ["READY", "FAULT"])
        dec1 = codec.decode(b"\x01", "profile:bits", profile=p)
        self.assertEqual(dec1["records"][0]["flags"]["st"], ["READY"])

    def test_overlap_rejected_unless_allowed(self):
        with self.assertRaises(ValueError) as ctx:
            sf.normalize_profile({
                "id": "ov", "frame": {"length": 4},
                "fields": [{"name": "a", "offset": 0, "type": "u16"},
                           {"name": "b", "offset": 1, "type": "u16"}]})
        self.assertIn("位区间重叠", str(ctx.exception))
        p = sf.normalize_profile({
            "id": "ov2", "frame": {"length": 4}, "allow_overlap": True,
            "fields": [{"name": "a", "offset": 0, "type": "u16"},
                       {"name": "b", "offset": 1, "type": "u16"}]})
        self.assertTrue(p["allow_overlap"])

    def test_bitfields_in_same_byte_do_not_overlap(self):
        p = sf.normalize_profile({
            "id": "ok", "frame": {"length": 1},
            "fields": [{"name": "lo", "offset": 0, "type": "u8",
                        "bit_offset": 0, "bit_length": 3},
                       {"name": "hi", "offset": 0, "type": "u8",
                        "bit_offset": 3, "bit_length": 5}]})
        self.assertEqual(len(p["fields"]), 2)


class ErrorReasons(unittest.TestCase):
    """错误分类（P2.2-C）：不再只有一个 skipped。"""

    def test_checksum_vs_no_head(self):
        p = sf.normalize_profile({
            "id": "er", "frame": {"head_hex": "a55a", "length": 6},
            "checksum": {"kind": "sum8", "at": "tail"},
            "fields": [{"name": "v", "offset": 2, "type": "u8"}]})
        good = bytearray(b"\xa5\x5a\x01\x02\x03\x00")
        good[-1] = sum(good[:-1]) & 0xFF
        bad = bytearray(good)
        bad[-1] ^= 0xFF
        dec = codec.decode(bytes(bad) + b"\x00\x00\x00", "profile:er", profile=p)
        self.assertEqual(dec["reasons"]["checksum"], 1)
        self.assertGreaterEqual(dec["reasons"]["no_head"], 0)
        self.assertEqual(dec["total_frames"], 0)
        self.assertEqual(sum(dec["reasons"].values()), dec["skipped"])

    def test_unknown_id_counted(self):
        p = sf.normalize_profile({
            "id": "uid", "frame": {"head_hex": "aa", "length": 3,
                                   "id_field": {"offset": 1, "type": "u8"}},
            "checksum": {"kind": "none"},
            "fields": [], "variants": [{"id": 1, "label": "A", "fields": []}]})
        dec = codec.decode(b"\xaa\x09\x00", "profile:uid", profile=p)
        self.assertEqual(dec["reasons"]["unknown_id"], 1)
        self.assertEqual(dec["unknown_id"], 1)


class IdleGap(unittest.TestCase):
    """空闲分包（P2.2-C）：没有帧头/长度时按"一次读 = 一帧"处理。"""

    def test_whole_buffer_is_one_frame(self):
        p = sf.normalize_profile({
            "id": "gap", "frame": {"idle_gap_ms": 20, "max_bytes": 16},
            "fields": [{"name": "v", "offset": 0, "type": "u16"}]})
        dec = codec.decode(b"\x01\x02", "profile:gap", profile=p)
        self.assertEqual(dec["total_frames"], 1)
        self.assertEqual(dec["records"][0]["fields"]["v"], 0x0201)

    def test_idle_gap_is_a_valid_framing_reason(self):
        p = sf.normalize_profile({"id": "g2", "frame": {"idle_gap_ms": 5}})
        self.assertEqual(p["frame"]["idle_gap_ms"], 5)

    def test_warning_when_idle_only(self):
        p = sf.normalize_profile({"id": "g3", "frame": {"idle_gap_ms": 5}})
        warns = sf._warnings(p)
        self.assertTrue(any("空闲分包" in w for w in warns))


if __name__ == "__main__":
    unittest.main()
