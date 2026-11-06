/**
 * `elab_modbus` 门面的行为门禁（2026-11-06）。
 *
 * 守四件事，都是**不给测试就会悄悄退化**的：
 *  1. **写必须过两道闸**：用户没开 allowAgentWrite → 直接拒；开了但缺 confirm → 也拒。
 *     且两种拒绝都**不许发请求**（不能"先发出去再报错"，那是真动物理世界）。
 *  2. **参数只从契约里来**：fc/address/count 的缺省值、FC15/16 的 values JSON 校验。
 *  3. **URL 拼装**：status/transactions 的增量游标、map 的 project 查询参数。
 *  4. **身份头**：所有 POST 带 `x-elab-actor: agent`（面板据此显示"agent 在写"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { modbusAction } from '../src/adapters/dsh-tools/modbus-ops.ts'

/** 装一个假内核：记录每次请求，统一回 200 + JSON。 */
function stubKernel(t, reply = { ok: true }) {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      headers: init?.headers ?? {},
    })
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  t.after(() => {
    globalThis.fetch = orig
  })
  return calls
}

/** 最小依赖桩：只有 ensureHost 与 allowAgentWrite 会被 modbus-ops 用到。 */
function deps(allow = false) {
  return {
    ensureHost: async () => ({ baseUrl: 'http://kernel.test' }),
    allowAgentWrite: () => allow,
  }
}

test('meta：GET 词汇表，不打开任何东西', async (t) => {
  const calls = stubKernel(t)
  await modbusAction(deps(), 'meta', {})
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url, 'http://kernel.test/api/modbus/meta')
})

test('status：project 与 after 都进查询串；两者都没有时不带问号', async (t) => {
  const calls = stubKernel(t)
  await modbusAction(deps(), 'status', { project: 'P1', after: 7 })
  assert.equal(calls[0].url, 'http://kernel.test/api/modbus/state?project=P1&after=7')

  await modbusAction(deps(), 'status', {})
  assert.equal(calls[1].url, 'http://kernel.test/api/modbus/state')
})

test('open：缺 project 直接拒（点表与串口参数都按工程取）', async () => {
  await assert.rejects(() => modbusAction(deps(), 'open', {}), /open 需要 project/)
})

test('open：allow_agent_write 来自用户设置而不是硬编码', async (t) => {
  const calls = stubKernel(t)
  await modbusAction(deps(false), 'open', { project: 'P1', port: 'COM9', baud: 9600 })
  assert.equal(calls[0].body.allow_agent_write, false)
  assert.equal(calls[0].body.port, 'COM9')
  assert.equal(calls[0].body.baud, 9600)

  await modbusAction(deps(true), 'open', { project: 'P1' })
  assert.equal(calls[1].body.allow_agent_write, true)
})

test('read：缺省 FC03 / addr 0 / count 1，且不发写请求', async (t) => {
  const calls = stubKernel(t)
  await modbusAction(deps(), 'read', {})
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, { fc: 3, address: 0, count: 1 })
  assert.equal(calls[0].headers['x-elab-actor'], 'agent')
})

test('write：未开 allowAgentWrite → agent-write-disabled，且一个请求都不发', async (t) => {
  const calls = stubKernel(t)
  const res = await modbusAction(deps(false), 'write', { fc: 6, address: 16, value: 1, confirm: true })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'agent-write-disabled')
  assert.ok(res.nextAction, '拒绝时必须给出能照做的下一步')
  assert.equal(calls.length, 0, '没权限时任何字节都不许上总线')
})

test('write：开了权限但缺 confirm → confirm-required，同样不发', async (t) => {
  const calls = stubKernel(t)
  const res = await modbusAction(deps(true), 'write', { fc: 6, address: 16, value: 1 })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'confirm-required')
  assert.equal(calls.length, 0)
})

test('write FC06：value 与 confirm/broadcast 一起下发', async (t) => {
  const calls = stubKernel(t)
  await modbusAction(deps(true), 'write', { fc: 6, address: 0x11, value: 8, confirm: true })
  assert.deepEqual(calls[0].body, {
    fc: 6,
    address: 17,
    confirm: true,
    broadcast: false,
    value: 8,
  })
})

test('write FC16：values 必须是 JSON 数组，非法/为空都在本地拦下', async (t) => {
  const calls = stubKernel(t)
  const bad = await modbusAction(deps(true), 'write', { fc: 16, address: 0, values: '1,0', confirm: true })
  assert.equal(bad.code, 'bad-json')
  const empty = await modbusAction(deps(true), 'write', { fc: 16, address: 0, values: '[]', confirm: true })
  assert.equal(empty.code, 'bad-json')
  assert.equal(calls.length, 0, '参数不合法时不许发请求')

  await modbusAction(deps(true), 'write', { fc: 16, address: 0, values: '[1,0,1]', confirm: true })
  assert.deepEqual(calls[0].body.values, [1, 0, 1])
})

test('start：groups 非法 JSON 本地拦；合法则透传', async (t) => {
  const calls = stubKernel(t)
  const bad = await modbusAction(deps(), 'start', { groups: 'fast,slow' })
  assert.equal(bad.code, 'bad-json')
  assert.equal(calls.length, 0)

  await modbusAction(deps(), 'start', { groups: '["fast"]' })
  assert.deepEqual(calls[0].body, { groups: ['fast'] })

  await modbusAction(deps(), 'start', {})
  assert.deepEqual(calls[1].body, {})
})

test('map：不带 map = 读点表（GET + project 查询参数）', async (t) => {
  const calls = stubKernel(t)
  await modbusAction(deps(), 'map', { project: 'STM32F411_modbus' })
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url, 'http://kernel.test/api/modbus/map?project=STM32F411_modbus')
})

test('map：保存要 allowAgentWrite + project + rev（乐观锁缺一不可）', async (t) => {
  const calls = stubKernel(t)
  const denied = await modbusAction(deps(false), 'map', { project: 'P1', map: '{}', rev: 1 })
  assert.equal(denied.code, 'agent-write-disabled')
  assert.equal(calls.length, 0)

  await assert.rejects(
    () => modbusAction(deps(true), 'map', { project: 'P1', map: '{}' }),
    /需要 rev/,
  )
  await assert.rejects(
    () => modbusAction(deps(true), 'map', { map: '{}', rev: 1 }),
    /需要 project/,
  )

  await modbusAction(deps(true), 'map', { project: 'P1', map: '{"points":[]}', rev: 3 })
  assert.deepEqual(calls[0].body, { project: 'P1', map: { points: [] }, rev: 3 })
})

test('close/stop：无参 POST，且带 agent 身份头', async (t) => {
  const calls = stubKernel(t)
  await modbusAction(deps(), 'close', {})
  await modbusAction(deps(), 'stop', {})
  assert.deepEqual(calls.map((c) => c.url), [
    'http://kernel.test/api/modbus/close',
    'http://kernel.test/api/modbus/stop',
  ])
  for (const c of calls) assert.equal(c.headers['x-elab-actor'], 'agent')
})

test('transactions：after 游标进查询串（增量拉流水）', async (t) => {
  const calls = stubKernel(t)
  await modbusAction(deps(), 'transactions', { after: 42 })
  assert.equal(calls[0].url, 'http://kernel.test/api/modbus/transactions?after=42')
})

test('内核报错原样抛出（不吞成 ok:false，agent 才能读到 code/message）', async (t) => {
  const orig = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'busy', message: '串口被占用' } }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })
  t.after(() => {
    globalThis.fetch = orig
  })
  await assert.rejects(() => modbusAction(deps(), 'read', { fc: 3 }), /串口被占用/)
})
