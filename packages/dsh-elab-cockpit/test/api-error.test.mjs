/**
 * HTTP 客户端错误解析：内核的错误体必须**原样透传到 UI**。
 *
 * 回归背景（2026-11-05 实机）：探针被别的会话占着时 `POST /elab/api/debug/session`
 * 回 503 `debug-gdb-missing`，hint 是 `CMSIS-DAP command mismatch. Sent 0x0 received 0x5`。
 * 旧实现按 `body.error.code` 取值，而内核把 `code`/`hint` 放在**同级**、`error` 是字符串，
 * 结果 code 退化成 `http-503`、message 退化成 `HTTP 503`，界面上等于什么都没说。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { elabApi, ElabApiError } from '../src/adapters/kernel-http/icd-client.ts'

/** 临时替换 fetch，返回指定状态码与 body（字符串按原样发，用来测非 JSON） */
async function withFetch(status, body, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  })
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

/** 抓住 open 抛出的错误 */
async function grabOpenError() {
  try {
    await elabApi.debugOpen({ project: 'p1' })
  } catch (e) {
    return e
  }
  throw new Error('应该抛错但成功返回了')
}

test('调试错误体：code / message / hint 三者都保留', async () => {
  const body = {
    error: '连接 gdb server 失败：CMSIS-DAP command mismatch',
    code: 'debug-gdb-missing',
    message: '连接 gdb server 失败：CMSIS-DAP command mismatch',
    hint: 'CMSIS-DAP command mismatch. Sent 0x0 received 0x5',
  }
  const e = await withFetch(503, body, grabOpenError)
  assert.ok(e instanceof ElabApiError)
  assert.equal(e.code, 'debug-gdb-missing')       // 不再是 http-503
  assert.equal(e.message, body.message)           // 不再是 "HTTP 503"
  assert.equal(e.hint, body.hint)                 // 关键：hint 没被吃掉
  assert.equal(e.status, 503)
})

test('通用错误体 {"error": "人话"}：当成 message，code 退到 http-N', async () => {
  const e = await withFetch(400, { error: '未知项目：p9' }, grabOpenError)
  assert.equal(e.code, 'http-400')
  assert.equal(e.message, '未知项目：p9')
  assert.equal(e.hint, '')
})

test('嵌套形状 {"error": {code,message,hint}} 也认（兼容旧后端）', async () => {
  const e = await withFetch(409, { error: { code: 'debug-target-busy', message: '目标忙', hint: '先关掉那个会话' } }, grabOpenError)
  assert.equal(e.code, 'debug-target-busy')
  assert.equal(e.message, '目标忙')
  assert.equal(e.hint, '先关掉那个会话')
})

test('空 body：不崩，给出 HTTP-N 兜底', async () => {
  const e = await withFetch(502, '', grabOpenError)
  assert.equal(e.code, 'http-502')
  assert.equal(e.message, 'HTTP 502')
})

test('code 优先用顶层、hint 缺失时不产生空字段', async () => {
  const e = await withFetch(500, { error: '内核炸了', code: 'debug-error' }, grabOpenError)
  assert.equal(e.code, 'debug-error')
  assert.equal(e.message, '内核炸了')
  assert.equal(e.hint, '')
  assert.equal(e.status, 500)
})
