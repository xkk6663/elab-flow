/**
 * 驾驶舱编排服务（批 2）—— 发现 → 适配 → 发起 → 订阅 → 回收的**唯一**编排点。
 *
 * ★ 本层零 I/O、零 React、零宿主类型：HTTP 走 IcdPort、SSE 走 RunEventsPort
 *   （实现 = kernel-http 的 elabApi 与 dsh-web 的 EventStream，由 dsh-web 挂载时注入），
 *   状态归约全部来自 domain（run.ts / pipeline.ts / adapt.ts / kernel-meta.ts）。
 *   dsh-web 面板只剩渲染：订阅快照 + 把原始事件喂给自己的环形缓冲。
 *
 * 「agent 很容易把业务写进工具/UI」的根治点：任何编排（发现、适配、发起、
 * 取消、预览、可见性驱动的事件生命周期）只能发生在这里 —— 加功能进本文件，
 * 不要往 CockpitPane / tools.ts 里加流程。
 *
 * 事件纪律（与旧 CockpitPane 实现逐条对齐，搬迁不改行为）：
 *  - **可见性驱动 SSE**：面板不可见就断开（上游 MAX_SSE_CONNS 有上限）；
 *    变可见从 lastSeq 续传（由 RunEventsPort 实现自管游标）。
 *  - **失败即中断**：后端 `run/end.ok=false` 或某步 failed → 状态立即呈现，
 *    不做任何"自动重试"或"跳过继续"。
 *  - 日志行不进 React 状态：原始事件经 onRawEvent 交给 dsh-web 的环形缓冲。
 */

import { IDLE, markStreamClosed, reduce, type RunSnapshot } from '../domain/run.ts'
import type { Actor, DiscoverResponse, ElabEvent, PlanPreview } from '../domain/icd.ts'
import {
  foldProgress,
  makeProgress,
  resolveAllPlans,
  stepLabel,
  type PlanView,
  type ProgressState,
  type StepAvailability,
} from '../domain/pipeline.ts'
import { setKernelMeta } from '../domain/kernel-meta.ts'
import {
  initialAdaptState,
  reduceAdapt,
  type AdaptEvent,
  type AdaptState,
} from '../domain/adapt.ts'
import type { IcdPort, RunEventConnection, RunEventsPort } from './ports.ts'

/** 面板渲染所需的全部状态（不可变快照；引用稳定才满足 useSyncExternalStore）。 */
export interface CockpitSnapshot {
  /** null = 首屏探测中；false = 宿主半不就绪（面板显示"未就绪"整屏）。 */
  hostOk: boolean | null
  hostError: string | null
  /** §16 内核自描述探测：meta 缺失 = 内核较旧（标签/档位退回插件内置默认）。 */
  kernelOld: boolean
  projects: Array<{ name: string; root?: string }>
  project: string
  discover: DiscoverResponse | null
  availability: StepAvailability
  run: RunSnapshot
  /** 发起/取消请求在途（按钮防抖）。 */
  busy: boolean
  /** 最近的操作错误（发起失败 / 适配失败 / 工程列表读取失败）。 */
  error: string | null
  progress: { current: number; total: number; label: string } | null
  /** 批 3 适配状态机（unbound → discovered → adapting → bound）。 */
  adapt: AdaptState
  /** 三档视图（availability 派生，勿手改）。 */
  plans: PlanView[]
}

export interface CockpitService {
  /** React useSyncExternalStore 三件套。 */
  subscribe(l: () => void): () => void
  getSnapshot(): CockpitSnapshot
  /** 首屏：健康 → meta 探测 → 工程 → 发现。 */
  init(): Promise<void>
  /** 面板可见性（驱动 SSE 连接）。 */
  setVisible(visible: boolean): void
  /** 原始事件馈送（dsh-web 环形缓冲；先于状态归约，顺序与旧实现一致）。 */
  onRawEvent(l: (e: ElabEvent) => void): () => void
  /** 只读预览结果馈送（dsh-web 渲染进 build 通道缓冲）。 */
  onPreview(l: (p: PlanPreview) => void): () => void
  reloadProjects(): Promise<void>
  selectProject(name: string): void
  startPlan(planId: string, opts: { clean: boolean; jobs: number | null }): Promise<void>
  runOne(step: string): Promise<void>
  cancel(): Promise<void>
  preview(opts: { clean: boolean; jobs: number | null }): Promise<void>
  /** 批 3 一键适配：write → 重载工程 → 绑定新工程 → 刷新发现。 */
  adaptProject(path: string): Promise<void>
  dispose(): void
}

export function createCockpitService(deps: {
  api: IcdPort
  events: RunEventsPort
  sessionId?: string
}): CockpitService {
  const { api, events, sessionId } = deps

  let snap: CockpitSnapshot = {
    hostOk: null,
    hostError: null,
    kernelOld: false,
    projects: [],
    project: '',
    discover: null,
    availability: {},
    run: IDLE,
    busy: false,
    error: null,
    progress: null,
    adapt: initialAdaptState(),
    plans: resolveAllPlans({}, false),
  }

  const listeners = new Set<() => void>()
  const rawListeners = new Set<(e: ElabEvent) => void>()
  const previewListeners = new Set<(p: PlanPreview) => void>()

  let cards: Array<Record<string, unknown>> = []
  let progressRef: ProgressState = makeProgress()
  let connection: RunEventConnection | null = null
  let visible = true
  let disposed = false
  // agent 自动跟随：只处理**新出现**的 agent run（记 id），不做持续抢占 ——
  // 否则人手动切到别的工程看历史时，每 2s 会被拽回去。
  const followedRuns = new Set<string>()
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function set(p: Partial<CockpitSnapshot>): void {
    snap = { ...snap, ...p }
    for (const l of listeners) l()
  }

  function dispatchAdapt(e: AdaptEvent): void {
    const next = reduceAdapt(snap.adapt, e)
    if (next !== snap.adapt) set({ adapt: next })
  }

  function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  // ── 可用性 → 三档视图 ────────────────────────────────────────────

  function applyAvailability(name: string): void {
    const card = cards.find((c) => String(c.name ?? '') === name)
    const st = (card?.steps ?? {}) as Record<string, { ok?: boolean; reason?: string }>
    const next: StepAvailability = {}
    for (const [k, v] of Object.entries(st)) {
      next[k] = { ok: v?.ok ?? true, reason: v?.reason }
    }
    // serialBusy 恒为 false：面板不知道互斥实况（宿主半在 run 侧硬拦），
    // 与旧实现一致 —— 互斥的呈现靠 409 错误回显，不靠本地猜测。
    set({ availability: next, plans: resolveAllPlans(next, false) })
  }

  // ── 事件流 ──────────────────────────────────────────────────────

  function closeConnection(): void {
    connection?.dispose()
    connection = null
  }

  function openConnection(): void {
    if (disposed || snap.run.run === null) return
    closeConnection()
    connection = events.connect(snap.run.run, sessionId, {
      onEvent: handleEvent,
      onClosed: handleClosed,
    })
    connection.setVisible(visible)
  }

  function handleEvent(e: ElabEvent): void {
    // ① 原始事件先给环形缓冲（顺序与旧实现一致：日志紧跟事件到达）
    for (const l of rawListeners) l(e)

    // ② 进度折叠（domain 纯函数）
    const topic = String(e.topic ?? '')
    const patch: Partial<CockpitSnapshot> = {}
    if (topic === 'proc/stdout' || topic === 'proc/stderr') {
      progressRef = foldProgress(progressRef, String(e.line ?? ''))
    } else if (topic === 'proc/stdout-batch') {
      for (const t of (e.lines as string[] | undefined) ?? []) {
        progressRef = foldProgress(progressRef, t)
      }
    }
    if (progressRef.total > 0) {
      patch.progress = {
        current: progressRef.current,
        total: progressRef.total,
        label: progressRef.label,
      }
    }

    // ③ 状态归约（domain 纯函数；未识别 topic 原样返回同一引用）
    const before = snap.run
    const after = reduce(before, e)
    if (after !== before) patch.run = after

    if (Object.keys(patch).length > 0) set(patch)

    // ④ run 收尾 → 立刻断流（旧实现同款；stream/closed 兜底在 handleClosed）
    if (topic === 'run/end' || topic === 'run/cancel') closeConnection()
  }

  function handleClosed(reason: string): void {
    connection = null
    // 收尾事件缺失（子进程被硬杀等）→ 显式判失败，不留假装在跑的界面
    const next = markStreamClosed(snap.run, reason)
    set({ run: next, busy: false })
  }

  // ── agent 自动跟随（面板必须展示 agent 正在跑的那个工程）────────────

  /**
   * 接管一条**别的入口**（agent 工具）发起的 run：切工程 → 置 running → 挂 SSE。
   *
   * ★ 为什么不是"只切工程、等用户点重放"：agent 的进度要**实时**出现在面板上，
   *   这正是"agent 执行的进展流程与驾驶舱画面同步"的要求。SSE 会从 seq 0 重放，
   *   所以即便接管时已经跑了一半，前面的步骤/日志也不会缺。
   */
  function adoptExternalRun(runId: string, project: string): boolean {
    if (runId === '' || snap.run.run === runId) return false
    if (project !== '' && project !== snap.project) {
      // 只认已加载的工程（未知工程不切，免得界面挂到不存在的卡片上）
      if (!cards.some((c) => String(c.name ?? '') === project)) return false
      selectProject(project)
    }
    progressRef = makeProgress()
    set({
      run: {
        ...IDLE,
        run: runId,
        project,
        status: 'running',
        actor: 'agent',
        startedAt: Date.now() / 1000,
      },
      busy: false,
      error: null,
      progress: null,
    })
    openConnection()
    return true
  }

  async function followAgentRuns(): Promise<void> {
    if (disposed || typeof api.runs !== 'function') return
    try {
      const r = await api.runs(sessionId)
      const active = (r.active ?? []) as Array<Record<string, unknown>>
      for (const a of active) {
        const runId = String(a.run ?? '')
        const project = String(a.project ?? '')
        if (runId === '' || a.alive === false) continue
        if (String(a.actor ?? '') !== 'agent') continue
        if (followedRuns.has(runId)) continue
        // 工程还没加载完 → 不记 id，下一拍照样会重试
        if (adoptExternalRun(runId, project)) followedRuns.add(runId)
      }
    } catch {
      /* 轮询失败静默：不能因为看不到列表就打断本地操作 */
    }
  }

  function startFollowPoll(): void {
    if (pollTimer !== null) return
    pollTimer = setInterval(() => {
      void followAgentRuns()
    }, 2000)
  }

  function stopFollowPoll(): void {
    if (pollTimer === null) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  // ── 动作 ────────────────────────────────────────────────────────

  async function reloadProjects(): Promise<void> {
    try {
      const r = await api.projects(sessionId)
      cards = (r.projects ?? r.cards ?? []) as Array<Record<string, unknown>>
      const list = cards.map((p) => ({
        name: String(p.name ?? ''),
        root: typeof p.root === 'string' ? p.root : undefined,
      }))
      const keep = snap.project !== '' && list.some((p) => p.name === snap.project)
      const nextProject = keep ? snap.project : (list[0]?.name ?? '')
      set({ projects: list, project: nextProject })
      if (nextProject !== '') applyAvailability(nextProject)
    } catch (e) {
      set({ error: message(e) })
    }
  }

  function selectProject(name: string): void {
    if (name === snap.project) return
    // 只接受列表里存在的工程（适配完成后自动绑定也走这条）
    if (!cards.some((c) => String(c.name ?? '') === name)) return
    set({ project: name })
    applyAvailability(name)
  }

  async function launch(
    steps: string[],
    opts: { clean?: boolean; jobs?: number },
  ): Promise<void> {
    set({ busy: true, error: null })
    try {
      const r = await api.startRun({
        project: snap.project,
        steps,
        ...(opts.clean === true ? { clean: true } : {}),
        ...(typeof opts.jobs === 'number' && opts.jobs > 0 ? { jobs: opts.jobs } : {}),
        sessionId,
      })
      // 乐观置 running；run/start 事件随后会用权威事件整体重建快照
      set({
        run: { ...snap.run, run: r.run, status: 'running', actor: (r.actor as Actor) ?? null },
      })
      openConnection()
    } catch (e) {
      set({ busy: false, error: message(e) })
    }
  }

  // ── 服务对象 ────────────────────────────────────────────────────

  return {
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getSnapshot() {
      return snap
    },

    async init() {
      let root: string | null = null
      try {
        const h = await api.host(sessionId)
        root = h.ok === true ? (h.elabRoot ?? null) : null
        set({
          hostOk: h.ok && h.elabRoot !== null,
          hostError:
            h.ok && h.elabRoot !== null
              ? null
              : '未找到 elab 仓库根（需含 cockpit/server.py 与 services/elab）',
        })
      } catch (e) {
        set({ hostOk: false, hostError: message(e) })
      }
      dispatchAdapt({ type: 'host/resolved', elabRoot: root })
      if (root === null) return

      // §16 内核自描述探测：meta 缺失 = 内核较旧（不挡主流程）
      try {
        const caps = (await api.capabilities(sessionId)) as { meta?: unknown }
        set({ kernelOld: caps.meta === undefined })
        setKernelMeta((caps.meta ?? null) as never)
      } catch {
        /* capabilities 拿不到不挡主流程 */
      }

      await reloadProjects()
      try {
        const r = await api.discover(sessionId)
        set({ discover: r })
        dispatchAdapt({ type: 'discover/result', candidates: r.candidates })
      } catch {
        /* 发现失败不阻塞主流程 */
      }
    },

    setVisible(v) {
      visible = v
      connection?.setVisible(v)
      // 跟随轮询只在面板可见时开：隐藏时不打 HTTP，也避免没人看的界面被切换
      if (v) startFollowPoll()
      else stopFollowPoll()
    },

    onRawEvent(l) {
      rawListeners.add(l)
      return () => rawListeners.delete(l)
    },

    onPreview(l) {
      previewListeners.add(l)
      return () => previewListeners.delete(l)
    },

    reloadProjects,

    selectProject,

    async startPlan(planId, opts) {
      if (snap.project === '') return
      const plan = snap.plans.find((p) => p.id === planId)
      if (plan === undefined || !plan.enabled) return
      await launch(plan.effectiveSteps, { clean: opts.clean, jobs: opts.jobs ?? undefined })
    },

    async runOne(step) {
      if (snap.project === '' || snap.run.status === 'running') return
      await launch([step], {})
    },

    async cancel() {
      if (snap.run.run === null) return
      try {
        await api.cancel(snap.run.run, '用户取消', sessionId)
      } catch (e) {
        set({ error: message(e) })
      }
    },

    async preview(opts) {
      if (snap.project === '') return
      try {
        const p = await api.plan({
          project: snap.project,
          steps: snap.plans.find((x) => x.enabled)?.effectiveSteps,
          clean: opts.clean,
          jobs: opts.jobs ?? undefined,
          sessionId,
        })
        for (const l of previewListeners) l(p)
      } catch (e) {
        set({ error: message(e) })
      }
    },

    async adaptProject(path) {
      dispatchAdapt({ type: 'adapt/start', path })
      try {
        const r = await api.adapt({ action: 'write', path, sessionId })
        dispatchAdapt({ type: 'adapt/done', ok: true, name: r.name })
        // 内核写入后已重载 Config → 这边拉新工程列表并绑定，再刷新发现
        await reloadProjects()
        selectProject(r.name)
        try {
          const d = await api.discover(sessionId, true)
          set({ discover: d })
          dispatchAdapt({ type: 'discover/result', candidates: d.candidates })
        } catch {
          /* 刷新失败不影响绑定结果 */
        }
      } catch (e) {
        dispatchAdapt({ type: 'adapt/done', ok: false, error: message(e) })
      }
    },

    dispose() {
      disposed = true
      stopFollowPoll()
      closeConnection()
      listeners.clear()
      rawListeners.clear()
      previewListeners.clear()
    },
  }
}

/** 便捷读取：当前未接入的候选（UI banner 用）。 */
export function pendingAdaptations(s: CockpitSnapshot): Array<{ path: string; dirname: string }> {
  return s.adapt.candidates
    .filter((c) => c.adaptedAs === undefined)
    .map((c) => ({ path: c.path, dirname: c.dirname }))
}
