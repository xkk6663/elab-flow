/**
 * Client 侧 HTTP 客户端 —— 与 Host 半 `/elab/*` 路由对话。
 *
 * 契约（Host 半 routes.ts 已实现）：
 *   GET  /elab/api/capabilities | projects | runs | plan | run-events |
 *        serial/console | serial/monitor
 *   POST /elab/api/run | cancel | serial | adapt
 *   GET  /elab/events?run=&from=        SSE
 *   GET  /elab/host                     健康
 *
 * 所有响应都是 JSON；错误统一为 `{ ok:false, error:{code,message} }`。
 *
 * ★ 响应类型全部在 domain/icd.ts（批 2：契约归 domain，本文件只留传输）。
 */

import type {
  AdaptResponse,
  AutoProvisionStatus,
  BootstrapRequest,
  BootstrapResponse,
  DiscoverResponse,
  ElabConfig,
  EnvResponse,
  HostInfo,
  PacksStatus,
  PkgJob,
  PkgVerifyResult,
  PlanPreview,
  SerialAction,
  SerialBytesTail,
  SerialDecodeResult,
  SerialDecodedTail,
  SerialMonitorTail,
  SerialPreviewResult,
  SerialWidget,
  SerialWidgetRunResult,
  SerialWidgetsDoc,
  SerialWriteResult,
} from '../../domain/icd.ts'
import type {
  DebugAuditResponse,
  DebugBreakpointsResponse,
  DebugControlResponse,
  DebugDisasmResponse,
  DebugEvaluateResponse,
  DebugMemoryResponse,
  DebugOpenOptions,
  DebugPeripheralsResponse,
  DebugRegistersResponse,
  DebugRtosResponse,
  DebugSessionResponse,
  DebugStackResponse,
  DebugVariablesResponse,
  DebugWatchResponse,
} from '../../domain/debug.ts'

export type {
  AdaptResponse,
  DiscoverResponse,
  ElabConfig,
  HostInfo,
  InstalledPack,
  MarketPack,
  PacksStatus,
  PkgJob,
  PkgVerifyResult,
} from '../../domain/icd.ts'

export interface ApiError {
  code: string
  message: string
}

export class ElabApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ElabApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    throw new ElabApiError('bad-json', `${path} 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const err = (body as { error?: ApiError } | null)?.error
    throw new ElabApiError(err?.code ?? `http-${res.status}`, err?.message ?? `HTTP ${res.status}`)
  }
  return body as T
}

function post<T>(path: string, payload: unknown, headers?: Record<string, string>): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(payload),
  })
}

function del<T>(path: string, payload: unknown, headers?: Record<string, string>): Promise<T> {
  return request<T>(path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(payload),
  })
}

/**
 * 附加 `sessionId` 查询参数 —— Host 半据此解析会话 cwd → elab 仓库根。
 * ★ /elab/host 与 /elab/api/* 都要带：进程首次 ensureHost 时用哪个仓库根，
 *   取决于第一个触发请求的会话（2026-10-26 实测：不带 sessionId 时
 *   auto 模式只能向上扫 DSH 进程 cwd，永远找不到仓库根 → 面板永远未就绪）。
 */
function withSession(path: string, sessionId?: string): string {
  if (sessionId === undefined || sessionId === '') return path
  return `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`
}

/** 后端契约版本；与 `EVENT_SCHEMA_VERSION` 比对，不一致显式报错而非渲染错位界面。 */
export const elabApi = {
  host: (sessionId?: string) => request<HostInfo>(withSession('/elab/host', sessionId)),
  /** 引导向导：只读环境探测（宿主半白名单执行，不 spawn 内核）。 */
  env: (sessionId?: string) => request<EnvResponse>(withSession('/elab/env', sessionId)),
  /** 引导向导：set-root / clone / install-toolchain / download-kernel（写动作，需 confirm:true）。 */
  bootstrap: (req: BootstrapRequest, sessionId?: string) =>
    post<BootstrapResponse>(withSession('/elab/bootstrap', sessionId), req),
  /** 零前置自动准备：主机侧状态快照（只读轮询，不触发动作）。 */
  bootstrapStatus: (sessionId?: string) =>
    request<{ ok: boolean; auto: AutoProvisionStatus }>(withSession('/elab/bootstrap', sessionId)),
  capabilities: (sessionId?: string) =>
    request<Record<string, unknown>>(withSession('/elab/api/capabilities', sessionId)),
  projects: (sessionId?: string) =>
    request<{ projects?: unknown[]; cards?: unknown[] }>(withSession('/elab/api/projects', sessionId)),
  runs: (sessionId?: string) =>
    request<{ runs: unknown[]; active: unknown[] }>(withSession('/elab/api/runs', sessionId)),
  runEvents: (run: string, from = 0, sessionId?: string) =>
    request<{ events: unknown[] }>(
      withSession(`/elab/api/run-events?run=${encodeURIComponent(run)}&from=${from}`, sessionId),
    ),
  /** 只读命令预览：不 spawn、不写盘。 */
  plan: (opts: { project: string; steps?: string[]; clean?: boolean; jobs?: number; sessionId?: string }) => {
    const q = new URLSearchParams({ project: opts.project })
    if (opts.steps?.length) q.set('steps', opts.steps.join(','))
    if (opts.clean) q.set('clean', '1')
    if (opts.jobs) q.set('jobs', String(opts.jobs))
    return request<PlanPreview>(withSession(`/elab/api/plan?${q.toString()}`, opts.sessionId))
  },
  startRun: (opts: { project: string; steps: string[]; clean?: boolean; jobs?: number; sessionId?: string }) =>
    post<{ run: string; project: string; steps: string[]; actor: string }>(
      withSession('/elab/api/run', opts.sessionId),
      opts,
    ),
  /** Agent 工具走这条（Host 半据 x-elab-actor 打 actor='agent'）。 */
  startRunAsAgent: (opts: { project: string; steps: string[]; clean?: boolean; sessionId?: string }) =>
    post<{ run: string }>(withSession('/elab/api/run', opts.sessionId), opts, { 'x-elab-actor': 'agent' }),
  cancel: (run: string, reason?: string, sessionId?: string) =>
    post<{ ok: boolean }>(withSession('/elab/api/cancel', sessionId), { run, reason }),
  serial: (opts: {
    project: string
    data: string
    baud?: number
    port?: string
    newline?: boolean
    hex?: boolean
    /** P1：utf8/ascii/gbk/hex；与 newline/eol 互斥由服务端 build_payload 统一裁决 */
    format?: string
    eol?: string
    encoding?: string
    sessionId?: string
  }) => post<SerialWriteResult>(withSession('/elab/api/serial', opts.sessionId), opts),
  /**
   * 只算字节、不碰串口（`dry_run`）。
   * ★ 自动识别/预览的唯一事实源在服务端；前端不在本地编码。
   */
  serialPreview: (opts: {
    project: string
    data: string
    port?: string
    baud?: number
    format?: string
    eol?: string
    encoding?: string
    sessionId?: string
  }) =>
    post<SerialPreviewResult>(withSession('/elab/api/serial', opts.sessionId), {
      ...opts,
      dry_run: true,
    }),
  /** 发送框定时发送：瞬态任务（不落盘），与组件共用任务引擎。 */
  serialLoop: (opts: {
    project: string
    data: string
    port?: string
    baud?: number
    format?: string
    eol?: string
    encoding?: string
    interval_ms?: number
    count?: number
    dry_run?: boolean
    sessionId?: string
  }) =>
    post<SerialWidgetRunResult>(withSession('/elab/api/serial/loop', opts.sessionId), opts),
  serialMonitor: (after = 0, sessionId?: string) =>
    request<SerialMonitorTail>(withSession(`/elab/api/serial/monitor?after=${after}`, sessionId)),
  /** P1 字节真值：增量拉取原始批次（方向/时间/序号 + base64）。 */
  serialMonitorBytes: (
    after = 0,
    opts?: { dir?: 'all' | 'rx' | 'tx'; limit?: number; sessionId?: string },
  ) => {
    const q = new URLSearchParams({ after: String(after) })
    if (opts?.dir !== undefined && opts.dir !== 'all') q.set('dir', opts.dir)
    if (opts?.limit !== undefined && opts.limit > 0) q.set('limit', String(opts.limit))
    return request<SerialBytesTail>(withSession(`/elab/api/serial/monitor/bytes?${q.toString()}`, opts?.sessionId))
  },
  /** 会话级共享解码帧（P3.5）：agent 与面板波页读同一份。 */
  serialMonitorDecoded: (after = 0, sessionId?: string) =>
    request<SerialDecodedTail>(
      withSession(`/elab/api/serial/monitor/decoded?after=${after}`, sessionId),
    ),
  /**
   * 监视会话动作（open/close/decoder/clear/pause/resume）。
   * ★ action **必须在 body 里**：服务端 POST /api/serial/monitor 读的是 body.action
   *   （此前只放 query → clear/pause/resume 全部落到 400）。
   */
  serialMonitorToggle: (
    action: SerialAction,
    opts?: {
      project?: string
      port?: string
      baud?: number
      actor?: 'human' | 'agent'
      lease_s?: number
      allow_agent_write?: boolean
      /** action=decoder：justfloat / firewater（'' = 关闭共享解码） */
      decoder?: string
      sessionId?: string
    },
  ) =>
    post<Record<string, unknown>>(
      withSession('/elab/api/serial/monitor', opts?.sessionId),
      { ...(opts ?? {}), action },
    ),
  /** P3 无状态协议解码（JustFloat / FireWater）。 */
  serialDecode: (opts: {
    decoder: string
    dataB64?: string
    hex?: string
    channels?: number
    sessionId?: string
  }) =>
    post<SerialDecodeResult>(withSession('/elab/api/serial/decode', opts.sessionId), {
      decoder: opts.decoder,
      ...(opts.dataB64 !== undefined ? { data_b64: opts.dataB64 } : {}),
      ...(opts.hex !== undefined ? { hex: opts.hex } : {}),
      ...(opts.channels !== undefined ? { channels: opts.channels } : {}),
    }),
  /** K5 显式录制：字节写成有界 JSONL（证据，可回放）。 */
  serialCapture: (opts: {
    action: 'start' | 'stop' | 'status'
    project?: string
    maxBytes?: number
    sessionId?: string
  }) =>
    post<Record<string, unknown>>(withSession('/elab/api/serial/capture', opts.sessionId), {
      action: opts.action,
      ...(opts.project !== undefined ? { project: opts.project } : {}),
      ...(opts.maxBytes !== undefined ? { max_bytes: opts.maxBytes } : {}),
    }),
  serialConsole: (limit = 60, sessionId?: string) =>
    request<Record<string, unknown>>(withSession(`/elab/api/serial/console?limit=${limit}`, sessionId)),

  // ── 串口发送组件（M1/M2）：读/存/跑/轮询/取消/暂停 ─────────────
  /** GET /api/serial/widgets：工程级组件投影（含 rev / warnings / 文件级 error）。 */
  serialWidgets: (project: string, sessionId?: string) =>
    request<SerialWidgetsDoc>(
      withSession(`/elab/api/serial/widgets?project=${encodeURIComponent(project)}`, sessionId),
    ),
  /** POST /api/serial/widgets action=save：rev 不匹配 → 409（调用方重读后再存）。 */
  serialWidgetSave: (opts: {
    project: string
    rev: number
    widget: SerialWidget | Record<string, unknown>
    sessionId?: string
  }) =>
    post<SerialWidgetsDoc>(withSession('/elab/api/serial/widgets', opts.sessionId), {
      action: 'save', project: opts.project, rev: opts.rev, widget: opts.widget,
    }),
  /** POST /api/serial/widgets action=delete。 */
  serialWidgetDelete: (opts: { project: string; rev: number; id: string; sessionId?: string }) =>
    post<SerialWidgetsDoc>(withSession('/elab/api/serial/widgets', opts.sessionId), {
      action: 'delete', project: opts.project, rev: opts.rev, id: opts.id,
    }),
  /**
   * POST /api/serial/widget/run：dry_run=true 只预览；否则执行（异步任务）。
   * 返回 `state='running'` 时用 serialWidgetJob 轮询到终态。
   */
  serialWidgetRun: (opts: {
    project: string
    id: string
    params?: Record<string, unknown>
    dryRun?: boolean
    /** true = 按组件 repeat 配置周期跑（组件没配 → 400） */
    repeat?: boolean
    confirm?: boolean
    /** agent 调用时置 true（Host 半据此打 actor='agent'；人 = 默认 false） */
    agent?: boolean
    sessionId?: string
  }) =>
    post<SerialWidgetRunResult>(
      withSession('/elab/api/serial/widget/run', opts.sessionId),
      {
        project: opts.project,
        id: opts.id,
        ...(opts.params !== undefined ? { params: opts.params } : {}),
        ...(opts.dryRun === true ? { dry_run: true } : {}),
        ...(opts.repeat === true ? { repeat: true } : {}),
        ...(opts.confirm === true ? { confirm: true } : {}),
      },
      opts.agent === true ? { 'x-elab-actor': 'agent' } : undefined,
    ),
  /** GET /api/serial/widget/job?id=：任务快照；id 缺省 = 当前未结束的任务。 */
  serialWidgetJob: (jobId = '', sessionId?: string) =>
    request<SerialWidgetRunResult>(withSession(
      `/elab/api/serial/widget/job${jobId === '' ? '' : `?id=${encodeURIComponent(jobId)}`}`,
      sessionId,
    )),
  serialWidgetCancel: (jobId: string, sessionId?: string) =>
    post<{ ok: boolean; id: string; state: string }>(
      withSession('/elab/api/serial/widget/cancel', sessionId), { id: jobId },
    ),
  serialWidgetPause: (jobId: string, paused: boolean, sessionId?: string) =>
    post<{ ok: boolean; id: string; state: string; paused?: boolean }>(
      withSession('/elab/api/serial/widget/pause', sessionId), { id: jobId, paused },
    ),

  adapt: (opts: { action: 'probe' | 'write' | 'check'; path: string; name?: string; force?: boolean; sessionId?: string }) =>
    post<AdaptResponse>(withSession('/elab/api/adapt', opts.sessionId), opts),
  setProjectProbe: (name: string, probe: string, sessionId?: string) =>
    post<{ action: string; name: string; probe: string }>(
      withSession('/elab/api/project', sessionId),
      { action: 'set_probe', name, probe },
    ),
  discover: (sessionId?: string, refresh = false) => {
    const q = new URLSearchParams()
    if (sessionId !== undefined && sessionId !== '') q.set('sessionId', sessionId)
    if (refresh) q.set('refresh', '1')
    return request<DiscoverResponse>(`/elab/api/discover?${q.toString()}`)
  },
  /** 设置页（P4）：读/保存插件配置（宿主热更新 + 持久化） */
  getConfig: () => request<{ ok: boolean; config: ElabConfig }>('/elab/config'),
  saveConfig: (patch: Partial<ElabConfig>) =>
    post<{ ok: boolean; config: ElabConfig }>('/elab/config', patch),

  // ── 适配包 / 社区市场（工具层只渲染内核投影，逻辑全在内核）────────
  /** GET /api/packs：已装包 + （可选）市场条目。market=false 跳过市场索引读取。 */
  packs: (opts?: { market?: boolean; q?: string; sessionId?: string }) => {
    const q = new URLSearchParams()
    if (opts?.market === false) q.set('market', '0')
    if (opts?.q !== undefined && opts.q !== '') q.set('q', opts.q)
    const qs = q.toString()
    return request<PacksStatus>(withSession(`/elab/api/packs${qs === '' ? '' : `?${qs}`}`, opts?.sessionId))
  },
  /** GET /api/pkg/job：包操作任务快照（202 后 500ms 轮询）。 */
  pkgJob: (jobId: string, sessionId?: string) =>
    request<PkgJob>(withSession(`/elab/api/pkg/job?job=${encodeURIComponent(jobId)}`, sessionId)),
  /**
   * POST /api/pkg/install：**只收包名**（来源与 sha256 由内核从市场索引解析）。
   * official=true → 装本仓 `packs/official` 里的内置包（离线）。
   * 返回 202 + job（异步：git clone / 哈希 / 复制可能很久）。
   */
  pkgInstall: (opts: { name: string; official?: boolean; force?: boolean; sessionId?: string }) =>
    post<PkgJob>(withSession('/elab/api/pkg/install', opts.sessionId), {
      name: opts.name,
      ...(opts.official === true ? { official: true } : {}),
      ...(opts.force === true ? { force: true } : {}),
    }),
  pkgRemove: (opts: { name: string; sessionId?: string }) =>
    post<PkgJob>(withSession('/elab/api/pkg/remove', opts.sessionId), { name: opts.name }),
  pkgUpdate: (opts: { name?: string; force?: boolean; sessionId?: string } = {}) =>
    post<PkgJob>(withSession('/elab/api/pkg/update', opts.sessionId), {
      ...(opts.name !== undefined && opts.name !== '' ? { name: opts.name } : {}),
      ...(opts.force === true ? { force: true } : {}),
    }),
  /** verify 是同步 200（只读、快）。name 缺省 = 全部已装包。 */
  pkgVerify: (opts: { name?: string; sessionId?: string } = {}) =>
    post<{ ok: boolean; results: PkgVerifyResult[] }>(
      withSession('/elab/api/pkg/verify', opts.sessionId),
      { ...(opts.name !== undefined && opts.name !== '' ? { name: opts.name } : {}) },
    ),
  /**
   * 首次进入市场：现场遍历 GitHub 上现有 elab-pack 仓库（202 + job）。
   * 结果落本机 `.work/pkg/market-live.json`，15 分钟内 `GET /api/packs` 直接复用。
   */
  marketRefresh: (opts?: { sessionId?: string }) =>
    post<PkgJob>(withSession('/elab/api/pkg/market', opts?.sessionId), {}),
  /** activate 是同步 200：启用一套已装包 + 重生成平台 skill + 重载 Config。 */
  pkgActivate: (opts: { name: string; sessionId?: string }) =>
    post<Record<string, unknown>>(withSession('/elab/api/pkg/activate', opts.sessionId), {
      name: opts.name,
    }),

  // ── 调试会话（§6 ICD；Agent 与面板同源）──────────────────────────
  debugSession: (sessionId?: string) =>
    request<DebugSessionResponse>(withSession('/elab/api/debug/session', sessionId)),
  /**
   * 打开会话。agent=true 时带上内部头（内核据此把 owner 设为 agent，
   * 租约到点自动关闭并恢复运行）。
   */
  debugOpen: (opts: {
    project: string
    options?: DebugOpenOptions
    lease_s?: number
    allow_write?: boolean
    agent?: boolean
    sessionId?: string
  }) =>
    post<DebugSessionResponse>(
      withSession('/elab/api/debug/session', opts.sessionId),
      {
        project: opts.project,
        ...(opts.options !== undefined ? { options: opts.options } : {}),
        ...(opts.lease_s !== undefined ? { lease_s: opts.lease_s } : {}),
        ...(opts.allow_write === true ? { allow_write: true } : {}),
      },
      opts.agent === true ? { 'x-elab-actor': 'agent' } : undefined,
    ),
  /** DELETE：关闭会话；默认 resume=true（monitor reset run）—— C36 延伸。 */
  debugClose: (opts?: { resume?: boolean; reason?: string; agent?: boolean; sessionId?: string }) =>
    del<{ closed: boolean; resumed?: boolean; session?: string }>(
      withSession('/elab/api/debug/session', opts?.sessionId),
      {
        resume: opts?.resume !== false,
        ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
      },
      opts?.agent === true ? { 'x-elab-actor': 'agent' } : undefined,
    ),
  debugControl: (opts: {
    action: string
    addr?: string
    confirm?: boolean
    agent?: boolean
    sessionId?: string
  }) =>
    post<DebugControlResponse>(
      withSession('/elab/api/debug/control', opts.sessionId),
      {
        action: opts.action,
        ...(opts.addr !== undefined ? { addr: opts.addr } : {}),
        ...(opts.confirm === true ? { confirm: true } : {}),
      },
      opts.agent === true ? { 'x-elab-actor': 'agent' } : undefined,
    ),
  debugStack: (opts?: { thread?: number; sessionId?: string }) => {
    const q = new URLSearchParams()
    if (opts?.thread !== undefined) q.set('thread', String(opts.thread))
    const qs = q.toString()
    return request<DebugStackResponse>(
      withSession(`/elab/api/debug/stack${qs === '' ? '' : `?${qs}`}`, opts?.sessionId),
    )
  },
  debugVariables: (opts?: {
    frame?: number
    scope?: 'locals' | 'args' | 'children'
    var?: string
    sessionId?: string
  }) => {
    const q = new URLSearchParams()
    if (opts?.frame !== undefined) q.set('frame', String(opts.frame))
    if (opts?.scope !== undefined) q.set('scope', opts.scope)
    if (opts?.var !== undefined && opts.var !== '') q.set('var', opts.var)
    return request<DebugVariablesResponse>(
      withSession(`/elab/api/debug/variables?${q.toString()}`, opts?.sessionId),
    )
  },
  debugRegisters: (opts?: { group?: string; format?: 'natural' | 'hex'; sessionId?: string }) => {
    const q = new URLSearchParams()
    if (opts?.group !== undefined) q.set('group', opts.group)
    if (opts?.format !== undefined) q.set('format', opts.format)
    return request<DebugRegistersResponse>(
      withSession(`/elab/api/debug/registers?${q.toString()}`, opts?.sessionId),
    )
  },
  debugBreakpoints: (
    opts?: {
      op?: 'list' | 'add' | 'update' | 'toggle' | 'remove'
      id?: string
      kind?: 'func' | 'addr'
      location?: string
      condition?: string
      enabled?: boolean
      hardware?: boolean
      temporary?: boolean
      agent?: boolean
      sessionId?: string
    },
  ) => {
    if (opts?.op === undefined || opts.op === 'list') {
      return request<DebugBreakpointsResponse>(
        withSession('/elab/api/debug/breakpoints', opts?.sessionId),
      )
    }
    return post<DebugBreakpointsResponse>(
      withSession('/elab/api/debug/breakpoints', opts?.sessionId),
      {
        op: opts.op,
        ...(opts.id !== undefined ? { id: opts.id } : {}),
        ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
        ...(opts.location !== undefined ? { location: opts.location } : {}),
        ...(opts.condition !== undefined ? { condition: opts.condition } : {}),
        ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
        ...(opts.hardware === true ? { hardware: true } : {}),
        ...(opts.temporary === true ? { temporary: true } : {}),
      },
      opts?.agent === true ? { 'x-elab-actor': 'agent' } : undefined,
    )
  },
  debugMemory: (opts: { addr: string; count?: number; sessionId?: string }) => {
    const q = new URLSearchParams({ addr: opts.addr })
    if (opts.count !== undefined) q.set('count', String(opts.count))
    return request<DebugMemoryResponse>(
      withSession(`/elab/api/debug/memory?${q.toString()}`, opts.sessionId),
    )
  },
  debugDisasm: (opts?: { addr?: string; count?: number; mode?: number; sessionId?: string }) => {
    const q = new URLSearchParams()
    if (opts?.addr !== undefined) q.set('addr', opts.addr)
    if (opts?.count !== undefined) q.set('count', String(opts.count))
    if (opts?.mode !== undefined) q.set('mode', String(opts.mode))
    const qs = q.toString()
    return request<DebugDisasmResponse>(
      withSession(`/elab/api/debug/disasm${qs === '' ? '' : `?${qs}`}`, opts?.sessionId),
    )
  },
  debugEvaluate: (opts: { expr: string; frame?: number; agent?: boolean; sessionId?: string }) =>
    post<DebugEvaluateResponse>(
      withSession('/elab/api/debug/evaluate', opts.sessionId),
      { expr: opts.expr, ...(opts.frame !== undefined ? { frame: opts.frame } : {}) },
      opts.agent === true ? { 'x-elab-actor': 'agent' } : undefined,
    ),
  /** 写内存/寄存器：必须 allow_write=true 的会话 + confirm=true。 */
  debugWrite: (opts: {
    target: 'memory' | 'register'
    addr?: string
    name?: string
    value: string
    confirm?: boolean
    agent?: boolean
    sessionId?: string
  }) =>
    post<Record<string, unknown>>(
      withSession('/elab/api/debug/write', opts.sessionId),
      {
        target: opts.target,
        ...(opts.addr !== undefined ? { addr: opts.addr } : {}),
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        value: opts.value,
        confirm: opts.confirm === true,
      },
      opts.agent === true ? { 'x-elab-actor': 'agent' } : undefined,
    ),
  /** 监视表达式（P1）：列表在停止态求值；写操作走 `rev` 乐观锁。 */
  debugWatch: (opts?: {
    op?: 'list' | 'add' | 'update' | 'remove'
    id?: string
    expr?: string
    format?: string
    rev?: number
    agent?: boolean
    sessionId?: string
  }) => {
    if (opts?.op === undefined || opts.op === 'list') {
      return request<DebugWatchResponse>(
        withSession('/elab/api/debug/watch', opts?.sessionId),
      )
    }
    return post<DebugWatchResponse>(
      withSession('/elab/api/debug/watch', opts?.sessionId),
      {
        op: opts.op,
        ...(opts.id !== undefined ? { id: opts.id } : {}),
        ...(opts.expr !== undefined ? { expr: opts.expr } : {}),
        ...(opts.format !== undefined ? { format: opts.format } : {}),
        ...(opts.rev !== undefined ? { rev: opts.rev } : {}),
      },
      opts.agent === true ? { 'x-elab-actor': 'agent' } : undefined,
    )
  },
  debugAudit: (opts?: { limit?: number; sessionId?: string }) => {
    const q = new URLSearchParams()
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return request<DebugAuditResponse>(
      withSession(`/elab/api/debug/audit${qs === '' ? '' : `?${qs}`}`, opts?.sessionId),
    )
  },
  debugPeripherals: (opts?: { path?: string; read?: boolean; sessionId?: string }) => {
    const q = new URLSearchParams()
    if (opts?.path !== undefined && opts.path !== '') q.set('path', opts.path)
    if (opts?.read === true) q.set('read', '1')
    const qs = q.toString()
    return request<DebugPeripheralsResponse>(
      withSession(`/elab/api/debug/peripherals${qs === '' ? '' : `?${qs}`}`, opts?.sessionId),
    )
  },
  debugRtos: (opts?: { sessionId?: string }) =>
    request<DebugRtosResponse>(withSession('/elab/api/debug/rtos', opts?.sessionId)),
}
