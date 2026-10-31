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
  DiscoverResponse,
  ElabConfig,
  HostInfo,
  PacksStatus,
  PkgJob,
  PkgVerifyResult,
  PlanPreview,
  SerialAction,
  SerialBytesTail,
  SerialDecodeResult,
  SerialMonitorTail,
  SerialWriteResult,
} from '../../domain/icd.ts'

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
  /**
   * 监视会话动作（open/close/clear/pause/resume）。
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
  adapt: (opts: { action: 'probe' | 'write'; path: string; name?: string; force?: boolean; sessionId?: string }) =>
    post<AdaptResponse>(withSession('/elab/api/adapt', opts.sessionId), opts),
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
  /** activate 是同步 200：启用一套已装包 + 重生成平台 skill + 重载 Config。 */
  pkgActivate: (opts: { name: string; sessionId?: string }) =>
    post<Record<string, unknown>>(withSession('/elab/api/pkg/activate', opts.sessionId), {
      name: opts.name,
    }),
}
