"""L0 主机视图的环境变量覆盖（DSH 插件「一键环境包」走的就是这条缝）。

        python -m unittest tests.test_host_env

覆盖：默认取 elab.host.yaml / 五个 ELAB_* 变量逐个覆盖 / 空值不覆盖 /
GCC 根被覆盖后 bin 与 PATH 前缀随之派生。

注：Host 的属性是**惰性求值**的，所以断言必须留在 mock 上下文内。
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab.config import Config, Host                          # noqa: E402

HOST_YAML = """\
version: 1
toolchains:
  arm-none-eabi:
    root: C:/yaml/gcc
    version: "13.3.1"
    prepend_path: true
tools:
  cmake:
    path: auto
  ninja:
    path: C:/yaml/ninja.exe
  openocd:
    path: C:/yaml/openocd.exe
    scripts: C:/yaml/scripts
"""

OVERRIDES = {
    "ELAB_ARM_GCC_ROOT": "D:/env/gcc",
    "ELAB_CMAKE": "D:/env/cmake/bin/cmake.exe",
    "ELAB_NINJA": "D:/env/ninja/ninja.exe",
    "ELAB_OPENOCD": "D:/env/openocd/bin/openocd.exe",
    "ELAB_OPENOCD_SCRIPTS": "D:/env/openocd/scripts",
}

UNSET = {name: "" for name in OVERRIDES}


class HostEnvOverrideTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        (self.tmp / "elab.host.yaml").write_text(HOST_YAML, encoding="utf-8")
        self.cfg = Config(root=self.tmp)

    def tearDown(self):
        self._tmp.cleanup()

    def test_默认取_yaml(self):
        with mock.patch.dict(os.environ, UNSET):
            h = Host(self.cfg)
            self.assertEqual(h.cmake, "auto")
            self.assertEqual(h.ninja, "C:/yaml/ninja.exe")
            self.assertEqual(h.openocd, "C:/yaml/openocd.exe")
            self.assertEqual(h.openocd_scripts, "C:/yaml/scripts")
            self.assertEqual(h.gcc_root, "C:/yaml/gcc")
            self.assertEqual(h.gcc_bin, "C:/yaml/gcc/bin")
            self.assertEqual(h.cc, "C:/yaml/gcc/bin/arm-none-eabi-gcc" + h.exec_ext)

    def test_五个变量全部覆盖(self):
        with mock.patch.dict(os.environ, OVERRIDES):
            h = Host(self.cfg)
            self.assertEqual(h.gcc_root, "D:/env/gcc")
            self.assertEqual(h.gcc_bin, "D:/env/gcc/bin")
            self.assertEqual(h.cmake, "D:/env/cmake/bin/cmake.exe")
            self.assertEqual(h.ninja, "D:/env/ninja/ninja.exe")
            self.assertEqual(h.openocd, "D:/env/openocd/bin/openocd.exe")
            self.assertEqual(h.openocd_scripts, "D:/env/openocd/scripts")

    def test_空值不覆盖(self):
        with mock.patch.dict(os.environ, {"ELAB_NINJA": "", "ELAB_OPENOCD": "   "}):
            h = Host(self.cfg)
            # 空白也当成"未设置"，回退 yaml —— 不把空路径传给 doctor
            self.assertEqual(h.ninja, "C:/yaml/ninja.exe")
            self.assertEqual(h.openocd, "C:/yaml/openocd.exe")

    def test_build_env_带出覆盖后的_gcc_根与_PATH(self):
        with mock.patch.dict(os.environ, OVERRIDES):
            h = Host(self.cfg)
            env = h.build_env()
            self.assertEqual(env["ELAB_ARM_GCC_ROOT"], "D:/env/gcc")
            self.assertEqual(env["PATH"].split(os.pathsep)[0],
                             os.path.normpath("D:/env/gcc/bin"))


if __name__ == "__main__":
    unittest.main()
