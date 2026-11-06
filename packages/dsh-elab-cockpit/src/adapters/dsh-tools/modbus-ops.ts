/**
 * modbus 组实现：RTU 主站（status/open/close/read/write/start/stop/map/meta）。
 *
 * 红线（与内核一致，不在插件侧重新发明）：
 *  - **不新开串口**：主站挂在已打开的串口会话上（open 会复用/代开会话），
 *    所以 agent 与面板看到的是同一份字节、同一个读线程；
 *  - **写必须显式**：`write` 只走 `POST /api/modbus/write`，且插件侧再 gate 一次
 *    `allowAgentWrite`（默认关）—— 总线上的写会真的动 LED/继电器/变频器；
 *  - **点表是声明式 JSON**：`map` 保存受 `rev` 乐观锁约束，冲突原样回 409，
 *    不静默覆盖别人的编辑；
 *  - 词汇表（功能码/类型/限制）只从 `GET /api/modbus/meta` 取，插件不硬编码。
 */

import { AGENT_JSON, cockpit, type ToolsDeps } from './runtime.ts'

/** JSON 文本 → 对象（失败返回结构化错误，不抛）。 */
function parseJsonArg(
  text: string | undefined,
  what: string,
): { ok: true; value?: Record<string, unknown> } | { ok: false; error: string } {
  if (text === undefined || text === '') return { ok: true, value: undefined }
  try {
    const value = JSON.parse(text) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: `${what} 必须是 JSON 对象` }
    }
    return { ok: true, value: value as Record<string, unknown> }
  } catch {
    return { ok: false, error: `${what} 必须是合法 JSON 字符串` }
  }
}

/** JSON 文本 → 数组（values / groups 用；同样是失败返回结构化错误）。 */
function parseJsonArray(
  text: string | undefined,
  what: string,
): { ok: true; value?: unknown[] } | { ok: false; error: string } {
  if (text === undefined || text === '') return { ok: true, value: undefined }
  try {
    const value = JSON.parse(text) as unknown
    if (!Array.isArray(value)) return { ok: false, error: `${what} 必须是 JSON 数组` }
    return { ok: true, value }
  } catch {
    return { ok: false, error: `${what} 必须是合法 JSON 字符串` }
  }
}

export interface ModbusArgs {
  action?: string
  project?: string
  port?: string
  baud?: number
  unit_id?: number
  fc?: number
  address?: number
  count?: number
  value?: number
  values?: string
  confirm?: boolean
  broadcast?: boolean
  probe?: boolean
  timeout_ms?: number
  retries?: number
  groups?: string
  map?: string
  rev?: number
  after?: number
}

/** 写动作的统一门控：默认拒绝，并给出**能照做**的下一步。 */
function writeDenied(): unknown {
  return {
    ok: false,
    code: 'agent-write-disabled',
    note: '总线上写寄存器会动物理世界：需要用户在设置里开启 allowAgentWrite',
    nextAction: '让用户打开「允许 Agent 写入」，或由用户在面板上点确认后自己发',
  }
}

/** `elab_modbus` 门面：一个 action 走一条内核端点。 */
export async function modbusAction(
  deps: ToolsDeps,
  action: string,
  args: ModbusArgs,
): Promise<unknown> {
  const project = args.project ?? ''

  if (action === 'meta') {
    // 词汇表：功能码中文名、类型、异常码、限制、端点清单
    return await cockpit(deps, '/api/modbus/meta')
  }

  if (action === 'status') {
    // 不打开任何东西：只读快照 + 增量事务；引擎没起来时也回点表
    const qs = new URLSearchParams()
    if (project) qs.set('project', project)
    if (args.after !== undefined) qs.set('after', String(args.after))
    const suffix = qs.toString() === '' ? '' : `?${qs.toString()}`
    return await cockpit(deps, `/api/modbus/state${suffix}`)
  }

  if (action === 'transactions') {
    const qs = new URLSearchParams()
    if (args.after !== undefined) qs.set('after', String(args.after))
    const suffix = qs.toString() === '' ? '' : `?${qs.toString()}`
    return await cockpit(deps, `/api/modbus/transactions${suffix}`)
  }

  if (action === 'open') {
    if (!project) throw new Error('open 需要 project（点表与串口参数都按工程取）')
    const body: Record<string, unknown> = { project }
    if (args.port) body.port = args.port
    if (args.baud !== undefined) body.baud = args.baud
    if (args.unit_id !== undefined) body.unit_id = args.unit_id
    if (args.timeout_ms !== undefined) body.timeout_ms = args.timeout_ms
    if (args.retries !== undefined) body.retries = args.retries
    if (args.probe !== undefined) body.probe = args.probe
    // 会话若由这里代开，写权限随用户设置（默认关，与 elab_serial 一致）
    body.allow_agent_write = deps.allowAgentWrite()
    return await cockpit(deps, '/api/modbus/open', {
      method: 'POST',
      headers: AGENT_JSON,
      body: JSON.stringify(body),
    })
  }

  if (action === 'close') {
    return await cockpit(deps, '/api/modbus/close', {
      method: 'POST',
      headers: AGENT_JSON,
      body: '{}',
    })
  }

  if (action === 'read') {
    const body: Record<string, unknown> = {
      fc: args.fc ?? 3,
      address: args.address ?? 0,
      count: args.count ?? 1,
    }
    if (project) body.project = project
    if (args.unit_id !== undefined) body.unit_id = args.unit_id
    return await cockpit(deps, '/api/modbus/read', {
      method: 'POST',
      headers: AGENT_JSON,
      body: JSON.stringify(body),
    })
  }

  if (action === 'write') {
    if (!deps.allowAgentWrite()) return writeDenied()
    const fc = args.fc ?? 6
    const body: Record<string, unknown> = {
      fc,
      address: args.address ?? 0,
      // 内核要求显式 confirm：工具侧传 confirm 等价于"我确实知道会动物理世界"
      confirm: args.confirm === true,
      broadcast: args.broadcast === true,
    }
    if (args.confirm !== true) {
      return {
        ok: false,
        code: 'confirm-required',
        note: '写操作必须带 confirm=true（内核会拒绝没有确认的写）',
      }
    }
    if (fc === 5 || fc === 6) {
      body.value = args.value ?? 0
    } else {
      const vals = parseJsonArray(args.values, 'values')
      if (!vals.ok) return { ok: false, code: 'bad-json', note: vals.error }
      if (vals.value === undefined || vals.value.length === 0) {
        return { ok: false, code: 'bad-json', note: 'FC15/FC16 批量写需要非空 values 数组' }
      }
      body.values = vals.value
    }
    return await cockpit(deps, '/api/modbus/write', {
      method: 'POST',
      headers: AGENT_JSON,
      body: JSON.stringify(body),
    })
  }

  if (action === 'start') {
    const groups = parseJsonArray(args.groups, 'groups')
    if (!groups.ok) return { ok: false, code: 'bad-json', note: groups.error }
    const body: Record<string, unknown> = {}
    if (groups.value !== undefined) body.groups = groups.value
    return await cockpit(deps, '/api/modbus/start', {
      method: 'POST',
      headers: AGENT_JSON,
      body: JSON.stringify(body),
    })
  }

  if (action === 'stop') {
    return await cockpit(deps, '/api/modbus/stop', {
      method: 'POST',
      headers: AGENT_JSON,
      body: '{}',
    })
  }

  if (action === 'map') {
    // 不带 map → 读点表；带 map → 保存（受 rev 乐观锁）
    if (args.map === undefined) {
      const qs = project ? `?project=${encodeURIComponent(project)}` : ''
      return await cockpit(deps, `/api/modbus/map${qs}`)
    }
    if (!deps.allowAgentWrite()) {
      return {
        ok: false,
        code: 'agent-write-disabled',
        note: '改点表会写盘：需要用户在设置里开启 allowAgentWrite',
        nextAction: '先 action=map 读出现有点表，改完让用户确认再保存',
      }
    }
    if (!project) throw new Error('保存点表需要 project')
    const draft = parseJsonArg(args.map, 'map')
    if (!draft.ok || draft.value === undefined) {
      return { ok: false, code: 'bad-json', note: draft.ok ? 'map 不能为空' : draft.error }
    }
    if (args.rev === undefined) {
      throw new Error('保存点表需要 rev（先 action=map 取 rev，再带上重试）')
    }
    return await cockpit(deps, '/api/modbus/map', {
      method: 'POST',
      headers: AGENT_JSON,
      body: JSON.stringify({ project, map: draft.value, rev: args.rev }),
    })
  }

  // 与其它门面同一形状（serial/debug/frame/pkg 都回 bad-action，不抛异常）：
  // agent 拿到的是可解析的结构，而不是一句 "Error: ..."。
  return {
    ok: false,
    code: 'bad-action',
    note: `action 必须是 meta/status/open/close/read/write/start/stop/transactions/map：${action}`,
  }
}
