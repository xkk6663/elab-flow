/**
 * 工具门面化的契约门禁（2026-11-06）。
 *
 * 守三件事：
 *  1. **注册面唯一** —— domain/tools.ts 的 TOOL_CONTRACTS 是注册面的唯一事实源；
 *     契约与实现必须一一对应（少实现 = 注册面缺工具；多契约 = 死契约）。
 *  2. **意图树自洽** —— 树里的每个入口都指向存在的工具与合法的 action；
 *     每个注册工具都在树里出现（否则 agent 找不到它）。
 *  3. **门面不认生 action** —— 未知 action 必须回结构化错误，而不是抛异常或静默。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LEGACY_TOOLS, TOOL_CONTRACTS, TOOL_GROUPS } from '../src/domain/tools.ts'
import { registerElabTools } from '../src/adapters/dsh-tools/tools.ts'
import { legacyNames, legacyToolDefinitions } from '../src/adapters/dsh-tools/legacy.ts'
import { debugAction } from '../src/adapters/dsh-tools/debug-ops.ts'
import { frameAction, frameLearnAction } from '../src/adapters/dsh-tools/frame-ops.ts'
import { pkgAction } from '../src/adapters/dsh-tools/pkg-ops.ts'
import { runAction } from '../src/adapters/dsh-tools/run-ops.ts'
import { serialAction } from '../src/adapters/dsh-tools/serial-ops.ts'

/** 收集注册的工具名（走真实注册路径）。 */
function registeredNames(mode) {
  const names = []
  registerElabTools((def) => {
    names.push(def.name)
    return () => {}
  }, { ensureHost: async () => ({ baseUrl: '' }), arbiter: {}, allowAgentWrite: () => false, warn: () => {} }, mode)
  return names
}

test('注册面：facade 模式只注册新工具（14 个），且与契约一一对应', () => {
  const names = registeredNames('facade')
  assert.deepEqual([...names].sort(), Object.keys(TOOL_CONTRACTS).sort())
  assert.equal(names.length, 14, '门面 + 细粒度应为 14 个注册工具')
  for (const name of names) assert.match(name, /^elab_/)
})

test('注册面：工具名唯一（不重复注册）', () => {
  const names = registeredNames('both')
  assert.equal(new Set(names).size, names.length, 'both 模式下不得出现重名工具')
})

test('兼容层：both 模式额外注册旧名别名', () => {
  const both = registeredNames('both')
  const facade = registeredNames('facade')
  const legacySet = new Set(legacyNames())
  for (const name of legacySet) {
    assert.ok(both.includes(name), `both 模式应注册旧名 ${name}`)
    assert.ok(!facade.includes(name), `facade 模式不应注册旧名 ${name}`)
  }
  // 旧名 elab_serial 与新门面同名 → 不建别名（旧形态由门面参数推断兼容）
  assert.ok(!legacySet.has('elab_serial'), 'elab_serial 不应建别名（与新门面同名）')
  assert.ok(both.includes('elab_serial'), 'elab_serial 由新门面提供')
})

test('兼容层：旧名别名的参数仍是旧契约（动作选择器不带门面的枚举）', () => {
  for (const def of legacyToolDefinitions()) {
    assert.ok(def.description.includes('已废弃'), `${def.name} 缺少废弃提示`)
    const action = def.parameters.action
    if (action !== undefined) {
      assert.equal(action.enum, undefined, `${def.name} 的 action 不该是门面的枚举`)
    }
  }
})

test('迁移表：每个旧名都指向存在的工具与合法 action', () => {
  for (const [legacy, targets] of Object.entries(LEGACY_TOOLS)) {
    assert.ok(targets.length > 0, `${legacy} 没有迁移目标`)
    for (const target of targets) {
      const contract = TOOL_CONTRACTS[target.tool]
      assert.ok(contract !== undefined, `${legacy} 指向不存在的工具 ${target.tool}`)
      if (target.action !== undefined) {
        assert.ok(contract.actions?.includes(target.action), `${legacy} → ${target.tool} 的 action ${target.action} 不合法`)
      }
      if (target.actions !== undefined) {
        for (const a of target.actions) {
          assert.ok(contract.actions?.includes(a), `${legacy} → ${target.tool} 的 action ${a} 不合法`)
        }
      }
    }
  }
})

test('意图树：每个入口都指向存在的工具与合法 action', () => {
  for (const group of TOOL_GROUPS) {
    for (const entry of group.entries) {
      const contract = TOOL_CONTRACTS[entry.tool]
      assert.ok(contract !== undefined, `${group.id} 的入口指向不存在的工具 ${entry.tool}`)
      if (entry.action !== undefined) {
        assert.ok(
          contract.actions?.includes(entry.action),
          `${entry.tool} 的 action ${entry.action} 不在契约枚举里`,
        )
      } else {
        assert.equal(contract.actions, undefined, `${entry.tool} 是门面工具，树里必须给 action`)
      }
    }
  }
})

test('意图树：每个注册工具都在树里出现（否则 agent 找不到）', () => {
  const seen = new Set()
  for (const group of TOOL_GROUPS) {
    for (const entry of group.entries) seen.add(entry.tool)
  }
  for (const name of Object.keys(TOOL_CONTRACTS)) {
    assert.ok(seen.has(name), `工具 ${name} 没进意图树`)
  }
})

test('意图树：门面的每个 action 都有树条目（同义词与前置条件是 agent 的导航依据）', () => {
  for (const contract of Object.values(TOOL_CONTRACTS)) {
    if (contract.actions === undefined) continue
    for (const action of contract.actions) {
      const found = TOOL_GROUPS.some((g) => g.entries.some((e) => e.tool === contract.name && e.action === action))
      assert.ok(found, `${contract.name} action=${action} 没进意图树`)
    }
  }
})

test('门面：未知 action 回结构化错误（不抛异常、不静默）', async () => {
  const dispatchers = [
    ['elab_run', runAction],
    ['elab_serial', serialAction],
    ['elab_debug', debugAction],
    ['elab_frame', frameAction],
    ['elab_frame_learn', frameLearnAction],
    ['elab_pkg', pkgAction],
  ]
  for (const [name, fn] of dispatchers) {
    const res = await fn({}, 'no-such-action', {})
    assert.equal(res.ok, false, `${name} 应对未知 action 返回 ok=false`)
    assert.equal(res.code, 'bad-action', `${name} 的未知 action 应回 bad-action`)
  }
})

test('门面：契约里的 action 枚举与实现分支一致（枚举里的都能进，不多不少）', async () => {
  // 逐个门面：枚举里的 action 不应回 bad-action；不在枚举里的应回 bad-action。
  const cases = [
    ['elab_run', runAction, ['build', 'triple', 'loop', 'step', 'preview', 'cancel']],
    ['elab_serial', serialAction, ['monitor', 'write', 'decode', 'decoded', 'stats', 'read', 'wait']],
    ['elab_debug', debugAction, ['open', 'control', 'inspect', 'breakpoint', 'wait', 'close']],
    ['elab_frame', frameAction, ['list', 'get', 'preview', 'save', 'delete', 'encode', 'templates', 'import']],
    ['elab_frame_learn', frameLearnAction, ['learn', 'verify', 'auto', 'codegen']],
    ['elab_pkg', pkgAction, ['status', 'search', 'install', 'activate', 'remove', 'update', 'verify', 'adapt']],
  ]
  const stub = {
    ensureHost: async () => { throw new Error('no host in test') },
    arbiter: { current: () => undefined },
    allowAgentWrite: () => false,
    warn: () => {},
  }
  for (const [name, fn, actions] of cases) {
    const contract = TOOL_CONTRACTS[name]
    assert.deepEqual([...(contract.actions ?? [])].sort(), [...actions].sort(), `${name} 的枚举与实现不一致`)
    for (const action of actions) {
      // 需要真机/内核的动作会抛（没起内核）——抛出来同样说明「有实现分支」，
      // 只有回 bad-action 才是「枚举里有、实现里没有」。
      let res
      try {
        res = await fn(stub, action, {})
      } catch {
        continue
      }
      assert.notEqual(res?.code, 'bad-action', `${name} action=${action} 没有实现分支`)
    }
  }
})
