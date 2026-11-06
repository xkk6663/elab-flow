/**
 * Agent 侧使用契约门禁（跨工程上下文修补）。
 *
 * 背景：工具注册是进程级、skill / AGENTS.md 是工作区级 —— 新建工程没带上下文时
 * agent 不知道 elab_* 该怎么用。插件改为注册常驻系统提示段 + 只读 `elab_guide`，
 * 两份文案必须同源且覆盖关键纪律，避免"提示说 A、guide 说 B"。
 *
 * 2026-11-06：工具门面化后，guide 正文从**扁平清单**升级为**意图树**
 * （group → 入口，含同义词 / 前置条件 / 调用示例）+ 旧名迁移表。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AGENT_USAGE, agentGuidePayload } from '../src/adapters/dsh-tools/guide.ts'
import { TOOL_CONTRACTS } from '../src/domain/tools.ts'

test('常驻提示段：短、指向 elab_guide、含首调 elab_status 与门面路由表', () => {
  assert.equal(typeof AGENT_USAGE, 'string')
  assert.ok(AGENT_USAGE.length > 0 && AGENT_USAGE.length < 1200, '常驻段应保持短小')
  assert.match(AGENT_USAGE, /elab_status/)
  assert.match(AGENT_USAGE, /elab_guide/)
  // 路由表：每个门面都要在常驻段出现（agent 才知道有哪几类意图）
  for (const tool of ['elab_run', 'elab_serial', 'elab_debug', 'elab_frame', 'elab_frame_learn', 'elab_pkg']) {
    assert.match(AGENT_USAGE, new RegExp(tool), `常驻段缺门面路由：${tool}`)
  }
})

test('elab_guide：返回意图树 + 工具索引 + 迁移表 + 规则 + 面板说明，且与常驻段同源', () => {
  const payload = agentGuidePayload()
  assert.equal(payload.ok, true)
  assert.equal(payload.usage, AGENT_USAGE)
  assert.ok(Array.isArray(payload.groups) && payload.groups.length >= 5, '意图树至少 5 组')
  assert.ok(Array.isArray(payload.tools) && payload.tools.length >= 12, '工具索引应覆盖注册面')
  assert.ok(Array.isArray(payload.rules) && payload.rules.length >= 3)
  assert.equal(typeof payload.panel, 'string')
  assert.ok(payload.migrated && Object.keys(payload.migrated).length >= 10, '应带旧名迁移表')

  // 工具名唯一、统一 elab 前缀（防止复制粘贴漂移）
  const names = payload.tools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length)
  for (const name of names) assert.match(name, /^elab_/)

  // 编排主链必须在清单里（agent 照着选工具的最短路径）
  for (const name of ['elab_status', 'elab_run', 'elab_log', 'elab_debug', 'elab_serial']) {
    assert.ok(names.includes(name), `elab_guide 缺 ${name}`)
  }
})

test('elab_guide 的意图树：每组都有意图、前置条件与带示例的入口', () => {
  const payload = agentGuidePayload()
  for (const group of payload.groups) {
    assert.equal(typeof group.intent, 'string')
    assert.ok(group.intent.length > 0, `${group.id} 缺 intent`)
    assert.ok(Array.isArray(group.preconditions) && group.preconditions.length > 0, `${group.id} 缺前置条件`)
    assert.ok(group.entries.length > 0, `${group.id} 没有入口`)
    for (const entry of group.entries) {
      assert.match(entry.tool, /^elab_/, `入口工具名必须是 elab_*：${entry.tool}`)
      assert.ok(Array.isArray(entry.synonyms) && entry.synonyms.length > 0, `${entry.tool} 缺同义词`)
      assert.ok(Array.isArray(entry.preconditions) && entry.preconditions.length > 0, `${entry.tool} 缺前置条件`)
      assert.ok(typeof entry.example === 'string' && entry.example.includes(entry.tool), `${entry.tool} 的示例要带上工具名`)
    }
  }
})

test('elab_guide topic：只返回一组（渐进披露）', () => {
  const payload = agentGuidePayload('serial')
  assert.equal(payload.groups.length, 1)
  assert.equal(payload.groups[0].id, 'serial')
  // 扁平索引仍全量（agent 需要知道有哪些工具可用）
  assert.equal(payload.tools.length, Object.keys(TOOL_CONTRACTS).length)
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
