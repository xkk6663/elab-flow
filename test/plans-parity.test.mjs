/**
 * R12 守护用例：Host 半 `plans.ts` 与 Client 半 `model/plans.ts` 必须同构。
 *
 * 为什么值得单写一个用例：
 *   两处判定一旦漂移，就会出现"按钮能点但后端拒绝"或反过来的缝 ——
 *   而这种缝在手工测试里极难撞见（需要恰好某个步骤不可用）。
 *   这里用同一组夹具跑两边，逐项比对 effective steps 与 skipped 集合。
 *
 * 注意：两边都用 `node:test` 直接 import .ts（Node 24 strip-types）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveRunSteps, PLANS as HOST_PLANS } from '../src/host/plans.ts'
import { resolveAllPlans, resolvePlan, PLANS as CLIENT_PLANS } from '../src/client/model/plans.ts'

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
  monitor: { ok: false, reason: '固件无心跳判据' },
}

const CASES = [
  ['全部可用', ALL_OK, false],
  ['全部可用 + 串口忙', ALL_OK, true],
  ['无探针', NO_PROBE, false],
  ['无探针 + 串口忙', NO_PROBE, true],
  ['编译不可用', NO_BUILD, false],
  ['仅 monitor 不可用', NO_MONITOR, false],
]

test('两边的档位定义一致（id 与声明步骤）', () => {
  assert.deepEqual(
    HOST_PLANS.map((p) => [p.id, [...p.steps], p.requiresHardware]),
    CLIENT_PLANS.map((p) => [p.id, [...p.steps], p.requiresHardware]),
  )
})

for (const [name, availability, serialBusy] of CASES) {
  test(`同构：${name}`, () => {
    // Client 侧：一次算全部三档
    const clientViews = resolveAllPlans(availability, serialBusy)

    for (const view of clientViews) {
      // ★ 已知且**有意**的语义差异：过滤后没有可执行步骤时，
      //   - Host 侧抛错（它要真发一个 run，空 run 无意义且会误导）；
      //   - Client 侧返回 enabled=false（它只负责把按钮置灰）。
      //   两者对"是否有步骤可跑"的判断必须一致 —— 这才是同构的实质。
      const hostHasSteps = view.effectiveSteps.length > 0

      if (!hostHasSteps) {
        assert.throws(
          () => resolveRunSteps({ plan: view.id, availability, serialBusy }),
          /没有任何可执行步骤/,
          `${name} / plan=${view.id}：Client 认为无可执行步骤，Host 也应拒绝`,
        )
        assert.equal(view.enabled, false, `${name} / plan=${view.id}：Client 应置灰`)
        continue
      }

      const hostResolved = resolveRunSteps({
        plan: view.id,
        availability,
        serialBusy,
      })

      assert.deepEqual(
        hostResolved.steps,
        view.effectiveSteps,
        `${name} / plan=${view.id} 的实际步骤不一致`,
      )
      assert.deepEqual(
        hostResolved.skipped,
        view.skipped,
        `${name} / plan=${view.id} 的跳过集合不一致`,
      )
      assert.equal(hostResolved.plan, view.id)
      // enabled 语义一致：两边都看 build 是否在最终步骤里
      assert.equal(
        hostResolved.steps.includes('build'),
        view.enabled,
        `${name} / plan=${view.id} 的 enabled 不一致`,
      )
    }
  })
}

test('语义契约：主步骤不可用时两边判定一致', () => {
  const clientViews = resolveAllPlans(NO_BUILD, false)
  for (const view of clientViews) {
    // ★ loop 是个特例：build 不可用时 doctor 仍可跑，所以 steps 非空，
    //   但 enabled 必须是 false —— 因为整档的意义（闭环/三连/编译）依赖 build。
    //   这正是"enabled 看 build，而不看 steps 是否为空"的由来。
    assert.equal(view.enabled, false, `${view.id} 应置灰（build 不可用）`)

    if (view.effectiveSteps.length === 0) {
      assert.throws(
        () => resolveRunSteps({ plan: view.id, availability: NO_BUILD }),
        /没有任何可执行步骤/,
        `${view.id}：Client 无步骤时 Host 也应拒绝`,
      )
    } else {
      // loop 仍有 doctor：Host 允许发（能跑体检），但 UI 不该让用户点
      const r = resolveRunSteps({ plan: view.id, availability: NO_BUILD })
      assert.deepEqual(r.steps, view.effectiveSteps)
      assert.equal(r.steps.includes('build'), false)
    }
  }
})

test('loop 在 build 不可用时：剔除 build，其余（探针可用时）保留', () => {
  const loop = resolveAllPlans(NO_BUILD, false).find((p) => p.id === 'loop')
  // NO_BUILD 夹具里 flash/debug_verify/monitor 仍标 ok，故只剔除 build。
  // 这说明剔除是按"每步自己的可用性"逐条判的，不是"主步骤挂了就清空"。
  assert.deepEqual(loop.effectiveSteps, ['doctor', 'flash', 'debug_verify', 'monitor'])
  assert.equal(loop.enabled, false, 'enabled 看 build，不看 steps 是否为空')
  const r = resolveRunSteps({ plan: 'loop', availability: NO_BUILD })
  assert.deepEqual(r.steps, ['doctor', 'flash', 'debug_verify', 'monitor'])
})

test('loop 在「无探针且无 build」时只剩 doctor', () => {
  const both = {
    doctor: { ok: true },
    build: { ok: false, reason: '工程配置缺失' },
    flash: { ok: false, reason: '未检测到探针' },
    debug_verify: { ok: false, reason: '未检测到探针' },
    monitor: { ok: false, reason: '未检测到探针' },
  }
  const loop = resolveAllPlans(both, false).find((p) => p.id === 'loop')
  assert.deepEqual(loop.effectiveSteps, ['doctor'])
  assert.equal(loop.enabled, false)
})

test('basic 永远只含 build', () => {
  const [basic] = resolveAllPlans(ALL_OK, false)
  assert.deepEqual(basic.effectiveSteps, ['build'])
})

test('triple 是 build→flash→debug_verify，不含 monitor/doctor', () => {
  const triple = resolveAllPlans(ALL_OK, false).find((p) => p.id === 'triple')
  assert.deepEqual(triple.effectiveSteps, ['build', 'flash', 'debug_verify'])
})

test('loop 含 doctor 但不含 doctor_deep', () => {
  const loop = resolveAllPlans(ALL_OK, false).find((p) => p.id === 'loop')
  assert.ok(loop.effectiveSteps.includes('doctor'))
  assert.ok(!loop.effectiveSteps.includes('doctor_deep'))
})

test('无探针时 triple 只剩 build（剔除而非拒绝，Q9）', () => {
  const triple = resolveAllPlans(NO_PROBE, false).find((p) => p.id === 'triple')
  assert.deepEqual(triple.effectiveSteps, ['build'])
  assert.equal(triple.skipped.length, 2)
  assert.equal(triple.enabled, true, '编译仍可跑，故整档仍可用')
})

test('无探针时 loop 只剩 doctor+build', () => {
  const loop = resolveAllPlans(NO_PROBE, false).find((p) => p.id === 'loop')
  assert.deepEqual(loop.effectiveSteps, ['doctor', 'build'])
  assert.equal(loop.skipped.length, 3)
})

test('build 不可用时三档全部 enabled=false', () => {
  for (const view of resolveAllPlans(NO_BUILD, false)) {
    assert.equal(view.enabled, false, `${view.id} 应不可用`)
    assert.ok(view.reason !== undefined)
  }
})

test('串口忙时 monitor/flash/debug_verify 都被剔除', () => {
  const loop = resolveAllPlans(ALL_OK, true).find((p) => p.id === 'loop')
  assert.deepEqual(loop.effectiveSteps, ['doctor', 'build'])
  assert.ok(loop.skipped.every((s) => ['flash', 'debug_verify', 'monitor'].includes(s.step)))
})

test('显式 steps 优先于 plan（不做事后过滤）', () => {
  const r = resolveRunSteps({ plan: 'loop', steps: ['build'] })
  assert.deepEqual(r.steps, ['build'])
  assert.deepEqual(r.skipped, [])
})

test('未指定 plan 且未给 steps → 默认 basic（绝不用 Python 的 doctor+build）', () => {
  const r = resolveRunSteps({})
  assert.deepEqual(r.steps, ['build'])
  assert.equal(r.plan, 'basic')
})

test('未知 plan 抛错', () => {
  assert.throws(() => resolveRunSteps({ plan: 'nope' }), /未知的 plan/)
})

test('过滤后无步骤时抛错（不允许发一个空 run）', () => {
  assert.throws(
    () => resolveRunSteps({ plan: 'basic', availability: { build: { ok: false, reason: 'x' } } }),
    /没有任何可执行步骤/,
  )
})

test('单个档位解析：resolvePlan 与 resolvePlanById 结果一致', () => {
  for (const def of CLIENT_PLANS) {
    const clientView = resolvePlan(def, NO_PROBE, false)
    const hostView = resolveRunSteps({ plan: def.id, availability: NO_PROBE, serialBusy: false })
    assert.deepEqual(hostView.steps, clientView.effectiveSteps, `plan=${def.id}`)
  }
})
