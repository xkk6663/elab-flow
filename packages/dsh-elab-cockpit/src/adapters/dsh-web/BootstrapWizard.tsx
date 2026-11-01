/**
 * 安装向导（面板空态）—— 四步：环境自检 → 内核来源 → 工具链体检 → 工程接入，
 * 顶部另有「自动准备」进度卡（零前置：首次打开自动下载内核 / 回落浅克隆 / 装工具链）。
 *
 * 设计（方案 §3.4）：
 *   - 只读优先：环境探测来自 `GET /elab/env`，本组件不发任何写请求；
 *   - 写动作都要一次显式确认：`clone` 走"点击 → 再点确认"两段式；
 *   - 工具链缺件只标 warn，不阻断（真正结论由内核 doctor 在工程接入后跑）；
 *   - 自动准备的状态/文案全部来自宿主半（props.auto），本组件只渲染 + 给重试入口。
 *
 * 组件是叶子：只收 props（不 import 编排服务），接线在 CockpitPane。
 */

import React from 'react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { AutoProvisionStatus, AutoProvisionStep, EnvProbe, ProbeItem } from '../../domain/icd.ts'
import { deriveBootstrapPhase, stepStates } from '../../domain/bootstrap.ts'
import type { BootstrapStepId } from '../../domain/bootstrap.ts'

const DEFAULT_KERNEL_URL = 'https://github.com/xkk6663/elab-flow'
const DISMISS_KEY = 'elab.bootstrap.dismissedAt'

export interface BootstrapWizardProps {
  env: EnvProbe | null
  envBusy: boolean
  envError: string | null
  bootstrapBusy: boolean
  bootstrapError: string | null
  bootstrapNotice: string | null
  elabRoot: string | null
  hostOk: boolean | null
  hostError: string | null
  projectCount: number
  /** 零前置自动准备：宿主半维护的实时状态（本组件只渲染）。 */
  auto: AutoProvisionStatus
  onRefreshEnv(): void
  onSetRoot(dir: string): void
  onClone(url: string, dir: string): void
  /** 一键环境包：下载官方 GCC / CMake / Ninja / OpenOCD 并注入 ELAB_*（需用户点击）。 */
  onInstallToolchain(): void
  /** 自动准备失败/卡住后重跑（同一个宿主流程）。 */
  onRetryAuto(): void
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--elab-border)',
  borderRadius: 'var(--elab-radius)',
  padding: '10px 12px',
  marginBottom: '8px',
  background: 'var(--elab-bg-surface)',
}

const inputStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  padding: '3px 8px',
  fontSize: '12px',
  borderRadius: '6px',
  border: '1px solid var(--elab-border)',
  background: 'var(--elab-bg-surface)',
  color: 'var(--elab-fg-primary)',
}

const buttonStyle: React.CSSProperties = {
  padding: '3px 12px',
  fontSize: '12px',
  borderRadius: '6px',
  border: '1px solid var(--elab-btn-primary-border)',
  background: 'var(--elab-btn-primary-bg)',
  color: 'var(--elab-btn-primary-fg)',
  cursor: 'pointer',
}

function statusColor(state: 'done' | 'warn' | 'blocked'): string {
  if (state === 'done') return 'var(--elab-status-ok)'
  if (state === 'warn') return 'var(--elab-status-run)'
  return 'var(--elab-status-fail)'
}

function dot(state: 'done' | 'warn' | 'blocked'): ReactNode {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        marginRight: '6px',
        background: statusColor(state),
        verticalAlign: 'middle',
      }}
    />
  )
}

function probeLine(label: string, item: ProbeItem | undefined, busy: boolean): ReactNode {
  const ok = item?.ok === true
  return (
    <div key={label} style={{ fontSize: '11px', lineHeight: 1.8, color: 'var(--elab-fg-secondary)' }}>
      {dot(ok ? 'done' : item === undefined ? 'warn' : 'warn')}
      <span style={{ color: 'var(--elab-fg-primary)' }}>{label}</span>
      <span style={{ marginLeft: '6px', color: 'var(--elab-fg-muted)' }}>
        {ok ? (item?.version ?? '可用') : busy ? '检测中…' : (item?.error ?? '未检测到')}
      </span>
    </div>
  )
}

function stepHeader(index: number, title: string, state: 'done' | 'warn' | 'blocked'): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '6px' }}>
      {dot(state)}
      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--elab-fg-primary)' }}>
        {`${index}. ${title}`}
      </span>
    </div>
  )
}

/** 自动准备的步骤名（stage 文案由宿主给，这里只补"当前在哪一步"）。 */
const AUTO_STEP_LABEL: Record<AutoProvisionStep, string> = {
  probe: '环境自检',
  kernel: '准备内核',
  toolchain: '安装工具链',
  done: '完成',
}

/** 进度条段数（无 CSS keyframes：靠 active 段位移制造"在跑"的进度感）。 */
const AUTO_SEGMENTS = 12

/** 运行中每 320ms 前进一段；停下时不动（组件仍可渲染静态态）。 */
function useAutoPulse(active: boolean): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((t) => (t + 1) % AUTO_SEGMENTS), 320)
    return () => clearInterval(id)
  }, [active])
  return tick
}

function autoTone(phase: AutoProvisionStatus['phase']): 'done' | 'warn' | 'blocked' {
  if (phase === 'done') return 'done'
  if (phase === 'blocked' || phase === 'failed') return 'blocked'
  return 'warn'
}

export function BootstrapWizard(props: BootstrapWizardProps): ReactNode {
  const {
    env,
    envBusy,
    envError,
    bootstrapBusy,
    bootstrapError,
    bootstrapNotice,
    elabRoot,
    hostOk,
    hostError,
    projectCount,
    auto,
    onRefreshEnv,
    onSetRoot,
    onClone,
    onInstallToolchain,
    onRetryAuto,
  } = props

  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return globalThis.localStorage?.getItem(DISMISS_KEY) !== null
    } catch {
      return false
    }
  })
  const [rootDraft, setRootDraft] = useState('')
  const [cloneDir, setCloneDir] = useState('')
  const [cloneUrl, setCloneUrl] = useState(DEFAULT_KERNEL_URL)
  const [confirmClone, setConfirmClone] = useState(false)

  const phase = deriveBootstrapPhase({
    elabRoot,
    hostOk,
    pythonOk: env === null ? null : env.python.ok,
    projectCount,
  })
  const states = stepStates(phase)

  const autoRunning = auto.phase === 'running'
  const autoTick = useAutoPulse(autoRunning)
  /** 自动流程在跑时，手动写动作一并禁用（同一个宿主，避免抢同一份下载）。 */
  const writeBusy = bootstrapBusy || autoRunning
  const autoStepText = auto.step === null ? '' : AUTO_STEP_LABEL[auto.step]

  const header = (state: BootstrapStepId, index: number, title: string): ReactNode =>
    stepHeader(index, title, states[state])

  if (dismissed) {
    return (
      <div style={{ padding: '12px', fontSize: '12px', color: 'var(--elab-fg-primary)', lineHeight: 1.7 }}>
        <div style={{ fontWeight: 600 }}>{'驾驶舱未就绪'}</div>
        <div style={{ color: 'var(--elab-fg-secondary)' }}>{hostError ?? '未找到 elab 仓库根'}</div>
        <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            style={buttonStyle}
            onClick={() => {
              try {
                globalThis.localStorage?.removeItem(DISMISS_KEY)
              } catch {
                /* localStorage 不可用：仅本次会话内展开 */
              }
              setDismissed(false)
            }}
          >
            {'打开安装向导'}
          </button>
          <span style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>
            {auto.phase === 'running' ? `正在自动准备：${auto.stage}` : '首次打开会自动准备内核与工具链（只写 ~/.dsh/elab）'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="elab-root" style={{ padding: '12px', fontSize: '12px', color: 'var(--elab-fg-primary)', lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' }}>
        <span style={{ fontWeight: 600 }}>{'安装向导'}</span>
        <span style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>{`当前阶段：${phase}`}</span>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--elab-fg-secondary)', marginBottom: '10px' }}>
        {`零前置：首次打开会自动准备内核 v${auto.kernelVersion} 与工具链（只写 ~/.dsh/elab，不写你的工作区）。唯一需要你自己装的是主机 Python。`}
      </div>

      {/* 0 自动准备（零前置流程） */}
      <div style={cardStyle} aria-live="polite" aria-busy={autoRunning}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '6px' }}>
          {dot(autoTone(auto.phase))}
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--elab-fg-primary)' }}>{'自动准备'}</span>
          <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--elab-fg-muted)' }}>
            {auto.phase === 'disabled' ? '已关闭' : auto.phase === 'idle' ? '待启动' : auto.phase === 'running' ? '进行中' : auto.phase === 'done' ? '完成' : auto.phase === 'blocked' ? '需要你处理' : '失败'}
          </span>
        </div>

        {autoRunning ? (
          <div>
            <div style={{ fontSize: '11px', color: 'var(--elab-fg-primary)', marginBottom: '4px', wordBreak: 'break-word' }}>
              {autoStepText === '' ? auto.stage : `${autoStepText} · ${auto.stage}`}
            </div>
            <div aria-hidden="true" style={{ display: 'flex', gap: '2px' }}>
              {Array.from({ length: AUTO_SEGMENTS }, (_, i) => (
                <span
                  key={i}
                  style={{
                    flex: '1 1 auto',
                    height: '3px',
                    borderRadius: '2px',
                    background: (i + autoTick) % AUTO_SEGMENTS < 4 ? 'var(--elab-accent)' : 'var(--elab-bg-raised)',
                  }}
                />
              ))}
            </div>
            <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--elab-fg-muted)' }}>
              {'可以关掉面板，下次打开会自动续上进度；下载与解压都走环境包的 sha256 校验。'}
            </div>
          </div>
        ) : auto.phase === 'blocked' ? (
          <div>
            <div style={{ fontSize: '11px', color: 'var(--elab-status-fail)', marginBottom: '4px' }}>
              {auto.blocked?.message ?? auto.stage}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--elab-fg-secondary)', marginBottom: '6px' }}>
              {auto.blocked?.hint ?? ''}
            </div>
            <button style={buttonStyle} onClick={onRetryAuto}>{'重试'}</button>
          </div>
        ) : auto.phase === 'failed' ? (
          <div>
            <div style={{ fontSize: '11px', color: 'var(--elab-status-fail)', marginBottom: '6px' }}>
              {auto.error?.message ?? '自动准备失败'}
            </div>
            {auto.error?.retryable === false ? (
              <span style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>{'该错误重试无法解决，请用下方手动入口。'}</span>
            ) : (
              <button style={buttonStyle} onClick={onRetryAuto}>{'重试'}</button>
            )}
          </div>
        ) : auto.phase === 'done' ? (
          <div style={{ fontSize: '11px', color: 'var(--elab-status-ok)' }}>{auto.stage}</div>
        ) : auto.phase === 'disabled' ? (
          <div style={{ fontSize: '11px', color: 'var(--elab-fg-secondary)' }}>
            {`自动准备已在设置页关闭${auto.stage === '' ? '' : `（${auto.stage}）`}：下面是手动入口。`}
          </div>
        ) : (
          <div style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>
            {'首次打开面板会自动准备内核与工具链；也可以用下面的手动入口。'}
          </div>
        )}
      </div>

      {/* 1 环境 */}
      <div style={cardStyle}>
        {header('env', 1, '环境自检')}
        {env === null ? (
          <div style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>
            {envBusy ? '正在检测 python / git / 工具链…' : '尚未检测'}
          </div>
        ) : (
          <div>
            {probeLine(`python${env.python.path === undefined ? '' : ` (${env.python.path})`}`, env.python, envBusy)}
            {probeLine('pyserial（串口读写）', env.pyserial, envBusy)}
            {probeLine('git（克隆内核）', env.git, envBusy)}
          </div>
        )}
        {env !== null && env.python.ok === false ? (
          <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--elab-fg-secondary)' }}>
            {'未找到 python：请安装 Python 3.10+，或在设置页把「python 路径」填成绝对路径（如 C:\\Python312\\python.exe）。'}
          </div>
        ) : null}
        <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button style={buttonStyle} onClick={onRefreshEnv} disabled={envBusy}>
            {envBusy ? '检测中…' : '重新检测'}
          </button>
          {envError !== null ? (
            <span style={{ fontSize: '11px', color: 'var(--elab-status-fail)' }}>{`检测失败：${envError}`}</span>
          ) : null}
        </div>
      </div>

      {/* 2 内核 */}
      <div style={cardStyle}>
        {header('kernel', 2, '内核来源')}
        {elabRoot !== null ? (
          <div style={{ fontSize: '11px', color: 'var(--elab-fg-secondary)', wordBreak: 'break-all' }}>
            {`已找到内核：${elabRoot}`}
          </div>
        ) : (
          <div style={{ fontSize: '11px', color: 'var(--elab-fg-secondary)' }}>
            {'未找到内核。可以指定一个已有的 elab 仓库目录，或浅克隆一份（约几十 MB）。'}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
          <input
            style={inputStyle}
            value={rootDraft}
            onChange={(e: { currentTarget: { value: string } }) => setRootDraft(e.currentTarget.value)}
            placeholder="已有仓库根：D:\\elab-flow"
            aria-label="elab 仓库根"
          />
          <button
            style={buttonStyle}
            disabled={writeBusy || rootDraft.trim() === ''}
            onClick={() => onSetRoot(rootDraft.trim())}
          >
            {'使用此目录'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
          <input
            style={{ ...inputStyle, flex: '0 1 45%' }}
            value={cloneUrl}
            onChange={(e: { currentTarget: { value: string } }) => setCloneUrl(e.currentTarget.value)}
            placeholder="https://github.com/<org>/elab-flow"
            aria-label="内核仓库地址"
          />
          <input
            style={inputStyle}
            value={cloneDir}
            onChange={(e: { currentTarget: { value: string } }) => setCloneDir(e.currentTarget.value)}
            placeholder="克隆到（必须是空目录）"
            aria-label="克隆目标目录"
          />
          <button
            style={buttonStyle}
            disabled={writeBusy || cloneDir.trim() === ''}
            onClick={() => setConfirmClone(true)}
          >
            {'浅克隆'}
          </button>
        </div>
        {confirmClone ? (
          <div
            style={{
              marginTop: '8px',
              padding: '8px',
              border: '1px solid var(--elab-border-strong)',
              borderRadius: 'var(--elab-radius-sm)',
              fontSize: '11px',
              color: 'var(--elab-fg-secondary)',
            }}
          >
            {`将执行 git clone --depth 1 ${cloneUrl} → ${cloneDir}（会写盘）。`}
            <div style={{ marginTop: '6px', display: 'flex', gap: '8px' }}>
              <button
                style={buttonStyle}
                disabled={writeBusy}
                onClick={() => {
                  setConfirmClone(false)
                  onClone(cloneUrl.trim(), cloneDir.trim())
                }}
              >
                {'确认克隆'}
              </button>
              <button
                style={{ ...buttonStyle, background: 'transparent', color: 'var(--elab-fg-secondary)' }}
                onClick={() => setConfirmClone(false)}
              >
                {'取消'}
              </button>
            </div>
          </div>
        ) : null}
        {hostError !== null ? (
          <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--elab-fg-muted)' }}>{hostError}</div>
        ) : null}
      </div>

      {/* 3 工具链 */}
      <div style={cardStyle}>
        {header('toolchain', 3, '工具链体检')}
        <div style={{ fontSize: '11px', color: 'var(--elab-fg-muted)', marginBottom: '4px' }}>
          {'缺件只影响编译 / 烧录 / 调试，不阻断面板。可一键下载官方工具链（不需要本机预装）。'}
        </div>
        {env === null ? (
          <div style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>{'随第 1 步一起检测'}</div>
        ) : (
          <div>
            {probeLine('arm-none-eabi-gcc（编译）', env.armGcc, envBusy)}
            {probeLine('cmake（构建）', env.cmake, envBusy)}
            {probeLine('ninja（构建）', env.ninja, envBusy)}
            {probeLine('openocd（烧录/调试）', env.openocd, envBusy)}
          </div>
        )}
        <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button style={buttonStyle} onClick={onInstallToolchain} disabled={writeBusy}>
            {bootstrapBusy ? '安装中…' : '一键安装工具链'}
          </button>
          <span style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>
            {'下载到 ~/.dsh/elab/env（约 400 MB），失败即中断'}
          </span>
        </div>
      </div>

      {/* 4 工程 */}
      <div style={cardStyle}>
        {header('project', 4, '工程接入')}
        <div style={{ fontSize: '11px', color: 'var(--elab-fg-secondary)' }}>
          {hostOk !== true
            ? '内核就绪后，用面板里的「＋适配」接入工程。'
            : projectCount > 0
              ? `已接入 ${projectCount} 个工程。`
              : '内核已就绪，但还没有工程：用面板里的「＋适配」选择一个固件目录。'}
        </div>
      </div>

      {bootstrapError !== null ? (
        <div style={{ fontSize: '11px', color: 'var(--elab-status-fail)', marginBottom: '6px' }}>
          {`操作失败：${bootstrapError}`}
        </div>
      ) : null}
      {bootstrapNotice !== null ? (
        <div style={{ fontSize: '11px', color: 'var(--elab-status-ok)', marginBottom: '6px' }}>{bootstrapNotice}</div>
      ) : null}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          style={{ ...buttonStyle, background: 'transparent', color: 'var(--elab-fg-secondary)' }}
          onClick={() => {
            try {
              globalThis.localStorage?.setItem(DISMISS_KEY, String(Date.now()))
            } catch {
              /* 关不掉就每次都展开，不影响功能 */
            }
            setDismissed(true)
          }}
        >
          {'暂时隐藏'}
        </button>
        <span style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>
          {'不会自动 pip install / git pull；升级内核请手动执行 git pull --ff-only'}
        </span>
      </div>
    </div>
  )
}
