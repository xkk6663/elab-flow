"""test_flow_manifest —— 流程清单（STEP_META / KERNEL_PLANS）回归。

运行：``python -m unittest tests.test_flow_manifest``

背景（2026-11-06）：流程清单从 ``cockpit/server.py`` 挪到 ``services/elab/flow.py``
—— 驾驶舱只是 HTTP 载体，词汇不该挂在载体上；CLI 与内核编排也要能引用同一份。

覆盖：
1. 展示侧清单（flow.STEP_META）与执行侧清单（run.ALL_STEPS）**一一对应**
   —— 少一个步骤 = 面板上出现一个没有标签的按钮；
2. 三档定义的步骤都在清单里，且档位 id 唯一；
3. label / channel / plan 查询helper 的行为（含项目级覆盖与未知项退化）；
4. 驾驶舱**不得**再内联一份流程清单（唯一事实源守卫，防止将来又分叉）。
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "services"))

from elab import flow                                   # noqa: E402
from elab import run as run_mod                          # noqa: E402


class FlowManifestTest(unittest.TestCase):
    def test_step_meta_covers_all_steps(self) -> None:
        """展示侧清单必须覆盖执行侧的全部步骤（双向一致，不多不少）。"""
        self.assertEqual(
            set(flow.STEP_META),
            set(run_mod.ALL_STEPS),
            "STEP_META 与 run.ALL_STEPS 不一致：新增步骤时两处都要改",
        )

    def test_step_meta_shape(self) -> None:
        for step, meta in flow.STEP_META.items():
            self.assertIn("label", meta, f"{step} 缺 label")
            self.assertIn("channel", meta, f"{step} 缺 channel")
            self.assertIn(
                meta["channel"],
                {"build", "flash", "debug", "serial"},
                f"{step} 的 channel 非法：{meta['channel']}",
            )
            self.assertTrue(str(meta["label"]).strip(), f"{step} 的 label 为空")

    def test_plans_reference_known_steps(self) -> None:
        ids = [p["id"] for p in flow.KERNEL_PLANS]
        self.assertEqual(len(ids), len(set(ids)), "档位 id 必须唯一")
        for plan in flow.KERNEL_PLANS:
            for step in plan["steps"]:
                self.assertIn(
                    step,
                    flow.STEP_META,
                    f"档位 {plan['id']} 引用了清单里没有的步骤 {step}",
                )
            self.assertTrue(plan["title"], f"档位 {plan['id']} 缺 title")
            self.assertIn("requires_hardware", plan)

    def test_label_and_channel_helpers(self) -> None:
        self.assertEqual(flow.step_label("build"), "编译")
        self.assertEqual(flow.step_label("flash"), "烧录")
        self.assertEqual(flow.step_channel("flash"), "flash")
        self.assertEqual(flow.step_channel("monitor"), "serial")
        # 项目级覆盖优先于全局默认
        self.assertEqual(flow.step_label("flash", {"flash": "烧录校验"}), "烧录校验")
        # 未知项退化，不抛异常
        self.assertEqual(flow.step_label("nope"), "nope")
        self.assertEqual(flow.step_channel("nope"), "build")

    def test_plan_helpers(self) -> None:
        self.assertEqual(flow.plan_steps("basic"), ["build"])
        self.assertEqual(
            flow.plan_steps("triple"), ["build", "flash", "debug_verify"]
        )
        self.assertEqual(flow.plan_steps("nope"), [])
        self.assertTrue(flow.plan_requires_hardware("triple"))
        self.assertFalse(flow.plan_requires_hardware("basic"))
        self.assertFalse(flow.plan_requires_hardware("nope"))

    def test_server_does_not_redefine_manifest(self) -> None:
        """驾驶舱不得再内联一份流程清单（防止将来又分叉出第二事实源）。"""
        src = (ROOT / "cockpit" / "server.py").read_text(encoding="utf-8")
        self.assertRegex(
            src,
            r"from\s+elab\.flow\s+import[^\n]*STEP_META",
            "cockpit/server.py 必须从 services/elab/flow.py 引用流程清单",
        )
        self.assertNotRegex(
            src,
            r"^STEP_META\s*=\s*\{",
            "cockpit/server.py 不得内联 STEP_META（唯一事实源在 services/elab/flow.py）",
        )
        self.assertNotRegex(
            src,
            r"^KERNEL_PLANS\s*=\s*\[",
            "cockpit/server.py 不得内联 KERNEL_PLANS（唯一事实源在 services/elab/flow.py）",
        )

    def test_server_exposes_same_manifest(self) -> None:
        """驾驶舱对外自述的 meta 必须就是 flow 里的那一份。"""
        from cockpit import server as srv  # noqa: PLC0415  局部导入避免全局副作用

        self.assertIs(srv.STEP_META, flow.STEP_META)
        self.assertIs(srv.KERNEL_PLANS, flow.KERNEL_PLANS)


if __name__ == "__main__":
    unittest.main()
