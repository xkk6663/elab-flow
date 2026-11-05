"""test_setup —— 装完芯片包后的环境自检与安装引导。

运行：``python -m unittest tests.test_setup``

覆盖：
1. 包已装但 provider 未装 → 上报缺失 + ``elab provider install`` 下一步
2. provider 已装但 ``requires.host`` 缺失 → 逐项上报 + 工具链安装引导（只展示）
3. 全部就绪 → ``ok=True``
4. 原生链包（无 provider_hint）→ 通用 host 检查
5. ``toolchain`` 块结构 fail-fast
6. ``elab pkg install`` 之后自动附带自检（JSON 的 ``setup`` 字段）
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "services"))

from elab import provider as prov                         # noqa: E402
from elab import setup                                     # noqa: E402
from elab.config import Config                             # noqa: E402

PROVIDER_YAML = """\
schema_version: 1
provider_api: 1
name: demo/toolchain
version: 1.2.0
license: MIT
description: 测试用工具链

requires:
  kernel_api: ">=1 <2"
  host:
    - { key: tools.demo.python, check: file }
    - { key: tools.demo.root, check: dir }
  probe: false
  serial: false

toolchain:
  name: Demo Toolchain
  version: "1.2"
  docs: https://example.com/demo
  install:
    windows:
      - echo install demo on windows
    linux:
      - echo install demo on linux
  host_keys: [tools.demo.python, tools.demo.root]

steps:
  doctor:
    cmd: ["python", "-c", "print('demo ok')"]
"""

HOST_MISSING = """\
version: 1
host:
  os: windows
  exec_ext: .exe
tools:
  demo:
    python: C:/fake/demo/python.exe
    root: C:/fake/demo
packs:
  roots: [${ELAB_ROOT}/packs/installed]
providers:
  roots: [${ELAB_ROOT}/providers/installed]
"""

HOST_READY = """\
version: 1
host:
  os: windows
  exec_ext: .exe
tools:
  demo:
    python: ${ELAB_ROOT}/fake/demo/python.exe
    root: ${ELAB_ROOT}/fake/demo
packs:
  roots: [${ELAB_ROOT}/packs/installed]
providers:
  roots: [${ELAB_ROOT}/providers/installed]
"""

HOST_NATIVE_READY = """\
version: 1
host:
  os: windows
  exec_ext: .exe
toolchains:
  arm-none-eabi:
    root: {root}/fake-gcc
    version: ""
tools:
  cmake:
    path: {root}/fake/cmake.exe
    min: "3.22"
  ninja:
    path: {root}/fake/ninja.exe
  openocd:
    path: {root}/fake/openocd.exe
    scripts: {root}/fake/scripts
  gdb:
    from: arm-none-eabi
probes:
  list: {{}}
  default: ""
packs:
  roots: [{root}/packs/installed]
providers:
  roots: [{root}/providers/installed]
"""

PACK_YAML = """\
schema_version: 1
name: demo/esp
vendor: demo
platform: esp
version: 0.1.0
license: MIT
status: community
requires:
  kernel_api: ">=1 <2"
  schema_version: 1
vendor_fingerprints:
  - vendor: demo
    kind: idf
    provider_hint: demo/toolchain
"""

PACK_NATIVE = """\
schema_version: 1
name: demo/arm
vendor: demo
platform: arm
version: 0.1.0
license: MIT
status: community
requires:
  kernel_api: ">=1 <2"
  schema_version: 1
vendor_fingerprints:
  - vendor: demo
    generator: demo-cube
"""

CHIP_YAML = """\
vendor: demo
id: demo1
"""


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _make_pack(root: Path, rel: str, manifest: str) -> Path:
    pack_dir = root / "packs" / "installed" / rel
    _write(pack_dir / "pack.yaml", manifest)
    _write(pack_dir / "chips" / "demo1.yaml", CHIP_YAML)
    return pack_dir


class SetupTestBase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(prefix="elab-test-setup-")
        self.root = Path(self._td.name)
        _write(self.root / "elab.host.yaml", HOST_MISSING)

    def tearDown(self):
        self._td.cleanup()

    def cfg(self) -> Config:
        return Config(self.root)

    def install_provider(self) -> Path:
        dest = self.root / "providers" / "installed" / "demo" / "toolchain"
        _write(dest / "provider.yaml", PROVIDER_YAML)
        return dest


class TestPackSetup(SetupTestBase):
    def test_provider_missing_reports_and_points_to_install(self):
        _make_pack(self.root, "demo/esp", PACK_YAML)
        # 官方源码里有 provider（仅用于展示安装引导，不算已安装）
        _write(self.root / "providers" / "official" / "demo" / "toolchain"
               / "provider.yaml", PROVIDER_YAML)

        report = setup.pack_report(self.cfg(), pack="demo/esp")
        codes = {i["code"] for i in report["items"]}
        self.assertFalse(report["ok"])
        self.assertIn("provider.demo/toolchain", codes)
        self.assertIn("elab provider install demo/toolchain", report["next"])

        entry = report["providers"][0]
        self.assertFalse(entry["installed"])
        self.assertEqual(entry["toolchain"]["name"], "Demo Toolchain")
        # host 缺失逐项上报（来自官方源码的 requires.host）
        self.assertTrue(all(not h["ok"] for h in entry["host"]))
        guide = next(i for i in report["items"]
                     if i["code"] == "toolchain.demo/toolchain")
        self.assertIn("echo install demo on windows", "\n".join(guide["detail"]))

    def test_provider_installed_but_host_missing(self):
        _make_pack(self.root, "demo/esp", PACK_YAML)
        self.install_provider()

        report = setup.pack_report(self.cfg(), pack="demo/esp")
        codes = {i["code"] for i in report["items"]}
        self.assertFalse(report["ok"])
        self.assertIn("provider.demo/toolchain", codes)
        self.assertIn("host.tools.demo.python", codes)
        self.assertIn("host.tools.demo.root", codes)
        self.assertTrue(any("elab.host.yaml" in s for s in report["next"]))

    def test_all_ready(self):
        _make_pack(self.root, "demo/esp", PACK_YAML)
        self.install_provider()
        _write(self.root / "elab.host.yaml", HOST_READY)
        (self.root / "fake" / "demo").mkdir(parents=True)
        _write(self.root / "fake" / "demo" / "python.exe", "")

        report = setup.pack_report(self.cfg(), pack="demo/esp")
        self.assertTrue(report["ok"])
        self.assertFalse(any(i["code"].startswith("host.") and i["level"] == "error"
                             for i in report["items"]))
        self.assertFalse(any(i["code"].startswith("toolchain.")
                             for i in report["items"]))


class TestNativeSetup(SetupTestBase):
    def setUp(self):
        super().setUp()
        for exe in ("fake-gcc/bin/arm-none-eabi-gcc.exe",
                    "fake-gcc/bin/arm-none-eabi-gdb.exe",
                    "fake/ninja.exe", "fake/openocd.exe", "fake/cmake.exe"):
            _write(self.root / exe, "")
        (self.root / "fake" / "scripts").mkdir(parents=True)
        _write(self.root / "elab.host.yaml",
               HOST_NATIVE_READY.format(root=self.root.as_posix()))

    def test_native_pack_runs_generic_host_check(self):
        _make_pack(self.root, "demo/arm", PACK_NATIVE)
        report = setup.pack_report(self.cfg(), pack="demo/arm")
        codes = {i["code"] for i in report["items"]}
        self.assertIn("provider.none", codes)
        self.assertIn("toolchain.root", codes)
        self.assertTrue(report["ok"], report["items"])


class TestToolchainManifest(SetupTestBase):
    def test_valid_toolchain_block(self):
        man = prov.read_manifest(self.install_provider())
        self.assertEqual(prov.validate_manifest(man), [])
        self.assertEqual(man["toolchain"]["host_keys"],
                         ["tools.demo.python", "tools.demo.root"])

    def test_unknown_toolchain_key(self):
        man = prov.read_manifest(self.install_provider())
        man["toolchain"]["bogus"] = 1
        self.assertTrue(any("toolchain 含未知字段" in p
                            for p in prov.validate_manifest(man)))

    def test_unknown_install_platform(self):
        man = prov.read_manifest(self.install_provider())
        man["toolchain"]["install"]["beos"] = "echo hi"
        self.assertTrue(any("平台未知" in p for p in prov.validate_manifest(man)))

    def test_host_keys_must_be_string_list(self):
        man = prov.read_manifest(self.install_provider())
        man["toolchain"]["host_keys"] = "tools.demo.python"
        self.assertTrue(any("host_keys" in p for p in prov.validate_manifest(man)))


class TestPkgInstallTriggersSetup(SetupTestBase):
    def test_install_json_contains_setup_report(self):
        from elab.__main__ import main

        pack_dir = _make_pack(self.root, "src/demo-esp", PACK_YAML)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = main(["pkg", "install", "--from", str(pack_dir),
                       "--root", str(self.root), "--json", "--no-skill"])
        self.assertEqual(rc, 0)
        data = json.loads(out.getvalue())
        self.assertIn("setup", data)
        self.assertEqual(data["setup"]["pack"]["name"], "demo/esp")
        self.assertFalse(data["setup"]["ok"])


if __name__ == "__main__":
    unittest.main()
