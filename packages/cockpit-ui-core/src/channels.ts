/**
 * 事件 → 日志通道归类（唯一规则；`tabOfEvent` 的继任者）。
 *
 * ★ 两侧的**唯一行为差异**是 `debug_verify` 归哪个通道，因此做成参数而不是分叉：
 *   - 独立 WebUI（三列）：`debug_verify` 并进「烧录」通道（默认）；
 *   - DSH 插件（窄栏）：`debug_verify` 拆成独立「调试」通道。
 *   理由（Q14 澄清后的方案 §11.1）：`debug_verify` 是 openocd 硬件寄存器级调试
 *   （断到 main 后观察 MCU），输出形态是 gdb 的寄存器/栈帧，与烧录的 openocd
 *   编程输出完全不同 —— 混在一起时用户在窄栏里根本分不清"这行是烧录成功
 *   还是断点命中"。拆开后阶梯的「调试校验」行有独立日志尾。
 *
 * 归类规则（自上而下首条命中）：
 *   1. `serial/*`               → serial
 *   2. step 为 `tool:<name>`    → tools（所有项目声明工具共用一个通道）
 *   3. proc/* 与 run/step-* 按 step：
 *        flash                → flash
 *        debug_verify         → debug（仅 debugChannel=true）/ flash（默认）
 *        monitor              → serial
 *        其余（doctor/build） → build
 */

import type { ElabEvent } from './icd.ts'

export type LogChannelId = 'build' | 'flash' | 'debug' | 'serial' | 'tools'

export const LOG_CHANNELS: readonly LogChannelId[] = ['build', 'flash', 'debug', 'serial', 'tools']

/** 通道的显示名（窄栏日志尾的切换条用）。 */
export const CHANNEL_LABEL: Record<LogChannelId, string> = {
  build: '构建',
  flash: '烧录',
  debug: '调试',
  serial: '串口',
  tools: '工具',
}

export interface ChannelOptions {
  /** true = `debug_verify` 落独立「调试」通道（DSH 窄栏）；false = 并进「烧录」（默认，WebUI）。 */
  debugChannel?: boolean
}

/** 步骤 id → 它的主通道（用于"点阶梯某行 → 日志尾切到哪"）。 */
export function channelOfStep(step: string, opts: ChannelOptions = {}): LogChannelId {
  if (step.startsWith('tool:')) return 'tools'
  if (step === 'flash') return 'flash'
  if (step === 'debug_verify') return opts.debugChannel === true ? 'debug' : 'flash'
  if (step === 'monitor') return 'serial'
  return 'build'
}

/**
 * 事件 → 通道。null = 不属于任何日志通道（如 `run/start`、心跳类）。
 */
export function channelOfEvent(e: ElabEvent, opts: ChannelOptions = {}): LogChannelId | null {
  const topic = String(e.topic ?? '')
  const step = String(e.step ?? '')

  if (topic.startsWith('serial/')) return 'serial'

  const isLogish =
    topic === 'proc/stdout' ||
    topic === 'proc/stderr' ||
    topic === 'proc/stdout-batch' ||
    topic === 'run/step-enter' ||
    topic === 'run/step-exit'

  if (!isLogish) return null
  if (step === '') return null
  return channelOfStep(step, opts)
}

/** 进度行判定：Ninja 的 `[3/28] Building …`（`builder._stream()` 逐行推出的正是它）。 */
export interface ProgressFrame {
  current: number
  total: number
  label: string
}

/**
 * 从一行文本解析进度。没有进度信息返回 null。
 *
 * ★ 不用正则：本项目里含反斜杠的转义序列经编辑链路有被折叠的风险
 *   （已两次踩到 `\s` → `s`），纯字符扫描最稳。
 */
export function parseProgressLine(line: string): ProgressFrame | null {
  const text = line.trim()
  if (!text.startsWith('[')) return null
  const close = text.indexOf(']')
  if (close < 0) return null
  const inner = text.slice(1, close)
  const slash = inner.indexOf('/')
  if (slash <= 0) return null
  const cur = Number(inner.slice(0, slash))
  const tot = Number(inner.slice(slash + 1))
  if (!Number.isInteger(cur) || !Number.isInteger(tot) || tot <= 0 || cur < 0 || cur > tot) return null
  return { current: cur, total: tot, label: text.slice(close + 1).trim() }
}
