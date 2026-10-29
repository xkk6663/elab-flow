/**
 * RunArbiter 单测（§6.2）：单飞互斥 / human-busy / 惰性活性回收 / attach-run。
 * 不起真进程；isRunActive 用可控行列。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RunArbiter } from '../src/domain/arbiter.ts'

test('空闲时 acquire 成功；第二个请求 busy 且带 holder', async () => {
  const arbiter = new RunArbiter(async (run) => run === 'r-1') // r-1 挂起后视为在跑
  const a = await arbiter.tryAcquire('root-1', 'human', ['build'])
  assert.deepEqual(a, { ok: true })
  arbiter.attachRun('root-1', 'r-1')

  const b = await arbiter.tryAcquire('root-1', 'agent', ['build'])
  assert.equal(b.ok, false)
  if (!b.ok) {
    // human 持有 + agent 请求 = human-busy（§6.2 规则 3，不是普通 busy）
    assert.equal(b.code, 'human-busy')
    assert.deepEqual(b.holder, { run: 'r-1', actor: 'human', steps: ['build'] })
  }
  assert.deepEqual(arbiter.current(), { rootKey: 'root-1', run: 'r-1', actor: 'human', steps: ['build'] })
})

test('§6.2 规则 3：人工 run 进行中，agent 请求 → human-busy + nextAction', async () => {
  const arbiter = new RunArbiter(async () => true)
  assert.deepEqual(await arbiter.tryAcquire('r', 'human', ['build']), { ok: true })
  arbiter.attachRun('r', 'r-7f')
  const b = await arbiter.tryAcquire('r2', 'agent', ['build'])
  assert.equal(b.ok, false)
  if (!b.ok) {
    assert.equal(b.code, 'human-busy')
    assert.match(String(b.nextAction), /取消/)
  }
})

test('§6.2 规则 4 前提：agent run 进行中，human 请求是普通 busy（可取消后重试）', async () => {
  const arbiter = new RunArbiter(async () => true)
  await arbiter.tryAcquire('r', 'agent', ['build'])
  arbiter.attachRun('r', 'r-a')
  const b = await arbiter.tryAcquire('r2', 'human', ['build'])
  assert.equal(b.ok, false)
  if (!b.ok) assert.equal(b.code, 'busy')
})

test('惰性回收：被持有的 run 已从活动列表消失 → 新请求直接成功', async () => {
  let active = true
  const arbiter = new RunArbiter(async () => active)
  await arbiter.tryAcquire('r', 'human', ['build'])
  arbiter.attachRun('r', 'r-1')
  active = false // run 结束
  const b = await arbiter.tryAcquire('r2', 'agent', ['build'])
  assert.deepEqual(b, { ok: true })
  arbiter.attachRun('r2', 'r-2')
  assert.deepEqual(arbiter.current()?.run, 'r-2')
})

test('活性查询抛错按“仍占用”保守处理', async () => {
  const arbiter = new RunArbiter(async () => {
    throw new Error('cockpit down')
  })
  await arbiter.tryAcquire('r', 'human', ['build'])
  arbiter.attachRun('r', 'r-1')
  const b = await arbiter.tryAcquire('r2', 'agent', ['build'])
  assert.equal(b.ok, false)
})

test('spawn 失败：releaseIfPending 撤销未回填的占用；已回填的不受影响', async () => {
  const arbiter = new RunArbiter(async () => false)
  await arbiter.tryAcquire('r1', 'human', ['build'])
  arbiter.releaseIfPending('r1')
  assert.equal(arbiter.current(), null, '未回填 run 的占用应被撤销')

  await arbiter.tryAcquire('r2', 'human', ['build'])
  arbiter.attachRun('r2', 'r-2')
  arbiter.releaseIfPending('r2')
  assert.equal(arbiter.current()?.run, 'r-2', '已回填的占用不受 releaseIfPending 影响')
  arbiter.release('r-2')
  assert.equal(arbiter.current(), null)
})

test('release(run) 只释放对应 run', async () => {
  const arbiter = new RunArbiter(async () => true)
  await arbiter.tryAcquire('r', 'human', ['build'])
  arbiter.attachRun('r', 'r-1')
  arbiter.release('r-other')
  assert.equal(arbiter.current()?.run, 'r-1')
  arbiter.release('r-1')
  assert.equal(arbiter.current(), null)
})
