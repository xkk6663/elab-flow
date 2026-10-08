"""OTA 布局单源化（方案 A/M1）的单元验证（stdlib unittest，无需 pytest、无需硬件）。

跑：``python tests/test_ota_layout.py`` 或 ``python -m unittest discover -s tests``

## 这个文件守什么

方案 A 把 OTA 分区表的单一事实源定为 chips/*.yaml 的 ``ota_layout:`` 节，
三段逻辑各有一个"后来者顺手简化"的高危面：

1. **归一化校验**（ota_layout.normalize_ota_layout）——缺区/重叠必须在 plan
   阶段 fail-fast；分区互斥是"分区表"的底线，静默放过 = 烧错位跑飞的温床。
2. **gen 头渲染**（ota_layout.render_gen_header）——宏名必须与 port 头
   ``ota_layout_*.h`` 逐字对齐（APP_START_ADDRESS / APP_SIZE / UPGRADE_STATE_ADDR /
   OFFSET_PAGE_ADDR / OTA_STORE_SLOT_COUNT…），拼错一个字母就是
   "#ifndef 兜底值悄悄赢"，单源化形同虚设。
3. **doctor 三方对账**（doctor.ota_layout_drift）——yaml 分区表 ↔
   flash.images 烧录地址 ↔ 各镜像 ld 的 FLASH ORIGIN。漂移要在编译前变红灯。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.elab.config import ElabError
from services.elab.doctor import ota_layout_drift
from services.elab.ota_layout import (
    normalize_ota_layout,
    render_gen_header,
    write_gen_file,
)
from services.elab.version import alloc_build, parse_version

# F411 真实布局（与 chips/st/stm32f411ceux.yaml 逐值一致）
F411_LAYOUT = {
    "boot": {"addr": 0x08000000, "size": 0x8000},
    "state": {"addr": 0x08008000, "size": 0x4000},
    "offset": {"addr": 0x0800C000, "size": 0x4000},
    "app": {"addr": 0x08010000, "size": 0x70000},
}
# F411 双槽（与 chips yaml slots 逐值一致：槽A=S4+S5 192K / 槽B=S6+S7 256K）
F411_SLOTS = [
    {"addr": 0x08010000, "size": 0x30000},
    {"addr": 0x08040000, "size": 0x40000},
]


class NormalizeTests(unittest.TestCase):
    def test_ok_and_derived_defaults(self):
        out = normalize_ota_layout(dict(F411_LAYOUT), "stm32f411ceux")
        self.assertEqual(out["boot"], {"addr": 0x08000000, "size": 0x8000})
        self.assertEqual(out["app"], {"addr": 0x08010000, "size": 0x70000})
        # flash_base 缺省 = boot.addr；store_slots 缺省 = state.size/4（16K/4=4096，
        # 与 port 头 OTA_STORE_SLOT_COUNT 逐值一致 —— 改分区大小自动改 slot 数）
        self.assertEqual(out["flash_base"], 0x08000000)
        self.assertEqual(out["store_slots"], 4096)

    def test_string_hex_forms_accepted(self):
        raw = {
            "boot": {"addr": "0x08000000", "size": "0x8000"},
            "state": {"addr": "0x08008000", "size": "0x4000"},
            "offset": {"addr": "0x0800C000", "size": "0x4000"},
            "app": {"addr": "0x08010000", "size": "0x70000"},
        }
        out = normalize_ota_layout(raw, "chip")
        self.assertEqual(out["app"]["addr"], 0x08010000)

    def test_missing_region_fails_fast(self):
        raw = dict(F411_LAYOUT)
        del raw["offset"]
        with self.assertRaises(ElabError):
            normalize_ota_layout(raw, "chip")

    def test_region_missing_size_fails_fast(self):
        raw = dict(F411_LAYOUT)
        raw["app"] = {"addr": 0x08010000}
        with self.assertRaises(ElabError):
            normalize_ota_layout(raw, "chip")

    def test_overlap_fails_fast(self):
        raw = dict(F411_LAYOUT)
        raw["state"] = {"addr": 0x08007000, "size": 0x4000}  # 与 boot 尾部重叠
        with self.assertRaises(ElabError):
            normalize_ota_layout(raw, "chip")

    def test_f103_order_also_ok(self):
        """F103/AT32 的 offset 在 state 前面（0xF800 < 0xFC00）——顺序无关，只禁重叠。"""
        raw = {
            "boot": {"addr": 0x08000000, "size": 0x4800},
            "app": {"addr": 0x08004800, "size": 0xB000},
            "offset": {"addr": 0x0800F800, "size": 0x400},
            "state": {"addr": 0x0800FC00, "size": 0x400},
        }
        out = normalize_ota_layout(raw, "stm32f103c8")
        self.assertEqual(out["store_slots"], 256)  # 1K/4，与 port 头逐值一致


class RenderTests(unittest.TestCase):
    def test_macro_names_aligned_with_port_header(self):
        text = render_gen_header(normalize_ota_layout(dict(F411_LAYOUT), "stm32f411ceux"),
                                 "stm32f411ceux")
        for name in ("FLASH_BASE_ADDR", "BOOTLOADER_SIZE", "APP_START_ADDRESS",
                     "APP_SIZE", "UPGRADE_STATE_ADDR", "OFFSET_PAGE_ADDR",
                     "OTA_STORE_SLOT_COUNT"):
            self.assertIn(name, text)
        self.assertIn("#define APP_START_ADDRESS     0x08010000", text)
        self.assertIn("#define APP_SIZE              0x00070000UL", text)
        self.assertIn("#define OTA_STORE_SLOT_COUNT  4096", text)
        self.assertIn("勿手改", text)  # 生成物警示
        self.assertIn("#ifndef OTA_LAYOUT_GEN_H", text)  # include 守卫

    def test_write_gen_file_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            path = write_gen_file(td, normalize_ota_layout(dict(F411_LAYOUT)), "chip")
            self.assertTrue(Path(path).exists())
            self.assertIn("elab_gen", path)
            self.assertIn("0x08010000", Path(path).read_text(encoding="utf-8"))


class SlotsTests(unittest.TestCase):
    """双槽（A/B Bank）归一化：方案 §3 的不变量在这里 fail-fast。"""

    def test_slots_ok(self):
        raw = dict(F411_LAYOUT, slots=[dict(s) for s in F411_SLOTS])
        out = normalize_ota_layout(raw, "stm32f411ceux")
        self.assertEqual(out["slots"], F411_SLOTS)  # 无缝衔接且覆盖 app → 原序保持

    def test_slots_unsorted_input_normalized(self):
        raw = dict(F411_LAYOUT, slots=[F411_SLOTS[1], F411_SLOTS[0]])
        out = normalize_ota_layout(raw, "chip")
        self.assertEqual(out["slots"][0]["addr"], 0x08010000)  # 按 addr 排序

    def test_slots_gap_fails(self):
        raw = dict(F411_LAYOUT, slots=[
            {"addr": 0x08010000, "size": 0x30000},
            {"addr": 0x08050000, "size": 0x30000},  # 与槽A之间有 64K 洞
        ])
        with self.assertRaises(ElabError):
            normalize_ota_layout(raw, "chip")

    def test_slots_not_covering_app_fails(self):
        raw = dict(F411_LAYOUT, slots=[
            {"addr": 0x08010000, "size": 0x30000},
            {"addr": 0x08040000, "size": 0x30000},  # 槽B尾部 0x08070000 ≠ app 尾 0x08080000
        ])
        with self.assertRaises(ElabError):
            normalize_ota_layout(raw, "chip")

    def test_slots_wrong_count_fails(self):
        raw = dict(F411_LAYOUT, slots=[F411_SLOTS[0]])
        with self.assertRaises(ElabError):
            normalize_ota_layout(raw, "chip")

    def test_render_slot_and_version_macros(self):
        layout = normalize_ota_layout(dict(F411_LAYOUT, slots=[dict(s) for s in F411_SLOTS]))
        text = render_gen_header(layout, "stm32f411ceux", version=(0, 2, 0), build_no=7)
        self.assertIn("#define OTA_SLOT_COUNT        2", text)
        self.assertIn("#define OTA_SLOT0_ADDR        0x08010000UL", text)
        self.assertIn("#define OTA_SLOT1_SIZE        0x00040000UL", text)
        self.assertIn("#define OTA_VER_MAJOR         0", text)
        self.assertIn("#define OTA_VER_MINOR         2", text)
        self.assertIn("#define OTA_VER_BUILD         7", text)
        # 未声明 slots/版本 → 不产出对应宏
        plain = render_gen_header(normalize_ota_layout(dict(F411_LAYOUT)))
        self.assertNotIn("OTA_SLOT_COUNT", plain)
        self.assertNotIn("OTA_VER_MAJOR", plain)

    def test_drift_slots_ok_and_out_of_physical(self):
        layout = normalize_ota_layout(dict(F411_LAYOUT, slots=[dict(s) for s in F411_SLOTS]))
        images = [{"path": "app.bin", "format": "bin", "address": "0x08010000"}]
        # 槽A起点 == app.addr == 烧录地址 → 一致
        self.assertEqual(ota_layout_drift(layout, images, (0x08000000, 0x80000)), [])
        # 出厂镜像烧槽 B 起点 → 不命中任何分区起点（槽B不许走 flash.images）→ 红灯
        bad = [{"path": "app.bin", "format": "bin", "address": "0x08040000"}]
        problems = ota_layout_drift(layout, bad, (0x08000000, 0x80000))
        self.assertTrue(any("未命中任何分区起点" in p for p in problems))


class VersionTests(unittest.TestCase):
    """版本声明解析 + build 号分配（§9.1）。"""

    def test_parse_version(self):
        self.assertEqual(parse_version("1.2.3"), (1, 2, 3))
        self.assertEqual(parse_version([0, 2, 0]), (0, 2, 0))
        self.assertIsNone(parse_version(None))
        self.assertIsNone(parse_version(""))
        with self.assertRaises(ElabError):
            parse_version("1.2")
        with self.assertRaises(ElabError):
            parse_version("a.b.c")

    def test_alloc_build_monotonic(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            a = alloc_build(td, "p1")
            b = alloc_build(td, "p1")
            c = alloc_build(td, "p2")
            self.assertEqual((a, b, c), (1, 2, 1))  # 按工程独立单调


class DriftTests(unittest.TestCase):
    """doctor 三方对账（含双槽扩展）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.td = Path(self._tmp.name)

    def _write_ld(self, name: str, origin: str, length: str = "448K") -> str:
        p = self.td / name
        p.write_text(
            f"MEMORY\n{{\n  RAM (xrw) : ORIGIN = 0x20000000, LENGTH = 128K\n"
            f"  FLASH (rx) : ORIGIN = {origin}, LENGTH = {length}\n}}\n",
            encoding="utf-8",
        )
        return str(p)

    def test_consistent_layout_no_problems(self):
        app_ld = self._write_ld("APP.ld", "0x8010000")
        boot_ld = self._write_ld("BOOT.ld", "0x8000000", "32K")
        images = [
            {"path": "boot.bin", "format": "bin", "address": "0x08000000", "ld": boot_ld},
            {"path": "app.bin", "format": "bin", "address": "0x08010000", "ld": app_ld},
        ]
        layout = normalize_ota_layout(dict(F411_LAYOUT))
        self.assertEqual(
            ota_layout_drift(layout, images, (0x08000000, 0x80000)), [],
        )

    def test_image_address_off_region_fails(self):
        images = [{"path": "app.bin", "format": "bin", "address": "0x08020000"}]
        layout = normalize_ota_layout(dict(F411_LAYOUT))
        problems = ota_layout_drift(layout, images, None)
        self.assertEqual(len(problems), 1)
        self.assertIn("未命中任何分区起点", problems[0])

    def test_ld_origin_drift_fails(self):
        """ld ORIGIN 与 yaml 分区起点漂移 —— 方案 A 要抓的正是这种跨文件漂移。"""
        app_ld = self._write_ld("APP.ld", "0x8020000")  # yaml 说 app@0x08010000
        images = [{"path": "app.bin", "format": "bin", "address": "0x08010000", "ld": app_ld}]
        layout = normalize_ota_layout(dict(F411_LAYOUT))
        problems = ota_layout_drift(layout, images, None)
        self.assertEqual(len(problems), 1)
        self.assertIn("≠ 命中分区 app 起点", problems[0])

    def test_out_of_physical_flash_fails(self):
        layout = normalize_ota_layout(dict(F411_LAYOUT))
        problems = ota_layout_drift(layout, [], (0x08000000, 0x10000))  # 只有 64K 物理
        self.assertTrue(any("越界物理 flash" in p for p in problems))

    def test_unreadable_ld_reported(self):
        images = [{"path": "app.bin", "format": "bin",
                   "address": "0x08010000", "ld": str(self.td / "nope.ld")}]
        layout = normalize_ota_layout(dict(F411_LAYOUT))
        problems = ota_layout_drift(layout, images, None)
        self.assertEqual(len(problems), 1)
        self.assertIn("ld 不可读", problems[0])


if __name__ == "__main__":
    unittest.main()
