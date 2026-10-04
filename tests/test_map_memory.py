"""``builder.parse_map_memory`` 的验证。

这个解析器是**内存占位的兜底来源**（Ninja 增量构建不 relink 时，链接器不会输出
``--print-memory-usage``）。它必须与链接器自报**逐字节一致**，否则驾驶舱的
内存表盘会在"改了代码"和"没改代码"两种情况下给出不同的数 —— 那是最难查的一类 bug。

下面的夹具不是随便编的，每一行都对应一个真实踩过的坑（见各条注释）。
真实工程上的交叉验证在 ``test_matches_linker_on_real_maps``（需先构建过）。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))

from elab.builder import parse_map_memory  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]

#: 合成 map：覆盖 ①/② 两种段形态、LMA 归属、NOBITS 排除、对齐填充、空 region、*default* 排除
FIXTURE = """\
Memory Configuration

Name             Origin             Length             Attributes
FLASH            0x08000000         0x00010000         xr
RAM              0x20000000         0x00004000         xrw
CCM              0x10000000         0x00010000         rw
*default*        0x00000000         0xffffffff

Linker script and memory map

LOAD crti.o
.isr_vector     0x08000000       0x100
.text           0x08000100       0x200
 *fill*         0x08000300        0x4
.rodata         0x08000304       0x10
.data           0x20000000       0x20 load address 0x08000314
.bss            0x20000020       0x40 load address 0x08000334
._user_heap_stack
                0x20000060      0x400 load address 0x08000334
.ARM.attributes
                0x00000000       0x2a
.debug_info     0x00000000     0x4b70
"""


class TestMapMemory(unittest.TestCase):
    def _parse(self, text: str) -> dict:
        with TemporaryDirectory() as d:
            p = Path(d) / "x.map"
            p.write_text(text, encoding="utf-8")
            return parse_map_memory(p)

    def test_flash_uses_span_not_sum(self):
        """★ 核心：region 用量是**跨度**，不是各段之和。

        本夹具里 `.text` 结束后有一处 4 字节 `*fill*`（对齐）。
        求和 = 0x100+0x200+0x10+0x20 = 0x330 = 816；
        跨度 = 0x08000334-0x08000000 = 0x334 = 820。
        **链接器自报的是 820**。真实工程同样差 4 字节（11784 vs 11788）。
        """
        m = self._parse(FIXTURE)
        self.assertEqual(m["FLASH"]["used"], 0x334)
        self.assertNotEqual(m["FLASH"]["used"], 0x330)

    def test_ram_span_includes_heap_stack(self):
        """形态②（名独占一行 + 地址在下一行）必须被认出来。

        漏认 `._user_heap_stack` 会把 RAM 从 0x460 算成 0x60 —— 差 1024 B。
        """
        m = self._parse(FIXTURE)
        self.assertEqual(m["RAM"]["used"], 0x460)

    def test_nobits_lma_excluded_from_flash(self):
        """``.bss`` 与 ``._user_heap_stack`` 的 LMA 是名义值，不得计入 Flash。"""
        m = self._parse(FIXTURE)
        # 若把 .bss(0x40) 和 heap_stack(0x400) 的 LMA 也算进 Flash：
        self.assertNotEqual(m["FLASH"]["used"], 0x334 + 0x40 + 0x400)

    def test_data_lma_does_count_in_flash(self):
        """``.data`` 的初值真存在 Flash 里，**必须**计入。"""
        m = self._parse(FIXTURE)
        # 去掉 .data 的 LMA（0x20）→ 跨度会变短
        self.assertGreater(m["FLASH"]["used"], 0x334 - 0x20)

    def test_empty_region_is_omitted(self):
        """没有任何分配的 region 不产出，避免界面出现一个假的 0% 表盘。"""
        m = self._parse(FIXTURE)
        self.assertNotIn("CCM", m)

    def test_default_region_excluded(self):
        """``*default*`` 覆盖全地址空间，若没排除会把所有段都吸进去。"""
        m = self._parse(FIXTURE)
        self.assertNotIn("*default*", m)
        self.assertEqual(set(m), {"FLASH", "RAM"})

    def test_pct(self):
        m = self._parse(FIXTURE)
        self.assertEqual(m["FLASH"]["pct"], round(0x334 * 100 / 0x10000, 2))
        self.assertEqual(m["RAM"]["region"], 0x4000)

    def test_missing_file_returns_empty(self):
        self.assertEqual(parse_map_memory(Path("C:/definitely/not/here.map")), {})

    def test_sections_outside_regions_are_ignored(self):
        """VMA 落在所有 region 之外的段不进任何 region（真实 ``.debug_*`` 就是 VMA 0x0）。"""
        m = self._parse(FIXTURE)          # 夹具里 .debug_info 在 VMA 0x0、大小 0x4b70
        self.assertEqual(m["FLASH"]["used"], 0x334)
        self.assertEqual(m["RAM"]["used"], 0x460)

    def test_non_alloc_section_inside_region_is_excluded(self):
        """★ 即使把调试段的 VMA **塞进 FLASH**，也必须不计入。

        这是刻意的：真实 map 里调试段恰好都在 VMA 0x0，但那是运气不是保证。
        若哪天换了链接脚本把它们挪进 Flash，几十 KB 的调试信息会把 Flash 表盘灌爆，
        而这种错误在界面上看起来"就是用量变大了"，极难归因。故按名字显式排除。
        """
        text = FIXTURE.replace(".debug_info     0x00000000     0x4b70",
                               ".debug_info     0x08000000     0x4b70")
        m = self._parse(text)
        self.assertEqual(m["FLASH"]["used"], 0x334, "调试段被算进 Flash 了")
        self.assertEqual(m["RAM"]["used"], 0x460)

    # ── 真实工程交叉验证（需要先构建过；没有产物就跳过）──────────
    CASES = {
        ".work/at32_test/TEST.map": {"FLASH": 4840, "RAM": 1576},
        ".work/at32f421g8u7/AT32F421G8U7.map": {"FLASH": 11788, "RAM": 2008},
        ".work/stm32_test/TEST.map": {"FLASH": 37780, "RAM": 8712},
    }

    def test_matches_linker_on_real_maps(self):
        """★ 与链接器 ``--print-memory-usage`` 的自报值逐字节比对。

        期望值来自真实的 ``--clean`` 构建输出（B 类 AT32 两个 + A 类 STM32 一个，
        覆盖 cortex-m4/soft-float 与 cortex-m3/无 FPU 两种内核）。
        """
        checked = 0
        for rel, want in self.CASES.items():
            p = ROOT / rel
            if not p.exists():
                continue
            got = parse_map_memory(p)
            for region, used in want.items():
                self.assertIn(region, got, f"{rel} 缺 region {region}")
                self.assertEqual(got[region]["used"], used, f"{rel} {region} 与链接器不一致")
                checked += 1
        if checked == 0:
            self.skipTest("没有已构建的 .map 产物，跳过（先跑 elab build）")
        self.assertEqual(checked, 6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
