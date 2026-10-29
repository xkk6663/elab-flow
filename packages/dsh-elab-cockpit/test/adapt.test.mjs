/**
 * 批 3 适配状态机（domain/adapt.ts）—— 纯归约单测。
 *
 * 状态链：unbound → discovered（有未接入候选）→ adapting → bound；
 * 失败回 discovered 并显式呈现原因。root 变化要作废旧候选。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initialAdaptState, reduceAdapt, unadaptedCandidates } from '../src/domain/adapt.ts'

const CANDS = [
  { path: 'C:/proj/led', dirname: 'led', adaptedAs: 'led' },
  { path: 'C:/proj/sensor', dirname: 'sensor' },
]

test('初始 = unbound；host 未解析到根保持 unbound', () => {
  let s = initialAdaptState()
  assert.equal(s.phase, 'unbound')
  s = reduceAdapt(s, { type: 'host/resolved', elabRoot: null })
  assert.equal(s.phase, 'unbound')
  assert.equal(s.elabRoot, null)
})

test('host 解析到根 → discovered（即使还没扫）', () => {
  const s = reduceAdapt(initialAdaptState(), { type: 'host/resolved', elabRoot: 'C:/elab' })
  assert.equal(s.phase, 'discovered')
  assert.equal(s.elabRoot, 'C:/elab')
})

test('discover：有未接入候选 → discovered；全部已接入 → bound', () => {
  const s0 = reduceAdapt(initialAdaptState(), { type: 'host/resolved', elabRoot: 'C:/elab' })
  const s1 = reduceAdapt(s0, { type: 'discover/result', candidates: CANDS })
  assert.equal(s1.phase, 'discovered')
  assert.equal(s1.scanned, true)
  assert.deepEqual(unadaptedCandidates(s1).map((c) => c.dirname), ['sensor'])

  const s2 = reduceAdapt(s1, {
    type: 'discover/result',
    candidates: CANDS.map((c) => ({ ...c, adaptedAs: c.adaptedAs ?? 'sensor' })),
  })
  assert.equal(s2.phase, 'bound')
  assert.equal(unadaptedCandidates(s2).length, 0)
})

test('一键适配：start → adapting；成功 → bound + lastAdapted', () => {
  const s0 = reduceAdapt(initialAdaptState(), { type: 'host/resolved', elabRoot: 'C:/elab' })
  const s1 = reduceAdapt(s0, { type: 'discover/result', candidates: CANDS })
  const s2 = reduceAdapt(s1, { type: 'adapt/start', path: 'C:/proj/sensor' })
  assert.equal(s2.phase, 'adapting')
  assert.equal(s2.target, 'C:/proj/sensor')

  const s3 = reduceAdapt(s2, { type: 'adapt/done', ok: true, name: 'sensor' })
  assert.equal(s3.phase, 'bound')
  assert.equal(s3.target, null)
  assert.equal(s3.lastAdapted, 'sensor')
  assert.equal(s3.error, null)
})

test('适配失败 → 回 discovered 并显式呈现原因', () => {
  const s0 = reduceAdapt(initialAdaptState(), { type: 'host/resolved', elabRoot: 'C:/elab' })
  const s1 = reduceAdapt(s0, { type: 'discover/result', candidates: CANDS })
  const s2 = reduceAdapt(s1, { type: 'adapt/start', path: 'C:/proj/sensor' })
  const s3 = reduceAdapt(s2, { type: 'adapt/done', ok: false, error: '芯片未匹配' })
  assert.equal(s3.phase, 'discovered')
  assert.equal(s3.error, '芯片未匹配')
  assert.equal(s3.lastAdapted, null)
})

test('root 变化 → 候选作废（旧候选指向旧 root 的路径）', () => {
  const s0 = reduceAdapt(initialAdaptState(), { type: 'host/resolved', elabRoot: 'C:/elab' })
  const s1 = reduceAdapt(s0, { type: 'discover/result', candidates: CANDS })
  const s2 = reduceAdapt(s1, { type: 'host/resolved', elabRoot: 'D:/other-elab' })
  assert.equal(s2.elabRoot, 'D:/other-elab')
  assert.equal(s2.candidates.length, 0)
  assert.equal(s2.scanned, false)
})

test('unbound 降级：root 丢失后事件不再呈现旧状态', () => {
  const s0 = reduceAdapt(initialAdaptState(), { type: 'host/resolved', elabRoot: 'C:/elab' })
  const s1 = reduceAdapt(s0, { type: 'discover/result', candidates: CANDS })
  const s2 = reduceAdapt(s1, { type: 'host/resolved', elabRoot: null })
  assert.equal(s2.phase, 'unbound')
  assert.equal(s2.candidates.length, 0)
})

test('未识别事件原样返回同一引用（前向兼容纪律）', () => {
  const s = reduceAdapt(initialAdaptState(), { type: 'host/resolved', elabRoot: 'C:/elab' })
  assert.equal(reduceAdapt(s, { type: 'future/thing' }), s)
})
