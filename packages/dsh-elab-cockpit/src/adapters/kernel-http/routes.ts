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
import { ONHW_STEPS } from '../../domain/pipeline.ts'
import type { KernelProxyDeps, RetentionConfig, SerialMutexPort } from '../../app/ports.ts'

/**
 * 串口监视互斥的宿主侧记账（§6.2 规则 2）：监视 open/close 都走本代理，
 * 记账即准确；cockpit 生命周期由宿主管（空闲回收 / Job Object 全树终结），
 * 进程死了监视必然一起没了 —— 重启后初值 false 与真实状态一致。
 *
 * ★ 批 2 端口化：形状 = app/ports.ts 的 SerialMutexPort（本文件保留实现与旧名）。
 */
export type SerialMutexTracker = SerialMutexPort

export function createSerialMutexTracker(): SerialMutexTracker {
  let active = false
  return {
    setOpen(v: boolean): void {
      active = v
    },
    isActive(): boolean {
      return active
    },
  }
}

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
  /** 首次打开面板时自动准备内核与工具链（默认 true）。 */
  autoProvision: boolean
}

export const DEFAULT_HOST_ROUTE_CONFIG: HostRouteConfig = {
  elabRoot: 'auto',
  pythonPath: 'auto',
  idleKillSec: 1800,
  retention: { keepCount: 200, keepDays: 14, maxTotalBytes: 50 * 1024 * 1024, dryRun: false },
  autoProvision: true,
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
  // P1 字节真值：与行级 monitor 同步轮询（方向/时间/序号 + base64 原始字节）
  'serial/monitor/bytes',
  // P3.5 会话级共享解码帧：agent 与面板读同一份（?after= 增量游标）
  'serial/monitor/decoded',
  // 适配包 / 社区市场投影（只读）：?market=0 跳过联网，?q= 搜索市场条目
  'packs',
  // 包操作任务快照（POST /api/pkg/* 返回 202 后轮询它）
  'pkg/job',
  // 工程级发送组件（M1/M2）：只读投影
  'serial/widgets',
  // 组件任务快照（run 返回 running 后 300–500ms 轮询；不带 id = 当前任务）
  'serial/widget/job',
  // 调试会话（§6 ICD）：面板/Agent 同源只读
  'debug/session', 'debug/stack', 'debug/variables', 'debug/registers',
  'debug/breakpoints', 'debug/memory', 'debug/disasm',
  'debug/watch', 'debug/audit', 'debug/peripherals', 'debug/rtos',
])

/** 允许转发的 POST 端点。 */
const POST_ALLOW = new Set(['run', 'cancel', 'serial', 'serial/monitor', 'serial/decode',
  'serial/capture', 'adapt', 'project',
  // 适配包写动作（内核 `_pkg`）：install/remove/update 回 202 + job，verify/activate 同步 200
  'pkg/install', 'pkg/remove', 'pkg/verify', 'pkg/update', 'pkg/activate',
  // 工程级发送组件（M1/M2）：保存/删除（rev 乐观锁）+ 执行/取消/暂停
  'serial/widgets', 'serial/widget/run', 'serial/widget/cancel', 'serial/widget/pause',
  // 发送框的定时发送：瞬态任务，不落盘（与组件共用任务引擎）
  'serial/loop',
  // 调试会话（§6 ICD）：open / control / breakpoints / watch / evaluate / write
  'debug/session', 'debug/control', 'debug/breakpoints', 'debug/watch',
  'debug/evaluate', 'debug/write'])

/** 允许转发的 DELETE 端点（调试会话关闭必须恢复运行 —— D8/C36）。 */
const DELETE_ALLOW = new Set(['debug/session'])

/** 需要按 `x-elab-actor` 注入 actor 的端点（调试租约/写权限依赖它）。 */
const ACTOR_INJECT = new Set([
  'debug/session', 'debug/control', 'debug/breakpoints', 'debug/watch',
  'debug/evaluate', 'debug/write',
])

/**
 * 代理路由的依赖端口（原 ProxyDeps；批 2 起形状收敛到 app/ports.ts）。
 * 实现由 main.ts 组装注入（host-app 的 ensureHost + 配置读取 + 仲裁 + 互斥）。
 */
export type ProxyDeps = KernelProxyDeps

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
      // DELETE 只有调试会话关闭一个合法端点；其余端点保持"方法不允许"（与历史契约一致）
      if (method === 'DELETE' && !DELETE_ALLOW.has(rel)) {
        res.setHeader('Allow', 'GET, POST')
        return err(res, 405, 'method-not-allowed', `不支持的方法：${method}`)
      }
      const allowed = method === 'GET' ? GET_ALLOW
        : method === 'POST' ? POST_ALLOW
          : method === 'DELETE' ? DELETE_ALLOW : undefined
      if (allowed === undefined) {
        res.setHeader('Allow', 'GET, POST, DELETE')
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
      if (method === 'POST' || method === 'DELETE') {
        const raw = await readBody(req)
        let body = raw
        try {
          const parsed = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
          // ★ actor 注入：AI 通过工具发起时，Host 半会带上 `__actor`
          //   （工具层用内部头传，避免与用户 body 混淆）
          const internal = req.headers['x-elab-actor']
          // ★ 调试会话：租约只对 agent 生效、写权限只给人 —— 必须带 actor。
          if (ACTOR_INJECT.has(rel)) {
            parsed.actor = internal === 'agent' ? 'agent' : 'human'
          }
          if (rel === 'run' || rel === 'serial/widget/run') {
            // ★ 组件执行也要区分人/agent：人的按钮 = human，工具调用带内部头 = agent
            //   （面板据 actor 决定谁能停：人的停止/暂停永远优先）。
            parsed.actor = internal === 'agent' ? 'agent' : 'human'
            // ★ §6.2 规则 2 预判拦截：带 onhw 步骤的 run 与常驻串口监视互斥
            //   （服务端只在监视 open/串口写侧查闭环，run 侧不查 —— 宿主提前拦）。
            if (deps.serialMutex?.isActive() === true) {
              const stepsNow = Array.isArray(parsed.steps) ? (parsed.steps as unknown[]).map(String) : []
              if (stepsNow.some((s) => (ONHW_STEPS as readonly string[]).includes(s))) {
                return json(res, 409, {
                  ok: false,
                  error: {
                    code: 'serial-busy',
                    message: '串口监视会话占用中（约束 N5）：先在「串口」通道点「关闭监视」，或等它结束后再发起含烧录/调试的 run',
                  },
                })
              }
            }
          }
          // ★ RunArbiter（§6.2）：同一 rootKey 同时最多 1 个 run；
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
        // 串口监视记账（§6.2 规则 2）：open 成功 → 占用；close → 释放
        if (rel === 'serial/monitor' && deps.serialMutex !== undefined && upstream.ok && typeof init.body === 'string') {
          try {
            const action = (JSON.parse(init.body) as { action?: string }).action
            // ★ 只有 open 占口、close 释放；clear/pause/resume 是会话内操作，
            //   绝不能把互斥标记清掉（否则常驻监视开着也能发起烧录 run）。
            if (action === 'open') deps.serialMutex.setOpen(true)
            else if (action === 'close') deps.serialMutex.setOpen(false)
          } catch {
            /* 解析失败不影响转发 */
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
/**
 * `/elab/debug/events`（exact）—— 调试事件 SSE 字节级透传。
 *
 * ★ 独立于 `/elab/events`：调试事件的信封没有 `run` 字段（§6.4），
 *   硬塞进 run 流会让前端把会话状态错挂到某个 run 上。
 */
export function registerDebugEventsRoute(ctx: HostRouteContext, deps: ProxyDeps): () => void {
  return registerOnce(ctx, {
    kind: 'exact',
    path: '/elab/debug/events',
    handler: async (req, res) => {
      if (ctx.connection?.requestRejection(req) !== undefined) {
        return err(res, 403, 'forbidden', 'forbidden')
      }
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        return err(res, 405, 'method-not-allowed', 'SSE 只接受 GET')
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      let host
      try {
        host = await deps.ensureHost(url.searchParams.get('sessionId') ?? undefined)
      } catch (error) {
        return err(res, 503, 'host-unavailable', error instanceof Error ? error.message : String(error))
      }
      const target = new URL(`${host.baseUrl}/api/debug/events`)
      let aborted = false
      res.on('close', () => {
        aborted = true
      })
      try {
        const upstream = await fetch(target, {
          headers: { Accept: 'text/event-stream' },
          signal: AbortSignal.timeout(30 * 60_000),
        })
        if (!upstream.ok || upstream.body === null) {
          const text = await upstream.text().catch(() => '')
          return err(res, upstream.status || 502, 'upstream-error', text.slice(0, 300))
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        res.socket?.setTimeout(0)
        res.flushHeaders?.()
        const reader = upstream.body.getReader()
        while (!aborted) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(Buffer.from(value))
        }
        try { await reader.cancel() } catch { /* ignore */ }
        if (!aborted) res.end()
      } catch (error) {
        if (!aborted) {
          try {
            err(res, 502, 'sse-failed', error instanceof Error ? error.message : String(error))
          } catch { /* 头已发出 */ }
        }
      }
    },
  })
}

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
