/**
 * P5 工具化 —— `elab_*` agent 工具（§6.1 工具表）· **混合门面**。
 *
 * 为什么要门面（2026-11-06）：
 *  - 原来 27 个工具一次性全注册，27 份 schema 常驻 agent 上下文；而且**两头都失衡**：
 *    过度平铺（serial_read/decoded/decode/wait 语义重叠，agent 得自己猜），
 *    过度聚合（elab_frame_profile 一个工具背 12 个动作）。
 *  - 现在是**混合门面**：6 个门面（run / serial / debug / frame / frame_learn / pkg）
 *    + 8 个细粒度高频入口（status / guide / log / serial_read / serial_wait /
 *    serial_capture / serial_widget / debug_inspect）= 14 个注册工具。
 *  - 意图树（group → action + 同义词 + 前置条件）在 domain/tools.ts，
 *    `elab_guide` 按 topic 取用 —— agent 找工具的路径从「猜名字」变成「选意图」。
 *
 * 红线：
 *  - **人机共用同一份 plans 解析**（domain/pipeline.ts 的 `resolveRunSteps`）：
 *    写操作全部落到 `POST /api/run`，人按的按钮与 Agent 调的工具有完全相同语义。
 *  - 写操作 actor='agent'（面板会出现蓝色 agent 标，用户可见即可取消，Q11 不预审批）。
 *  - 一律回**结构化**结果（含 run id）；日志不塞工具输出，Agent 需要时用 `elab_log`。
 *  - 串口写 / 适配写盘受 `allowAgentWrite` 门控（默认关，§6.2 规则 6）。
 *  - 工具契约（name/description/parameters）属 **domain**，本文件只提供执行。
 */

import { TOOL_CONTRACTS, type ToolContract } from '../../domain/tools.ts'

import { debugAction, debugInspect } from './debug-ops.ts'
import { frameAction, frameLearnAction } from './frame-ops.ts'
import { AGENT_USAGE, agentGuidePayload } from './guide.ts'
import { legacyToolDefinitions } from './legacy.ts'
import { modbusAction } from './modbus-ops.ts'
import { statusSnapshot } from './overview-ops.ts'
import { pkgAction } from './pkg-ops.ts'
import { jsonOutput, makeTool, type ToolsDeps } from './runtime.ts'
import { logTail, runAction } from './run-ops.ts'
import { serialAction, serialCapture, serialRead, serialWait, serialWidget } from './serial-ops.ts'

export { AGENT_USAGE, agentGuidePayload }

/** 批 2 端口化：依赖形状收敛到 app/ports.ts（实现由 main.ts 组装注入）；旧名保留。 */
export type { ToolsDeps } from './runtime.ts'

/**
 * 注册面模式（Config.toolMode）：
 *  - facade（默认）：只注册 14 个新工具 —— 上下文最省；
 *  - both：额外注册 17 个旧名别名（过渡期用，别名带废弃提示）。
 *
 * ★ 没有 'legacy' 模式：旧实现并没有第二份代码（门面动作就是旧实现），
 *   'both' 已经覆盖「按旧写法调用」的需求，再留一个纯旧面只是多一份上下文。
 */
export type ToolMode = 'facade' | 'both'

/** 工具实现（契约在 domain/tools.ts；这里只管执行）。 */
const IMPLS: Record<string, (deps: ToolsDeps, args: any) => Promise<unknown>> = {
  elab_status: async (deps) => statusSnapshot(deps),
  elab_guide: async (_deps, args) => agentGuidePayload(typeof args?.topic === 'string' ? args.topic : undefined),
  elab_log: async (deps, args) => logTail(deps, args ?? {}),
  elab_run: async (deps, args) => runAction(deps, String(args?.action ?? ''), args ?? {}),
  elab_serial: async (deps, args) => serialAction(deps, String(args?.action ?? ''), args ?? {}),
  elab_serial_read: async (deps, args) => serialRead(deps, args ?? {}),
  elab_serial_wait: async (deps, args) => serialWait(deps, args ?? {}),
  elab_serial_capture: async (deps, args) => serialCapture(deps, args ?? {}),
  elab_serial_widget: async (deps, args) => serialWidget(deps, args ?? {}),
  elab_debug: async (deps, args) => debugAction(deps, String(args?.action ?? ''), args ?? {}),
  elab_debug_inspect: async (deps, args) => debugInspect(deps, args ?? {}),
  elab_frame: async (deps, args) => frameAction(deps, String(args?.action ?? ''), args ?? {}),
  elab_frame_learn: async (deps, args) => frameLearnAction(deps, String(args?.action ?? ''), args ?? {}),
  elab_pkg: async (deps, args) => pkgAction(deps, String(args?.action ?? ''), args ?? {}),
  elab_modbus: async (deps, args) => modbusAction(deps, String(args?.action ?? ''), args ?? {}),
}

/** 面板卡片标题（presentCall；门面标题带动作，agent/用户都看得懂在做什么）。 */
const TITLES: Record<string, string> = {
  elab_status: '查看 elab 驾驶舱状态',
  elab_guide: '查看 elab 工具树',
  elab_log: 'elab 读日志',
  elab_run: 'elab 执行',
  elab_serial: 'elab 串口',
  elab_serial_read: 'elab 读串口',
  elab_serial_wait: 'elab 等待串口输出',
  elab_serial_capture: 'elab 串口录制',
  elab_serial_widget: 'elab 串口发送组件',
  elab_debug: 'elab 调试',
  elab_debug_inspect: 'elab 读调试数据',
  elab_frame: 'elab 帧协议 profile',
  elab_frame_learn: 'elab 协议自学习',
  elab_pkg: 'elab 芯片包与工程接入',
  elab_modbus: 'elab Modbus RTU 主站',
}

/** 门面卡片标题：带上 action（用户看得到「这次到底调了哪个动作」）。 */
function titleFor(contract: ToolContract, args: unknown): string {
  const base = TITLES[contract.name] ?? contract.name
  const action = (args as { action?: unknown } | undefined)?.action
  if (contract.actions !== undefined && typeof action === 'string' && action !== '') {
    return `${base}（${action}）`
  }
  return base
}

/**
 * 注册全部 elab_* 工具（autoExposeTools=true 时由入口调用）。
 *
 * @param mode 注册面模式（默认 facade = 只注册新工具）。
 */
export function registerElabTools(
  register: (definition: unknown) => () => void,
  deps: ToolsDeps,
  mode: ToolMode = 'facade',
): () => void {
  const disposers: Array<() => void> = []

  const add = (definition: unknown): void => {
    try {
      disposers.push(register(definition))
    } catch (error) {
      deps.warn(`dsh-elab-cockpit: 工具注册失败 ${String(error)}`)
    }
  }

  // ① 新工具（门面 + 细粒度）
  for (const contract of Object.values(TOOL_CONTRACTS)) {
    const impl = IMPLS[contract.name]
    if (impl === undefined) {
      deps.warn(`dsh-elab-cockpit: 工具 ${contract.name} 没有实现，已跳过`)
      continue
    }
    add(
      makeTool({
        name: contract.name,
        description: contract.description,
        parameters: contract.parameters,
        output: jsonOutput,
        presentCall: (args: unknown) => ({
          card: 'generic',
          kind: contract.kind,
          title: titleFor(contract, args),
        }),
        async execute(args: any) {
          return impl(deps, args ?? {})
        },
      }),
    )
  }

  // ② 旧名别名（默认不注册；过渡期用）
  if (mode !== 'facade') {
    for (const legacy of legacyToolDefinitions()) {
      add(
        makeTool({
          name: legacy.name,
          description: legacy.description,
          parameters: legacy.parameters,
          output: jsonOutput,
          presentCall: () => ({ card: 'generic', kind: legacy.kind, title: `${legacy.name}（已废弃）` }),
          async execute(args: any) {
            return legacy.execute(deps, args ?? {})
          },
        }),
      )
    }
  }

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
