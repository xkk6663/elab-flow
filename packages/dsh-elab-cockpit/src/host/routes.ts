/**
 * Host 半：`/elab/*` 路由 —— API 代理 + SSE 透传 + 健康/清理。
 *
 * 设计要点（全部来自实测，见文档 §4.2/§4.3/§14）：
 *   ① 每条路由先过 `ctx.connection.requestRejection(req)`（照 better-sidebar 的 fence）；
 *   ② **方法白名单**：只转发已知端点，不做通配反代 ——
 *      否则上游将来新增危险端点会被自动暴露；
 *   ③ `POST /elab/api/run` 统一注入 `actor`：面板点 = human，工具调 = agent；
 *   ④ SSE **字节级透传**：保留 `id:` 帧（Last-Event-ID 续传依赖它）、
 *      `no-transform`、心跳；收到 `stream/closed` 由浏览器侧关闭；
 *   ⑤ 进程按需启动（`ensureHost`），空闲超时回收。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { registerOnce } from './route-guard.ts'
import { CockpitHost } from './host-process.ts'
import { looksLikeElabRoot } from './host-process.ts'
import type { RunArbiter } from './run-arbiter.ts'
import { runRetention, type RetentionConfig } from './run-retention.ts'

export interface HostRouteContext {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
  connection?: { requestRejection(req: unknown): unknown }
  sessions?: { get(id: string): { header?: { cwd?: string } } | undefined }
  workingDirectory?: { get(session: unknown): string | undefined; defaultDirectory?: string }
  /** P5：agent 工具注册面（dsh-tools 服务；结构化声明，不 import 宿主类型）。 */
  tools?: { register(definition: unknown): () => void }
  logger?: { warn?(msg: string): void; info?(msg: string): void }
  effect(callback: () => () => void, label?: string): void
  get(name: string): unknown
}

export interface HostRouteConfig {
  elabRoot: string
  pythonPath: string
  idleKillSec: number
  retention: RetentionConfig
}

export const DEFAULT_HOST_ROUTE_CONFIG: HostRouteConfig = {
  elabRoot: 'auto',
  pythonPath: 'auto',
  idleKillSec: 1800,
  retention: { keepCount: 200, keepDays: 14, maxTotalBytes: 50 * 1024 * 1024, dryRun: false },
}

/** 允许转发的 GET 端点（路径 → 是否允许）。 */
const GET_ALLOW = new Set([
  'capabilities',
  'projects',
  'runs',
  'plan',
  'run-events',
  'serial/console',
  'serial/monitor',
])

/** 允许转发的 POST 端点。 */
const POST_ALLOW = new Set(['run', 'cancel', 'serial', 'adapt'])

export interface ProxyDeps {
  /** 取当前可用的 cockpit 实例（按需启动）。sessionId 用于解析会话 cwd → elab 仓库根。 */
  ensureHost(sessionId?: string): Promise<{ baseUrl: string; info: { port: number; job: string; bootMs: number } }>
  config(): HostRouteConfig
  /** run 仲裁（P5）：POST /elab/api/run 路径上的单飞互斥；缺省不拦。 */
  arbiter?: RunArbiter
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(Buffer.byteLength(text)))
  res.end(text)
}

function err(res: ServerResponse, code: number, errorCode: string, message: string): void {
  json(res, code, { ok: false, error: { code: errorCode, message } })
}

async function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limit) throw new Error(`请求体超过 ${limit} 字节`)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * `/elab/api/<method>`（prefix）—— 白名单转发的 JSON API。
 *
 * 查询串原样透传；POST body 透传前按需注入 `actor`。
 */
export function registerApiRoute(ctx: HostRouteContext, deps: ProxyDeps): () => void {
  const dispose = registerOnce(ctx, {
    kind: 'prefix',
    path: '/elab/api',
    handler: async (req, res) => {
      if (ctx.connection?.requestRejection(req) !== undefined) {
        return err(res, 403, 'forbidden', 'forbidden')
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      let rel = url.pathname.startsWith('/elab/api/') ? url.pathname.slice('/elab/api/'.length) : ''
      rel = rel.replace(/\/+$/, '')
      // 只允许单段或已知的两段（serial/console…）
      const method = req.method ?? 'GET'
      const allowed = method === 'GET' ? GET_ALLOW : method === 'POST' ? POST_ALLOW : undefined
      if (allowed === undefined) {
        res.setHeader('Allow', 'GET, POST')
        return err(res, 405, 'method-not-allowed', `不支持的方法：${method}`)
      }
      if (rel === '' || !allowed.has(rel)) {
        return err(res, 404, 'unknown-endpoint', `未知端点：${rel || '(空)'}（${method}）`)
      }

      let host
      try {
        host = await deps.ensureHost(url.searchParams.get('sessionId') ?? undefined)
      } catch (error) {
        return err(res, 503, 'host-unavailable', error instanceof Error ? error.message : String(error))
      }

      const target = new URL(`${host.baseUrl}/api/${rel}`)
      url.searchParams.forEach((v, k) => target.searchParams.set(k, v))

      const init: RequestInit & { duplex?: 'half' } = { method }
      let runAcquired = false
      const rootKey = url.searchParams.get('sessionId') ?? 'default'
      if (method === 'POST') {
        const raw = await readBody(req)
        let body = raw
        try {
          const parsed = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
          // ★ actor 注入：AI 通过工具发起时，Host 半会带上 `__actor`
          //   （工具层用内部头传，避免与用户 body 混淆）
          const internal = req.headers['x-elab-actor']
          if (rel === 'run') {
            parsed.actor = internal === 'agent' ? 'agent' : 'human'
          }
          // ★ RunArbiter（§6.2）：同一 rootKey 同时最多 1 个 run；
          //   人工 run 进行中 agent 请求返回 human-busy（不静默排队）。
          if (rel === 'run' && deps.arbiter !== undefined) {
            const actor = parsed.actor === 'agent' ? 'agent' : 'human'
            const steps = Array.isArray(parsed.steps) ? parsed.steps.map(String) : []
            const acquire = await deps.arbiter.tryAcquire(rootKey, actor, steps)
            if (!acquire.ok) {
              return json(res, 409, {
                ok: false,
                error: {
                  code: acquire.code,
                  message:
                    acquire.code === 'human-busy'
                      ? '人工 run 进行中，agent 不抢占；等待结束或请用户取消'
                      : '已有 run 在跑（同一会话同时最多 1 个）',
                },
                holder: acquire.holder,
                ...(acquire.nextAction !== undefined ? { nextAction: acquire.nextAction } : {}),
              })
            }
            runAcquired = true
          }
          body = JSON.stringify(parsed)
        } catch {
          /* 非 JSON：原样透传，让上游报错 */
        }
        init.body = body
        init.headers = { 'Content-Type': 'application/json' }
      }

      try {
        const upstream = await fetch(target, init)
        const text = await upstream.text()
        // 仲裁簿记：成功回填 run id；上游失败撤销占用
        if (rel === 'run' && deps.arbiter !== undefined && runAcquired) {
          try {
            const parsedRun = JSON.parse(text) as { run?: unknown }
            if (upstream.ok && typeof parsedRun.run === 'string') deps.arbiter.attachRun(rootKey, parsedRun.run)
            else if (!upstream.ok) deps.arbiter.releaseIfPending(rootKey)
          } catch {
            if (!upstream.ok) deps.arbiter.releaseIfPending(rootKey)
          }
        }
        res.statusCode = upstream.status
        res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Length', String(Buffer.byteLength(text)))
        res.end(text)
      } catch (error) {
        err(res, 502, 'upstream-unreachable', error instanceof Error ? error.message : String(error))
      }
    },
  })
  return () => {
    void dispose
  }
}

/**
 * `/elab/events`（exact）—— SSE 字节级透传。
 *
 * ★ 关键：不解析、不重组，只 pipe。理由（实测 + 源码）：
 *   服务端用 `id: <seq>` + `event: <topic>` 发帧，浏览器/客户端靠 `id` 维护
 *   `Last-Event-ID` 做断线续传（`server.py:1046-1200`）。任何中间层的重组
 *   都会破坏这个契约；而 `proc/stdout-batch` 的 100ms 合帧也已在服务端做好。
 */
export function registerEventsRoute(ctx: HostRouteContext, deps: ProxyDeps): () => void {
  return registerOnce(ctx, {
    kind: 'exact',
    path: '/elab/events',
    handler: async (req, res) => {
      if (ctx.connection?.requestRejection(req) !== undefined) {
        return err(res, 403, 'forbidden', 'forbidden')
      }
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        return err(res, 405, 'method-not-allowed', 'SSE 只接受 GET')
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const run = url.searchParams.get('run') ?? ''
      if (run === '') return err(res, 400, 'bad-request', '缺少 run 参数')

      let host
      try {
        host = await deps.ensureHost(url.searchParams.get('sessionId') ?? undefined)
      } catch (error) {
        return err(res, 503, 'host-unavailable', error instanceof Error ? error.message : String(error))
      }

      const target = new URL(`${host.baseUrl}/api/events`)
      target.searchParams.set('run', run)
      const from = url.searchParams.get('from')
      if (from !== null) target.searchParams.set('from', from)

      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      // 续传：浏览器若带了 Last-Event-ID，原样转给上游（它自己会 max(from, leid)）
      const leid = req.headers['last-event-id']
      if (typeof leid === 'string' && leid !== '') headers['Last-Event-ID'] = leid

      let aborted = false
      // 客户端断开 → 中止上游请求（避免泄漏一条 SSE 连接，上游 MAX_SSE_CONNS 有上限）
      res.on('close', () => {
        aborted = true
      })

      try {
        const upstream = await fetch(target, { headers, signal: AbortSignal.timeout(30 * 60_000) })
        if (!upstream.ok || upstream.body === null) {
          const text = await upstream.text().catch(() => '')
          return err(res, upstream.status || 502, 'upstream-error', text.slice(0, 300))
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        // ★ 不让 Node 的 keepAlive 超时掐断长连接
        res.socket?.setTimeout(0)
        res.flushHeaders?.()

        const reader = upstream.body.getReader()
        while (!aborted) {
          const { done, value } = await reader.read()
          if (done) break
          // 原文写出：帧边界、id、event 全部保持不变
          res.write(Buffer.from(value))
        }
        try { await reader.cancel() } catch { /* ignore */ }
        if (!aborted) res.end()
      } catch (error) {
        if (!aborted) {
          try {
            err(res, 502, 'sse-failed', error instanceof Error ? error.message : String(error))
          } catch { /* 头已发出，无法回错 */ }
        }
      }
    },
  })
}
