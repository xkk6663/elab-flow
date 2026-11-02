import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LogBook, LogRing, linesOfEvent } from '../src/index.ts'

/** 测试用通道规则（生产规则由各宿主注入，core 不自带）。 */
const channelOf = (e) => (String(e.topic).startsWith('serial/') ? 'serial' : 'build')

test('linesOfEvent：stdout-batch 展开成多行，ANSI 被剥掉', () => {
  const e = { topic: 'proc/stdout-batch', step: 'build', lines: ['\u001b[31merror: x\u001b[0m', 'ok'] }
  const r = linesOfEvent(e, channelOf)
  assert.equal(r.tab, 'build')
  assert.equal(r.lines.length, 2)
  assert.equal(r.lines[0].plain, 'error: x')
  assert.equal(r.lines[0].tone, 'alert')
  assert.equal(r.lines[1].tone, 'normal')
})

test('linesOfEvent：step-enter/exit 生成 marker 行；不可归类返回 null', () => {
  const enter = linesOfEvent({ topic: 'run/step-enter', step: 'flash' }, channelOf)
  assert.equal(enter.lines[0].kind, 'marker')
  assert.match(enter.lines[0].raw, /进入步骤 flash/)

  const exit = linesOfEvent({ topic: 'run/step-exit', step: 'flash', ok: false, duration_s: 1.234, detail: 'boom' }, channelOf)
  assert.match(exit.lines[0].raw, /✗ 退出步骤 flash  用时 1\.23s  boom/)

  assert.equal(linesOfEvent({ topic: 'run/start' }, () => null), null)
})

test('LogRing：容量裁剪 / O(1) 计数 / 订阅', () => {
  const ring = new LogRing(3)
  let calls = 0
  ring.subscribe(() => calls++)

  const line = (tone) => ({ raw: 'x', plain: 'x', tone, step: 'build', kind: 'line' })
  ring.push([line('alert'), line('normal'), line('normal')])
  assert.deepEqual(ring.stats, { lines: 3, alerts: 1, dropped: 0 })

  ring.push([line('warn'), line('alert')])
  assert.deepEqual(ring.stats, { lines: 3, alerts: 1, dropped: 2 })
  assert.equal(calls, 2)

  ring.clear()
  assert.deepEqual(ring.stats, { lines: 0, alerts: 0, dropped: 0 })
})

test('LogBook：ring 工厂 / push 归类 / local 与 history 来源标记', () => {
  const book = new LogBook(channelOf)
  assert.deepEqual(book.channels(), [])

  book.push({ topic: 'serial/line', line: 'dev says hi' })
  assert.deepEqual(book.channels(), ['serial'])
  assert.equal(book.ring('serial').snapshot()[0].step, 'monitor')

  book.local('serial', 'TX → ping')
  assert.equal(book.ring('serial').snapshot().at(-1).step, 'manual')

  book.history('serial', [{ text: 'old 1' }, { text: 'old 2', tone: 'warn' }])
  assert.equal(book.counts().serial.lines, 4)

  book.clearAll()
  // 通道保留、内容归零（导航徽标仍要显示空通道）
  assert.deepEqual(book.counts(), { serial: { lines: 0, alerts: 0, dropped: 0 } })
})
