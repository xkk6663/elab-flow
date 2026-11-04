"""M2 串口二期：掉线重连 / 让位回归 / 速率统计（无硬件，假 IO）。

判据（方案 §4.3 / §4.6）：
· 掉线后默认自动重连，200ms→5s 退避，epoch 与行序号**不变**；
· 重连关闭时如实收摊（state=closed + error），不假装还在；
· 闭环让位 → suspend 保留环与 epoch，restore 用同一 target 重开；
· 速率/帧率/缓冲占用由服务端算，窗口不足 1s 标 warmup。
"""

from __future__ import annotations

import sys
import time
import unittest

sys.path.insert(0, "services")

from elab import serialmon as sm  # noqa: E402
from elab import serialport as sp  # noqa: E402


class FakeIO:
    """可编排的假串口：前 N 次 read 抛 TransportLost，之后返回给定数据。"""

    backend = "fake"

    def __init__(self, *, lost_first: int = 0, lines: bytes = b"",
                 serial_fail: bool = False):
        self.lost_first = lost_first
        self.lines = lines
        self.serial_fail = serial_fail
        self.opened = False
        self.closed = False
        self.written: list[bytes] = []
        self._fed = False

    def open(self):
        if self.serial_fail:
            raise OSError("access denied")
        self.opened = True

    def read(self, n=4096):
        if self.lost_first > 0:
            self.lost_first -= 1
            raise sp.TransportLost("device removed", code=1167)
        if self.lines and not self._fed:
            self._fed = True
            out, self.lines = self.lines, b""
            return out
        time.sleep(0.01)
        return b""

    def write(self, data: bytes) -> int:
        self.written.append(bytes(data))
        return len(data)

    def close(self):
        self.closed = True


def _wait(pred, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _make(*, io=None, opener=None, reconnect=None, epoch=1):
    return sm._Session("demo", "COM9", 115200, io or FakeIO(),
                       epoch=epoch, line=sp.LineConfig(),
                       port_spec="COM9", reconnect=reconnect, opener=opener)


class Reconnect(unittest.TestCase):
    def test_auto_reconnect_keeps_epoch_and_seq(self):
        io2 = FakeIO(lines=b"one\ntwo\n")
        first = FakeIO(lost_first=1)
        s = _make(io=first,
                  reconnect={"enabled": True, "min_ms": 50, "max_ms": 100},
                  opener=lambda: (io2, None))
        try:
            s.start()
            self.assertTrue(_wait(lambda: s.reconnects == 1 and s.state == "live"))
            self.assertTrue(_wait(lambda: s.seq >= 2))
            self.assertEqual(s.epoch, 1)          # 重连不换纪元
            self.assertEqual((s.conn, s.reconnects), (2, 1))
            self.assertEqual(s.port, "COM9")
            snap = sm._snapshot(s)
            self.assertEqual(snap["state"], "live")
            self.assertIs(snap["active"], True)
            self.assertGreater(snap["stats"]["rx_bps"], 0)
        finally:
            s.shutdown()

    def test_reconnect_disabled_closes_honestly(self):
        s = _make(io=FakeIO(lost_first=1), reconnect={"enabled": False})
        s.start()
        self.assertTrue(_wait(lambda: s.state == "closed"))
        self.assertIn("TransportLost", (s.error or ""))
        self.assertEqual((s.conn, s.reconnects), (1, 0))
        s.shutdown()

    def test_reconnect_gives_up_after_max_attempts(self):
        s = _make(io=FakeIO(lost_first=1),
                  reconnect={"enabled": True, "min_ms": 50, "max_ms": 60,
                             "max_attempts": 2},
                  opener=lambda: (FakeIO(serial_fail=True), None))
        s.start()
        self.assertTrue(_wait(lambda: s.state == "closed", timeout=3.0))
        self.assertIn("重连失败", (s.error or ""))
        s.shutdown()

    def test_suspend_restore_preserves_ring_and_epoch(self):
        s = _make(io=FakeIO(lines=b"alpha\nbeta\n"),
                  opener=lambda: (FakeIO(lines=b"gamma\n"), None))
        s.start()
        self.assertTrue(_wait(lambda: s.seq >= 2))
        epoch, seq = s.epoch, s.seq
        out = s.suspend("run 需要串口", by_run=True)
        self.assertTrue(out["ok"])
        self.assertEqual(s.state, "suspended")
        self.assertEqual((s.epoch, s.seq), (epoch, seq))   # 让位不清环/不换纪元
        self.assertTrue(s.suspended_by_run)
        self.assertEqual(s.write(b"x"), 0)                 # 让位期间不可写
        out = s.restore()
        self.assertTrue(out["ok"], out)
        self.assertEqual(s.epoch, epoch)
        self.assertEqual(s.conn, 2)
        self.assertEqual(s.state, "live")
        self.assertTrue(_wait(lambda: s.seq >= 3))
        s.shutdown()

    def test_stats_buffer_and_frame_rate(self):
        s = _make(io=FakeIO(lines=b"hello\n"))
        s.start()
        self.assertTrue(_wait(lambda: s.seq >= 1))
        st = sm._snapshot(s)["stats"]
        self.assertEqual(st["rx_bytes_total"], 6)          # "hello\n"
        self.assertEqual(st["tx_bytes_total"], 0)
        self.assertTrue(st["warmup"])                      # 刚开会话 <1s
        self.assertEqual(st["buffer"]["lines"], round(1 / sm.MAX_LINES, 3))
        self.assertIsNone(st["frames_per_s"])              # 未开解码
        s.write(b"ping")
        st = sm._snapshot(s)["stats"]
        self.assertEqual(st["tx_bytes_total"], 4)
        self.assertGreater(st["tx_bps"], 0)
        s.shutdown()

    def test_limits_exposed(self):
        lim = sm.limits()
        self.assertEqual(lim["max_lines"], sm.MAX_LINES)
        self.assertEqual(lim["rate_window_s"], sm.RATE_WINDOW_S)


if __name__ == "__main__":
    unittest.main()
