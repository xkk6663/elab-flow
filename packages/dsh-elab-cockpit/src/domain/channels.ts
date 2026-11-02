/**
 * 事件 → 日志通道归类 —— **DSH 宿主薄包装**。
 *
 * ★ 规则本体在 `@elab/cockpit-ui-core/src/channels.ts`；本文件只钉住本宿主的
 *   唯一行为差异：`debug_verify` 拆成独立「调试」通道（窄栏的阶梯行需要
 *   自己的日志尾）。WebUI 走默认（并进「烧录」）。
 *
 * 归类规则（自上而下首条命中）：
 *   1. `serial/*`               → serial
 *   2. step 为 `tool:<name>`    → tools（所有项目声明工具共用一个通道）
 *   3. proc/* 与 run/step-* 按 step：
 *        flash                → flash
 *        debug_verify         → debug
 *        monitor              → serial
 *        其余（doctor/build） → build
 */

import {
  CHANNEL_LABEL,
  LOG_CHANNELS,
  channelOfEvent as channelOfEventCore,
  channelOfStep as channelOfStepCore,
  parseProgressLine,
} from '@elab/cockpit-ui-core'
import type { ChannelOptions, LogChannelId, ProgressFrame } from '@elab/cockpit-ui-core'
import type { ElabEvent } from './icd.ts'

/** 本宿主的通道口径（见文件头）。 */
const HOST_OPTIONS: ChannelOptions = { debugChannel: true }

export { CHANNEL_LABEL, LOG_CHANNELS, parseProgressLine }
export type { LogChannelId, ProgressFrame }

/** 步骤 id → 它的主通道（用于"点阶梯某行 → 日志尾切到哪"）。 */
export function channelOfStep(step: string): LogChannelId {
  return channelOfStepCore(step, HOST_OPTIONS)
}

/** 事件 → 通道。null = 不属于任何日志通道（如 `run/start`、心跳类）。 */
export function channelOfEvent(e: ElabEvent): LogChannelId | null {
  return channelOfEventCore(e, HOST_OPTIONS)
}
