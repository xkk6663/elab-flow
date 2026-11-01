/**
 * Host 半主入口：lazy 启停 cockpit + 注册全部路由 + 定时清理。
 *
 * 与 DSH 的关系：`apply(ctx)` 里用 `ctx.effect()` 登记 disposer，
 * 插件卸载/DSH 退出时 → 关 Job Object → 全树终结（Q16）。
 *
 * ★ 定位（批 2）：本文件是 host 半的**组装单元**（等价第二个组装根，由 main.ts
 *   调用）——它 import 适配器并接线，正如 main.ts 一样；门禁测试对它的
 *   "app 只准 import domain/ports" 规则显式豁免。**编排语义**（发现→适配→发起
 *   →订阅）一律去 app/cockpit-service.ts，不要在这里长业务。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, normalize } from 'node:path'

import { CockpitHost, looksLikeElabRoot } from '../adapters/kernel-process/host-process.ts'
import { probeEnv } from '../adapters/env/probe.ts'
import { cloneKernel, validateBootstrapRequest } from '../adapters/env/bootstrap.ts'
import { envPackStatus, installEnvPack, installedPackEnv } from '../adapters/env/envpack.ts'
import { downloadKernelTag } from '../adapters/env/kernel-download.ts'
import { registerOnce } from '../adapters/kernel-http/route-guard.ts'
import type { RunArbiter } from '../domain/arbiter.ts'
import {
  DEFAULT_HOST_ROUTE_CONFIG,
  registerApiRoute,
  registerEventsRoute,
  type HostRouteConfig,
  type HostRouteContext,
  type ProxyDeps,
} from '../adapters/kernel-http/routes.ts'
import { runRetention } from '../adapters/fs-store/run-retention.ts'
import type { SerialMutexTracker } from '../adapters/kernel-http/routes.ts'

export interface ApplyOptions {
  config?: Partial<HostRouteConfig>
  /** 会话 cwd 解析（决定性：用会话的工作目录找 elab 仓库根）。 */
  resolveCwd?: (sessionId: string | undefined) => string | undefined
  /** run 仲裁（P5）：/elab/api/run 路径上的单飞互斥。 */
  arbiter?: RunArbiter
  /** 串口监视互斥记账（P5 §6.2 规则 2）。 */
  serialMutex?: SerialMutexTracker
  /** 引导向导写根后调用（由 main.ts 注入：热更新 + 持久化 elabRoot）。 */
  onRootPersisted?: (dir: string) => void
}

/** 从起点向上找 elab 仓库根（`cockpit/server.py` + `services/elab`）。 */
function findElabRootUpward(from: string, maxUp = 6): string | undefined {
  let cur = normalize(from)
  for (let i = 0; i <= maxUp; i += 1) {
    if (looksLikeElabRoot(cur)) return cur
    const next = dirname(cur)
    if (next === cur) break
    cur = next
  }
  return undefined
}

/** 设置页热更新控制器：自身仍是 disposer 函数（向后兼容旧调用方）。 */
export type HostController = (() => void) & {
  update(next: Partial<HostRouteConfig>): void
  readonly current: HostRouteConfig
  /** 按需取/启动 cockpit（P5 工具与仲裁的活性检查用）。 */
  ensureHost(sessionId?: string): Promise<{ baseUrl: string; info: { port: number; job: string; bootMs: number } }>
}

export function apply(ctx: HostRouteContext, options: ApplyOptions = {}): HostController {
  const cfg: HostRouteConfig = { ...DEFAULT_HOST_ROUTE_CONFIG, ...(options.config ?? {}) }
  let current = cfg

  let host: CockpitHost | undefined
  let starting: Promise<CockpitHost> | undefined
  let lastUsed = Date.now()

  /** 解析这次该用哪个 elab 仓库根。 */
  function resolveRoot(sessionId?: string): string | undefined {
    const explicit = current.elabRoot
    if (explicit !== 'auto' && explicit.trim() !== '') {
      return looksLikeElabRoot(explicit.trim()) ? explicit.trim() : undefined
    }
    const cwd = options.resolveCwd?.(sessionId)
    if (cwd !== undefined) return findElabRootUpward(cwd)
    return findElabRootUpward(process.cwd())
  }

  /** 根的来源（UI 如实说明"这是你指定的还是自动找到的"）。 */
  function rootSource(sessionId?: string): 'user' | 'auto' | null {
    if (resolveRoot(sessionId) === undefined) return null
    const explicit = current.elabRoot
    return explicit !== 'auto' && explicit.trim() !== '' ? 'user' : 'auto'
  }

  async function ensureHost(sessionId?: string): Promise<{ baseUrl: string; info: { port: number; job: string; bootMs: number } }> {
    lastUsed = Date.now()
    if (host !== undefined) {
      const info = host.info
      if (info.alive()) return { baseUrl: info.baseUrl, info: { port: info.port, job: info.job, bootMs: info.bootMs } }
      // 已死：清理后重启
      await host.dispose().catch(() => undefined)
      host = undefined
    }
    if (starting !== undefined) {
      const h = await starting
      return { baseUrl: h.info.baseUrl, info: { port: h.info.port, job: h.info.job, bootMs: h.info.bootMs } }
    }
    // ★ sessionId 必须参与解析：auto 模式下唯一可靠来源是会话 cwd
    //   （2026-10-26 实测：不带 sessionId 时 DSH 进程 cwd 向上扫不到仓库根）
    const root = resolveRoot(sessionId)
    if (root === undefined) {
      throw new Error(
        '未找到 elab 仓库根（需要同时包含 cockpit/server.py 与 services/elab）。' +
          '请在设置页指定 elabRoot，或在 elab 仓库内的会话里打开面板。',
      )
    }
    // 一键环境包装好的 ELAB_* / PATH（没装 = 不注入，完全走本机既有工具链）
    const packEnvVars = installedPackEnv()
    starting = CockpitHost.start({
      elabRoot: root,
      pythonPath: current.pythonPath,
      ...(packEnvVars !== null ? { toolEnv: packEnvVars } : {}),
    })
    try {
      const h = await starting
      host = h
      return { baseUrl: h.info.baseUrl, info: { port: h.info.port, job: h.info.job, bootMs: h.info.bootMs } }
    } finally {
      starting = undefined
    }
  }

  const deps: ProxyDeps = {
    ensureHost,
    config: () => current,
    ...(options.arbiter !== undefined ? { arbiter: options.arbiter } : {}),
    ...(options.serialMutex !== undefined ? { serialMutex: options.serialMutex } : {}),
  }

  const disposers: Array<() => void> = []
  disposers.push(registerApiRoute(ctx, deps))
  disposers.push(registerEventsRoute(ctx, deps))

  // 健康 / 清理 / 诊断（GET /elab/host）
  disposers.push(
    registerOnce(ctx, {
      kind: 'exact',
      path: '/elab/host',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (ctx.connection?.requestRejection(req) !== undefined) {
          res.statusCode = 403
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: { code: 'forbidden' } }))
          return
        }
        // ★ 带上会话 cwd：客户端用 /elab/host?sessionId=… 触发首次仓库根解析
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const root = resolveRoot(url.searchParams.get('sessionId') ?? undefined)
        const info = host?.info
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(
          JSON.stringify({
            ok: true,
            elabRoot: root ?? null,
            rootSource: rootSource(url.searchParams.get('sessionId') ?? undefined),
            running: info === undefined ? false : info.alive(),
            port: info?.port ?? null,
            pid: info?.pid ?? null,
            job: info?.job ?? null,
            bootMs: info?.bootMs ?? null,
            kernelVersion: info?.kernelVersion ?? null,
            idleKillSec: current.idleKillSec,
            retention: current.retention,
          }),
        )
      },
    }),
  )

  // ── 引导向导：只读环境探测（GET /elab/env）──────────────────────
  disposers.push(
    registerOnce(ctx, {
      kind: 'exact',
      path: '/elab/env',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (ctx.connection?.requestRejection(req) !== undefined) {
          json(res, 403, { ok: false, error: { code: 'forbidden' } })
          return
        }
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          json(res, 405, { ok: false, error: { code: 'method-not-allowed' } })
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const sessionId = url.searchParams.get('sessionId') ?? undefined
          const env = await probeEnv({ pythonPath: current.pythonPath })
          json(res, 200, { ok: true, env, elabRoot: resolveRoot(sessionId) ?? null, rootSource: rootSource(sessionId) })
        } catch (error) {
          json(res, 500, { ok: false, error: { code: 'probe-failed', message: String(error) } })
        }
      },
    }),
  )

  // ── 一键环境包：状态（GET /elab/envpack）─────────────────────────
  //  只读：清单里有什么、当前平台装到第几件。真正安装走 POST /elab/bootstrap。
  disposers.push(
    registerOnce(ctx, {
      kind: 'exact',
      path: '/elab/envpack',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (ctx.connection?.requestRejection(req) !== undefined) {
          json(res, 403, { ok: false, error: { code: 'forbidden' } })
          return
        }
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          json(res, 405, { ok: false, error: { code: 'method-not-allowed' } })
          return
        }
        json(res, 200, { ok: true, status: envPackStatus() })
      },
    }),
  )

  // ── 引导向导：写动作（POST /elab/bootstrap）────────────────────
  //   set-root（校验 + 写配置）/ clone（浅克隆到空目录 + 写配置）/
  //   install-toolchain（官方环境包）/ download-kernel（按 tag 下内核）。
  disposers.push(
    registerOnce(ctx, {
      kind: 'exact',
      path: '/elab/bootstrap',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (ctx.connection?.requestRejection(req) !== undefined) {
          json(res, 403, { ok: false, error: { code: 'forbidden' } })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          json(res, 405, { ok: false, error: { code: 'method-not-allowed' } })
          return
        }
        let body: unknown
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          json(res, 400, { ok: false, error: { code: 'bad-json', message: '请求体不是合法 JSON' } })
          return
        }
        const check = validateBootstrapRequest(body, looksLikeElabRoot)
        if (check.ok === false) {
          json(res, 400, { ok: false, error: { code: check.code, message: check.message } })
          return
        }
        const request = check.request
        if (request.action === 'clone') {
          const cloned = await cloneKernel(request.url, request.dir)
          if (cloned.ok === false) {
            json(res, 502, { ok: false, error: { code: 'clone-failed', message: cloned.error ?? 'git clone 失败' } })
            return
          }
          if (!looksLikeElabRoot(request.dir)) {
            json(res, 422, {
              ok: false,
              error: {
                code: 'not-elab-root',
                message: '克隆完成，但目录不是 elab 仓库根（需同时包含 cockpit/server.py 与 services/elab）',
              },
            })
            return
          }
        }

        // 环境包 / 按版本下内核：写盘发生在固定目录（~/.dsh/elab/**），不接受任意路径
        if (request.action === 'install-toolchain') {
          const installed = await installEnvPack(request.pack)
          if (installed.ok === false) {
            json(res, installed.code === 'no-pack' ? 400 : 502, {
              ok: false,
              error: { code: installed.code, message: installed.message },
            })
            return
          }
          // 新工具要用在**重启后**的 spawn 环境里：丢弃旧进程，下次按需重启
          const oldPack = host
          host = undefined
          void oldPack?.dispose().catch(() => undefined)
          json(res, 200, {
            ok: true,
            action: request.action,
            envPack: {
              packId: installed.packId,
              tools: Object.keys(installed.state.tools).length,
              warnings: installed.warnings,
            },
          })
          return
        }

        if (request.action === 'download-kernel') {
          const dl = await downloadKernelTag(request.version)
          if (dl.ok === false) {
            json(res, 502, { ok: false, error: { code: dl.code, message: dl.message } })
            return
          }
          if (!looksLikeElabRoot(dl.dir)) {
            json(res, 422, {
              ok: false,
              error: {
                code: 'not-elab-root',
                message: `已下载 v${dl.version}，但解出的目录不是 elab 仓库根：${dl.dir}`,
              },
            })
            return
          }
          const old = host
          host = undefined
          void old?.dispose().catch(() => undefined)
          options.onRootPersisted?.(dl.dir)
          json(res, 200, { ok: true, action: request.action, elabRoot: dl.dir })
          return
        }

        // 根已变更 → 丢弃旧进程，下次 ensureHost 按新根起
        const old = host
        host = undefined
        void old?.dispose().catch(() => undefined)
        options.onRootPersisted?.(request.dir)
        json(res, 200, { ok: true, action: request.action, elabRoot: request.dir })
      },
    }),
  )

  // 空闲回收：每分钟看一次，超时且没活动 run 就关掉（下次按需重启，实测 ~300ms）
  const idleTimer = setInterval(() => {
    if (host === undefined) return
    if (Date.now() - lastUsed < current.idleKillSec * 1000) return
    const h = host
    host = undefined
    void h.dispose().catch(() => undefined)
    ctx.logger?.info?.('dsh-elab-cockpit: idle-reaped cockpit host')
  }, 60_000)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()

  // runs 清理：启动 10s 后跑一次，之后每 30 分钟一次
  const retentionOnce = async (): Promise<void> => {
    const root = resolveRoot()
    if (root === undefined) return
    try {
      const result = await runRetention(`${root}/.work/.cockpit/runs`, current.retention, [], [])
      if (result.deleted.length > 0) {
        ctx.logger?.info?.(
          `dsh-elab-cockpit: runs 清理 ${result.deleted.length} 个（保留 ${result.kept}），释放 ${Math.round(result.freedBytes / 1024)}KB`,
        )
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-elab-cockpit: runs 清理失败：${String(error)}`)
    }
  }
  const retentionBoot = setTimeout(() => void retentionOnce(), 10_000)
  if (typeof retentionBoot.unref === 'function') retentionBoot.unref()
  const retentionTimer = setInterval(() => void retentionOnce(), 30 * 60_000)
  if (typeof retentionTimer.unref === 'function') retentionTimer.unref()

  const dispose = (): void => {
    for (const d of disposers) {
      try { d() } catch { /* ignore */ }
    }
    clearInterval(idleTimer)
    clearInterval(retentionTimer)
    clearTimeout(retentionBoot)
    const h = host
    host = undefined
    void h?.dispose().catch(() => undefined)
  }
  ctx.effect(() => dispose, 'dsh-elab-cockpit: host routes + lifecycle')

  // 设置页热更新（P4）：保持“函数即 disposer”的旧返回形状（verify-routes.mjs
  // 与单测都这么用），控制器能力以属性挂载，不破坏既有调用方。
  const controller = dispose as HostController
  controller.update = (next): void => {
    current = { ...current, ...next }
  }
  controller.ensureHost = (sessionId?: string) => ensureHost(sessionId)
  Object.defineProperty(controller, 'current', { get: () => current })

  return controller
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(Buffer.byteLength(text)))
  res.end(text)
}

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

