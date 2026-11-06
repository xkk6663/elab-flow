/**
 * serial 组实现：监视 / 写 / 解码 / 共享解码帧 / 统计 / 读字节 / 等行 / 录制 / 组件。
 *
 * 红线（不变）：
 *  - 串口写、录制、组件发送受 `allowAgentWrite` 门控（默认关，§6.2 规则 6）；
 *  - agent 开的监视带 lease_s 租约，到期自动释放端口（不把串口占死）；
 *  - 读写都走内核会话环，agent 与面板**同源**（人看到的就是 agent 读的那份）。
 */

import type { SerialBytesTail, SerialDecodedTail } from '../../domain/icd.ts'

import { cockpit, sleep, type ToolsDeps } from './runtime.ts'

/** 拉一段字节批次（P1）：agent 读串口的唯一数据面。 */
async function fetchBytes(
  deps: ToolsDeps,
  after: number,
  opts: { direction?: 'all' | 'rx' | 'tx'; limit?: number } = {},
): Promise<SerialBytesTail> {
  const q = new URLSearchParams({ after: String(after) })
  if (opts.direction !== undefined && opts.direction !== 'all') q.set('dir', opts.direction)
  if (opts.limit !== undefined && opts.limit > 0) q.set('limit', String(opts.limit))
  return cockpit<SerialBytesTail>(deps, `/api/serial/monitor/bytes?${q.toString()}`)
}

/** 拉一段会话级共享解码帧（P3.5）：与面板波页同源。 */
async function fetchDecoded(deps: ToolsDeps, after: number): Promise<SerialDecodedTail> {
  return cockpit<SerialDecodedTail>(
    deps,
    `/api/serial/monitor/decoded?after=${Math.max(0, Math.round(after))}`,
  )
}

/** 批次 → agent 可读文本（UTF-8 投影 + 原始 hex 兜底）。 */
function chunkText(dataB64: string): { text: string; hex: string } {
  const bytes = Buffer.from(dataB64, 'base64')
  return {
    text: bytes.toString('utf8'),
    hex: bytes.toString('hex').replace(/([0-9a-f]{2})(?=[0-9a-f])/g, '$1 '),
  }
}

// ── 监视（open/close/decoder/clear/pause/resume）─────────────────────

const MONITOR_OPS = ['open', 'close', 'decoder', 'clear', 'pause', 'resume'] as const

async function serialMonitor(
  deps: ToolsDeps,
  args: {
    op?: string
    project?: string
    port?: string
    baud?: number
    lease_s?: number
    decoder?: string
  },
) {
  const op = args.op ?? ''
  if (!MONITOR_OPS.includes(op as (typeof MONITOR_OPS)[number])) {
    return { ok: false, code: 'bad-op', note: `op 必须是 open/close/decoder/clear/pause/resume：${op}` }
  }
  const body: Record<string, unknown> = { action: op }
  if (op === 'open') {
    body.actor = 'agent'
    if (args.project !== undefined) body.project = args.project
    if (args.port !== undefined) body.port = args.port
    if (args.baud !== undefined) body.baud = args.baud
    body.lease_s = args.lease_s !== undefined ? args.lease_s : 120
    // 写权限随用户设置（默认关）；读不受限。
    body.allow_agent_write = deps.allowAgentWrite()
  }
  if (op === 'decoder') {
    body.actor = 'agent'
    body.decoder = args.decoder ?? ''
  }
  return cockpit(deps, '/api/serial/monitor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── 写（需 allowAgentWrite）────────────────────────────────────────

async function serialWrite(
  deps: ToolsDeps,
  args: {
    project?: string
    data?: string
    baud?: number
    format?: string
    eol?: string
    encoding?: string
    interval_ms?: number
    count?: number
  },
) {
  if (!deps.allowAgentWrite()) {
    return {
      ok: false,
      code: 'agent-write-disabled',
      nextAction: '串口写硬件需要用户在设置里开启 allowAgentWrite；或请用户在面板串口通道手动输入',
    }
  }
  if (args.project === undefined || args.project === '' || args.data === undefined) {
    return { ok: false, code: 'missing-args', note: 'action=write 需要 project 与 data' }
  }
  const loop = args.interval_ms !== undefined
  return cockpit(deps, loop ? '/api/serial/loop' : '/api/serial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: args.project,
      data: args.data,
      ...(args.baud !== undefined ? { baud: args.baud } : {}),
      ...(args.format !== undefined ? { format: args.format } : {}),
      ...(args.eol !== undefined ? { eol: args.eol } : {}),
      ...(args.encoding !== undefined ? { encoding: args.encoding } : {}),
      ...(args.interval_ms !== undefined ? { interval_ms: args.interval_ms } : {}),
      ...(args.count !== undefined ? { count: args.count } : {}),
    }),
  })
}

// ── 解码（无状态）───────────────────────────────────────────────────

async function serialDecode(
  deps: ToolsDeps,
  args: {
    decoder?: string
    project?: string
    profile?: string
    hex?: string
    data_b64?: string
    channels?: number
    apply?: boolean
  },
) {
  if (args.decoder === undefined || args.decoder === '') {
    return { ok: false, code: 'missing-decoder', note: 'action=decode 需要 decoder（justfloat / firewater / profile / profile:<id>）' }
  }
  let draft: Record<string, unknown> | undefined
  if (args.profile !== undefined && args.profile !== '') {
    try {
      draft = JSON.parse(args.profile) as Record<string, unknown>
    } catch {
      return { ok: false, code: 'bad-profile', note: 'profile 必须是合法 JSON 字符串' }
    }
  }
  const payload = {
    decoder: args.decoder,
    ...(args.project !== undefined ? { project: args.project } : {}),
    ...(draft !== undefined ? { profile: draft } : {}),
    ...(args.hex !== undefined ? { hex: args.hex } : {}),
    ...(args.data_b64 !== undefined ? { data_b64: args.data_b64 } : {}),
    ...(args.channels !== undefined ? { channels: args.channels } : {}),
  }
  const result = await cockpit<Record<string, unknown>>(deps, '/api/serial/decode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (args.apply !== true) return result
  if (draft !== undefined && !args.decoder.startsWith('profile:')) {
    return {
      ...result,
      applied: false,
      note: '草稿 profile 未落盘，不能写入会话；先用 elab_frame action=save，再用 decoder=profile:<id>',
    }
  }
  // 落会话：人看到的波形页与本次解码同源（同一 decoder + 同一帧环）
  try {
    const applied = await cockpit<Record<string, unknown>>(deps, '/api/serial/monitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'decoder', actor: 'agent', decoder: args.decoder }),
    })
    return { ...result, applied: true, session: applied }
  } catch (error) {
    return {
      ...result,
      applied: false,
      note: `解码成功但未能落到会话（没有进行中的监视？）：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

// ── 共享解码帧（会话级）────────────────────────────────────────────

async function serialDecoded(deps: ToolsDeps, args: { after?: number; limit?: number }) {
  const after = Math.max(0, Math.round(args.after ?? 0))
  const limit = Math.min(1024, Math.max(1, Math.round(args.limit ?? 200)))
  const tail = await fetchDecoded(deps, after)
  if (tail.active !== true) {
    return {
      ok: false,
      active: false,
      note: '没有进行中的串口监视；先用 elab_serial action=monitor op=open（需要硬件在位）',
    }
  }
  const all = tail.frames ?? []
  const frames = all.slice(-limit)
  return {
    ok: true,
    active: true,
    epoch: tail.epoch,
    decoder: tail.decoder,
    decoder_by: tail.decoder_by,
    channels: tail.channels,
    total_frames: tail.total_frames,
    skipped: tail.skipped,
    pending_bytes: tail.pending_bytes,
    covered: tail.covered,
    error: tail.error ?? null,
    next_after: all.length > 0 ? all[all.length - 1].seq : after,
    gap: tail.gap ?? 0,
    frames,
  }
}

// ── 帧级统计 ───────────────────────────────────────────────────────

async function serialStats(deps: ToolsDeps, args: { window_s?: number }) {
  const w = args.window_s === undefined ? 10 : args.window_s
  return await cockpit(deps, `/api/serial/monitor/stats?window_s=${w}`)
}

// ── 读字节 / 等匹配行（高频快捷入口的实现）──────────────────────────

export async function serialRead(deps: ToolsDeps, args: { after?: number; direction?: string; limit?: number }) {
  const after = Math.max(0, Math.round(args.after ?? 0))
  const direction = (args.direction ?? 'all') as 'all' | 'rx' | 'tx'
  const limit = Math.min(4096, Math.max(1, Math.round(args.limit ?? 500)))
  const tail = await fetchBytes(deps, after, { direction, limit })
  if (tail.active !== true) {
    return {
      ok: false,
      active: false,
      note: '没有进行中的串口监视；先用 elab_serial action=monitor op=open（需要硬件在位）',
    }
  }
  const chunks = (tail.chunks ?? []).map((c) => {
    const { text, hex } = chunkText(c.data_b64)
    return { seq: c.seq, dir: c.dir, t: c.t, len: c.len, text, hex }
  })
  return {
    ok: true,
    active: true,
    epoch: tail.epoch,
    next_after: chunks.length > 0 ? chunks[chunks.length - 1].seq : after,
    gap: tail.gap ?? 0,
    paused: tail.paused === true,
    error: tail.error ?? null,
    chunks,
  }
}

export async function serialWait(
  deps: ToolsDeps,
  args: { pattern?: string; after?: number; direction?: string; timeout_ms?: number; poll_ms?: number },
) {
  if (args.pattern === undefined || args.pattern === '') {
    return { ok: false, code: 'missing-pattern', note: 'action=wait 需要 pattern（正则表达式）' }
  }
  let re: RegExp
  try {
    re = new RegExp(args.pattern)
  } catch (error) {
    return { ok: false, code: 'bad-pattern', note: error instanceof Error ? error.message : String(error) }
  }
  const direction = (args.direction ?? 'rx') as 'all' | 'rx' | 'tx'
  const timeout = Math.min(60000, Math.max(100, Math.round(args.timeout_ms ?? 5000)))
  const poll = Math.min(2000, Math.max(50, Math.round(args.poll_ms ?? 150)))
  const start = Math.max(0, Math.round(args.after ?? 0))
  const deadline = Date.now() + timeout
  let cursor = start
  const collected: Array<{ seq: number; dir: string; t: string; text: string }> = []
  let carried = ''
  while (Date.now() < deadline) {
    const tail = await fetchBytes(deps, cursor, { direction, limit: 500 })
    if (tail.active !== true) {
      return {
        ok: false,
        active: false,
        note: '串口监视会话不存在或已结束；先用 elab_serial action=monitor op=open（需要硬件在位）',
      }
    }
    for (const c of tail.chunks ?? []) {
      const { text } = chunkText(c.data_b64)
      collected.push({ seq: c.seq, dir: c.dir, t: c.t, text })
      cursor = c.seq
      if (re.test(text) || re.test(carried + text)) {
        return {
          ok: true,
          matched: true,
          pattern: args.pattern,
          after: start,
          next_after: cursor,
          chunks: collected.slice(-32),
        }
      }
      carried = (carried + text).slice(-512)
    }
    await sleep(poll)
  }
  return {
    ok: false,
    matched: false,
    timeout: true,
    pattern: args.pattern,
    next_after: cursor,
    chunks: collected.slice(-32),
  }
}

// ── 录制（证据，可回放）────────────────────────────────────────────

export async function serialCapture(
  deps: ToolsDeps,
  args: { action?: string; project?: string; max_bytes?: number; trigger?: string; pre_bytes?: number },
) {
  const action = args.action ?? ''
  if (action !== 'status' && !deps.allowAgentWrite()) {
    return {
      ok: false,
      code: 'agent-write-disabled',
      nextAction: '录制会写盘，需要用户在设置里开启 allowAgentWrite；只用 status 可查看当前是否在录',
    }
  }
  let trigger: Record<string, unknown> | undefined
  if (args.trigger !== undefined && args.trigger !== '') {
    try {
      trigger = JSON.parse(args.trigger) as Record<string, unknown>
    } catch {
      return { ok: false, code: 'bad-json', note: 'trigger 必须是合法 JSON 字符串' }
    }
  }
  return cockpit(deps, '/api/serial/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      ...(args.project !== undefined ? { project: args.project } : {}),
      ...(args.max_bytes !== undefined ? { max_bytes: args.max_bytes } : {}),
      ...(trigger !== undefined ? { trigger } : {}),
      ...(args.pre_bytes !== undefined ? { pre_bytes: args.pre_bytes } : {}),
    }),
  })
}

// ── 自定义发送组件（定时/循环发）───────────────────────────────────

export async function serialWidget(
  deps: ToolsDeps,
  args: {
    action?: string
    project?: string
    id?: string
    params?: string
    repeat?: boolean
    confirm?: boolean
    job_id?: string
    widget?: string
    rev?: number
  },
) {
  const action = args.action ?? ''
  const project = args.project ?? ''
  const needProject = ['list', 'preview', 'run', 'save', 'delete'].includes(action)
  if (needProject && project === '') {
    return { ok: false, code: 'missing-project', note: '该 action 需要 project（工程名）' }
  }
  if (['run', 'save', 'delete'].includes(action) && !deps.allowAgentWrite()) {
    return {
      ok: false,
      code: 'agent-write-disabled',
      nextAction: '组件发送/改配置会写硬件或工程文件，需要用户在设置里开启 allowAgentWrite；'
        + '只读请用 action=list / preview / status',
    }
  }
  let params: Record<string, unknown> | undefined
  if (args.params !== undefined && args.params.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(args.params)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>
      } else {
        return { ok: false, code: 'bad-params', note: 'params 必须是 JSON 对象（如 {"n":3}）' }
      }
    } catch {
      return { ok: false, code: 'bad-params', note: 'params 不是合法 JSON' }
    }
  }
  try {
    if (action === 'list') {
      return await cockpit(deps, `/api/serial/widgets?project=${encodeURIComponent(project)}`)
    }
    if (action === 'status') {
      const q = args.job_id !== undefined && args.job_id !== '' ? `?id=${encodeURIComponent(args.job_id)}` : ''
      return await cockpit(deps, `/api/serial/widget/job${q}`)
    }
    if (action === 'preview') {
      return await cockpit(deps, '/api/serial/widget/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project, id: args.id ?? '',
          ...(params !== undefined ? { params } : {}),
          dry_run: true,
        }),
      })
    }
    if (action === 'run') {
      return await cockpit(deps, '/api/serial/widget/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-elab-actor': 'agent' },
        body: JSON.stringify({
          project, id: args.id ?? '',
          ...(params !== undefined ? { params } : {}),
          ...(args.repeat === true ? { repeat: true } : {}),
          ...(args.confirm === true ? { confirm: true } : {}),
          actor: 'agent',
        }),
      })
    }
    if (action === 'cancel' || action === 'pause' || action === 'resume') {
      let jobId = args.job_id ?? ''
      if (jobId === '') {
        const cur = await cockpit<{ job_id?: string; state?: string }>(deps, '/api/serial/widget/job')
        jobId = cur.job_id ?? ''
        if (jobId === '') return { ok: false, note: '当前没有组件任务' }
      }
      const path = action === 'cancel' ? '/api/serial/widget/cancel' : '/api/serial/widget/pause'
      const body = action === 'cancel' ? { id: jobId } : { id: jobId, paused: action === 'pause' }
      return await cockpit(deps, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    if (action === 'save') {
      if (args.widget === undefined || args.widget === '') {
        return { ok: false, code: 'missing-widget', note: 'save 需要 widget（组件定义 JSON）' }
      }
      return await cockpit(deps, '/api/serial/widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save', project, rev: args.rev ?? 0,
          widget: JSON.parse(args.widget) as unknown,
        }),
      })
    }
    if (action === 'delete') {
      return await cockpit(deps, '/api/serial/widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', project, rev: args.rev ?? 0, id: args.id ?? '' }),
      })
    }
    return { ok: false, code: 'unknown-action', note: `未知 action：${action}` }
  } catch (error) {
    return {
      ok: false,
      code: 'widget-request-failed',
      note: error instanceof Error ? error.message : String(error),
      nextAction: action === 'save' || action === 'delete'
        ? 'rev 冲突或组件不合法：先 action=list 重读，再按最新 rev 重试'
        : undefined,
    }
  }
}

/**
 * `elab_serial` 门面的动作分发（monitor 的子动作在 `op`）。
 */
export async function serialAction(
  deps: ToolsDeps,
  action: string,
  args: {
    project?: string
    port?: string
    baud?: number
    lease_s?: number
    op?: string
    decoder?: string
    after?: number
    direction?: string
    limit?: number
    pattern?: string
    timeout_ms?: number
    poll_ms?: number
    data?: string
    format?: string
    eol?: string
    encoding?: string
    interval_ms?: number
    count?: number
    window_s?: number
  },
): Promise<unknown> {
  switch (action) {
    case 'monitor':
      return serialMonitor(deps, args)
    case 'write':
      return serialWrite(deps, args)
    case 'decode':
      return serialDecode(deps, args)
    case 'decoded':
      return serialDecoded(deps, args)
    case 'stats':
      return serialStats(deps, args)
    case 'read':
      return serialRead(deps, args)
    case 'wait':
      return serialWait(deps, args)
    case '':
      // 兼容旧版直写用法：elab_serial(project, data) —— action 缺省且带 data → write
      if (args.data !== undefined) return serialWrite(deps, args)
      return {
        ok: false,
        code: 'missing-action',
        note: 'action 必须是 monitor/write/decode/decoded/stats/read/wait（带 data 时可省略，缺省=write）',
      }
    default:
      return {
        ok: false,
        code: 'bad-action',
        note: `action 必须是 monitor/write/decode/decoded/stats/read/wait：${action}`,
      }
  }
}
