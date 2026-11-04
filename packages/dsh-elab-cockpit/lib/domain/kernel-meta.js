/**
 * 内核自描述消费层（§16 分层解耦）—— 业务词汇的唯一事实源在内核
 * （cockpit/server.py 的 capabilities.meta），本模块是它在插件内的落点。
 *
 * 设计：
 *  - CockpitPane 挂载时把 capabilities.meta 灌进来（setKernelMeta）；
 *  - 各组件的标签/档位查询走本模块，**内核没给时退回插件内置默认**；
 *  - 插件内置默认只为"内核过旧"兜底 —— 新业务词汇永远只改内核，不改这里。
 */
let current = null;
/** 当前工程的项目级文案覆盖（`projects/*.yaml` 的 `step_labels`）。 */
let projectSteps = {};
/** 灌入内核自描述（每次挂载/刷新都会重灌）。 */
export function setKernelMeta(meta) {
    current = meta ?? null;
}
/**
 * 灌入当前工程的项目级步骤文案（`/api/projects` 卡片的 `step_labels`）。
 * 空值 = 回到内核全局 `STEP_META` —— 切换工程时不会残留上一个项目的覆盖。
 */
export function setProjectStepLabels(labels) {
    projectSteps = labels ?? {};
}
/** 读取当前内核 meta（未拿到 = null，调用方走内置默认）。 */
export function kernelMeta() {
    return current;
}
/** 步骤标签：项目覆盖优先，其次内核 meta，最后 fallback。 */
export function kernelStepLabel(id, fallback) {
    const override = projectSteps[id];
    if (typeof override === 'string' && override !== '')
        return override;
    const label = current?.steps?.[id]?.label;
    return typeof label === 'string' && label !== '' ? label : fallback;
}
/** 档位标题：meta 优先，退回 fallback。 */
export function kernelPlanTitle(planId, fallback) {
    const plan = current?.plans?.find((p) => p.id === planId);
    const title = plan?.title;
    return typeof title === 'string' && title !== '' ? title : fallback;
}
/** 档位的内核步骤集（用于 host 侧解析；未定义 = undefined，调用方走内置）。 */
export function kernelPlanSteps(planId) {
    const steps = current?.plans?.find((p) => p.id === planId)?.steps;
    return Array.isArray(steps) ? steps.map(String) : undefined;
}
/** 调试面板是否可见：**只有**内核声明 `meta.debug.available=true` 才显示。 */
export function kernelDebugAvailable() {
    return current?.debug?.available === true;
}
/** 探针清单（缺失 = 内核较旧，调用方隐藏下拉，只显示当前值）。 */
export function kernelProbes() {
    return current?.probes ?? null;
}
