"""serialmon（常驻串口监视会话）的离线单测。

        python -m unittest tests.test_serialmon

★ 全部用假 IO：不碰真串口、不开真线程之外的任何资源。读线程是真线程
  （要测的正是"它能被 stop 及时收摊、异常能自愈成 error"这一件事）。
"""

from __future__ import annotations

import base64
import json
import struct
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab import serialmon as sm            # noqa: E402
from elab import serialcodec as codec       # noqa: E402
from elab import serialframes as sf         # noqa: E402
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
        sm.MAX_CHUNKS = 4                     # 字节环的批次上限也要可测
        sm.MAX_BYTES = 1 << 20
        sm.PARTIAL_FLUSH_S = 1.0
        self.io = FakeIO("COM9", 115200, for_write=True)
        from elab import serialport as real_sp
        self._orig_sp, self._orig_tp = sm.sp, sm.tp
        sm.sp = types.SimpleNamespace(SerialIO=lambda p, b, **kw: self.io,
                                      LineConfig=real_sp.LineConfig,
                                      capabilities=lambda: {
                                          "available": True, "layer": "L1",
                                          "hint": ""})
        sm.tp = types.SimpleNamespace(
            resolve=lambda cfg, name, *, port="", baud=0, line=None,
            transport="", net=None: types.SimpleNamespace(
                kind="serial", label=self._resolved,
                port_spec=port or "COM9", baud=baud or 115200,
                line=real_sp.LineConfig(), net={},
                reason="" if self._resolved else "没选到口",
                errors=(), ports=(), backend="fake"),
            open=lambda t, for_write=False: self.io)
        self._resolved = "COM9"
        self.cfg = Config(str(ROOT))

    def tearDown(self):
        sm.close_session(log=lambda *a: None)
        sm.sp, sm.tp = self._orig_sp, self._orig_tp
        sm.MAX_LINES = 2000
        sm.MAX_CHUNKS = 4096
        sm.MAX_BYTES = 1 << 20
        sm.PARTIAL_FLUSH_S = 1.0

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

    def test_open_same_target_adopts_session(self):
        """★ 回归：闭环自动回归后（同工程/同口）再点「打开监视」必须接上，
        而不是报「监视已在进行」把人挡在门外（此前导致"串口怎么都打不开"）。"""
        first = self.open()
        self.assertTrue(first["ok"], first)
        again = self.open()
        self.assertTrue(again["ok"], again)
        self.assertTrue(again.get("adopted"))
        self.assertEqual(again["epoch"], first["epoch"], "复用不得 bump 纪元")
        self.assertEqual(again["port"], "COM9")

    def test_open_other_port_still_refused(self):
        self.assertTrue(self.open()["ok"])
        self._resolved = "COM10"
        r = self.open()
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
        # M2：默认会自动重连；这里显式关掉，验证"关重连时如实收摊"的旧行为。
        self.assertTrue(self.open(reconnect={"enabled": False})["ok"])
        self.io.fail_read = True
        self.wait_for(lambda: not sm.status()["active"], what="读线程自愈收摊")
        self.assertEqual(sm.write_through(b"x"), 0)
        self.assertIn("读失败", sm.status()["error"])


class BytePlane(Base):
    """P1：字节为真值 —— RX/TX 同构入环、纪元、覆盖计数。"""

    def chunks(self, after: int = 0, **kw) -> list[dict]:
        return sm.tail_bytes(after, **kw)["chunks"]

    def test_rx_bytes_are_recorded_with_direction(self):
        self.assertTrue(self.open()["ok"])
        self.io.rx.append(b"hello\n")
        self.wait_for(lambda: sm.tail_bytes(0)["chunk_seq"] >= 1, what="RX 批次")
        c = self.chunks()[0]
        self.assertEqual(c["dir"], "rx")
        self.assertEqual(base64.b64decode(c["data_b64"]), b"hello\n")
        self.assertEqual(c["len"], 6)

    def test_tx_bytes_enter_the_same_plane(self):
        self.assertTrue(self.open()["ok"])
        self.assertEqual(sm.write_through(b"help\r\n"), 6)
        c = self.chunks()[0]
        self.assertEqual(c["dir"], "tx")
        self.assertEqual(base64.b64decode(c["data_b64"]), b"help\r\n")

    def test_direction_filter(self):
        self.assertTrue(self.open()["ok"])
        self.io.rx.append(b"in\n")
        self.wait_for(lambda: sm.tail_bytes(0)["chunk_seq"] >= 1, what="RX 批次")
        sm.write_through(b"out\r\n")
        self.assertEqual([x["dir"] for x in self.chunks()], ["rx", "tx"])
        tx = sm.tail_bytes(0, direction="tx")
        self.assertEqual([x["dir"] for x in tx["chunks"]], ["tx"])
        self.assertTrue(tx["filtered"])

    def test_tail_bytes_after_is_incremental(self):
        self.assertTrue(self.open()["ok"])
        sm.write_through(b"a")
        sm.write_through(b"b")
        self.assertEqual([x["seq"] for x in self.chunks(1)], [2])

    def test_ring_overflow_reports_chunk_gap(self):
        self.assertTrue(self.open()["ok"])
        for i in range(6):                   # MAX_CHUNKS=4 → 最旧两批被挤掉
            sm.write_through(bytes([i]))
        t = sm.tail_bytes(0)
        self.assertEqual([x["seq"] for x in t["chunks"]], [3, 4, 5, 6])
        self.assertGreaterEqual(t["covered"], 2)
        self.assertGreaterEqual(t["gap"], 2)

    def test_epoch_increases_on_reopen(self):
        r1 = self.open()
        e1 = r1["epoch"]
        sm.close_session(log=lambda *a: None)
        self.io2 = FakeIO("COM9", 115200, for_write=True)
        sm.sp = types.SimpleNamespace(SerialIO=lambda p, b, **kw: self.io2,
                                      capabilities=sm.sp.capabilities)
        r2 = self.open()
        self.assertEqual(r2["epoch"], e1 + 1)

    def test_snapshot_reports_byte_fields(self):
        self.assertTrue(self.open()["ok"])
        sm.write_through(b"x")
        st = sm.status()
        for k in ("epoch", "chunk_seq", "covered_chunks", "bytes_total",
                  "paused", "opened_by", "allow_agent_write", "lease_s"):
            self.assertIn(k, st)

    def test_tail_bytes_without_session(self):
        r = sm.tail_bytes(0)
        self.assertFalse(r["active"])
        self.assertEqual(r["chunks"], [])


class ClearPause(Base):
    def test_clear_keeps_seq_monotonic_and_counts_covered(self):
        self.assertTrue(self.open()["ok"])
        self.io.rx.append(b"a\nb\n")
        self.wait_for(lambda: sm.tail(0)["seq"] >= 2, what="两行")
        r = sm.clear()
        self.assertEqual(r["cleared_lines"], 2)
        self.assertGreaterEqual(r["cleared_chunks"], 1)
        self.assertEqual(sm.tail(0)["lines"], [])
        self.assertEqual(sm.status()["seq"], 2)          # seq 不回退
        self.assertGreaterEqual(sm.status()["covered"], 2)

    def test_clear_without_session(self):
        self.assertFalse(sm.clear()["ok"])

    def test_pause_stops_ring_but_keeps_reading(self):
        self.assertTrue(self.open()["ok"])
        self.assertTrue(sm.set_paused(True)["paused"])
        self.io.rx.append(b"hidden\n")
        time.sleep(0.3)
        self.assertEqual(sm.tail_bytes(0)["chunks"], [])
        self.assertTrue(sm.set_paused(False)["ok"])
        self.io.rx.append(b"visible\n")
        self.wait_for(lambda: sm.tail(0)["seq"] >= 1, what="恢复后入环")
        self.assertEqual(sm.tail(0)["lines"][0]["text"], "visible")

    def test_pause_without_session(self):
        self.assertFalse(sm.set_paused(True)["ok"])


class AgentLease(Base):
    def test_lease_expires_and_releases_port(self):
        r = self.open(lease_s=0.2, opened_by="agent", allow_agent_write=True)
        self.assertTrue(r["ok"])
        self.assertEqual(r["opened_by"], "agent")
        self.assertTrue(r["allow_agent_write"])
        self.wait_for(lambda: not sm.status()["active"], what="租约到期自愈")
        self.assertEqual(sm.status()["error"], "lease_expired")
        self.assertTrue(self.io.closed)      # 到期必须真的放开独占口（N5）

    def test_tail_renews_lease(self):
        self.assertTrue(self.open(lease_s=1.0, opened_by="agent")["ok"])
        for _ in range(4):
            time.sleep(0.3)
            self.assertTrue(sm.status()["active"], "tail 应当续租")
            sm.tail(0)
        remaining = sm.status()["lease_remaining_s"]
        self.assertGreater(remaining, 0.0)


class Capture(Base):
    """K5：显式录制 —— 有界 JSONL、只存字节、到顶如实标 truncated。"""

    def setUp(self):
        super().setUp()
        # 录制落在 cfg.root/.work/.cockpit —— 测试必须用临时根，别写进仓库
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Config(self.tmp.name)

    def tearDown(self):
        super().tearDown()
        self.tmp.cleanup()

    def test_capture_records_both_directions(self):
        self.assertTrue(self.open()["ok"])
        r = sm.capture_start(self.cfg)
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["path"].endswith(".jsonl"))
        self.io.rx.append(b"cap\n")
        self.wait_for(lambda: sm.status()["chunk_seq"] >= 1, what="RX 批次")
        self.assertTrue(sm.write_through(b"tx\n"))
        self.wait_for(lambda: sm.status()["capture"]["chunks"] >= 2, what="两条录制")
        stopped = sm.capture_stop()
        self.assertTrue(stopped["ok"], stopped)
        self.assertEqual(stopped["chunks"], 2)
        lines = Path(stopped["path"]).read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        recs = [json.loads(x) for x in lines]
        self.assertEqual([x["dir"] for x in recs], ["rx", "tx"])
        for rec in recs:
            self.assertEqual(set(rec), {"seq", "t_us", "dir", "bytes_b64"})
        self.assertEqual(base64.b64decode(recs[1]["bytes_b64"]), b"tx\n")

    def test_capture_stops_at_cap_and_marks_truncated(self):
        self.assertTrue(self.open()["ok"])
        r = sm.capture_start(self.cfg, max_bytes=150)
        self.assertTrue(r["ok"], r)
        for i in range(2):
            sm.write_through(f"line-{i}\n".encode())
        stop = sm.capture_stop()
        self.assertTrue(stop["truncated"])       # 第二条超上限 → 停录
        self.assertLessEqual(stop["bytes"], 150)
        text = Path(stop["path"]).read_text(encoding="utf-8")
        self.assertTrue(text.strip())            # 不全空
        for line in text.splitlines():
            json.loads(line)                     # 每条都是完整 JSON（不截半条）

    def test_capture_status_visible_in_snapshot(self):
        self.assertTrue(self.open()["ok"])
        sm.capture_start(self.cfg)
        cap = sm.status()["capture"]
        self.assertTrue(cap["active"])
        self.assertTrue(cap["path"].endswith(".jsonl"))
        sm.capture_stop()
        self.assertFalse(sm.status()["capture"]["active"])

    def test_capture_without_session_is_honest(self):
        r = sm.capture_start(self.cfg)
        self.assertFalse(r["ok"])
        self.assertIn("监视", r["error"])


class SharedDecode(Base):
    """P3.5：会话级共享解码 —— decoder 是会话属性，agent 与面板读同一份帧。"""

    @staticmethod
    def _frame(*vals: float) -> bytes:
        return struct.pack("<%df" % len(vals), *vals) + b"\x00\x00\x80\x7f"

    def test_rx_bytes_are_decoded_into_session_ring(self):
        self.assertTrue(self.open()["ok"])
        r = sm.set_decoder("justfloat", actor="agent")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["decoder"], "justfloat")
        self.assertEqual(r["decoder_by"], "agent")
        self.io.rx.append(self._frame(1.0, 2.0))
        self.wait_for(lambda: sm.tail_decoded(0)["next_after"] >= 1, what="一帧")
        t = sm.tail_decoded(0)
        self.assertEqual(t["decoder"], "justfloat")
        self.assertEqual(t["channels"], 2)
        self.assertEqual(len(t["frames"]), 1)
        self.assertEqual(t["frames"][0]["seq"], 1)
        self.assertAlmostEqual(t["frames"][0]["values"][0], 1.0, places=5)
        self.assertAlmostEqual(t["frames"][0]["values"][1], 2.0, places=5)
        # 人在面板上看到的摘要就是这份投影
        self.assertEqual(sm.status()["decode"]["total_frames"], 1)

    def test_half_frame_is_pending_not_lost(self):
        self.assertTrue(self.open()["ok"])
        self.assertTrue(sm.set_decoder("justfloat", actor="human")["ok"])
        self.io.rx.append(struct.pack("<f", 1.0))          # 只有半个帧
        self.wait_for(lambda: sm.tail_decoded(0)["pending_bytes"] >= 4, what="半帧待续")
        self.assertEqual(sm.tail_decoded(0)["frames"], [])
        self.io.rx.append(struct.pack("<f", 2.0) + b"\x00\x00\x80\x7f")
        self.wait_for(lambda: sm.tail_decoded(0)["next_after"] >= 1, what="拼上后半帧")
        vals = sm.tail_decoded(0)["frames"][0]["values"]
        self.assertAlmostEqual(vals[0], 1.0, places=5)
        self.assertAlmostEqual(vals[1], 2.0, places=5)
        self.assertEqual(sm.tail_decoded(0)["pending_bytes"], 0)

    def test_tx_is_not_decoded(self):
        self.assertTrue(self.open()["ok"])
        self.assertTrue(sm.set_decoder("justfloat", actor="agent")["ok"])
        self.assertTrue(sm.write_through(self._frame(9.0, 9.0)))   # 我们自己写的
        self.wait_for(lambda: sm.tail_bytes(0)["chunk_seq"] >= 1, what="TX 批次")
        self.assertEqual(sm.tail_decoded(0)["frames"], [])           # 只解 RX

    def test_switch_decoder_keeps_seq_monotonic(self):
        self.assertTrue(self.open()["ok"])
        self.assertTrue(sm.set_decoder("justfloat", actor="agent")["ok"])
        self.io.rx.append(self._frame(1.0, 2.0) * 3)
        self.wait_for(lambda: sm.tail_decoded(0)["next_after"] >= 3, what="三帧")
        before = sm.tail_decoded(0)["next_after"]
        r = sm.set_decoder("firewater", actor="human")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["total_frames"], 0)
        self.assertGreaterEqual(r["covered"], 3)       # 旧帧被换解码器"挤掉"，如实计数
        self.assertEqual(sm.tail_decoded(0)["next_after"], before)  # 序号不回退
        self.io.rx.append(b"5,6\n")
        self.wait_for(lambda: sm.tail_decoded(0)["next_after"] >= 4, what="新解码器帧")
        f = sm.tail_decoded(0)["frames"][-1]
        self.assertEqual(f["seq"], 4)
        self.assertEqual(f["values"], [5.0, 6.0])
        self.assertEqual(sm.status()["decode"]["decoder_by"], "human")

    def test_decoder_can_be_cleared(self):
        self.assertTrue(self.open()["ok"])
        self.assertTrue(sm.set_decoder("justfloat", actor="agent")["ok"])
        self.io.rx.append(self._frame(1.0, 2.0))
        self.wait_for(lambda: sm.tail_decoded(0)["next_after"] >= 1, what="一帧")
        self.assertTrue(sm.set_decoder("", actor="human")["ok"])
        self.assertEqual(sm.tail_decoded(0)["decoder"], "")
        self.assertEqual(sm.tail_decoded(0)["decoder_by"], "")
        self.io.rx.append(self._frame(3.0, 4.0))          # 关闭后不再解
        time.sleep(0.3)
        self.assertEqual(sm.tail_decoded(0)["next_after"], 1)

    def test_unknown_decoder_refused(self):
        self.assertTrue(self.open()["ok"])
        r = sm.set_decoder("protobuf", actor="agent")
        self.assertFalse(r["ok"])
        self.assertIn("未知解码器", r["error"])

    def test_tail_decoded_without_session(self):
        r = sm.tail_decoded(0)
        self.assertFalse(r["active"])
        self.assertEqual(r["frames"], [])

    def test_set_decoder_without_session_is_refused(self):
        r = sm.set_decoder("justfloat", actor="agent")
        self.assertFalse(r["ok"])
        self.assertIn("没有进行中的监视", r["error"])

    def test_open_restores_decoder_from_previous_session(self):
        """跨会话记忆：open 带 decoder → 第一批 RX 就按同一协议解码。"""
        r = self.open(decoder="justfloat")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["decode"]["decoder"], "justfloat")
        self.assertEqual(r["decode"]["decoder_by"], "human")
        self.io.rx.append(self._frame(3.0, 4.0))
        self.wait_for(lambda: sm.tail_decoded(0)["next_after"] >= 1, what="开会话即解码")
        vals = sm.tail_decoded(0)["frames"][0]["values"]
        self.assertAlmostEqual(vals[0], 3.0, places=5)
        self.assertAlmostEqual(vals[1], 4.0, places=5)

    def test_open_refuses_unknown_decoder(self):
        r = self.open(decoder="nope")
        self.assertFalse(r["ok"])
        self.assertIn("未知解码器", r["error"])


# ── P3：帧级健康度 / 触发录制 / 空闲分包 ────────────────────────────
#
# 帧协议用真 profile（走 serialframes 的校验与装配），不手搓 dict：
# 这里要验的是"监视会话怎么读这份配置"，而不是"配置长什么样"。
_NODE_PROFILE = {
    "id": "t-node", "label": "节点帧", "kind": "binary",
    "frame": {"head_hex": "A5 5A", "tail_hex": "0D 0A", "length": 10,
              "id_field": {"offset": 2, "type": "u8"}},
    "checksum": {"kind": "crc16modbus"},
    "variants": [
        {"id": 1, "label": "STAT", "fields": [
            {"name": "rpm", "offset": 3, "type": "u16", "endian": "le"}]},
        {"id": 2, "label": "TEMP", "fields": [
            {"name": "temp", "offset": 3, "type": "i16", "endian": "le",
             "scale": 0.1}]},
    ],
}


def _node_frame(vid: int = 1, val: int = 1000, *, bad_ck: bool = False) -> bytes:
    """head(2) + id(1) + value(2) + pad(1) + crc16(2) + tail(2) = 10 字节。"""
    body = (b"\xA5\x5A" + bytes([vid])
            + int(val).to_bytes(2, "little", signed=True) + b"\x00")
    ck = codec.crc16modbus(body) ^ (0xFFFF if bad_ck else 0)
    return body + ck.to_bytes(2, "little") + b"\x0D\x0A"


class ProfileBase(Base):
    """临时工程根 + 落盘的 profile：解码/录制都走真实的加载路径。"""

    def setUp(self):
        super().setUp()
        from elab.config import Config as _Cfg
        self.tmp = tempfile.TemporaryDirectory()
        self._write_project()
        self.cfg = _Cfg(self.tmp.name)
        r = sf.save(self.cfg, "p1", 0, _NODE_PROFILE)
        self.assertTrue(r["ok"], r)

    def _write_project(self) -> None:
        """最小工程：Config 要求 projects/*.yaml 里既有 name 也有 root。"""
        p = Path(self.tmp.name) / "projects"
        p.mkdir(parents=True, exist_ok=True)
        (p / "p1.yaml").write_text("name: p1\nroot: ${ELAB_ROOT}\n",
                                   encoding="utf-8")

    def tearDown(self):
        super().tearDown()
        self.tmp.cleanup()

    def use_profile(self, pid: str = "t-node") -> dict:
        r = sm.set_decoder(f"profile:{pid}", actor="agent", cfg=self.cfg,
                           project="p1")
        self.assertTrue(r["ok"], r)
        return r


class FrameStats(ProfileBase):
    """P3.1：帧率 / 到达间隔 / 错误分类 / 每 variant 计数都要如实。"""

    def test_fps_interval_and_buffer(self):
        self.assertTrue(self.open()["ok"])
        self.use_profile()
        self.io.rx.append(_node_frame(1, 1000) + _node_frame(1, 1100)
                          + _node_frame(1, 1200) + _node_frame(1, 1300))
        self.wait_for(lambda: sm.tail_decoded(0)["next_after"] >= 4, what="四帧")
        st = sm.frame_stats(10)
        self.assertTrue(st["active"])
        self.assertEqual(st["profile"], "t-node")
        self.assertEqual(st["frames"], 4)
        self.assertEqual(st["frames_total"], 4)
        self.assertGreater(st["fps"], 0)
        self.assertEqual(st["error_rate"], 0.0)
        self.assertEqual(st["skipped_total"], 0)
        self.assertEqual(st["pending_bytes"], 0)
        self.assertIn("frames", st["buffer"])
        self.assertGreaterEqual(st["interval_ms"]["mean"], 0.0)
        self.assertGreaterEqual(st["rate_bps"], 0.0)

    def test_checksum_failures_are_classified(self):
        self.assertTrue(self.open()["ok"])
        self.use_profile()
        self.io.rx.append(_node_frame(1, 1000, bad_ck=True) + _node_frame(1, 1000))
        self.wait_for(lambda: sm.status()["decode"]["reasons"]["checksum"] >= 1,
                      what="校验失败记账")
        self.wait_for(lambda: sm.status()["decode"]["total_frames"] >= 1,
                      what="好帧")
        d = sm.status()["decode"]
        self.assertEqual(d["reasons"]["checksum"], 1)
        self.assertEqual(d["skipped"], 1)
        st = sm.frame_stats(10)
        self.assertEqual(st["checksum_fail"], 1)
        self.assertEqual(st["frames_total"], 1)
        self.assertGreater(st["error_rate"], 0.0)        # 1 坏 / (1 好 + 1 坏)

    def test_variants_are_counted_per_label(self):
        self.assertTrue(self.open()["ok"])
        self.use_profile()
        self.io.rx.append(_node_frame(1, 800) + _node_frame(2, -100))
        self.wait_for(lambda: sm.status()["decode"]["total_frames"] >= 2, what="两帧")
        st = sm.frame_stats(10)
        self.assertEqual(st["variants"], {"STAT": 1, "TEMP": 1})
        self.assertEqual(st["variant_totals"], {"STAT": 1, "TEMP": 1})
        recs = sm.status()["decode"]["records"]
        self.assertEqual([r.get("variant") for r in recs], ["STAT", "TEMP"])
        temps = [r["fields"]["temp"] for r in recs if "temp" in r["fields"]]
        self.assertAlmostEqual(temps[0], -10.0, places=5)   # scale 0.1

    def test_unknown_id_is_not_a_silent_drop(self):
        self.assertTrue(self.open()["ok"])
        self.use_profile()
        self.io.rx.append(_node_frame(7, 123))
        self.wait_for(lambda: sm.status()["decode"]["reasons"]["unknown_id"] >= 1,
                      what="未知 id 记账")
        d = sm.status()["decode"]
        self.assertEqual(d["total_frames"], 0)
        self.assertEqual(d["reasons"]["unknown_id"], 1)
        st = sm.frame_stats(10)
        self.assertEqual(st["unknown_id"], 1)

    def test_stats_without_session_and_window_clamped(self):
        r = sm.frame_stats(5)
        self.assertFalse(r["active"])
        self.assertEqual(r["frames"], 0)
        self.assertTrue(self.open()["ok"])
        self.assertEqual(sm.frame_stats(0)["window_s"], 1.0)     # 下限 1s
        self.assertEqual(sm.frame_stats(999)["window_s"], 60.0)  # 上限 60s


class CaptureTrigger(ProfileBase):
    """P3.2：布防 —— 命中前不落盘、命中把预录一起交出去、命中后继续录。"""

    def test_pattern_trigger_flushes_pre_roll(self):
        self.assertTrue(self.open()["ok"])
        r = sm.capture_start(self.cfg, trigger={"pattern": "aa55"},
                             pre_bytes=4096)
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["armed"])
        self.io.rx.append(b"boot-1\n")
        self.io.rx.append(b"boot-2\n")
        self.wait_for(lambda: sm.status()["chunk_seq"] >= 2, what="预录批次")
        cap = sm.status()["capture"]
        self.assertTrue(cap["armed"])
        self.assertFalse(cap["triggered"])
        self.assertEqual(cap["chunks"], 0)        # 未命中 = 一个字节都不落盘

        self.io.rx.append(b"\xAA\x55\x01")
        self.wait_for(lambda: sm.status()["capture"]["triggered"], what="命中")
        sm.write_through(b"after\n")              # 命中之后照录，不停
        self.wait_for(lambda: sm.status()["capture"]["chunks"] >= 5,
                      what="命中后继续录")
        stop = sm.capture_stop()
        self.assertTrue(stop["triggered"])
        self.assertEqual(stop["triggered_by"], "pattern")
        lines = [json.loads(x) for x in
                 Path(stop["path"]).read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(lines), 5)
        self.assertEqual(base64.b64decode(lines[0]["bytes_b64"]), b"boot-1\n")
        self.assertEqual(base64.b64decode(lines[1]["bytes_b64"]), b"boot-2\n")
        self.assertEqual(lines[2]["event"], "trigger")
        self.assertEqual(lines[2]["why"], "pattern")
        self.assertEqual(base64.b64decode(lines[3]["bytes_b64"]), b"\xAA\x55\x01")
        self.assertEqual(base64.b64decode(lines[4]["bytes_b64"]), b"after\n")

    def test_no_pre_roll_keeps_only_the_hit(self):
        self.assertTrue(self.open()["ok"])
        r = sm.capture_start(self.cfg, trigger={"pattern": "0d0a"}, pre_bytes=0)
        self.assertTrue(r["ok"], r)
        self.io.rx.append(b"noise\n")
        self.wait_for(lambda: sm.status()["chunk_seq"] >= 1, what="无关批次")
        self.assertEqual(sm.status()["capture"]["chunks"], 0)
        self.io.rx.append(b"tail\r\n")
        self.wait_for(lambda: sm.status()["capture"]["triggered"], what="命中")
        stop = sm.capture_stop()
        lines = [json.loads(x) for x in
                 Path(stop["path"]).read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(lines), 2)           # 没要预录：标记 + 命中那一批
        self.assertEqual(lines[0]["event"], "trigger")
        self.assertEqual(base64.b64decode(lines[1]["bytes_b64"]), b"tail\r\n")

    def test_frame_index_trigger_keeps_its_own_batch(self):
        """按第 N 帧触发：命中那一批字节必须留下（现场不能被自己丢掉）。"""
        self.assertTrue(self.open()["ok"])
        self.use_profile()
        r = sm.capture_start(self.cfg, trigger={"frame_index": 3})
        self.assertTrue(r["ok"], r)
        batch = _node_frame(1, 1) + _node_frame(1, 2) + _node_frame(1, 3)
        self.io.rx.append(batch)
        self.wait_for(lambda: sm.status()["capture"]["triggered"], what="第 3 帧")
        stop = sm.capture_stop()
        self.assertEqual(stop["triggered_by"], "frame_index=3")
        lines = [json.loads(x) for x in
                 Path(stop["path"]).read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(lines), 2)
        self.assertEqual(base64.b64decode(lines[0]["bytes_b64"]), batch)

    def test_field_trigger_needs_decoder(self):
        self.assertTrue(self.open()["ok"])
        r = sm.capture_start(self.cfg, trigger={"field": {"name": "rpm",
                                                         "op": "gt", "value": 500}})
        self.assertFalse(r["ok"])
        self.assertIn("解码器", r["error"])

    def test_bad_pattern_rejected_at_arm_time(self):
        # 布防时就要拦：留到匹配阶段静默 return 的话，录制会永远不命中，
        # 用户只会以为"问题没复现"，而不是"我把 pattern 拼错了"。
        self.assertTrue(self.open()["ok"])
        r = sm.capture_start(self.cfg, trigger={"pattern": "aa5g"})
        self.assertFalse(r["ok"])
        self.assertIn("HEX", r["error"])

    def test_bad_op_rejected_at_arm_time(self):
        self.assertTrue(self.open()["ok"])
        self.use_profile()
        r = sm.capture_start(self.cfg, trigger={"field": {"name": "rpm",
                                                          "op": "between", "value": 5}})
        self.assertFalse(r["ok"])
        self.assertIn("eq", r["error"])

    def test_unknown_field_name_warns_instead_of_silent(self):
        self.assertTrue(self.open()["ok"])
        self.use_profile()
        r = sm.capture_start(self.cfg, trigger={"field": {"name": "nope",
                                                          "op": "gt", "value": 1}})
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["warnings"], r)
        self.assertIn("nope", r["warnings"][0])
        sm.capture_stop()

    def test_frame_index_must_be_positive(self):
        self.assertTrue(self.open()["ok"])
        r = sm.capture_start(self.cfg, trigger={"frame_index": 0})
        self.assertFalse(r["ok"])
        self.assertIn("frame_index", r["error"])

    def test_field_trigger_compares_decoded_value(self):
        self.assertTrue(self.open()["ok"])
        self.use_profile()
        r = sm.capture_start(self.cfg, trigger={"field": {"name": "rpm",
                                                          "op": "gt",
                                                          "value": 500}},
                             pre_bytes=4096)
        self.assertTrue(r["ok"], r)
        self.io.rx.append(_node_frame(1, 100))     # 不满足：进预录
        self.wait_for(lambda: sm.status()["chunk_seq"] >= 1, what="低值帧")
        self.assertFalse(sm.status()["capture"]["triggered"])
        self.io.rx.append(_node_frame(1, 900))     # rpm>500 → 命中
        self.wait_for(lambda: sm.status()["capture"]["triggered"], what="命中")
        stop = sm.capture_stop()
        self.assertEqual(stop["triggered_by"], "field rpm>500")
        lines = [json.loads(x) for x in
                 Path(stop["path"]).read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(lines), 3)            # 低值帧 + 标记 + 命中帧
        self.assertEqual(base64.b64decode(lines[0]["bytes_b64"]), _node_frame(1, 100))

    def test_armed_but_never_hit_is_reported(self):
        self.assertTrue(self.open()["ok"])
        r = sm.capture_start(self.cfg, trigger={"pattern": "deadbeef"})
        self.assertTrue(r["ok"], r)
        self.io.rx.append(b"nothing to see\n")
        self.wait_for(lambda: sm.status()["chunk_seq"] >= 1, what="无关批次")
        stop = sm.capture_stop()
        self.assertTrue(stop["armed"])
        self.assertFalse(stop["triggered"])
        self.assertEqual(stop["triggered_by"], "")
        self.assertIn("未命中", stop["note"])

    def test_trigger_must_be_object(self):
        self.assertTrue(self.open()["ok"])
        r = sm.capture_start(self.cfg, trigger=["aa55"])
        self.assertFalse(r["ok"])
        self.assertIn("trigger", r["error"])


class IdleGapSession(Base):
    """P3.3：只靠空闲分包定界的协议 —— 静默超过 idle_gap_ms 才算一帧结束。"""

    PROFILE = {
        "id": "idle-demo", "label": "无帧头遥测", "kind": "binary",
        "frame": {"idle_gap_ms": 30, "max_bytes": 256},
        "fields": [{"name": "a", "offset": 0, "type": "f32"},
                   {"name": "b", "offset": 4, "type": "f32"}],
    }

    def setUp(self):
        super().setUp()
        from elab.config import Config as _Cfg
        self.tmp = tempfile.TemporaryDirectory()
        p = Path(self.tmp.name) / "projects"
        p.mkdir(parents=True, exist_ok=True)
        (p / "p1.yaml").write_text("name: p1\nroot: ${ELAB_ROOT}\n",
                                   encoding="utf-8")
        self.cfg = _Cfg(self.tmp.name)
        self.assertTrue(sf.save(self.cfg, "p1", 0, self.PROFILE)["ok"])
        self.assertTrue(self.open()["ok"])
        r = sm.set_decoder("profile:idle-demo", actor="agent", cfg=self.cfg,
                           project="p1")
        self.assertTrue(r["ok"], r)

    def tearDown(self):
        super().tearDown()
        self.tmp.cleanup()

    @staticmethod
    def _pair(a: float, b: float) -> bytes:
        return struct.pack("<ff", a, b)

    def test_silence_splits_frames(self):
        self.assertEqual(sm.frame_stats(10)["idle_gap_ms"], 30)
        self.io.rx.append(self._pair(1.0, 2.0))
        self.wait_for(lambda: sm.tail_decoded(0)["next_after"] >= 1, what="静默出一帧")
        self.io.rx.append(self._pair(3.0, 4.0))
        self.wait_for(lambda: sm.tail_decoded(0)["next_after"] >= 2, what="第二帧")
        frames = sm.tail_decoded(0)["frames"]
        self.assertAlmostEqual(frames[0]["values"][0], 1.0, places=5)
        self.assertAlmostEqual(frames[1]["values"][1], 4.0, places=5)
        self.assertEqual(sm.tail_decoded(0)["pending_bytes"], 0)

    def test_back_to_back_bytes_stay_one_frame(self):
        """连着的两批在空闲阈值内 = 同一帧（这就是"空闲分包"与"定长"的区别）。"""
        self.io.rx.append(self._pair(5.0, 6.0))
        self.wait_for(lambda: sm.tail_decoded(0)["pending_bytes"] > 0, what="攒字节")
        self.io.rx.append(self._pair(7.0, 8.0))
        self.wait_for(lambda: sm.tail_decoded(0)["next_after"] >= 1, what="合成一帧")
        self.assertEqual(sm.tail_decoded(0)["next_after"], 1)


if __name__ == "__main__":
    unittest.main()
