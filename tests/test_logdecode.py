"""M6：日志 profile 数据驱动解析 + addr2line 符号化（无硬件）。

判据（方案 §4.4）：
· 内核只认数据键：同一份解析器吃 ESP-IDF profile 能出 reset/panic/回溯；
· 回溯地址能合并进同一条 panic（不产生重复 issue）；
· addr2line 失败/ROM 地址如实标注，绝不编造函数名；
· 会话层：panic + 回溯行入 issue 环，且 after_reset 正确。
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, "services")

from elab import logdecode as ld  # noqa: E402
from elab import serialmon as sm  # noqa: E402
from elab import serialport as sp  # noqa: E402

ESP_PROFILE = {
    "id": "esp-idf",
    "label": "ESP-IDF",
    "panic_lines": ["Guru Meditation Error", "panic: ", "assert failed"],
    "reset_lines": ["ESP-ROM:", "^rst:0x"],
    "core_pattern": r"Core\s*(\d+)",
    "reason_pattern": r"Guru Meditation Error:\s*([^\r\n]+)",
    "backtrace_line": r"Backtrace:\s*(.*)",
    "addr_pattern": r"0x[0-9a-fA-F]{8}",
    "rom_prefixes": ["0x400"],
    "symbolize": {"tool_key": "addr2line_esp32", "args": ["-pfiaC"]},
}


class FakeCfg:
    host = {"tools": {"addr2line_esp32": {"path": "fake-addr2line"}}}

    def __init__(self, elf: str):
        self.elf = elf

    def resolved_project(self, _name):
        return {"artifacts": {"elf": self.elf}}


class Parse(unittest.TestCase):
    def test_reset_then_panic_with_backtrace(self):
        p = ld.normalize_profile(ESP_PROFILE)
        reset = ld.parse_line("rst:0x1 (POWERON_RESET)", p)
        self.assertEqual(reset["kind"], "reset")
        panic = ld.parse_line(
            "Guru Meditation Error: Core  0 panic'ed (LoadProhibited).", p,
            after_reset=True)
        self.assertEqual(panic["kind"], "panic")
        self.assertEqual(panic["core"], "0")
        self.assertTrue(panic["after_reset"])
        bt = ld.parse_line("Backtrace: 0x400d1234 0x42001234", p)
        self.assertEqual(bt["kind"], "backtrace")
        self.assertEqual(bt["addrs"], ["0x400d1234", "0x42001234"])

    def test_unrelated_line_is_none(self):
        p = ld.normalize_profile(ESP_PROFILE)
        self.assertIsNone(ld.parse_line("I (1234) app_main: hello", p))

    def test_profile_validation_rejects_bad_regex(self):
        bad = dict(ESP_PROFILE, panic_lines=["("])
        with self.assertRaises(ValueError):
            ld.load_profiles(_FakeProjectCfg(bad), "p1")

    def test_addr2line_output_parser(self):
        out = ("0x400d1234\n"
               "app_main at /project/main/app.c:42\n"
               "0x42001234\n"
               "vTaskDelay at /idf/freertos.c:101\n")
        parsed = ld._parse_addr2line(out)
        self.assertEqual(parsed["0x400d1234"]["func"], "app_main")
        self.assertEqual(parsed["0x400d1234"]["line"], 42)
        self.assertEqual(parsed["0x42001234"]["func"], "vTaskDelay")


class _FakeProjectCfg:
    host = {}

    def __init__(self, profile):
        self.profile = profile

    def resolved_project(self, _name):
        return {"pack": "", "serial": {"log_profiles": [self.profile]}}


class Symbolize(unittest.TestCase):
    def setUp(self):
        ld._SYM_CACHE.clear()
        self.tmp = tempfile.NamedTemporaryFile(suffix=".elf", delete=False)
        self.tmp.write(b"\x7fELF")
        self.tmp.close()

    def tearDown(self):
        Path(self.tmp.name).unlink(missing_ok=True)

    def test_symbolize_calls_tool_and_caches(self):
        calls = []

        def fake_run(argv, **kw):
            calls.append(argv)
            return SimpleNamespace(returncode=0, stderr="", stdout=(
                "0x42001234\napp_main at /p/main.c:42\n"))

        old = ld.subprocess.run
        ld.subprocess.run = fake_run
        try:
            cfg = FakeCfg(self.tmp.name)
            res = ld.symbolize(cfg, "p1", ["0x42001234"],
                               ld.normalize_profile(ESP_PROFILE))
            self.assertTrue(res["ok"], res)
            self.assertEqual(res["symbols"][0]["func"], "app_main")
            self.assertEqual(len(calls), 1)
            # 第二次命中缓存，不再调外部工具
            res2 = ld.symbolize(cfg, "p1", ["0x42001234"],
                                ld.normalize_profile(ESP_PROFILE))
            self.assertEqual(res2["symbols"][0]["func"], "app_main")
            self.assertEqual(len(calls), 1)
        finally:
            ld.subprocess.run = old

    def test_unresolvable_address_note_is_not_faked(self):
        """解不出来才解释：ROM 前缀只作为"可能原因"，不预判也不编造函数名。

        ★ 不能按 0x400 前缀**预先**拦掉：ESP32-S31（RISC-V）的 IRAM 就在 0x4000xxxx，
          板上真实函数会因此永远符号化不出来（实机事故 2026-11-04）。
        """
        calls = []

        def fake_run(argv, **kw):
            calls.append(argv)
            return SimpleNamespace(returncode=0, stderr="", stdout="")

        old = ld.subprocess.run
        ld.subprocess.run = fake_run
        try:
            cfg = FakeCfg(self.tmp.name)
            res = ld.symbolize(cfg, "p1", ["0x40001234"],
                               ld.normalize_profile(ESP_PROFILE))
            self.assertEqual(res["symbols"][0]["func"], None)
            self.assertIn("ROM", res["symbols"][0]["note"])
            self.assertEqual(len(calls), 1, "地址应交由 addr2line 判定，而不是前缀预判")
        finally:
            ld.subprocess.run = old

    def test_addr2line_wins_over_rom_prefix(self):
        """addr2line 能解 → 0x400 前缀不得覆盖真实结果（ESP32-S31 IRAM）。"""
        calls = []

        def fake_run(argv, **kw):
            calls.append(argv)
            return SimpleNamespace(returncode=0, stderr="",
                                   stdout="0x0000000040001234\napp_main at /src/main.c:42\n")

        old = ld.subprocess.run
        ld.subprocess.run = fake_run
        try:
            cfg = FakeCfg(self.tmp.name)
            res = ld.symbolize(cfg, "p1", ["0x40001234"],
                               ld.normalize_profile(ESP_PROFILE))
            sym = res["symbols"][0]
            self.assertEqual(sym["func"], "app_main")
            self.assertEqual(sym["line"], 42)
            self.assertNotIn("note", sym)
        finally:
            ld.subprocess.run = old

    def test_addr2line_pretty_single_line_form(self):
        """`-pfiaC`（不带 -a）的输出是 `0xADDR: func at file:line` 单行形态。"""
        calls = []

        def fake_run(argv, **kw):
            calls.append(argv)
            return SimpleNamespace(
                returncode=0, stderr="",
                stdout=("0x4000d066: app_main at /src/heartbeat_main.c:89\n"
                        "0x42001234: ?? ??:0\n"))

        old = ld.subprocess.run
        ld.subprocess.run = fake_run
        try:
            cfg = FakeCfg(self.tmp.name)
            res = ld.symbolize(cfg, "p1", ["0x4000d066", "0x42001234"],
                               ld.normalize_profile(ESP_PROFILE))
            first, second = res["symbols"]
            self.assertEqual(first["func"], "app_main")
            self.assertEqual(first["line"], 89)
            self.assertIn("heartbeat_main.c", first["file"])
            self.assertIsNone(second["func"])
            self.assertTrue(second.get("note"))
        finally:
            ld.subprocess.run = old

    def test_missing_elf_is_reported(self):
        cfg = FakeCfg(str(Path(self.tmp.name) / "nope.elf"))
        res = ld.symbolize(cfg, "p1", ["0x42001234"])
        self.assertFalse(res["ok"])
        self.assertIn("先 build", res["error"])


class FakeIO:
    backend = "fake"

    def __init__(self, lines: bytes):
        self.lines = lines
        self._fed = False

    def open(self):
        pass

    def read(self, n=4096):
        if self.lines and not self._fed:
            self._fed = True
            out, self.lines = self.lines, b""
            return out
        time.sleep(0.01)
        return b""

    def write(self, data):
        return len(data)

    def close(self):
        pass


class SessionIssues(unittest.TestCase):
    def test_panic_and_backtrace_become_issues(self):
        lines = (b"rst:0x1 (POWERON_RESET)\n"
                 b"Guru Meditation Error: Core  0 panic'ed (LoadProhibited).\n"
                 b"Backtrace: 0x400d1234 0x42001234\n")
        s = sm._Session("p1", "COM9", 115200, FakeIO(lines),
                        epoch=1, line=sp.LineConfig(), port_spec="COM9",
                        reconnect={"enabled": False})
        s.log_profile = ld.normalize_profile(ESP_PROFILE)
        s.log_profile_id = "esp-idf"
        try:
            s.start()
            end = time.time() + 2
            while time.time() < end and s.issue_seq < 2:
                time.sleep(0.02)
            self.assertEqual(s.issue_seq, 2)
            reset, panic = list(s.issues)
            self.assertEqual(reset["kind"], "reset")
            self.assertEqual(panic["kind"], "panic")
            self.assertEqual(panic["backtrace"], ["0x400d1234", "0x42001234"])
            self.assertTrue(panic["after_reset"])
            out = s.tail_issues(0)
            self.assertEqual(len(out["issues"]), 2)
        finally:
            s.shutdown()


if __name__ == "__main__":
    unittest.main()
