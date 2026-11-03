"""串口自定义发送组件（M1）的离线用例。

覆盖四类**容易在改动中被悄悄破坏**的事：
  1. 渲染只在服务端：参数类型/范围/hex 宽度/转义，且与最终字节一致；
  2. 坏文件/坏组件**不阻塞**串口功能，错误如实进 warnings/error；
  3. rev 乐观锁：人的修改不会被旧副本覆盖；
  4. 执行只走现有写口（监视写穿 / 无状态往返），console 留档带 via + 参数快照。
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
for p in (str(ROOT), str(ROOT / "services")):
    if p not in sys.path:
        sys.path.insert(0, p)

from elab import serialwidgets as sw             # noqa: E402
from elab.config import ElabError                # noqa: E402


class FakeCfg:
    def __init__(self, root):
        self.root = root


def _pid_widget(**over):
    w = {
        "id": "pid-set", "label": "设置 PID",
        "format": "utf8", "eol": "crlf",
        "params": [
            {"name": "kp", "label": "Kp", "type": "float", "default": 1.0,
             "min": 0, "max": 20, "step": 0.01, "decimals": 2},
            {"name": "ki", "label": "Ki", "type": "float", "default": 0.1,
             "min": 0, "max": 5, "step": 0.01, "decimals": 2},
            {"name": "kd", "label": "Kd", "type": "float", "default": 0.0,
             "min": 0, "max": 5, "step": 0.01, "decimals": 2},
        ],
        "steps": [{"kind": "send", "text": "pid {{kp}} {{ki}} {{kd}}"}],
    }
    w.update(over)
    return w


def _one_step(text="PING:{{n}}", **over):
    w = {
        "id": "ping", "label": "PING", "format": "utf8", "eol": "crlf",
        "params": [{"name": "n", "label": "序号", "type": "int",
                    "default": 1, "min": 0, "max": 99}],
        "steps": [{"kind": "send", "text": text}],
    }
    w.update(over)
    return w


class Base(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.root = Path(self._td.name)
        (self.root / "projects").mkdir(parents=True, exist_ok=True)
        self.cfg = FakeCfg(self.root)

    def tearDown(self):
        self._td.cleanup()

    def write_doc(self, widgets, *, rev=0, project="f411", raw=None):
        path = self.root / "projects" / f"{project}.widgets.json"
        path.write_text(
            raw if raw is not None else json.dumps(
                {"version": 1, "rev": rev, "widgets": widgets}, ensure_ascii=False),
            encoding="utf-8")
        return path


# ══════════════════════════════════════════════════════════════════
#  加载 / 校验
# ══════════════════════════════════════════════════════════════════
class TestLoad(Base):
    def test_missing_file_is_empty(self):
        doc = sw.load(self.cfg, "f411")
        self.assertEqual(doc["rev"], 0)
        self.assertEqual(doc["widgets"], [])
        self.assertIsNone(doc["error"])

    def test_valid_file_loads_defaults(self):
        self.write_doc([_pid_widget()])
        doc = sw.load(self.cfg, "f411")
        self.assertIsNone(doc["error"])
        self.assertEqual(doc["rev"], 0)
        w = doc["widgets"][0]
        self.assertEqual([p["name"] for p in w["params"]], ["kp", "ki", "kd"])
        self.assertEqual(w["params"][0]["default"], 1.0)

    def test_bad_json_does_not_raise(self):
        self.write_doc([], raw="{oops")
        doc = sw.load(self.cfg, "f411")
        self.assertTrue(doc["error"])
        self.assertEqual(doc["widgets"], [])

    def test_bad_widget_dropped_with_warning(self):
        self.write_doc([{"id": "BAD ID", "label": "x",
                         "steps": [{"kind": "send", "text": "a"}]}])
        doc = sw.load(self.cfg, "f411")
        self.assertEqual(doc["widgets"], [])
        self.assertTrue(any("id 不合法" in x for x in doc["warnings"]))

    def test_duplicate_id_dropped_with_warning(self):
        self.write_doc([_one_step(), _one_step()])
        doc = sw.load(self.cfg, "f411")
        self.assertEqual(len(doc["widgets"]), 1)
        self.assertTrue(any("重复" in x for x in doc["warnings"]))

    def test_bad_project_name_rejected(self):
        with self.assertRaises(ElabError):
            sw.widgets_path(self.cfg, "../evil")


# ══════════════════════════════════════════════════════════════════
#  渲染
# ══════════════════════════════════════════════════════════════════
class TestRender(Base):
    def test_float_decimals(self):
        text, err = sw.render_text("{{kp}}|{{ki}}", {"kp": 2.5, "ki": 0.1},
                                   _pid_widget()["params"])
        self.assertEqual(err, "")
        self.assertEqual(text, "2.50|0.10")

    def test_int_plain(self):
        text, err = sw.render_text("n={{n}}", {"n": 7},
                                   [{"name": "n", "type": "int"}])
        self.assertEqual((text, err), ("n=7", ""))

    def test_int_hex_width(self):
        params = [{"name": "n", "type": "int", "render": "hex", "width": 2}]
        text, err = sw.render_text("{{n}}", {"n": 31}, params)
        self.assertEqual((text, err), ("1F", ""))

    def test_hex_param_width_and_endian(self):
        w = _pid_widget(params=[{"name": "addr", "type": "hex", "default": "0102",
                                 "width": 2, "endian": "le"}],
                        steps=[{"kind": "send", "text": "A5 {{addr}}"}])
        norm, errs = sw.normalize_widget(w)
        self.assertEqual(errs, [])
        vals, perrs = sw.resolve_params(norm, {"addr": "0102"})
        self.assertEqual(perrs, [])
        text, rerr = sw.render_text(w["steps"][0]["text"], vals, norm["params"])
        self.assertEqual((text, rerr), ("A5 0201", ""))

    def test_hex_param_wrong_width_rejected(self):
        w = _pid_widget(params=[{"name": "addr", "type": "hex", "width": 1}],
                        steps=[{"kind": "send", "text": "{{addr}}"}])
        norm, errs = sw.normalize_widget(w)
        self.assertEqual(errs, [])
        _vals, perrs = sw.resolve_params(norm, {"addr": "0102"})
        self.assertTrue(any("需要 1 字节" in x for x in perrs))

    def test_bool_true_false_value(self):
        w = _pid_widget(params=[{"name": "on", "type": "bool", "default": True,
                                 "true_value": "ON", "false_value": "OFF"}],
                        steps=[{"kind": "send", "text": "led {{on}}"}])
        norm, errs = sw.normalize_widget(w)
        self.assertEqual(errs, [])
        vals, _ = sw.resolve_params(norm, {"on": "false"})
        text, _ = sw.render_text("led {{on}}", vals, norm["params"])
        self.assertEqual(text, "led OFF")

    def test_enum_send_value(self):
        w = _pid_widget(params=[{"name": "mode", "type": "enum",
                                 "options": [{"label": "闭环", "value": "1"},
                                             {"label": "开环", "value": "0"}],
                                 "default": "1"}],
                        steps=[{"kind": "send", "text": "mode {{mode}}"}])
        norm, errs = sw.normalize_widget(w)
        self.assertEqual(errs, [])
        vals, _ = sw.resolve_params(norm, {"mode": "0"})
        text, _ = sw.render_text("mode {{mode}}", vals, norm["params"])
        self.assertEqual(text, "mode 0")

    def test_string_crlf_rejected(self):
        w = _pid_widget(params=[{"name": "s", "type": "string", "default": "x"}],
                        steps=[{"kind": "send", "text": "{{s}}"}])
        norm, errs = sw.normalize_widget(w)
        self.assertEqual(errs, [])
        _vals, perrs = sw.resolve_params(norm, {"s": "a\r\nb"})
        self.assertTrue(any("CR/LF" in x for x in perrs))

    def test_unknown_placeholder(self):
        _text, err = sw.render_text("{{nope}}", {}, [])
        self.assertIn("未声明", err)

    def test_escaped_braces(self):
        text, err = sw.render_text("A\\{{x}}B", {}, [])
        self.assertEqual((text, err), ("A{{x}}B", ""))

    def test_range_rejected(self):
        _vals, errs = sw.resolve_params(_pid_widget(), {"kp": 99})
        self.assertTrue(any("最大值" in x for x in errs))

    def test_nan_rejected(self):
        w = _pid_widget(params=[{"name": "v", "type": "float", "default": 1.0}],
                        steps=[{"kind": "send", "text": "{{v}}"}])
        norm, _ = sw.normalize_widget(w)
        _vals, errs = sw.resolve_params(norm, {"v": "NaN"})
        self.assertTrue(any("NaN" in x for x in errs))

    def test_unknown_param_rejected(self):
        _vals, errs = sw.resolve_params(_one_step(), {"nope": 1})
        self.assertTrue(any("未知参数" in x for x in errs))


# ══════════════════════════════════════════════════════════════════
#  预览
# ══════════════════════════════════════════════════════════════════
class TestPreview(Base):
    def test_preview_bytes_and_eol(self):
        self.write_doc([_one_step()])
        r = sw.preview(self.cfg, "f411", "ping", {"n": 3})
        self.assertTrue(r["ok"])
        self.assertEqual(r["bytes"], len(b"PING:3\r\n"))
        self.assertEqual(r["params"], {"n": 3})

    def test_preview_hex_format_has_no_eol(self):
        w = _one_step(id="frame", format="hex", eol="crlf",
                      params=[{"name": "n", "type": "hex", "width": 1, "default": "01"}],
                      steps=[{"kind": "send", "text": "A5 {{n}}"}])
        self.write_doc([w])
        r = sw.preview(self.cfg, "f411", "frame", {})
        self.assertTrue(r["ok"])
        self.assertEqual(r["bytes"], 2)       # A5 01，没有 CRLF

    def test_empty_render_rejected(self):
        w = _one_step(id="empty", steps=[{"kind": "send", "text": "{{n}}"}],
                      params=[{"name": "n", "type": "string", "default": ""}])
        self.write_doc([w])
        r = sw.preview(self.cfg, "f411", "empty", {})
        self.assertFalse(r["ok"])
        self.assertEqual(r["stage"], "validate")

    def test_missing_widget(self):
        self.write_doc([])
        r = sw.preview(self.cfg, "f411", "nope", {})
        self.assertFalse(r["ok"])
        self.assertIn("不存在", r["error"])

    def test_wait_steps_are_deferred_in_preview(self):
        w = _one_step(steps=[{"kind": "send", "text": "PING:{{n}}"},
                             {"kind": "wait", "within_s": 1,
                              "match": {"kind": "regex", "pattern": "^PONG"}}])
        self.write_doc([w])
        r = sw.preview(self.cfg, "f411", "ping", {})
        self.assertTrue(r["ok"])
        self.assertEqual(r["deferred"], [{"i": 2, "kind": "wait"}])


# ══════════════════════════════════════════════════════════════════
#  保存 / 删除（rev 乐观锁）
# ══════════════════════════════════════════════════════════════════
class TestSaveDelete(Base):
    def test_save_increments_rev_and_persists(self):
        r = sw.save(self.cfg, "f411", _one_step(), 0)
        self.assertTrue(r["ok"])
        self.assertEqual(r["rev"], 1)
        self.assertEqual(len(r["widgets"]), 1)

    def test_save_conflict_returns_latest(self):
        self.write_doc([_one_step()], rev=2)
        r = sw.save(self.cfg, "f411", _one_step(id="other"), 1)
        self.assertTrue(r["conflict"])
        self.assertEqual(r["rev"], 2)

    def test_save_invalid_widget_rejected(self):
        with self.assertRaises(ElabError):
            sw.save(self.cfg, "f411", {"id": "x"}, 0)

    def test_save_replaces_same_id(self):
        sw.save(self.cfg, "f411", _one_step(), 0)
        r = sw.save(self.cfg, "f411", _one_step(label="新标签"), 1)
        self.assertEqual(r["widgets"][0]["label"], "新标签")

    def test_delete_works(self):
        sw.save(self.cfg, "f411", _one_step(), 0)
        r = sw.delete(self.cfg, "f411", "ping", 1)
        self.assertTrue(r["ok"])
        self.assertEqual(r["widgets"], [])

    def test_delete_conflict(self):
        self.write_doc([_one_step()], rev=3)
        r = sw.delete(self.cfg, "f411", "ping", 2)
        self.assertTrue(r["conflict"])

    def test_delete_missing_rejected(self):
        self.write_doc([], rev=1)
        with self.assertRaises(ElabError):
            sw.delete(self.cfg, "f411", "nope", 1)

    def test_max_widgets_limit(self):
        widgets = [_one_step(id=f"w{i}") for i in range(sw.MAX_WIDGETS)]
        self.write_doc(widgets)
        with self.assertRaises(ElabError):
            sw.save(self.cfg, "f411", _one_step(id="extra"), 0)


# ══════════════════════════════════════════════════════════════════
#  执行（只走现有写口）
# ══════════════════════════════════════════════════════════════════
class TestRun(Base):
    def test_roundtrip_path_and_journal(self):
        self.write_doc([_one_step()])
        calls = []

        def fake_roundtrip(cfg, name, **kw):
            calls.append(kw)
            kw["journal"]({"dir": "tx", "text": kw["data"], "ok": True,
                           "written": 8, "payload_bytes": 8, "error": None})
            return {"ok": True, "written": 8, "error": None,
                    "port": "COM10", "baud": 115200, "echoed": []}

        with mock.patch.object(sw.sm, "write_through", return_value=None), \
                mock.patch.object(sw.st, "roundtrip", side_effect=fake_roundtrip):
            journal = []
            r = sw.run(self.cfg, "f411", "ping", {"n": 3},
                       journal=lambda rec: journal.append(rec))
        self.assertTrue(r["ok"])
        self.assertEqual(r["state"], "done")
        self.assertEqual(r["steps"][0]["bytes"], 8)
        self.assertEqual(r["port"], "COM10")
        self.assertEqual(len(journal), 1)
        self.assertEqual(journal[0]["via"], "widget:ping")
        self.assertEqual(journal[0]["params"], {"n": 3})

    def test_monitor_path_writes_through(self):
        self.write_doc([_one_step()])
        sent = []

        def fake_write(data):
            sent.append(data)
            return len(data)

        with mock.patch.object(sw.sm, "write_through", side_effect=fake_write), \
                mock.patch.object(sw.sm, "status",
                                  return_value={"port": "COM10", "baud": 115200}):
            journal = []
            r = sw.run(self.cfg, "f411", "ping", {"n": 1},
                       journal=lambda rec: journal.append(rec))
        self.assertTrue(r["ok"])
        self.assertEqual(r["via"], "monitor")
        self.assertEqual(sent, [b"PING:1\r\n"])
        self.assertEqual(journal[0]["via"], "widget:ping")

    def test_monitor_partial_write_is_failure(self):
        self.write_doc([_one_step()])
        with mock.patch.object(sw.sm, "write_through", return_value=1), \
                mock.patch.object(sw.sm, "status",
                                  return_value={"port": "COM10", "baud": 115200}):
            r = sw.run(self.cfg, "f411", "ping", {})
        self.assertFalse(r["ok"])
        self.assertEqual(r["state"], "failed")
        self.assertIn("部分字节", r["steps"][0]["error"])

    def test_confirm_required(self):
        w = _one_step(confirm=True)
        self.write_doc([w])
        r = sw.run(self.cfg, "f411", "ping", {})
        self.assertEqual(r["stage"], "validate")
        self.assertIn("confirm", r["error"])

    def test_repeat_requires_widget_config(self):
        """M2：repeat 必须配在组件上；未配置时拒绝，而不是偷偷跑一次。"""
        self.write_doc([_one_step()])
        r = sw.run(self.cfg, "f411", "ping", {}, repeat=True)
        self.assertEqual(r["stage"], "validate")
        self.assertIn("repeat", r["error"])

    def test_wait_requires_monitor(self):
        """M2：wait 需要连续的 RX 流 → 没有监视会话时明确拒绝。"""
        w = _one_step(steps=[{"kind": "send", "text": "PING:{{n}}"},
                             {"kind": "wait", "within_s": 1}])
        self.write_doc([w])
        r = sw.run(self.cfg, "f411", "ping", {})
        self.assertEqual(r["stage"], "validate")
        self.assertIn("监视", r["error"])

    def test_sequence_delay_and_wait_success(self):
        """M2：send → delay → wait 一轮跑完，wait 命中回显。"""
        w = _one_step(steps=[
            {"kind": "send", "text": "PING:{{n}}"},
            {"kind": "delay", "ms": 10},
            {"kind": "wait", "within_s": 1,
             "match": {"kind": "regex", "pattern": "^PONG"}},
        ])
        self.write_doc([w])
        with mock.patch.object(sw.sm, "write_through", return_value=8), \
                mock.patch.object(sw.sm, "status",
                                  return_value={"active": True, "port": "COM10", "baud": 115200}), \
                mock.patch.object(sw.sm, "tail",
                                  return_value={"seq": 1, "lines": [{"seq": 1, "text": "PONG:1"}]}), \
                mock.patch.object(sw.sm, "tail_bytes",
                                  return_value={"chunk_seq": 0, "chunks": []}):
            r = sw.run(self.cfg, "f411", "ping", {"n": 1})
        self.assertTrue(r["ok"])
        self.assertEqual(r["state"], "done")
        self.assertEqual([s["kind"] for s in r["steps"]], ["send", "delay", "wait"])
        self.assertTrue(r["steps"][2]["matched"])

    def test_wait_timeout_fails_and_stops(self):
        """M2：等不到回显 → 任务 failed，后续步骤不再执行。"""
        w = _one_step(steps=[
            {"kind": "send", "text": "PING:{{n}}"},
            {"kind": "wait", "within_s": 0.15,
             "match": {"kind": "regex", "pattern": "^PONG"}},
            {"kind": "send", "text": "NEVER"},
        ])
        self.write_doc([w])
        with mock.patch.object(sw.sm, "write_through", return_value=8), \
                mock.patch.object(sw.sm, "status",
                                  return_value={"active": True, "port": "COM10", "baud": 115200}), \
                mock.patch.object(sw.sm, "tail", return_value={"seq": 0, "lines": []}), \
                mock.patch.object(sw.sm, "tail_bytes",
                                  return_value={"chunk_seq": 0, "chunks": []}):
            r = sw.run(self.cfg, "f411", "ping", {"n": 1})
        self.assertFalse(r["ok"])
        self.assertEqual(r["state"], "failed")
        self.assertIn("超时", r["error"])
        self.assertEqual([s["kind"] for s in r["steps"]], ["send", "wait"])

    def test_repeat_runs_fixed_rounds(self):
        """M2：周期任务按 count 跑完，轮次与步骤记录都在。"""
        w = _one_step(repeat={"interval_ms": 20, "count": 3})
        self.write_doc([w])
        sent = []

        def fake_roundtrip(cfg, name, **kw):
            sent.append(kw["data"])
            return {"ok": True, "written": 8, "error": None,
                    "port": "COM10", "baud": 115200, "echoed": []}

        with mock.patch.object(sw.sm, "write_through", return_value=None), \
                mock.patch.object(sw.sm, "tail", return_value={"seq": 0, "lines": []}), \
                mock.patch.object(sw.sm, "tail_bytes",
                                  return_value={"chunk_seq": 0, "chunks": []}), \
                mock.patch.object(sw.st, "roundtrip", side_effect=fake_roundtrip):
            r = sw.run(self.cfg, "f411", "ping", {"n": 7}, repeat=True)
        self.assertTrue(r["ok"])
        self.assertEqual(r["state"], "done")
        self.assertEqual(r["rounds"], 3)
        self.assertEqual(len(sent), 3)

    def test_pause_and_cancel_flags(self):
        """M2：暂停/取消只改标志位；未知任务如实报错。"""
        job = {"id": "j1", "widget": "ping", "state": "running",
               "cancel": False, "paused": False}
        sw._remember(job)
        try:
            p = sw.set_paused("j1", True)
            self.assertTrue(p["ok"])
            self.assertEqual(p["state"], "paused")
            c = sw.cancel("j1")
            self.assertEqual(c["state"], "cancelling")
            self.assertTrue(job["cancel"])
        finally:
            with sw._JOBS_LOCK:
                sw._JOBS.pop("j1", None)
                if "j1" in sw._JOB_ORDER:
                    sw._JOB_ORDER.remove("j1")
        self.assertFalse(sw.set_paused("j1", True)["ok"])

    def test_dry_run_does_not_touch_port(self):
        self.write_doc([_one_step()])
        with mock.patch.object(sw.sm, "write_through") as w:
            r = sw.run(self.cfg, "f411", "ping", {}, dry_run=True)
        w.assert_not_called()
        self.assertTrue(r["ok"])
        self.assertTrue(r["dry_run"])

    def test_busy_when_another_job_running(self):
        self.write_doc([_one_step()])
        self.assertTrue(sw._JOB_LOCK.acquire(blocking=False))
        try:
            r = sw.run(self.cfg, "f411", "ping", {})
        finally:
            sw._JOB_LOCK.release()
        self.assertEqual(r["stage"], "busy")

    def test_job_status_and_cancel(self):
        self.write_doc([])
        self.assertIsNone(sw.job_status("nope"))
        r = sw.cancel("nope")
        self.assertFalse(r["ok"])


# ══════════════════════════════════════════════════════════════════
#  发送框定时发送（run_raw）：瞬态任务、不落盘、与手发共用编码
# ══════════════════════════════════════════════════════════════════
class TestRaw(Base):
    def test_dry_run_reports_bytes_like_real_send(self):
        """dry_run 与实发共用 resolve_payload：预览字节就是实发字节。"""
        r = sw.run_raw(self.cfg, "f411", "0A FF", format="auto", dry_run=True)
        self.assertTrue(r["ok"])
        self.assertTrue(r["dry_run"])
        self.assertEqual(r["format"], "hex")
        self.assertEqual(r["eol_key"], "none")
        self.assertEqual(r["preview_hex"], "0A FF")
        self.assertEqual(r["bytes"], 2)

    def test_dry_run_does_not_touch_port(self):
        with mock.patch.object(sw.sm, "write_through") as w:
            sw.run_raw(self.cfg, "f411", "PING", format="utf8", dry_run=True)
        w.assert_not_called()

    def test_auto_text_keeps_eol_and_trailing_newline(self):
        r = sw.run_raw(self.cfg, "f411", "1234", format="auto",
                       eol="crlf", dry_run=True)
        self.assertTrue(r["ok"])
        self.assertEqual(r["format"], "utf8")
        self.assertEqual(r["eol_key"], "crlf")
        self.assertEqual(r["bytes"], 6)

    def test_interval_below_min_rejected(self):
        r = sw.run_raw(self.cfg, "f411", "PING", interval_ms=sw.MIN_REPEAT_MS - 1)
        self.assertEqual(r["stage"], "validate")
        self.assertIn("不能小于", r["error"])

    def test_interval_above_max_rejected(self):
        r = sw.run_raw(self.cfg, "f411", "PING",
                       interval_ms=sw.MAX_REPEAT_S * 1000 + 1)
        self.assertEqual(r["stage"], "validate")
        self.assertIn("不能大于", r["error"])

    def test_negative_count_rejected(self):
        r = sw.run_raw(self.cfg, "f411", "PING", interval_ms=100, count=-1)
        self.assertEqual(r["stage"], "validate")
        self.assertIn("负数", r["error"])

    def test_empty_data_rejected(self):
        r = sw.run_raw(self.cfg, "f411", "", interval_ms=100)
        self.assertEqual(r["stage"], "validate")

    def test_busy_when_another_job_running(self):
        self.assertTrue(sw._JOB_LOCK.acquire(blocking=False))
        try:
            r = sw.run_raw(self.cfg, "f411", "PING", interval_ms=100)
        finally:
            sw._JOB_LOCK.release()
        self.assertEqual(r["stage"], "busy")

    def test_raw_loop_runs_count_without_writing_widget_file(self):
        sent = []

        def fake_roundtrip(cfg, name, **kw):
            sent.append(kw["data"])
            return {"ok": True, "written": 8, "error": None,
                    "port": "COM10", "baud": 115200, "echoed": []}

        with mock.patch.object(sw.sm, "write_through", return_value=None), \
                mock.patch.object(sw.st, "roundtrip", side_effect=fake_roundtrip):
            journal = []
            r = sw.run_raw(self.cfg, "f411", "PING", format="utf8",
                           interval_ms=50, count=3,
                           journal=lambda rec: journal.append(rec))
        self.assertTrue(r["ok"])
        self.assertEqual(r["state"], "done")
        self.assertEqual(r["source"], "raw")
        self.assertEqual(r["label"], "发送框")
        self.assertEqual(r["rounds"], 3)
        self.assertEqual(sent, ["PING"] * 3)
        self.assertTrue(all(rec["via"] == "raw-loop" for rec in journal))
        # 不落盘：工程里没有 widgets 文件被创建
        self.assertFalse((self.root / "projects" / "f411.widgets.json").exists())

    def test_single_send_without_interval(self):
        with mock.patch.object(sw.sm, "write_through", return_value=6), \
                mock.patch.object(sw.sm, "status",
                                  return_value={"active": True, "port": "COM10",
                                                "baud": 115200}):
            r = sw.run_raw(self.cfg, "f411", "PING", format="utf8")
        self.assertTrue(r["ok"])
        self.assertEqual(r["source"], "raw")
        self.assertEqual(r["rounds"], 1)


if __name__ == "__main__":
    unittest.main()

