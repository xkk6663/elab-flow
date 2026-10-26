/**
 * Host 路由层单测：fence / 白名单 / 方法 / actor 注入 / 端口解析 / 仓根判定。
 * 不真起 Python（那属于 verify-routes.mjs 的端到端职责）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerApiRoute, registerEventsRoute } from '../src/host/routes.ts'
import { apply as applyHostPackage } from '../src/index.ts'
import { looksLikeElabRoot, parsePortFromBanner, resolvePython } from '../src/host/host-process.ts'

function makeCtx({ reject = false } = {}) {
  const routes = []
  return {
    routes,
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => (reject ? { denied: true } : undefined) },
    sessions: { get: () => undefined },
    workingDirectory: { get: () => undefined },
    logger: { warn: () => {}, info: () => {} },
    effect: () => {},
    get: () => undefined,
  }
}

const deps = (overrides = {}) => ({
  ensureHost: async () => ({ baseUrl: 'http://127.0.0.1:9', info: { port: 9, job: 'armed', bootMs: 1 } }),
  config: () => ({ elabRoot: 'auto', pythonPath: 'auto', idleKillSec: 1800, retention: {} }),
  ...overrides,
})

function req(method, url, body) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  r.method = method
  r.url = url
  r.headers = {}
  return r
}

function res() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    on() {},
    end(b) { this.body = b },
    get json() { return JSON.parse(this.body) },
  }
}

async function call(route, method, url, body) {
  const r = res()
  await route.handler(req(method, url, body), r)
  return r
}

test('fence 拒绝 → 403（API 与 SSE 都要）', async () => {
  const ctx = makeCtx({ reject: true })
  registerApiRoute(ctx, deps())
  registerEventsRoute(ctx, deps())
  const a = await call(ctx.routes[0], 'GET', '/elab/api/capabilities')
  const b = await call(ctx.routes[1], 'GET', '/elab/events?run=r-1')
  assert.equal(a.statusCode, 403)
  assert.equal(b.statusCode, 403)
})

test('白名单：未知端点 404，已知 GET 通过', async () => {
  const ctx = makeCtx()
  registerApiRoute(ctx, deps())
  assert.equal((await call(ctx.routes[0], 'GET', '/elab/api/nope')).statusCode, 404)
  assert.equal((await call(ctx.routes[0], 'GET', '/elab/api/capabilities')).statusCode, 502) // 端点合法但上游不可达
})

test('方法：DELETE → 405 + Allow 头', async () => {
  const ctx = makeCtx()
  registerApiRoute(ctx, deps())
  const r = await call(ctx.routes[0], 'DELETE', '/elab/api/projects')
  assert.equal(r.statusCode, 405)
  assert.equal(r.headers.allow, 'GET, POST')
})

test('POST 白名单只放行 run/cancel/serial/adapt', async () => {
  const ctx = makeCtx()
  registerApiRoute(ctx, deps())
  assert.equal((await call(ctx.routes[0], 'POST', '/elab/api/projects', '{}')).statusCode, 404)
  // cancel 合法（上游不可达 → 502，说明进了转发逻辑）
  assert.equal((await call(ctx.routes[0], 'POST', '/elab/api/cancel', '{"run":"r-1"}')).statusCode, 502)
})

test('SSE 缺 run → 400；非 GET → 405', async () => {
  const ctx = makeCtx()
  registerEventsRoute(ctx, deps())
  assert.equal((await call(ctx.routes[0], 'GET', '/elab/events')).statusCode, 400)
  assert.equal((await call(ctx.routes[0], 'POST', '/elab/events?run=r-1')).statusCode, 405)
})

test('上游不可达 → 503（ensureHost 抛错时）', async () => {
  const ctx = makeCtx()
  registerApiRoute(ctx, deps({ ensureHost: async () => { throw new Error('未找到 elab 仓库根') } }))
  const r = await call(ctx.routes[0], 'GET', '/elab/api/capabilities')
  assert.equal(r.statusCode, 503)
  assert.equal(r.json.error.code, 'host-unavailable')
})

test('parsePortFromBanner 解析真实横幅', () => {
  assert.equal(parsePortFromBanner('[cockpit] 监听 http://127.0.0.1:6338/'), 6338)
  assert.equal(parsePortFromBanner('[cockpit] 监听 http://localhost:80/x'), 80)
  assert.equal(parsePortFromBanner('[cockpit] ELAB_ROOT = C:/x'), undefined)
  assert.equal(parsePortFromBanner('[cockpit] 监听 http://127.0.0.1:0/'), undefined) // 0 不是有效端口
})

test('looksLikeElabRoot 需要 cockpit/server.py + services/elab', () => {
  assert.equal(looksLikeElabRoot(process.cwd()), true)
  assert.equal(looksLikeElabRoot('/definitely/not/elab'), false)
  assert.equal(looksLikeElabRoot('relative/path'), false)
})

test('resolvePython：显式值优先，auto 回落到 python', () => {
  assert.equal(resolvePython('C:/py/python.exe'), 'C:/py/python.exe')
  assert.equal(resolvePython('auto'), 'python')
  assert.equal(resolvePython(), 'python')
})

/** 临时搭一个最小 elab 仓根（cockpit/server.py + services/elab）。 */
function makeElabFixture() {
  const root = mkdtempSync(join(tmpdir(), 'elab-fixture-'))
  mkdirSync(join(root, 'cockpit'), { recursive: true })
  writeFileSync(join(root, 'cockpit', 'server.py'), '# fixture\n')
  mkdirSync(join(root, 'services', 'elab'), { recursive: true })
  return root
}

test('回归 2026-10-26：/elab/host 带 sessionId → 用会话 cwd 解析 elabRoot', async () => {
  const fixture = makeElabFixture()
  const ctx = makeCtx()
  // 仿真实宿主：服务经 ctx.get 提供（cordis 代理直读未 inject 属性会抛，§15.5c）
  ctx.get = (name) =>
    name === 'sessions'
      ? { get: (id) => (id === 's1' ? { header: { cwd: fixture } } : undefined) }
      : undefined
  applyHostPackage(ctx)
  const hostRoute = ctx.routes.find((r) => r.path === '/elab/host')
  assert.ok(hostRoute, 'apply 应注册 /elab/host')
  const withSession = await call(hostRoute, 'GET', '/elab/host?sessionId=s1')
  assert.equal(withSession.statusCode, 200)
  assert.equal(withSession.json.ok, true)
  assert.equal(withSession.json.elabRoot, fixture, 'auto 模式应取会话 cwd（向上找）')
  // 无 sessionId → 回退路径（进程 cwd 向上找），结果不等于会话仓根
  const without = await call(hostRoute, 'GET', '/elab/host')
  assert.notEqual(without.json.elabRoot, fixture)
})

test('回归 2026-10-26：/elab/api/* 与 /elab/events 把 sessionId 传给 ensureHost', async () => {
  const seen = []
  const trackingDeps = deps({
    ensureHost: async (sessionId) => {
      seen.push(sessionId)
      return { baseUrl: 'http://127.0.0.1:9', info: { port: 9, job: 'armed', bootMs: 1 } }
    },
  })
  const ctx = makeCtx()
  registerApiRoute(ctx, trackingDeps)
  registerEventsRoute(ctx, trackingDeps)
  await call(ctx.routes[0], 'GET', '/elab/api/capabilities?sessionId=s1')
  await call(ctx.routes[0], 'GET', '/elab/api/capabilities')
  await call(ctx.routes[1], 'GET', '/elab/events?run=r-1&sessionId=s2')
  assert.deepEqual(seen, ['s1', undefined, 's2'])
})

test('P5 串口互斥预判：onhw 步骤撞监视会话 → 409 serial-busy；纯 build 不拦', async () => {
  const mutex = { active: true, setOpen(v) { this.active = v }, isActive() { return this.active } }
  const ctx = makeCtx()
  registerApiRoute(ctx, deps({ serialMutex: mutex }))
  // flash 在 ONHW_STEPS 里 → 预判拦截
  const blocked = await call(ctx.routes[0], 'POST', '/elab/api/run?sessionId=s1', JSON.stringify({ project: 'p', steps: ['flash'] }))
  assert.equal(blocked.statusCode, 409)
  assert.equal(blocked.json.error.code, 'serial-busy')
  // build 不占串口 → 过门（上游不可达 → 502）
  const allowed = await call(ctx.routes[0], 'POST', '/elab/api/run?sessionId=s1', JSON.stringify({ project: 'p', steps: ['build'] }))
  assert.equal(allowed.statusCode, 502)
  // 关监视后 → 过门
  mutex.setOpen(false)
  const after = await call(ctx.routes[0], 'POST', '/elab/api/run?sessionId=s1', JSON.stringify({ project: 'p', steps: ['flash'] }))
  assert.equal(after.statusCode, 502)
})

test('P4 设置页：GET/POST /elab/config 热更新 + 持久化 + 白名单校验', async () => {
  const persistPath = join(tmpdir(), `elab-cfg-${Date.now()}.json`)
  const ctx = makeCtx()
  applyHostPackage(ctx, undefined, { persistPath })
  const cfgRoute = ctx.routes.find((r) => r.path === '/elab/config')
  assert.ok(cfgRoute, 'apply 应注册 /elab/config')

  // 初始值（行配置）
  const g1 = await call(cfgRoute, 'GET', '/elab/config')
  assert.equal(g1.statusCode, 200)
  assert.equal(g1.json.ok, true)
  assert.equal(g1.json.config.idleKillSec, 1800)

  // POST 合法字段 → 200 + 生效 + 落盘
  const p1 = await call(cfgRoute, 'POST', '/elab/config', JSON.stringify({ idleKillSec: 600, discoverMaxDepth: 4, bogus: 'x' }))
  assert.equal(p1.statusCode, 200)
  assert.equal(p1.json.config.idleKillSec, 600)
  assert.equal(p1.json.config.discoverMaxDepth, 4)
  assert.equal(JSON.parse(readFileSync(persistPath, 'utf8')).idleKillSec, 600, '应持久化到指定文件')

  // 范围夹取 + 非法字段剔除
  const p2 = await call(cfgRoute, 'POST', '/elab/config', JSON.stringify({ idleKillSec: 1, bogus: 1 }))
  assert.equal(p2.statusCode, 200)
  assert.equal(p2.json.config.idleKillSec, 60, '低于下限应夹到 60')

  // 无合法字段 → 400
  const p3 = await call(cfgRoute, 'POST', '/elab/config', JSON.stringify({ nope: 1 }))
  assert.equal(p3.statusCode, 400)

  // 非法 elabRoot（非 auto 且非绝对路径）→ 400
  const p4 = await call(cfgRoute, 'POST', '/elab/config', JSON.stringify({ elabRoot: 'relative/path' }))
  assert.equal(p4.statusCode, 400)

  rmSync(persistPath, { force: true })
})
