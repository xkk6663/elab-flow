/**
 * 阶梯（StageLadder）—— 步骤状态机的一维投影 + 手动单步入口。
 *
 * 设计约束：
 *  ① **组件不推导状态**：`StepView.state` 直接来自 `runStore.reduce()`，
 *     六态 pending / running / ok / failed / skipped / cancelled
 *     （`skipped` = fail-fast 后未执行到的步骤，见 run.py:528 的 break）。
 *  ② **点行 = 聚焦日志，点 ▶ = 单步执行**（Q1：防误触烧录）。
 *  ③ **可用性只有一个来源**：`card.steps[id].ok/reason`（服务端算好）。
 *     置灰时必须能看到原因，不让用户点了才知道失败。
 *  ④ 状态色只用 DSH 令牌（§5.5），不写字面色值。
 */

import React from 'react'
import type { ReactNode } from 'react'

/** 与 `store/runStore.ts` 的 `StepView` 对齐（此处只依赖用到的字段）。 */
export interface LadderStep {
  id: string
  index: number
  state: 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'cancelled'
  detail: string
  duration_s: number
}

export interface StageLadderProps {
  steps: LadderStep[]
  /** 每步可用性（来自卡片）。 */
  availability: Record<string, { ok: boolean; reason?: string }>
  /** 当前聚焦的步骤（点行切换）。 */
  focusStep: string | null
  /** 是否有 run 在跑（跑动中禁止再点单步）。 */
  running: boolean
  /** 点行：聚焦日志尾到该步的通道。 */
  onFocus(step: string): void
  /** 点 ▶：只跑这一步。 */
  onRunOne(step: string): void
  /** 该步的进度（仅 running 的步可能有）。 */
  progressOf?(step: string): { current: number; total: number } | null
  /** §5.4 密度档：narrow（默认，单行省略）/ mid|wide（detail 全宽第二行）。 */
  density?: 'narrow' | 'mid' | 'wide'
}

const STATE_TONE: Record<string, { dot: string; text: string; label: string }> = {
  pending: { dot: 'var(--elab-status-idle)', text: 'var(--elab-fg-muted)', label: '待跑' },
  running: { dot: 'var(--elab-accent)', text: 'var(--elab-fg-primary)', label: '运行中' },
  ok: { dot: 'var(--elab-status-ok)', text: 'var(--elab-fg-primary)', label: '成功' },
  failed: { dot: 'var(--elab-status-fail)', text: 'var(--elab-status-fail)', label: '失败' },
  skipped: { dot: 'var(--elab-fg-dimmed)', text: 'var(--elab-fg-dimmed)', label: '未执行' },
  cancelled: { dot: 'var(--elab-status-run)', text: 'var(--elab-status-run)', label: '已取消' },
}

const DOT: Record<string, string> = {
  pending: '\u25cb',
  running: '\u25d0',
  ok: '\u25cf',
  failed: '\u2715',
  skipped: '\u2013',
  cancelled: '\u25cb',
}

export function fmtDur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '\u2014'
  if (sec < 60) return `${sec.toFixed(2)}s`
  return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`
}

export function stepLabelOf(id: string): string {
  const map: Record<string, string> = {
    doctor: '\u4f53\u68c0',
    doctor_deep: '\u6df1\u5ea6\u4f53\u68c0',
    build: '\u7f16\u8bd1',
    flash: '\u70e7\u5f55',
    debug_verify: '\u8c03\u8bd5\u6821\u9a8c',
    monitor: '\u4e32\u53e3\u95ed\u73af',
  }
  return map[id] ?? (id.startsWith('tool:') ? `\u5de5\u5177\u00b7${id.slice(5)}` : id)
}

/** 一行阶梯。 */
function Row(props: {
  key?: string | number
  step: LadderStep
  focus: boolean
  available: { ok: boolean; reason?: string } | undefined
  running: boolean
  progress: { current: number; total: number } | null
  density: 'narrow' | 'mid' | 'wide'
  onFocus(): void
  onRunOne(): void
}) {
  const { step, focus, available, running, progress, density } = props
  const tone = STATE_TONE[step.state] ?? STATE_TONE.pending
  const ok = available?.ok ?? true
  const disabled = running || !ok
  const showDetail = density !== 'narrow' && step.detail !== ''
  const tip = !ok
    ? `\u4e0d\u53ef\u7528\uff1a${available?.reason ?? '\u672a\u77e5\u539f\u56e0'}`
    : `\u53ea\u8dd1\u8fd9\u4e00\u6b65\uff1a${stepLabelOf(step.id)}`

  return (
    <div
      role="listitem"
      onClick={props.onFocus}
      title={step.detail !== '' ? step.detail : undefined}
      style={{
        cursor: 'pointer',
        background: focus ? 'var(--elab-bg-raised)' : 'transparent',
        borderBottom: '1px solid var(--elab-border)',
        opacity: step.state === 'skipped' ? 0.55 : 1,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          height: '28px',
          padding: '0 8px',
        }}
      >
      <span style={{ color: tone.dot, width: '12px', textAlign: 'center' }}>{DOT[step.state] ?? '\u25cb'}</span>

      <span
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '12px',
          color: tone.text,
          fontWeight: step.state === 'running' ? 600 : 400,
        }}
      >
        {stepLabelOf(step.id)}
      </span>

      {/* 进度：仅 running 且拿到 [n/m] 时显示 */}
      {step.state === 'running' && progress !== null && progress.total > 0 ? (
        <span
          style={{
            fontFamily: 'ui-monospace, Consolas, monospace',
            fontSize: '10px',
            color: 'var(--elab-accent)',
            whiteSpace: 'nowrap',
          }}
        >
          {progress.current}/{progress.total}
        </span>
      ) : null}

      <span style={{ fontSize: '10px', color: 'var(--elab-fg-muted)', whiteSpace: 'nowrap' }}>
        {tone.label}
      </span>

      {step.duration_s > 0 ? (
        <span
          style={{
            fontFamily: 'var(--elab-font-mono)',
            fontSize: '10px',
            color: 'var(--elab-fg-muted)',
            whiteSpace: 'nowrap',
          }}
        >
          {fmtDur(step.duration_s)}
        </span>
      ) : null}

      {/* 单步按钮 */}
      <button
        type="button"
        disabled={disabled}
        title={tip}
        aria-label={`\u5355\u6b65\u6267\u884c ${stepLabelOf(step.id)}`}
        onClick={(e: any) => {
          e.stopPropagation() // 别触发整行的"聚焦"
          props.onRunOne()
        }}
        style={{
          flex: '0 0 auto',
          width: '20px',
          height: '20px',
          padding: 0,
          borderRadius: '4px',
          border: '1px solid var(--elab-border)',
          background: disabled ? 'transparent' : 'var(--elab-bg-surface)',
          color: disabled ? 'var(--elab-fg-dimmed)' : 'var(--elab-accent)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: '10px',
          lineHeight: 1,
        }}
      >
        {'\u25b6'}
      </button>
      </div>
      {showDetail ? (
        <div
          style={{
            padding: '0 8px 6px 26px',
            fontSize: '11px',
            lineHeight: 1.5,
            color: 'var(--elab-fg-secondary)',
            fontFamily: 'var(--elab-font-mono)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {step.detail}
        </div>
      ) : null}
    </div>
  )
}

export function StageLadder(props: StageLadderProps): ReactNode {
  const { steps, availability, focusStep, running } = props

  if (steps.length === 0) {
    return (
      <div
        role="list"
        aria-label="\u6d41\u6c34\u7ebf\u72b6\u6001"
        style={{
          padding: '12px 8px',
          fontSize: '12px',
          color: 'var(--elab-fg-muted)',
          lineHeight: 1.6,
        }}
      >
        <div>{'\u8fd8\u6ca1\u6709\u8dd1\u8fc7\u95ed\u73af\u3002'}</div>
        <div style={{ marginTop: '4px', opacity: 0.8 }}>
          {'\u70b9\u4e0b\u65b9\u300c\u7f16\u8bd1 / \u4e09\u8fde / \u95ed\u73af\u300d\u5f00\u59cb\uff1b\u4e5f\u53ef\u4ee5\u76f4\u63a5\u70b9\u6b65\u9aa4\u53f3\u4fa7\u7684 \u25b6 \u5355\u6b65\u6267\u884c\u3002'}
        </div>
      </div>
    )
  }

  return (
    <div role="list" aria-label="\u6d41\u6c34\u7ebf\u72b6\u6001" style={{ flex: '0 0 auto' }}>
      {steps.map((step) => (
        <Row
          key={step.id}
          step={step}
          focus={focusStep === step.id}
          available={availability[step.id]}
          running={running}
          progress={props.progressOf?.(step.id) ?? null}
          density={props.density ?? 'narrow'}
          onFocus={() => props.onFocus(step.id)}
          onRunOne={() => props.onRunOne(step.id)}
        />
      ))}
    </div>
  )
}
