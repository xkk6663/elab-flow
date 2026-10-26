/**
 * P5 工具化 —— `elab_*` agent 工具（§6.1 工具表）。
 *
 * 红线：
 *  - **人机共用同一份 plans 解析**（host/plans.ts 的 `resolveRunSteps`）：
 *    `elab_build`→plan 'basic'、`elab_triple`→'triple'、`elab_loop`→'loop'，
 *    写操作全部落到 `POST /api/run`，人按的按钮与 Agent 调的工具有完全相同语义。
 *  - 写操作 actor='agent'（面板会出现蓝色 agent 标，用户可见即可取消，Q11 不预审批）。
 *  - 一律回**结构化**结果（含 run id）；日志不塞工具输出，Agent 需要时用 `elab_log`。
 *  - 串口写 / 适配写盘受 `allowAgentWrite` 门控（默认关，§6.2 规则 6）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { resolveRunSteps, type PlanDef, type PlanId, type StepAvailability } from './plans.ts'
import type { RunArbiter } from './run-arbiter.ts'

export interface ToolsDeps {
  ensureHost(): Promise<{ baseUrl: string }>
  arbiter: RunArbiter
  allowAgentWrite(): boolean
  warn(msg: string): void
}

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
        '查看 elab 驾驶舱状态：工程列表（含各步骤可用性与原因）、当前 run 归属与步骤、cockpit 进程健康。只读。写操作前先调它确认工程名。',
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
        return {
          ok: true,
          projects: cards.map((c) => ({
            name: String(c.name ?? ''),
            ...(typeof c.root === 'string' ? { root: c.root } : {}),
            steps: c.steps ?? {},
          })),
          activeRun: current,
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
      description: '向指定工程的串口写一行数据（写硬件！需要 allowAgentWrite 开启）。波特率默认 115200。',
      parameters: {
        project: { type: 'string', required: true, description: '工程名' },
        data: { type: 'string', required: true, description: '要写入的一行（不含换行符）' },
        baud: { type: 'number', description: '波特率（默认 115200）' },
      },
      output: jsonOutput,
      presentCall: () => ({ card: 'generic', kind: 'edit', title: 'elab 串口写' }),
      async execute(args: { project: string; data: string; baud?: number }) {
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
          body: JSON.stringify({ project: args.project, data: args.data, ...(args.baud !== undefined ? { baud: args.baud } : {}) }),
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
