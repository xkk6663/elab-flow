"""组合工程 C1~C3 的单元验证（stdlib unittest，无需 pytest、无需硬件）。

跑：``python tests/test_boot_combo.py`` 或 ``python -m unittest discover -s tests``

## 这个文件守什么

双槽回滚方案的"乐鑫式体验"三件套：
1. **C1 boot_project 解析**（plan.resolve_boot_project）——chips yaml 声明的
   boot 工程名必须存在、不许自引用；静默放过 = build 级联在运行时才炸。
2. **C2 boot 烧录台账**（flash.boot_flash_decision / _stamp_*）——冻结判据
   是"产物指纹一致"，不是"版本号一致"（build 号每次递增，指纹才是产物事实）。
3. **C3 冻结路径过滤**（flash._samefile）——app flash.images 引用 boot bin
   （${ELAB_ROOT} 写法）与 boot 工程 artifacts.bin（${work_dir} 写法）必须被
   识别为同一文件，否则冻结时 boot 镜像剔不干净 = 冻结形同虚设。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.elab.config import ElabError
from services.elab.flash import (
    _stamp_load,
    _stamp_save,
    _samefile,
    boot_flash_decision,
)
from services.elab.plan import resolve_boot_project


class ResolveBootProjectTests(unittest.TestCase):
    def test_declared_ok(self):
        self.assertEqual(
            resolve_boot_project({"boot_project": "f411_boot"}, "f411",
                                 ["f411", "f411_boot"]),
            "f411_boot")

    def test_not_declared_empty(self):
        self.assertEqual(resolve_boot_project({}, "f411", ["f411"]), "")
        self.assertEqual(resolve_boot_project(None, "f411", ["f411"]), "")

    def test_self_reference_is_the_boot_itself(self):
        # ★ boot 工程与 app 共用 chips yaml：boot_project 指向自己 = "我就是
        #   boot" → 返回空（自身不再级联、不参与冻结台账），不是错误。
        self.assertEqual(
            resolve_boot_project({"boot_project": "f411_boot"}, "f411_boot",
                                 ["f411", "f411_boot"]),
            "")

    def test_unknown_project_fails(self):
        with self.assertRaises(ElabError):
            resolve_boot_project({"boot_project": "nope"}, "f411", ["f411"])

    def test_whitespace_only_treated_as_empty(self):
        self.assertEqual(
            resolve_boot_project({"boot_project": "  "}, "f411", ["f411"]), "")


def _fake_boot_plan(bin_path: Path, version=(1, 0, 0)):
    return SimpleNamespace(name="f411_boot", bin=str(bin_path), version=version)


class BootFlashDecisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin_path = Path(self.tmp.name) / "f411_boot.bin"
        self.bin_path.write_bytes(b"\x00\x01ELAB-BOOT-FW")

    def test_no_stamp_flashes(self):
        d = boot_flash_decision(_fake_boot_plan(self.bin_path))
        self.assertEqual(d["action"], "flash")
        self.assertIn("无烧录台账", d["reason"])

    def test_missing_bin_fails_fast(self):
        with self.assertRaises(ElabError):
            boot_flash_decision(_fake_boot_plan(Path(self.tmp.name) / "nope.bin"))

    def test_missing_bin_declaration_fails_fast(self):
        plan = SimpleNamespace(name="f411_boot", bin="", version=None)
        with self.assertRaises(ElabError):
            boot_flash_decision(plan)

    def test_same_md5_frozen(self):
        from services.elab.flash import boot_flash_decision as dec
        first = dec(_fake_boot_plan(self.bin_path))
        stamp = {"md5": first["md5"], "version": "1.0.0",
                 "flashed_at": "2026-10-08 12:00:00"}
        d = dec(_fake_boot_plan(self.bin_path), stamp=stamp)
        self.assertEqual(d["action"], "skip")
        self.assertIn("冻结", d["reason"])
        self.assertIn("1.0.0", d["reason"])

    def test_changed_bin_reflashes(self):
        from services.elab.flash import boot_flash_decision as dec
        first = dec(_fake_boot_plan(self.bin_path))
        stamp = {"md5": first["md5"]}
        self.bin_path.write_bytes(b"\x00\x02ELAB-BOOT-FW-v2")
        d = dec(_fake_boot_plan(self.bin_path), stamp=stamp)
        self.assertEqual(d["action"], "flash")
        self.assertIn("指纹不一致", d["reason"])

    def test_force_overrides_frozen(self):
        from services.elab.flash import boot_flash_decision as dec
        first = dec(_fake_boot_plan(self.bin_path))
        stamp = {"md5": first["md5"]}
        d = dec(_fake_boot_plan(self.bin_path), stamp=stamp, force=True)
        self.assertEqual(d["action"], "flash")
        self.assertIn("强制", d["reason"])

    def test_unversioned_plan_shows_question_mark(self):
        d = boot_flash_decision(_fake_boot_plan(self.bin_path, version=None))
        self.assertEqual(d["version"], "?")


class StampAndSamefileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_stamp_roundtrip(self):
        from services.elab.flash import _boot_stamp_path
        plan = SimpleNamespace(cfg=SimpleNamespace(root=self.tmp.name),
                               boot_project="f411_boot")
        path = _boot_stamp_path(plan)
        self.assertIsNone(_stamp_load(path))
        _stamp_save(path, {"md5": "abc", "version": "1.0.0"})
        self.assertEqual(_stamp_load(path)["md5"], "abc")

    def test_stamp_corrupt_returns_none(self):
        p = Path(self.tmp.name) / "bad.json"
        p.write_text("{not json", encoding="utf-8")
        self.assertIsNone(_stamp_load(p))

    def test_samefile_same_file_two_spellings(self):
        a = Path(self.tmp.name) / "sub" / "boot.bin"
        a.parent.mkdir()
        a.write_bytes(b"x")
        b = Path(self.tmp.name) / "sub" / "." / "boot.bin"
        self.assertTrue(_samefile(str(a), str(b)))

    def test_samefile_different_files(self):
        a = Path(self.tmp.name) / "a.bin"
        b = Path(self.tmp.name) / "b.bin"
        a.write_bytes(b"x")
        b.write_bytes(b"y")
        self.assertFalse(_samefile(str(a), str(b)))


if __name__ == "__main__":
    unittest.main()
