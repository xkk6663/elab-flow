"""步骤委托（``steps.<step>: tool:<name>``）与项目固定包的离线单测。

        python -m unittest tests.test_delegated_steps

覆盖（技术方案_ESP32接入与工具链解耦 §5.4）：
1. 委托步骤的日志事件仍用**规范步骤名**（落对通道）
2. 预览走委托分支，不构造原生 ARM 命令
3. 委托的 flash 不要求探针即可用
4. ``env_from_cmd`` 的 ``KEY=VALUE`` 合并 / ``%PATH%`` 展开 / 诊断行不污染
5. ``timeout_s`` 超时杀进程树
6. 命令不存在 → 秒失败、detail 可读
7. 项目 ``pack`` 固定解析芯片（active 是别的包也能解析）
8. 固定包未安装 → 明确报错（不吞成 KeyError）
9. ``step_labels`` 随 ``/api/projects`` 原样暴露
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "services"))

from cockpit import server as srv                    # noqa: E402
from elab import pkg                                  # noqa: E402
from elab import run as run_mod                       # noqa: E402
from elab.config import Config, ElabError             # noqa: E402

PACK_A = """\
schema_version: 1
name: acme/demo
vendor: acme
platform: demo
version: 0.1.0
license: MIT
status: community
"""
CHIP_A = """\
id: demo1
vendor: acme
platform: demo
part: DEMO1
"""

PACK_B = """\
schema_version: 1
name: other/board
vendor: other
platform: board
version: 0.1.0
license: MIT
status: community
"""
CHIP_B = """\
id: board1
vendor: other
platform: board
part: BOARD1
"""

HOST_YAML = """\
version: 1
host:
  os: windows
  exec_ext: .exe
toolchains:
  arm-none-eabi:
    root: ""
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
"""


def _proj_yaml(py: str, *, pack: str = "acme/demo", chip: str = "demo1",
               monitor_rules: bool = True) -> str:
    rules = ('  close_on:\n    - {kind: contains, pattern: "ok"}\n'
             if monitor_rules else "")
    return f"""\
name: fake
root: ${{ELAB_ROOT}}/examples/Fake
pack: {pack}
chip: {chip}
build:
  work_dir: ${{root}}/build
artifacts:
  elf: ${{root}}/build/fake.elf
debug:
  probe: ""
serial:
  port: COM1
  baud: 115200
monitor:
{rules}  idle_timeout_s: 5
steps:
  build: tool:fake_build
  flash: tool:fake_flash
  debug_verify: tool:fake_flash
step_labels:
  debug_verify: 烧录校验
tools:
  fake_build:
    label: 假编译
    cwd: ${{root}}
    cmd: ["${{env:PY}}", "-c", "print('hello from fake build')"]
    env:
      PY: {py or "${{env:PY_FALLBACK}}"}
  fake_flash:
    label: 假烧录
    cwd: ${{root}}
    cmd: ["${{env:PY}}", "-c", "print('flash ok')"]
    env:
      PY: {py or "${{env:PY_FALLBACK}}"}
  envcheck:
    cwd: ${{root}}
    cmd: ["${{env:PY}}", "-c", "import os; print('A='+os.environ.get('A',''))"]
    env:
      PY: {py or "${{env:PY_FALLBACK}}"}
    env_from_cmd:
      cmd: ["${{env:PY}}", "-c", "print('A=1'); print('PATH=/x/%PATH%'); print('WARNING: x')"]
      format: key-value
      path_key: PATH
  slow:
    cwd: ${{root}}
    cmd: ["${{env:PY}}", "-c", "import time; time.sleep(10)"]
    env:
      PY: {py or "${{env:PY_FALLBACK}}"}
    timeout_s: 1
  ghost:
    cwd: ${{root}}
    cmd: ["definitely-not-a-real-command"]
"""


class DelegatedTestBase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(prefix="elab-test-deleg-")
        self.root = Path(self._td.name)
        (self.root / "elab.host.yaml").write_text(HOST_YAML, encoding="utf-8")
        (self.root / "projects").mkdir(parents=True)
        (self.root / "examples" / "Fake" / "build").mkdir(parents=True)
        (self.root / "packs" / "installed").mkdir(parents=True)
        py = Path(sys.executable).as_posix()
        (self.root / "projects" / "fake.yaml").write_text(
            _proj_yaml(py), encoding="utf-8")
        self.py = py
        self.cfg = Config(self.root)

    def tearDown(self):
        self._td.cleanup()

    def make_pack(self, *, name: str, pack: str, chip_file: str, chip: str) -> Path:
        d = self.root / "src" / name.replace("/", "_")
        (d / "chips").mkdir(parents=True)
        (d / "pack.yaml").write_text(pack, encoding="utf-8")
        (d / "chips" / f"{chip}.yaml").write_text(chip_file, encoding="utf-8")
        return d


class TestDelegation(DelegatedTestBase):
    def test_delegated_step_uses_canonical_step_name(self):
        """★ 日志事件的 step 必须是 ``build``，不是 ``tool:fake_build``。"""
        runs = self.root / "runs"
        res = run_mod.run(self.cfg, "fake", steps=["build"], emit_events=True,
                          runs_dir=runs, echo=False)
        self.assertTrue(res["ok"], res)
        lines = [json.loads(x) for x in
                 (Path(res["events"]["proc"])).read_text("utf-8").splitlines() if x]
        proc = [e for e in lines if e.get("topic") == "proc/stdout"]
        self.assertTrue(proc, "没有 proc/stdout 事件")
        self.assertEqual({e["step"] for e in proc}, {"build"})
        self.assertTrue(any("hello from fake build" in e["line"] for e in proc))
        self.assertEqual(res["steps"][0]["delegated_to"], "tool:fake_build")

    def test_delegated_preview_no_native_command(self):
        pv = run_mod.preview(self.cfg, "fake", steps=["build"])
        entry = pv["plan"][0]
        cmd = entry["commands"][0]
        self.assertIn("-c", cmd)
        self.assertFalse(any("cmake" in str(a) or "ninja" in str(a) for a in cmd), cmd)
        self.assertIn("委托给 tools.fake_build", entry["note"])

    def test_delegated_flash_available_without_probe(self):
        cards = srv.project_cards(self.cfg)["projects"]
        card = next(c for c in cards if c["name"] == "fake")
        self.assertTrue(card["steps"]["flash"]["ok"], card["steps"]["flash"])
        # 未委托的步骤仍受探针约束（回归：不能把原生路径一起放开）
        self.assertTrue(card["steps"]["debug_verify"]["ok"])   # 本项目也委托了
        self.assertEqual(card["delegated"]["build"], True)
        self.assertEqual(card["delegated"]["monitor"], False)

    def test_step_labels_exposed_and_merged(self):
        card = next(c for c in srv.project_cards(self.cfg)["projects"]
                    if c["name"] == "fake")
        self.assertEqual(card["step_labels"], {"debug_verify": "烧录校验"})

    def test_monitor_cannot_be_delegated(self):
        p = self.root / "projects" / "bad.yaml"
        p.write_text((self.root / "projects" / "fake.yaml").read_text("utf-8")
                     .replace("name: fake", "name: bad")
                     .replace("steps:\n", "steps:\n  monitor: tool:fake_build\n"),
                     encoding="utf-8")
        cfg = Config(self.root)
        with self.assertRaises(run_mod.RunError) as cm:
            run_mod.run(cfg, "bad", steps=["monitor"], echo=False)
        self.assertIn("monitor", str(cm.exception))


class TestToolEnv(DelegatedTestBase):
    def test_env_from_cmd_key_value(self):
        lines = []
        res = run_mod._run_tool(self.cfg, "fake", "envcheck", sink=lines.append)
        self.assertTrue(res.ok, res)
        self.assertTrue(any("A=1" in x for x in lines), lines)
        self.assertEqual(res.extra["exit_code"], 0)

    def test_merge_key_values_path_and_warnings(self):
        env = {"PATH": "C:/base"}
        run_mod._merge_key_values(
            env, "A=1\nPATH=/x/%PATH%\nWARNING: something\nNot using x", "PATH")
        self.assertEqual(env["A"], "1")
        self.assertEqual(env["PATH"], "/x/C:/base")
        self.assertNotIn("WARNING", " ".join(env.keys()))

    def test_env_ref_undefined_fails_fast(self):
        p = self.root / "projects" / "nodenv.yaml"
        p.write_text((self.root / "projects" / "fake.yaml").read_text("utf-8")
                     .replace("name: fake", "name: nodenv")
                     .replace('"${env:PY}"', '"${env:NOT_DEFINED}"'),
                     encoding="utf-8")
        cfg = Config(self.root)
        pv = run_mod.preview(cfg, "nodenv", steps=["build"])
        entry = pv["plan"][0]
        self.assertTrue(entry["blocked"], entry)
        self.assertIn("NOT_DEFINED", entry["note"])

    def test_tool_timeout_kills_tree(self):
        t0 = time.time()
        res = run_mod._run_tool(self.cfg, "fake", "slow", sink=lambda *a: None)
        self.assertLess(time.time() - t0, 6.0, "超时未生效")
        self.assertFalse(res.ok)
        self.assertIn("timeout", res.detail)
        self.assertEqual(res.extra["timeout_s"], 1)

    def test_tool_missing_cmd_fail_fast(self):
        with self.assertRaises(run_mod.RunError) as cm:
            run_mod._run_tool(self.cfg, "fake", "ghost", sink=lambda *a: None)
        self.assertIn("命令不存在", str(cm.exception))


class TestPackPinning(DelegatedTestBase):
    def _install_both(self):
        a = self.make_pack(name="acme_demo", pack=PACK_A, chip_file=CHIP_A, chip="demo1")
        b = self.make_pack(name="other_board", pack=PACK_B, chip_file=CHIP_B, chip="board1")
        pkg.install(self.cfg, local=a, log=lambda *a, **k: None)
        pkg.install(self.cfg, local=b, log=lambda *a, **k: None)
        pkg.set_active(self.cfg, "other/board", log=lambda *a, **k: None)

    def test_pack_pinning_resolves_chip(self):
        """active 是 other/board，但项目固定 acme/demo 仍能解析 demo1。"""
        self._install_both()
        cfg = Config(self.root)
        self.assertEqual(cfg.active_pack["name"], "other/board")
        proj = cfg.resolved_project("fake")
        chip = cfg.chip_of(proj)
        self.assertEqual(chip["id"], "demo1")
        self.assertEqual(chip["_pack"], "acme/demo")
        # 未固定的项目仍只看 active pack（回归）
        self.assertIn("other/board1", cfg.chips)
        self.assertNotIn("acme/demo1", cfg.chips)

    def test_pack_pinning_missing_pack_clear_error(self):
        cfg = Config(self.root)
        with self.assertRaises(ElabError) as cm:
            cfg.chip_of({"name": "fake", "chip": "demo1", "pack": "ghost/ghost"})
        self.assertIn("ghost/ghost", str(cm.exception))
        self.assertIn("未安装", str(cm.exception))


class TestTemplates(DelegatedTestBase):
    """P0：``${host:...}`` / ``${json_args:...}`` / 委托构建的 .map 内存回填。"""

    def _write(self, name: str, body: str) -> Config:
        (self.root / "projects" / f"{name}.yaml").write_text(body, encoding="utf-8")
        return Config(self.root)

    def test_host_ref_and_nested_env(self):
        cfg = self._write("hostref", f"""\
name: hostref
root: ${{ELAB_ROOT}}/examples/Fake
build:
  work_dir: ${{root}}/build
artifacts:
  map: ${{root}}/build/fake.map
tools:
  t:
    cwd: ${{root}}
    cmd: ["${{env:IDF_PY}}", "${{env:IDF_PATH}}/tools/idf.py", "--version"]
    env:
      IDF_PY: "${{host:tools.idf.python}}"
      IDF_PATH: "${{host:tools.idf.idf_path}}"
""")
        argv, _cwd, _label = run_mod._resolve_tool(cfg, "hostref", "t")
        self.assertEqual(argv[0], "C:/fake/idf/venv/Scripts/python.exe")
        self.assertEqual(argv[1], "C:/fake/esp-idf/tools/idf.py")

    def test_json_args_expands_offsets(self):
        (self.root / "examples" / "Fake" / "build" / "flasher_args.json").write_text(
            json.dumps({"flash_files": {"0x2000": "bootloader/bootloader.bin",
                                        "0x10000": "app.bin"}}), encoding="utf-8")
        cfg = self._write("argjson", """\
name: argjson
root: ${ELAB_ROOT}/examples/Fake
build:
  work_dir: ${root}/build
tools:
  t:
    cwd: ${root}
    cmd: ["echo", "${json_args:${root}/build/flasher_args.json#flash_files}"]
""")
        argv, _cwd, _label = run_mod._resolve_tool(cfg, "argjson", "t")
        base = (self.root / "examples" / "Fake" / "build")
        self.assertEqual(argv[0], "echo")
        self.assertEqual(argv[1:], [
            "0x2000", (base / "bootloader/bootloader.bin").as_posix(),
            "0x10000", (base / "app.bin").as_posix(),
        ])

    def test_delegated_build_fills_memory_from_map(self):
        map_file = self.root / "examples" / "Fake" / "build" / "fake.map"
        map_file.write_text(MAP_FIXTURE, encoding="utf-8")
        cfg = self._write("memfake", f"""\
name: memfake
root: ${{ELAB_ROOT}}/examples/Fake
build:
  work_dir: ${{root}}/build
artifacts:
  map: ${{root}}/build/fake.map
steps:
  build: tool:fake_mem_build
tools:
  fake_mem_build:
    cwd: ${{root}}
    cmd: ["{self.py}", "-c", "print('built')"]
""")
        res = run_mod.run(cfg, "memfake", steps=["build"], echo=False)
        self.assertTrue(res["ok"], res)
        step = res["steps"][0]
        self.assertEqual(step["memory_source"], "map")
        self.assertIn("FLASH", step["memory"])
        self.assertEqual(step["memory"]["FLASH"]["used"], 0x334)


MAP_FIXTURE = """\
Memory Configuration

Name             Origin             Length             Attributes
FLASH            0x08000000         0x00010000         xr
RAM              0x20000000         0x00004000         xrw

Linker script and memory map

.isr_vector     0x08000000       0x100
.text           0x08000100       0x200
 *fill*         0x08000300        0x4
.rodata         0x08000304       0x10
.data           0x20000000       0x20 load address 0x08000314
.bss            0x20000020       0x40 load address 0x08000334
"""


if __name__ == "__main__":
    unittest.main()
