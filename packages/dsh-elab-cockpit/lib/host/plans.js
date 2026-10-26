/**
 * Host 半的三档一键流解析 —— 与 Client 侧 `model/plans.ts` **必须同构**。
 *
 * 为什么两处都要有：
 *   - Client 需要它算"按钮能不能点"（即时反馈，不等一次往返）；
 *   - Host 需要它把 `plan: 'basic'|'triple'|'loop'` 解析成实际 `steps` 再转发
 *     （Python 只认 `steps`，见 `services/elab/run.py:45` 的 DEFAULT_STEPS 陷阱）。
 *
 * ★ 防漂移：`test/plans-parity.test.mjs` 用同一组夹具对两边逐项比对。
 *   改这里必须同步改 `src/client/model/plans.ts`，否则用例会红。
 */
/** elab 全部步骤（`services/elab/run.py:38-40` 实读）。 */
export const ALL_STEPS = ['doctor', 'doctor_deep', 'build', 'flash', 'debug_verify', 'monitor'];
/** 需要探针的步骤（`run.py:48` 实读）。 */
export const ONHW_STEPS = ['flash', 'debug_verify', 'monitor'];
export const PLANS = [
    { id: 'basic', steps: ['build'], requiresHardware: false },
    { id: 'triple', steps: ['build', 'flash', 'debug_verify'], requiresHardware: true },
    { id: 'loop', steps: ['doctor', 'build', 'flash', 'debug_verify', 'monitor'], requiresHardware: false },
];
/**
 * 解析一档：过滤不可用步骤（Q9：三连与闭环一致，都剔除而非拒绝）。
 *
 * @param serialBusy 串口是否被监视占用（N5 互斥）
 */
export function resolvePlanById(id, steps, serialBusy = false) {
    const def = PLANS.find((p) => p.id === id);
    if (def === undefined) {
        throw new Error(`未知的 plan：${id}（可选：${PLANS.map((p) => p.id).join(', ')}）`);
    }
    const effective = [];
    const skipped = [];
    for (const step of def.steps) {
        const av = steps[step];
        if (!(av?.ok ?? true)) {
            skipped.push({ step, reason: av?.reason ?? '不可用' });
            continue;
        }
        if (serialBusy && ONHW_STEPS.includes(step)) {
            skipped.push({ step, reason: '串口正被监视会话占用' });
            continue;
        }
        effective.push(step);
    }
    return { id, steps: effective, skipped, enabled: effective.includes('build') };
}
/**
 * 把 `{plan}` 或 `{steps}` 归一成最终步骤集。
 *
 * 优先级：显式 `steps` > `plan` > 默认（build）。
 * ★ 绝不回落到 Python 的 DEFAULT_STEPS（`doctor,build`）——那是"默认两步"，
 *   不是闭环；原驾驶舱曾因不传 steps 而"跑完编译就停"。
 */
export function resolveRunSteps(input) {
    if (Array.isArray(input.steps) && input.steps.length > 0) {
        return { steps: input.steps, skipped: [] };
    }
    const id = (input.plan ?? 'basic');
    const resolved = resolvePlanById(id, input.availability ?? {}, input.serialBusy ?? false);
    if (resolved.steps.length === 0) {
        throw new Error(`plan=${id} 过滤后没有任何可执行步骤`);
    }
    return { steps: resolved.steps, skipped: resolved.skipped, plan: id };
}
