"""cockpit 的两条"真相纪律"的守卫用例（stdlib unittest，无需 pytest）。

跑：``python tests/test_cockpit_backpressure.py``

## 守的是什么

1. **背压丢弃必须留痕**（契约 §3.2 / §17.3）。
   服务端在 SSE 队列满时丢弃活动事件是**允许**的，但**不允许**悄悄丢。
   旧实现只写 ``ar.dropped += 1`` 然后 continue —— 于是"丢了多少"只有服务端
   自己知道，界面上一个像素都没变。这正是本仓库反复出现的**静默丢事件**：
   服务端全对、HTTP 全 200、日志无一行报错，只有那块 UI 少了内容。
   这里断言"丢弃一定伴随一条 ``stream/overrun``"，并且**一个溢出 episode 只报一次**
   （否则标记会把真实内容全挤出去，比不报还瞎）。

2. **``run/*`` 绝不丢**（契约 §3.2）。它是界面状态的唯一真相，
   丢了界面就再也回不到正确状态。队列满时必须**挤掉队首的活动行**给它让位。

3. **run 元数据以事件日志为准**（契约 §5.3）。
   ``project``/``steps``/``actor``/``started_at`` 在 ``run/start`` 里逐字都有，
   内存那份只是"子进程还没落盘"的临时占位。这份用例故意让两份**不一致**，
   断言对外报的是**日志那份**，并把来源标成 ``meta_source``。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))

from cockpit import server as srv                    # noqa: E402
from elab.kernel import events as ev_mod             # noqa: E402


# ── 极简替身 ─────────────────────────────────────────────────────
class FakeProc:
    """只提供 `_active` 与 `list_active` 用到的那点接口。"""

    def __init__(self, pid: int = 4242, alive: bool = True):
        self.pid = pid
        self._alive = alive
        self._rc = None

    def poll(self):
        if self._alive:
            return None
        return 0 if self._rc is None else self._rc

    def kill(self):                                   # 某些下游会调
        self._alive = False


class FakeCfg:
    host: dict = {}

    def __init__(self, root: Path):
        self.root = root
        self.projects: dict = {}
        self.chips: dict = {}

    def resolved_project(self, name):
        return {}

    def resolve(self, s, ctx=None):
        return s


def _drain(q) -> list[dict]:
    out = []
    while True:
        try:
            out.append(q.get_nowait())
        except Exception:                             # noqa: BLE001 —— queue.Empty
            return out


def _topics(items) -> list[str]:
    return [i.get("topic", "") for i in items]


class BackpressureBase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.mgr = srv.RunManager(FakeCfg(self.root), log=lambda *a: None)
        self.mgr.runs_dir.mkdir(parents=True, exist_ok=True)
        self.ar = srv.ActiveRun(
            run_id="r-bp000001", project="mem_project", steps=["doctor", "build"],
            actor="human", proc=FakeProc(), started_at=1000.0)
        with self.mgr._lock:
            self.mgr._active[self.ar.run_id] = self.ar

    def tearDown(self):
        self.tmp.cleanup()

    # ── 工具 ────────────────────────────────────────────────────
    def _fill(self, q) -> None:
        """把队列灌满（模拟"客户端太慢"）。"""
        while True:
            try:
                q.put_nowait({"topic": "proc/stdout", "seq": 0, "line": "x"})
            except Exception:                         # noqa: BLE001
                return

    def _proc_ev(self, seq: int) -> dict:
        return {"topic": "proc/stdout", "seq": seq, "line": f"line {seq}",
                "step": "build", "run": self.ar.run_id}

    def _markers(self, q) -> list[dict]:
        return [i for i in _drain(q) if i.get("topic") == "stream/overrun"]


class TestActivityDropLeavesATrace(BackpressureBase):

    def test_drop_increments_counter_and_emits_overrun(self):
        q = self.mgr.subscribe(self.ar.run_id)
        self._fill(q)
        self.assertEqual(self.ar.dropped, 0)

        self.mgr._fanout(self.ar, self._proc_ev(7))

        self.assertEqual(self.ar.dropped, 1, "丢弃必须计数（/api/runs.active 读它）")
        markers = self._markers(q)
        self.assertEqual(len(markers), 1, "丢弃必须伴随一条 stream/overrun")
        self.assertEqual(markers[0]["topic_scope"], "proc/*")
        self.assertEqual(markers[0]["dropped"], 1)
        self.assertEqual(markers[0]["reason"], "sse-queue-full")

    def test_only_one_marker_per_episode(self):
        """★ 同一溢出 episode 只报一次 —— 否则队列里全是标记，真实内容全被挤掉。"""
        q = self.mgr.subscribe(self.ar.run_id)
        self._fill(q)
        for i in range(50):
            self.mgr._fanout(self.ar, self._proc_ev(10 + i))

        self.assertEqual(self.ar.dropped, 50)
        markers = self._markers(q)
        self.assertEqual(len(markers), 1, f"50 次丢弃只该有 1 个标记，实得 {len(markers)}")
        # 标记内的 dropped 是**就地更新**的同一个 dict → 读到的是最新值
        self.assertEqual(markers[0]["dropped"], 50)

    def test_new_episode_reports_again(self):
        """队列恢复（客户端追上了）之后的**新一轮**溢出必须重新报。"""
        q = self.mgr.subscribe(self.ar.run_id)
        self._fill(q)
        self.mgr._fanout(self.ar, self._proc_ev(1))
        self.assertEqual(len(self._markers(q)), 1)

        # 让一次 put 成功 → 解除 armed
        _drain(q)
        self.mgr._fanout(self.ar, self._proc_ev(2))
        self.mgr._fanout(self.ar, self._proc_ev(3))
        self.assertNotIn("stream/overrun", _topics(_drain(q)))

        # 再次灌满 → 新的 episode 应重新报
        self._fill(q)
        self.mgr._fanout(self.ar, self._proc_ev(4))
        self.assertEqual(len(self._markers(q)), 1, "新 episode 必须重新留痕")

    def test_run_events_are_never_dropped(self):
        """`run/*` 是状态唯一真相 —— 队列满时必须挤掉活动行给它让位。"""
        q = self.mgr.subscribe(self.ar.run_id)
        self._fill(q)
        end = {"topic": "run/end", "seq": 99, "ok": True, "run": self.ar.run_id}

        self.mgr._fanout(self.ar, end)

        items = _drain(q)
        self.assertIn("run/end", _topics(items), "run/* 绝不能丢")
        self.assertEqual(self.ar.dropped, 1, "让位时被挤掉的那条也是真丢了，要计数")

    def test_stream_closed_is_never_dropped(self):
        """★ ``stream/closed`` 的 ``is_activity()`` 是 True，但它是**控制帧**。

        它是浏览器唯一的"run 结束、可以收尾了"信号。丢掉它 → ``markStreamClosed``
        永不触发 → 界面**永远显示"运行中"**，而进程早就没了；唯一兜底是
        心跳分支（≈2 分钟）后断开重连。症状是"卡住"而不是"报错"，
        所以这条断言值得单独钉住。
        """
        self.assertTrue(ev_mod.is_activity("stream/closed"),
                        "前提：它确实落在 activity 通道 —— 所以必须靠白名单兜住")
        q = self.mgr.subscribe(self.ar.run_id)
        self._fill(q)

        self.mgr._fanout(self.ar, {"topic": "stream/closed", "seq": 99,
                                   "reason": "run-finished", "rc": 0})

        self.assertIn("stream/closed", _topics(_drain(q)),
                      "控制帧被丢了 → 界面会永远停在'运行中'")


class TestSubscriberStateHygiene(BackpressureBase):

    def test_unsubscribe_clears_sub_state(self):
        """★ sub_state 用 `id(q)` 当键：不清就是"地址将被复用"的隐患 ——
        新队列落到同一地址会被误判成"已报过溢出"，真正的溢出反而报不出来。"""
        q = self.mgr.subscribe(self.ar.run_id)
        self._fill(q)
        self.mgr._fanout(self.ar, self._proc_ev(1))
        self.assertIn(id(q), self.ar.sub_state)

        self.mgr.unsubscribe(self.ar.run_id, q)
        self.assertNotIn(id(q), self.ar.sub_state)
        self.assertNotIn(q, self.ar.subscribers)

    def test_no_subscribers_is_a_noop(self):
        self.mgr._fanout(self.ar, self._proc_ev(1))          # 不该抛
        self.assertEqual(self.ar.dropped, 0)


class TestListActivePrefersTheLog(BackpressureBase):

    def _write_start(self, project: str, steps: list[str], actor: str, ts: float):
        ev = {"ts": ts, "run": self.ar.run_id, "topic": "run/start", "seq": 1,
              "actor": actor, "project": project, "steps": steps}
        (self.mgr.runs_dir / f"{self.ar.run_id}.jsonl").write_text(
            json.dumps(ev, ensure_ascii=False) + "\n", encoding="utf-8")

    def test_meta_comes_from_event_log(self):
        """内存说 `mem_project/[doctor,build]/human`，日志说别的 → **必须报日志那份**。"""
        self._write_start("at32f421g8u7", ["doctor", "build", "monitor"],
                          "agent", 1759570023.4)
        rows = self.mgr.list_active()
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["project"], "at32f421g8u7")
        self.assertEqual(r["steps"], ["doctor", "build", "monitor"])
        self.assertEqual(r["actor"], "agent")
        self.assertEqual(r["started_at"], 1759570023.4)
        self.assertEqual(r["meta_source"], "event-log")
        # 进程内独占的字段仍然来自内存（日志里没有也不该有）
        self.assertEqual(r["pid"], 4242)
        self.assertTrue(r["alive"])

    def test_provisional_when_log_not_written_yet(self):
        """子进程刚 spawn、首行还没落盘 → 用内存占位，但**标明**来源。"""
        rows = self.mgr.list_active()
        self.assertEqual(rows[0]["project"], "mem_project")
        self.assertEqual(rows[0]["meta_source"], "provisional")

    def test_first_line_that_is_not_start_is_not_guessed(self):
        """首行不是 run/start（文件被人改过）→ 不猜，退回 provisional。"""
        (self.mgr.runs_dir / f"{self.ar.run_id}.jsonl").write_text(
            '{"ts":1,"run":"r-bp000001","topic":"run/end","seq":1,"actor":"agent"}\n',
            encoding="utf-8")
        rows = self.mgr.list_active()
        self.assertEqual(rows[0]["meta_source"], "provisional")

    def test_finished_runs_are_excluded(self):
        self._write_start("p", ["build"], "agent", 1.0)
        self.ar.proc._alive = False
        self.assertEqual(self.mgr.list_active(), [])

    def test_sorted_by_started_at_desc(self):
        self._write_start("older", ["build"], "agent", 1.0)
        ar2 = srv.ActiveRun(run_id="r-bp000002", project="m2", steps=["build"],
                            actor="human", proc=FakeProc(pid=7), started_at=2000.0)
        (self.mgr.runs_dir / "r-bp000002.jsonl").write_text(
            json.dumps({"ts": 2000.0, "run": "r-bp000002", "topic": "run/start",
                        "seq": 1, "actor": "human", "project": "newer",
                        "steps": ["build"]}) + "\n", encoding="utf-8")
        with self.mgr._lock:
            self.mgr._active[ar2.run_id] = ar2
        rows = self.mgr.list_active()
        self.assertEqual([r["project"] for r in rows], ["newer", "older"])


class TestCapabilitiesMirrorsTopics(unittest.TestCase):
    """跨端白名单：服务端**可能发出**的每个 topic，前端都必须订阅。

    这里只做"服务端内部自洽"的那一半（``SSE_TOPICS`` ⊇ 实际发出的 topic 集合）；
    与前端 `KNOWN_TOPICS` 的集合比对在 ``it_cockpit_server.py`` 里（要读 TS 文件）。
    """

    def test_stream_overrun_is_registered(self):
        self.assertIn("stream/overrun", srv.SSE_TOPICS,
                      "stream/overrun 未登记 → _sse_warn_unknown 会 WARN，"
                      "且浏览器 KNOWN_TOPICS 对不上就会**静默丢弃**")
        self.assertIn(ev_mod.STREAM_OVERRUN, ev_mod.KNOWN_TOPICS)

    def test_overrun_is_classified_as_activity(self):
        """它属于"可丢"通道（它描述的就是丢事件），走 `.proc.jsonl`。"""
        self.assertTrue(ev_mod.is_activity("stream/overrun"))
        self.assertFalse(ev_mod.is_persisted("stream/overrun"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
