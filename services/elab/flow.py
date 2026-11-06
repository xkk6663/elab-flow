"""elab.flow —— **流程清单**（步骤词汇 + 三档定义）的唯一事实源。

§16 分层解耦：业务词汇属内核，工具层（DSH 插件 / CLI 帮助）只渲染这里的定义，
不自带业务名词 —— 内核改标签、加步骤、调档位，工具层无需改代码。

本模块**芯片无关**：换芯片只改 pack / provider，步骤与档位不变。

为什么从 ``cockpit/server.py`` 挪出来（2026-11-06）：
  - 驾驶舱只是 HTTP 载体，词汇不该挂在载体上（载体可换，词汇不变）；
  - CLI（``elab``）与内核编排（``services/elab``）也能引用同一份，
    不再出现「面板叫 doctor、命令行叫 check」的漂移；
  - ``run_mod.ALL_STEPS`` 是**执行**侧的事实源，本模块是**展示**侧的，
    两者同处业务层，可互相校验（见 ``tests/test_flow_manifest.py``）。

兄弟清单：串口词汇表 ``SERIAL_META`` 仍留在 ``cockpit/server.py``——
它依赖串口/帧协议模块的运行时常量，与流程清单不同源，暂不合并。
"""

from __future__ import annotations

#: 步骤词汇：step id → 显示标签 + 面板通道。
#: 面板通道取 build / flash / debug / serial 四选一（驾驶舱按通道分流日志）。
STEP_META: dict[str, dict[str, str]] = {
    "doctor":       {"label": "体检",     "channel": "build"},
    "doctor_deep":  {"label": "深度体检", "channel": "build"},
    "build":        {"label": "编译",     "channel": "build"},
    "flash":        {"label": "烧录",     "channel": "flash"},
    "debug_verify": {"label": "调试校验", "channel": "debug"},
    "monitor":      {"label": "串口闭环", "channel": "serial"},
}

#: 三档闭环定义：plan id → 标题 + 步骤序列 + 是否需要硬件在位。
#: steps 里的 step id 必须出现在 STEP_META 里（见 ``tests/test_flow_manifest.py``）。
KERNEL_PLANS: list[dict] = [
    {"id": "basic",  "title": "编译", "steps": ["build"],
     "requires_hardware": False},
    {"id": "triple", "title": "三连", "steps": ["build", "flash", "debug_verify"],
     "requires_hardware": True},
    {"id": "loop",   "title": "闭环", "steps": ["doctor", "build", "flash", "debug_verify", "monitor"],
     "requires_hardware": False},
]


def step_label(step: str, override: dict[str, str] | None = None) -> str:
    """步骤显示标签：项目级文案覆盖优先 → 全局 STEP_META → 退化成 step id。

    项目可在 yaml 里写 ``step_labels: {flash: 烧录校验}``（ESP32 等工程改文案
    而不动全局默认），规则只有这一条，工具层与面板共用。
    """
    if override:
        label = override.get(step)
        if isinstance(label, str) and label:
            return label
    meta = STEP_META.get(step)
    if meta is None:
        return step
    return meta.get("label", step)


def step_channel(step: str) -> str:
    """步骤所属面板通道（build / flash / debug / serial）；未知步骤退化为 build。"""
    meta = STEP_META.get(step)
    if meta is None:
        return "build"
    return meta.get("channel", "build")


def plan_steps(plan_id: str) -> list[str]:
    """三档定义的步骤序列；未知 plan 返回空列表。"""
    for plan in KERNEL_PLANS:
        if plan.get("id") == plan_id:
            return list(plan.get("steps") or [])
    return []


def plan_requires_hardware(plan_id: str) -> bool:
    """该档是否需要硬件在位（工具层据此提示用户「先把板子插好」）。"""
    for plan in KERNEL_PLANS:
        if plan.get("id") == plan_id:
            return bool(plan.get("requires_hardware"))
    return False
