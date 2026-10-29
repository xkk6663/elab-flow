/**
 * 内核自描述消费层（§16 分层解耦）—— 业务词汇的唯一事实源在内核
 * （cockpit/server.py 的 capabilities.meta），本模块是它在插件内的落点。
 *
 * 设计：
 *  - CockpitPane 挂载时把 capabilities.meta 灌进来（setKernelMeta）；
 *  - 各组件的标签/档位查询走本模块，**内核没给时退回插件内置默认**；
 *  - 插件内置默认只为"内核过旧"兜底 —— 新业务词汇永远只改内核，不改这里。
 */

export interface KernelStepMeta {
  label?: string
  channel?: string
}

export interface KernelPlanMeta {
  id: string
  title?: string
  steps?: string[]
  requires_hardware?: boolean
}

export interface KernelMeta {
  steps?: Record<string, KernelStepMeta>
  plans?: KernelPlanMeta[]
  channels?: string[]
}

let current: KernelMeta | null = null

/** 灌入内核自描述（每次挂载/刷新都会重灌）。 */
export function setKernelMeta(meta: KernelMeta | null | undefined): void {
  current = meta ?? null
}

/** 读取当前内核 meta（未拿到 = null，调用方走内置默认）。 */
export function kernelMeta(): KernelMeta | null {
  return current
}

/** 步骤标签：meta 优先，退回 fallback。 */
export function kernelStepLabel(id: string, fallback: string): string {
  const label = current?.steps?.[id]?.label
  return typeof label === 'string' && label !== '' ? label : fallback
}

/** 档位标题：meta 优先，退回 fallback。 */
export function kernelPlanTitle(planId: string, fallback: string): string {
  const plan = current?.plans?.find((p) => p.id === planId)
  const title = plan?.title
  return typeof title === 'string' && title !== '' ? title : fallback
}

/** 档位的内核步骤集（用于 host 侧解析；未定义 = undefined，调用方走内置）。 */
export function kernelPlanSteps(planId: string): string[] | undefined {
  const steps = current?.plans?.find((p) => p.id === planId)?.steps
  return Array.isArray(steps) ? steps.map(String) : undefined
}
