"""serialcodec（串口协议无状态解码）的离线单测。

        python -m unittest tests.test_serialcodec
"""

from __future__ import annotations

import base64
import struct
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab import serialcodec as sc            # noqa: E402


def justfloat(values: list[float]) -> bytes:
    return struct.pack("<%df" % len(values), *values) + sc.JUSTFLOAT_TAIL


class JustFloat(unittest.TestCase):
    def test_frames_and_channels_are_deduced(self):
        data = justfloat([1.0, 2.0, 3.0]) + justfloat([4.0, 5.0, 6.0])
        r = sc.decode(data, "justfloat")
        self.assertTrue(r["ok"])
        self.assertEqual(r["channels"], 3)
        self.assertEqual(r["total_frames"], 2)
        self.assertEqual(r["frames"][1], [4.0, 5.0, 6.0])
        self.assertEqual(r["pending_bytes"], 0)

    def test_partial_tail_is_returned_as_pending(self):
        head = justfloat([1.0, 2.0])
        pending = struct.pack("<2f", 7.0, 8.0)       # 缺尾标记 → 半帧
        r = sc.decode(head + pending, "justfloat")
        self.assertEqual(r["total_frames"], 1)
        self.assertEqual(r["pending_bytes"], len(pending))
        self.assertEqual(base64.b64decode(r["pending_b64"]), pending)

    def test_explicit_channels_rejects_mismatched_frames(self):
        data = justfloat([1.0, 2.0]) + justfloat([3.0, 4.0, 5.0])
        r = sc.decode(data, "justfloat", channels=2)
        self.assertEqual(r["channels"], 2)
        self.assertEqual(r["total_frames"], 1)
        self.assertEqual(r["skipped"], 1)


class FireWater(unittest.TestCase):
    def test_csv_lines(self):
        r = sc.decode(b"1,2,3\n4,5,6\n", "firewater")
        self.assertTrue(r["ok"])
        self.assertEqual(r["channels"], 3)
        self.assertEqual(r["frames"], [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])

    def test_unterminated_last_line_is_pending(self):
        r = sc.decode(b"1,2\n3,4", "firewater")
        self.assertEqual(r["total_frames"], 1)
        self.assertEqual(r["pending_bytes"], len(b"3,4"))

    def test_bad_line_is_skipped(self):
        r = sc.decode(b"1,2\nabc\n3,4\n", "firewater")
        self.assertEqual(r["total_frames"], 2)
        self.assertEqual(r["skipped"], 1)


class Guards(unittest.TestCase):
    def test_unknown_decoder(self):
        r = sc.decode(b"x", "nope")
        self.assertFalse(r["ok"])
        self.assertIn("未知解码器", r["error"])

    def test_empty_input(self):
        r = sc.decode(b"")
        self.assertTrue(r["ok"])
        self.assertEqual(r["total_frames"], 0)
        self.assertEqual(r["channels"], 0)


if __name__ == "__main__":
    unittest.main()
