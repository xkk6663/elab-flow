/**
 * Host 半 —— `/elab/api/discover`：把"打开一个仓库就看到可一键接入的工程"变成一次 GET。
 *
 * 分层（与 §13 的结论一致）：
 *   本文件只做**接线与边界**（路由 / 鉴权 fence / 会话 cwd 解析 / 缓存 / YAML 读取），
 *   扫描算法在 `discovery.ts`（纯函数、可注入 fs、有 11 条单测）。
 *
 * 三条硬约束（来自调研）：
 *   ① 每条路由先过 `ctx.connection.requestRejection(req)`（照 better-sidebar 的 fence）；
 *   ② 启动 **不 spawn Python**：发现是纯文件系统扫描（实测本仓库 65 目录 / ~50ms）；
 *   ③ 绝不写盘：写仍走 Python 的 `POST /api/adapt`（六道保护在那里）。
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { registerOnce } from './route-guard.ts'
import { parse as parseYaml } from 'yaml'

import {
  discoverProjects,
  DEFAULT_LIMIT,
  DEFAULT_MAX_DEPTH,
  normalizePath,
  type AdaptedEntry,
  type DiscoverResult,
} from './discovery.ts'

/** 本插件需要的 Host 服务面（结构化声明，不 import 宿主类型）。 */
export interface HostContext {
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

export interface DiscoverConfig {
  /** elab 仓库根（含 `cockpit/server.py` 与 `services/elab`）。`auto` = 由会话 cwd 向上找。 */
  elabRoot: string
  maxDepth: number
  limit: number
  /** 缓存 TTL（毫秒）；0 表示不缓存。 */
  cacheTtlMs: number
  /**
   * 根判据（唯一真源 = kernel-process 的 `looksLikeElabRoot`，由 main.ts 注入）。
   * 缺省仅供单测使用，判据与宿主完全一致。
   */
  isElabRoot?: (dir: string) => boolean
}

export const DEFAULT_CONFIG: DiscoverConfig = {
  elabRoot: 'auto',
  maxDepth: DEFAULT_MAX_DEPTH,
  limit: DEFAULT_LIMIT,
  cacheTtlMs: 30_000,
}

/** 与宿主半 `looksLikeElabRoot` 同一判据（生产接线由 main.ts 注入宿主实现）。 */
export function isElabRootDefault(dir: string): boolean {
  return existsSync(join(dir, 'cockpit', 'server.py')) && existsSync(join(dir, 'services', 'elab'))
}

/** 扫描起点解析结果：root + 来源（用于 UI 如实说明"在哪儿扫的"）。 */
export interface ScanRoot {
  path: string
  source: 'session' | 'elabRoot' | 'home'
}

/**
 * 解析会话 cwd —— 与 better-sidebar 的 `sessionCwdOf` 同源的降级链，
 * 但**不做查询与持久化读取**：发现接口是低延迟的，宁可降级也不阻塞。
 */
export function resolveSessionCwd(
  ctx: HostContext,
  sessionId: string | undefined,
): string | undefined {
  if (sessionId === undefined || sessionId === '') return undefined
  // ★ cordis 的 ctx 是代理：直接读未 inject 的服务属性会抛
  //   （"cannot get property … without inject" → webserver 派发层兜底 400）。
  //   一律走 ctx.get()：服务缺席时返回 undefined 而不是炸（better-sidebar 同款）。
  const sessions = ctx.get('sessions') as HostContext['sessions']
  const workingDirectory = ctx.get('workingDirectory') as HostContext['workingDirectory']
  const session = sessions?.get(sessionId)
  const fromWorkingDirectory = session !== undefined ? workingDirectory?.get(session) : undefined
  if (isUsableDir(fromWorkingDirectory)) return fromWorkingDirectory
  if (isUsableDir(session?.header?.cwd)) return session?.header?.cwd
  if (isUsableDir(workingDirectory?.defaultDirectory)) return workingDirectory?.defaultDirectory
  return undefined
}

function isUsableDir(p: string | undefined): p is string {
  return p !== undefined && p !== '' && isAbsolute(p)
}

/**
 * 从起点向上找 elab 仓库根。
 * ★ 判据与宿主半统一（`cockpit/server.py` + `services/elab`）—— 不再另立
 *   "projects/ + elab.host.yaml" 的第二套标准（方案 B1）。
 */
export async function findElabRoot(
  from: string,
  maxUp = 6,
  isElabRoot: (dir: string) => boolean = isElabRootDefault,
): Promise<string | undefined> {
  let cur = resolve(from)
  for (let i = 0; i <= maxUp; i += 1) {
    if (isElabRoot(cur)) return normalizePath(cur)
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return undefined
}

/**
 * 读取 `projects/*.yaml` 的 `root` 字段，归一化成已接入工程表。
 *
 * ★ 只做**最小 YAML 读取**（`root` 一个字段），不引 elab 的 Config：
 *   插件不该复制 elab 的配置解析（那会漂移），只需要"哪些目录已接入"。
 *
 * ★ `${ELAB_ROOT}` 必须实测求值：本仓库**全部** projects/*.yaml 都用
 *   `${ELAB_ROOT}/examples/...` 写法（`adapt` 生成时优先写相对仓库根的表达式）。
 *   早期版本把含 `${` 的条目直接跳过，实测导致 adaptedCount 恒为 0、
 *   "已接入"标记形同虚设。这里只支持 `${ELAB_ROOT}`/`${ROOT}` 两个变量
 *   （elab 配置里的确只用这两个表达根），其余未识别变量才跳过。
 */
export async function readAdaptedProjects(elabRoot: string): Promise<AdaptedEntry[]> {
  const projectsDir = join(elabRoot, 'projects')
  let names: string[]
  try {
    names = (await readdir(projectsDir)).filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'))
  } catch {
    return []
  }
  const out: AdaptedEntry[] = []
  for (const n of names) {
    const abs = join(projectsDir, n)
    try {
      const doc = parseYaml(await readFile(abs, 'utf8')) as { root?: unknown } | null
      const raw = typeof doc?.root === 'string' ? doc.root.trim() : ''
      const expanded = expandRootExpr(raw, elabRoot)
      if (expanded === undefined) continue
      const abs2 = isAbsolute(expanded) ? expanded : resolve(elabRoot, expanded)
      out.push({ name: n.replace(/\.(yaml|yml)$/, ''), root: normalizePath(abs2) })
    } catch {
      // 单文件解析失败不影响其余工程
    }
  }
  return out
}

/**
 * 展开 `root:` 里的路径表达式。
 * 返回 undefined = 无法求值（含未识别变量），调用方跳过该条目。
 */
export function expandRootExpr(raw: string, elabRoot: string): string | undefined {
  if (raw === '') return undefined
  // 只认这两个变量；其余 ${...} 视为未识别 → 放弃（宁可少标一个，也不标错）
  const leftover = raw.replace(/\$\{(ELAB_ROOT|ROOT)\}/g, '')
  if (leftover.includes('${')) return undefined
  const expanded = raw.replace(/\$\{(ELAB_ROOT|ROOT)\}/g, elabRoot.replace(/\\/g, '/'))
  return normalizePath(expanded)
}

interface CacheEntry {
  at: number
  /** 缓存键：起点 + 参数 */
  key: string
  result: DiscoverResult
  adapted: AdaptedEntry[]
  elabRoot?: string
}

/** 挂在 fiber 上的扫描器（缓存 + 并发合并）。 */
export function createDiscoverService(ctx: HostContext, cfg: () => DiscoverConfig) {
  let cache: CacheEntry | undefined
  let inflight: Promise<DiscoverResult> | undefined

  const cfgNow = (): DiscoverConfig => ({ ...DEFAULT_CONFIG, ...cfg() })

  /** 解析这次该扫哪里。
   *
   * ★ **会话工作区优先**：面板要探测的是"用户当前打开的那个工程"，不是内核仓本身。
   *   两者是不同概念——`elabRoot` 只负责启动内核、读 `projects/*.yaml`（见
   *   `resolveAdapted`），不该决定"扫哪里"。否则显式配好内核仓后，在任意
   *   STM32 工程工作区开会话，扫描根都会退化成内核仓，工作区工程永远发现不了。
   */
  async function resolveRoot(sessionId: string | undefined): Promise<ScanRoot> {
    const c = cfgNow()
    const sessionCwd = resolveSessionCwd(ctx, sessionId)
    if (sessionCwd !== undefined) return { path: normalizePath(sessionCwd), source: 'session' }
    if (c.elabRoot !== 'auto' && c.elabRoot.trim() !== '') {
      return { path: normalizePath(c.elabRoot.trim()), source: 'elabRoot' }
    }
    const found = await findElabRoot(process.cwd(), 6, c.isElabRoot)
    if (found !== undefined) return { path: found, source: 'elabRoot' }
    return { path: normalizePath(homedir()), source: 'home' }
  }

  /** 已接入表：优先从 elabRoot 的 projects/ 读；找不到 elabRoot 就空表。 */
  async function resolveAdapted(root: ScanRoot): Promise<{ elabRoot?: string; adapted: AdaptedEntry[] }> {
    const c = cfgNow()
    const explicit = c.elabRoot !== 'auto' && c.elabRoot.trim() !== '' ? c.elabRoot.trim() : undefined
    const elabRoot = explicit !== undefined ? normalizePath(explicit) : await findElabRoot(root.path, 6, c.isElabRoot)
    if (elabRoot === undefined) return { adapted: [] }
    return { elabRoot, adapted: await readAdaptedProjects(elabRoot) }
  }

  return {
    /** 执行一次（或命中缓存的）扫描。 */
    async discover(sessionId: string | undefined, opts?: { refresh?: boolean }): Promise<{
      root: ScanRoot
      elabRoot?: string
      adaptedCount: number
      result: DiscoverResult
      cached: boolean
    }> {
      const c = cfgNow()
      const root = await resolveRoot(sessionId)
      const key = `${root.path}|d${c.maxDepth}|l${c.limit}`
      const now = Date.now()
      if (
        opts?.refresh !== true &&
        c.cacheTtlMs > 0 &&
        cache !== undefined &&
        cache.key === key &&
        now - cache.at < c.cacheTtlMs
      ) {
        return {
          root,
          elabRoot: cache.elabRoot,
          adaptedCount: cache.adapted.length,
          result: cache.result,
          cached: true,
        }
      }
      if (inflight !== undefined) {
        // 并发合并：同一时刻只跑一次扫描（等待者拿同一份结果）
        const result = await inflight
        return {
          root,
          elabRoot: cache?.elabRoot,
          adaptedCount: cache?.adapted.length ?? 0,
          result,
          cached: true,
        }
      }
      const task = (async () => {
        const { elabRoot, adapted } = await resolveAdapted(root)
        const result = await discoverProjects({
          root: root.path,
          maxDepth: c.maxDepth,
          limit: c.limit,
          adapted,
        })
        cache = { at: Date.now(), key, result, adapted, elabRoot }
        return result
      })()
      inflight = task
      try {
        const result = await task
        return {
          root,
          elabRoot: cache?.elabRoot,
          adaptedCount: cache?.adapted.length ?? 0,
          result,
          cached: false,
        }
      } finally {
        inflight = undefined
      }
    },
  }
}

// ── HTTP 接线 ──────────────────────────────────────────────────────

function writeJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2)
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(Buffer.byteLength(text)))
  res.end(text)
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * 注册 `/elab/api/discover`。
 *
 * 只接受 GET（发现是纯读操作，动词即契约 —— 与 `/api/plan` 走 GET 是同一条纪律）。
 * 查询参数：`sessionId`（用于解析 cwd）、`refresh=1`（跳过缓存）。
 */
export function registerDiscoverRoute(
  ctx: HostContext,
  service: ReturnType<typeof createDiscoverService>,
): () => void {
  // 幂等注册：重装/HMR 时新旧 fiber 并存不撞 duplicate route
  return registerOnce(ctx, {
    kind: 'exact',
    path: '/elab/api/discover',
    handler: async (req, res) => {
      // ① 鉴权 fence：与宿主 /api 网关同一套准入
      if (ctx.connection !== undefined && ctx.connection.requestRejection(req) !== undefined) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '用 GET' } })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        if (sessionId !== undefined && !ID_RE.test(sessionId)) {
          writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId 非法' } })
          return
        }
        const refresh = url.searchParams.get('refresh') === '1'
        const out = await service.discover(sessionId, { refresh })
        // ★ 响应形状：`scanRoot: {path, source}` 与发现结果分开命名。
        //   曾用 `root` 同时表示"扫描起点对象"和"结果里的 root 字符串"，
        //   展开 `...out.result` 时后者覆盖前者 —— 字段名必须互斥。
        writeJson(res, 200, {
          ok: true,
          scanRoot: out.root,
          elabRoot: out.elabRoot,
          adaptedCount: out.adaptedCount,
          cached: out.cached,
          candidates: out.result.candidates,
          maxDepth: out.result.maxDepth,
          truncated: out.result.truncated,
          dirsVisited: out.result.dirsVisited,
          elapsedMs: out.result.elapsedMs,
          root: out.result.root,
        })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-elab-cockpit: /elab/api/discover 失败：${String(error)}`)
        writeJson(res, 500, {
          ok: false,
          error: { code: 'discover-failed', message: error instanceof Error ? error.message : String(error) },
        })
      }
    },
  })
}

/** Host 半入口：由 index.ts 调用。 */
export function applyDiscover(ctx: HostContext, config?: Partial<DiscoverConfig>): () => void {
  const merged: DiscoverConfig = { ...DEFAULT_CONFIG, ...config }
  let current: DiscoverConfig = merged
  const service = createDiscoverService(ctx, () => current)
  const dispose = registerDiscoverRoute(ctx, service)
  // 配置热更新入口（设置页改 elabRoot 时调用；不重启即生效）
  ;(applyDiscover as unknown as { update?: (next: Partial<DiscoverConfig>) => void }).update = (next) => {
    current = { ...current, ...next }
  }
  return dispose
}
