"""源码页签 / 寄存器组 / 多会话的内核单测（P3）。

    python -m unittest tests.test_debugp3

无硬件依赖：gdb 用假 MI 记录替身，``DebugManager`` 用假会话替身。
真机验收另见 ``tests/manual`` 与教程 04/05。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "services"))

from elab import debugdata as dd                              # noqa: E402
from elab import debugsource as dsrc                          # noqa: E402
from elab.debugsession import (DebugError, DebugSession,      # noqa: E402
                               register_width, register_writable)
from elab.gdbmi import MiError                                # noqa: E402


# ── 假 gdb ──────────────────────────────────────────────────────
class _FakeGdb:
    """只实现寄存器读写用到的三条 MI 命令。"""

    NAMES = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10",
             "r11", "r12", "sp", "lr", "pc", "xpsr", "faultmask", "s0", "s1"]

    def __init__(self):
        self.values = {n: 0x10 + i for i, n in enumerate(self.NAMES)}
        self.fail_on = ""

    def command(self, cmd: str, timeout: float = 5.0):
        if cmd.startswith("-data-list-register-names"):
            return {"results": {"register-names": self.NAMES}}
        if cmd.startswith("-data-list-register-values"):
            return {"results": {"register-values": [
                {"number": i, "value": hex(self.values[n])}
                for i, n in enumerate(self.NAMES)]}}
        if "set $" in cmd:
            name = cmd.split("set $", 1)[1].split(" ", 1)[0]
            if name == self.fail_on:
                raise MiError("gdb 拒绝")
            word = cmd.rsplit("0x", 1)[1].split('"')[0]
            self.values[name] = int(word, 16)
            return {"results": {}}
        raise AssertionError(f"未预期的 MI 命令：{cmd}")


def _fake_plan(root: str):
    class _P:
        name = "unit-proj"
        source_dir = root
        cfg = object()

        def debug_profile(self):
            return {}
    return _P()


class SourceReadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "Core" / "Src").mkdir(parents=True)
        self.src = self.root / "Core" / "Src" / "main.c"
        self.src.write_text("\n".join(f"line {i}" for i in range(1, 201)) + "\n",
                            encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_relative_and_absolute_both_ok(self):
        out = dsrc.read_lines(str(self.root), "Core/Src/main.c", start=10, count=3)
        self.assertEqual([r["no"] for r in out["lines"]], [10, 11, 12])
        self.assertEqual(out["rel"], "Core/Src/main.c")
        out2 = dsrc.read_lines(str(self.root), str(self.src), start=1, count=1)
        self.assertEqual(out2["lines"][0]["text"], "line 1")

    def test_escape_rejected(self):
        with self.assertRaises(dsrc.SourceError):
            dsrc.read_lines(str(self.root), "../../secret.c")
        with self.assertRaises(dsrc.SourceError):
            dsrc.read_lines(str(self.root), "C:/Windows/win.ini")

    def test_symlink_escape_rejected(self):
        link = self.root / "Core" / "evil.c"
        try:
            link.symlink_to(Path(tempfile.gettempdir()) / "outside.c")
        except (OSError, NotImplementedError):
            self.skipTest("当前环境不允许建符号链接")
        with self.assertRaises(dsrc.SourceError):
            dsrc.resolve_in_sandbox(str(self.root), "Core/evil.c")

    def test_pagination_flags(self):
        out = dsrc.read_lines(str(self.root), "Core/Src/main.c", start=1, count=120)
        self.assertTrue(out["has_more"])
        self.assertFalse(out["truncated"])          # 窗口后还有行 ≠ 文件被截断
        tail = dsrc.read_lines(str(self.root), "Core/Src/main.c", start=190, count=120)
        self.assertFalse(tail["has_more"])

    def test_missing_file_is_unavailable(self):
        with self.assertRaises(dsrc.SourceUnavailable):
            dsrc.read_lines(str(self.root), "Core/Src/nope.c")

    def test_count_is_clamped(self):
        out = dsrc.read_lines(str(self.root), "Core/Src/main.c", start=1, count=9999)
        self.assertLessEqual(len(out["lines"]), dsrc.MAX_LINES)


class BreakpointSpecTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "with space"
        (self.root / "src").mkdir(parents=True)
        self.f = self.root / "src" / "app.c"
        self.f.write_text("int x;\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_quoted_when_space(self):
        spec = dsrc.breakpoint_spec(str(self.root), "src/app.c", 12)
        self.assertTrue(spec["quoted"].startswith('"'))
        self.assertTrue(spec["quoted"].endswith(':12"'))
        self.assertIn("with space", spec["quoted"])
        self.assertEqual(spec["rel"], "src/app.c")

    def test_no_quote_without_space(self):
        plain = Path(self.tmp.name) / "plain"
        (plain / "src").mkdir(parents=True)
        (plain / "src" / "app.c").write_text("int x;\n", encoding="utf-8")
        spec = dsrc.breakpoint_spec(str(plain), "src/app.c", 3)
        self.assertFalse(spec["quoted"].startswith('"'))
        self.assertTrue(spec["quoted"].endswith("app.c:3"))

    def test_bad_line(self):
        with self.assertRaises(dsrc.SourceError):
            dsrc.breakpoint_spec(str(self.root), "src/app.c", 0)
        with self.assertRaises(dsrc.SourceError):
            dsrc.breakpoint_spec(str(self.root), "src/app.c", "abc")


class StackFullnameTest(unittest.TestCase):
    def test_fullname_kept(self):
        payload = {"_pc": "0x8000100", "stack": [{"frame": {
            "level": "0", "addr": "0x08000100", "func": "main",
            "file": "main.c", "fullname": "C:/proj/Core/Src/main.c", "line": "79"}}]}
        frames = dd.stack(payload)
        self.assertEqual(frames[0]["fullname"], "C:/proj/Core/Src/main.c")
        self.assertEqual(frames[0]["line"], 79)

    def test_stop_frame_fullname(self):
        rec = {"results": {"reason": "breakpoint-hit", "frame": {
            "func": "main", "file": "main.c", "fullname": "/a/main.c", "line": "3"}}}
        self.assertEqual(dd.stop_frame(rec)["frame"]["fullname"], "/a/main.c")


class RegisterPolicyTest(unittest.TestCase):
    def test_whitelist(self):
        self.assertTrue(register_writable("s0"))
        self.assertTrue(register_writable("s31"))
        self.assertTrue(register_writable("r12"))
        self.assertTrue(register_writable("sp"))
        self.assertFalse(register_writable("pc"))
        self.assertFalse(register_writable("lr"))
        self.assertFalse(register_writable("xpsr"))
        self.assertFalse(register_writable("d0"))
        self.assertFalse(register_writable("s32"))

    def test_width(self):
        self.assertEqual(register_width("r0"), 32)
        self.assertEqual(register_width("s31"), 32)
        self.assertEqual(register_width("d3"), 64)
        self.assertEqual(register_width("q15"), 128)

    def test_fpu_group_only_for_real_fpu_regs(self):
        """M3 没有 FPU：``faultmask`` 不能把 FPU 页签撑出来。"""
        names = {"register-names": ["r0", "pc", "xpsr", "faultmask"]}
        vals = {"register-values": [{"number": i, "value": "0x0"} for i in range(4)]}
        groups = dd.registers(names, vals, editable_fn=register_writable,
                              width_fn=register_width)
        self.assertEqual([g["name"] for g in groups], ["core"])
        names2 = {"register-names": ["r0", "s0", "d0", "fpscr"]}
        vals2 = {"register-values": [{"number": i, "value": "0x0"} for i in range(4)]}
        groups2 = dd.registers(names2, vals2, editable_fn=register_writable,
                               width_fn=register_width)
        self.assertEqual([g["name"] for g in groups2], ["core", "fpu"])
        wide = {r["name"]: r for g in groups2 for r in g["regs"]}
        self.assertTrue(wide["s0"]["editable"])
        self.assertFalse(wide["d0"]["editable"])
        self.assertEqual(wide["d0"]["width"], 64)


class _StoppedSession(DebugSession):
    """不连 gdb 的会话：只把状态与假 gdb 塞进去。"""

    def __init__(self, root):                       # noqa: D107
        super().__init__(_fake_plan(root), emit=lambda t, d: None)
        self.state = "stopped"
        self.stop = {"frame": {"file": "main.c", "fullname": str(Path(root) / "main.c"),
                               "line": 1}, "pc": "0x8000000"}
        self._gdb = _FakeGdb()

    def _require_stopped(self):                      # 跳过状态机
        return


class BatchWriteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "main.c").write_text("int main(){}\n", encoding="utf-8")
        self.sess = _StoppedSession(str(self.root))

    def tearDown(self):
        self.tmp.cleanup()

    def test_batch_applied_with_before_after(self):
        out = self.sess.write_registers(items=[{"name": "r0", "value": "0xAA"},
                                               {"name": "r1", "value": "0xBB"}])
        self.assertTrue(out["ok"])
        self.assertEqual([a["name"] for a in out["applied"]], ["r0", "r1"])
        self.assertEqual(out["applied"][0]["after"], "0xaa")
        self.assertEqual(self.sess._gdb.values["r0"], 0xAA)

    def test_whole_batch_rejected_when_one_item_bad(self):
        with self.assertRaises(DebugError) as ctx:
            self.sess.write_registers(items=[{"name": "r0", "value": "0x11"},
                                             {"name": "pc", "value": "0x8000000"}])
        self.assertEqual(ctx.exception.code, "debug-write-denied")
        self.assertEqual(self.sess._gdb.values["r0"], 0x10)   # 一条都没写

    def test_readonly_and_wide(self):
        for name, code in (("pc", "debug-write-denied"), ("lr", "debug-write-denied"),
                           ("d0", "debug-write-denied"), ("zz", "debug-bad-request")):
            with self.assertRaises(DebugError) as ctx:
                self.sess.write_registers(items=[{"name": name, "value": "0x1"}])
            self.assertEqual(ctx.exception.code, code, name)

    def test_width_checked(self):
        with self.assertRaises(DebugError) as ctx:
            self.sess.write_registers(items=[{"name": "r0", "value": "0x123456789"}])
        self.assertEqual(ctx.exception.code, "debug-bad-request")

    def test_batch_limit(self):
        with self.assertRaises(DebugError) as ctx:
            self.sess.write_registers(items=[{"name": "r0", "value": "0x1"}] * 17)
        self.assertEqual(ctx.exception.code, "debug-limit")

    def test_partial_failure_reports_applied(self):
        self.sess._gdb.fail_on = "r1"
        out = self.sess.write_registers(items=[{"name": "r0", "value": "0xCC"},
                                               {"name": "r1", "value": "0xDD"}])
        self.assertFalse(out["ok"])
        self.assertEqual([a["name"] for a in out["applied"]], ["r0"])
        self.assertEqual(out["failed"]["name"], "r1")


class SourceEndpointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "main.c").write_text("a\nb\nc\n", encoding="utf-8")
        self.sess = _StoppedSession(str(self.root))

    def tearDown(self):
        self.tmp.cleanup()

    def test_defaults_to_stop_frame(self):
        out = self.sess.source(start=1, count=10)
        self.assertEqual(out["rel"], "main.c")
        self.assertEqual(len(out["lines"]), 3)

    def test_escape_is_bad_request(self):
        with self.assertRaises(DebugError) as ctx:
            self.sess.source(file="../../../etc/passwd")
        self.assertEqual(ctx.exception.code, "debug-bad-request")

    def test_missing_is_source_unavailable(self):
        with self.assertRaises(DebugError) as ctx:
            self.sess.source(file="gone.c")
        self.assertEqual(ctx.exception.code, "debug-source-unavailable")


# ── 多会话：DebugManager（假会话）────────────────────────────────
class _FakeSess:
    _seq = 0

    def __init__(self, plan, *, actor="human", lease_s=0, options=None, open_seq=0,
                 emit=None, log=print):
        _FakeSess._seq += 1
        self.session_id = f"dbg-test{_FakeSess._seq}"
        self.plan = plan
        self.actor = actor
        self.owner = actor
        self.lease_s = lease_s
        self.options = options or {}
        self.state = "stopped"
        self.stop = None
        self.last_active = 0
        self.error = None
        self.resumed_on_close = None
        self._cb = emit
        self.closed = False

    def bind_emit(self, cb):
        self._cb = cb

    def open(self):
        if self.plan.name == "boom":
            raise DebugError("debug-openocd-dead", "openocd 起不来", "检查探针")
        return self.snapshot()

    def snapshot(self):
        return {"id": self.session_id, "project": self.plan.name, "state": self.state,
                "owner": self.owner, "stop": self.stop, "features": ["session"]}

    def close(self, *, resume=True, reason="user-closed"):
        self.state = "closed"
        self.closed = True
        return {"closed": True, "resumed": resume}


class DebugManagerTest(unittest.TestCase):
    def setUp(self):
        import cockpit.server as srv
        self.srv = srv
        self.tmp = tempfile.TemporaryDirectory()
        self._patches = [
            unittest.mock.patch.object(srv, "plan_for",
                                       lambda cfg, name: type("P", (), {
                                           "name": name, "source_dir": "",
                                           "debug_profile": lambda self: {}})()),
            unittest.mock.patch.object(srv.dbgsess_mod, "DebugSession", _FakeSess),
            unittest.mock.patch.object(srv, "_debug_audit", lambda cfg, rec: None),
            unittest.mock.patch.object(srv.DebugManager, "_blocker", lambda self: None),
        ]
        for p in self._patches:
            p.start()
        self.mgr = srv.DebugManager(type("C", (), {"host": {}, "root": Path(self.tmp.name)})(),
                                    runs=type("R", (), {"list_active": lambda self: []})())

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self.tmp.cleanup()

    def test_two_sessions_isolated(self):
        a = self.mgr.open(project="p1")["session_id"]
        b = self.mgr.open(project="p2")["session_id"]
        self.assertNotEqual(a, b)
        self.assertEqual(len(self.mgr.list()), 2)
        self.assertEqual(self.mgr.require(a).plan.name, "p1")
        self.assertEqual(self.mgr.require(b).plan.name, "p2")

    def test_require_without_id_needs_disambiguation(self):
        self.mgr.open(project="p1")
        self.mgr.require()                              # 单会话可不带 id
        self.mgr.open(project="p2")
        with self.assertRaises(DebugError) as ctx:
            self.mgr.require()
        self.assertEqual(ctx.exception.code, "debug-session-required")

    def test_same_project_rejected(self):
        self.mgr.open(project="p1")
        with self.assertRaises(DebugError) as ctx:
            self.mgr.open(project="p1")
        self.assertEqual(ctx.exception.code, "debug-target-busy")

    def test_session_limit(self):
        self.mgr.open(project="p1")
        self.mgr.open(project="p2")
        with self.assertRaises(DebugError) as ctx:
            self.mgr.open(project="p3")
        self.assertEqual(ctx.exception.code, "debug-session-limit")

    def test_events_filtered_by_session(self):
        a = self.mgr.open(project="p1")["session_id"]
        b = self.mgr.open(project="p2")["session_id"]
        qa = self.mgr.subscribe(a)
        qall = self.mgr.subscribe()
        self.mgr._emit_for(b, "debug/stop", {"seq": 1})
        self.assertTrue(qa.empty())                     # A 不串 B 的事件
        self.assertFalse(qall.empty())                  # 全量订阅仍能收到
        env = qall.get_nowait()
        self.assertEqual(env["session"], b)
        self.mgr._emit_for(a, "debug/stop", {"seq": 2})
        self.assertEqual(qa.get_nowait()["session"], a)

    def test_close_only_target(self):
        a = self.mgr.open(project="p1")["session_id"]
        b = self.mgr.open(project="p2")["session_id"]
        self.mgr.close(debug_session=a)
        self.assertEqual([s.session_id for s in self.mgr.list()], [b])
        self.assertEqual(self.mgr.require(b).state, "stopped")

    def test_write_permission_is_per_session(self):
        a = self.mgr.open(project="p1", allow_write=True)["session_id"]
        b = self.mgr.open(project="p2", allow_write=False)["session_id"]
        self.mgr.require_write(confirm=True, debug_session=a)     # 不抛
        with self.assertRaises(DebugError) as ctx:
            self.mgr.require_write(confirm=True, debug_session=b)
        self.assertEqual(ctx.exception.code, "debug-write-denied")

    def test_agent_cannot_write(self):
        a = self.mgr.open(project="p1", actor="agent", allow_write=True)["session_id"]
        with self.assertRaises(DebugError):
            self.mgr.require_write(confirm=True, debug_session=a)

    def test_failed_open_is_cleaned_up(self):
        with self.assertRaises(DebugError):
            self.mgr.open(project="boom")
        self.assertEqual(self.mgr.list(), [])

    def test_snapshot_shape_compat(self):
        snap = self.mgr.snapshot()
        self.assertEqual(snap["sessions"], [])
        self.assertIsNone(snap["session"])
        self.assertEqual(snap["max_sessions"], 2)
        self.mgr.open(project="p1")
        snap = self.mgr.snapshot()
        self.assertEqual(snap["session"]["project"], "p1")   # 旧前端字段仍在
        self.assertEqual(len(snap["sessions"]), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
