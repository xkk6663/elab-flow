"""test_provider —— Provider 工具链架构（P1/P2）回归。

运行：``python -m unittest tests.test_provider``

覆盖（技术方案_Provider工具链架构 §15 P1/P2）：
1. manifest 校验 fail-fast（未知键 / monitor / timeout≤0 / 版本约束）
2. 解析优先级：项目内联 tool: > provider steps > 原生链；缺步骤 → unavailable 不回退
3. provider 缺失 / 版本不匹配 → 明确报错（含安装提示）
4. 预览与实跑同源：provider 生成 argv 与旧内联 tools 完全一致
5. monitor 永远原生；doctor_deep 不可外包
6. 安装 / 卸载 / 内容哈希
7. 驾驶舱项目卡片投影（provider + 每步 kind/source）
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "services"))

from cockpit import server as srv                         # noqa: E402
from elab import provider as prov                         # noqa: E402
from elab import run as run_mod                           # noqa: E402
from elab.config import Config, ElabError                 # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "providers" / "demo" / "toolchain"

HOST_YAML = """\
version: 1
host:
  os: windows
  exec_ext: .exe
tools:
  idf:
    python: C:/fake/idf/venv/Scripts/python.exe
    idf_path: C:/fake/esp-idf
    tools_path: C:/fake
    version: "6.1"
probes:
  list: {}
  default: ""
packs:
  roots:
    - ${ELAB_ROOT}/packs/installed
providers:
  roots:
    - ${ELAB_ROOT}/providers/installed
"""


def _proj(name: str, *, provider: str = "demo/toolchain@>=1 <2",
          steps: str = "", tools: str = "") -> str:
    return f"""\
name: {name}
root: ${{ELAB_ROOT}}/examples/{name}
chip: demo1
build:
  work_dir: ${{root}}/build
artifacts:
  elf: ${{root}}/build/{name}.elf
debug:
  probe: ""
serial:
  port: COM1
  baud: 115200
monitor:
  idle_timeout_s: 5
{f"provider: {provider}" + chr(10) if provider else ""}{steps}{tools}"""


class ProviderTestBase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(prefix="elab-test-provider-")
        self.root = Path(self._td.name)
        (self.root / "elab.host.yaml").write_text(HOST_YAML, encoding="utf-8")
        (self.root / "projects").mkdir(parents=True)
        (self.root / "examples" / "p1" / "build").mkdir(parents=True)
        (self.root / "examples" / "p2" / "build").mkdir(parents=True)
        self._old_py = os.environ.get("PY")
        os.environ["PY"] = sys.executable
        self.install_fixture()
        (self.root / "projects" / "p1.yaml").write_text(
            _proj("p1"), encoding="utf-8")

    def tearDown(self):
        if self._old_py is None:
            os.environ.pop("PY", None)
        else:
            os.environ["PY"] = self._old_py
        self._td.cleanup()

    def install_fixture(self, name: str = "demo/toolchain") -> Path:
        dest = self.root / "providers" / "installed" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(FIXTURE, dest)
        return dest

    def cfg(self) -> Config:
        return Config(self.root)


class TestManifest(ProviderTestBase):
    def test_fixture_is_valid(self):
        man = prov.read_manifest(FIXTURE)
        self.assertEqual(prov.validate_manifest(man), [])

    def test_unknown_top_key_fails(self):
        man = prov.read_manifest(FIXTURE)
        man["bogus"] = 1
        self.assertTrue(any("未知顶层字段" in p for p in prov.validate_manifest(man)))

    def test_monitor_and_doctor_deep_are_kernel_only(self):
        man = prov.read_manifest(FIXTURE)
        man["steps"]["monitor"] = {"cmd": ["echo", "x"]}
        man["steps"]["doctor_deep"] = {"cmd": ["echo", "x"]}
        problems = prov.validate_manifest(man)
        self.assertTrue(any("steps.monitor" in p for p in problems), problems)
        self.assertTrue(any("steps.doctor_deep" in p for p in problems), problems)

    def test_timeout_must_be_positive(self):
        man = prov.read_manifest(FIXTURE)
        man["steps"]["build"]["timeout_s"] = 0
        self.assertTrue(any("timeout_s" in p for p in prov.validate_manifest(man)))

    def test_kernel_api_mismatch(self):
        man = prov.read_manifest(FIXTURE)
        man["requires"]["kernel_api"] = ">=99 <100"
        self.assertTrue(any("kernel_api" in p for p in prov.validate_manifest(man)))


class TestResolve(ProviderTestBase):
    def test_priority_inline_over_provider_over_native(self):
        (self.root / "projects" / "p2.yaml").write_text(
            _proj("p2", provider="demo/toolchain@>=1 <2",
                  steps="steps:\n  build: tool:mine\n",
                  tools="tools:\n  mine:\n    cwd: ${root}\n"
                        "    cmd: [\"${env:PY}\", \"-c\", \"print('mine')\"]\n"),
            encoding="utf-8")
        tc = prov.resolve(self.cfg(), "p2")
        self.assertEqual(tc.steps["build"].kind, "external")
        self.assertEqual(tc.steps["build"].provider, "project")
        self.assertEqual(tc.steps["flash"].provider, "demo/toolchain")
        self.assertEqual(tc.steps["monitor"].kind, "native")
        # doctor_deep：provider 不提供 → unavailable（不回退原生）
        self.assertEqual(tc.steps["doctor_deep"].kind, "unavailable")

    def test_no_provider_uses_native_chain(self):
        (self.root / "projects" / "p3.yaml").write_text(
            _proj("p3", provider=""), encoding="utf-8")
        tc = prov.resolve(self.cfg(), "p3")
        self.assertEqual(tc.provider.source, "builtin")
        self.assertEqual(tc.steps["build"].kind, "native")

    def test_missing_step_fails_preview(self):
        dest = self.root / "providers" / "installed" / "demo" / "toolchain" / "provider.yaml"
        text = dest.read_text(encoding="utf-8")
        text = text.replace(
            '  flash:\n    cmd: ["${env:PY}", "-c", "print(\'provider flash ok\')"]\n',
            "")
        dest.write_text(text, encoding="utf-8")
        tc = prov.resolve(self.cfg(), "p1")
        self.assertEqual(tc.steps["flash"].kind, "unavailable")
        with self.assertRaises(ElabError) as cm:
            run_mod.preview(self.cfg(), "p1", steps=["flash"])
        self.assertIn("flash", str(cm.exception))

    def test_missing_provider_clear_error(self):
        (self.root / "projects" / "p4.yaml").write_text(
            _proj("p4", provider="ghost/ghost@>=1"), encoding="utf-8")
        with self.assertRaises(ElabError) as cm:
            prov.resolve(self.cfg(), "p4")
        self.assertIn("ghost/ghost", str(cm.exception))
        self.assertIn("provider install", str(cm.exception))

    def test_version_range_mismatch(self):
        (self.root / "projects" / "p5.yaml").write_text(
            _proj("p5", provider="demo/toolchain@>=2 <3"), encoding="utf-8")
        with self.assertRaises(ElabError) as cm:
            prov.resolve(self.cfg(), "p5")
        self.assertIn("1.2.0", str(cm.exception))

    def test_artifacts_project_overrides_provider(self):
        tc = prov.resolve(self.cfg(), "p1")
        self.assertTrue(tc.artifacts["elf"].endswith("p1.elf"))
        self.assertTrue(tc.artifacts["map"].endswith("p1.map"))


class TestPreviewEquivalence(ProviderTestBase):
    def test_provider_argv_equals_legacy_inline_tools(self):
        """同一命令模板，provider 与项目内联必须 materialize 出逐字一致的 argv。"""
        cmd = ["${env:PY}", "-c", "print('provider build ok')"]
        (self.root / "projects" / "inline.yaml").write_text(
            _proj("inline", provider="",
                  steps="steps:\n  build: tool:build\n",
                  tools="tools:\n  build:\n    cwd: ${root}\n"
                        f"    cmd: {json.dumps(cmd)}\n")
            .replace("examples/inline", "examples/p1"),
            encoding="utf-8")
        a = run_mod.preview(self.cfg(), "p1", steps=["build"])["plan"][0]
        b = run_mod.preview(self.cfg(), "inline", steps=["build"])["plan"][0]
        self.assertEqual(a["commands"][0], b["commands"][0])
        self.assertEqual(a["work_dir"], b["work_dir"])
        self.assertEqual(a["provider"], "demo/toolchain")
        self.assertIn("provider demo/toolchain@1.2.0", a["note"])

    def test_run_external_step_and_events(self):
        res = run_mod.run(self.cfg(), "p1", steps=["build"], echo=False)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["steps"][0]["provider"], "demo/toolchain")
        self.assertEqual(res["steps"][0]["provider_version"], "1.2.0")


class TestInstall(ProviderTestBase):
    def test_install_and_remove_roundtrip(self):
        cfg = self.cfg()
        # setUp 已装好一份用于其它用例；这里先清掉再测安装/卸载
        prov.remove(cfg, "demo/toolchain", log=lambda *a, **k: None)
        src = self.root / "src-provider"
        shutil.copytree(FIXTURE, src)
        res = prov.install(cfg, "demo/toolchain", local=str(src),
                           log=lambda *a, **k: None)
        self.assertEqual(res["version"], "1.2.0")
        self.assertTrue((Path(res["dir"]) / prov.PROVIDER_FILE).exists())
        self.assertTrue((Path(res["dir"]) / prov.INSTALL_META).exists())
        self.assertIn("demo/toolchain", prov.ProviderRegistry(cfg).installed_names())
        prov.remove(cfg, "demo/toolchain", log=lambda *a, **k: None)
        self.assertNotIn("demo/toolchain", prov.ProviderRegistry(cfg).installed_names())

    def test_install_hash_mismatch_rejected(self):
        cfg = self.cfg()
        src = self.root / "src-provider"
        shutil.copytree(FIXTURE, src)
        with self.assertRaises(ElabError):
            prov.install(cfg, "demo/toolchain", local=str(src),
                         sha256="0" * 64, log=lambda *a, **k: None)


class TestCockpitCard(ProviderTestBase):
    def test_card_projects_provider_and_step_sources(self):
        cards = srv.project_cards(self.cfg())["projects"]
        card = next(c for c in cards if c["name"] == "p1")
        self.assertEqual(card["provider"]["name"], "demo/toolchain")
        self.assertEqual(card["provider"]["version"], "1.2.0")
        self.assertEqual(card["steps"]["build"]["kind"], "external")
        self.assertEqual(card["steps"]["build"]["source"], "demo/toolchain@1.2.0")
        self.assertEqual(card["steps"]["monitor"]["kind"], "native")
        self.assertTrue(card["steps"]["build"]["ok"])


class TestVersion(ProviderTestBase):
    def test_satisfies(self):
        self.assertTrue(prov.satisfies_version("1.2.0", ">=1 <2"))
        self.assertTrue(prov.satisfies_version("1.2.0", "^1"))
        self.assertTrue(prov.satisfies_version("1.2.3", "~1.2"))
        self.assertFalse(prov.satisfies_version("1.2.0", ">=2"))
        self.assertFalse(prov.satisfies_version("1.2.0", "~1.1"))
        self.assertTrue(prov.satisfies_version("1.2.0", ""))


if __name__ == "__main__":
    unittest.main()
