/**
 * pkg 组实现：芯片适配包管理 + 工程接入（adapt）。
 *
 * 红线（不变）：
 *  - install **不** gate `allowAgentWrite`（用户明确要求 agent 能自行安装芯片包）：
 *    安装只写 `packs/installed/`，是"装驱动"级别的操作，不碰硬件、不碰业务工程；
 *  - 内核同一时刻只允许一个包操作（有闭环在跑会 409），失败原因原样带回；
 *  - adapt write=true 落盘 → 受 allowAgentWrite 约束。
 */

import { cockpit, sleep, type ToolsDeps } from './runtime.ts'

/** 包操作 job 的最小投影（内核 `PkgJob`，见 domain/icd.ts）。 */
interface PkgJobLike {
  id: string
  action: string
  name: string
  state: 'queued' | 'running' | 'ok' | 'failed'
  stage: string
  log?: string[]
  error?: string | null
  result?: Record<string, unknown> | null
}

/**
 * 包写操作：`POST /api/pkg/<action>` → 202 + job → 轮询到终态。
 */
async function pkgOp(
  deps: ToolsDeps,
  action: 'install' | 'remove' | 'update',
  body: Record<string, unknown>,
  waitS: number,
): Promise<unknown> {
  const first = await cockpit<PkgJobLike>(deps, `/api/pkg/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let snap = first
  const deadline = Date.now() + Math.max(5, waitS) * 1000
  while ((snap.state === 'queued' || snap.state === 'running') && Date.now() < deadline) {
    await sleep(500)
    snap = await cockpit<PkgJobLike>(deps, `/api/pkg/job?job=${encodeURIComponent(first.id)}`)
  }
  const stillRunning = snap.state === 'queued' || snap.state === 'running'
  return {
    ok: snap.state === 'ok',
    job: snap.id,
    action: snap.action,
    name: snap.name,
    state: snap.state,
    stage: snap.stage,
    ...(snap.error !== null && snap.error !== undefined && snap.error !== '' ? { error: snap.error } : {}),
    log: (snap.log ?? []).slice(-40),
    ...(snap.result !== null && snap.result !== undefined ? { result: snap.result } : {}),
    ...(stillRunning
      ? { waiting: true, note: '仍在后台进行（git clone / 哈希可能较久）；稍后用 action=status 查看结果' }
      : {}),
  }
}

/** 适配包投影 → agent 可读的紧凑摘要（不把整份 status JSON 塞进上下文）。 */
function packsSummary(data: Record<string, unknown>): Record<string, unknown> {
  const installed = Array.isArray(data.installed)
    ? (data.installed as Array<Record<string, unknown>>).filter((p) => p.installed === true)
    : []
  return {
    active: String(data.active ?? ''),
    chips: data.chips ?? [],
    installed: installed.map((p) => ({
      name: String(p.name ?? ''),
      version: p.version ?? null,
      status: String(p.status ?? ''),
      active: p.active === true,
      compatible: p.compatible ?? null,
    })),
    official_source: Array.isArray(data.installed)
      ? (data.installed as Array<Record<string, unknown>>)
          .filter((p) => p.status === 'official' && p.installed !== true)
          .map((p) => String(p.name ?? ''))
      : [],
  }
}

/** 搜索结果 → agent 可读的紧凑卡片。 */
function marketSummary(data: Record<string, unknown>, q: string): Record<string, unknown> {
  const market = (data.market ?? {}) as Record<string, unknown>
  const packs = Array.isArray(market.packs)
    ? (market.packs as Array<Record<string, unknown>>).map((p) => ({
        name: String(p.name ?? ''),
        version: p.version ?? null,
        vendor: p.vendor ?? null,
        platform: p.platform ?? null,
        status: p.status ?? null,
        chips: p.chips ?? [],
        installed: p.installed === true,
        compatible: p.compatible ?? null,
      }))
    : []
  return {
    query: q,
    count: packs.length,
    packs,
    ...(market.error !== null && market.error !== undefined ? { market_error: market.error } : {}),
  }
}

/** 工程接入（adapt）：write=false 只读探测，write=true 落盘（需 allowAgentWrite）。 */
async function pkgAdapt(
  deps: ToolsDeps,
  args: { path?: string; write?: boolean; name?: string },
): Promise<unknown> {
  const write = args.write === true
  if (args.path === undefined || args.path === '') {
    return { ok: false, code: 'missing-path', note: 'action=adapt 需要 path（工程目录绝对路径）' }
  }
  if (write && !deps.allowAgentWrite()) {
    return {
      ok: false,
      code: 'agent-write-disabled',
      nextAction: '适配写盘需要用户在设置里开启 allowAgentWrite；或用 write=false 先看探测报告',
    }
  }
  return cockpit(deps, '/api/adapt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: write ? 'write' : 'probe',
      path: args.path,
      ...(args.name !== undefined ? { name: args.name } : {}),
    }),
  })
}

/** `elab_pkg` 门面的动作分发。 */
export async function pkgAction(
  deps: ToolsDeps,
  action: string,
  args: {
    name?: string
    query?: string
    official?: boolean
    force?: boolean
    wait_s?: number
    path?: string
    write?: boolean
  },
): Promise<unknown> {
  const waitS = Math.min(900, Math.max(5, Math.round(args.wait_s ?? 180)))
  const needName = ['install', 'activate', 'remove'].includes(action)
  if (needName && (args.name === undefined || args.name === '')) {
    return { ok: false, code: 'missing-name', note: '该 action 需要 name（如 st/stm32）' }
  }
  try {
    if (action === 'status') {
      const data = await cockpit<Record<string, unknown>>(deps, '/api/packs?market=0')
      return { ok: true, ...packsSummary(data), roots: data.roots ?? [], install_root: data.install_root ?? '' }
    }
    if (action === 'search') {
      const q = args.query ?? ''
      const qs = new URLSearchParams({ market: '1' })
      if (q !== '') qs.set('q', q)
      const data = await cockpit<Record<string, unknown>>(deps, `/api/packs?${qs.toString()}`)
      return { ok: true, ...marketSummary(data, q) }
    }
    if (action === 'install') {
      return await pkgOp(
        deps,
        'install',
        {
          name: args.name,
          ...(args.official === true ? { official: true } : {}),
          ...(args.force === true ? { force: true } : {}),
        },
        waitS,
      )
    }
    if (action === 'remove') {
      return await pkgOp(deps, 'remove', { name: args.name }, waitS)
    }
    if (action === 'update') {
      return await pkgOp(
        deps,
        'update',
        {
          ...(args.name !== undefined && args.name !== '' ? { name: args.name } : {}),
          ...(args.force === true ? { force: true } : {}),
        },
        waitS,
      )
    }
    if (action === 'verify') {
      return await cockpit<Record<string, unknown>>(deps, '/api/pkg/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(args.name !== undefined && args.name !== '' ? { name: args.name } : {}) }),
      })
    }
    if (action === 'activate') {
      const r = await cockpit<Record<string, unknown>>(deps, '/api/pkg/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: args.name }),
      })
      const packs = (r.packs ?? {}) as Record<string, unknown>
      return {
        ok: true,
        active: r.active ?? args.name,
        skills: r.skills ?? [],
        ...(Object.keys(packs).length > 0 ? { packs: packsSummary(packs) } : {}),
      }
    }
    if (action === 'adapt') {
      return await pkgAdapt(deps, {
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.write !== undefined ? { write: args.write } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
      })
    }
    return {
      ok: false,
      code: 'bad-action',
      note: 'action 必须是 status/search/install/activate/remove/update/verify/adapt',
    }
  } catch (error) {
    return {
      ok: false,
      code: 'pkg-error',
      error: error instanceof Error ? error.message : String(error),
      note: '有闭环在跑时包操作会被 409 拦住；等 run 结束后重试',
    }
  }
}
