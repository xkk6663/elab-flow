/**
 * 控制条（ManualBar）—— 三档一键流 + 取消 + 预览 + 选项。
 *
 * 决策依据：
 *  - Q7：触发面只有三档（编译 / 三连 / 闭环）+ 单步，**不做部分步骤多选**。
 *  - Q9：三连与闭环一致，不可用步骤**剔除**而非拒绝，但必须显式说明跳过了什么。
 *  - Q18：`--clean` 会**先删工作目录且不可逆**，勾选后点任一带 clean 的动作，
 *         弹**行内**二次确认（非模态，不打断），删除路径取自 `/api/plan` 预览。
 *  - 失败即中断：闭环任一步失败就 break（run.py:528），本组件不提供"忽略错误继续"。
 */

import React from 'react'
import { useState } from 'react'
import type { ReactNode } from 'react'

import type { PlanView, StepAvailability } from '../../domain/pipeline.ts'
import { describeSkipped, stepLabel } from '../../domain/pipeline.ts'

export interface ManualBarProps {
  plans: PlanView[]
  running: boolean
  busy: boolean
  /** `--clean` 的删除目标路径（取自 plan 预览；null = 未知）。 */
  cleanTarget: string | null
  /** 每步可用性（单步启动按钮的置灰依据）。 */
  availability: StepAvailability
  /** 常驻监视是否开着（串口超按钮的状态点）。 */
  serialActive: boolean
  onRun(planId: string, opts: { clean: boolean; jobs: number | null }): void
  /** 单步执行（构建/烧录/调试）。 */
  onRunOne(step: string): void
  /** 串口通道的启停开关：切到串口页；未开则打开常驻监视，已在跑则关闭并释放串口。 */
  onSerial(): void
  onCancel(): void
  onPreview(opts: { clean: boolean; jobs: number | null }): void
}

const chipBase: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '11px',
  borderRadius: '6px',
  border: '1px solid var(--elab-border)',
  background: 'var(--elab-bg-surface)',
  color: 'var(--elab-fg-secondary)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  lineHeight: '16px',
}

/** 主档（三连）比普通 chip 大一号：一眼能找到「一键跑完」。 */
const chipPrimaryBig: React.CSSProperties = {
  ...chipBase,
  padding: '5px 14px',
  fontSize: '12px',
  borderRadius: '8px',
  fontWeight: 600,
  background: 'var(--elab-btn-primary-bg)',
  borderColor: 'var(--elab-btn-primary-border)',
  color: 'var(--elab-btn-primary-fg)',
}

/** 单步行的小按钮：比动作行轻，视觉上退到第二层。 */
const chipSmall: React.CSSProperties = {
  ...chipBase,
  padding: '3px 8px',
  fontSize: '10.5px',
  lineHeight: '15px',
}

function chipFor(primary: boolean, disabled: boolean): React.CSSProperties {
  if (disabled) {
    return {
      ...(primary ? chipPrimaryBig : chipBase),
      background: 'transparent',
      borderColor: 'var(--elab-border)',
      color: 'var(--elab-fg-dimmed)',
      boxShadow: 'none',
      cursor: 'not-allowed',
    }
  }
  if (primary) return chipPrimaryBig
  return chipBase
}

/** 单步行按钮（小一号；禁用时同样退成灰）。 */
function chipSmallFor(disabled: boolean): React.CSSProperties {
  if (disabled) {
    return {
      ...chipSmall,
      background: 'transparent',
      color: 'var(--elab-fg-dimmed)',
      cursor: 'not-allowed',
    }
  }
  return chipSmall
}

/** 单步启动按钮（每个通道自己的启动入口；串口单独处理）。 */
const STEP_BUTTONS: ReadonlyArray<{ step: string }> = [
  { step: 'build' },
  { step: 'flash' },
  { step: 'debug_verify' },
]

export function ManualBar(props: ManualBarProps): ReactNode {
  const { plans, running, busy, cleanTarget } = props
  const [clean, setClean] = useState(false)
  const [jobs, setJobs] = useState<number | null>(null)
  const [optsOpen, setOptsOpen] = useState(false)
  /** 已勾 clean、等确认的那一档；null = 无待确认。 */
  const [pending, setPending] = useState<string | null>(null)

  const fire = (planId: string, withClean: boolean): void => {
    props.onRun(planId, { clean: withClean, jobs })
  }

  /** 点某一档：勾了 clean 就先要确认。 */
  const request = (planId: string): void => {
    if (clean) {
      setPending(planId)
      return
    }
    fire(planId, false)
  }

  const confirm = (): void => {
    const planId = pending
    setPending(null)
    if (planId !== null) fire(planId, true)
  }

  const cancelConfirm = (): void => setPending(null)

  return (
    <div style={{ flex: '0 0 auto', borderBottom: '1px solid var(--elab-border)' }}>
      {/* ── 动作行：三连 / 闭环（单步启动在下一行） ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 8px 6px', flexWrap: 'wrap' }}>
        {plans
          .filter((plan) => plan.id !== 'basic')
          .map((plan) => {
            const disabled = running || busy || !plan.enabled
            const tip = plan.enabled ? describeSkipped(plan) || plan.hint : `不可用：${plan.reason ?? '未知原因'}`
            return (
              <button
                key={plan.id}
                type="button"
                disabled={disabled}
                title={tip}
                onClick={() => request(plan.id)}
                style={chipFor(plan.id === 'triple', disabled)}
              >
                {plan.label}
              </button>
            )
          })}

        <button
          type="button"
          disabled={!running}
          title="杀掉整棵进程树（cmake → ninja → gcc）"
          onClick={props.onCancel}
          style={{
            ...chipFor(false, !running),
            ...(running
              ? { borderColor: 'var(--elab-status-fail)', color: 'var(--elab-status-fail)' }
              : {}),
          }}
        >
          {'\u25a0 取消'}
        </button>

        <button
          type="button"
          disabled={busy}
          title="只读预览：打印将执行的每条命令，不 spawn、不写盘"
          onClick={() => props.onPreview({ clean, jobs })}
          style={chipFor(false, busy)}
        >
          {'\u25c9 预览'}
        </button>

        <button
          type="button"
          title="运行选项（--clean / -j）"
          onClick={() => setOptsOpen((v) => !v)}
          style={{ ...chipFor(false, false), marginLeft: 'auto' }}
        >
          {'\u2699'}
        </button>
      </div>

      {/* ── 单步启动行：构建 / 烧录 / 调试 / 串口，每个通道各自启动 ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 8px 7px',
          flexWrap: 'wrap',
          borderTop: '1px dashed color-mix(in srgb, var(--elab-border) 70%, transparent)',
          background: 'color-mix(in srgb, var(--elab-bg-surface) 55%, transparent)',
        }}
      >
        <span style={{ flex: '0 0 auto', fontSize: '10px', color: 'var(--elab-fg-faint)', letterSpacing: '0.04em' }}>
          单步
        </span>
        {STEP_BUTTONS.map((b) => {
          const av = props.availability[b.step]
          const disabled = running || busy || (av?.ok === false)
          const tip = av?.ok === false ? `不可用：${av.reason ?? '未知原因'}` : `只跑这一步：${stepLabel(b.step)}`
          return (
            <button
              key={b.step}
              type="button"
              disabled={disabled}
              title={tip}
              onClick={() => props.onRunOne(b.step)}
              style={chipSmallFor(disabled)}
            >
              {`\u25b6 ${stepLabel(b.step)}`}
            </button>
          )
        })}

        <button
          type="button"
          disabled={running || busy}
          title={props.serialActive ? '串口监视正在运行：点击关闭并释放串口（闭环烧录/调试需要）' : '启动串口通道：打开常驻监视并实时收设备输出'}
          onClick={props.onSerial}
          style={{
            ...chipSmallFor(running || busy),
            marginLeft: 'auto',
            ...(props.serialActive
              ? { borderColor: 'var(--elab-status-ok)', color: 'var(--elab-status-ok)' }
              : {}),
          }}
        >
          {props.serialActive ? '\u25a0 关闭监视' : '\u25b6 打开监视'}
        </button>
      </div>

      {/* ── 选项区（折叠） ── */}
      {optsOpen ? (
        <div
          style={{
            display: 'flex',
            gap: '10px',
            alignItems: 'center',
            padding: '0 10px 8px',
            fontSize: '11px',
            color: 'var(--elab-fg-secondary)',
            flexWrap: 'wrap',
          }}
        >
          <label style={{ display: 'flex', gap: '4px', alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={clean}
              onChange={(e: any) => {
                setClean(e.currentTarget.checked)
                setPending(null)
              }}
            />
            <span>{'--clean 先删工作目录'}</span>
          </label>

          <label style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <span>{'-j'}</span>
            <input
              type="number"
              min={1}
              max={64}
              value={jobs ?? ''}
              placeholder="默认"
              onChange={(e: any) => {
                const v = e.currentTarget.value
                setJobs(v === '' ? null : Math.max(1, Math.min(64, Number(v) || 1)))
              }}
              style={{
                width: '48px',
                padding: '1px 4px',
                fontSize: '11px',
                borderRadius: '4px',
                border: '1px solid var(--elab-border)',
                background: 'var(--elab-bg-surface)',
                color: 'var(--elab-fg-primary)',
              }}
            />
          </label>
        </div>
      ) : null}

      {/* ── --clean 行内二次确认（非模态） ── */}
      {pending !== null ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'flex-start',
            padding: '6px 10px',
            margin: '0 8px 6px',
            borderRadius: '6px',
            border: '1px solid var(--elab-status-run)',
            background: 'var(--elab-bg-raised)',
            fontSize: '11px',
            lineHeight: 1.5,
            color: 'var(--elab-fg-primary)',
          }}
        >
          <span style={{ flex: '1 1 auto', minWidth: 0 }}>
            <strong style={{ color: 'var(--elab-status-run)' }}>{'不可逆：'}</strong>
            {'将先删除工作目录'}
            {cleanTarget !== null ? ` ${cleanTarget}` : ''}
            {'，然后重新配置编译。'}
          </span>
          <button type="button" onClick={confirm} style={{ ...chipFor(true, false), padding: '2px 8px' }}>
            {'确认'}
          </button>
          <button type="button" onClick={cancelConfirm} style={{ ...chipFor(false, false), padding: '2px 8px' }}>
            {'取消'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
