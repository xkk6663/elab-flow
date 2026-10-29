/**
 * 三档一键流两门面自洽验证（原 plans-parity 用例，§16.5 批 1 后升级）。
 *
 * 背景：Host 半 plans.ts 与 Client 半 model/plans.ts 曾是**两份同构实现**，
 * 漂移会出现"按钮能点但后端拒绝"的缝。批 1 已把两份合并为 domain/pipeline.ts
 * —— parity 由结构保证。本用例保留原夹具，验证**两个门面**（面板视图
 * `resolveAllPlans` 与命令视图 `resolveRunSteps`）在同一份定义上仍然一致：
 * effectiveSteps 与 skipped 集合逐项相等。
 *
 * 注：两边都用 node:test 直接 import .ts（Node 24 strip-types）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveRunSteps, resolveAllPlans, PLANS } from '../src/domain/pipeline.ts'

/** 夹具：全部可用。 */
const ALL_OK = {
  doctor: { ok: true },
  build: { ok: true },
  flash: { ok: true },
  debug_verify: { ok: true },
  monitor: { ok: true },
}

/** 夹具：无探针（flash/debug_verify/monitor 不可用）。 */
const NO_PROBE = {
  doctor: { ok: true },
  build: { ok: true },
  flash: { ok: false, reason: '未检测到探针' },
  debug_verify: { ok: false, reason: '未检测到探针' },
  monitor: { ok: false, reason: '未检测到探针' },
}

/** 夹具：编译都不可用。 */
const NO_BUILD = {
  doctor: { ok: true },
  build: { ok: false, reason: '工程配置缺失' },
  flash: { ok: true },
  debug_verify: { ok: true },
  monitor: { ok: true },
}

/** 夹具：只有 monitor 不可用（判据缺失）。 */
const NO_MONITOR = {
  doctor: { ok: true },
  build: { ok: true },
  flash: { ok: true },
  debug_verify: { ok: true },
  monitor: { ok: false, reason: '判据缺失' },
}

const FIXTURES = [
  ['全部可用', ALL_OK],
  ['无探针', NO_PROBE],
  ['编译不可用', NO_BUILD],
  ['monitor 不可用', NO_MONITOR],
]

test('门面自洽：resolveRunSteps（命令视图）与 resolveAllPlans（面板视图）逐档一致', () => {
  for (const plan of PLANS) {
    for (const [name, availability] of FIXTURES) {
      const serialBusy = false
      // 面板视图：resolveAllPlans 过滤后取同档（永远不抛，整档不可用则 enabled=false）
      const view = resolveAllPlans(availability, serialBusy).find((p) => p.id === plan.id)
      assert.ok(view, `面板视图缺少档位 ${plan.id}（夹具：${name}）`)
      // 命令视图：可执行时与面板视图一致；整档不可用时抛错（工具面转告 agent），
      // 而面板把同一判定呈现为 enabled=false —— 两者对"能不能跑"结论一致。
      if (view.enabled) {
        const cmd = resolveRunSteps({ plan: plan.id, availability, serialBusy })
        assert.deepEqual(
          { steps: cmd.steps, skipped: cmd.skipped },
          { steps: view.effectiveSteps, skipped: view.skipped },
          `档位 ${plan.id}（夹具：${name}）两门面不一致`,
        )
      } else {
        assert.throws(
          () => resolveRunSteps({ plan: plan.id, availability, serialBusy }),
          `档位 ${plan.id}（夹具：${name}）面板判不可用，命令视图却未拒绝`,
        )
      }
    }
  }
})

test('门面自洽：无探针时 triple 剔除 onhw、保留 build；loop 保留 doctor+build', () => {
  const triple = resolveRunSteps({ plan: 'triple', availability: NO_PROBE })
  assert.deepEqual(triple.steps, ['build'])
  assert.equal(triple.skipped.length, 2)
  const loop = resolveRunSteps({ plan: 'loop', availability: NO_PROBE })
  assert.deepEqual(loop.steps, ['doctor', 'build'])
  assert.equal(loop.skipped.length, 3)
})

test('门面自洽：编译不可用时面板置灰、命令视图抛错（同一判定的两种呈现）', () => {
  // 面板：整档不可用 → enabled=false（按钮置灰 + reason）
  const view = resolveAllPlans(NO_BUILD).find((p) => p.id === 'triple')
  assert.equal(view?.enabled, false)
  assert.match(String(view?.reason), /编译/)
  // 命令：整档不可用 → 抛错（宿主把错误转告 agent，不静默降级到别的步骤）
  assert.throws(() => resolveRunSteps({ plan: 'triple', availability: NO_BUILD }), /没有任何可执行步骤/)
})

test('显式 steps 优先于 plan（两门面共同规则）', () => {
  const cmd = resolveRunSteps({ plan: 'triple', steps: ['build'], availability: NO_PROBE })
  assert.deepEqual(cmd.steps, ['build'])
  assert.equal(cmd.skipped.length, 0)
})
