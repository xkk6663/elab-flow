/**
 * 旧工具名的兼容层（**默认不注册**）。
 *
 * 门面化后旧名（如 `elab_triple` / `elab_frame_profile`）不再是一等入口，
 * 但老 skill、老脚本、老记忆里还写着它们 —— 直接消失会打断正在进行的会话。
 * 这里按 `Config.toolMode` 决定是否把旧名作为**别名工具**注册：
 *
 *   facade（默认）：只注册 12 个新工具 —— 上下文最省，agent 走意图树；
 *   both           ：新工具 + 旧名别名（过渡期用，别名描述带废弃提示）；
 *   legacy         ：只注册旧名（回退开关，出问题时用）。
 *
 * 别名工具的参数 = 旧契约的原样（描述沿用新契约，避免第二份词汇表）；
 * 执行 = 转发到对应门面的动作，实现只有一份。
 */

import { TOOL_CONTRACTS, type ToolParamSpec } from '../../domain/tools.ts'

import { debugAction } from './debug-ops.ts'
import { frameAction, frameLearnAction } from './frame-ops.ts'
import { pkgAction } from './pkg-ops.ts'
import { runAction } from './run-ops.ts'
import { serialAction } from './serial-ops.ts'

/** 一个旧名工具的规格。 */
interface LegacySpec {
  /** 转发到的门面工具。 */
  tool: string
  /** 固定 action（转发时用）。 */
  action?: string
  /** 暴露哪些参数（描述取自新契约）。 */
  params: readonly string[]
  /** 旧名独有的参数（新契约里没有的）。 */
  extra?: Record<string, ToolParamSpec>
  /** 参数改名：旧名 → 新名。 */
  rename?: Record<string, string>
  /** 旧名废弃提示里的一句话用途。 */
  use: string
}

const LEGACY_SPECS: Record<string, LegacySpec> = {
  elab_build: { tool: 'elab_run', action: 'build', params: ['project', 'clean', 'jobs'], use: '只编译' },
  elab_triple: { tool: 'elab_run', action: 'triple', params: ['project', 'clean'], use: '编译+烧录+调试校验' },
  elab_loop: { tool: 'elab_run', action: 'loop', params: ['project', 'clean'], use: '完整闭环' },
  elab_step: { tool: 'elab_run', action: 'step', params: ['project', 'steps', 'clean', 'jobs'], use: '指定步骤组合' },
  elab_preview: { tool: 'elab_run', action: 'preview', params: ['project', 'steps', 'clean', 'jobs'], use: '预览将执行的计划' },
  elab_cancel: { tool: 'elab_run', action: 'cancel', params: ['run', 'reason'], use: '取消当前 run' },
  elab_serial_monitor: {
    tool: 'elab_serial',
    action: 'monitor',
    params: ['project', 'port', 'baud', 'lease_s', 'decoder'],
    rename: { action: 'op' },
    extra: { action: { type: 'string', required: true, description: 'open / close / decoder / clear / pause / resume' } },
    use: '串口监视生命周期',
  },
  // ★ elab_serial（旧版 = 直接写串口）**不建别名**：新门面同名。
  //   新门面的 action 可省（带 data → write），旧调用形态照样能跑。
  elab_serial_decode: {
    tool: 'elab_serial',
    action: 'decode',
    params: ['project', 'profile', 'hex', 'data_b64', 'channels', 'apply'],
    extra: { decoder: { type: 'string', required: true, description: 'justfloat / firewater / profile / profile:<id>' } },
    use: '无状态解码一帧',
  },
  elab_serial_decoded: { tool: 'elab_serial', action: 'decoded', params: ['after', 'limit'], use: '增量读共享解码帧' },
  elab_serial_stats: { tool: 'elab_serial', action: 'stats', params: ['window_s'], use: '帧级健康度统计' },
  elab_debug_open: {
    tool: 'elab_debug',
    action: 'open',
    params: ['project', 'stop_at', 'load', 'lease_s'],
    use: '打开调试会话',
  },
  elab_debug_control: {
    tool: 'elab_debug',
    action: 'control',
    params: ['addr', 'confirm', 'wait_s'],
    rename: { action: 'op' },
    extra: {
      action: {
        type: 'string',
        required: true,
        description: 'continue / pause / step_over / step_in / step_out / stepi / reset / restart / run_to',
      },
    },
    use: '驱动调试会话',
  },
  elab_debug_breakpoint: {
    tool: 'elab_debug',
    action: 'breakpoint',
    params: ['id', 'kind', 'location', 'condition', 'enabled', 'hardware'],
    extra: { op: { type: 'string', required: true, description: 'list / add / update / toggle / remove' } },
    use: '断点增删查',
  },
  elab_debug_wait: { tool: 'elab_debug', action: 'wait', params: ['after_seq', 'timeout_s'], use: '等待下一个 stop' },
  elab_debug_close: { tool: 'elab_debug', action: 'close', params: ['resume'], use: '关闭调试会话并恢复运行' },
  elab_adapt: {
    tool: 'elab_pkg',
    action: 'adapt',
    params: ['path', 'write', 'name'],
    extra: { path: { type: 'string', required: true, description: '工程目录绝对路径' } },
    use: '把工程目录接入 elab',
  },
}

/** elab_frame_profile 特殊：一个旧名拆到两个新工具（管理 / 自学习）。 */
const FRAME_LEARN_ACTIONS = ['learn', 'verify', 'auto', 'codegen']
const FRAME_PROFILE_ACTIONS = ['list', 'get', 'preview', 'save', 'delete', 'encode', 'templates', 'import']

/** 旧名 → 新调用写法（提示语）。 */
function hintFor(legacy: string): string {
  if (legacy === 'elab_frame_profile') {
    return 'elab_frame（管理）或 elab_frame_learn（自学习）'
  }
  const spec = LEGACY_SPECS[legacy]
  if (spec === undefined) return ''
  return spec.action !== undefined ? `${spec.tool} action="${spec.action}"` : spec.tool
}

/** 旧名的参数规格（描述沿用新契约；旧名独有的用 extra）。 */
function legacyParameters(legacy: string): Record<string, ToolParamSpec> {
  const out: Record<string, ToolParamSpec> = {}
  if (legacy === 'elab_frame_profile') {
    const frame = TOOL_CONTRACTS.elab_frame?.parameters ?? {}
    const learn = TOOL_CONTRACTS.elab_frame_learn?.parameters ?? {}
    for (const [k, v] of Object.entries(frame)) {
      if (k === 'action') continue
      out[k] = v
    }
    for (const [k, v] of Object.entries(learn)) {
      if (k === 'action') continue
      out[k] = v
    }
    out.action = {
      type: 'string',
      required: true,
      description: [...FRAME_PROFILE_ACTIONS, ...FRAME_LEARN_ACTIONS].join(' / '),
    }
    return out
  }
  const spec = LEGACY_SPECS[legacy]
  if (spec === undefined) return out
  const target = TOOL_CONTRACTS[spec.tool]?.parameters ?? {}
  for (const name of spec.params) {
    const p = target[name]
    if (p !== undefined) out[name] = p
  }
  for (const [name, p] of Object.entries(spec.extra ?? {})) out[name] = p
  return out
}

/** 旧名 → 转发执行体。 */
function legacyExecutor(
  legacy: string,
): (deps: any, args: Record<string, unknown>) => Promise<unknown> {
  return async (deps, rawArgs) => {
    const args = { ...(rawArgs ?? {}) } as Record<string, unknown>
    if (legacy === 'elab_frame_profile') {
      const action = String(args.action ?? '')
      if (FRAME_LEARN_ACTIONS.includes(action)) {
        delete args.action
        return frameLearnAction(deps, action, args as any)
      }
      delete args.action
      return frameAction(deps, action, args as any)
    }
    const spec = LEGACY_SPECS[legacy]
    if (spec === undefined) {
      return { ok: false, code: 'legacy-unknown', note: `未知的旧工具：${legacy}` }
    }
    // 参数改名（旧 action → 新 op）
    for (const [from, to] of Object.entries(spec.rename ?? {})) {
      if (args[from] !== undefined) {
        args[to] = args[from]
        delete args[from]
      }
    }
    switch (spec.tool) {
      case 'elab_run':
        return runAction(deps, spec.action ?? '', args as any)
      case 'elab_serial':
        return serialAction(deps, spec.action ?? '', args as any)
      case 'elab_debug':
        return debugAction(deps, spec.action ?? '', args as any)
      case 'elab_pkg':
        return pkgAction(deps, spec.action ?? '', args as any)
      default:
        return { ok: false, code: 'legacy-unknown', note: `旧工具 ${legacy} 没有可转发的目标` }
    }
  }
}

/** 全部旧名工具的契约（供注册层拼装）。 */
export function legacyToolDefinitions(): Array<{
  name: string
  description: string
  parameters: Record<string, ToolParamSpec>
  kind: 'read' | 'execute' | 'edit'
  execute: (deps: any, args: Record<string, unknown>) => Promise<unknown>
}> {
  return Object.keys(LEGACY_SPECS)
    .concat('elab_frame_profile')
    // 与新工具同名的旧名不建别名（新门面已覆盖，且旧形态由门面的参数推断兼容）
    .filter((legacy) => TOOL_CONTRACTS[legacy] === undefined)
    .map((legacy) => {
      const spec = LEGACY_SPECS[legacy]
      const use = legacy === 'elab_frame_profile' ? '帧协议 profile 全家桶' : (spec?.use ?? '')
      const target = TOOL_CONTRACTS[legacy === 'elab_frame_profile' ? 'elab_frame' : (spec?.tool ?? '')]
      const kind = target?.kind ?? 'execute'
      return {
        name: legacy,
        description:
          `【已废弃】${use}；请改用 ${hintFor(legacy)}。` +
          '（本工具仅为兼容旧脚本保留，下个版本将移除；参数与旧版一致。）',
        parameters: legacyParameters(legacy),
        kind,
        execute: legacyExecutor(legacy),
      }
    })
}

/** 旧名工具清单（注册面 + 迁移提示都用它）。 */
export function legacyNames(): string[] {
  return Object.keys(LEGACY_SPECS)
    .concat('elab_frame_profile')
    .filter((legacy) => TOOL_CONTRACTS[legacy] === undefined)
}
