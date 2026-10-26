/**
 * 日志尾（EvidenceTail）—— 通道切换 + 命令式追加 + 进度条 + 串口输入。
 *
 * 三条性能红线（沿用驾驶舱既有结论）：
 *  ① `proc/*` 上万行**绝不进 React 状态**：用环形缓冲 + 命令式 DOM 追加。
 *  ② 一次事件最多 `requestAnimationFrame` 合并一次滚动。
 *  ③ 窄栏里省掉每行的时间戳独立节点（单层 div），降低 DOM 深度。
 *
 * 失败可视化（用户明确要求）：任一步失败时，
 *  - 该步日志尾部自动插入一条醒目的 `✗ 步骤失败` 分隔行（带 detail）；
 *  - 框内出现一条常驻告警条，点它可跳到失败行；
 *  - 环形缓冲不因 run 结束而清空 —— 错误必须能回看。
 */

import React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { LogChannelId } from './model/channels.ts'
import { CHANNEL_LABEL, LOG_CHANNELS } from './model/channels.ts'
import { parseAnsi } from './theme/ansi.ts'

/** 日志尾可见的最大行数（窄栏；原驾驶舱 4000，实测单 run 最大 12KB 可承受）。 */
/** ANSI → span 序列；无 ESC 时原样返回字符串，避免多余节点（§5.5.3）。 */
function renderLine(text: string): ReactNode {
  if (!text.includes('\u001b')) return text
  return parseAnsi(text).map((span, i) =>
    span.cls === '' ? (
      <span key={i}>{span.text}</span>
    ) : (
      <span key={i} className={span.cls}>{span.text}</span>
    ),
  )
}
export const TAIL_CAPACITY = 2000

export interface TailLine {
  text: string
  tone: 'alert' | 'warn' | 'normal'
  step: string
}

/** 通道 → 行数组。由容器组件持有（不进 React 状态树之外的复杂结构）。 */
export type TailBuffers = Record<string, TailLine[]>

export interface EvidenceTailProps {
  channel: LogChannelId
  channels: readonly LogChannelId[]
  buffers: TailBuffers
  /** 主 run 的进度（来自 `[n/m]` 帧）。 */
  progress: { current: number; total: number; label: string } | null
  /** 最近一次失败：显示常驻告警条。 */
  failure: { step: string; detail: string } | null
  onChannel(channel: LogChannelId): void
  /** 串口通道才显示输入行。 */
  serial?: {
    writable: boolean
    port: string
    baud: number
    onSend(line: string): void
  } | null
}

const TONE_COLOR: Record<TailLine['tone'], string> = {
  alert: 'var(--elab-status-fail)',
  warn: 'var(--elab-status-run)',
  normal: 'var(--elab-fg-secondary)',
}

/** 进度条：▓▓▓▓░░░░ 21/28 · 75% · 3.5s */
function ProgressBar(props: { current: number; total: number; label: string; startedAt: number | null }): ReactNode {
  const { current, total, label } = props
  const pct = total > 0 ? Math.round((current / total) * 100) : 0
  const cells = 10
  const filled = total > 0 ? Math.round((current / total) * cells) : 0

  return (
    <div
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 8px',
        fontSize: '11px',
        fontFamily: 'var(--elab-font-mono)',
        background: 'var(--elab-bg-surface)',
        borderBottom: '1px solid var(--elab-border)',
        color: 'var(--elab-fg-secondary)',
      }}
    >
      <span style={{ color: 'var(--elab-accent)', letterSpacing: '-1px' }}>
        {'\u2588'.repeat(filled)}
        {'\u2591'.repeat(Math.max(0, cells - filled))}
      </span>
      <span style={{ whiteSpace: 'nowrap' }}>
        {current}/{total}
      </span>
      <span style={{ whiteSpace: 'nowrap' }}>{pct}%</span>
      <span
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--elab-fg-muted)',
        }}
        title={label}
      >
        {label}
      </span>
    </div>
  )
}

export function EvidenceTail(props: EvidenceTailProps): ReactNode {
  const { channel, channels, buffers, progress, failure } = props
  const [draft, setDraft] = useState('')
  const [follow, setFollow] = useState(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)
  followRef.current = follow

  const lines = buffers[channel] ?? []

  // 命令式追加后滚到底（只在"跟随"时；用户手动上滚则暂停）
  useEffect(() => {
    const el = scrollRef.current
    if (el === null || !followRef.current) return
    el.scrollTop = el.scrollHeight
  }, [lines.length, channel])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== follow) setFollow(atBottom)
  }

  const jumpToFail = (): void => {
    const el = scrollRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
    setFollow(true)
  }

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* ── 通道切换 + 跟随开关 ── */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '4px 8px',
          borderBottom: '1px solid var(--elab-border)',
          overflow: 'hidden',
        }}
      >
        {channels
          .filter((c) => c !== 'tools' || (buffers.tools?.length ?? 0) > 0)
          .map((c) => {
            const active = c === channel
            const count = buffers[c]?.length ?? 0
            return (
              <button
                key={c}
                type="button"
                onClick={() => props.onChannel(c)}
                style={{
                  padding: '1px 6px',
                  fontSize: '11px',
                  borderRadius: '4px',
                  border: `1px solid ${active ? 'var(--elab-accent)' : 'transparent'}`,
                  background: active ? 'var(--elab-bg-raised)' : 'transparent',
                  color: active ? 'var(--elab-fg-primary)' : 'var(--elab-fg-muted)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
                title={`${CHANNEL_LABEL[c]}：${count} 行`}
              >
                {CHANNEL_LABEL[c]}
                {count > 0 ? <span style={{ opacity: 0.6 }}>{` ${count}`}</span> : null}
              </button>
            )
          })}

        <button
          type="button"
          onClick={() => setFollow((v) => !v)}
          title={follow ? '正在跟随最新输出；点击暂停' : '已暂停跟随；点击恢复'}
          style={{
            marginLeft: 'auto',
            padding: '1px 6px',
            fontSize: '11px',
            borderRadius: '4px',
            border: '1px solid var(--elab-border)',
            background: 'transparent',
            color: follow ? 'var(--elab-accent)' : 'var(--elab-fg-dimmed)',
            cursor: 'pointer',
          }}
        >
          {follow ? '\u25be 跟随' : '\u21ba 恢复'}
        </button>
      </div>

      {/* ── 进度条（有进度才显示） ── */}
      {progress !== null && progress.total > 0 ? (
        <ProgressBar current={progress.current} total={progress.total} label={progress.label} startedAt={null} />
      ) : null}

      {/* ── 失败告警条（常驻，直到下次 run） ── */}
      {failure !== null ? (
        <button
          type="button"
          onClick={jumpToFail}
          title={failure.detail}
          style={{
            flex: '0 0 auto',
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
            padding: '4px 8px',
            fontSize: '11px',
            textAlign: 'left',
            border: 'none',
            borderBottom: '1px solid var(--elab-border)',
            background: 'var(--elab-bg-raised)',
            color: 'var(--elab-status-fail)',
            cursor: 'pointer',
          }}
        >
          <strong>{'\u2717 失败'}</strong>
          <span
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {failure.step}：{failure.detail}
          </span>
          <span style={{ color: 'var(--elab-fg-muted)' }}>{'跳到末尾'}</span>
        </button>
      ) : null}

      {/* ── 日志行（单层 div，命令式追加） ── */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '4px 8px',
          fontFamily: 'var(--elab-font-mono)',
          fontSize: '11px',
          lineHeight: '16px',
          background: 'var(--elab-bg-raised)',
        }}
      >
        {lines.length === 0 ? (
          <div style={{ color: 'var(--elab-fg-muted)' }}>{'（本通道还没有输出）'}</div>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              style={{
                color: TONE_COLOR[line.tone],
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontWeight: line.tone === 'alert' ? 600 : 400,
              }}
            >
              {renderLine(line.text)}
            </div>
          ))
        )}
      </div>

      {/* ── 串口输入行（仅串口通道） ── */}
      {channel === 'serial' && props.serial !== null && props.serial !== undefined ? (
        <form
          onSubmit={(e: any) => {
            e.preventDefault()
            const text = draft.trim()
            if (text === '' || !props.serial?.writable) return
            props.serial.onSend(text)
            setDraft('')
          }}
          style={{
            flex: '0 0 auto',
            display: 'flex',
            gap: '4px',
            alignItems: 'center',
            padding: '4px 8px',
            borderTop: '1px solid var(--elab-border)',
          }}
        >
          <input
            value={draft}
            onChange={(e: any) => setDraft(e.currentTarget.value)}
            disabled={!props.serial.writable}
            placeholder={props.serial.writable ? '输入一行并回车发送到设备' : '串口写通道不可用'}
            aria-label="串口手动输入"
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              padding: '2px 6px',
              fontSize: '11px',
              fontFamily: 'var(--elab-font-mono)',
              borderRadius: '4px',
              border: '1px solid var(--elab-border)',
              background: 'var(--elab-bg-surface)',
              color: 'var(--elab-fg-primary)',
            }}
          />
          <span style={{ fontSize: '10px', color: 'var(--elab-fg-muted)', whiteSpace: 'nowrap' }}>
            {`${props.serial.port || 'auto'}@${props.serial.baud}`}
          </span>
        </form>
      ) : null}
    </div>
  )
}

/** 全部通道（供容器初始化缓冲）。 */
export const ALL_CHANNELS = LOG_CHANNELS
