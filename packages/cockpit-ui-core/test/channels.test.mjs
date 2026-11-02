import { test } from 'node:test'
import assert from 'node:assert/strict'

import { channelOfEvent, channelOfStep, parseProgressLine } from '../src/index.ts'

test('channelOfStep：默认把 debug_verify 并进烧录（WebUI 口径）', () => {
  assert.equal(channelOfStep('build'), 'build')
  assert.equal(channelOfStep('flash'), 'flash')
  assert.equal(channelOfStep('debug_verify'), 'flash')
  assert.equal(channelOfStep('monitor'), 'serial')
  assert.equal(channelOfStep('tool:ota'), 'tools')
})

test('channelOfStep：debugChannel=true 时拆出独立调试通道（DSH 窄栏口径）', () => {
  assert.equal(channelOfStep('debug_verify', { debugChannel: true }), 'debug')
  // 其余步骤不受该开关影响
  assert.equal(channelOfStep('flash', { debugChannel: true }), 'flash')
})

test('channelOfEvent：serial/* 恒进串口；只有日志类 topic 才归类', () => {
  const serial = { ts: 1, run: 'r', seq: 1, actor: 'agent', topic: 'serial/line' }
  assert.equal(channelOfEvent(serial), 'serial')
  const start = { ts: 1, run: 'r', seq: 1, actor: 'agent', topic: 'run/start' }
  assert.equal(channelOfEvent(start), null)
})

test('channelOfEvent：tool: 步骤共用一个通道；无 step 的日志事件不归类', () => {
  const toolLog = { ts: 1, run: 'r', seq: 1, actor: 'agent', topic: 'proc/stdout', step: 'tool:ota' }
  assert.equal(channelOfEvent(toolLog), 'tools')
  const noStep = { ts: 1, run: 'r', seq: 1, actor: 'agent', topic: 'proc/stdout' }
  assert.equal(channelOfEvent(noStep), null)
})

test('channelOfEvent：按 step 落到对应通道（含调试开关）', () => {
  const e = (step) => ({ ts: 1, run: 'r', seq: 1, actor: 'agent', topic: 'proc/stdout', step })
  assert.equal(channelOfEvent(e('flash')), 'flash')
  assert.equal(channelOfEvent(e('debug_verify')), 'flash')
  assert.equal(channelOfEvent(e('debug_verify'), { debugChannel: true }), 'debug')
  assert.equal(channelOfEvent(e('monitor')), 'serial')
  assert.equal(channelOfEvent(e('doctor')), 'build')
})

test('parseProgressLine：Ninja 进度行；非法/无进度返回 null', () => {
  assert.deepEqual(parseProgressLine('[3/28] Building C object …'), {
    current: 3,
    total: 28,
    label: 'Building C object …',
  })
  assert.equal(parseProgressLine('hello'), null)
  assert.equal(parseProgressLine('[3/0] x'), null)
  assert.equal(parseProgressLine('[4/3] x'), null)
})
