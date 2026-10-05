"""M3-b 串口写通道的守卫用例（离线，不碰真串口）。

覆盖两件**容易在改动中被悄悄破坏**的事：
  1. 载荷组装：空输入不能变成 `b"\\r\\n"` 被发出去；hex 模式不能多带 CR。
  2. 错误信息**对症**：端口不存在（errno=2）不能被说成"被 openocd 占用"（errno=5）。
     —— 指错方向的提示比不提示更坏（用户会去拔插、杀进程）。
另加：只读实例拒绝写、锁忙时如实报错、往返结果组装。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
for p in (str(ROOT), str(ROOT / "services")):
    if p not in sys.path:
        sys.path.insert(0, p)

from elab import serialport as sp              # noqa: E402
from elab import serialterm as st              # noqa: E402
from cockpit import server as srv              # noqa: E402


class FakeCfg:
    """最小 Config 替身：只需要 host / resolved_project 两个接口。"""

    def __init__(self, port: str = "auto", baud: int = 115200):
        self.host = {"serial": {"default": port, "baud": baud}}
        self._port = port
        self._baud = baud

    def resolved_project(self, name: str) -> dict:
        return {"serial": {"port": self._port, "baud": self._baud}}


class FakeSerial:
    """假串口：记录写出的字节、按脚本吐回显。"""

    def __init__(self, port, baud=115200, *, for_write=False):
        self.port, self.baud, self.for_write = port, baud, for_write
        self.backend = "fake"
        self.sent = b""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def write(self, data: bytes) -> int:
        self.sent += data
        return len(data)

    def read(self, n: int = 4096) -> bytes:
        return b""


def _opts(**kw):
    """组装 roundtrip 的 patch 环境（默认：后端可用、显式选到 COM9）。"""
    base = {
        "capabilities": {"layer": "L1", "available": True},
        "list_ports": ([], "fake"),
        "select_port": ("COM9", "显式指定 COM9", []),
    }
    base.update(kw)
    return base


class TestBuildPayload(unittest.TestCase):
    def test_text_gets_crlf(self):
        p, err = st.build_payload("help")
        self.assertEqual(err, "")
        self.assertEqual(p, b"help\r\n")

    def test_newline_off(self):
        p, err = st.build_payload("help", newline=False)
        self.assertEqual((p, err), (b"help", ""))

    def test_hex_has_no_crlf(self):
        p, err = st.build_payload("01 A0 FF", hex_=True)
        self.assertEqual(err, "")
        self.assertEqual(p, b"\x01\xa0\xff")

    def test_hex_without_spaces(self):
        p, _ = st.build_payload("01a0ff", hex_=True)
        self.assertEqual(p, b"\x01\xa0\xff")

    def test_hex_bad(self):
        p, err = st.build_payload("zz", hex_=True)
        self.assertEqual(p, b"")
        self.assertIn("十六进制", err)

    def test_empty_rejected(self):
        # ★ 回归：`""` 曾被加成 `b"\r\n"` 发出去 —— 一个空回车照样能打断
        #   固件的行解析器，所以判空必须在**加行结束符之前**。
        for bad in ("", "   ", "\t\n"):
            p, err = st.build_payload(bad)
            self.assertEqual(p, b"", f"{bad!r} 不该编出载荷")
            self.assertIn("为空", err)

    def test_utf8_text(self):
        p, _ = st.build_payload("你好", newline=False)
        self.assertEqual(p, "你好".encode("utf-8"))


class TestOpenErrorMessage(unittest.TestCase):
    """★ 错误提示必须**对症** —— 这是实测抓到的缺陷。"""

    def test_file_not_found_says_missing(self):
        msg = sp._open_error("COM99", 2)
        self.assertIn("ERROR_FILE_NOT_FOUND", msg)
        self.assertIn("不存在", msg)
        # 绝不能把"端口不存在"说成"被占用"
        self.assertNotIn("ERROR_ACCESS_DENIED", msg)

    def test_access_denied_talks_about_n5(self):
        msg = sp._open_error("COM10", 5)
        self.assertIn("ERROR_ACCESS_DENIED", msg)
        self.assertIn("N5", msg)

    def test_other_errno_is_plain(self):
        msg = sp._open_error("COM10", 87)
        self.assertIn("GetLastError=87", msg)
        self.assertNotIn("N5", msg)


class TestSerialIOWriteGuard(unittest.TestCase):
    def test_readonly_refuses_write(self):
        """只读打开时必须**拒绝**写 —— 否则 pyserial 后端会真的把数据发出去。"""
        s = sp.SerialIO("COM1", 115200)
        with self.assertRaises(OSError) as cm:
            s.write(b"x")
        self.assertIn("只读", str(cm.exception))

    def test_write_when_for_write_defaults_ok_shape(self):
        """for_write=True 但未 open：write() 返回 0（不抛）—— 调用方据此判失败。"""
        s = sp.SerialIO("COM1", 115200, for_write=True)
        self.assertEqual(s.write(b"x"), 0)

    def test_empty_write_is_noop(self):
        s = sp.SerialIO("COM1", 115200, for_write=True)
        self.assertEqual(s.write(b""), 0)


class TestRoundtrip(unittest.TestCase):
    def test_success_assembles_result(self):
        fake = FakeSerial("COM9", for_write=True)
        with mock.patch.object(st.sp, "capabilities", **_pv(_opts()["capabilities"])), \
             mock.patch.object(st.sp, "list_ports", return_value=([], "fake")), \
             mock.patch.object(st.sp, "select_port", return_value=("COM9", "x", [])), \
             mock.patch.object(st.sp, "SerialIO", return_value=fake):
            r = st.roundtrip(FakeCfg(), "", data="ping", read_ms=30,
                             log=lambda *a: None)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["written"], 6)          # "ping\r\n"
        self.assertEqual(r["port"], "COM9")
        self.assertEqual(r["baud"], 115200)
        self.assertIsNone(r["error"])
        self.assertEqual(r["echoed"], [])

    def test_echoed_lines_from_fake(self):
        class Echo(FakeSerial):
            def read(self, n=4096):
                if not hasattr(self, "_done"):
                    self._done = True
                    return b"[dev] ok\r\n[dev] bye\r\n"
                return b""

        with mock.patch.object(st.sp, "capabilities", **_pv(_opts()["capabilities"])), \
             mock.patch.object(st.sp, "list_ports", return_value=([], "fake")), \
             mock.patch.object(st.sp, "select_port", return_value=("COM9", "x", [])), \
             mock.patch.object(st.sp, "SerialIO", return_value=Echo("COM9", for_write=True)):
            r = st.roundtrip(FakeCfg(), "", data="hi", read_ms=60,
                             log=lambda *a: None)
        self.assertTrue(r["ok"])
        self.assertEqual(r["echoed"], ["[dev] ok", "[dev] bye"])

    def test_partial_write_is_failure(self):
        class Half(FakeSerial):
            def write(self, data):
                self.sent += data[:1]
                return 1

        with mock.patch.object(st.sp, "capabilities", **_pv(_opts()["capabilities"])), \
             mock.patch.object(st.sp, "list_ports", return_value=([], "fake")), \
             mock.patch.object(st.sp, "select_port", return_value=("COM9", "x", [])), \
             mock.patch.object(st.sp, "SerialIO", return_value=Half("COM9", for_write=True)):
            r = st.roundtrip(FakeCfg(), "", data="abcd", read_ms=20,
                             log=lambda *a: None)
        self.assertFalse(r["ok"])
        self.assertIn("只写出 1/6", r["error"])

    def test_backend_unavailable(self):
        with mock.patch.object(st.sp, "capabilities",
                               return_value={"layer": "L2", "available": False,
                                             "hint": "装 pyserial"}):
            r = st.roundtrip(FakeCfg(), "", data="hi", read_ms=20, log=lambda *a: None)
        self.assertFalse(r["ok"])
        self.assertIn("不可用", r["error"])

    def test_no_port_selected(self):
        with mock.patch.object(st.sp, "capabilities", **_pv(_opts()["capabilities"])), \
             mock.patch.object(st.sp, "list_ports", return_value=([], "fake")), \
             mock.patch.object(st.sp, "select_port",
                               return_value=("", "auto 有歧义：2 个候选", [])):
            r = st.roundtrip(FakeCfg(), "", data="hi", read_ms=20, log=lambda *a: None)
        self.assertFalse(r["ok"])
        self.assertIn("歧义", r["error"])

    def test_open_failure_is_reported(self):
        def boom(*a, **kw):
            raise OSError("CreateFileW 失败，GetLastError=5")

        with mock.patch.object(st.sp, "capabilities", **_pv(_opts()["capabilities"])), \
             mock.patch.object(st.sp, "list_ports", return_value=([], "fake")), \
             mock.patch.object(st.sp, "select_port", return_value=("COM9", "x", [])), \
             mock.patch.object(st.sp, "SerialIO", side_effect=boom):
            r = st.roundtrip(FakeCfg(), "", data="hi", read_ms=20, log=lambda *a: None)
        self.assertFalse(r["ok"])
        self.assertIn("GetLastError=5", r["error"])

    def test_empty_data_short_circuits(self):
        """空输入在**碰串口之前**就该失败（不该为了报错去开一次口）。"""
        with mock.patch.object(st.sp, "SerialIO") as mk:
            r = st.roundtrip(FakeCfg(), "", data="  ", read_ms=20, log=lambda *a: None)
        self.assertFalse(r["ok"])
        self.assertIn("为空", r["error"])
        mk.assert_not_called()

    def test_lock_busy_is_reported(self):
        """锁被占时**如实报错**，而不是排队装作没事（用户会以为操作被吞了）。"""
        self.assertTrue(st._LOCK.acquire(blocking=False))
        try:
            with mock.patch.object(st, "_LOCK_WAIT_S", 0.01), \
                 mock.patch.object(st.sp, "capabilities", **_pv(_opts()["capabilities"])), \
                 mock.patch.object(st.sp, "list_ports", return_value=([], "fake")), \
                 mock.patch.object(st.sp, "select_port", return_value=("COM9", "x", [])):
                r = st.roundtrip(FakeCfg(), "", data="hi", read_ms=20, log=lambda *a: None)
        finally:
            st._LOCK.release()
        self.assertFalse(r["ok"])
        self.assertIn("另一个串口操作", r["error"])

    def test_read_ms_is_clamped(self):
        # ★ 必须把 `_drain` 换掉：夹取后的窗口若是 10000ms，真跑会空转 10 秒。
        #   夹取逻辑在 roundtrip 开头，与 drain 无关 —— 替换它不影响本用例要验的事。
        with mock.patch.object(st, "_drain", return_value=([], 0, b"")), \
             mock.patch.object(st.sp, "capabilities", **_pv(_opts()["capabilities"])), \
             mock.patch.object(st.sp, "list_ports", return_value=([], "fake")), \
             mock.patch.object(st.sp, "select_port", return_value=("COM9", "x", [])), \
             mock.patch.object(st.sp, "SerialIO", return_value=FakeSerial("COM9", for_write=True)):
            r = st.roundtrip(FakeCfg(), "", data="hi", read_ms=999999, log=lambda *a: None)
        self.assertEqual(r["read_ms"], 10000)
        with mock.patch.object(st, "_drain", return_value=([], 0, b"")), \
             mock.patch.object(st.sp, "capabilities", **_pv(_opts()["capabilities"])), \
             mock.patch.object(st.sp, "list_ports", return_value=([], "fake")), \
             mock.patch.object(st.sp, "select_port", return_value=("COM9", "x", [])), \
             mock.patch.object(st.sp, "SerialIO", return_value=FakeSerial("COM9", for_write=True)):
            r2 = st.roundtrip(FakeCfg(), "", data="hi", read_ms="junk", log=lambda *a: None)
        self.assertEqual(r2["read_ms"], st.DEFAULT_READ_MS)

    def test_eol_field(self):
        with mock.patch.object(st.sp, "capabilities", **_pv(_opts()["capabilities"])), \
             mock.patch.object(st.sp, "list_ports", return_value=([], "fake")), \
             mock.patch.object(st.sp, "select_port", return_value=("COM9", "x", [])), \
             mock.patch.object(st.sp, "SerialIO", return_value=FakeSerial("COM9", for_write=True)):
            r = st.roundtrip(FakeCfg(), "", data="hi", log=lambda *a: None)
            h = st.roundtrip(FakeCfg(), "", data="01", hex_=True, log=lambda *a: None)
        self.assertEqual(r["eol"], "\r\n")
        self.assertEqual(h["eol"], "")


class TestRender(unittest.TestCase):
    def test_render_failure(self):
        out = st.render({"ok": False, "error": "boom", "port": "", "backend": ""})
        self.assertIn("boom", out)

    def test_render_success_lists_echo(self):
        out = st.render({"ok": True, "written": 4, "port": "COM1", "baud": 9600,
                         "backend": "ctypes", "echoed": ["a", "b"], "bytes_read": 4,
                         "read_ms": 100})
        self.assertIn("已发送 4 B", out)
        self.assertIn("← a", out)
        self.assertIn("← b", out)

    def test_render_success_without_echo(self):
        out = st.render({"ok": True, "written": 4, "port": "COM1", "baud": 9600,
                         "backend": "ctypes", "echoed": [], "bytes_read": 0,
                         "read_ms": 600})
        self.assertIn("没有回显", out)


class TestSerialBlocker(unittest.TestCase):
    """`_serial_blocker`：会用到串口的闭环在跑时，手写通道必须让路。"""

    class FakeMgr:
        def __init__(self, active):
            self._a = active

        def list_active(self):
            return self._a

    def test_monitor_run_blocks(self):
        m = self.FakeMgr([{"run": "r1", "alive": True, "steps": ["build", "monitor"]}])
        b = srv._serial_blocker(m)
        self.assertIsNotNone(b)
        self.assertEqual(b["run"], "r1")

    def test_build_only_does_not_block(self):
        """只跑 build 的 run 不碰串口 → 不该拦（否则手写通道白废）。"""
        m = self.FakeMgr([{"run": "r1", "alive": True, "steps": ["doctor", "build"]}])
        self.assertIsNone(srv._serial_blocker(m))

    def test_dead_run_does_not_block(self):
        m = self.FakeMgr([{"run": "r1", "alive": False, "steps": ["monitor"]}])
        self.assertIsNone(srv._serial_blocker(m))

    def test_flash_and_debug_block(self):
        for step in ("flash", "debug_verify"):
            m = self.FakeMgr([{"run": "r1", "alive": True, "steps": [step]}])
            self.assertIsNotNone(srv._serial_blocker(m), step)


def _pv(caps: dict) -> dict:
    """mock.patch.object 的 kwargs 形式：`**_pv(caps)` == `return_value=caps`。"""
    return {"return_value": caps}


if __name__ == "__main__":
    unittest.main(verbosity=2)
