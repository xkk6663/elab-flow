/**
 * 双入口 SSE 单实例协调（adapters/dsh-web/events/run-events.ts）的离线单测。
 *
 * 背景：`CockpitPane` 会同时出现在原生右栏与 betterSidebar 底部工作台两个入口，
 * 每个入口各组装一个 service；若各开一条 `/elab/events`，同一个 run 会占掉两条
 * 上游 SSE 槽位（`MAX_SSE_CONNS` 是有限信号量）。本测试用假 EventSource 证明：
 *   ① 同 `(run, sessionId)` 只建一条流，事件广播给每个入口；
 *   ② 可见性取并集（关一个入口不断另一个）；
 *   ③ 最后一个订阅者释放才断开；
 *   ④ 不同 run / 不同会话各自独立。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRunEventsPort } from '../src/adapters/dsh-web/events/run-events.ts'

/** 假 EventSource：记录实例、可编程派发帧。 */
class FakeEventSource {
  static instances = []

  constructor(url) {
    this.url = url
    this.closed = false
    this.handlers = new Map()
    FakeEventSource.instances.push(this)
  }

  addEventListener(name, fn) {
    const arr = this.handlers.get(name) ?? []
    arr.push(fn)
    this.handlers.set(name, arr)
  }

  close() {
    this.closed = true
  }

  /** 按 topic 派发一条 SSE 帧（`message` 走 onmessage 兜底）。 */
  emit(topic, payload) {
    const ev = { data: JSON.stringify(payload) }
    if (topic === 'message') {
      this.onmessage?.(ev)
      return
    }
    for (const fn of this.handlers.get(topic) ?? []) fn(ev)
  }
}

globalThis.EventSource = FakeEventSource

/** 取本次测试新建的实例（模块级共享表跨用例，故按快照切片）。 */
function freshSources(before) {
  return FakeEventSource.instances.slice(before)
}

test('同 (run, sessionId) 只建一条流，事件广播给每个入口', () => {
  const before = FakeEventSource.instances.length
  const portA = createRunEventsPort()
  const portB = createRunEventsPort()
  const gotA = []
  const gotB = []
  const ca = portA.connect('r-share-1', 's1', { onEvent: (e) => gotA.push(e), onClosed: () => {} })
  const cb = portB.connect('r-share-1', 's1', { onEvent: (e) => gotB.push(e), onClosed: () => {} })

  const sources = freshSources(before)
  assert.equal(sources.length, 1, '两个入口必须共用同一条 SSE')
  assert.ok(sources[0].url.includes('run=r-share-1'))

  const e = { seq: 1, topic: 'run/step-enter', step: 'build' }
  sources[0].emit('run/step-enter', e)
  assert.deepEqual(gotA, [e])
  assert.deepEqual(gotB, [e])

  ca.dispose()
  cb.dispose()
})

test('可见性取并集：关一个入口不断另一个', () => {
  const before = FakeEventSource.instances.length
  const portA = createRunEventsPort()
  const portB = createRunEventsPort()
  const ca = portA.connect('r-share-2', 's1', { onEvent: () => {}, onClosed: () => {} })
  const cb = portB.connect('r-share-2', 's1', { onEvent: () => {}, onClosed: () => {} })
  const src = freshSources(before)[0]

  src.emit('run/step-enter', { seq: 1, topic: 'run/step-enter', step: 'build' })
  ca.setVisible(false)
  assert.equal(src.closed, false, '另一个入口仍可见 → 流必须保持')
  cb.setVisible(false)
  assert.equal(src.closed, true, '全部不可见 → 断开（不占上游槽位）')

  cb.setVisible(true)
  const src2 = freshSources(before)[1]
  assert.ok(src2 !== undefined && src2.url.includes('from=1'), '续传从 lastSeq 起')

  ca.dispose()
  cb.dispose()
  assert.equal(src2.closed, true)
})

test('最后一个订阅者释放才断开', () => {
  const before = FakeEventSource.instances.length
  const portA = createRunEventsPort()
  const portB = createRunEventsPort()
  const ca = portA.connect('r-share-3', 's1', { onEvent: () => {}, onClosed: () => {} })
  const cb = portB.connect('r-share-3', 's1', { onEvent: () => {}, onClosed: () => {} })
  const src = freshSources(before)[0]

  ca.dispose()
  assert.equal(src.closed, false, '仍有入口在 → 不释放')
  cb.dispose()
  assert.equal(src.closed, true)
})

test('不同 run / 不同会话各自独立', () => {
  const before = FakeEventSource.instances.length
  const port = createRunEventsPort()
  const c1 = port.connect('r-share-4', 's1', { onEvent: () => {}, onClosed: () => {} })
  const c2 = port.connect('r-share-5', 's1', { onEvent: () => {}, onClosed: () => {} })
  const c3 = port.connect('r-share-4', 's2', { onEvent: () => {}, onClosed: () => {} })
  const sources = freshSources(before)
  assert.equal(sources.length, 3)
  c1.dispose()
  c2.dispose()
  c3.dispose()
})

test('run 为 null 不建流', () => {
  const before = FakeEventSource.instances.length
  const c = createRunEventsPort().connect(null, 's1', { onEvent: () => {}, onClosed: () => {} })
  assert.equal(freshSources(before).length, 0)
  c.dispose()
})
