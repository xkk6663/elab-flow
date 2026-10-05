"""serialmon（常驻串口监视会话）的离线单测。

        python -m unittest tests.test_serialmon

★ 全部用假 IO：不碰真串口、不开真线程之外的任何资源。读线程是真线程
  （要测的正是"它能被 stop 及时收摊、异常能自愈成 error"这一件事）。
"""

from __future__ import annotations

import sys
import time
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab import serialmon as sm            # noqa: E402
from elab.config import Config              # noqa: E402


class FakeIO:
    """SerialIO 的假身：测试往 ``rx`` 队列里塞字节，读线程就会收走。"""

    backend = "fake"

    def __init__(self, port: str, baud: int = 115200, *, for_write: bool = False):
        self.port, self.baud, self.for_write = port, baud, for_write
        self.rx: list[bytes] = []
        self.written: list[bytes] = []
        self.opened = False
        self.closed = False
        self.fail_open = False
        self.fail_read = False

    def open(self):
        if self.fail_open:
            raise OSError(f"打开失败（故意的）：{self.port}")
        self.opened = True

    def read(self, n: int = 4096) -> bytes:
        if self.fail_read:
            raise OSError("读失败（故意的：模拟拔线）")
        return self.rx.pop(0) if self.rx else b""

    def write(self, data: bytes) -> int:
        self.written.append(bytes(data))
        return len(data)

    def close(self):
        self.closed = True

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class Base(unittest.TestCase):
    """每个用例：桩掉 sp/st 两个模块引用 + 兜底关闭会话 + 小环形缓冲。"""

    def setUp(self):
        sm.MAX_LINES = 4                      # 小缓冲：让"挤掉旧行"可测
        self.io = FakeIO("COM9", 115200, for_write=True)
        self._orig_sp, self._orig_st = sm.sp, sm.st
        sm.sp = types.SimpleNamespace(SerialIO=lambda p, b, **kw: self.io,
                                      capabilities=lambda: {
                                          "available": True, "layer": "L1",
                                          "hint": ""})
        sm.st = types.SimpleNamespace(
            resolve_target=lambda cfg, name, *, port="", baud=0: {
                "spec": port or "COM9", "port": self._resolved,
                "baud": baud or 115200, "reason": "" if self._resolved else "没选到口",
                "backend": "fake", "ports": []})
        self._resolved = "COM9"
        self.cfg = Config(str(ROOT))

    def tearDown(self):
        sm.close_session(log=lambda *a: None)
        sm.sp, sm.st = self._orig_sp, self._orig_st
        sm.MAX_LINES = 2000

    # ── 小工具 ──────────────────────────────────────────────────
    def open(self, **kw) -> dict:
        return sm.open_session(self.cfg, kw.pop("project", "p1"), **kw)

    def wait_for(self, cond, timeout: float = 3.0, what: str = "条件") -> None:
        t0 = time.time()
        while time.time() - t0 < timeout:
            if cond():
                return
            time.sleep(0.02)
        self.fail(f"等待超时：{what}")


class OpenClose(Base):
    def test_open_reports_session(self):
        r = self.open()
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["port"], "COM9")
        self.assertEqual(r["baud"], 115200)
        self.assertEqual(r["backend"], "fake")
        self.assertTrue(r["active"])

    def test_open_twice_is_refused(self):
        self.assertTrue(self.open()["ok"])
        r = self.open(project="p2")
        self.assertFalse(r["ok"])
        self.assertIn("监视已在进行", r["error"])

    def test_close_is_idempotent(self):
        self.assertTrue(self.open()["ok"])
        r1 = sm.close_session(log=lambda *a: None)
        self.assertTrue(r1["ok"])
        self.assertEqual(r1["closed"]["port"], "COM9")
        r2 = sm.close_session(log=lambda *a: None)
        self.assertTrue(r2["ok"])
        self.assertIn("没有进行中的监视", r2["note"])
        self.assertTrue(self.io.closed)

    def test_close_stops_reader_promptly(self):
        self.assertTrue(self.open()["ok"])
        t0 = time.time()
        sm.close_session(log=lambda *a: None)
        self.assertLess(time.time() - t0, 3.0, "读线程必须在 3s 内收摊")
        self.assertFalse(sm.status()["active"])

    def test_open_without_port_is_refused(self):
        self._resolved = ""
        r = self.open()
        self.assertFalse(r["ok"])
        self.assertFalse(sm.status()["active"])

    def test_open_failure_surfaces_error(self):
        r = self.open()
        self.io.fail_open = True
        # 失败要发生在 open 阶段 → 先关掉刚开的会话再试
        sm.close_session(log=lambda *a: None)
        r2 = sm.open_session(self.cfg, "p1")
        self.assertFalse(r2["ok"])
        self.assertIn("打开失败", r2["error"])
        self.assertEqual(r2["port"], "COM9")

    def test_backend_unavailable_is_refused(self):
        sm.sp.capabilities = lambda: {"available": False, "layer": "L0",
                                      "hint": "没有后端"}
        r = self.open()
        self.assertFalse(r["ok"])
        self.assertIn("串口后端不可用", r["error"])

    def test_status_without_session(self):
        self.assertEqual(sm.status(), {"active": False})
        self.assertEqual(sm.tail(0)["active"], False)


class Stream(Base):
    def test_lines_are_assembled_and_seq_monotonic(self):
        self.assertTrue(self.open()["ok"])
        self.io.rx.append(b"[alive] tick=1\n[ali")
        self.io.rx.append(b"ve] tick=2\n")
        self.wait_for(lambda: sm.tail(0)["seq"] >= 2, what="两行输出")
        lines = sm.tail(0)["lines"]
        self.assertEqual([x["text"] for x in lines],
                         ["[alive] tick=1", "[alive] tick=2"])
        self.assertEqual([x["seq"] for x in lines], [1, 2])

    def test_partial_line_flushed_after_silence(self):
        sm.PARTIAL_FLUSH_S = 0.1
        self.assertTrue(self.open()["ok"])
        self.io.rx.append(b"> ")                 # 提示符：没有换行
        self.wait_for(lambda: sm.tail(0)["seq"] >= 1, what="残留被冲刷成行")
        # 保留提示符原样（只去 \r）："> " 的尾空格是设备打出来的
        self.assertEqual(sm.tail(0)["lines"][0]["text"], "> ")

    def test_tail_after_is_incremental(self):
        self.assertTrue(self.open()["ok"])
        self.io.rx.append(b"a\nb\nc\n")
        self.wait_for(lambda: sm.tail(0)["seq"] >= 3, what="三行输出")
        self.assertEqual([x["text"] for x in sm.tail(2)["lines"]], ["c"])
        self.assertEqual(sm.tail(99)["lines"], [])

    def test_ring_overflow_reports_gap_not_silence(self):
        self.assertTrue(self.open()["ok"])
        self.io.rx.append(b"1\n2\n3\n4\n5\n")    # MAX_LINES=4 → 最旧的 1 被挤掉
        self.wait_for(lambda: sm.tail(0)["seq"] >= 5, what="五行输出")
        t = sm.tail(0)
        self.assertEqual([x["text"] for x in t["lines"]], ["2", "3", "4", "5"])
        self.assertGreaterEqual(t["covered"], 1)
        # 浏览器从 seq=0 开始追 → 它错过了 seq=1，gap 必须说出来
        self.assertGreaterEqual(t["gap"], 1)

    def test_gap_zero_when_caught_up(self):
        self.assertTrue(self.open()["ok"])
        self.io.rx.append(b"a\n")
        self.wait_for(lambda: sm.tail(0)["seq"] >= 1, what="一行输出")
        t = sm.tail(1)
        self.assertEqual(t["lines"], [])
        self.assertEqual(t["gap"], 0)


class WriteThrough(Base):
    def test_write_goes_through_session_port(self):
        self.assertTrue(self.open()["ok"])
        self.assertEqual(sm.write_through(b"help\r\n"), 6)
        self.assertEqual(self.io.written, [b"help\r\n"])

    def test_write_without_session_returns_none(self):
        self.assertIsNone(sm.write_through(b"x"))

    def test_write_after_reader_death_returns_zero(self):
        self.assertTrue(self.open()["ok"])
        self.io.fail_read = True
        self.wait_for(lambda: not sm.status()["active"], what="读线程自愈收摊")
        self.assertEqual(sm.write_through(b"x"), 0)
        self.assertIn("读失败", sm.status()["error"])


if __name__ == "__main__":
    unittest.main()
