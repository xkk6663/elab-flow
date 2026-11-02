import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IDLE, markStreamClosed, reduce } from '../src/index.ts'

const ev = (topic, extra = {}) => ({
  ts: 1000 + (extra.seq ?? 0),
  run: 'r1',
  seq: 1,
  actor: 'agent',
  topic,
  ...extra,
})

test('reduce：run/start 建立声明序列，未识别 topic 原样返回同一个引用', () => {
  const s = reduce(IDLE, ev('run/start', { steps: ['doctor', 'build'], project: 'p' }))
  assert.equal(s.status, 'running')
  assert.equal(s.project, 'p')
  assert.deepEqual(s.steps.map((v) => [v.id, v.state]), [['doctor', 'pending'], ['build', 'pending']])

  const same = reduce(s, ev('something/unknown', { seq: 2 }))
  assert.equal(same, s)
})

test('reduce：step-enter/exit 归约状态，build 结果进 lastBuild', () => {
  let s = reduce(IDLE, ev('run/start', { steps: ['build'], seq: 1 }))
  s = reduce(s, ev('run/step-enter', { step: 'build', seq: 2 }))
  assert.equal(s.currentStep, 'build')
  assert.equal(s.steps[0].state, 'running')

  s = reduce(s, ev('run/step-exit', { step: 'build', ok: true, detail: '', duration_s: 1.5, seq: 3 }))
  assert.equal(s.steps[0].state, 'ok')
  assert.equal(s.steps[0].duration_s, 1.5)
  assert.equal(s.lastBuild.ok, true)
  assert.equal(s.currentStep, null)
})

test('reduce：run/end 把没跑到的步骤标 skipped；run/cancel 标 cancelled', () => {
  let s = reduce(IDLE, ev('run/start', { steps: ['build', 'flash'], seq: 1 }))
  s = reduce(s, ev('run/step-enter', { step: 'build', seq: 2 }))
  s = reduce(s, ev('run/step-exit', { step: 'build', ok: true, seq: 3 }))
  s = reduce(s, ev('run/end', { ok: true, seq: 4 }))
  assert.equal(s.status, 'ok')
  assert.equal(s.steps[0].state, 'ok')
  assert.equal(s.steps[1].state, 'skipped')

  let c = reduce(IDLE, ev('run/start', { steps: ['build'], seq: 1 }))
  c = reduce(c, ev('run/cancel', { seq: 2 }))
  assert.equal(c.status, 'cancelled')
  assert.equal(c.steps[0].state, 'cancelled')
})

test('reduce：proc/* 只推进游标；serial/closed-loop 写入判定', () => {
  let s = reduce(IDLE, ev('proc/stdout', { seq: 10 }))
  assert.equal(s.lastSeq, 10)
  assert.equal(s.status, 'idle')

  s = reduce(s, ev('serial/closed-loop', { seq: 11, verdict: 'ok', rule: 'marker', evidence: 'x' }))
  assert.deepEqual(s.closedLoop, { verdict: 'ok', rule: 'marker', evidence: 'x' })
})

test('reduce：stream/overrun 计数单调不回退', () => {
  let s = reduce(IDLE, ev('stream/overrun', { seq: 1, dropped: 5, topic_scope: 'proc/*' }))
  assert.equal(s.overrun, 5)
  assert.equal(s.overrunScope, 'proc/*')
  s = reduce(s, ev('stream/overrun', { seq: 2, dropped: 3 }))
  assert.equal(s.overrun, 5)
  assert.equal(s.overrunScope, 'proc/*')
})

test('markStreamClosed：只在 running 时兜底判失败，其余状态原样返回', () => {
  let s = reduce(IDLE, ev('run/start', { steps: ['build'], seq: 1 }))
  s = reduce(s, ev('run/step-enter', { step: 'build', seq: 2 }))
  const closed = markStreamClosed(s, 'closed')
  assert.equal(closed.status, 'failed')
  assert.equal(closed.steps[0].state, 'failed')
  assert.match(closed.steps[0].detail, /流已关闭（closed）/)

  assert.equal(markStreamClosed(IDLE, 'closed'), IDLE)
})
