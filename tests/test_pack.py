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

    def test_hash_order_is_platform_independent(self):
        """★ Windows 的 Path 比较不区分大小写，排序必须按 as_posix() 区分大小写。

        期望值在 Linux/Windows 都必须一致（同一条目不能按平台算出两个 sha256）。
        """
        pack = self.root / "case-pack"
        (pack / "chips").mkdir(parents=True)
        (pack / "pack.yaml").write_text("a\n", encoding="utf-8")
        (pack / "LICENSE").write_text("b\n", encoding="utf-8")
        (pack / "README.md").write_text("c\n", encoding="utf-8")
        (pack / "chips" / "x.yaml").write_text("d\n", encoding="utf-8")
        # 顺序 = LICENSE → README.md → chips/x.yaml → pack.yaml
        self.assertEqual(
            pkg.tree_hash(pack),
            "9887b34cc63afee928892da51214ac8fec59c457e86696c61971942ce4d3a085")


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


class TestActivePack(PackTestBase):
    """一次只启用一套：active.json 的写入 / 回退 / 卸载顺延。"""

    def _install(self, name: str) -> Path:
        manifest = PACK_YAML.replace("name: acme/demo", f"name: {name}") \
                             .replace("platform: demo", f"platform: {name.split('/')[1]}")
        src = self.make_pack(name=name, manifest=manifest)
        pkg.install(self.cfg, local=src, log=lambda *a, **k: None)
        return src

    def test_first_install_auto_activates(self):
        self._install("acme/demo")
        self.assertEqual(pkg.read_active(self.cfg), "acme/demo")
        self.assertEqual(pkg.active_pack(self.cfg)["name"], "acme/demo")

    def test_second_install_keeps_first_active(self):
        self._install("acme/demo")
        self._install("acme/demo2")
        self.assertEqual(pkg.read_active(self.cfg), "acme/demo")
        # 芯片只来自启用的那一套（另一套已装但不生效）
        self.assertIn("acme/demo1", self.cfg.chips)
        self.assertEqual(self.cfg.chips["acme/demo1"]["_pack"], "acme/demo")

    def test_set_active_switches_chips(self):
        self._install("acme/demo")
        self._install("acme/demo2")
        pkg.set_active(self.cfg, "acme/demo2", log=lambda *a, **k: None)
        cfg2 = Config(self.root)
        self.assertEqual(pkg.read_active(cfg2), "acme/demo2")
        self.assertIn("acme/demo1", cfg2.chips)
        self.assertEqual(cfg2.chips["acme/demo1"]["_pack"], "acme/demo2")
        self.assertEqual(pkg.status(cfg2, include_market=False)["active"], "acme/demo2")

    def test_reject_activating_uninstalled_official_source(self):
        # 官方源目录不是安装副本 → 不能启用
        official = self.root / "packs" / "official" / "acme" / "demo"
        official.mkdir(parents=True)
        self.make_pack()  # 只在 src 里造，不安装
        (official / "pack.yaml").write_text(PACK_YAML, encoding="utf-8")
        (official / "chips").mkdir(parents=True)
        (official / "chips" / "demo1.yaml").write_text(CHIP_YAML, encoding="utf-8")
        with self.assertRaises(pkg.PackError):
            pkg.set_active(self.cfg, "acme/demo", log=lambda *a, **k: None)

    def test_remove_active_falls_back_to_next(self):
        self._install("acme/demo")
        self._install("acme/demo2")
        pkg.remove(self.cfg, "acme/demo", log=lambda *a, **k: None)
        self.assertEqual(pkg.read_active(self.cfg), "acme/demo2")

    def test_remove_last_active_clears(self):
        self._install("acme/demo")
        pkg.remove(self.cfg, "acme/demo", log=lambda *a, **k: None)
        self.assertEqual(pkg.read_active(self.cfg), "")
        self.assertEqual(Config(self.root).chips, {})

    def test_status_marks_active_and_official_source(self):
        self._install("acme/demo")
        official = self.root / "packs" / "official" / "acme" / "src-demo"
        official.mkdir(parents=True)
        (official / "pack.yaml").write_text(
            PACK_YAML.replace("name: acme/demo", "name: acme/src-demo")
                     .replace("platform: demo", "platform: src-demo"), encoding="utf-8")
        (official / "chips").mkdir()
        (official / "chips" / "demo1.yaml").write_text(CHIP_YAML, encoding="utf-8")
        st = pkg.status(self.cfg, include_market=False)
        by = {r["name"]: r for r in st["installed"]}
        self.assertTrue(by["acme/demo"]["active"])
        self.assertTrue(by["acme/demo"]["installed"])
        self.assertFalse(by["acme/src-demo"]["active"])
        self.assertFalse(by["acme/src-demo"]["installed"])
        self.assertEqual(st["active"], "acme/demo")
        self.assertEqual(st["chips"], ["acme/demo1"])

    def _write_market(self, entries: list[dict]) -> None:
        path = self.root / "market" / "index.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"schema_version": 1, "packs": entries},
                                   ensure_ascii=False), encoding="utf-8")

    def test_status_exposes_market_latest_and_updatable(self):
        self._install("acme/demo")
        self._write_market([{"name": "acme/demo", "version": "0.2.0"}])
        st = pkg.status(self.cfg)
        rec = next(r for r in st["installed"] if r["name"] == "acme/demo")
        self.assertEqual(rec["latest"], "0.2.0")
        self.assertTrue(rec["updatable"])

        for ver in ("0.1.0", "0.0.9"):
            self._write_market([{"name": "acme/demo", "version": ver}])
            st = pkg.status(self.cfg)
            rec = next(r for r in st["installed"] if r["name"] == "acme/demo")
            self.assertEqual(rec["latest"], ver)
            self.assertFalse(rec["updatable"], ver)

    def test_update_does_not_downgrade_without_force(self):
        self._install("acme/demo")
        self._write_market([{"name": "acme/demo", "version": "0.0.9"}])
        logs: list[str] = []
        self.assertEqual(pkg.update(self.cfg, "acme/demo", log=logs.append), [])
        self.assertIn("高于市场", "\n".join(logs))


class TestBootAndLiveMarket(PackTestBase):
    """开箱即用（自动装内置包）与"现场遍历市场"的本机缓存优先级。"""

    def _official_pack(self) -> Path:
        official = self.root / "packs" / "official" / "acme" / "demo"
        official.mkdir(parents=True)
        (official / "pack.yaml").write_text(PACK_YAML, encoding="utf-8")
        (official / "chips").mkdir()
        (official / "chips" / "demo1.yaml").write_text(CHIP_YAML, encoding="utf-8")
        return official

    def test_ensure_bootstrap_installs_builtin_when_empty(self):
        self._official_pack()
        recs = pkg.ensure_bootstrap(self.cfg, log=lambda *a, **k: None)
        self.assertEqual([r["name"] for r in recs], ["acme/demo"])
        self.assertTrue((self.root / "packs" / "installed" / "acme" / "demo"
                         / ".installed.json").exists())
        self.assertEqual(pkg.read_active(self.cfg), "acme/demo")

    def test_ensure_bootstrap_is_noop_when_any_pack_installed(self):
        """已有任何已装包 → 不自动补装（用户卸载内置包后不会被悄悄装回来）。"""
        src = self.make_pack()
        pkg.install(self.cfg, local=src, log=lambda *a, **k: None)
        self._official_pack()
        self.assertEqual(pkg.ensure_bootstrap(self.cfg, log=lambda *a, **k: None), [])

    def test_live_market_cache_takes_priority(self):
        live = pkg.market_live_path(self.cfg)
        live.parent.mkdir(parents=True)
        live.write_text(json.dumps({"schema_version": 1, "packs": []}), encoding="utf-8")
        self.assertEqual(pkg.market_spec(self.cfg), pkg.to_fwd(live))


if __name__ == "__main__":
    unittest.main()
