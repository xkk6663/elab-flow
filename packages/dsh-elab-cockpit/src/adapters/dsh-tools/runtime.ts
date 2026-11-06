/**
 * dsh-tools 适配器的**共享底座**：HTTP 调用、结构化输出、工具包装。
 *
 * 这一层只做「怎么把内核 HTTP 面变成工具返回值」，不含任何业务词汇
 * （业务词汇 = 步骤/档位/串口格式 → 内核自描述；工具契约 → domain/tools.ts）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { ToolDeps } from '../../app/ports.ts'

/** 批 2 端口化：依赖形状收敛到 app/ports.ts（实现由 main.ts 组装注入）；旧名保留。 */
export type ToolsDeps = ToolDeps

/** 拿到 cockpit baseUrl 后执行一次 JSON HTTP 调用。 */
export async function cockpit<T>(deps: ToolsDeps, path: string, init?: RequestInit): Promise<T> {
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

/** 结构化输出：统一 JSON 投影（agent 拿到的永远是可解析的 JSON）。 */
export const jsonOutput = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
} as const

/**
 * defineTool 的类型边界：宿主内核的 execute 契约返回 JsonValue，而我们的
 * 结构化结果是普通对象（字段含 unknown）——统一经 JSON 序列化收敛
 * （我们的返回本来就是纯 JSON 数据，语义无损）。presentCall 的 kind 用
 * ToolCallKind 的合法值（'execute'/'edit'/'read'）。
 */
export function makeTool(def: any) {
  return defineTool({
    ...def,
    execute: async (args: any, exec: any) => JSON.parse(JSON.stringify(await def.execute(args))),
  })
}

/** 轮询/等待用的休眠。 */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** agent 身份头（写操作记 actor=agent，面板可见可取消）。 */
export const AGENT_JSON = {
  'Content-Type': 'application/json',
  'x-elab-actor': 'agent',
}
