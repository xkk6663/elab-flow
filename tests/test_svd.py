"""CMSIS-SVD 解析（elab.svd）离线单测。

    python -m unittest tests.test_svd

覆盖：外设/寄存器/字段解析、derivedFrom 继承、三级懒加载树、
读值 + 枚举解码、路径错误。全部用合成 XML，不依赖任何芯片包。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab import svd                                        # noqa: E402

SVD_XML = """\
<?xml version="1.0" encoding="utf-8"?>
<device>
  <name>TESTCHIP</name>
  <peripherals>
    <peripheral>
      <name>GPIOA</name>
      <groupName>GPIO</groupName>
      <baseAddress>0x40010800</baseAddress>
      <description>General purpose IO</description>
      <registers>
        <register>
          <name>ODR</name>
          <addressOffset>0x0C</addressOffset>
          <size>32</size>
          <access>read-write</access>
          <resetValue>0x00000000</resetValue>
          <fields>
            <field>
              <name>ODR0</name>
              <bitOffset>0</bitOffset>
              <bitWidth>1</bitWidth>
              <description>Output data bit 0</description>
              <enumeratedValues>
                <enumeratedValue><name>LOW</name><value>0</value></enumeratedValue>
                <enumeratedValue><name>HIGH</name><value>1</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field>
              <name>ODR4</name>
              <bitOffset>4</bitOffset>
              <bitWidth>2</bitWidth>
            </field>
          </fields>
        </register>
        <register>
          <name>IDR</name>
          <addressOffset>0x08</addressOffset>
          <size>32</size>
          <access>read-only</access>
        </register>
      </registers>
    </peripheral>
    <peripheral derivedFrom="GPIOA">
      <name>GPIOB</name>
      <baseAddress>0x40010C00</baseAddress>
    </peripheral>
  </peripherals>
</device>
"""


class SvdParseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        p = Path(self.tmp.name) / "TESTCHIP.svd"
        p.write_text(SVD_XML, encoding="utf-8")
        self.model = svd.load(str(p))

    def tearDown(self):
        self.tmp.cleanup()

    def test_device_and_derived(self):
        self.assertEqual(self.model["name"], "TESTCHIP")
        self.assertEqual([p["name"] for p in self.model["peripherals"]],
                         ["GPIOA", "GPIOB"])
        gpiob = self.model["by_name"]["GPIOB"]
        self.assertEqual([r["name"] for r in gpiob["registers"]], ["IDR", "ODR"])

    def test_tree_levels(self):
        top = svd.tree(self.model)
        self.assertEqual(top["level"], "device")
        self.assertEqual(top["peripherals"][0]["registers_count"], 2)

        periph = svd.tree(self.model, "GPIOA")
        self.assertEqual(periph["level"], "peripheral")
        self.assertEqual([r["name"] for r in periph["peripheral"]["registers"]],
                         ["IDR", "ODR"])

    def test_register_read_and_decode(self):
        def read_bytes(addr, size):
            self.assertEqual(addr, 0x40010800 + 0x0C)
            self.assertEqual(size, 4)
            return (0x13).to_bytes(4, "little")

        out = svd.tree(self.model, "GPIOA.ODR", read_bytes=read_bytes)
        reg = out["register"]
        self.assertEqual(reg["value"], "0x13")
        fields = {f["name"]: f for f in reg["fields"]}
        self.assertEqual(fields["ODR0"]["value"], 1)
        self.assertEqual(fields["ODR0"]["enum"]["name"], "HIGH")
        self.assertEqual(fields["ODR4"]["value"], 1)

    def test_bad_path(self):
        with self.assertRaises(KeyError):
            svd.tree(self.model, "NOPE")
        with self.assertRaises(KeyError):
            svd.tree(self.model, "GPIOA.NOPE")


if __name__ == "__main__":
    unittest.main()
