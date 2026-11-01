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
import type {
  Actor,
  AutoProvisionStatus,
  BootstrapRequest,
  DiscoverResponse,
  ElabEvent,
  EnvProbe,
  PlanPreview,
} from '../domain/icd.ts'
import { DEFAULT_KERNEL_VERSION } from '../domain/envpack.ts'
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
  /** 引导向导：只读环境探测结果（null = 尚未探测）。 */
  env: EnvProbe | null
  envBusy: boolean
  envError: string | null
  /** 引导向导：写动作在途（set-root / clone 防重复提交）。 */
  bootstrapBusy: boolean
  bootstrapError: string | null
  bootstrapNotice: string | null
  /** 零前置自动准备：宿主半维护的状态快照（面板只轮询渲染）。 */
  auto: AutoProvisionStatus
  /** 根的来源（user = 指定；auto = 会话 cwd 向上找）。 */
  rootSource: 'user' | 'auto' | 'bundled' | null
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
  /** 适配复探测（只读）：重新探测并比对已写入的 projects/<name>.yaml（drift 判据）。 */
  checkAdapt(name: string, root: string): Promise<void>
  /** 引导向导：只读环境探测（不 spawn 内核）。 */
  refreshEnv(): Promise<void>
  /** 引导向导：指定一个已存在的 elab 仓库根（校验 + 持久化）。 */
  setRoot(dir: string): Promise<boolean>
  /** 引导向导：浅克隆到空目录（写盘，调用方需二次确认）。 */
  cloneKernel(url: string, dir: string): Promise<boolean>
  /** 引导向导：一键安装当前平台工具链环境包（下载类动作，需二次确认）。 */
  installToolchain(): Promise<boolean>
  /** 自动准备失败/卡住后重跑（同一份宿主流程，不另造一套）。 */
  retryAutoProvision(): void
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
    env: null,
    envBusy: false,
    envError: null,
    bootstrapBusy: false,
    bootstrapError: null,
    bootstrapNotice: null,
    auto: {
      phase: 'idle',
      step: null,
      stage: '',
      error: null,
      blocked: null,
      kernelVersion: DEFAULT_KERNEL_VERSION,
      updatedAt: Date.now(),
    },
    rootSource: null,
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
    // ★ 新 run / 新步骤开始 → 进度条归零：否则上一轮（例如编译）的
    //   「53/53 Linking C executable」会残留到本轮调试/串口通道里，
    //   界面上出现与本步骤无关的进度（实测 2026-11-01）。
    if (topic === 'run/start' || topic === 'run/step-enter') {
      progressRef = makeProgress()
      patch.progress = null
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
    // ★ 同时清 busy：主动 dispose 后 EventStream 不会再回调 onClosed，
    //   若只靠 handleClosed 复位，「跑完一次」后所有启动按钮就永久变灰
    //   （disabled = running || busy || !available，实测 2026-11-01 实机复现）。
    if (topic === 'run/end' || topic === 'run/cancel') {
      closeConnection()
      if (snap.busy) set({ busy: false })
    }
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

  // ── 引导向导（只读探测 + 一次显式写盘）──────────────────────────

  /** 首屏全流程（健康 → meta → 工程 → 发现）；向导写根成功后复跑。 */
  async function initFlow(): Promise<void> {
    let root: string | null = null
    try {
      const h = await api.host(sessionId)
      root = h.ok === true ? (h.elabRoot ?? null) : null
      set({
        hostOk: h.ok && h.elabRoot !== null,
        rootSource: h.rootSource ?? null,
        hostError:
          h.ok && h.elabRoot !== null
            ? null
            : '未找到 elab 仓库根（需含 cockpit/server.py 与 services/elab）',
      })
    } catch (e) {
      set({ hostOk: false, hostError: message(e) })
    }
    dispatchAdapt({ type: 'host/resolved', elabRoot: root })
    if (root === null) {
      // 未就绪：先跑只读环境探测，向导第一屏就有数据（不 spawn 内核）
      void refreshEnv()
      return
    }

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
  }

  async function refreshEnv(): Promise<void> {
    if (typeof api.env !== 'function') return
    set({ envBusy: true, envError: null })
    try {
      const r = await api.env(sessionId)
      set({ env: r.env, envBusy: false })
    } catch (e) {
      set({ envBusy: false, envError: message(e) })
    }
  }

  /**
   * 写根（set-root / clone）→ 成功后重跑 init。
   * 失败只回显错误码文案，不自动重试（写盘动作必须由人再点一次）。
   */
  async function bootstrapWrite(req: BootstrapRequest): Promise<boolean> {
    if (typeof api.bootstrap !== 'function') return false
    set({ bootstrapBusy: true, bootstrapError: null, bootstrapNotice: null })
    try {
      const r = await api.bootstrap(req)
      if (req.action === 'install-toolchain') {
        // 装完只需重探环境（内核下次按需重启时自动带上新 ELAB_*）
        const warnings = r.envPack?.warnings ?? []
        set({
          bootstrapBusy: false,
          bootstrapNotice: `工具链已就绪（${r.envPack?.tools ?? 0} 件）${warnings.length > 0 ? ` · ${warnings.length} 条告警` : ''}`,
        })
        await refreshEnv()
        return true
      }
      const notice = req.action === 'download-kernel'
        ? `已下载内核 → ${r.elabRoot ?? ''}`
        : `已切换到 ${r.elabRoot ?? ('dir' in req ? req.dir : '')}`
      set({ bootstrapBusy: false, bootstrapNotice: notice })
      await initFlow()
      return true
    } catch (e) {
      set({ bootstrapBusy: false, bootstrapError: message(e) })
      return false
    }
  }

  // ── 零前置自动准备（宿主半跑流程，这里只触发 + 轮询 + 终态重跑首屏）──
  //
  // 纪律：
  //   - 触发一次后不重复 POST：宿主单飞且幂等，面板重启只续上轮询；
  //   - `autoProvision=false` → 只显示 disabled，不发任何自动请求；
  //   - 终态（done/failed/blocked）各处理一次，避免重复刷新把界面刷成抖动；
  //   - 仍保留手动入口（指定路径 / 浅克隆 / 环境包）作为兜底。

  const AUTO_POLL_MS = 1200
  let autoTimer: ReturnType<typeof setTimeout> | null = null
  /** 已处理过的终态（同一服务实例内只刷新一次首屏）。 */
  let autoSettled: AutoProvisionStatus['phase'] | null = null

  function stopAutoPoll(): void {
    if (autoTimer === null) return
    clearTimeout(autoTimer)
    autoTimer = null
  }

  function scheduleAutoPoll(): void {
    stopAutoPoll()
    if (disposed) return
    autoTimer = setTimeout(() => {
      autoTimer = null
      void pollAuto()
    }, AUTO_POLL_MS)
  }

  async function pollAuto(): Promise<void> {
    if (disposed || typeof api.bootstrapStatus !== 'function') return
    try {
      const r = await api.bootstrapStatus(sessionId)
      adoptAuto(r.auto)
    } catch {
      // 轮询失败（宿主暂时不可达）：稍后再试，终态自然停止
      scheduleAutoPoll()
    }
  }

  /** 采纳宿主状态：running → 续轮询；终态 → 重跑首屏（内核/环境变了）。 */
  function adoptAuto(status: AutoProvisionStatus): void {
    set({ auto: status })
    if (status.phase === 'running') {
      autoSettled = null
      scheduleAutoPoll()
      return
    }
    stopAutoPoll()
    if (status.phase === 'disabled' || status.phase === 'idle') return
    if (autoSettled === status.phase) return
    autoSettled = status.phase
    void (async () => {
      if (disposed) return
      await initFlow()
      await refreshEnv()
    })()
  }

  /**
   * 触发自动准备（面板首次打开 / 用户点重试）。
   * 只在**未 ready** 时自动跑；`force=true` 用于重试失败/卡住的步骤。
   */
  async function startAutoProvision(force: boolean): Promise<void> {
    if (disposed || typeof api.bootstrap !== 'function') return

    // ① 配置开关：关闭就只显示 disabled（宿主侧也会拒绝，双重防护）
    if (typeof api.getConfig === 'function') {
      try {
        const cfg = await api.getConfig()
        if (cfg.config.autoProvision === false) {
          autoSettled = 'disabled'
          set({
            auto: {
              ...snap.auto,
              phase: 'disabled',
              step: null,
              stage: '自动准备已在设置页关闭（autoProvision=false）',
              error: null,
              blocked: null,
              updatedAt: Date.now(),
            },
          })
          return
        }
      } catch {
        /* 读不到配置按默认 true */
      }
    }

    // ② 已 ready（内核就绪且已接入工程）→ 不打扰
    if (!force && snap.hostOk === true && snap.projects.length > 0) return

    // ③ 先问宿主：已在跑就续上轮询；非强制时终态不重跑（幂等）
    if (typeof api.bootstrapStatus === 'function') {
      try {
        const r = await api.bootstrapStatus(sessionId)
        const p = r.auto.phase
        if (p === 'running' || (!force && (p === 'done' || p === 'failed' || p === 'blocked' || p === 'disabled'))) {
          adoptAuto(r.auto)
          return
        }
      } catch {
        /* 旧宿主没有该端点：直接走 POST */
      }
    }

    // ④ 触发宿主流程（首次打开 = 下载内核 → 回落浅克隆 → 装工具链）
    try {
      const r = await api.bootstrap({ action: 'auto-provision' }, sessionId)
      if (r.auto !== undefined) adoptAuto(r.auto)
    } catch {
      /* 旧宿主不认识该动作：静默降级，向导的手动入口仍可用 */
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
      await initFlow()
      // 零前置：内核/工具链没备好就自动跑（宿主幂等；已 ready 直接跳过）
      await startAutoProvision(false)
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

    async checkAdapt(name, root) {
      try {
        const r = await api.adapt({ action: 'check', path: root, name, sessionId })
        const raw = r.result?.status
        // check 只会回 missing / identical / drift；其它值（内核过旧）按 drift 呈现，
        // 宁可让人多看一次，也不把"未知"当成"没漂移"。
        const status =
          raw === 'missing' || raw === 'identical' || raw === 'drift' ? raw : 'drift'
        dispatchAdapt({ type: 'adapt/checked', name, status, at: Date.now() })
      } catch (e) {
        set({ error: message(e) })
      }
    },

    refreshEnv,

    setRoot(dir) {
      return bootstrapWrite({ action: 'set-root', dir })
    },

    cloneKernel(url, dir) {
      return bootstrapWrite({ action: 'clone', url, dir, confirm: true })
    },

    installToolchain() {
      return bootstrapWrite({ action: 'install-toolchain', confirm: true })
    },

    retryAutoProvision() {
      void startAutoProvision(true)
    },

    dispose() {
      disposed = true
      stopAutoPoll()
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
