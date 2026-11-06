/**
 * run 组实现：编译 / 烧录 / 三连 / 闭环 / 指定步骤 / 预览 / 取消 / 读日志。
 *
 * 红线（不变）：
 *  - **人机共用同一份 plans 解析**（domain/pipeline.ts 的 `resolveRunSteps`）；
 *  - 写操作 actor='agent'（面板出现蓝色 agent 标，用户可见即可取消）；
 *  - 一律回**结构化**结果（含 run id）；日志不塞工具输出，需要时用 elab_log。
 */

import { resolveRunSteps, type PlanDef, type PlanId, type StepAvailability } from '../../domain/pipeline.ts'

import { cockpit, type ToolsDeps } from './runtime.ts'

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

/** 显式步骤执行（与面板里的单步按钮同源）；不可用步骤直接报错，不静默剔除。 */
async function runStep(deps: ToolsDeps, args: { project: string; steps: string; clean?: boolean; jobs?: number }) {
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
}

/** 只读预览将执行的命令（GET /api/plan：不 spawn、不写盘、不发事件）。 */
async function runPreview(
  deps: ToolsDeps,
  args: { project: string; steps?: string; clean?: boolean; jobs?: number },
) {
  const qs = new URLSearchParams({ project: args.project })
  if (args.steps !== undefined && args.steps.trim() !== '') qs.set('steps', args.steps.trim())
  if (args.clean === true) qs.set('clean', '1')
  if (typeof args.jobs === 'number' && args.jobs > 0) qs.set('jobs', String(args.jobs))
  return cockpit(deps, `/api/plan?${qs.toString()}`)
}

/** 取消 run（杀整棵进程树；人发的也能取消）。 */
async function runCancel(deps: ToolsDeps, args: { run?: string; reason?: string }) {
  const run = args.run ?? deps.arbiter.current()?.run
  if (run === undefined || run === '') return { ok: false, note: '当前没有活动 run' }
  const r = await cockpit<{ ok: boolean }>(deps, '/api/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run, ...(args.reason !== undefined ? { reason: args.reason } : {}) }),
  })
  return { ok: r.ok === true, run }
}

/**
 * `elab_run` 门面的动作分发。
 *
 * action 枚举在 domain/tools.ts（契约层），这里只管执行；
 * 未知 action 一律回结构化错误（不抛），便于 agent 自纠。
 */
export async function runAction(
  deps: ToolsDeps,
  action: string,
  args: {
    project?: string
    steps?: string
    clean?: boolean
    jobs?: number
    run?: string
    reason?: string
  },
): Promise<unknown> {
  switch (action) {
    case 'build':
    case 'triple':
    case 'loop': {
      if (args.project === undefined || args.project === '') {
        return { ok: false, code: 'missing-project', note: `action=${action} 需要 project（用 elab_status 查工程名）` }
      }
      // 门面动作名 → 内核档位 id（build = plan basic）
      const plan = action === 'build' ? 'basic' : action
      return runPlanTool(deps, { project: args.project, ...(args.clean !== undefined ? { clean: args.clean } : {}), ...(args.jobs !== undefined ? { jobs: args.jobs } : {}) }, plan)
    }
    case 'step': {
      if (args.project === undefined || args.project === '') {
        return { ok: false, code: 'missing-project', note: 'action=step 需要 project（用 elab_status 查工程名）' }
      }
      if (args.steps === undefined || args.steps.trim() === '') {
        return { ok: false, code: 'bad-steps', note: 'action=step 需要 steps（逗号分隔，如 build 或 flash,debug_verify）' }
      }
      return runStep(deps, {
        project: args.project,
        steps: args.steps,
        ...(args.clean !== undefined ? { clean: args.clean } : {}),
        ...(args.jobs !== undefined ? { jobs: args.jobs } : {}),
      })
    }
    case 'preview': {
      if (args.project === undefined || args.project === '') {
        return { ok: false, code: 'missing-project', note: 'action=preview 需要 project' }
      }
      return runPreview(deps, {
        project: args.project,
        ...(args.steps !== undefined ? { steps: args.steps } : {}),
        ...(args.clean !== undefined ? { clean: args.clean } : {}),
        ...(args.jobs !== undefined ? { jobs: args.jobs } : {}),
      })
    }
    case 'cancel':
      return runCancel(deps, {
        ...(args.run !== undefined ? { run: args.run } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      })
    default:
      return {
        ok: false,
        code: 'bad-action',
        note: `action 必须是 build/triple/loop/step/preview/cancel：${action}`,
      }
  }
}

/** elab_log：run 事件流 → 纯文本尾部 N 行（不塞全量）。 */
export async function logTail(
  deps: ToolsDeps,
  args: { run?: string; step?: string; tail?: number },
): Promise<unknown> {
  const run = args.run ?? deps.arbiter.current()?.run
  if (run === undefined || run === '') {
    throw new Error('没有进行中的 run（可用 elab_status 查看，或先发起一个）')
  }
  const tail = Math.min(2000, Math.max(1, Math.round(args.tail ?? 200)))
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
