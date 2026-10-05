"""C33 OTA 双镜像（flash.images）的单元验证（stdlib unittest，无需 pytest、无需硬件）。

跑：``python tests/test_flash_images.py`` 或 ``python -m unittest discover -s tests``

## 这个文件守什么

C33 一次引入了四段逻辑，每段都有"后来者顺手简化"的高危写法：

1. **plan 解析校验**（plan._parse_flash_images）——bin 不带显式地址是最危险的静默
   错误（M2 实测：app.elf 烧录从 0x08004000 起擦，覆盖 Bootloader 尾部），
   校验必须在 plan 层 fail-fast，而不是等 openocd 报一个离根因很远的错。
2. **flash 多镜像命令构造**（flash._flash_images）——预览与实跑共用同一函数
   （C26 单一命令源）；bin 必须带地址、收尾必须是 ``reset run``（与 debug 同约定）。
3. **doctor 镜像级对账**（doctor._check_drift_images）——BOOT 18K / APP 44K 都
   不等于芯片 64K，逐字节相等口径必然误报；换 ⊆ 物理范围口径后，
   flash 分区互斥 + bin 地址对齐 ld 起点是新的防呆面。
4. **adapt 输出能力探测**（adapt._has_putchar_definition）——Allman 风格
   （``{`` 换行）是 WorkBench 生成代码的常态，漏认会把有输出能力的固件
   误判成"无输出能力"，进而静默放弃 monitor 判据。

全部纯函数/临时文件入参出参，不插板、不开串口。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))

from elab import adapt                        # noqa: E402
from elab import doctor                       # noqa: E402
from elab import flash as flash_mod           # noqa: E402
from elab import plan as plan_mod             # noqa: E402
from elab.config import ElabError             # noqa: E402


# ══════════════════════════════════════════════════════════════════
#  1. plan._parse_flash_images —— fail-fast 校验
# ══════════════════════════════════════════════════════════════════
class TestParseFlashImages(unittest.TestCase):

    def test_absent_flash_section_means_single_image(self):
        """未声明 flash.images → []，单镜像模式，与旧行为完全一致。"""
        self.assertEqual(plan_mod._parse_flash_images({"name": "p"}), [])
        self.assertEqual(
            plan_mod._parse_flash_images({"name": "p", "flash": {}}), [])
        self.assertEqual(
            plan_mod._parse_flash_images(
                {"name": "p", "flash": {"images": []}}), [])

    def test_valid_layout_resolved(self):
        imgs = plan_mod._parse_flash_images({
            "name": "p",
            "flash": {"images": [
                {"path": "/x/boot.elf", "format": "elf"},
                {"path": "/x/app.bin", "format": "bin", "address": "0x08004800"},
            ]},
        })
        self.assertEqual(len(imgs), 2)
        self.assertEqual(imgs[0]["format"], "elf")
        self.assertEqual(imgs[0]["address"], "")
        self.assertEqual(imgs[1]["address"], "0x08004800")

    def test_bin_without_address_rejected(self):
        """★ M2 铁律：bin 不带显式地址 = 会擦掉 Bootloader —— 必须在 plan 层拒绝。"""
        with self.assertRaises(ElabError):
            plan_mod._parse_flash_images({
                "name": "p",
                "flash": {"images": [{"path": "/x/app.bin", "format": "bin"}]},
            })

    def test_bad_format_rejected(self):
        with self.assertRaises(ElabError):
            plan_mod._parse_flash_images({
                "name": "p",
                "flash": {"images": [{"path": "/x/a.hex", "format": "hex"}]},
            })

    def test_non_hex_address_rejected(self):
        with self.assertRaises(ElabError):
            plan_mod._parse_flash_images({
                "name": "p",
                "flash": {"images": [
                    {"path": "/x/app.bin", "format": "bin", "address": "134234112"}]},
            })

    def test_missing_path_rejected(self):
        with self.assertRaises(ElabError):
            plan_mod._parse_flash_images({
                "name": "p",
                "flash": {"images": [{"format": "elf"}]},
            })


# ══════════════════════════════════════════════════════════════════
#  2. flash._flash_images —— 命令构造（C26：预览 = 实跑）
# ══════════════════════════════════════════════════════════════════
class _FakeHost:
    """最小 Host 替身：只满足 _openocd_argv 的存在性检查（argv 是纯字符串拼接）。"""

    def __init__(self, scripts_root: Path):
        self.openocd = "openocd"
        self.openocd_scripts = str(scripts_root)

    def probe(self, _name):
        return {}


class _FakePlan:
    """最小 Plan 替身：flash 命令构造只碰这些字段。"""

    def __init__(self, images, scripts_root: Path):
        self.flash_images = images
        self.name = "fake"
        self.chip = {"id": "at32f421g8",
                     "debug": {"device": "AT32F421G8U7",
                               "openocd_interface": "interface/dap.cfg",
                               "openocd_target": "target/at32f421xx.cfg"}}
        self.probe = ""
        self.cfg = None
        self.host = _FakeHost(scripts_root)


BOOT = {"path": "/x/boot.elf", "format": "elf", "address": "", "ld": ""}
APP = {"path": "/x/app.bin", "format": "bin", "address": "0x08004800", "ld": ""}


class TestFlashImagesCommand(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "interface").mkdir()
        (root / "target").mkdir()
        (root / "interface" / "dap.cfg").write_text("# fake\n", encoding="utf-8")
        (root / "target" / "at32f421xx.cfg").write_text("# fake\n", encoding="utf-8")
        self.scripts_root = root

    def tearDown(self):
        self.tmp.cleanup()

    def _plan(self, images):
        return _FakePlan(images, self.scripts_root)

    def _cmds(self, res):
        """argv 里 -c 后面的命令序列（_openocd_argv 是 -c 与命令交替的结构）。"""
        argv = res["argv"]
        return [argv[i + 1] for i, a in enumerate(argv) if a == "-c"]

    def test_bin_carries_explicit_address(self):
        """★ M2 落地：bin 镜像的 program 必须带显式地址。"""
        res = flash_mod._flash_images(
            self._plan([dict(BOOT), dict(APP)]), dry_run=True,
            verbose=False, log=lambda *_: None, allow_missing=True)
        prog = [c for c in self._cmds(res) if c.startswith("program")]
        self.assertEqual(len(prog), 2)
        self.assertEqual(prog[0], "program {/x/boot.elf} verify")
        self.assertEqual(prog[1], "program {/x/app.bin} 0x08004800 verify")

    def test_session_ends_with_reset_run_and_shutdown(self):
        """收尾必须是 reset run（留运行态）+ shutdown，且 program 不带 exit/reset。"""
        res = flash_mod._flash_images(
            self._plan([dict(BOOT), dict(APP)]), dry_run=True,
            verbose=False, log=lambda *_: None, allow_missing=True)
        cs = self._cmds(res)
        self.assertEqual(cs[-2], "reset run")
        self.assertEqual(cs[-1], "shutdown")
        for c in cs:
            if c.startswith("program"):
                self.assertNotIn("exit", c)
                self.assertNotIn("reset", c)

    def test_missing_image_raises_unless_preview(self):
        with self.assertRaises(ElabError):
            flash_mod._flash_images(
                self._plan([dict(APP)]), dry_run=True, verbose=False,
                log=lambda *_: None, allow_missing=False)
        res = flash_mod._flash_images(          # 预览放开
            self._plan([dict(APP)]), dry_run=True, verbose=False,
            log=lambda *_: None, allow_missing=True)
        self.assertFalse(res["images"][0]["exists"])

    def test_result_carries_images_and_primary_elf(self):
        res = flash_mod._flash_images(
            self._plan([dict(BOOT), dict(APP)]), dry_run=True,
            verbose=False, log=lambda *_: None, allow_missing=True)
        self.assertEqual(res["elf"], "/x/boot.elf")
        self.assertEqual([i["format"] for i in res["images"]], ["elf", "bin"])


# ══════════════════════════════════════════════════════════════════
#  3. doctor._check_drift_images —— 镜像级内存对账
# ══════════════════════════════════════════════════════════════════
BOOT_LD = """
MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 18K
  RAM  (rwx) : ORIGIN = 0x20000000, LENGTH = 16K
}
"""
APP_LD = """
MEMORY
{
  FLASH (rx) : ORIGIN = 0x08004800, LENGTH = 44K
  RAM  (rwx) : ORIGIN = 0x20000000, LENGTH = 16K
}
"""


class _DriftPlan:
    """doctor 镜像对账所需的最小 Plan 替身。"""

    def __init__(self, images, linker_script, chip_memory=None):
        self.flash_images = images
        self.linker_script = linker_script
        self.name = "fake"
        self.chip = {
            "id": "at32f421g8",
            "memory": chip_memory or {
                "flash": {"origin": "0x08000000", "length": "0x10000"},
                "ram": {"origin": "0x20000000", "length": "0x4000"},
            },
        }


def _write_ld(tmp: Path, name: str, text: str) -> str:
    p = tmp / name
    p.write_text(text, encoding="utf-8")
    return str(p)


class TestDriftImages(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.boot_ld = _write_ld(self.root, "BOOT.ld", BOOT_LD)
        self.app_ld = _write_ld(self.root, "APP.ld", APP_LD)

    def tearDown(self):
        self.tmp.cleanup()

    def _imgs(self, app_address="0x08004800"):
        return [
            {"path": "/x/boot.elf", "format": "elf", "address": "", "ld": self.boot_ld},
            {"path": "/x/app.bin", "format": "bin", "address": app_address,
             "ld": self.app_ld},
        ]

    def _run(self, plan):
        rep = doctor.Report()
        doctor._check_drift_images(rep, plan, {"flash": "0x10000", "ram": "0x4000"})
        return rep

    def test_legal_layout_passes(self):
        """BOOT 18K + APP 44K（⊆ 64K、互斥、地址对齐）→ ok。"""
        rep = self._run(_DriftPlan(self._imgs(), self.app_ld))
        self.assertTrue(rep.passed, rep.render())
        self.assertIn("双镜像布局合法", rep.render())

    def test_overlapping_flash_partitions_fail(self):
        """APP 压到 BOOT 区 → fail（分区互斥被破坏）。"""
        app_ld = _write_ld(self.root, "APP_BAD.ld", BOOT_LD)   # 故意同 BOOT 区
        imgs = [
            {"path": "/x/boot.elf", "format": "elf", "address": "", "ld": self.boot_ld},
            {"path": "/x/app.bin", "format": "bin", "address": "0x08000000",
             "ld": app_ld},
        ]
        rep = self._run(_DriftPlan(imgs, app_ld))
        self.assertFalse(rep.passed)
        self.assertIn("重叠", rep.render())

    def test_out_of_physical_range_fails(self):
        """APP 越过芯片 64K 末尾 → fail。"""
        app_ld = _write_ld(self.root, "APP_BIG.ld", """
MEMORY
{
  FLASH (rx) : ORIGIN = 0x08004800, LENGTH = 64K
  RAM  (rwx) : ORIGIN = 0x20000000, LENGTH = 16K
}
""")
        imgs = [
            {"path": "/x/boot.elf", "format": "elf", "address": "", "ld": self.boot_ld},
            {"path": "/x/app.bin", "format": "bin", "address": "0x08004800",
             "ld": app_ld},
        ]
        rep = self._run(_DriftPlan(imgs, app_ld))
        self.assertFalse(rep.passed)
        self.assertIn("越界", rep.render())

    def test_bin_address_misaligned_with_ld_origin_fails(self):
        """★ 烧错位 = 跑飞：bin address ≠ 其 ld 的 flash 起点 → fail。"""
        rep = self._run(_DriftPlan(self._imgs(app_address="0x08004000"),
                                   self.app_ld))
        self.assertFalse(rep.passed)
        self.assertIn("bin address", rep.render())

    def test_ram_full_overlap_is_not_flagged(self):
        """RAM 两个镜像都声明全量 16K 是 OTA 惯例（不同时运行）→ 不得报重叠。"""
        rep = self._run(_DriftPlan(self._imgs(), self.app_ld))
        self.assertNotIn("重叠", rep.render())


# ══════════════════════════════════════════════════════════════════
#  4. adapt._has_putchar_definition —— Allman 风格不漏报
# ══════════════════════════════════════════════════════════════════
class TestPutcharDetection(unittest.TestCase):

    SAME_LINE = "int __io_putchar(int ch) {\n    usart_data_transmit(USART1, ch);\n}\n"
    NEXT_LINE = ("int __io_putchar(int ch)\n{\n"
                 "    while(usart_flag_get(USART1, USART_TDBE_FLAG) == RESET)\n"
                 "    { if(--timeout == 0) { return ch; } }\n"
                 "    usart_data_transmit(USART1, (uint16_t)ch);\n    return ch;\n}\n")
    WEAK_DECL = "extern int __io_putchar(int ch) __attribute__((weak));\n"
    PROTO_DECL = "int __io_putchar(int ch);\n"

    def test_same_line_brace_detected(self):
        self.assertTrue(adapt._has_putchar_definition(self.SAME_LINE))

    def test_next_line_brace_detected(self):
        """★ WorkBench 生成代码是 Allman 风格 —— 漏认 = 误报无输出能力（实测坑）。"""
        self.assertTrue(adapt._has_putchar_definition(self.NEXT_LINE))

    def test_weak_declaration_not_a_definition(self):
        self.assertFalse(adapt._has_putchar_definition(self.WEAK_DECL))

    def test_prototype_not_a_definition(self):
        self.assertFalse(adapt._has_putchar_definition(self.PROTO_DECL))

    def test_comment_before_brace_still_detected(self):
        commented = ("int __io_putchar(int ch)\n"
                     "{ /* TDBE wait + timeout */\n    return ch;\n}\n")
        self.assertTrue(adapt._has_putchar_definition(commented))


if __name__ == "__main__":
    unittest.main()
