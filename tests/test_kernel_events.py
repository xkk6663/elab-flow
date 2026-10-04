"""kernel/events.py 的契约验证（stdlib unittest，无需 pytest）。

跑：``python -m unittest discover -s tests`` 或 ``python tests/test_kernel_events.py``

重点验证**两条被整套设计依赖的性质**——它们一旦破了，
"断线续传"和"事件是唯一真相"会同时失效，而且失效得很安静：
  ① seq 的**连续前缀**性质（跨文件直接比 seq 就能定序）
  ② 删掉 ``.proc.jsonl`` 只损失日志、**不影响状态重建**
"""

from __future__ import annotations

import json
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))

from elab.kernel import events as ev_mod           # noqa: E402
from elab.kernel.events import EventLog, RingBuffer  # noqa: E402


def _read_jsonl(path: Path) -> list[dict]:
    if not Path(path).exists():
        return []
    out = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if raw:
            out.append(json.loads(raw))
    return out


class TestEnvelope(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.runs = Path(self.tmp.name) / "runs"
        self.log = EventLog(self.runs, project="p", log=lambda *a: None)

    def tearDown(self):
        self.log.close()
        self.tmp.cleanup()

    def test_run_id_shape(self):
        self.assertRegex(self.log.run_id, r"^r-[0-9a-f]{8}$")

    def test_envelope_keys_and_order(self):
        e = self.log.start(["doctor"], project="at32_test")
        self.assertEqual(list(e.keys())[:5], ["ts", "run", "topic", "seq", "actor"])
        self.assertEqual(e["topic"], "run/start")
        self.assertEqual(e["seq"], 1)
        self.assertEqual(e["actor"], "agent")
        self.assertEqual(e["project"], "at32_test")
        self.assertEqual(e["steps"], ["doctor"])

    def test_actor_required(self):
        with self.assertRaises(ValueError):
            self.log.emit("run/start", actor="")

    def test_seq_starts_at_1_and_is_global_across_topics(self):
        self.log.start([])
        self.log.step_enter("doctor", 0, 1)
        self.log.proc("doctor", "hello")
        self.log.step_exit("doctor", True, "全绿", 0.4)
        self.log.end(True, ["doctor"], [])
        seqs = [e["seq"] for e in _read_jsonl(self.log.state_path)] + \
               [e["seq"] for e in _read_jsonl(self.log.proc_path)]
        # 跨两个文件合起来必须是 1..5 且不重不漏
        self.assertEqual(sorted(seqs), [1, 2, 3, 4, 5])


class TestChannels(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.log = EventLog(Path(self.tmp.name), project="p")

    def tearDown(self):
        self.log.close()
        self.tmp.cleanup()

    def test_only_run_goes_to_state(self):
        self.log.start([])                       # run/*  → state
        self.log.proc("build", "line")           # proc/* → activity
        self.log.emit("stream/overrun", dropped=3)
        self.assertEqual([e["topic"] for e in _read_jsonl(self.log.state_path)],
                         ["run/start"])
        act = [e["topic"] for e in _read_jsonl(self.log.proc_path)]
        self.assertEqual(act, ["proc/stdout", "stream/overrun"])

    def test_serial_line_duplicated_to_raw_log(self):
        self.log.emit("serial/open", port="COM10", baud=115200)
        self.log.emit("serial/line", line="[alive] tick=1", t=0.9)
        raw = self.log.serial_path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(raw, ["[alive] tick=1"])       # 纯文本，不是 JSON
        # 结构化那条同时也在 activity 通道里（前端靠这个拿元数据）
        topics = [e["topic"] for e in _read_jsonl(self.log.proc_path)]
        self.assertIn("serial/line", topics)

    def test_channel_helpers(self):
        self.assertTrue(ev_mod.is_persisted("run/end"))
        self.assertFalse(ev_mod.is_persisted("proc/stdout"))
        self.assertTrue(ev_mod.is_activity("serial/line"))
        self.assertEqual(ev_mod.channel_of("stream/overrun"), "proc")


class TestSeqPrefixProperty(unittest.TestCase):
    """★ 性质①：多线程写入下，已落盘集合恒为 seq 的连续前缀。"""

    def test_concurrent_emit_yields_contiguous_prefix(self):
        with TemporaryDirectory() as d:
            log = EventLog(Path(d), project="p", ring_capacity=10_000)
            N_THREADS, N_EACH = 8, 120

            def worker(tid):
                for i in range(N_EACH):
                    log.proc(f"t{tid}", f"{tid}-{i}")

            ts = [threading.Thread(target=worker, args=(t,)) for t in range(N_THREADS)]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
            log.close()

            seqs = [e["seq"] for e in _read_jsonl(log.proc_path)]
            total = N_THREADS * N_EACH
            self.assertEqual(len(seqs), total, "有事件丢失")
            self.assertEqual(len(set(seqs)), total, "出现重复 seq")
            # 连续前缀：排序后必须恰好是 1..total
            self.assertEqual(sorted(seqs), list(range(1, total + 1)))

    def test_concurrent_emit_proc_lines_not_interleaved(self):
        """同一行不能被两个线程写坏（每行必须是完整 JSON）。"""
        with TemporaryDirectory() as d:
            log = EventLog(Path(d), project="p", ring_capacity=10_000)

            def worker(tid):
                for i in range(80):
                    log.proc(f"t{tid}", f"line-{tid}-{i}")

            ts = [threading.Thread(target=worker, args=(t,)) for t in range(6)]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
            log.close()
            # _read_jsonl 内部用 json.loads，任何半行都会抛异常 → 到这里即证明行完整
            self.assertEqual(len(_read_jsonl(log.proc_path)), 6 * 80)


class TestProcFileDeletable(unittest.TestCase):
    """★ 性质②：删掉 .proc.jsonl 只损失日志，不影响状态重建（契约 §5.2 判据）。"""

    def test_state_rebuild_survives_proc_deletion(self):
        with TemporaryDirectory() as d:
            runs = Path(d)
            log = EventLog(runs, project="at32_test")
            log.start(["doctor", "build"])
            for step, ok in (("doctor", True), ("build", True)):
                log.step_enter(step, 0, 2)
                for i in range(50):
                    log.proc(step, f"[{i}/50] compiling...")
                log.step_exit(step, ok, "FLASH 7.39%", 1.23)
            log.end(True, ["doctor", "build"], [])
            rid = log.run_id
            log.close()

            before = [e for e in _read_jsonl(runs / f"{rid}.jsonl")]
            (runs / f"{rid}.proc.jsonl").unlink()          # ← 删掉活动日志
            after = [e for e in _read_jsonl(runs / f"{rid}.jsonl")]

            self.assertEqual(before, after)
            # 状态可完整重建
            steps = [e["step"] for e in after if e["topic"] == "run/step-exit"]
            self.assertEqual(steps, ["doctor", "build"])
            meta = ev_mod.list_runs(runs)[0]
            self.assertEqual(meta["status"], "ok")
            self.assertEqual(meta["steps"], ["doctor", "build"])


class TestReplayFollow(unittest.TestCase):
    def _make(self, runs: Path) -> str:
        log = EventLog(runs, project="p")
        log.start(["a"])
        for i in range(5):
            log.proc("a", f"out-{i}")
        log.step_enter("a", 0, 1)
        log.step_exit("a", True, "ok", 0.1)
        log.end(True, ["a"])
        rid = log.run_id
        log.close()
        return rid

    def test_replay_after_seq(self):
        """``replay`` 是**单文件**语义；``read_run`` 才是合并两文件的语义。

        这个区别很容易被踩错：拿 replay(state.jsonl) 的结果去对
        "所有事件"做断言，会得到"丢了一大半"的错觉。
        """
        with TemporaryDirectory() as d:
            runs = Path(d)
            rid = self._make(runs)

            state = _read_jsonl(runs / f"{rid}.jsonl")
            # 单文件：state.jsonl 里 seq>2 的恰好是 step-enter/step-exit/run-end
            tail = list(ev_mod.replay(runs / f"{rid}.jsonl", 2))
            self.assertEqual([e["seq"] for e in tail],
                             [e["seq"] for e in state if e["seq"] > 2])
            self.assertTrue(all(e["topic"].startswith("run/") for e in tail))

            # 合并：必须把 proc/* 也带上
            merged = ev_mod.read_run(runs, rid, after_seq=2)
            self.assertTrue(all(e["seq"] > 2 for e in merged))
            self.assertEqual(len(merged),
                             len([e for e in ev_mod.read_run(runs, rid) if e["seq"] > 2]))
            self.assertTrue(any(e["topic"] == "proc/stdout" for e in merged))

    def test_replay_missing_file_is_empty(self):
        """文件还不存在时不许抛异常（服务端在 run 刚 spawn 时就会来读）。"""
        with TemporaryDirectory() as d:
            self.assertEqual(list(ev_mod.replay(Path(d) / "nope.jsonl", 0)), [])

    def test_follow_merges_two_files_in_seq_order(self):
        with TemporaryDirectory() as d:
            runs = Path(d)
            rid = self._make(runs)
            got = list(ev_mod.follow(ev_mod.run_paths(runs, rid), after_seq=0,
                                     stop=lambda: True, poll=0.01))
            seqs = [e["seq"] for e in got]
            self.assertEqual(seqs, sorted(seqs), "跨文件归并后 seq 不是升序")
            self.assertEqual(len(set(seqs)), len(seqs), "归并出现重复")
            # 必须同时收到两个文件的全部事件
            self.assertEqual(len(seqs), len(ev_mod.read_run(runs, rid)))

    def test_follow_ignores_half_written_line(self):
        """写到一半的行要能被跳过，且下一轮补齐后不重复不丢失。"""
        with TemporaryDirectory() as d:
            runs = Path(d)
            p = runs / "r-00000000.jsonl"
            runs.mkdir(parents=True, exist_ok=True)
            good = {"ts": 1.0, "run": "r-00000000", "topic": "run/start",
                    "seq": 1, "actor": "agent", "project": "p", "steps": []}
            p.write_text(json.dumps(good) + "\n" + '{"ts":2.0,"run":"r-000', encoding="utf-8")
            got = list(ev_mod.follow([p], stop=lambda: True, poll=0.01))
            self.assertEqual([e["seq"] for e in got], [1])

    def test_list_runs_statuses(self):
        with TemporaryDirectory() as d:
            runs = Path(d)
            rid_ok = self._make(runs)
            # 一个"未结束"的 run
            dangling = EventLog(runs, project="q")
            dangling.start(["build"])
            dangling.close()
            metas = {m["run"]: m for m in ev_mod.list_runs(runs)}
            self.assertEqual(metas[rid_ok]["status"], "ok")
            self.assertEqual(metas[dangling.run_id]["status"], "running")
            self.assertEqual(metas[rid_ok]["project"], "p")


class TestRingBuffer(unittest.TestCase):
    def test_bounded_and_oldest_drops(self):
        r = RingBuffer(capacity=3)
        for i in range(10):
            r.append(i)
        self.assertEqual(r.snapshot(), [7, 8, 9])
        self.assertEqual(len(r), 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
