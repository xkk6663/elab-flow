"""适配包（elab-pack）机制的离线单测。

        python -m unittest tests.test_pack

覆盖：安装隔离 / 内容哈希 / requires 兼容性 / 安全审计 / 骨架零芯片 / 市场索引。
全部在临时目录里造包，不碰仓库的 packs/ 与 market/。
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab import pkg                                    # noqa: E402
from elab.config import Config                          # noqa: E402

PACK_YAML = """\
schema_version: 1
name: acme/demo
vendor: acme
platform: demo
version: 0.1.0
license: MIT
status: community
description: 测试用适配包
requires:
  kernel_api: ">=1 <2"
  schema_version: 1
"""

CHIP_YAML = """\
id: demo1
vendor: acme
platform: demo
part: DEMO1
core:
  cpu: cortex-m4
memory:
  flash: { origin: 0x08000000, length: 0x10000 }
  ram:   { origin: 0x20000000, length: 0x4000 }
"""


class PackTestBase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(prefix="elab-test-pack-")
        self.root = Path(self._td.name)
        (self.root / "elab.host.yaml").write_text(
            "version: 1\npacks:\n  roots:\n"
            "    - ${ELAB_ROOT}/packs/installed\n", encoding="utf-8")
        self.cfg = Config(self.root)

    def tearDown(self):
        self._td.cleanup()

    def make_pack(self, *, name="acme/demo", extra_files=None, manifest=None) -> Path:
        """在临时目录里造一个合法包，返回包目录。"""
        d = self.root / "src" / name.replace("/", "_")
        (d / "chips").mkdir(parents=True)
        (d / "pack.yaml").write_text(manifest if manifest is not None else PACK_YAML,
                                     encoding="utf-8")
        (d / "chips" / "demo1.yaml").write_text(CHIP_YAML, encoding="utf-8")
        for rel, content in (extra_files or {}).items():
            p = d / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
        return d


class TestSkeleton(PackTestBase):
    def test_no_packs_means_no_chips(self):
        """★ 骨架无芯片：没装包时 chips 为空、packs 为空。"""
        self.assertEqual(self.cfg.packs, {})
        self.assertEqual(self.cfg.chips, {})
        self.assertEqual(self.cfg.vendor_fingerprints, [])

    def test_install_then_discover(self):
        src = self.make_pack()
        rec = pkg.install(self.cfg, local=src, log=lambda *a, **k: None)
        self.assertEqual(rec["name"], "acme/demo")
        self.assertEqual(rec["chips"], ["acme/demo1"])
        dest = self.root / "packs" / "installed" / "acme" / "demo"
        self.assertTrue((dest / ".installed.json").exists())
        self.assertEqual(json.loads((dest / ".installed.json").read_text("utf-8"))["version"],
                         "0.1.0")

        installed = Config(self.root)
        self.assertIn("acme/demo", installed.packs)
        self.assertIn("acme/demo1", installed.chips)
        self.assertEqual(installed.chips["acme/demo1"]["_pack"], "acme/demo")

    def test_install_is_isolated_not_in_skeleton(self):
        src = self.make_pack()
        pkg.install(self.cfg, local=src, log=lambda *a, **k: None)
        self.assertFalse((self.root / "chips").exists())
        self.assertFalse((self.root / "pack.yaml").exists())

    def test_duplicate_install_requires_force(self):
        src = self.make_pack()
        pkg.install(self.cfg, local=src, log=lambda *a, **k: None)
        with self.assertRaises(pkg.PackError):
            pkg.install(self.cfg, local=src, log=lambda *a, **k: None)
        pkg.install(self.cfg, local=src, force=True, log=lambda *a, **k: None)

    def test_remove(self):
        src = self.make_pack()
        pkg.install(self.cfg, local=src, log=lambda *a, **k: None)
        pkg.remove(self.cfg, "acme/demo", log=lambda *a, **k: None)
        self.assertFalse((self.root / "packs" / "installed" / "acme" / "demo").exists())


class TestValidation(PackTestBase):
    def test_reject_executable_files(self):
        src = self.make_pack(extra_files={"tool.py": "print(1)"})
        with self.assertRaises(pkg.PackError) as cm:
            pkg.install(self.cfg, local=src, log=lambda *a, **k: None)
        self.assertIn("tool.py", str(cm.exception))

    def test_c_source_allowed(self):
        src = self.make_pack(extra_files={"ports/demo/port.c": "int f(void){return 0;}\n"})
        probs = pkg.validate_manifest(pkg.read_manifest(src), src)
        self.assertEqual(probs, [])

    def test_requires_kernel_api_mismatch(self):
        bad = PACK_YAML.replace('kernel_api: ">=1 <2"', 'kernel_api: ">=2"')
        src = self.make_pack(manifest=bad)
        probs = pkg.validate_manifest(pkg.read_manifest(src), src)
        self.assertTrue(any("kernel_api" in p for p in probs), probs)

    def test_requires_schema_mismatch(self):
        bad = PACK_YAML.replace("schema_version: 1\n", "schema_version: 2\n", 1)
        src = self.make_pack(manifest=bad)
        probs = pkg.validate_manifest(pkg.read_manifest(src), src)
        self.assertTrue(any("schema_version" in p for p in probs), probs)

    def test_name_vendor_mismatch(self):
        bad = PACK_YAML.replace("vendor: acme", "vendor: other")
        src = self.make_pack(manifest=bad)
        probs = pkg.validate_manifest(pkg.read_manifest(src), src)
        self.assertTrue(any("vendor" in p for p in probs), probs)

    def test_satisfies(self):
        self.assertTrue(pkg.satisfies(1, ">=1"))
        self.assertTrue(pkg.satisfies(1, ">=1 <2"))
        self.assertTrue(pkg.satisfies(1, "^1"))
        self.assertFalse(pkg.satisfies(1, ">=2"))
        self.assertFalse(pkg.satisfies(2, "<2"))


class TestHashAndVerify(PackTestBase):
    def test_hash_drift_detected(self):
        src = self.make_pack()
        pkg.install(self.cfg, local=src, log=lambda *a, **k: None)
        chip = self.root / "packs" / "installed" / "acme" / "demo" / "chips" / "demo1.yaml"
        chip.write_text(CHIP_YAML.replace("DEMO1", "DEMO2"), encoding="utf-8")
        res = pkg.verify(self.cfg, "acme/demo")[0]
        self.assertFalse(res["ok"])
        self.assertTrue(any("哈希漂移" in p for p in res["problems"]), res["problems"])

    def test_hash_stable_across_copy(self):
        src = self.make_pack()
        copy = self.root / "copy"
        shutil.copytree(src, copy)
        self.assertEqual(pkg.tree_hash(src), pkg.tree_hash(copy))


class TestMarket(PackTestBase):
    def test_index_roundtrip_and_install_from_market(self):
        src = self.make_pack()
        index = self.root / "market" / "index.json"
        index.parent.mkdir(parents=True)
        data = pkg.build_index(self.root / "src", self.root)
        index.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(pkg.index_problems(self.root / "src", self.root, index), [])

        entry = pkg.market_entry(self.cfg, "acme/demo")
        self.assertIsNotNone(entry)
        kwargs = pkg.entry_source(entry, entry["_base"])
        rec = pkg.install(self.cfg, sha256=entry["sha256"], log=lambda *a, **k: None,
                          **kwargs)
        self.assertEqual(rec["name"], "acme/demo")

    def test_index_drift_detected(self):
        src = self.make_pack()
        index = self.root / "market" / "index.json"
        index.parent.mkdir(parents=True)
        data = pkg.build_index(self.root / "src", self.root)
        data["packs"][0]["version"] = "9.9.9"
        index.write_text(json.dumps(data), encoding="utf-8")
        self.assertTrue(pkg.index_problems(self.root / "src", self.root, index))

    def test_index_keeps_external_git_entry(self):
        """内置包重新生成索引时，外置 git 条目必须保留。"""
        src = self.make_pack()
        external = {
            "name": "ext/demo", "vendor": "ext", "platform": "demo",
            "version": "0.1.0", "license": "MIT",
            "source": {"type": "git", "url": "https://github.com/x/ext.git", "ref": "main"},
            "sha256": "0" * 64,
        }
        data = pkg.build_index(self.root / "src", self.root, keep=[external])
        names = [e["name"] for e in data["packs"]]
        self.assertEqual(names, ["acme/demo", "ext/demo"])

        index = self.root / "market" / "index.json"
        index.parent.mkdir(parents=True)
        index.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(pkg.index_problems(self.root / "src", self.root, index), [])

    def test_index_drops_deleted_local_entry(self):
        src = self.make_pack()
        stale = {"name": "gone/demo", "source": {"type": "local", "path": "gone"}}
        data = pkg.build_index(self.root / "src", self.root, keep=[stale])
        self.assertEqual([e["name"] for e in data["packs"]], ["acme/demo"])


if __name__ == "__main__":
    unittest.main()
