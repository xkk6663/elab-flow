"""`elab adapt` 一键适配探测器的离线回归用例。

        python -m unittest tests.test_adapt

覆盖（对应 docs/需求对照与改进.md P1-6 验收）：
  - A 类（preset toolchainFile）与 B 类（CMakeLists 行内 include）两类工程探测；
  - 写盘 → 复写幂等 → `check` identical；
  - 人工接管保护（generated-by 标记缺失 → hand-edited，不覆盖）；
  - 工程变更后的 drift 判定；
  - 「适配 ≠ 改造」：写盘前后业务工程字节不变；
  - T3（无 CMakeLists）与未决项 / 未匹配芯片的拒写。

全部在临时目录里造工程与适配包，不碰仓库的 packs/ 与 projects/。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab import adapt                                    # noqa: E402
from elab import pkg                                      # noqa: E402
from elab.config import Config, ElabError                 # noqa: E402

HOST_YAML = """\
version: 1
packs:
  roots:
    - ${ELAB_ROOT}/packs/installed
"""

PACK_YAML = """\
schema_version: 1
name: acme/demo
vendor: acme
platform: demo
version: 0.1.0
license: MIT
status: community
description: 测试用适配包（A/B 两类工程夹具）
requires:
  kernel_api: ">=1 <2"
  schema_version: 1
vendor_fingerprints:
  - gen_dir: acme_cmake
    syms_var: ACME_SYMS
    project_glob: "*.atwp"
"""

CHIP1_YAML = """\
id: acme1
vendor: acme
platform: demo
part: ACME1_V1
core:
  cpu: cortex-m4
memory:
  flash: { origin: 0x08000000, length: 0x10000 }
  ram:   { origin: 0x20000000, length: 0x4000 }
"""

CHIP2_YAML = """\
id: acme2
vendor: acme
platform: demo
part: ACME2_V1
core:
  cpu: cortex-m3
memory:
  flash: { origin: 0x08000000, length: 0x20000 }
  ram:   { origin: 0x20000000, length: 0x8000 }
"""

CMAKE_B = """\
cmake_minimum_required(VERSION 3.20)
project(DEMO_B)
add_subdirectory(cmake/acme_cmake)
include("cmake/acme_b_toolchain.cmake")
"""

CMAKE_A = """\
cmake_minimum_required(VERSION 3.20)
project(DEMO_A)
add_subdirectory(cmake/acme_cmake)
"""

PRESETS_A = """\
{
  "version": 3,
  "configurePresets": [
    { "name": "debug", "toolchainFile": "cmake/acme_a_toolchain.cmake" }
  ]
}
"""

SYMS_B = """\
set(ACME_SYMS
    ACME1_V1
)
"""

SYMS_A = """\
set(ACME_SYMS
    ACME2_V1
)
"""

TC_B = """\
set(CMAKE_C_COMPILER arm-none-eabi-gcc)
set(TARGET_FLAGS "-mcpu=cortex-m4 -mfloat-abi=soft")
set(CMAKE_C_LINK_FLAGS "${CMAKE_C_LINK_FLAGS} -Tacme_b.ld")
"""

TC_A = """\
set(CMAKE_C_COMPILER arm-none-eabi-gcc)
set(TARGET_FLAGS "-mcpu=cortex-m3")
set(CMAKE_EXE_LINKER_FLAGS "-Tacme_a.ld")
"""

LD_B = """\
MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 0x10000
  RAM (rwx)  : ORIGIN = 0x20000000, LENGTH = 0x4000
}
"""

LD_A = """\
MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 0x20000
  RAM (rwx)  : ORIGIN = 0x20000000, LENGTH = 0x8000
}
"""

ATWP_B = """\
<?xml version="1.0" encoding="utf-8"?>
<Project>
  <MCUName>ACME1_V1</MCUName>
  <Setting name="RealBaudRate" value="115200" />
</Project>
"""


def _quiet(*_a, **_k):
    """吞掉 write()/install() 的默认 print，测试输出保持干净。"""


class AdaptTestBase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(prefix="elab-test-adapt-")
        self.root = Path(self._td.name)
        self._write(self.root / "elab.host.yaml", HOST_YAML)
        self.cfg = Config(self.root)
        self._install_pack()

    def tearDown(self):
        self._td.cleanup()

    # ── 夹具 ────────────────────────────────────────────────────
    @staticmethod
    def _write(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def _install_pack(self) -> None:
        src = self.root / "src" / "acme_demo"
        self._write(src / "pack.yaml", PACK_YAML)
        self._write(src / "chips" / "acme1.yaml", CHIP1_YAML)
        self._write(src / "chips" / "acme2.yaml", CHIP2_YAML)
        pkg.install(self.cfg, local=src, log=_quiet)
        # 安装后重开 Config：packs / chips 是惰性缓存，旧实例看不到新包。
        self.cfg = Config(self.root)

    def make_b_project(self, dirname: str = "demo_b") -> Path:
        d = self.root / "fixtures" / dirname
        self._write(d / "CMakeLists.txt", CMAKE_B)
        self._write(d / "cmake" / "acme_cmake" / "CMakeLists.txt", SYMS_B)
        self._write(d / "cmake" / "acme_b_toolchain.cmake", TC_B)
        self._write(d / "acme_b.ld", LD_B)
        self._write(d / "demo.atwp", ATWP_B)
        return d

    def make_a_project(self, dirname: str = "demo_a") -> Path:
        d = self.root / "fixtures" / dirname
        self._write(d / "CMakeLists.txt", CMAKE_A)
        self._write(d / "CMakePresets.json", PRESETS_A)
        self._write(d / "cmake" / "acme_cmake" / "CMakeLists.txt", SYMS_A)
        self._write(d / "cmake" / "acme_a_toolchain.cmake", TC_A)
        self._write(d / "acme_a.ld", LD_A)
        return d

    def project_yaml(self, name: str) -> Path:
        return self.root / "projects" / f"{name}.yaml"

    def snapshot(self, d: Path) -> dict[str, bytes]:
        return {str(p.relative_to(d)): p.read_bytes() for p in d.rglob("*") if p.is_file()}


class TestProbe(AdaptTestBase):
    def test_b_class_probe(self):
        """B 类：CMakeLists 行内 include 工具链 → 链接变量是 CMAKE_C_LINK_FLAGS。"""
        p = adapt.probe_project(self.cfg, self.make_b_project())
        self.assertEqual(p.tier, "T1")
        self.assertEqual(p.archetype, "B")
        self.assertEqual(p.vendor, "acme")
        self.assertEqual(p.chip_ref, "acme/acme1")
        self.assertEqual(p.project_name, "DEMO_B")
        self.assertEqual(p.linker_script, "acme_b.ld")
        self.assertEqual(p.linker_variable, "CMAKE_C_LINK_FLAGS")
        self.assertEqual(p.baud, 115200)
        self.assertEqual(p.ambiguities, [])
        self.assertEqual(p.conflicts, [])
        self.assertEqual(p.confidence, "high")

    def test_a_class_probe(self):
        """A 类：工具链由 CMakePresets.json 的 toolchainFile 指定 → CMAKE_EXE_LINKER_FLAGS。"""
        p = adapt.probe_project(self.cfg, self.make_a_project())
        self.assertEqual(p.archetype, "A")
        self.assertEqual(p.vendor, "acme")
        self.assertEqual(p.chip_ref, "acme/acme2")
        self.assertEqual(p.project_name, "DEMO_A")
        self.assertEqual(p.linker_script, "acme_a.ld")
        self.assertEqual(p.linker_variable, "CMAKE_EXE_LINKER_FLAGS")
        self.assertEqual(p.ambiguities, [])
        self.assertEqual(p.confidence, "high")

    def test_t3_without_cmakelists(self):
        d = self.root / "fixtures" / "plain"
        self._write(d / "main.c", "int main(void) { return 0; }\n")
        p = adapt.probe_project(self.cfg, d)
        self.assertEqual(p.tier, "T3")
        self.assertEqual(p.confidence, "low")
        with self.assertRaises(ElabError):
            adapt.write(self.cfg, p, log=_quiet)

    def test_unmatched_chip_refuses_write(self):
        """没有匹配芯片 → 未决项，write 拒写（不猜）。"""
        d = self.make_b_project("demo_unknown")
        self._write(d / "cmake" / "acme_cmake" / "CMakeLists.txt",
                    "set(ACME_SYMS\n    ACME9_V1\n)\n")
        p = adapt.probe_project(self.cfg, d)
        self.assertEqual(p.chip_ref, "")
        self.assertTrue(p.ambiguities)
        with self.assertRaises(ElabError) as ctx:
            adapt.write(self.cfg, p, name="demo_unknown", log=_quiet)
        self.assertIn("未决项", str(ctx.exception))


class TestWrite(AdaptTestBase):
    def test_write_then_check_identical(self):
        d = self.make_b_project()
        p = adapt.probe_project(self.cfg, d)
        r1 = adapt.write(self.cfg, p, log=_quiet)
        self.assertEqual(r1["status"], "written")
        self.assertTrue(r1["written"])

        out = self.project_yaml("demo_b")
        self.assertTrue(out.exists())
        text = out.read_text(encoding="utf-8")
        self.assertIn("generated-by: elab adapt", text)
        self.assertIn("chip: acme/acme1", text)
        self.assertIn("${ELAB_ROOT}/fixtures/demo_b", text)

        # 同工程再写一次 → 幂等，不重写
        r2 = adapt.write(self.cfg, p, log=_quiet)
        self.assertEqual(r2["status"], "identical")
        self.assertFalse(r2["written"])

        # --check → identical
        r3 = adapt.write(self.cfg, p, check=True, log=_quiet)
        self.assertEqual(r3["status"], "identical")
        self.assertFalse(r3["written"])

    def test_default_probe_from_host(self):
        """新适配工程的默认探针取 elab.host.yaml 的 probes.default，而不是写死 atlink。"""
        self._write(self.root / "elab.host.yaml", HOST_YAML.replace(
            "version: 1",
            "version: 1\nprobes:\n  default: stlink\n  list:\n"
            "    stlink: { backend: stlink, interface_cfg: interface/stlink.cfg }\n",
            1))
        self.cfg = Config(self.root)
        p = adapt.probe_project(self.cfg, self.make_b_project())
        adapt.write(self.cfg, p, log=_quiet)
        text = self.project_yaml("demo_b").read_text(encoding="utf-8")
        self.assertIn("probe: stlink", text)

    def test_check_missing_before_write(self):
        p = adapt.probe_project(self.cfg, self.make_a_project())
        r = adapt.write(self.cfg, p, check=True, log=_quiet)
        self.assertEqual(r["status"], "missing")
        self.assertFalse(self.project_yaml("demo_a").exists())

    def test_untouched(self):
        """适配 ≠ 改造：写盘只新增 projects/<name>.yaml，业务工程字节不变。"""
        d = self.make_b_project()
        before = self.snapshot(d)
        p = adapt.probe_project(self.cfg, d)
        adapt.write(self.cfg, p, log=_quiet)
        self.assertEqual(self.snapshot(d), before)

    def test_hand_edited_protection(self):
        """人工接管（删掉 generated-by 标记）→ 不覆盖；--force 才覆盖并留 .bak。"""
        p = adapt.probe_project(self.cfg, self.make_b_project())
        adapt.write(self.cfg, p, log=_quiet)
        out = self.project_yaml("demo_b")
        hand = out.read_text(encoding="utf-8").replace(
            "# generated-by: elab adapt   ← 机器生成标记；删掉此行即视为人工接管，elab 将不再覆盖\n", "")
        out.write_text(hand, encoding="utf-8")

        r = adapt.write(self.cfg, p, log=_quiet)
        self.assertEqual(r["status"], "hand-edited")
        self.assertFalse(r["written"])
        self.assertEqual(out.read_text(encoding="utf-8"), hand)

        r2 = adapt.write(self.cfg, p, force=True, log=_quiet)
        self.assertEqual(r2["status"], "written")
        self.assertTrue(Path(r2["backup"]).exists())
        self.assertEqual(Path(r2["backup"]).read_text(encoding="utf-8"), hand)

    def test_drift_after_project_change(self):
        """工程变更后复探测 → drift（不自动覆盖，交给人重新适配）。"""
        d = self.make_b_project()
        p = adapt.probe_project(self.cfg, d)
        adapt.write(self.cfg, p, log=_quiet)

        # 生成器模板改了波特率（工程事实变化）→ 重新探测结果与落盘文件不一致
        self._write(d / "demo.atwp", ATWP_B.replace('value="115200"', 'value="921600"'))
        p2 = adapt.probe_project(self.cfg, d)
        r = adapt.write(self.cfg, p2, check=True, log=_quiet)
        self.assertEqual(r["status"], "drift")
        self.assertFalse(r["written"])
        # drift 不写盘：文件仍是旧内容
        self.assertIn('baud: 115200', self.project_yaml("demo_b").read_text(encoding="utf-8"))

    def test_a_class_writes_and_checks(self):
        p = adapt.probe_project(self.cfg, self.make_a_project())
        r1 = adapt.write(self.cfg, p, log=_quiet)
        self.assertEqual(r1["status"], "written")
        self.assertIn("chip: acme/acme2", self.project_yaml("demo_a").read_text(encoding="utf-8"))
        r2 = adapt.write(self.cfg, p, check=True, log=_quiet)
        self.assertEqual(r2["status"], "identical")


if __name__ == "__main__":
    unittest.main()
