/**
 * Agent 侧使用契约门禁（跨工程上下文修补）。
 *
 * 背景：工具注册是进程级、skill / AGENTS.md 是工作区级 —— 新建工程没带上下文时
 * agent 不知道 elab_* 该怎么用。插件改为注册常驻系统提示段 + 只读 `elab_guide`，
 * 两份文案必须同源且覆盖关键纪律，避免"提示说 A、guide 说 B"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AGENT_USAGE, agentGuidePayload } from '../src/adapters/dsh-tools/tools.ts'

test('常驻提示段：短、指向 elab_guide、含首调 elab_status', () => {
  assert.equal(typeof AGENT_USAGE, 'string')
  assert.ok(AGENT_USAGE.length > 0 && AGENT_USAGE.length < 1200, '常驻段应保持短小')
  assert.match(AGENT_USAGE, /elab_status/)
  assert.match(AGENT_USAGE, /elab_guide/)
})

test('elab_guide：返回工具清单 + 规则 + 面板说明，且与常驻段同源', () => {
  const payload = agentGuidePayload()
  assert.equal(payload.ok, true)
  assert.equal(payload.usage, AGENT_USAGE)
  assert.ok(Array.isArray(payload.tools) && payload.tools.length >= 15)
  assert.ok(Array.isArray(payload.rules) && payload.rules.length >= 3)
  assert.equal(typeof payload.panel, 'string')

  // 工具名唯一、统一 elab 前缀（防止复制粘贴漂移）
  const names = payload.tools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length)
  for (const name of names) assert.match(name, /^elab_/)

  // 编排主链必须在清单里（agent 照着选工具的最短路径）
  for (const name of ['elab_status', 'elab_triple', 'elab_loop', 'elab_log', 'elab_debug_open', 'elab_serial_monitor']) {
    assert.ok(names.includes(name), `elab_guide 缺 ${name}`)
  }
})

test('纪律文案：单飞 / 串口让位 / 写门控 / 判活四类都在', () => {
  const { rules } = agentGuidePayload()
  const text = rules.join('\n')
  assert.match(text, /单飞/)
  // M2 起串口不再是「互斥不许跑」，而是内核自动让位（挂起监视并在收尾恢复）。
  assert.match(text, /让位/)
  assert.match(text, /allowAgentWrite/)
  assert.match(text, /toggles|tick/)
})
