"""工程级调试配置持久化（elab.debugstore）单测。

    python -m unittest tests.test_debugstore

覆盖：空文件降级、rev 递增、乐观锁冲突（debug-rev-conflict）、整形过滤。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab import debugstore                                    # noqa: E402
from elab.debugsession import DebugError                       # noqa: E402


class _Cfg:
    def __init__(self, root):
        self.root = root


class DebugStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = _Cfg(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_empty_and_shape(self):
        data = debugstore.load(self.cfg, "demo")
        self.assertEqual(data, {"rev": 0, "breakpoints": [], "watches": []})

    def test_save_increments_rev_and_filters(self):
        saved = debugstore.save(self.cfg, "demo", {
            "breakpoints": [
                {"id": "bp-1", "kind": "func", "location": "main",
                 "condition": "", "enabled": True, "hardware": False},
                {"id": "bp-2", "kind": "func", "location": ""},
            ],
            "watches": [{"id": "w-1", "expr": "i", "format": "hex"}],
        })
        self.assertEqual(saved["rev"], 1)
        got = debugstore.load(self.cfg, "demo")
        self.assertEqual(got["rev"], 1)
        self.assertEqual([b["location"] for b in got["breakpoints"]], ["main"])
        self.assertEqual(got["watches"][0]["expr"], "i")

    def test_optimistic_lock(self):
        debugstore.save(self.cfg, "demo", {"breakpoints": [], "watches": []},
                        base_rev=0)
        with self.assertRaises(DebugError) as cm:
            debugstore.save(self.cfg, "demo", {"breakpoints": [], "watches": []},
                            base_rev=0)
        self.assertEqual(cm.exception.code, "debug-rev-conflict")

    def test_bad_file_degrades(self):
        p = debugstore.path_for(self.cfg, "demo")
        p.parent.mkdir(parents=True)
        p.write_text("{not json", encoding="utf-8")
        self.assertEqual(debugstore.load(self.cfg, "demo")["rev"], 0)


if __name__ == "__main__":
    unittest.main()
