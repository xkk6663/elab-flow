"""M1 线参数 / 传输解析 / DTR-RTS 预设校验的单元测试。

不碰真串口：端口枚举与选择都被打桩。真机验收仍是「7E1 能开能收发、
会话快照显示 7E1」——单测只保证解析与映射不漂移。
"""

from __future__ import annotations

import ctypes
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))

from elab import serialcontrol as sc           # noqa: E402
from elab import serialport as sp             # noqa: E402
from elab import serialtransport as tp         # noqa: E402


class LineConfigParsing(unittest.TestCase):
    def test_default_is_8n1(self):
        cfg, errs = sp.line_config(None)
        self.assertEqual((cfg.data_bits, cfg.parity, cfg.stop_bits, cfg.flow),
                         (8, "none", 1.0, "none"))
        self.assertEqual(cfg.text, "8N1")
        self.assertEqual(errs, [])

    def test_text_forms(self):
        cases = {"8N1": (8, "none", 1.0), "7E1": (7, "even", 1.0),
                 "8O2": (8, "odd", 2.0), "8M1": (8, "mark", 1.0),
                 "8S1": (8, "space", 1.0), "5N1.5": (5, "none", 1.5),
                 "7e1:rtscts": (7, "even", 1.0)}
        for text, want in cases.items():
            cfg, errs = sp.line_config(text)
            self.assertEqual(errs, [], text)
            self.assertEqual((cfg.data_bits, cfg.parity, cfg.stop_bits),
                             want, text)
        self.assertEqual(sp.line_config("7e1:rtscts")[0].flow, "rtscts")

    def test_dict_forms_and_aliases(self):
        cfg, errs = sp.line_config({"data": 7, "parity": "E", "stop": "2"})
        self.assertEqual(errs, [])
        self.assertEqual((cfg.data_bits, cfg.parity, cfg.stop_bits), (7, "even", 2.0))
        cfg, errs = sp.line_config({"bytesize": 8, "stopbits": 1.5})
        self.assertIn("stop_bits=1.5 只能配 data_bits=5", errs[0])

    def test_errors_are_reported_not_silently_fixed(self):
        _, errs = sp.line_config("9N1")
        self.assertTrue(any("无法解析" in e for e in errs))
        _, errs = sp.line_config({"data_bits": 9, "parity": "x",
                                  "stop_bits": 3, "flow": "hw"})
        self.assertEqual(len([e for e in errs if "非法" in e]), 4)
        _, errs = sp.line_config({"data_bits": 8, "parity": "none",
                                  "stop_bits": 1, "foo": 1})
        self.assertTrue(any("未知线参数字段" in e for e in errs))

    def test_dict_and_obj_roundtrip(self):
        """`Target.line.as_dict()` / `LineConfig` 都必须能再喂回 `line_config`。

        ★ 重连就是靠这一步把线参数原样传回去的；不接受会导致"每次重连都失败"。
        """
        base = sp.LineConfig(7, "even", 1.0, "rtscts")
        cfg, errs = sp.line_config(base)
        self.assertEqual(errs, [])
        self.assertEqual((cfg.data_bits, cfg.parity, cfg.flow),
                         (7, "even", "rtscts"))
        cfg2, errs2 = sp.line_config(base.as_dict())
        self.assertEqual(errs2, [], "as_dict 里的 text 是派生字段，不该算未知字段")
        self.assertEqual(cfg2.text, "7E1")

    def test_pyserial_kwargs_mapping(self):
        cfg = sp.LineConfig(7, "even", 1.0, "rtscts")
        kw = cfg.pyserial_kwargs()
        self.assertEqual(kw["bytesize"], 7)
        self.assertEqual(kw["parity"], "E")
        self.assertEqual(kw["stopbits"], 1.0)
        self.assertTrue(kw["rtscts"])
        self.assertFalse(kw["xonxoff"])

    def test_dcb_tokens(self):
        self.assertEqual(sp.LineConfig(7, "even", 1.0).dcb_tokens(115200),
                         "baud=115200 parity=E data=7 stop=1")


@unittest.skipUnless(sys.platform.startswith("win"), "DCB 位域只在 Win32")
class DcbFlags(unittest.TestCase):
    def _flags(self, buf) -> int:
        return ctypes.c_uint32.from_buffer(buf, 8).value

    def test_rtscts_sets_flow_and_rts_handshake(self):
        buf = ctypes.create_string_buffer(28)
        sp._apply_dcb_flags(buf, sp.LineConfig(flow="rtscts"))
        v = self._flags(buf)
        self.assertTrue(v & sp._F_OUTXCTSFLOW)
        self.assertEqual((v & sp._F_RTSCONTROL_MASK)
                         >> 12, sp._F_RTSCONTROL_HANDSHAKE >> 12)

    def test_xonxoff_sets_in_and_out(self):
        buf = ctypes.create_string_buffer(28)
        sp._apply_dcb_flags(buf, sp.LineConfig(flow="xonxoff"))
        v = self._flags(buf)
        self.assertTrue(v & sp._F_OUTX)
        self.assertTrue(v & sp._F_INX)
        self.assertFalse(v & sp._F_OUTXCTSFLOW)

    def test_parity_enables_checking(self):
        buf = ctypes.create_string_buffer(28)
        sp._apply_dcb_flags(buf, sp.LineConfig(parity="even"))
        self.assertTrue(self._flags(buf) & sp._F_PARITY)

    def test_default_leaves_flow_bits_clear(self):
        buf = ctypes.create_string_buffer(28)
        sp._apply_dcb_flags(buf, sp.LineConfig())
        v = self._flags(buf)
        for bit in (sp._F_OUTXCTSFLOW, sp._F_OUTXDSRFLOW,
                    sp._F_OUTX, sp._F_INX, sp._F_PARITY):
            self.assertFalse(v & bit)


class TransportLost(unittest.TestCase):
    def test_is_oserror_with_code(self):
        self.assertTrue(issubclass(sp.TransportLost, OSError))
        exc = sp.TransportLost("gone", code=1167, backend="ctypes")
        self.assertEqual(exc.code, 1167)
        self.assertEqual(exc.backend, "ctypes")


class _StubCfg:
    """只实现 resolve 用到的两个面：host 与 resolved_project。"""

    host = {"serial": {"default": "auto", "baud": 115200}}

    def __init__(self, project: dict | None = None):
        self._project = project or {}

    def resolved_project(self, name):
        return self._project


class TargetResolution(unittest.TestCase):
    def setUp(self):
        self._patches = [
            mock.patch.object(sp, "list_ports",
                              return_value=([sp.Port("COM9", "", "usb")], "pyserial")),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def test_default_zero_regression(self):
        t = tp.resolve(_StubCfg(), "p")
        self.assertEqual((t.kind, t.label, t.baud), ("serial", "COM9", 115200))
        self.assertEqual(t.line.text, "8N1")
        self.assertEqual(t.errors, ())

    def test_project_line_is_used(self):
        t = tp.resolve(_StubCfg({"serial": {"line": {"data_bits": 7,
                                                   "parity": "even"}}}), "p")
        self.assertEqual(t.line.text, "7E1")

    def test_explicit_line_wins(self):
        t = tp.resolve(_StubCfg({"serial": {"line": "7E1"}}), "p", line="8N2")
        self.assertEqual(t.line.text, "8N2")

    def test_explicit_port_and_baud_win(self):
        t = tp.resolve(_StubCfg({"serial": {"port": "COM3", "baud": 9600}}),
                       "p", port="COM9", baud=921600, line="8E1")
        self.assertEqual((t.label, t.baud, t.line.text),
                         ("COM9", 921600, "8E1"))

    def test_invalid_line_blocks_open(self):
        t = tp.resolve(_StubCfg({"serial": {"line": "9N1"}}), "p")
        self.assertTrue(t.errors)
        with self.assertRaises(OSError):
            tp.open(t)

    def test_network_kinds_resolve_to_label(self):
        """M4：网络传输不再是"尚未实现"，解析出可开户的 label 与 net 配置。"""
        t = tp.resolve(_StubCfg(), "p", transport="tcp-client",
                       net={"host": "127.0.0.1", "port": 9000})
        self.assertEqual(t.errors, ())
        self.assertEqual(t.kind, "tcp-client")
        self.assertEqual(t.label, "tcp://127.0.0.1:9000")
        self.assertEqual(t.backend, "net/tcp-client")
        self.assertEqual(t.net["port"], 9000)

    def test_network_remote_requires_allow_remote(self):
        t = tp.resolve(_StubCfg(), "p", transport="tcp-server",
                       net={"bind": "0.0.0.0", "port": 9000})
        self.assertTrue(any("allow_remote" in e for e in t.errors))
        with self.assertRaises(OSError):
            tp.open(t)

    def test_unknown_transport_is_reported(self):
        t = tp.resolve(_StubCfg(), "p", transport="ble")
        self.assertTrue(any("未知传输" in e for e in t.errors))

    def test_auto_ambiguity_selects_nothing(self):
        with mock.patch.object(sp, "list_ports", return_value=(
                [sp.Port("COM4", "", "usb"), sp.Port("COM7", "", "usb")],
                "pyserial")):
            t = tp.resolve(_StubCfg(), "p")
        self.assertEqual(t.label, "")
        self.assertTrue(t.reason)


class PresetValidation(unittest.TestCase):
    def test_valid_preset(self):
        items, errs = sc._norm_presets([{
            "id": "classic", "label": "进下载",
            "steps": [{"dtr": False, "rts": True, "hold_ms": 100},
                      {"dtr": True, "rts": False}]}])
        self.assertEqual(errs, [])
        self.assertEqual(items[0]["name"], "classic")
        self.assertEqual(items[0]["steps"][0]["hold_ms"], 100)
        self.assertEqual(items[0]["steps"][1]["hold_ms"], sc._DEFAULT_HOLD_MS)

    def test_total_duration_limit(self):
        _, errs = sc._norm_presets([{
            "id": "slow",
            "steps": [{"dtr": True, "hold_ms": sc.MAX_HOLD_MS}] * 5}])
        self.assertTrue(any("总时长" in e for e in errs))

    def test_bad_entries_are_skipped_with_errors(self):
        items, errs = sc._norm_presets([
            {"name": "", "steps": [{"dtr": True}]},
            {"name": "empty", "steps": []},
            {"name": "badbool", "steps": [{"dtr": "yes"}]},
            {"name": "longhold", "steps": [{"rts": True, "hold_ms": 9999}]},
            {"name": "noline", "steps": [{"hold_ms": 10}]},
        ])
        self.assertEqual(items, [])
        self.assertEqual(len(errs), 5)

    def test_too_many_steps_rejected(self):
        _, errs = sc._norm_presets([{"name": "n",
                                     "steps": [{"dtr": True}] * (sc.MAX_STEPS + 1)}])
        self.assertTrue(any("超过" in e for e in errs))

    def test_unknown_shape(self):
        items, errs = sc._norm_presets({"name": "x"})
        self.assertEqual(items, [])
        self.assertTrue(errs)


if __name__ == "__main__":
    unittest.main()
