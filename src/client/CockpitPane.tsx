/**
 * CockpitPane —— 窄栏根容器，把 store / SSE / HTTP 接到三个视图上。
 *
 * 数据流（单向）：
 *   SSE `/elab/events`  →  runStore.reduce（状态）  →  StageLadder / ManualBar
 *                       →  logs（环形缓冲）        →  EvidenceTail
 *
 * 关键纪律：
 *  - **可见性驱动 SSE**：面板不可见就断开（上游 MAX_SSE_CONNS 有上限）；
 *    变可见从 lastSeq 续传（P2 已验证无空洞无重复）。
 *  - **失败即中断**：后端 `run/end.ok=false` 或某步 failed → 阶梯立刻全标状态、
 *    日志尾常驻告警条；不做任何"自动重试"或"跳过继续"。
 *  - 日志行**不进 React 状态**（只在 buffer 里追加，按 version 触发重绘）。
 */

import React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { elabApi, ElabApiError } from './api/client.ts'
import type { DiscoverResponse } from './api/client.ts'
import { setKernelMeta, type KernelMeta } from './model/kernel-meta.ts'
import { channelOfEvent, channelOfStep } from './model/channels.ts'
import type { LogChannelId } from './model/channels.ts'
import { LOG_CHANNELS } from './model/channels.ts'
import { resolveAllPlans, foldProgress } from './model/plans.ts'
import type { PlanView, ProgressState } from './model/plans.ts'
import { StageLadder, stepLabelOf } from './StageLadder.tsx'
import type { LadderStep } from './StageLadder.tsx'
import { ManualBar } from './ManualBar.tsx'
import { EvidenceTail, TAIL_CAPACITY } from './EvidenceTail.tsx'
import type { TailBuffers, TailLine } from './EvidenceTail.tsx'

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

export function CockpitPane(props: CockpitPaneProps): ReactNode {
  const { sessionId, visible = true } = props

  // ── 数据态（只有这些进 React；日志行不在其中） ──
  const [hostOk, setHostOk] = useState<boolean | null>(null)
  const [hostError, setHostError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Array<{ name: string; root?: string }>>([])
  const [project, setProject] = useState<string>('')
  const [discover, setDiscover] = useState<DiscoverResponse | null>(null)
  const [availability, setAvailability] = useState<Record<string, { ok: boolean; reason?: string }>>({})
  const [steps, setSteps] = useState<LadderStep[]>([])
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'ok' | 'failed' | 'cancelled'>('idle')
  const [runId, setRunId] = useState<string | null>(null)
  const [actor, setActor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ step: string; detail: string } | null>(null)
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(null)
  /** §16 内核自描述探测：meta 缺失 = 内核较旧（标签/档位退回插件内置默认）。 */
  const [kernelOld, setKernelOld] = useState(false)
  const [channel, setChannel] = useState<LogChannelId>('build')
  const [focusStep, setFocusStep] = useState<string | null>(null)
  const [tailVersion, setTailVersion] = useState(0)
  const [planError, setPlanError] = useState<string | null>(null)
  const [cleanTarget, setCleanTarget] = useState<string | null>(null)

  const buffersRef = useRef<TailBuffers>(emptyBuffers())
  const progressRef = useRef<ProgressState>({ current: 0, total: 0, label: '', startedAt: 0 })
  const esRef = useRef<EventSource | null>(null)
  const lastSeqRef = useRef(0)

  /** 日志追加后节流重绘（≤1 次/100ms）。 */
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bumpTail = useCallback(() => {
    if (bumpTimer.current !== null) return
    bumpTimer.current = setTimeout(() => {
      bumpTimer.current = null
      setTailVersion((v) => v + 1)
    }, 100)
  }, [])

  // ── 首屏：健康 + 工程 ──
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const h = await elabApi.host(sessionId)
        if (cancelled) return
        setHostOk(h.ok && h.elabRoot !== null)
        if (!h.ok || h.elabRoot === null) {
          setHostError('未找到 elab 仓库根（需含 cockpit/server.py 与 services/elab）')
        }
        // §16 内核自描述探测：meta 缺失 = 内核较旧，面板降级到内置默认
        try {
          const caps = (await elabApi.capabilities(sessionId)) as { meta?: KernelMeta }
          if (!cancelled) {
            setKernelOld(caps.meta === undefined)
            setKernelMeta(caps.meta ?? null)
          }
        } catch {
          /* capabilities 拿不到不挡主流程 */
        }
      } catch (e) {
        if (cancelled) return
        setHostOk(false)
        setHostError(e instanceof ElabApiError ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // ── 工程列表（host 就绪后） ──
  const reloadProjects = useCallback(async () => {
    try {
      const r = await elabApi.projects(sessionId)
      const list = ((r.projects ?? r.cards ?? []) as Array<Record<string, unknown>>).map((p) => ({
        name: String(p.name ?? ''),
        root: typeof p.root === 'string' ? p.root : undefined,
      }))
      setProjects(list)
      setProject((cur) => (cur !== '' && list.some((p) => p.name === cur) ? cur : (list[0]?.name ?? '')))
    } catch (e) {
      setPlanError(e instanceof ElabApiError ? e.message : String(e))
    }
  }, [sessionId])

  useEffect(() => {
    if (hostOk !== true) return
    void reloadProjects()
    void (async () => {
      try {
        const r = await elabApi.discover(sessionId)
        setDiscover(r)
      } catch {
        /* 发现失败不阻塞主流程 */
      }
    })()
  }, [hostOk, reloadProjects, sessionId])

  // ── 选中工程后取可用性（capabilities 里的 steps.onhw + 卡片 steps） ──
  useEffect(() => {
    if (project === '') return
    let cancelled = false
    void (async () => {
      try {
        const r = await elabApi.projects(sessionId)
        const cards = (r.projects ?? r.cards ?? []) as Array<Record<string, unknown>>
        const card = cards.find((c) => String(c.name ?? '') === project)
        const st = (card?.steps ?? {}) as Record<string, { ok?: boolean; reason?: string }>
        const next: Record<string, { ok: boolean; reason?: string }> = {}
        for (const [k, v] of Object.entries(st)) {
          next[k] = { ok: v?.ok ?? true, reason: v?.reason }
        }
        if (!cancelled) setAvailability(next)
      } catch {
        /* 忽略：可用性拿不到就按"都可用"处理 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [project, sessionId])

  // ── SSE：可见性驱动 ──
  const closeStream = useCallback(() => {
    if (esRef.current !== null) {
      esRef.current.close()
      esRef.current = null
    }
  }, [])

  const openStream = useCallback(
    (id: string, from: number) => {
      closeStream()
      const q = new URLSearchParams({ run: id, from: String(from) })
      if (sessionId !== undefined && sessionId !== '') q.set('sessionId', sessionId)
      const es = new EventSource(`/elab/events?${q.toString()}`)
      esRef.current = es

      const ingest = (raw: string): void => {
        let e: Record<string, unknown>
        try {
          e = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return
        }
        const seq = Number(e.seq ?? 0)
        if (Number.isFinite(seq) && seq > 0) {
          if (seq <= lastSeqRef.current) return
          lastSeqRef.current = seq
        }
        const topic = String(e.topic ?? '')

        // ① 进度：从 batch 行里找 [n/m]
        if (topic === 'proc/stdout-batch') {
          const arr = (e.lines as string[] | undefined) ?? []
          for (const t of arr) progressRef.current = foldProgress(progressRef.current, t)
          if (progressRef.current.total > 0) {
            setProgress({
              current: progressRef.current.current,
              total: progressRef.current.total,
              label: progressRef.current.label,
            })
          }
        } else if (topic === 'proc/stdout' || topic === 'proc/stderr') {
          progressRef.current = foldProgress(progressRef.current, String(e.line ?? ''))
        }

        // ② 日志：按通道落缓冲（不进 React 状态）
        const ch = channelOfEvent({
          topic,
          step: e.step,
        } as never)
        if (ch !== null) {
          const buf = buffersRef.current[ch] ?? (buffersRef.current[ch] = [])
          const step = String(e.step ?? '')
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
              text: `${ok ? '\u2713' : '\u2717'} ${stepLabelOf(step)} ${ok ? '完成' : '失败'}${
                detail !== '' ? `：${detail}` : ''
              }`,
              tone: ok ? 'normal' : 'alert',
              step,
            })
            if (!ok) setFailure({ step: stepLabelOf(step), detail: detail || '见日志' })
          } else if (topic === 'run/step-enter') {
            pushLine(buf, { text: `\u25b6 进入 ${stepLabelOf(step)}`, tone: 'warn', step })
          }
          bumpTail()
        }

        // ③ 状态：只认 run/* 与 stream/closed
        if (topic === 'run/start') {
          const declared = ((e.steps as string[] | undefined) ?? []).map((s, i) => ({
            id: s,
            index: i,
            state: 'pending' as const,
            detail: '',
            duration_s: 0,
          }))
          setSteps(declared)
          setRunStatus('running')
          setActor(String(e.actor ?? 'agent'))
          setFailure(null)
          progressRef.current = { current: 0, total: 0, label: '', startedAt: 0 }
          setProgress(null)
        } else if (topic === 'run/step-enter') {
          const id = String(e.step ?? '')
          setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, state: 'running' } : s)))
          setFocusStep(id)
          setChannel(channelOfStep(id))
        } else if (topic === 'run/step-exit') {
          const id = String(e.step ?? '')
          const ok = Boolean(e.ok)
          setSteps((prev) =>
            prev.map((s) =>
              s.id === id
                ? { ...s, state: ok ? 'ok' : 'failed', detail: String(e.detail ?? ''), duration_s: Number(e.duration_s ?? 0) }
                : s,
            ),
          )
        } else if (topic === 'run/end') {
          const ok = Boolean(e.ok)
          setRunStatus(ok ? 'ok' : 'failed')
          setSteps((prev) =>
            prev.map((s) => (s.state === 'pending' ? { ...s, state: 'skipped' } : s)),
          )
          setBusy(false)
          closeStream()
        } else if (topic === 'run/cancel') {
          setRunStatus('cancelled')
          setSteps((prev) =>
            prev.map((s) => (s.state === 'running' || s.state === 'pending' ? { ...s, state: 'cancelled' } : s)),
          )
          setBusy(false)
          closeStream()
        }
      }

      for (const topic of [
        'run/start',
        'run/step-enter',
        'run/step-exit',
        'run/end',
        'run/cancel',
        'proc/stdout',
        'proc/stderr',
        'proc/stdout-batch',
        'stream/overrun',
      ]) {
        es.addEventListener(topic, (ev: any) => ingest((ev as MessageEvent<string>).data))
      }
      es.addEventListener('stream/closed', () => {
        closeStream()
        // run 若仍显示 running，说明收尾事件缺失（子进程被硬杀等）——显式判失败
        setRunStatus((cur) => (cur === 'running' ? 'failed' : cur))
        setBusy(false)
      })
      es.onerror = () => {
        // 不在这里判定"跑完了"：只有 stream/closed 才是结束
      }
    },
    [bumpTail, closeStream],
  )

  // 可见性：隐藏即断，可见即从 lastSeq 续
  useEffect(() => {
    if (!visible) {
      closeStream()
      return
    }
    if (runId !== null && runStatus === 'running') {
      openStream(runId, lastSeqRef.current)
    }
    return () => closeStream()
  }, [visible, runId, runStatus, openStream, closeStream])

  // ── 动作 ──
  const plans: PlanView[] = useMemo(
    () => resolveAllPlans(availability, false),
    [availability],
  )

  const startRun = useCallback(
    async (planId: string, opts: { clean: boolean; jobs: number | null }) => {
      if (project === '') return
      const plan = plans.find((p) => p.id === planId)
      if (plan === undefined || !plan.enabled) return
      setBusy(true)
      setPlanError(null)
      setFailure(null)
      lastSeqRef.current = 0
      buffersRef.current = emptyBuffers()
      try {
        const r = await elabApi.startRun({
          project,
          steps: plan.effectiveSteps,
          clean: opts.clean,
          jobs: opts.jobs ?? undefined,
          sessionId,
        })
        setRunId(r.run)
        setRunStatus('running')
        setActor(r.actor)
      } catch (e) {
        setBusy(false)
        setPlanError(e instanceof ElabApiError ? e.message : String(e))
      }
    },
    [project, plans, sessionId],
  )

  const cancelRun = useCallback(async () => {
    if (runId === null) return
    try {
      await elabApi.cancel(runId, '用户取消', sessionId)
    } catch (e) {
      setPlanError(e instanceof ElabApiError ? e.message : String(e))
    }
  }, [runId, sessionId])

  const preview = useCallback(
    async (opts: { clean: boolean; jobs: number | null }) => {
      if (project === '') return
      try {
        const p = await elabApi.plan({
          project,
          steps: plans.find((x) => x.enabled)?.effectiveSteps,
          clean: opts.clean,
          jobs: opts.jobs ?? undefined,
          sessionId,
        })
        const lines = ((p.commands ?? p.steps ?? []) as Array<Record<string, unknown>>)
          .map((c) => String(c.command ?? c.cmd ?? JSON.stringify(c)))
          .join('\n')
        const buf = buffersRef.current.build
        pushLine(buf, { text: '── 只读预览（不会执行）──', tone: 'warn', step: 'preview' })
        for (const l of lines.split('\n')) if (l !== '') pushLine(buf, { text: l, tone: 'normal', step: 'preview' })
        bumpTail()
        setChannel('build')
        const wd = (p as Record<string, unknown>).work_dir ?? (p as Record<string, unknown>).clean_target
        setCleanTarget(typeof wd === 'string' ? wd : null)
      } catch (e) {
        setPlanError(e instanceof ElabApiError ? e.message : String(e))
      }
    },
    [project, plans, bumpTail, sessionId],
  )

  const runOne = useCallback(
    async (step: string) => {
      if (project === '' || runStatus === 'running') return
      setBusy(true)
      setPlanError(null)
      setFailure(null)
      lastSeqRef.current = 0
      buffersRef.current = emptyBuffers()
      try {
        const r = await elabApi.startRun({ project, steps: [step], sessionId })
        setRunId(r.run)
        setRunStatus('running')
        setActor(r.actor)
      } catch (e) {
        setBusy(false)
        setPlanError(e instanceof ElabApiError ? e.message : String(e))
      }
    },
    [project, runStatus, sessionId],
  )

  // ── 渲染 ──
  if (hostOk === false) {
    return (
      <div style={{ padding: '12px', fontSize: '12px', lineHeight: 1.6, color: 'var(--elab-fg-primary)' }}>
        <div style={{ fontWeight: 600, marginBottom: '6px' }}>{'驾驶舱未就绪'}</div>
        <div style={{ color: 'var(--elab-fg-secondary)' }}>{hostError ?? '未知原因'}</div>
        <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--elab-fg-muted)' }}>
          {'处理：确认 python 在 PATH，且当前会话位于 elab 仓库内（含 elab.host.yaml、cockpit/、services/elab）。'}
        </div>
      </div>
    )
  }

  // ── §5.4 宽度三档 ──
  const rootRef = useRef<HTMLDivElement | null>(null)
  const paneWidth = usePaneWidth(rootRef)
  const tier: 'narrow' | 'mid' | 'wide' = paneWidth >= 700 ? 'wide' : paneWidth >= 420 ? 'mid' : 'narrow'

  const running = runStatus === 'running'

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
          value={project}
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
          {projects.length === 0 ? <option value="">{'（无工程）'}</option> : null}
          {projects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>

        {actor !== null ? (
          <span
            style={{
              fontSize: '10px',
              padding: '0 4px',
              borderRadius: '3px',
              background: 'var(--elab-bg-raised)',
              color: actor === 'human' ? 'var(--elab-accent)' : 'var(--elab-fg-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            {actor === 'human' ? '我点的' : 'agent'}
          </span>
        ) : null}

        {runStatus !== 'idle' ? (
          <span
            style={{
              fontSize: '10px',
              whiteSpace: 'nowrap',
              color:
                runStatus === 'ok'
                  ? 'var(--elab-status-ok)'
                  : runStatus === 'failed'
                    ? 'var(--elab-status-fail)'
                    : runStatus === 'cancelled'
                      ? 'var(--elab-status-run)'
                      : 'var(--elab-accent)',
            }}
          >
            {runStatus}
          </span>
        ) : null}

        <button
          type="button"
          onClick={() => void reloadProjects()}
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
      </div>

      {/* ── 发现提示（有未接入工程时） ── */}
      {discover !== null && discover.candidates.some((c) => c.adaptedAs === undefined) ? (
        <div
          style={{
            flex: '0 0 auto',
            padding: '3px 8px',
            fontSize: '11px',
            color: 'var(--elab-fg-muted)',
            borderBottom: '1px solid var(--elab-border)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={discover.candidates
            .filter((c) => c.adaptedAs === undefined)
            .map((c) => c.path)
            .join('\n')}
        >
          {`发现 ${discover.candidates.filter((c) => c.adaptedAs === undefined).length} 个未接入工程（${
            discover.candidates.filter((c) => c.adaptedAs === undefined).map((c) => c.dirname).join('、')
          }）`}
        </div>
      ) : null}

      {/* ── §16 内核过旧提示（capabilities 无 meta 时） ── */}
      {hostOk === true && kernelOld ? (
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
            availability={availability}
            focusStep={focusStep}
            running={running}
            density={tier}
            onFocus={(id) => {
              setFocusStep(id)
              setChannel(channelOfStep(id))
            }}
            onRunOne={(id) => void runOne(id)}
            progressOf={(id) =>
              id === steps.find((s) => s.state === 'running')?.id && progress !== null
                ? { current: progress.current, total: progress.total }
                : null
            }
          />
        )
        const bar = (
          <ManualBar
            plans={plans}
            running={running}
            busy={busy}
            cleanTarget={cleanTarget}
            onRun={(id, opts) => void startRun(id, opts)}
            onCancel={() => void cancelRun()}
            onPreview={(opts) => void preview(opts)}
          />
        )
        const error = planError !== null ? (
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
            {planError}
          </div>
        ) : null
        const tail = (
          <EvidenceTail
            channel={channel}
            channels={LOG_CHANNELS}
            buffers={buffersRef.current}
            progress={progress}
            failure={failure}
            onChannel={setChannel}
            serial={channel === 'serial' ? { writable: true, port: 'auto', baud: 115200, onSend: () => {} } : null}
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

