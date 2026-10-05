"""monitor.judge() 的判据引擎验证（stdlib unittest，无需 pytest，无需硬件）。

跑：``python tests/test_monitor_judge.py`` 或 ``python -m unittest discover -s tests``

## 为什么这个文件必须存在（它是一次真实的"文档说有、仓库里没有"事故的产物）

``monitor.py`` 的 docstring 写着两条铁律"**均由单测用例②/⑨ 抓出后才固化**"，
``README.md`` 与 ``docs/技术方案_闭环驾驶舱.md`` 也都声称判据引擎"单测 12/12"。
但在 M3 收口时核对仓库，**这个文件（或任何含 ``judge`` 的测试）并不存在** ——
声称的用例跑在会话临时文件里，从未入库。

后果不是"少几个测试"，而是：**那两条铁律的修复完全无守卫**。
`fail_on` 的"绝对优先"与 `settle_s` 的"ok 后再观察"都是**容易被后来者"顺手简化掉"**
的写法（它们看起来可以合并成一个逐行 if），一旦被改回去，
症状是"HardFault 的板子被报成通过"——一个**假通过**，比失败更难发现。

故本文件把"判据引擎的三态语义 + 两条铁律"逐条固化。它的价值在于
**可以离线复现**：不插板、不开串口，纯函数入参出参。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))

from elab import monitor as mon                     # noqa: E402


def R(kind: str = "regex", pattern: str = "", within_s: float = 0.0,
      n: int = 0) -> mon.Rule:
    return mon.Rule(kind=kind, pattern=pattern, within_s=within_s, n=n)


CLOSE = [R("regex", r"^\[(boot|alive)\]", within_s=10.0)]
FAIL = [R("regex", r"HardFault|Hard Fault|assert|PANIC")]


def J(lines, close=None, fail=None, *, idle=0.0, elapsed=0.0):
    return mon.judge(list(lines), CLOSE if close is None else close,
                     FAIL if fail is None else fail,
                     idle_timeout_s=idle, elapsed_s=elapsed)


# ══════════════════════════════════════════════════════════════════
#  三态：ok / failed / inconclusive
# ══════════════════════════════════════════════════════════════════
class TestThreeStates(unittest.TestCase):
    """★ 核心语义：**缺证据 ≠ 失败**。塌成两态是本模块最严重的退化。"""

    def test_ok_on_banner(self):
        st, why, ev = J([(0.9, "[alive] tick=1")])
        self.assertEqual(st, "ok")
        self.assertIn("close_on", why)
        self.assertEqual(ev[0]["line"], "[alive] tick=1")
        self.assertEqual(ev[0]["verdict"], "ok")

    def test_ok_on_boot_banner(self):
        st, _, ev = J([(0.4, "[boot] at32f421g8u7 ok, sysclk=120000000 Hz")])
        self.assertEqual(st, "ok")
        self.assertEqual(ev[0]["rule"], "regex:^\\[(boot|alive)\\] within_s=10")

    def test_inconclusive_when_silent(self):
        """一个字节都没收到 → inconclusive（固件没 printf 不是"崩了"）。"""
        st, why, ev = J([])
        self.assertEqual(st, "inconclusive")
        self.assertIn("一个字节都没收到", why)
        self.assertEqual(ev, [])

    def test_inconclusive_when_talking_but_wrong_words(self):
        """★ 真机实测过的形态：板子跑的是别的固件，会说话但没说约定关键字。"""
        st, why, _ = J([(0.5, "[I][80000] heartbeat tick=80000 high_loop=3201063")])
        self.assertEqual(st, "inconclusive")
        self.assertIn("没有任何一行命中", why)

    def test_inconclusive_when_no_rules_declared(self):
        """工程没声明判据 → 不假装成功，也不冤枉它失败。"""
        st, why, _ = J([(0.5, "anything")], close=[], fail=[])
        self.assertEqual(st, "inconclusive")
        self.assertIn("未声明任何 monitor 判据", why)

    def test_failed_on_hardfault(self):
        st, why, ev = J([(0.5, "*** HardFault ***")])
        self.assertEqual(st, "failed")
        self.assertEqual(ev[0]["verdict"], "failed")
        self.assertIn("fail_on", why)


# ══════════════════════════════════════════════════════════════════
#  铁律 ①：fail_on 对整个缓冲区**绝对优先**
# ══════════════════════════════════════════════════════════════════
class TestFailOnHasAbsolutePriority(unittest.TestCase):
    """★ 这条是**假通过**的唯一防线，最容易被"顺手简化"掉。

    若按"逐行谁先命中谁赢"实现，下面第 1 个用例会返回 ok ——
    一块**先报活、0.6s 后崩溃**的板子被报成通过。所以它必须在**每一行都扫完**
    fail_on 之后，才轮到 close_on。
    """

    def test_alive_then_hardfault_is_failed(self):
        st, why, ev = J([(0.9, "[alive] tick=1"), (1.5, "*** HardFault ***")])
        self.assertEqual(st, "failed", "先报活后崩溃必须判 failed，绝不能 ok")
        self.assertIn("HardFault", ev[0]["line"])

    def test_fail_evidence_is_the_failing_line_not_the_ok_line(self):
        _, _, ev = J([(0.9, "[alive] tick=1"), (1.5, "assert failed at main.c:88")])
        self.assertEqual(ev[0]["line"], "assert failed at main.c:88")
        self.assertEqual(ev[0]["t"], 1.5)

    def test_same_line_hitting_both_wins_failed(self):
        """同一行同时命中 close_on 与 fail_on → failed（契约 §16.4）。"""
        st, _, _ = J([(0.3, "[alive] then HardFault")],
                     fail=[R("regex", "HardFault")])
        self.assertEqual(st, "failed")

    def test_hardfault_long_before_ok_still_failed(self):
        st, _, _ = J([(0.3, "PANIC"), (1.2, "[alive] tick=1")])
        self.assertEqual(st, "failed")

    def test_ok_when_no_fail_line(self):
        """对照组：没有失败行时，fail_on 不能误伤。"""
        st, _, _ = J([(0.9, "[alive] tick=1"), (1.4, "[alive] tick=2")])
        self.assertEqual(st, "ok")


# ══════════════════════════════════════════════════════════════════
#  铁律 ②：ok 命中后仍需观察 settle_s（抓"刚报活就崩"）
# ══════════════════════════════════════════════════════════════════
class TestSettleWindow(unittest.TestCase):
    """**在这层怎么体现**：``judge()`` 是纯函数，没有"何时收工"的概念——
    settle 由 ``run()`` 的读循环实现（命中 ok 后继续收 ``settle_s`` 秒）。

    故这里验的是 settle **依赖的另一半**：只要 ok 之后还有行进来，
    ``judge()`` 每一次调用都会重新全扫 fail_on。也就是说
    "命中 ok 就再也不看后续"这种实现不可能通过上面的用例 —— 两半合起来
    才等价于"不假通过"。本类用"分帧调用"把这个过程显式化。
    """

    def test_rejudge_after_ok_can_flip_to_failed(self):
        buf: list[tuple[float, str]] = []
        # 第 1 帧：只有 alive → ok（此时 run() 会记下 ok_at，继续观察）
        buf.append((0.9, "[alive] tick=1"))
        st1, _, _ = J(buf)
        self.assertEqual(st1, "ok")
        # 第 2 帧：settle 窗口内崩了 → 同一缓冲区重判必须翻盘
        buf.append((1.4, "*** HardFault ***"))
        st2, _, ev2 = J(buf)
        self.assertEqual(st2, "failed", "settle 窗口内的崩溃必须能翻盘")
        self.assertEqual(ev2[0]["line"], "*** HardFault ***")

    def test_settle_default_and_override(self):
        self.assertEqual(mon.DEFAULT_SETTLE_S, 1.5)


# ══════════════════════════════════════════════════════════════════
#  idle_timeout：有输出后静默超时 → failed（**正面**失败证据）
# ══════════════════════════════════════════════════════════════════
class TestIdleTimeout(unittest.TestCase):
    def test_silent_after_talking_is_failed(self):
        st, why, ev = J([(0.5, "config ok")], idle=3.0, elapsed=10.0)
        self.assertEqual(st, "failed")
        self.assertIn("静默", why)
        self.assertEqual(ev[0]["verdict"], "failed")

    def test_within_idle_window_is_inconclusive_not_failed(self):
        """★ 铁律：静默**未超窗**时不能判 failed —— 只是还没说出来。"""
        st, _, _ = J([(0.5, "config ok")], idle=30.0, elapsed=10.0)
        self.assertEqual(st, "inconclusive")

    def test_idle_not_armed_without_lines(self):
        """一行都没收到时，idle 超时不该被解释成"挂死"（从来就没活过）。"""
        st, why, _ = J([], idle=3.0, elapsed=99.0)
        self.assertEqual(st, "inconclusive")
        self.assertIn("一个字节都没收到", why)


# ══════════════════════════════════════════════════════════════════
#  within_s：过期判据不得回补命中
# ══════════════════════════════════════════════════════════════════
class TestWithinS(unittest.TestCase):
    def test_late_ok_line_is_not_a_hit(self):
        st, _, _ = J([(12.0, "[alive] tick=1")])       # close_on 的 within_s=10
        self.assertEqual(st, "inconclusive")

    def test_on_deadline_is_a_hit(self):
        st, _, _ = J([(10.0, "[alive] tick=1")])
        self.assertEqual(st, "ok")

    def test_fail_on_is_not_gated_by_within_s(self):
        """★ fail_on 不设窗口：晚到的崩溃同样算失败（漏判才是灾难）。"""
        st, _, _ = J([(99.0, "*** HardFault ***")])
        self.assertEqual(st, "failed")


# ══════════════════════════════════════════════════════════════════
#  line_count：对"关键字未知的第三方固件"唯一可用判据
# ══════════════════════════════════════════════════════════════════
class TestLineCount(unittest.TestCase):
    RULE = [R("line_count", within_s=5.0, n=3)]

    def test_enough_lines_is_ok(self):
        st, why, ev = J([(0.1, "a"), (0.2, "b"), (0.3, "c")], close=self.RULE)
        self.assertEqual(st, "ok")
        self.assertEqual(ev[0]["line"], "c")
        self.assertIn("line_count", ev[0]["rule"])

    def test_too_few_lines_is_inconclusive(self):
        st, _, _ = J([(0.1, "a"), (0.2, "b")], close=self.RULE)
        self.assertEqual(st, "inconclusive")

    def test_lines_after_window_do_not_count(self):
        st, _, _ = J([(0.1, "a"), (6.0, "b"), (7.0, "c")], close=self.RULE)
        self.assertEqual(st, "inconclusive")

    def test_line_count_beats_fail_on_collision(self):
        """聚合判据在 ⓪ 步就 return，故它先于 fail_on —— 这是**刻意的**：
        line_count 的语义是"还在吐字节"，此时关键字命中与否都还没有意义。
        把它写下来是为了让这条优先级不是"碰巧"，而是**约定**。"""
        st, _, _ = J([(0.1, "a"), (0.2, "HardFault"), (0.3, "c")], close=self.RULE)
        self.assertEqual(st, "ok")


# ══════════════════════════════════════════════════════════════════
#  规则解析：坏规则跳过并告警，绝不静默变成"没有判据"
# ══════════════════════════════════════════════════════════════════
class TestParseRules(unittest.TestCase):
    def setUp(self):
        self.msgs: list[str] = []

    def _log(self, *a):
        self.msgs.append(" ".join(str(x) for x in a))

    def test_parses_pattern_and_value_keys(self):
        rs = mon.parse_rules([{"kind": "regex", "pattern": "^\\[boot\\]", "within_s": 3},
                              {"kind": "contains", "value": "ok"}],
                             what="t", log=self._log)
        self.assertEqual(len(rs), 2)
        self.assertEqual(rs[0].within_s, 3.0)
        self.assertEqual(rs[1].pattern, "ok")
        self.assertEqual(self.msgs, [])

    def test_short_anchored_regex_triggers_a_false_positive_warning(self):
        """**记录一个已知假阳性**（不掩盖、也不改代码）。

        "判据过宽"的判据是 ``能匹配空串 or len(pattern) < 3``。后半句把
        "短" 混同成了 "宽"：``^x`` 只有 2 个字符，却是一个**精确的**锚定判据，
        并不会假通过。故它对短而精确的判据会**误报**。

        为什么明知误报也不改：这是 **warn-only** 的启发式（照旧生效），
        而收紧/放宽判据的**决定权在设计者**；改判据本身会同时改变
        `projects/*.yaml` 的告警噪声，收益不明、爆炸半径不明。
        所以：把真实行为写成用例，让"这个警告是误报"成为一个**可查的事实**，
        而不是下一个"为什么会有这条警告"的悬案。
        """
        rs = mon.parse_rules([{"kind": "regex", "pattern": "^x"}],
                             what="t", log=self._log)
        self.assertEqual(len(rs), 1, "警告归警告，规则仍然生效")
        self.assertEqual(rs[0].pattern, "^x")
        self.assertTrue(any("判据过宽" in m for m in self.msgs), self.msgs)

    def test_empty_matchable_regex_is_the_real_signal(self):
        """启发式真正想抓的形态：能吃空串（= 判据等于没有）。"""
        rs = mon.parse_rules([{"kind": "regex", "pattern": "a?"}],
                             what="t", log=self._log)
        self.assertEqual(len(rs), 1)
        self.assertTrue(any("判据过宽" in m for m in self.msgs), self.msgs)

    def test_bad_regex_is_skipped_and_warned(self):
        rs = mon.parse_rules([{"kind": "regex", "pattern": "([unclosed"}],
                             what="t", log=self._log)
        self.assertEqual(rs, [])
        self.assertTrue(any("正则非法" in m for m in self.msgs), self.msgs)

    def test_overbroad_regex_warns_but_keeps(self):
        rs = mon.parse_rules([{"kind": "regex", "pattern": ".*"}],
                             what="t", log=self._log)
        self.assertEqual(len(rs), 1, "过宽只是警告，仍生效（是否收紧由人决定）")
        self.assertTrue(any("判据过宽" in m for m in self.msgs), self.msgs)

    def test_non_mapping_item_is_skipped(self):
        rs = mon.parse_rules(["not-a-dict"], what="t", log=self._log)
        self.assertEqual(rs, [])
        self.assertTrue(any("不是映射" in m for m in self.msgs), self.msgs)

    def test_line_count_requires_positive_n_and_window(self):
        rs = mon.parse_rules([{"kind": "line_count", "n": 0, "within_s": 5},
                              {"kind": "line_count", "n": 3},
                              {"kind": "line_count", "n": 3, "within_s": 5}],
                             what="t", log=self._log)
        self.assertEqual(len(rs), 1, "只有第三条合法")
        self.assertEqual(rs[0].n, 3)

    def test_missing_pattern_is_skipped(self):
        rs = mon.parse_rules([{"kind": "regex"}], what="t", log=self._log)
        self.assertEqual(rs, [])
        self.assertTrue(any("缺 pattern" in m for m in self.msgs), self.msgs)


# ══════════════════════════════════════════════════════════════════
#  观察窗口推导 与 退出码映射
# ══════════════════════════════════════════════════════════════════
class TestWindowAndExitCode(unittest.TestCase):
    def test_window_is_max_of_close_on(self):
        self.assertEqual(mon._window([R(within_s=3), R(within_s=7)], 30.0, 0.0), 7.0)

    def test_explicit_seconds_wins(self):
        self.assertEqual(mon._window([R(within_s=3)], 30.0, 2.5), 2.5)

    def test_falls_back_to_idle_then_default(self):
        self.assertEqual(mon._window([], 30.0, 0.0), 30.0)
        self.assertEqual(mon._window([], 0.0, 0.0), mon.DEFAULT_WINDOW_S)

    def test_exit_codes_are_three_distinct(self):
        """★ 三态各有码：CI 才能分开'没证据(=2)'与'失败(=1)'。"""
        self.assertEqual(mon.exit_code(mon.Verdict(status="ok")), 0)
        self.assertEqual(mon.exit_code(mon.Verdict(status="failed")), 1)
        self.assertEqual(mon.exit_code(mon.Verdict(status="inconclusive")), 2)

    def test_verdict_to_dict_is_json_safe_and_carries_no_lines(self):
        """``to_dict()`` 进事件流，**不能**把上千行原文塞进去（会撑爆 JSONL 行长）。"""
        v = mon.Verdict(status="ok", port="COM10", backend="ctypes", layer="L1",
                        elapsed_s=1.234, bytes_seen=64,
                        lines=["a", "b", "c"])
        d = v.to_dict()
        self.assertEqual(d["lines"], 3)          # 是**条数**，不是内容
        self.assertNotIn("lines_text", d)
        self.assertEqual(d["bytes"], 64)
        self.assertEqual(d["elapsed_s"], 1.23)   # 已 round
        self.assertEqual(mon.render(v).count("串口闭环"), 1)


# ══════════════════════════════════════════════════════════════════
#  回调契约（M3-a 的接线前提）
# ══════════════════════════════════════════════════════════════════
class TestRunCallbackContract(unittest.TestCase):
    """``run()`` 的三个回调是 M3-a "把串口接到事件流上"的唯一接口。

    ★ 这里**不碰硬件**，只验一件最容易搞错的事：**开不了口时不发 on_open /
      on_close**。否则事件流里会出现一对没有主体的 `serial/open` + `serial/close`
      ——孤儿事件比缺失事件更坏，因为它看起来"一切正常"。
    做法：把 port 指到一个必然不存在的口（`SELECT_PORT` 返回空 → 提前 return）。
    """

    def test_no_callbacks_when_port_cannot_be_selected(self):
        calls: list[tuple] = []

        class Cfg:
            host: dict = {}

            def resolved_project(self, name):
                return {"serial": {"port": "COM_NOPE_9999"}}

        v = mon.run(Cfg(), "x", port="COM_NOPE_9999", log=lambda *a: None,
                    on_open=lambda *a: calls.append(("open",) + a),
                    on_line=lambda *a: calls.append(("line",) + a),
                    on_close=lambda *a: calls.append(("close",) + a))
        self.assertIn(v.status, ("inconclusive",))
        self.assertEqual(calls, [], "选不到口 → 一个回调都不该发")

    def test_callback_exception_does_not_break_the_run(self):
        """回调（也就是事件流）出错**不能**把判定结果弄丢。"""
        class Cfg:
            host: dict = {}

            def resolved_project(self, name):
                return {"serial": {"port": "COM_NOPE_9999"}}

        v = mon.run(Cfg(), "x", log=lambda *a: None,
                    on_open=lambda *a: (_ for _ in ()).throw(RuntimeError("boom")))
        self.assertIsNotNone(v)          # 没抛出去


if __name__ == "__main__":
    unittest.main(verbosity=2)
