/**
 * `/elab/env` 探测单测 —— 白名单 / 失败隔离 / 候选降级。
 *
 * 全部用注入的 run（不打真命令），保证测试不依赖本机装了什么。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROBE_COMMANDS, probeEnv, runProbe } from '../src/adapters/env/probe.ts'

test('白名单：只允许固定命令，其余直接拒绝（不 spawn）', async () => {
  const r = await runProbe('curl', ['--version'], 1000)
  assert.equal(r.ok, false)
  assert.match(r.error, /白名单/)
  for (const cmd of PROBE_COMMANDS) {
    assert.equal(typeof cmd, 'string')
  }
})

test('python 候选降级：python 失败 → python3 可用', async () => {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'python') return { ok: false, error: 'not found' }
    if (cmd === 'python3') return { ok: true, version: 'Python 3.12.1' }
    if (cmd === 'git') return { ok: true, version: 'git version 2.40' }
    return { ok: false, error: 'missing' }
  }
  const env = await probeEnv({ run })
  assert.equal(env.ok, true)
  assert.equal(env.python.path, 'python3')
  assert.equal(env.python.version, 'Python 3.12.1')
  assert.ok(calls.includes('python3 --version'))
})

test('失败隔离：单项失败不影响其它项；无 python 时 pyserial 直接判失败', async () => {
  const run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    if (cmd.startsWith('python') || cmd === 'py') return { ok: false, error: 'no python' }
    if (line === 'git --version') return { ok: true, version: 'git version 2.40' }
    return { ok: false, error: 'missing' }
  }
  const env = await probeEnv({ run })
  assert.equal(env.ok, false)
  assert.equal(env.python.ok, false)
  assert.equal(env.git.ok, true) // 单项失败不连坐
  assert.equal(env.pyserial.ok, false)
  assert.match(env.pyserial.error, /python 不可用/)
})

test('pyserial 借用选中的 python 路径探测', async () => {
  const py = 'C:/Python312/python.exe'
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === py && args[0] === '--version') return { ok: true, version: 'Python 3.12.1' }
    if (cmd === py && args[0] === '-c') return { ok: true, version: '3.5' }
    return { ok: false, error: 'missing' }
  }
  const env = await probeEnv({ pythonPath: py, run })
  assert.equal(env.python.path, py)
  assert.equal(env.pyserial.ok, true)
  assert.equal(env.pyserial.version, '3.5')
  assert.ok(calls.includes(`${py} -c import serial;print(serial.__version__)`))
})

test('超时参数原样传给命令执行层', async () => {
  const seen = []
  const run = async (_cmd, _args, timeoutMs) => {
    seen.push(timeoutMs)
    return { ok: true, version: 'x' }
  }
  await probeEnv({ timeoutMs: 1234, run })
  assert.ok(seen.length >= 5)
  for (const t of seen) assert.equal(t, 1234)
})
