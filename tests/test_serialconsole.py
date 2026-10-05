"""M3-b2 串口 console 留档的守卫用例（离线，只碰临时文件）。

这个文件存在的理由，是它承载着一条**容易被忘掉的差别**：

    run 事件流   state 的唯一真相；只追加、**永不改写**；丢一条就是丢了
    console 日志  会话记录；**有上限、会滚动**；极旧的可能被丢掉

一旦有人把 console 当成 state 用（在它上面做增量同步、按它做验收判据），
滚动就会变成"数据凭空消失"。下面这些用例把"它就是这么设计的"钉死：
滚动保留尾部、坏行不阻塞整段读取、`count()` 与 `tail()` 的语义差别是**故意**的。
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for p in (str(ROOT), str(ROOT / "services")):
    if p not in sys.path:
        sys.path.insert(0, p)

from elab import serialconsole as sc          # noqa: E402
from elab import serialterm as st             # noqa: E402


class FakeCfg:
    """最小 Config 替身：`console_path_for` 只用得到 root / host / resolve。"""

    def __init__(self, root: str, *, runs_dir: str = ""):
        self.root = root
        self.host = {"cockpit": {"runs_dir": runs_dir}} if runs_dir else {}

    def resolve(self, spec: str, env: dict | None = None) -> str:
        # 与 config.Config.resolve 的关键行为一致：替换 ${ELAB_ROOT} 并认相对路径
        out = spec.replace("${ELAB_ROOT}", self.root)
        return out if Path(out).is_absolute() else str(Path(self.root) / out)


class Base(unittest.TestCase):
    """临时目录的用法与其他守卫用例保持一致（每例一个 `TemporaryDirectory`）。

    ★ 顺带记一笔实测：本机（Windows + 沙箱过滤驱动）**递归删目录约 300~400ms/条目**，
      所以这一套 26 例要跑 10s 上下 —— 慢的是文件系统，不是这些逻辑本身
      （`append` 2ms、`tail` 0.5ms）。将来有人想"提速"，别去动被测代码。
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def make(self, **kw) -> sc.ConsoleLog:
        return sc.ConsoleLog(self.dir / "serial-console.jsonl", **kw)


class TestConsolePathFor(Base):
    def test_default_is_sibling_of_runs_dir(self):
        """console 与 run 产物**同级** —— "一份运行产物集中在一个地方"。"""
        cfg = FakeCfg(str(self.dir))
        p = sc.console_path_for(cfg)
        self.assertEqual(p.name, "serial-console.jsonl")
        self.assertEqual(p.parent, self.dir / ".work" / ".cockpit")
        # 同级而非同一目录：runs 目录归 run，它归手写通道
        self.assertEqual(p.parent / "runs", self.dir / ".work" / ".cockpit" / "runs")

    def test_follows_host_override(self):
        """`cockpit.runs_dir` 一改，console 跟着走（否则会分裂成两份留档）。"""
        cfg = FakeCfg(str(self.dir), runs_dir="${ELAB_ROOT}/tmp/custom-runs")
        p = sc.console_path_for(cfg)
        self.assertEqual(p.parent, self.dir / "tmp")
        self.assertEqual(p.name, "serial-console.jsonl")


class TestAppend(Base):
    def test_stamps_time_and_keeps_fields(self):
        log = self.make()
        row = log.append({"dir": "tx", "text": "help", "ok": True})
        self.assertIn("ts", row)
        self.assertIn("t", row)
        self.assertEqual(row["dir"], "tx")
        self.assertEqual(row["text"], "help")
        self.assertIsInstance(row["ts"], float)

    def test_caller_fields_win_over_stamp(self):
        """显式传 ts 时**不**被覆盖 —— 否则将来做回填会时间错乱。"""
        log = self.make()
        row = log.append({"ts": 1.5, "t": "1970-01-01T00:00:01", "dir": "tx"})
        self.assertEqual(row["ts"], 1.5)

    def test_creates_missing_parent_dirs(self):
        log = sc.ConsoleLog(self.dir / "deep" / "nested" / "c.jsonl")
        log.append({"dir": "tx", "text": "x"})
        self.assertTrue((self.dir / "deep" / "nested" / "c.jsonl").exists())

    def test_unicode_round_trips(self):
        log = self.make()
        log.append({"dir": "rx", "text": "温度 25.3℃ ✓"})
        self.assertEqual(log.tail()[0]["text"], "温度 25.3℃ ✓")


class TestTail(Base):
    def test_missing_file_is_empty(self):
        self.assertEqual(self.make().tail(), [])
        self.assertEqual(self.make().count(), 0)

    def test_returns_newest_n_in_chronological_order(self):
        """最近 N 条，但**返回顺序仍是时间正序** —— 界面是追加渲染的。"""
        log = self.make()
        for i in range(10):
            log.append({"dir": "tx", "text": f"cmd{i}"})
        got = [r["text"] for r in log.tail(3)]
        self.assertEqual(got, ["cmd7", "cmd8", "cmd9"])

    def test_limit_zero_is_empty(self):
        log = self.make()
        log.append({"dir": "tx", "text": "x"})
        self.assertEqual(log.tail(0), [])

    def test_limit_over_count_is_all(self):
        log = self.make()
        log.append({"dir": "tx", "text": "x"})
        self.assertEqual(len(log.tail(999)), 1)

    def test_bad_lines_are_skipped_not_fatal(self):
        """文件被外部写坏时，一行读不出来**不该**让整段历史不可读。"""
        log = self.make()
        log.append({"dir": "tx", "text": "good1"})
        with log.path.open("a", encoding="utf-8") as fh:
            fh.write("{ 这不是 JSON\n")
            fh.write('"just a string"\n')      # 合法 JSON 但不是对象
            fh.write("\n")                      # 空行
        log.append({"dir": "tx", "text": "good2"})
        self.assertEqual([r["text"] for r in log.tail()], ["good1", "good2"])

    def test_count_counts_bad_lines_too(self):
        """★ `count()` 数的是**行**，`tail()` 给的是**能解析的**。

        两者之差是"有多少行读不出来"的**唯一**观测窗口 —— 刻意不额外造字段。
        若把 `count()` 也做成"只数好行"，这个差异就被抹平，坏行从此静默。
        """
        log = self.make()
        log.append({"dir": "tx", "text": "good"})
        with log.path.open("a", encoding="utf-8") as fh:
            fh.write("坏行\n")
        self.assertEqual(log.count(), 2)
        self.assertEqual(len(log.tail()), 1)


class TestRolling(Base):
    def test_roll_keeps_newest_records(self):
        """超上限时保留**尾部** `max_records` 条 —— 代价是丢最旧的，换来文件有界。"""
        log = self.make(max_bytes=1, max_records=5)   # 每次 append 都触发滚动
        for i in range(20):
            log.append({"dir": "tx", "text": f"cmd{i}"})
        self.assertEqual(log.count(), 5)
        self.assertEqual([r["text"] for r in log.tail()],
                         ["cmd15", "cmd16", "cmd17", "cmd18", "cmd19"])

    def test_roll_is_atomic_no_tmp_left(self):
        log = self.make(max_bytes=1, max_records=3)
        for i in range(9):
            log.append({"dir": "tx", "text": f"cmd{i}"})
        leftovers = list(log.path.parent.glob("*.tmp"))
        self.assertEqual(leftovers, [], f"滚动留下了临时文件：{leftovers}")

    def test_roll_only_when_over_bytes(self):
        """没超字节就不该滚动 —— 否则每次 append 都要读全文件（O(n) 变 O(n²)）。"""
        log = self.make(max_bytes=sc.MAX_BYTES, max_records=2)
        for i in range(6):
            log.append({"dir": "tx", "text": f"cmd{i}"})
        self.assertEqual(log.count(), 6)

    def test_rolled_file_stays_parseable(self):
        log = self.make(max_bytes=1, max_records=4)
        for i in range(12):
            log.append({"dir": "tx", "text": f"cmd{i}"})
        raw = log.path.read_text(encoding="utf-8")
        for ln in raw.splitlines():
            json.loads(ln)                       # 每行都必须是完整 JSON，不许截半行


class TestClear(Base):
    def test_clear_returns_count_and_removes(self):
        log = self.make()
        for i in range(3):
            log.append({"dir": "tx", "text": f"c{i}"})
        self.assertEqual(log.clear(), 3)
        self.assertEqual(log.count(), 0)
        self.assertFalse(log.path.exists())

    def test_clear_on_missing_is_zero(self):
        self.assertEqual(self.make().clear(), 0)

    def test_append_after_clear_works(self):
        log = self.make()
        log.append({"dir": "tx", "text": "a"})
        log.clear()
        log.append({"dir": "tx", "text": "b"})
        self.assertEqual([r["text"] for r in log.tail()], ["b"])


class TestJournalFor(Base):
    def test_attaches_project_to_every_record(self):
        """闭包捕获 project：端口会复用，工程不会 —— 按工程过滤历史才不丢信息。"""
        cfg = FakeCfg(str(self.dir))
        j = sc.journal_for(cfg, project="at32f421g8u7")
        j({"dir": "tx", "text": "help"})
        j({"dir": "rx", "text": "[alive] tick=1"})
        recs = sc.ConsoleLog(sc.console_path_for(cfg)).tail()
        self.assertEqual([r["project"] for r in recs], ["at32f421g8u7"] * 2)

    def test_default_project_is_empty_string(self):
        cfg = FakeCfg(str(self.dir))
        sc.journal_for(cfg)({"dir": "tx", "text": "x"})
        self.assertEqual(sc.ConsoleLog(sc.console_path_for(cfg)).tail()[0]["project"], "")

    def test_returns_none(self):
        """回调必须返回 `None`（`roundtrip` 不依赖返回值，别让它以为有协议）。"""
        cfg = FakeCfg(str(self.dir))
        self.assertIsNone(sc.journal_for(cfg)({"dir": "tx", "text": "x"}))


class TestJournalCallback(unittest.TestCase):
    """`serialterm._journal`：从**结果**生成记录。

    这条设计的价值在于"**恰好**一对 (TX, RX*)"：无论从哪条早退路径返回，
    都不会漏记，也不会因为将来多一条 `return` 就少记一笔。
    """

    def test_success_writes_tx_then_rx_per_line(self):
        got = []
        st._journal(got.append,
                    {"ok": True, "port": "COM10", "baud": 115200, "written": 6,
                     "payload_bytes": 6, "echoed": ["a", "b"], "error": None},
                    data="status", hex_=False, newline=True, log=lambda *a: None)
        self.assertEqual([r["dir"] for r in got], ["tx", "rx", "rx"])
        self.assertEqual(got[0]["text"], "status")
        self.assertEqual(got[0]["written"], 6)
        self.assertEqual(got[1]["text"], "a")
        self.assertEqual(got[1]["port"], "COM10")

    def test_failure_still_writes_exactly_one_tx(self):
        """失败也要留痕 —— 否则"我敲过这一行"这件事会从历史上消失。"""
        got = []
        st._journal(got.append,
                    {"ok": False, "port": "", "baud": 0, "written": 0,
                     "payload_bytes": 0, "echoed": [], "error": "串口操作失败：打不开"},
                    data="help", hex_=False, newline=True, log=lambda *a: None)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["dir"], "tx")
        self.assertFalse(got[0]["ok"])
        self.assertIn("打不开", got[0]["error"])

    def test_journal_exception_does_not_escape(self):
        """每次操作都落一条：写日志失败**不许**改变"命令已经发出去了"这个事实。"""
        seen = []

        def boom(_rec):
            raise OSError("磁盘满")

        st._journal(boom, {"ok": True, "port": "COM1", "baud": 9600, "echoed": ["x"]},
                    data="a", hex_=False, newline=True, log=seen.append)
        self.assertTrue(any("磁盘满" in str(x) for x in seen))

    def test_no_journal_is_a_noop(self):
        st._journal(None, {"ok": True}, data="a", hex_=False, newline=True)  # 不抛即可


if __name__ == "__main__":
    unittest.main(verbosity=2)
