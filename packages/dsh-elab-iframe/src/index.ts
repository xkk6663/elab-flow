/**
 * dsh-elab-iframe —— Host 半（P0 探针）。
 *
 * 目标只有一个：**把真实驾驶舱塞进右栏**，让"右栏到底多宽、三列会不会崩、
 * 键盘会不会被抢"这些只能用眼睛和尺子回答的问题，半天内出结论（§8.0）。
 *
 * 与 dsh-elab-cockpit 的关系：**刻意不共用代码**。探针要能独立跑、独立删，
 * 不被主线重构拖累；但它复用同样的三条托管约束（`-u` / UTF-8 / `--port 0`），
 * 因为这些是实测踩出来的硬约束（§14.3），不是设计选择。
 *
 * 暴露：
 *   GET /elab-iframe/url    → { url, port, pid, bootMs, distReady }
 *   GET /elab-iframe/host   → 健康 + 诊断
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'

const execFileAsync = promisify(execFile)

export interface ProbeContext {
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
  logger?: { warn?(msg: string): void; info?(msg: string): void }
  effect(callback: () => () => void, label?: string): void
  get(name: string): unknown
}

export const name = 'dsh-elab-iframe'
export const inject = ['webServer', 'connection']

export interface Config {
  /** elab 仓库根；auto = 由会话 cwd 向上找。 */
  elabRoot?: string
  pythonPath?: string
}

/** elab 仓库根判定：有 cockpit/server.py 与 services/elab。 */
export function looksLikeElabRoot(root: string): boolean {
  if (!isAbsolute(root)) return false
  const r = normalize(root)
  return existsSync(join(r, 'cockpit', 'server.py')) && existsSync(join(r, 'services', 'elab'))
}

function findUpward(from: string, maxUp = 8): string | undefined {
  let cur = normalize(from)
  for (let i = 0; i <= maxUp; i += 1) {
    if (looksLikeElabRoot(cur)) return cur
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return undefined
}

/** 从启动横幅取端口（纯字符串解析，不用正则 —— 见 §15.3 第 5 条）。 */
export function parsePortFromBanner(line: string): number | undefined {
  const at = line.indexOf('监听')
  if (at < 0) return undefined
  const rest = line.slice(at + 2)
  const scheme = rest.indexOf('//')
  if (scheme < 0) return undefined
  const afterScheme = rest.slice(scheme + 2)
  const colon = afterScheme.lastIndexOf(':')
  if (colon < 0) return undefined
  let digits = ''
  for (const ch of afterScheme.slice(colon + 1)) {
    if (ch >= '0' && ch <= '9') digits += ch
    else break
  }
  if (digits === '') return undefined
  const port = Number(digits)
  return port > 0 && port < 65536 ? port : undefined
}

interface ProbeHost {
  port: number
  pid: number
  bootMs: number
  distReady: boolean
  url: string
  child: ChildProcess
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(Buffer.byteLength(text)))
  res.end(text)
}

async function startProbeHost(root: string, python = 'python'): Promise<ProbeHost> {
  const t0 = Date.now()
  const child = spawn(python, ['-u', '-m', 'cockpit.server', '--port', '0'], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: join(root, 'services'),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise<number>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`cockpit 启动超时：${buf.slice(-500)}`)), 20_000)
    const onData = (d: Buffer | string): void => {
      buf += String(d)
      const line = buf.split('\n').find((l) => l.includes('监听'))
      if (line !== undefined) {
        clearTimeout(timer)
        const p = parsePortFromBanner(line)
        if (p === undefined) reject(new Error(`无法解析端口：${line}`))
        else resolve(p)
      }
    }
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 python：${e.message}`))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`cockpit 提前退出 code=${code}：${buf.slice(-500)}`))
    })
  })
  // 就绪探活（横幅先于 serve_forever，见 §15.3 第 2 条）
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${base}/api/capabilities`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) break
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  const dist = join(root, 'cockpit', 'web', 'dist', 'index.html')
  return {
    port,
    pid: child.pid ?? -1,
    bootMs: Date.now() - t0,
    distReady: existsSync(dist),
    url: `${base}/`,
    child,
  }
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch { /* 已退出 */ }
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ } }
}

export function apply(ctx: ProbeContext, config?: Config): () => void {
  let host: ProbeHost | undefined
  let starting: Promise<ProbeHost> | undefined
  const resolveRoot = (): string | undefined => {
    const explicit = config?.elabRoot ?? 'auto'
    if (explicit !== 'auto' && explicit.trim() !== '') {
      return looksLikeElabRoot(explicit.trim()) ? explicit.trim() : undefined
    }
    const cwd = (() => {
      const wd = ctx.workingDirectory?.defaultDirectory
      return typeof wd === 'string' && wd !== '' ? wd : undefined
    })()
    return findUpward(cwd ?? process.cwd())
  }

  // ★ starting 必须在 ensure 之前声明：否则首次调用会命中 TDZ（Cannot access before init）
  const ensure = async (): Promise<ProbeHost> => {
    if (host !== undefined && host.child.exitCode === null) return host
    if (starting !== undefined) return starting
    const root = resolveRoot()
    if (root === undefined) {
      throw new Error('未找到 elab 仓库根（需含 cockpit/server.py 与 services/elab），请在设置里指定 elabRoot')
    }
    starting = startProbeHost(root, config?.pythonPath ?? 'python')
    try {
      host = await starting
      return host
    } finally {
      starting = undefined
    }
  }

  const fence = (req: IncomingMessage): boolean => ctx.connection?.requestRejection(req) === undefined

  const disposers: Array<() => void> = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/elab-iframe/url',
      handler: async (req, res) => {
        if (!fence(req)) return json(res, 403, { ok: false, error: { code: 'forbidden' } })
        try {
          const h = await ensure()
          json(res, 200, { ok: true, url: h.url, port: h.port, pid: h.pid, bootMs: h.bootMs, distReady: h.distReady })
        } catch (e) {
          json(res, 503, { ok: false, error: { code: 'host-unavailable', message: e instanceof Error ? e.message : String(e) } })
        }
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/elab-iframe/host',
      handler: async (req, res) => {
        if (!fence(req)) return json(res, 403, { ok: false, error: { code: 'forbidden' } })
        const root = resolveRoot()
        json(res, 200, {
          ok: true,
          elabRoot: root ?? null,
          running: host !== undefined && host.child.exitCode === null,
          port: host?.port ?? null,
          pid: host?.pid ?? null,
          bootMs: host?.bootMs ?? null,
          distReady: host?.distReady ?? null,
        })
      },
    }),
  )

  const dispose = (): void => {
    for (const d of disposers) {
      try { d() } catch { /* ignore */ }
    }
    const h = host
    host = undefined
    if (h !== undefined) void killTree(h.pid)
  }
  ctx.effect(() => dispose, 'dsh-elab-iframe: probe host lifecycle')
  return dispose
}
