/**
 * CockpitPane —— 窄栏根容器：**只剩渲染**（批 2 编排下沉后的形态）。
 *
 * 数据流（单向）：
 *   cockpit-service（app 层编排）
 *     ├─ snapshot（useSyncExternalStore）→ StageLadder / ManualBar / 状态条
 *     └─ onRawEvent → 环形缓冲（日志行不进 React 状态）→ EvidenceTail
 *
 * 本组件的职责边界：
 *  - 组装客户端半（elabApi + EventStream 端口 + sessionId → service）——
 *    DSH 把槽位 props 传给组件而非 factory，所以客户端半的组装点在这里
 *    （host 半的组装点在 main.ts）；
 *  - 原始事件 → 日志行落缓冲（通道/语气/步骤行文案是呈现，不是业务）；
 *  - 批 3 适配状态机 banner（unbound/discovered/adapting/bound 的可视化）。
 *
 * 关键纪律（继承自旧实现，一条不丢）：
 *  - **可见性驱动 SSE**：visible 变化 → service.setVisible（断开/续传由端口管）；
 *  - **失败即中断**：不做任何"自动重试"或"跳过继续"；
 *  - 日志行只在 buffer 里追加，按 version 节流重绘。
 */

import React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import { createCockpitService } from '../../app/cockpit-service.ts'
import type { PlanPreview } from '../../domain/icd.ts'
import { channelOfEvent, channelOfStep } from '../../domain/channels.ts'
import type { LogChannelId } from '../../domain/channels.ts'
import { LOG_CHANNELS } from '../../domain/channels.ts'
import type { PlanView } from '../../domain/pipeline.ts'
import type { AdaptCheck } from '../../domain/adapt.ts'
import type { SerialMonitorSnapshot } from '../../domain/icd.ts'
import { elabApi } from '../kernel-http/icd-client.ts'
import { createRunEventsPort } from './events/run-events.ts'
import { BootstrapWizard } from './BootstrapWizard.tsx'
import { StageLadder, stepLabelOf } from './StageLadder.tsx'
import type { LadderStep } from './StageLadder.tsx'
import { ManualBar } from './ManualBar.tsx'
import { EvidenceTail, TAIL_CAPACITY } from './EvidenceTail.tsx'
import type { TailBuffers, TailLine } from './EvidenceTail.tsx'
import { SerialPane } from './SerialPane.tsx'
import type { SerialPortInfo } from './SerialPane.tsx'
import { useSerialStream } from './serial/useSerialStream.ts'
import { PackSettingsView } from './PackSettingsView.tsx'

/** 每个通道的环形缓冲（最多 TAIL_CAPACITY 行）。 */
function pushLine(buf: TailLine[], line: TailLine): void {
  buf.push(line)
  if (buf.length > TAIL_CAPACITY) buf.splice(0, buf.length - TAIL_CAPACITY)
}

function emptyBuffers(): TailBuffers {
  const b: TailBuffers = {}
  for (const c of LOG_CHANNELS) b[c] = []
  return b
}

/** 行色调：stderr / 含 error 关键字 → alert；警告关键字 → warn。 */
function toneOf(text: string): TailLine['tone'] {
  const low = text.toLowerCase()
  if (low.includes('hardfault') || low.includes('hard fault') || low.includes('panic')) return 'alert'
  if (low.includes(' error') || low.includes('failed') || low.includes('✗') || low.startsWith('error')) return 'alert'
  if (low.includes('warning') || low.includes('warn') || low.includes('⚠')) return 'warn'
  return 'normal'
}

/** 串口偏好（端口/波特率）：用户级 UI 偏好，与工程无关，宿主禁写时只在本次会话生效。 */
const SERIAL_PREF_KEY = 'elab.serial.pref'

interface SerialPref {
  port?: string
  baud?: number
  /** 上次选定的解码器（跨会话记忆；'' 或缺省 = 不启用共享解码）。 */
  decoder?: string
}

function readSerialPref(): SerialPref {
  try {
    const raw = window.localStorage.getItem(SERIAL_PREF_KEY)
    if (raw === null) return {}
    const o = JSON.parse(raw) as { port?: unknown; baud?: unknown; decoder?: unknown }
    const out: SerialPref = {}
    if (typeof o.port === 'string' && o.port !== '') out.port = o.port
    if (typeof o.baud === 'number' && Number.isFinite(o.baud) && o.baud > 0) out.baud = o.baud
    if (typeof o.decoder === 'string' && o.decoder !== '') out.decoder = o.decoder
    return out
  } catch {
    return {}
  }
}

function writeSerialPref(p: SerialPref): void {
  try {
    window.localStorage.setItem(SERIAL_PREF_KEY, JSON.stringify(p))
  } catch {
    /* 宿主禁写 localStorage：偏好仅本次会话有效 */
  }
}

export interface CockpitPaneProps {
  /** 会话 id（Host 半据此解析 cwd → elab 仓库根）。 */
  sessionId?: string
  /** 宿主是否把面板显示出来了（不可见时断开 SSE）。 */
  visible?: boolean
}

/**
 * §5.4 宽度三档：ResizeObserver 实测容器宽。
 * 阈值 420/700 为方案初值，待 P0 真实会话读数后校准（见 §5.4 表）。
 */
function usePaneWidth(ref: { readonly current: HTMLDivElement | null }): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries: ResizeObserverEntry[]) => {
      for (const entry of entries) setWidth(Math.round(entry.contentRect.width))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

/** 批 3 适配状态机 banner（discovered/adapting/bound/error 的呈现）。 */
function AdaptBanner(props: {
  phase: string
  pending: Array<{ path: string; dirname: string }>
  adaptingPath: string | null
  lastAdapted: string | null
  /** 最近一次复探测结果（null = 还没探测过）。 */
  check: AdaptCheck | null
  /** 复探测在途（按钮防抖）。 */
  checking: boolean
  /** 已接入工程的磁盘根（null = 工程列表还没给出 root，无法复探测）。 */
  checkRoot: string | null
  error: string | null
  disabled: boolean
  onAdapt(path: string): void
  onCheck(name: string): void
}): ReactNode {
  const {
    phase,
    pending,
    adaptingPath,
    lastAdapted,
    check,
    checking,
    checkRoot,
    error,
    disabled,
    onAdapt,
    onCheck,
  } = props

  if (phase === 'adapting') {
    return (
      <div
        style={{
          flex: '0 0 auto',
          padding: '3px 8px',
          fontSize: '11px',
          color: 'var(--elab-status-run)',
          borderBottom: '1px solid var(--elab-border)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {`一键适配中：${adaptingPath ?? '…'}（探测证据 → 写 projects/*.yaml）`}
      </div>
    )
  }
  if (error !== null) {
    return (
      <div
        role="alert"
        style={{
          flex: '0 0 auto',
          padding: '3px 8px',
          fontSize: '11px',
          color: 'var(--elab-status-fail)',
          borderBottom: '1px solid var(--elab-border)',
        }}
      >
        {`适配失败：${error}`}
      </div>
    )
  }
  if (pending.length === 0) {
    if (phase === 'bound' && lastAdapted !== null) {
      // 复探测结果只对**当前**工程有效：切工程后旧结果不作数（避免误报 drift）。
      const badge = check !== null && check.name === lastAdapted ? check : null
      const badgeText =
        badge === null
          ? null
          : badge.status === 'identical'
            ? '配置一致'
            : badge.status === 'drift'
              ? '工程已漂移（需重新适配）'
              : '配置缺失（需重新适配）'
      const badgeColor =
        badge === null
          ? 'var(--elab-fg-muted)'
          : badge.status === 'identical'
            ? 'var(--elab-status-ok)'
            : 'var(--elab-status-fail)'
      const checkDisabled = disabled || checking || checkRoot === null
      return (
        <div
          style={{
            flex: '0 0 auto',
            padding: '3px 8px',
            fontSize: '11px',
            color: 'var(--elab-status-ok)',
            borderBottom: '1px solid var(--elab-border)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            minWidth: 0,
          }}
        >
          <span
            style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {`已接入工程「${lastAdapted}」——建议跑一次三连自证（体检+编译）`}
          </span>
          {badgeText === null ? null : (
            <span style={{ flex: '0 0 auto', color: badgeColor }}>{`复探测：${badgeText}`}</span>
          )}
          <button
            type="button"
            disabled={checkDisabled}
            onClick={() => onCheck(lastAdapted)}
            title={
              checkRoot === null
                ? '工程列表尚未给出根目录，暂不可复探测'
                : '只读复探测：重新探测后与 projects/<name>.yaml 逐字节比对（不写盘）'
            }
            style={{
              flex: '0 0 auto',
              padding: '0 6px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid var(--elab-border)',
              background: 'transparent',
              color: 'var(--elab-accent)',
              cursor: checkDisabled ? 'default' : 'pointer',
            }}
          >
            {checking ? '探测中…' : '复探测'}
          </button>
        </div>
      )
    }
    return null
  }
  // discovered：每个未接入候选给一个「一键适配」按钮
  return (
    <div
      style={{
        flex: '0 0 auto',
        padding: '3px 8px',
        fontSize: '11px',
        color: 'var(--elab-fg-muted)',
        borderBottom: '1px solid var(--elab-border)',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}
    >
      {pending.map((c) => (
        <div key={c.path} style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <span
            style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={c.path}
          >
            {`发现未接入工程：${c.dirname}`}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAdapt(c.path)}
            title={`接入 ${c.path}（只生成 projects/<name>.yaml，业务工程零改动）`}
            style={{
              flex: '0 0 auto',
              padding: '0 6px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid var(--elab-border)',
              background: 'transparent',
              color: 'var(--elab-accent)',
              cursor: disabled ? 'default' : 'pointer',
            }}
          >
            {'一键适配'}
          </button>
        </div>
      ))}
    </div>
  )
}

export function CockpitPane(props: CockpitPaneProps): ReactNode {
  const { sessionId, visible = true } = props

  // ── 客户端半组装点：elabApi（kernel-http 客户端）+ EventStream 端口 → service ──
  const service = useMemo(
    () => createCockpitService({ api: elabApi, events: createRunEventsPort(), sessionId }),
    [sessionId],
  )
  const snap = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)

  // ── 本地呈现态（日志缓冲 / 频道聚焦，不进 service） ──
  const buffersRef = useRef<TailBuffers>(emptyBuffers())
  const [channel, setChannel] = useState<LogChannelId>('build')
  const [focusStep, setFocusStep] = useState<string | null>(null)
  const [tailVersion, setTailVersion] = useState(0)
  const [cleanTarget, setCleanTarget] = useState<string | null>(null)
  /**
   * 视图开关：'work' = 闭环面板；'settings' = 芯片插件市场 / 芯片包管理。
   * ★ 刻意**不做**成 DSH 的新槽位：设置视图在面板内部整幅覆盖（方案 A，
   *   见 docs/技术分析_侧边栏设置页与芯片插件市场.md）——槽位契约不变，
   *   `verify-client-contract.mjs` 的 3 槽位断言无需改动。
   */
  const [view, setView] = useState<'work' | 'settings'>('work')

  // ── 串口：端口/波特率来自 capabilities；数据面统一在 useSerialStream ──
  const [serialMeta, setSerialMeta] = useState<{
    port: string
    baud: number
    writable: boolean
    ports: SerialPortInfo[]
  }>({
    port: 'auto',
    baud: 115200,
    writable: false,
    ports: [],
  })
  /** 用户显式选的端口/波特率（localStorage 持久化）；高优先级于工程/宿主默认。 */
  const [serialPref, setSerialPref] = useState<SerialPref>(readSerialPref)
  /** capabilities 里的监视快照（别处已开的会话能立刻接上）。 */
  const [serialInitial, setSerialInitial] = useState<SerialMonitorSnapshot | null>(null)
  /** 协议解码器（caps.meta.serial.decoders；缺失时用内置两种）。 */
  const [decoders, setDecoders] = useState<Array<{ id: string; label: string; desc?: string }>>([
    { id: 'justfloat', label: 'JustFloat' },
    { id: 'firewater', label: 'FireWater' },
  ])

  /** 日志追加后节流重绘（≤1 次/100ms）。 */
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bumpTail = useCallback(() => {
    if (bumpTimer.current !== null) return
    bumpTimer.current = setTimeout(() => {
      bumpTimer.current = null
      setTailVersion((v) => v + 1)
    }, 100)
  }, [])

  // ── 生命周期：init / 原始事件订阅 / 可见性 / 释放 ──
  useEffect(() => {
    void service.init()
    return () => service.dispose()
  }, [service])

  useEffect(() => {
    // 原始事件 → 日志行落缓冲（状态归约已由 service 完成，这里只管呈现）
    const ingest = (e: Record<string, unknown>): void => {
      const topic = String(e.topic ?? '')
      const step = String(e.step ?? '')
      const ch = channelOfEvent({ topic, step: e.step } as never)
      if (ch === null) return
      const buf = buffersRef.current[ch] ?? (buffersRef.current[ch] = [])
      if (topic === 'proc/stdout-batch') {
        for (const t of (e.lines as string[] | undefined) ?? []) {
          pushLine(buf, { text: t, tone: toneOf(t), step })
        }
      } else if (topic === 'proc/stdout' || topic === 'proc/stderr') {
        const t = String(e.line ?? '')
        pushLine(buf, { text: t, tone: toneOf(t), step })
      } else if (topic === 'run/step-exit') {
        const ok = Boolean(e.ok)
        const detail = String(e.detail ?? '')
        pushLine(buf, {
          text: `${ok ? '\u2713' : '\u2717'} ${stepLabelOf(step)} ${ok ? '完成' : '失败'}${detail !== '' ? `：${detail}` : ''}`,
          tone: ok ? 'normal' : 'alert',
          step,
        })
      } else if (topic === 'run/step-enter') {
        pushLine(buf, { text: `\u25b6 进入 ${stepLabelOf(step)}`, tone: 'warn', step })
      }
      bumpTail()
    }
    return service.onRawEvent(ingest)
  }, [service, bumpTail])

  useEffect(() => {
    // 只读预览命令 → build 通道缓冲（呈现；请求编排在 service.preview）
    return service.onPreview((p: PlanPreview) => {
      const lines: string[] = []
      for (const entry of p.plan ?? []) {
        for (const argv of entry.commands ?? []) lines.push(argv.join(' '))
        if ((entry.effects ?? []).length > 0) lines.push(`! ${entry.effects.join('；')}`)
      }
      const buf = buffersRef.current.build
      pushLine(buf, { text: '── 只读预览（不会执行）──', tone: 'warn', step: 'preview' })
      for (const l of lines) if (l !== '') pushLine(buf, { text: l, tone: 'normal', step: 'preview' })
      bumpTail()
      setChannel('build')
      // 内核预览的顶层没有稳定字段名：work_dir/clean_target 都试（与旧实现一致）
      const wd = (p as unknown as Record<string, unknown>).work_dir
      const ct = (p as unknown as Record<string, unknown>).clean_target
      setCleanTarget(typeof wd === 'string' ? wd : typeof ct === 'string' ? ct : null)
    })
  }, [service, bumpTail])

  useEffect(() => {
    service.setVisible(visible)
  }, [service, visible])

  // run 切换 → 清缓冲 + 频道复位（旧实现同款）
  const runId = snap.run.run
  useEffect(() => {
    if (runId === null) return
    buffersRef.current = emptyBuffers()
    setChannel('build')
  }, [runId])

  // ── 串口元数据：能力面（端口/波特率/可写） → 工程卡片覆盖 ──
  useEffect(() => {
    let cancelled = false
    void elabApi
      .capabilities(sessionId)
      .then((caps) => {
        if (cancelled) return
        const s = (caps as {
          serial?: {
            host_default?: string
            host_baud?: number
            write_available?: boolean
            ports?: Array<{ name?: string; kind?: string; desc?: string }>
            monitor?: SerialMonitorSnapshot
          }
          meta?: { serial?: { decoders?: Array<{ id?: string; label?: string; desc?: string }> } }
        })
        const serial = s.serial
        if (serial !== undefined) {
          setSerialMeta({
            port: serial.host_default || serial.ports?.[0]?.name || 'auto',
            baud: serial.host_baud ?? 115200,
            writable: serial.write_available === true,
            ports: (serial.ports ?? [])
              .filter((p) => typeof p.name === 'string' && p.name !== '')
              .map((p) => ({
                name: String(p.name),
                ...(typeof p.kind === 'string' ? { kind: p.kind } : {}),
                ...(typeof p.desc === 'string' ? { desc: p.desc } : {}),
              })),
          })
          // ★ 已有会话（别处打开/刷新前就在跑）：直接接上（游标由 hook 从 0 追起）。
          if (serial.monitor !== undefined) setSerialInitial(serial.monitor)
        }
        const list = s.meta?.serial?.decoders
        if (Array.isArray(list) && list.length > 0) {
          setDecoders(
            list
              .filter((d) => typeof d.id === 'string' && d.id !== '')
              .map((d) => ({ id: String(d.id), label: String(d.label ?? d.id), ...(d.desc !== undefined ? { desc: d.desc } : {}) })),
          )
        }
      })
      .catch(() => {
        /* capability 读不到不挡主流程 */
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  useEffect(() => {
    if (snap.project === '') return
    let cancelled = false
    void elabApi
      .projects(sessionId)
      .then((r) => {
        if (cancelled) return
        const cards = (r.projects ?? r.cards ?? []) as Array<{
          name?: string
          serial?: { port?: string; baud?: number }
        }>
        const card = cards.find((c) => String(c.name ?? '') === snap.project)
        const serial = card?.serial
        if (serial === undefined) return
        setSerialMeta((prev) => ({
          ...prev,
          port: serial.port || prev.port,
          baud: serial.baud || prev.baud,
        }))
      })
      .catch(() => {
        /* 读不到就用 capabilities 默认 */
      })
    return () => {
      cancelled = true
    }
  }, [snap.project, sessionId])

  // ── 串口数据面（行 + 字节批次）：只在串口通道可见时轮询 ──
  const serialPort = serialPref.port ?? serialMeta.port
  const serialBaud = serialPref.baud ?? serialMeta.baud

  /** 端口/波特率偏好：本地即时生效（打开监视时按新值解析），并持久化。 */
  const onSerialPort = useCallback((port: string) => {
    setSerialPref((prev) => {
      const next = { ...prev, port }
      writeSerialPref(next)
      return next
    })
  }, [])
  const onSerialBaud = useCallback((baud: number) => {
    setSerialPref((prev) => {
      const next = { ...prev, baud }
      writeSerialPref(next)
      return next
    })
  }, [])
  /**
   * 解码器偏好：'' = 关闭共享解码（从偏好里删掉）。
   * 记住它是为了"下次打开监视从第一批 RX 就按同一协议解码"（P0-4）。
   */
  const onSerialDecoder = useCallback((decoder: string) => {
    setSerialPref((prev) => {
      const next: SerialPref = { ...prev }
      if (decoder === '') delete next.decoder
      else next.decoder = decoder
      writeSerialPref(next)
      return next
    })
  }, [])

  const serialStream = useSerialStream({
    api: elabApi,
    initial: serialInitial,
    project: snap.project,
    port: serialPort,
    baud: serialBaud,
    enabled: channel === 'serial' && visible === true && view === 'work',
    sessionId,
  })

  /** 串口通道的「启动」：切到串口页 + 打开常驻监视（已在跑则只切页）。 */
  const onSerialStart = useCallback(() => {
    setChannel('serial')
    if (!serialStream.active) void serialStream.open(serialPref.decoder)
  }, [serialStream, serialPref.decoder])

  // 阶梯数据：RunSnapshot.steps 与 LadderStep 同形（domain/run.ts 的 StepView）
  const steps: LadderStep[] = snap.run.steps
  const running = snap.run.status === 'running'
  /** 适配复探测在途（P1-5）：只读，不写盘。 */
  const [checkingAdapt, setCheckingAdapt] = useState(false)
  /** 已接入工程的磁盘根（复探测要 POST 给内核）；缺 root 时按钮禁用。 */
  const adaptCheckRoot =
    snap.projects.find((p) => p.name === snap.adapt.lastAdapted)?.root ?? null
  const failure = useMemo(() => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i].state === 'failed') {
        return { step: stepLabelOf(steps[i].id), detail: steps[i].detail || '见日志' }
      }
    }
    return null
  }, [steps])

  const setProject = useCallback(
    (name: string) => {
      service.selectProject(name)
      setFocusStep(null)
    },
    [service],
  )

  /** 单步启动：先切到该步骤对应通道，再发起（点了就能看见自己的输出）。 */
  const onRunOne = useCallback(
    (id: string) => {
      setChannel(channelOfStep(id))
      void service.runOne(id)
    },
    [service],
  )

  // ── 渲染 ──
  if (snap.hostOk === false) {
    // 首启向导（方案 §3.4）：把"未就绪 + 一行字"换成四步可操作卡片
    return (
      <BootstrapWizard
        env={snap.env}
        envBusy={snap.envBusy}
        envError={snap.envError}
        bootstrapBusy={snap.bootstrapBusy}
        bootstrapError={snap.bootstrapError}
        bootstrapNotice={snap.bootstrapNotice}
        elabRoot={snap.adapt.elabRoot}
        hostOk={snap.hostOk}
        hostError={snap.hostError}
        projectCount={snap.projects.length}
        auto={snap.auto}
        onRefreshEnv={() => void service.refreshEnv()}
        onSetRoot={(dir) => void service.setRoot(dir)}
        onClone={(url, dir) => void service.cloneKernel(url, dir)}
        onInstallToolchain={() => void service.installToolchain()}
        onRetryAuto={() => service.retryAutoProvision()}
      />
    )
  }

  // ── §5.4 宽度三档 ──
  const rootRef = useRef<HTMLDivElement | null>(null)
  const paneWidth = usePaneWidth(rootRef)
  const tier: 'narrow' | 'mid' | 'wide' = paneWidth >= 700 ? 'wide' : paneWidth >= 420 ? 'mid' : 'narrow'

  const plans: PlanView[] = snap.plans

  // ── 设置视图：覆盖整个侧边栏（芯片插件市场 / 包管理 / 内核设置）──
  //   ★ 放在所有 hook 之后（hook 调用顺序必须稳定），且在 work 视图的 return 之前。
  if (view === 'settings') {
    return (
      <PackSettingsView
        api={elabApi}
        sessionId={sessionId}
        runActive={running}
        onBack={() => setView('work')}
      />
    )
  }

  return (
    <div
      ref={rootRef}
      className="elab-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--elab-bg-canvas)',
        color: 'var(--elab-fg-primary)',
      }}
    >
      {/* ── 工程条 ── */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '5px 8px',
          borderBottom: '1px solid var(--elab-border)',
          fontSize: '12px',
        }}
      >
        <select
          value={snap.project}
          disabled={running}
          onChange={(e: any) => setProject(e.currentTarget.value)}
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            padding: '1px 4px',
            fontSize: '12px',
            borderRadius: '4px',
            border: '1px solid var(--elab-border)',
            background: 'var(--elab-bg-surface)',
            color: 'var(--elab-fg-primary)',
          }}
          title={running ? '有任务在跑，先取消或等它结束' : '选择工程'}
        >
          {snap.projects.length === 0 ? <option value="">{'（无工程）'}</option> : null}
          {snap.projects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>

        {snap.run.actor !== null ? (
          <span
            style={{
              fontSize: '10px',
              padding: '0 4px',
              borderRadius: '3px',
              background: 'var(--elab-bg-raised)',
              color: snap.run.actor === 'human' ? 'var(--elab-accent)' : 'var(--elab-fg-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            {snap.run.actor === 'human' ? '我点的' : 'agent'}
          </span>
        ) : null}

        {snap.run.status !== 'idle' ? (
          <span
            style={{
              fontSize: '10px',
              whiteSpace: 'nowrap',
              color:
                snap.run.status === 'ok'
                  ? 'var(--elab-status-ok)'
                  : snap.run.status === 'failed'
                    ? 'var(--elab-status-fail)'
                    : snap.run.status === 'cancelled'
                      ? 'var(--elab-status-run)'
                      : 'var(--elab-accent)',
            }}
          >
            {snap.run.status}
          </span>
        ) : null}

        <button
          type="button"
          onClick={() => void service.reloadProjects()}
          title="重新读取 projects/*.yaml"
          style={{
            flex: '0 0 auto',
            padding: '0 5px',
            fontSize: '11px',
            borderRadius: '4px',
            border: '1px solid var(--elab-border)',
            background: 'transparent',
            color: 'var(--elab-fg-secondary)',
            cursor: 'pointer',
          }}
        >
          {'\u21bb'}
        </button>

        <button
          type="button"
          onClick={() => setView('settings')}
          title="芯片插件市场 / 芯片包管理 / 内核设置"
          aria-label="打开设置"
          style={{
            flex: '0 0 auto',
            padding: '0 5px',
            fontSize: '11px',
            borderRadius: '4px',
            border: '1px solid var(--elab-border)',
            background: 'transparent',
            color: 'var(--elab-fg-secondary)',
            cursor: 'pointer',
          }}
        >
          {'\u2699'}
        </button>
      </div>

      {/* ── 批 3 适配状态机 banner ── */}
      {snap.hostOk === true ? (
        <AdaptBanner
          phase={snap.adapt.phase}
          pending={snap.adapt.candidates
            .filter((c) => c.adaptedAs === undefined)
            .map((c) => ({ path: c.path, dirname: c.dirname }))}
          adaptingPath={snap.adapt.target}
          lastAdapted={snap.adapt.lastAdapted}
          check={snap.adapt.check}
          checking={checkingAdapt}
          checkRoot={adaptCheckRoot}
          error={snap.adapt.error}
          disabled={running || snap.busy}
          onAdapt={(path) => void service.adaptProject(path)}
          onCheck={(name) => {
            if (adaptCheckRoot === null) return
            setCheckingAdapt(true)
            void service.checkAdapt(name, adaptCheckRoot).finally(() => setCheckingAdapt(false))
          }}
        />
      ) : null}

      {/* ── 零前置自动准备（内核已就绪后仍在装工具链的可见性 + 失败重试） ── */}
      {snap.hostOk === true && snap.auto.phase === 'running' ? (
        <div
          aria-live="polite"
          style={{
            flex: '0 0 auto',
            padding: '3px 8px',
            fontSize: '11px',
            color: 'var(--elab-status-run)',
            borderBottom: '1px solid var(--elab-border)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {`自动准备中：${snap.auto.stage}`}
        </div>
      ) : null}
      {snap.hostOk === true && snap.auto.phase === 'failed' ? (
        <div
          role="alert"
          style={{
            flex: '0 0 auto',
            padding: '3px 8px',
            fontSize: '11px',
            color: 'var(--elab-status-fail)',
            borderBottom: '1px solid var(--elab-border)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            minWidth: 0,
          }}
        >
          <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {snap.auto.error?.message ?? '自动准备失败'}
          </span>
          <button
            type="button"
            onClick={() => service.retryAutoProvision()}
            style={{
              flex: '0 0 auto',
              padding: '0 6px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid var(--elab-border)',
              background: 'transparent',
              color: 'var(--elab-accent)',
              cursor: 'pointer',
            }}
          >
            {'重试'}
          </button>
        </div>
      ) : null}

      {/* ── §16 内核过旧提示（capabilities 无 meta 时） ── */}
      {snap.hostOk === true && snap.kernelOld ? (
        <div
          style={{
            flex: '0 0 auto',
            padding: '3px 8px',
            fontSize: '11px',
            color: 'var(--elab-status-run)',
            borderBottom: '1px solid var(--elab-border)',
          }}
        >
          {'当前 elab 内核较旧（无自描述元数据）：步骤标签与档位使用插件内置默认；同步会话仓库的 cockpit/server.py（v2.1.0+）后消失'}
        </div>
      ) : null}

      {/* ── 阶梯 / 控制条 / 错误 / 日志尾 —— wide 档双栏（左 40% 阶梯 + 右 60% 日志尾）—— */}
      {(() => {
        const ladder = (
          <StageLadder
            steps={steps}
            availability={snap.availability}
            focusStep={focusStep}
            running={running}
            density={tier}
            onFocus={(id) => {
              setFocusStep(id)
              setChannel(channelOfStep(id))
            }}
            onRunOne={onRunOne}
            progressOf={(id) =>
              id === steps.find((s) => s.state === 'running')?.id && snap.progress !== null
                ? { current: snap.progress.current, total: snap.progress.total }
                : null
            }
          />
        )
        const bar = (
          <ManualBar
            plans={plans}
            running={running}
            busy={snap.busy}
            cleanTarget={cleanTarget}
            availability={snap.availability}
            serialActive={serialStream.active}
            onRun={(id, opts) => void service.startPlan(id, opts)}
            onRunOne={onRunOne}
            onSerial={onSerialStart}
            onCancel={() => void service.cancel()}
            onPreview={(opts) => void service.preview(opts)}
          />
        )
        const error = snap.error !== null ? (
          <div
            role="alert"
            style={{
              flex: '0 0 auto',
              padding: '4px 8px',
              fontSize: '11px',
              color: 'var(--elab-status-fail)',
              borderBottom: '1px solid var(--elab-border)',
            }}
          >
            {snap.error}
          </div>
        ) : null
        const tail = (
          <EvidenceTail
            channel={channel}
            channels={LOG_CHANNELS}
            buffers={buffersRef.current}
            progress={snap.progress}
            failure={failure}
            onChannel={setChannel}
            serialContent={
              channel === 'serial' ? (
                <SerialPane
                  api={elabApi}
                  stream={serialStream}
                  decoders={decoders}
                  project={snap.project}
                  running={running}
                  port={serialPort}
                  baud={serialBaud}
                  ports={serialMeta.ports}
                  onPort={onSerialPort}
                  onBaud={onSerialBaud}
                  decoderPref={serialPref.decoder}
                  onDecoder={onSerialDecoder}
                  writable={serialMeta.writable}
                  runLines={buffersRef.current.serial ?? []}
                  runLinesVersion={tailVersion}
                  sessionId={sessionId}
                />
              ) : undefined
            }
          />
        )
        if (tier !== 'wide') {
          return (
            <>
              {ladder}
              {bar}
              {error}
              {tail}
            </>
          )
        }
        return (
          <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', alignItems: 'stretch' }}>
            <div style={{ flex: '0 0 40%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {ladder}
              {bar}
              {error}
              <div style={{ flex: '1 1 auto' }} />
            </div>
            <div style={{ flex: '1 1 60%', minWidth: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--elab-border)' }}>
              {tail}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
