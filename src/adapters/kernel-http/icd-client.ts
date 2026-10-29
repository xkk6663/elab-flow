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
  PlanPreview,
} from '../../domain/icd.ts'

export type { AdaptResponse, DiscoverResponse, ElabConfig, HostInfo } from '../../domain/icd.ts'

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
  serial: (opts: { project: string; data: string; baud?: number; newline?: boolean; sessionId?: string }) =>
    post<Record<string, unknown>>(withSession('/elab/api/serial', opts.sessionId), opts),
  serialMonitor: (after = 0, sessionId?: string) =>
    request<Record<string, unknown>>(withSession(`/elab/api/serial/monitor?after=${after}`, sessionId)),
  serialMonitorToggle: (action: 'open' | 'close', opts?: { project?: string; baud?: number; sessionId?: string }) =>
    post<Record<string, unknown>>(withSession(`/elab/api/serial/monitor?action=${action}`, opts?.sessionId), opts ?? {}),
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
}
