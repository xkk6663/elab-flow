/**
 * 事件 → 日志通道归类（移植自 `cockpit/web/src/workspaces.ts#channelOfEvent`）。
 *
 * ★ 与原文的唯一差异：`debug_verify` 从 `flash` 通道**拆出**为独立 `debug` 通道。
 *   理由（Q14 澄清后的 §11.1）：`debug_verify` 是 openocd 硬件寄存器级调试
 *   （断到 main 后观察 MCU），它的输出形态是 gdb 的寄存器/栈帧，与烧录的
 *   openocd 编程输出完全不同 —— 混在一起时用户在窄栏里根本分不清
 *   "这行是烧录成功还是断点命中"。拆开后阶梯的「调试校验」行有独立日志尾。
 *
 * 归类规则（自上而下首条命中）：
 *   1. `serial/*`               → serial
 *   2. step 为 `tool:<name>`    → tools（所有项目声明工具共用一个通道）
 *   3. proc/* 与 run/step-* 按 step：
 *        flash                → flash
 *        debug_verify         → debug     ← 本插件新增
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

/** 步骤 id → 它的主通道（用于"点阶梯某行 → 日志尾切到哪"）。 */
export function channelOfStep(step: string): LogChannelId {
  if (step.startsWith('tool:')) return 'tools'
  if (step === 'flash') return 'flash'
  if (step === 'debug_verify') return 'debug'
  if (step === 'monitor') return 'serial'
  return 'build'
}

/**
 * 事件 → 通道。null = 不属于任何日志通道（如 `run/start`、心跳类）。
 */
export function channelOfEvent(e: ElabEvent): LogChannelId | null {
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
  return channelOfStep(step)
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
