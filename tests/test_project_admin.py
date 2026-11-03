"""工程接入层的探针切换：只动 debug.probe，保留注释与其它字段。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from elab import project_admin
from elab.config import Config, ElabError

HOST = """\
version: 1
probes:
  default: atlink
  list:
    atlink: { backend: cmsis-dap, interface_cfg: interface/atlink.cfg, speed: 5000 }
    stlink: { backend: stlink, interface_cfg: interface/stlink.cfg, speed: 4000 }
"""

PROJECT = """\
# projects/demo.yaml —— 由 elab adapt 确定性生成，请勿手改
name: demo
root: C:/work/demo
work_dir: ${ELAB_ROOT}/.work/demo
debug:
  probe: atlink
  gdb_script: ${ELAB_ROOT}/toolchains/gdb/break_main.gdb
guard:
  untouched: true
"""

NO_DEBUG = """\
# projects/demo.yaml —— 由 elab adapt 确定性生成，请勿手改
name: demo
root: C:/work/demo
"""


class ProjectAdminProbeTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "projects").mkdir()
        (self.root / "scripts" / "interface").mkdir(parents=True)
        (self.root / "scripts" / "interface" / "stlink.cfg").write_text("", encoding="utf-8")
        (self.root / "scripts" / "interface" / "atlink.cfg").write_text("", encoding="utf-8")
        (self.root / "elab.host.yaml").write_text(HOST, encoding="utf-8")
        self.write_project(PROJECT)

    def tearDown(self):
        self._tmp.cleanup()

    def write_project(self, text: str):
        (self.root / "projects" / "demo.yaml").write_text(text, encoding="utf-8")

    def cfg(self, *, scripts: bool = False) -> Config:
        if scripts:
            host = HOST + f"tools:\n  openocd:\n    scripts: {self.root.as_posix()}/scripts\n"
            (self.root / "elab.host.yaml").write_text(host, encoding="utf-8")
        return Config(self.root)

    def test_set_probe_keeps_comments_and_other_fields(self):
        res = project_admin.set_probe(self.cfg(), "demo", "stlink")
        text = (self.root / "projects" / "demo.yaml").read_text(encoding="utf-8")
        self.assertEqual(res["probe"], "stlink")
        self.assertIn("probe: stlink", text)
        self.assertNotIn("probe: atlink", text)
        self.assertIn("由 elab adapt 确定性生成", text)
        self.assertIn("gdb_script", text)
        self.assertIn("guard:", text)

    def test_unknown_probe_rejected(self):
        with self.assertRaises(ElabError) as cm:
            project_admin.set_probe(self.cfg(), "demo", "jlink")
        self.assertIn("未知探针", str(cm.exception))

    def test_insert_probe_when_debug_block_missing(self):
        self.write_project(NO_DEBUG)
        project_admin.set_probe(self.cfg(), "demo", "stlink")
        text = (self.root / "projects" / "demo.yaml").read_text(encoding="utf-8")
        self.assertIn("debug:\n  probe: stlink", text)

    def test_missing_interface_cfg_rejected(self):
        missing = self.root / "scripts" / "interface" / "stlink.cfg"
        missing.unlink()
        with self.assertRaises(ElabError) as cm:
            project_admin.set_probe(self.cfg(scripts=True), "demo", "stlink")
        self.assertIn("接口文件不存在", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
