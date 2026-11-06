/**
 * debug 组实现：开会话 / 驱动执行 / 读数据 / 管断点 / 等停止 / 关会话。
 *
 * 红线（不变）：
 *  - 同一时刻只允许一个调试会话（一个 SWD 目标只能被一个 GDB 附着）；
 *  - agent 开的会话带租约（默认 600s），到期自动关闭并**恢复运行**；
 *  - close 默认复位并恢复运行（resume=false 才留在 halt，仅排障用）；
 *  - 用户与 agent 看到同一份调用栈/寄存器（人机同源）。
 */

import { AGENT_JSON, cockpit, sleep, type ToolsDeps } from './runtime.ts'

/** 调试会话快照（agent 与面板同一份；不含 MI 原始噪声）。 */
async function debugSession(deps: ToolsDeps): Promise<Record<string, unknown>> {
  return cockpit<Record<string, unknown>>(deps, '/api/debug/session')
}

/** 打开调试会话（actor=agent → 租约到点自动关闭并恢复运行）。 */
async function debugOpen(
  deps: ToolsDeps,
  args: { project?: string; stop_at?: 'main' | 'reset' | 'none'; load?: boolean; lease_s?: number },
): Promise<unknown> {
  if (args.project === undefined || args.project === '') {
    throw new Error('需要 project（用 elab_status 查看工程名）')
  }
  const r = await cockpit<{ session?: Record<string, unknown> }>(deps, '/api/debug/session', {
    method: 'POST',
    headers: AGENT_JSON,
    body: JSON.stringify({
      project: args.project,
      options: {
        ...(args.stop_at !== undefined ? { stop_at: args.stop_at } : {}),
        ...(args.load !== undefined ? { load: args.load } : {}),
      },
      ...(args.lease_s !== undefined ? { lease_s: args.lease_s } : {}),
    }),
  })
  return {
    ok: true,
    session: r.session ?? null,
    note: '面板会在新会话时自动切到调试视图；用户与你看到同一份调用栈/寄存器（人机同源）',
  }
}

/** 等下一个 stop（stop_seq 严格递增；避免与旧事件混淆）。 */
async function waitForStop(
  deps: ToolsDeps,
  afterSeq: number,
  timeoutMs: number,
): Promise<{ stop?: Record<string, unknown> | null; stop_seq?: number; timedOut?: boolean; note?: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snap = await debugSession(deps)
    const s = snap.session as Record<string, unknown> | null
    if (s === null) return { stop: null, note: '会话已关闭' }
    const state = String(s.state ?? '')
    const stop = s.stop as Record<string, unknown> | null
    const stopSeq = Number(stop?.seq ?? 0)
    if (state === 'error') return { stop, stop_seq: stopSeq, note: '调试会话进入 error' }
    if (state === 'stopped' && stopSeq > afterSeq) return { stop, stop_seq: stopSeq }
    await sleep(400)
  }
  return { timedOut: true, note: '等待 stop 超时；用 elab_debug_inspect 看当前状态' }
}

/** 控制：continue/pause/step_over/step_in/step_out/stepi/reset/restart/run_to。 */
async function debugControl(
  deps: ToolsDeps,
  args: { op?: string; addr?: string; confirm?: boolean; wait_s?: number },
): Promise<unknown> {
  const action = args.op ?? ''
  if (action === '') {
    return { ok: false, code: 'bad-op', note: 'op 必须是 continue/pause/step_over/step_in/step_out/stepi/reset/restart/run_to' }
  }
  const before = await debugSession(deps)
  const seq = Number(((before.session as Record<string, unknown> | null)?.stop as Record<string, unknown> | null)?.seq ?? 0)
  const r = await cockpit<Record<string, unknown>>(deps, '/api/debug/control', {
    method: 'POST',
    headers: AGENT_JSON,
    body: JSON.stringify({
      action,
      ...(args.addr !== undefined ? { addr: args.addr } : {}),
      ...(args.confirm === true ? { confirm: true } : {}),
    }),
  })
  // 单步/运行到地址是"命令返回后还要等 *stopped"：内核已等了 15s，这里再兜一层
  if (['step_over', 'step_in', 'step_out', 'stepi', 'run_to'].includes(action)) {
    const waited = await waitForStop(deps, seq, Math.min(20_000, Math.max(1_000, (args.wait_s ?? 8) * 1000)))
    return { ok: true, ...r, ...waited }
  }
  return { ok: true, ...r }
}

/** 只读 inspect：session/stack/variables/registers/breakpoints/memory/disasm/evaluate。 */
export async function debugInspect(
  deps: ToolsDeps,
  args: {
    what?: string
    frame?: number
    scope?: 'locals' | 'args' | 'children'
    var?: string
    thread?: number
    group?: string
    format?: 'natural' | 'hex'
    addr?: string
    count?: number
    expr?: string
  },
): Promise<unknown> {
  const q = (kv: Record<string, string | number | undefined>): string => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(kv)) if (v !== undefined) p.set(k, String(v))
    const s = p.toString()
    return s === '' ? '' : `?${s}`
  }
  switch (args.what) {
    case 'session':
      return debugSession(deps)
    case 'stack':
      return cockpit(deps, `/api/debug/stack${q({ thread: args.thread })}`)
    case 'variables':
      return cockpit(deps, `/api/debug/variables${q({ frame: args.frame ?? 0, scope: args.scope ?? 'locals', var: args.var })}`)
    case 'registers':
      return cockpit(deps, `/api/debug/registers${q({ group: args.group ?? 'core', format: args.format ?? 'natural' })}`)
    case 'breakpoints':
      return cockpit(deps, '/api/debug/breakpoints')
    case 'memory': {
      if (args.addr === undefined || args.addr === '') throw new Error('memory 需要 addr')
      return cockpit(deps, `/api/debug/memory${q({ addr: args.addr, count: args.count ?? 64 })}`)
    }
    case 'disasm':
      return cockpit(deps, `/api/debug/disasm${q({ addr: args.addr, count: args.count ?? 16, mode: 2 })}`)
    case 'evaluate': {
      if (args.expr === undefined || args.expr === '') throw new Error('evaluate 需要 expr')
      return cockpit(deps, '/api/debug/evaluate', {
        method: 'POST',
        headers: AGENT_JSON,
        body: JSON.stringify({ expr: args.expr, ...(args.frame !== undefined ? { frame: args.frame } : {}) }),
      })
    }
    default:
      return {
        ok: false,
        code: 'bad-inspect',
        note: 'what 必须是 session/stack/variables/registers/breakpoints/memory/disasm/evaluate',
      }
  }
}

/** 断点：list/add/update/toggle/remove（函数/地址；条件断点走 update）。 */
async function debugBreakpoint(
  deps: ToolsDeps,
  args: {
    op?: string
    id?: string
    kind?: 'func' | 'addr'
    location?: string
    condition?: string
    enabled?: boolean
    hardware?: boolean
  },
): Promise<unknown> {
  const op = args.op ?? ''
  if (op === 'list' || op === '') return cockpit(deps, '/api/debug/breakpoints')
  if (!['add', 'update', 'toggle', 'remove'].includes(op)) {
    return { ok: false, code: 'bad-op', note: 'op 必须是 list/add/update/toggle/remove' }
  }
  return cockpit(deps, '/api/debug/breakpoints', {
    method: 'POST',
    headers: AGENT_JSON,
    body: JSON.stringify({
      op,
      ...(args.id !== undefined ? { id: args.id } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.location !== undefined ? { location: args.location } : {}),
      ...(args.condition !== undefined ? { condition: args.condition } : {}),
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      ...(args.hardware === true ? { hardware: true } : {}),
    }),
  })
}

/** 关闭会话：默认 resume=true（monitor reset run），绝不把板子留在 halt。 */
async function debugClose(deps: ToolsDeps, args: { resume?: boolean }): Promise<unknown> {
  const r = await cockpit<Record<string, unknown>>(deps, '/api/debug/session', {
    method: 'DELETE',
    headers: AGENT_JSON,
    body: JSON.stringify({ resume: args.resume !== false, reason: 'agent-closed' }),
  })
  return {
    ok: true,
    ...r,
    note: r.resumed === true
      ? '目标已恢复运行（心跳/串口闭环可以继续）'
      : '目标未恢复运行（resume=false 或恢复命令失败）；如需心跳请重新上电或再开一次会话后正常关闭',
  }
}

/**
 * `elab_debug` 门面的动作分发。
 * 子动作：control/breakpoint 用 `op`，inspect 用 `what`。
 */
export async function debugAction(
  deps: ToolsDeps,
  action: string,
  args: {
    project?: string
    stop_at?: string
    load?: boolean
    lease_s?: number
    op?: string
    what?: string
    addr?: string
    confirm?: boolean
    wait_s?: number
    frame?: number
    scope?: string
    var?: string
    thread?: number
    group?: string
    format?: string
    count?: number
    expr?: string
    id?: string
    kind?: string
    location?: string
    condition?: string
    enabled?: boolean
    hardware?: boolean
    after_seq?: number
    timeout_s?: number
    resume?: boolean
  },
): Promise<unknown> {
  switch (action) {
    case 'open': {
      const stopAt = ['main', 'reset', 'none'].includes(String(args.stop_at ?? ''))
        ? (args.stop_at as 'main' | 'reset' | 'none')
        : undefined
      return debugOpen(deps, {
        project: args.project ?? '',
        ...(stopAt !== undefined ? { stop_at: stopAt } : {}),
        ...(args.load !== undefined ? { load: args.load } : {}),
        ...(typeof args.lease_s === 'number' ? { lease_s: args.lease_s } : {}),
      })
    }
    case 'control':
      return debugControl(deps, {
        ...(args.op !== undefined ? { op: args.op } : {}),
        ...(args.addr !== undefined ? { addr: args.addr } : {}),
        ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
        ...(args.wait_s !== undefined ? { wait_s: args.wait_s } : {}),
      })
    case 'inspect':
      return debugInspect(deps, {
        ...(args.what !== undefined ? { what: args.what } : {}),
        ...(args.frame !== undefined ? { frame: args.frame } : {}),
        ...(args.scope !== undefined ? { scope: args.scope as 'locals' | 'args' | 'children' } : {}),
        ...(args.var !== undefined ? { var: args.var } : {}),
        ...(args.thread !== undefined ? { thread: args.thread } : {}),
        ...(args.group !== undefined ? { group: args.group } : {}),
        ...(args.format !== undefined ? { format: args.format as 'natural' | 'hex' } : {}),
        ...(args.addr !== undefined ? { addr: args.addr } : {}),
        ...(args.count !== undefined ? { count: args.count } : {}),
        ...(args.expr !== undefined ? { expr: args.expr } : {}),
      })
    case 'breakpoint':
      return debugBreakpoint(deps, {
        ...(args.op !== undefined ? { op: args.op } : {}),
        ...(args.id !== undefined ? { id: args.id } : {}),
        ...(args.kind !== undefined ? { kind: args.kind as 'func' | 'addr' } : {}),
        ...(args.location !== undefined ? { location: args.location } : {}),
        ...(args.condition !== undefined ? { condition: args.condition } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.hardware !== undefined ? { hardware: args.hardware } : {}),
      })
    case 'wait': {
      let after = args.after_seq
      if (after === undefined) {
        const snap = await debugSession(deps)
        const s = snap.session as Record<string, unknown> | null
        after = Number(((s?.stop as Record<string, unknown> | null)?.seq) ?? 0)
      }
      const timeout = Math.min(60, Math.max(1, Math.round(args.timeout_s ?? 10))) * 1000
      return waitForStop(deps, Number(after), timeout)
    }
    case 'close':
      return debugClose(deps, { ...(args.resume !== undefined ? { resume: args.resume } : {}) })
    default:
      return {
        ok: false,
        code: 'bad-action',
        note: `action 必须是 open/control/inspect/breakpoint/wait/close：${action}`,
      }
  }
}
