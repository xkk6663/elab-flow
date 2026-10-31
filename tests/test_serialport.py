"""serialport 的 URL 端口支持（``loop://``）。

为什么单独测这一条：``SerialIO`` 的生产路径是 COM 口，但 **URL 端口**
（``loop://`` / ``socket://`` …）只能走 ``serial_for_url``，``Serial()`` 不认。
没有这条分支，无硬件时的端到端自测（TX 入环 → RX 投影 → 解码）就跑不起来。
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))

from elab import serialport as sp              # noqa: E402

_PS, _LP = sp._pyserial()


@unittest.skipUnless(_PS is not None, "需要 pyserial（URL 端口只有它支持）")
class LoopUrl(unittest.TestCase):
    def test_loop_url_is_writable_and_echoes(self):
        io = sp.SerialIO("loop://", 115200, for_write=True)
        try:
            io.open()
            self.assertEqual(io.backend, "pyserial")
            n = io.write(b"loop-check")
            self.assertEqual(n, 10)
            got = b""
            deadline = time.time() + 2.0
            while time.time() < deadline and len(got) < 10:
                got += io.read(64)
            self.assertEqual(got, b"loop-check")
        finally:
            io.close()

    def test_write_after_close_returns_zero(self):
        """契约：写失败返回 0，**不抛** —— HTTP 层据此如实回 ok:false。"""
        io = sp.SerialIO("loop://", 115200, for_write=True)
        io.open()
        io.close()
        self.assertEqual(io.write(b"x"), 0)


if __name__ == "__main__":
    unittest.main()
