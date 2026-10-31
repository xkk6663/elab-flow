/**
 * P5 工具化 —— `elab_*` agent 工具（§6.1 工具表）。
 *
 * 红线：
 *  - **人机共用同一份 plans 解析**（domain/pipeline.ts 的 `resolveRunSteps`）：
 *    `elab_build`→plan 'basic'、`elab_triple`→'triple'、`elab_loop`→'loop'，
 *    写操作全部落到 `POST /api/run`，人按的按钮与 Agent 调的工具有完全相同语义。
 *  - 写操作 actor='agent'（面板会出现蓝色 agent 标，用户可见即可取消，Q11 不预审批）。
 *  - 一律回**结构化**结果（含 run id）；日志不塞工具输出，Agent 需要时用 `elab_log`。
 *  - 串口写 / 适配写盘受 `allowAgentWrite` 门控（默认关，§6.2 规则 6）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { resolveRunSteps, type PlanDef, type PlanId, type StepAvailability } from '../../domain/pipeline.ts'
import type { SerialBytesTail } from '../../domain/icd.ts'
import type { ToolDeps } from '../../app/ports.ts'

/** 批 2 端口化：依赖形状收敛到 app/ports.ts（实现由 main.ts 组装注入）；旧名保留。 */
export type ToolsDeps = ToolDeps

/** 拿到 cockpit baseUrl 后执行一次 JSON HTTP 调用。 */
async function cockpit<T>(deps: ToolsDeps, path: string, init?: RequestInit): Promise<T> {
  const { baseUrl } = await deps.ensureHost()
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    throw new Error(`cockpit ${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new Error(err?.message ?? `cockpit ${path} HTTP ${res.status}`)
  }
  return body as T
}

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
} as const

/**
 * defineTool 的类型边界：宿主内核的 execute 契约返回 JsonValue，而我们的
 * 结构化结果是普通对象（字段含 unknown）——统一经 JSON 序列化收敛
 * （我们的返回本来就是纯 JSON 数据，语义无损）。presentCall 的 kind 用
 * ToolCallKind 的合法值（'execute'/'edit'/'read'）。
 */
function makeTool(def: any) {
  return defineTool({
    ...def,
    execute: async (args: any, exec: any) => JSON.parse(JSON.stringify(await def.execute(args))),
  })
}

/** §16：拉内核自描述的档位定义（meta.plans）；拿不到 = undefined，走内置 PLANS。 */
async function kernelPlanDefs(deps: ToolsDeps): Promise<PlanDef[] | undefined> {
  try {
    const { baseUrl } = await deps.ensureHost()
    const res = await fetch(`${baseUrl}/api/capabilities`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return undefined
    const cap = (await res.json()) as { meta?: { plans?: Array<{ id?: unknown; steps?: unknown; requires_hardware?: unknown }> } }
    const plans = cap.meta?.plans
    if (!Array.isArray(plans)) return undefined
    const out: PlanDef[] = []
    for (const p of plans) {
      if (typeof p?.id !== 'string' || !Array.isArray(p.steps)) continue
      out.push({
        id: p.id as PlanId,
        steps: p.steps.map(String),
        requiresHardware: p.requires_hardware === true,
      })
    }
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/** 三档工具的公共实现：解析 plan → 仲裁 → POST /api/run（actor=agent）。 */
async function runPlanTool(
  deps: ToolsDeps,
  args: { project: string; clean?: boolean; jobs?: number },
  plan: 'basic' | 'triple' | 'loop',
): Promise<unknown> {
  const { baseUrl } = await deps.ensureHost()
  const projects = await cockpit<{ projects?: Array<Record<string, unknown>>; cards?: Array<Record<string, unknown>> }>(
    deps,
    '/api/projects',
  )
  const cards = projects.projects ?? projects.cards ?? []
  const card = cards.find((c) => String(c.name ?? '') === args.project)
  if (card === undefined) {
    const names = cards.map((c) => String(c.name ?? '')).filter(Boolean)
    throw new Error(`未找到工程「${args.project}」（可用：${names.length > 0 ? names.join('、') : '（无）'}）；可先用 elab_status 查看`)
  }
  const availability = (card.steps ?? {}) as StepAvailability
  const resolved = resolveRunSteps({
    plan,
    availability,
    plans: await kernelPlanDefs(deps),
  })
  const acquire = await deps.arbiter.tryAcquire('tool', 'agent', resolved.steps)
  if (!acquire.ok) {
    return {
      ok: false,
      code: acquire.code,
      holder: acquire.holder,
      ...(acquire.nextAction !== undefined ? { nextAction: acquire.nextAction } : {}),
    }
  }
  try {
    const r = await cockpit<{ run: string; project: string; steps: string[] }>(deps, '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: args.project,
        steps: resolved.steps,
        ...(args.clean === true ? { clean: true } : {}),
        ...(typeof args.jobs === 'number' && args.jobs > 0 ? { jobs: args.jobs } : {}),
        actor: 'agent',
      }),
    })
    deps.arbiter.attachRun('tool', r.run)
    return {
      ok: true,
      run: r.run,
      project: args.project,
      steps: resolved.steps,
      ...(resolved.skipped.length > 0 ? { skipped: resolved.skipped } : {}),
      note: '进度在面板实时可见；需要日志用 elab_log（含 run id）',
    }
  } catch (error) {
    deps.arbiter.releaseIfPending('tool')
    throw error
  }
}

/** elab_log：run 事件流 → 纯文本尾部 N 行（不塞全量）。 */
async function logTail(
  deps: ToolsDeps,
  args: { run?: string; step?: string; tail?: number },
): Promise<unknown> {
  const run = args.run ?? deps.arbiter.current()?.run
  if (run === undefined || run === '') {
    throw new Error('没有进行中的 run（可用 elab_status 查看，或先发起一个）')
  }
  const tail = Math.min(2000, Math.max(1, Math.round(args.tail ?? 200)))
  const { baseUrl } = await deps.ensureHost()
  const data = await cockpit<{ events?: Array<Record<string, unknown>> }>(
    deps,
    `/api/run-events?run=${encodeURIComponent(run)}&from=0`,
  )
  const events = data.events ?? []
  const lines: string[] = []
  for (const e of events) {
    const topic = String(e.topic ?? '')
    if (args.step !== undefined && args.step !== '' && String(e.step ?? '') !== args.step) continue
    if (topic === 'proc/stdout-batch') {
      for (const l of (e.lines as string[] | undefined) ?? []) lines.push(l)
    } else if (topic === 'proc/stdout' || topic === 'proc/stderr') {
      lines.push(String(e.line ?? ''))
    } else if (topic === 'run/step-enter') {
      lines.push(`▶ 进入 ${String(e.step ?? '')}`)
    } else if (topic === 'run/step-exit') {
      lines.push(`${e.ok ? '✓' : '✗'} ${String(e.step ?? '')} ${e.ok ? '完成' : `失败：${String(e.detail ?? '')}`}`)
    }
  }
  const total = lines.length
  return {
    ok: true,
    run,
    total,
    lines: lines.slice(-tail),
    truncated: total > tail,
  }
}

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

/** 批次 → agent 可读文本（UTF-8 投影 + 原始 hex 兜底）。 */
function chunkText(dataB64: string): { text: string; hex: string } {
  const bytes = Buffer.from(dataB64, 'base64')
  return {
    text: bytes.toString('utf8'),
    hex: bytes.toString('hex').replace(/([0-9a-f]{2})(?=[0-9a-f])/g, '$1 '),
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 注册全部 elab_* 工具（autoExposeTools=true 时由入口调用）。 */
export function registerElabTools(
  register: (definition: unknown) => () => void,
  deps: ToolsDeps,
): () => void {
  const disposers: Array<() => void> = []

  const add = (definition: unknown): void => {
    try {
      disposers.push(register(definition))
    } catch (error) {
      deps.warn(`dsh-elab-cockpit: 工具注册失败 ${String(error)}`)
    }
  }

  add(
    makeTool({
      name: 'elab_status',
      description:
        '查看 elab 驾驶舱状态：工程列表（含各步骤可用性与原因）、当前 run 归属与步骤、cockpit 进程健康，' +
        '以及串口现状（端口候选 / 当前监视会话 / 租约剩余）。只读。写操作前先调它确认工程名与端口。',
      parameters: {},
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'read', title: '查看 elab 驾驶舱状态' }),
      async execute() {
        const { baseUrl } = await deps.ensureHost()
        const projects = await cockpit<{ projects?: Array<Record<string, unknown>>; cards?: Array<Record<string, unknown>> }>(
          deps,
          '/api/projects',
        )
        const cards = projects.projects ?? projects.cards ?? []
        const current = deps.arbiter.current()
        const caps = await cockpit<{
          serial?: {
            available?: boolean
            layer?: string
            hint?: string | null
            backend?: string
            write_available?: boolean
            ports?: Array<{ name?: string; kind?: string; desc?: string }>
            host_default?: string
            host_baud?: number
            monitor?: Record<string, unknown> | null
          }
        }>(deps, '/api/capabilities')
        const serial = caps.serial
        return {
          ok: true,
          projects: cards.map((c) => ({
            name: String(c.name ?? ''),
            ...(typeof c.root === 'string' ? { root: c.root } : {}),
            tools: Array.isArray(c.tools) ? c.tools : [],
            steps: c.steps ?? {},
          })),
          activeRun: current,
          // 串口现状：端口候选 + 当前会话（含 opened_by / lease_remaining_s）——
          // agent 换口前先看这里，不用猜 / 也不用先 open 一次试错。
          serial: serial === undefined ? null : {
            available: serial.available === true,
            layer: serial.layer ?? '',
            hint: serial.hint ?? null,
            backend: serial.backend ?? '',
            write_available: serial.write_available === true,
            host_default: serial.host_default ?? '',
            host_baud: serial.host_baud ?? 115200,
            ports: (serial.ports ?? []).map((p) => ({
              name: String(p.name ?? ''),
              kind: String(p.kind ?? ''),
              desc: String(p.desc ?? ''),
            })),
            monitor: serial.monitor ?? null,
          },
        }
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_build',
      description: '编译指定工程（plan=basic，只跑 build）。返回 run id；进度在 DSH 面板实时可见，需要日志用 elab_log。',
      parameters: {
        project: { type: 'string', required: true, description: '工程名（用 elab_status 查询）' },
        clean: { type: 'boolean', description: '先删除工作目录再编译（不可逆，谨慎）' },
        jobs: { type: 'number', description: '并行度 -j（默认由工程决定）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 编译' }),
      async execute(args: { project: string; clean?: boolean; jobs?: number }) {
        return runPlanTool(deps, args, 'basic')
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_triple',
      description: '编译+烧录+调试校验（plan=triple，三连；需要硬件在位）。返回 run id；面板实时可见进度。',
      parameters: {
        project: { type: 'string', required: true, description: '工程名（用 elab_status 查询）' },
        clean: { type: 'boolean', description: '先删除工作目录（不可逆，谨慎）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 三连（编译+烧录+调试）' }),
      async execute(args: { project: string; clean?: boolean }) {
        return runPlanTool(deps, args, 'triple')
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_loop',
      description: '跑完整闭环（plan=loop：体检→编译→烧录→调试校验→串口闭环；缺什么自动剔除并在返回里说明）。返回 run id。',
      parameters: {
        project: { type: 'string', required: true, description: '工程名（用 elab_status 查询）' },
        clean: { type: 'boolean', description: '先删除工作目录（不可逆，谨慎）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 完整闭环' }),
      async execute(args: { project: string; clean?: boolean }) {
        return runPlanTool(deps, args, 'loop')
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_step',
      description:
        '按**显式步骤**执行（与面板里的单步按钮同源）：doctor / build / flash / debug_verify / monitor，' +
        '以及项目声明的 tool:<name>；steps 用逗号分隔。显式步骤不可用时**直接报错**（不静默剔除）。' +
        '返回 run id，进度在面板实时可见。',
      parameters: {
        project: { type: 'string', required: true, description: '工程名（用 elab_status 查询）' },
        steps: { type: 'string', required: true, description: '逗号分隔，如 build 或 flash,debug_verify 或 tool:ota' },
        clean: { type: 'boolean', description: '先删除工作目录（不可逆，谨慎）' },
        jobs: { type: 'number', description: '并行度 -j（默认由工程决定）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 单步执行' }),
      async execute(args: { project: string; steps: string; clean?: boolean; jobs?: number }) {
        const wanted = args.steps.split(',').map((s) => s.trim()).filter(Boolean)
        if (wanted.length === 0) {
          return { ok: false, code: 'bad-steps', note: 'steps 不能为空（逗号分隔，如 build 或 flash,debug_verify）' }
        }
        const projects = await cockpit<{ projects?: Array<Record<string, unknown>>; cards?: Array<Record<string, unknown>> }>(
          deps,
          '/api/projects',
        )
        const cards = projects.projects ?? projects.cards ?? []
        const card = cards.find((c) => String(c.name ?? '') === args.project)
        if (card === undefined) {
          const names = cards.map((c) => String(c.name ?? '')).filter(Boolean)
          throw new Error(`未找到工程「${args.project}」（可用：${names.length > 0 ? names.join('、') : '（无）'}）；可先用 elab_status 查看`)
        }
        const availability = (card.steps ?? {}) as StepAvailability
        const declaredTools = new Set(
          ((card.tools as Array<{ name?: unknown }> | undefined) ?? []).map((t) => `tool:${String(t.name ?? '')}`),
        )
        for (const s of wanted) {
          if (s.startsWith('tool:')) {
            if (!declaredTools.has(s)) {
              return {
                ok: false,
                code: 'unknown-step',
                step: s,
                note: `工程未声明工具「${s.slice(5)}」（项目 yaml 的 tools: 节里没有它）`,
              }
            }
            continue
          }
          const av = availability[s]
          if (av === undefined) {
            return {
              ok: false,
              code: 'unknown-step',
              step: s,
              note: `未知步骤「${s}」；已知步骤：${Object.keys(availability).join('、')}`,
            }
          }
          if (av.ok === false) {
            return { ok: false, code: 'step-unavailable', step: s, note: av.reason ?? '该步骤当前不可用' }
          }
        }
        const acquire = await deps.arbiter.tryAcquire('tool', 'agent', wanted)
        if (!acquire.ok) {
          return {
            ok: false,
            code: acquire.code,
            holder: acquire.holder,
            ...(acquire.nextAction !== undefined ? { nextAction: acquire.nextAction } : {}),
          }
        }
        try {
          const r = await cockpit<{ run: string; project: string; steps: string[] }>(deps, '/api/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project: args.project,
              steps: wanted,
              ...(args.clean === true ? { clean: true } : {}),
              ...(typeof args.jobs === 'number' && args.jobs > 0 ? { jobs: args.jobs } : {}),
              actor: 'agent',
            }),
          })
          deps.arbiter.attachRun('tool', r.run)
          return {
            ok: true,
            run: r.run,
            project: args.project,
            steps: wanted,
            note: '进度在面板实时可见；需要日志用 elab_log（含 run id）',
          }
        } catch (error) {
          deps.arbiter.releaseIfPending('tool')
          throw error
        }
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_preview',
      description:
        '只读预览将执行的命令（GET /api/plan：不 spawn、不写盘、不发事件）。' +
        'steps 缺省 = 工程默认步序；返回每步 argv 与 --clean 的删除目标。',
      parameters: {
        project: { type: 'string', required: true, description: '工程名' },
        steps: { type: 'string', description: '逗号分隔；缺省=默认闭环步序' },
        clean: { type: 'boolean', description: '按 --clean 预览（会显式列出删除目录）' },
        jobs: { type: 'number', description: '并行度 -j' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 命令预览' }),
      async execute(args: { project: string; steps?: string; clean?: boolean; jobs?: number }) {
        const qs = new URLSearchParams({ project: args.project })
        if (args.steps !== undefined && args.steps.trim() !== '') qs.set('steps', args.steps.trim())
        if (args.clean === true) qs.set('clean', '1')
        if (typeof args.jobs === 'number' && args.jobs > 0) qs.set('jobs', String(args.jobs))
        return cockpit(deps, `/api/plan?${qs.toString()}`)
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_cancel',
      description: '取消当前 run（杀整棵进程树）。无论 run 由人还是 agent 发起都可取消（§6.2 规则 4）。',
      parameters: {
        run: { type: 'string', description: '要取消的 run id；缺省 = 当前活动 run' },
        reason: { type: 'string', description: '取消原因（记入日志）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 取消 run' }),
      async execute(args: { run?: string; reason?: string }) {
        const run = args.run ?? deps.arbiter.current()?.run
        if (run === undefined || run === '') return { ok: false, note: '当前没有活动 run' }
        const r = await cockpit<{ ok: boolean }>(deps, '/api/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ run, ...(args.reason !== undefined ? { reason: args.reason } : {}) }),
        })
        return { ok: r.ok === true, run }
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_serial',
      description:
        '向指定工程的串口写数据（写硬件！需要 allowAgentWrite 开启）。默认 UTF-8 文本 + CRLF；' +
        'format=hex 时 data 按十六进制字节发送（空格可有可无）。',
      parameters: {
        project: { type: 'string', required: true, description: '工程名' },
        data: { type: 'string', required: true, description: '要写入的内容（不含换行符；hex 格式时为十六进制串）' },
        baud: { type: 'number', description: '波特率（默认 115200）' },
        format: { type: 'string', description: 'utf8 / ascii / gbk / hex（默认 utf8）' },
        eol: { type: 'string', description: 'none / lf / crlf（默认 crlf；hex 自动 none）' },
        encoding: { type: 'string', description: '文本编码（默认 utf-8）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'edit', title: 'elab 串口写' }),
      async execute(args: {
        project: string
        data: string
        baud?: number
        format?: string
        eol?: string
        encoding?: string
      }) {
        if (!deps.allowAgentWrite()) {
          return {
            ok: false,
            code: 'agent-write-disabled',
            nextAction: '串口写硬件需要用户在设置里开启 allowAgentWrite；或请用户在面板串口通道手动输入',
          }
        }
        return cockpit(deps, '/api/serial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: args.project,
            data: args.data,
            ...(args.baud !== undefined ? { baud: args.baud } : {}),
            ...(args.format !== undefined ? { format: args.format } : {}),
            ...(args.eol !== undefined ? { eol: args.eol } : {}),
            ...(args.encoding !== undefined ? { encoding: args.encoding } : {}),
          }),
        })
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_serial_monitor',
      description:
        '常驻串口监视会话（open/close/clear/pause/resume）。agent 打开时默认带 lease_s 租约，' +
        '到期自动释放端口（避免把串口一直占死）。读数据用 elab_serial_read / elab_serial_wait。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'open / close / clear / pause / resume',
        },
        project: { type: 'string', description: '工程名（open 时用于解析端口/波特率）' },
        port: { type: 'string', description: '显式端口（缺省取工程配置）' },
        baud: { type: 'number', description: '显式波特率（缺省取工程配置）' },
        lease_s: { type: 'number', description: '租约秒数（open 时默认 120；0 = 无租约）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 串口监视' }),
      async execute(args: {
        action: string
        project?: string
        port?: string
        baud?: number
        lease_s?: number
      }) {
        const action = args.action as 'open' | 'close' | 'clear' | 'pause' | 'resume'
        if (!['open', 'close', 'clear', 'pause', 'resume'].includes(action)) {
          return { ok: false, code: 'bad-action', note: `action 必须是 open/close/clear/pause/resume：${args.action}` }
        }
        const body: Record<string, unknown> = { action }
        if (action === 'open') {
          body.actor = 'agent'
          if (args.project !== undefined) body.project = args.project
          if (args.port !== undefined) body.port = args.port
          if (args.baud !== undefined) body.baud = args.baud
          body.lease_s = args.lease_s !== undefined ? args.lease_s : 120
          // 写权限随用户设置（默认关）；读不受限。
          body.allow_agent_write = deps.allowAgentWrite()
        }
        return cockpit(deps, '/api/serial/monitor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_serial_read',
      description:
        '增量读取串口监视会话的原始字节（带方向/时间/序号）。返回 next_after 游标与 text/hex 投影；' +
        '没有会话时先 elab_serial_monitor action=open。只读，不写硬件。',
      parameters: {
        after: { type: 'number', description: '上次返回的 next_after（缺省 0 = 从当前环起点）' },
        direction: { type: 'string', description: 'all / rx / tx（默认 all；rx=设备输出，tx=我们写出的）' },
        limit: { type: 'number', description: '最多返回多少批次（默认 500，上限 4096）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 读串口' }),
      async execute(args: { after?: number; direction?: string; limit?: number }) {
        const after = Math.max(0, Math.round(args.after ?? 0))
        const direction = (args.direction ?? 'all') as 'all' | 'rx' | 'tx'
        const limit = Math.min(4096, Math.max(1, Math.round(args.limit ?? 500)))
        const tail = await fetchBytes(deps, after, { direction, limit })
        if (tail.active !== true) {
          return {
            ok: false,
            active: false,
            note: '没有进行中的串口监视；先用 elab_serial_monitor action=open（需要硬件在位）',
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
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_serial_wait',
      description:
        '等待串口监视流里出现匹配文本（正则或子串），返回匹配时刻前后的批次。超时返回 ok=false。' +
        '用于“发命令后等设备回 OK/数据”这类时序断言。只读。',
      parameters: {
        pattern: { type: 'string', required: true, description: '要等待的正则表达式（大小写敏感）' },
        after: { type: 'number', description: '起始游标（缺省 = 当前环末尾之后的新数据）' },
        direction: { type: 'string', description: 'all / rx / tx（默认 rx）' },
        timeout_ms: { type: 'number', description: '超时毫秒（默认 5000，上限 60000）' },
        poll_ms: { type: 'number', description: '轮询间隔毫秒（默认 150）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 等待串口输出' }),
      async execute(args: {
        pattern: string
        after?: number
        direction?: string
        timeout_ms?: number
        poll_ms?: number
      }) {
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
              note: '串口监视会话不存在或已结束；先用 elab_serial_monitor action=open（需要硬件在位）',
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
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_serial_decode',
      description:
        '无状态协议解码（justfloat / firewater）。justfloat = N×4 小端 float + 尾 00 00 80 7F；' +
        'firewater = ASCII 逗号分隔 float + 换行。半帧以 pending_b64 原样带回，拼下一批再解。',
      parameters: {
        decoder: { type: 'string', required: true, description: 'justfloat / firewater' },
        hex: { type: 'string', description: '十六进制字节串（与 data_b64 二选一）' },
        data_b64: { type: 'string', description: 'base64 字节串（与 hex 二选一）' },
        channels: { type: 'number', description: '显式通道数（缺省自动推断）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 串口解码' }),
      async execute(args: { decoder: string; hex?: string; data_b64?: string; channels?: number }) {
        return cockpit(deps, '/api/serial/decode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decoder: args.decoder,
            ...(args.hex !== undefined ? { hex: args.hex } : {}),
            ...(args.data_b64 !== undefined ? { data_b64: args.data_b64 } : {}),
            ...(args.channels !== undefined ? { channels: args.channels } : {}),
          }),
        })
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_serial_capture',
      description:
        '显式录制串口字节（证据，可回放）：start 开始录、stop 收尾返回文件路径与统计、' +
        'status 查当前录制。文件是有界 JSONL（默认上限 5 MiB），到顶自动停录并标 truncated。' +
        '只存原始字节（bytes_b64），不存文本投影。',
      parameters: {
        action: { type: 'string', required: true, description: 'start / stop / status' },
        project: { type: 'string', description: '工程名（可省略；用于文件命名与留档关联）' },
        max_bytes: { type: 'number', description: '录制文件上限（字节；缺省 5 MiB）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'edit', title: 'elab 串口录制' }),
      async execute(args: { action: string; project?: string; max_bytes?: number }) {
        if (args.action !== 'status' && !deps.allowAgentWrite()) {
          return {
            ok: false,
            code: 'agent-write-disabled',
            nextAction: '录制会写盘，需要用户在设置里开启 allowAgentWrite；只用 status 可查看当前是否在录',
          }
        }
        return cockpit(deps, '/api/serial/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: args.action,
            ...(args.project !== undefined ? { project: args.project } : {}),
            ...(args.max_bytes !== undefined ? { max_bytes: args.max_bytes } : {}),
          }),
        })
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_adapt',
      description: '把一个工程目录接入 elab（生成 projects/<name>.yaml）。write=false 只读探测并给出报告；write=true 落盘（需要 allowAgentWrite）。',
      parameters: {
        path: { type: 'string', required: true, description: '工程目录绝对路径' },
        write: { type: 'boolean', description: 'true = 写入适配文件；缺省 false = 只读探测' },
        name: { type: 'string', description: '适配名（write 时用；缺省取目录名）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'edit', title: 'elab 工程适配' }),
      async execute(args: { path: string; write?: boolean; name?: string }) {
        const write = args.write === true
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
          body: JSON.stringify({ action: write ? 'write' : 'probe', path: args.path, ...(args.name !== undefined ? { name: args.name } : {}) }),
        })
      },
    }),
  )

  add(
    makeTool({
      name: 'elab_log',
      description: '读取某个 run 的日志尾部 N 行纯文本（默认 200，可按步骤过滤）。run 缺省 = 当前活动 run。',
      parameters: {
        run: { type: 'string', description: 'run id；缺省 = 当前活动 run' },
        step: { type: 'string', description: '只看某一步（doctor/build/flash/debug_verify/monitor）' },
        tail: { type: 'number', description: '尾部行数（默认 200，上限 2000）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 读日志' }),
      async execute(args: { run?: string; step?: string; tail?: number }) {
        return logTail(deps, args)
      },
    }),
  )

  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
  }
}
