/**
 * 三档一键流（§6.6）—— 人机共用的触发面。
 *
 * 三个按钮 + 单步，**不做**"勾选部分步骤"多选（Q7 决策）。
 *
 * ★ 与 Host 半 `plans.ts` 必须同构：同一份步骤集常量、同一套可用性判定。
 *   否则会出现"按钮能点但后端拒绝"的缝。P3 用对照用例钉死。
 *
 * 降级规则（Q9 已定）：**三连与闭环一致 —— 不可用步骤都剔除**，
 *   并在 tooltip / 日志首行显式写明跳过了什么。
 */

import { kernelStepLabel, kernelPlanTitle } from './kernel-meta.ts'

/** elab 的全部步骤（`services/elab/run.py:38-40` 实读）。 */
export const ALL_STEPS = ['doctor', 'doctor_deep', 'build', 'flash', 'debug_verify', 'monitor'] as const

export type StepId = (typeof ALL_STEPS)[number] | `tool:${string}`

/** 需要探针（上板）的步骤（`run.py:48` 实读）。 */
export const ONHW_STEPS: readonly string[] = ['flash', 'debug_verify', 'monitor']

/** 步骤显示名。 */
export const STEP_LABEL: Record<string, string> = {
  doctor: '体检',
  doctor_deep: '深度体检',
  build: '编译',
  flash: '烧录',
  debug_verify: '调试校验',
  monitor: '串口闭环',
}

export function stepLabel(id: string): string {
  // §16：内核 meta 的标签优先（业务词汇唯一事实源），无 meta 时退回内置默认
  return kernelStepLabel(id, STEP_LABEL[id] ?? (id.startsWith('tool:') ? `工具·${id.slice(5)}` : id))
}

export type PlanId = 'basic' | 'triple' | 'loop'

export interface PlanDef {
  id: PlanId
  /** 按钮文案。 */
  label: string
  /** 悬停说明。 */
  hint: string
  /** 声明的步骤序列（未过滤）。 */
  steps: readonly string[]
  /** 是否要求"到板"（三连）。 */
  requiresHardware: boolean
}

/**
 * 三档定义。
 *
 * - basic：只编译。组合工程会自动级联编 boot（框架 C1，见 §6.7）。
 * - triple：编译 → 烧录 → 调试校验。**全程需要探针**。
 * - loop：闭环 = doctor + build + flash + debug_verify + monitor，
 *         按卡片可用性过滤（`doctor_deep` 永不进入，它是 doctor 的重型变体）。
 */
export const PLANS: readonly PlanDef[] = [
  {
    id: 'basic',
    label: '编译',
    hint: '只编译当前工程（组合工程会自动级联编译 boot）',
    steps: ['build'],
    requiresHardware: false,
  },
  {
    id: 'triple',
    label: '三连',
    hint: '编译 → 烧录 → 调试校验（需要探针在位）',
    steps: ['build', 'flash', 'debug_verify'],
    requiresHardware: true,
  },
  {
    id: 'loop',
    label: '闭环',
    hint: '体检 → 编译 → 烧录 → 调试校验 → 串口闭环（不可用步骤自动跳过）',
    steps: ['doctor', 'build', 'flash', 'debug_verify', 'monitor'],
    requiresHardware: false,
  },
]

/** 每步可用性（来自服务端算好的卡片；缺省视为可用，与 `fullLoopSteps` 一致）。 */
export interface StepAvailability {
  [step: string]: { ok: boolean; reason?: string }
}

export interface PlanView extends PlanDef {
  /** 过滤后的实际步骤。 */
  effectiveSteps: string[]
  /** 被剔除的步骤（含原因），用于 UI 显式说明。 */
  skipped: Array<{ step: string; reason: string }>
  enabled: boolean
  /** 不可用原因（enabled=false 时必有）。 */
  reason?: string
}

/**
 * 计算某一档的实际步骤与可用性。
 *
 * @param plan 档位定义
 * @param steps 服务端给的每步可用性
 * @param serialBusy 串口是否被监视占用（影响 monitor / flash / debug_verify）
 */
export function resolvePlan(
  plan: PlanDef,
  steps: StepAvailability,
  serialBusy = false,
): PlanView {
  const effectiveSteps: string[] = []
  const skipped: Array<{ step: string; reason: string }> = []

  for (const step of plan.steps) {
    const av = steps[step]
    const ok = av?.ok ?? true
    if (!ok) {
      skipped.push({ step, reason: av?.reason ?? '不可用' })
      continue
    }
    // 串口互斥（N5）：monitor/flash/debug_verify 都要用串口或 SWD
    if (serialBusy && ONHW_STEPS.includes(step)) {
      skipped.push({ step, reason: '串口正被监视会话占用' })
      continue
    }
    effectiveSteps.push(step)
  }

  // 主步骤全被剔除 → 整档不可用
  const primary = plan.id === 'basic' ? 'build' : 'build'
  const primaryOk = effectiveSteps.includes(primary)
  return {
    ...plan,
    // §16：内核 meta 的档位标题优先（业务词汇唯一事实源）
    label: kernelPlanTitle(plan.id, plan.label),
    effectiveSteps,
    skipped,
    enabled: primaryOk,
    reason: primaryOk
      ? undefined
      : skipped.find((s) => s.step === primary)?.reason ?? `${stepLabel(primary)}不可用`,
  }
}

/** 计算全部三档。 */
export function resolveAllPlans(
  steps: StepAvailability,
  serialBusy = false,
): PlanView[] {
  return PLANS.map((p) => resolvePlan(p, steps, serialBusy))
}

/** 跳过说明（用于日志首行 / tooltip 追加）。 */
export function describeSkipped(view: PlanView): string {
  if (view.skipped.length === 0) return ''
  return `本次跳过：${view.skipped.map((s) => `${stepLabel(s.step)}（${s.reason}）`).join('、')}`
}

/**
 * 进度帧累积器 —— 把 `[3/28] Building …` 合并成可渲染的进度。
 *
 * 依据：`builder._stream()` 逐行推 `[n/m]`（Q15 已实现并验证）。
 * 只保留**最新**一帧的 current/total，label 用于显示"正在编译哪个文件"。
 */
export interface ProgressState {
  current: number
  total: number
  label: string
  /** 从收到第一帧开始计时，用于显示速率。 */
  startedAt: number
}

export function makeProgress(): ProgressState {
  return { current: 0, total: 0, label: '', startedAt: 0 }
}

/** 输入一行文本，返回更新后的进度（无进度信息则原样返回同一引用）。 */
export function foldProgress(state: ProgressState, line: string, now = Date.now()): ProgressState {
  const text = line.trim()
  if (!text.startsWith('[')) return state
  const close = text.indexOf(']')
  if (close < 0) return state
  const inner = text.slice(1, close)
  const slash = inner.indexOf('/')
  if (slash <= 0) return state
  const cur = Number(inner.slice(0, slash))
  const tot = Number(inner.slice(slash + 1))
  if (!Number.isInteger(cur) || !Number.isInteger(tot) || tot <= 0) return state
  if (cur < 0 || cur > tot) return state
  return {
    current: cur,
    total: tot,
    label: text.slice(close + 1).trim(),
    startedAt: state.startedAt === 0 ? now : state.startedAt,
  }
}
