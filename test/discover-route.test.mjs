/**
 * `/elab/api/discover` 接线层单测。
 *
 * 用**假 ctx**（只实现用到的成员）+ 真临时目录树，
 * 断言的是"边界与契约"：fence、方法、参数、缓存、cwd 降级链、变量求值。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  applyDiscover,
  expandRootExpr,
  findElabRoot,
  readAdaptedProjects,
  resolveSessionCwd,
} from '../src/adapters/kernel-http/discover-route.ts'

let ROOT
const norm = (p) => p.replace(/\\/g, '/').toLowerCase()

async function mk(path, body) {
  const abs = join(ROOT, path)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, body, 'utf8')
  return abs
}

before(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'elab-discover-'))
  // 一个 elab 仓库形态的树
  await mk('repo/elab.host.yaml', 'version: 1\n')
  await mk('repo/projects/alpha.yaml', 'name: alpha\nroot: ${ELAB_ROOT}/fw/alpha\n')
  await mk('repo/projects/beta.yaml', 'name: beta\nroot: ${ELAB_ROOT}/fw/beta\n')
  await mk('repo/fw/alpha/CMakeLists.txt', 'project(Alpha)\n')
  await mk('repo/fw/alpha/app.ioc', '')
  await mk('repo/fw/beta/CMakeLists.txt', 'set(CMAKE_PROJECT_NAME Beta)\n')
  await mk('repo/fw/comp/CMakeLists.txt', 'set(X 1)\n') // 子目录 CMake，不是根工程
  await mk('repo/fw/build/junk/CMakeLists.txt', 'project(Junk)\n') // 应被排除
})

after(async () => {
  if (ROOT !== undefined) await rm(ROOT, { recursive: true, force: true })
})

function fakeCtx({ reject = false, cwd, sessions: sessionsOverride } = {}) {
  const routes = []
  const sessions = sessionsOverride ?? { get: () => (cwd === undefined ? undefined : { header: { cwd } }) }
  const workingDirectory = { get: () => undefined }
  return {
    routes,
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => (reject ? { code: 'forbidden' } : undefined) },
    sessions,
    workingDirectory,
    logger: { warn: () => {} },
    effect: () => {},
    // 与真实宿主同形：服务经 ctx.get 提供（cordis 代理直读未 inject 属性会抛）
    get: (name) => (name === 'sessions' ? sessions : name === 'workingDirectory' ? workingDirectory : undefined),
  }
}

function makeReq(method, url) {
  const req = Readable.from([])
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(body) { this.body = body },
    get json() { return JSON.parse(this.body) },
  }
}

async function call(route, method, url) {
  const res = makeRes()
  await route.handler(makeReq(method, url), res)
  return res
}

test('未通过 fence → 403，且不触碰文件系统', async () => {
  const ctx = fakeCtx({ reject: true })
  applyDiscover(ctx, { elabRoot: join(ROOT, 'repo') })
  const res = await call(ctx.routes[0], 'GET', '/elab/api/discover')
  assert.equal(res.statusCode, 403)
  assert.equal(res.json.ok, false)
  assert.equal(res.json.error.code, 'forbidden')
})

test('非 GET → 405 且带 Allow 头', async () => {
  const ctx = fakeCtx()
  applyDiscover(ctx, { elabRoot: join(ROOT, 'repo') })
  const res = await call(ctx.routes[0], 'POST', '/elab/api/discover')
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET')
})

test('非法 sessionId → 400', async () => {
  const ctx = fakeCtx()
  applyDiscover(ctx, { elabRoot: join(ROOT, 'repo') })
  const res = await call(ctx.routes[0], 'GET', '/elab/api/discover?sessionId=../etc')
  assert.equal(res.statusCode, 400)
})

test('正常发现：排除 build/ 与子目录 CMake，标出已接入项', async () => {
  const ctx = fakeCtx()
  applyDiscover(ctx, { elabRoot: join(ROOT, 'repo'), cacheTtlMs: 0 })
  const res = await call(ctx.routes[0], 'GET', '/elab/api/discover')
  assert.equal(res.statusCode, 200)
  const body = res.json
  assert.equal(body.ok, true)
  assert.equal(body.scanRoot.source, 'elabRoot')
  assert.deepEqual(body.candidates.map((c) => c.dirname).sort(), ['alpha', 'beta'])
  // 两个 yaml 都用 ${ELAB_ROOT}，求值后都应标为已接入
  assert.equal(body.adaptedCount, 2)
  assert.equal(body.candidates.find((c) => c.dirname === 'alpha').adaptedAs, 'alpha')
  assert.equal(body.candidates.find((c) => c.dirname === 'beta').adaptedAs, 'beta')
  assert.equal(body.candidates[0].hints.ioc, 'app.ioc')
})

test('缓存命中：第二次请求 cached=true 且 refresh=1 可绕过', async () => {
  const ctx = fakeCtx()
  applyDiscover(ctx, { elabRoot: join(ROOT, 'repo'), cacheTtlMs: 60_000 })
  const first = await call(ctx.routes[0], 'GET', '/elab/api/discover')
  const second = await call(ctx.routes[0], 'GET', '/elab/api/discover')
  const forced = await call(ctx.routes[0], 'GET', '/elab/api/discover?refresh=1')
  assert.equal(first.json.cached, false)
  assert.equal(second.json.cached, true)
  assert.equal(forced.json.cached, false)
})

test('会话 cwd 优先于 elabRoot=auto', async () => {
  const ctx = fakeCtx({ cwd: join(ROOT, 'repo') })
  applyDiscover(ctx, { elabRoot: 'auto', cacheTtlMs: 0 })
  const res = await call(ctx.routes[0], 'GET', '/elab/api/discover?sessionId=abc123')
  assert.equal(res.json.scanRoot.source, 'session')
  assert.equal(norm(res.json.scanRoot.path), norm(join(ROOT, 'repo')))
  assert.equal(norm(res.json.elabRoot), norm(join(ROOT, 'repo')))
  assert.equal(res.json.adaptedCount, 2)
})

test('resolveSessionCwd 降级链：workingDirectory 优先于 header.cwd', () => {
  const ctx = {
    sessions: { get: () => ({ header: { cwd: 'C:/from-header' } }) },
    workingDirectory: { get: () => 'C:/from-wd' },
    get(name) { return name === 'sessions' ? this.sessions : name === 'workingDirectory' ? this.workingDirectory : undefined },
  }
  assert.equal(resolveSessionCwd(ctx, 's1'), 'C:/from-wd')
  const ctx2 = {
    sessions: { get: () => ({ header: { cwd: 'C:/from-header' } }) },
    workingDirectory: { get: () => undefined },
    get(name) { return name === 'sessions' ? this.sessions : name === 'workingDirectory' ? this.workingDirectory : undefined },
  }
  assert.equal(resolveSessionCwd(ctx2, 's1'), 'C:/from-header')
  assert.equal(resolveSessionCwd({ sessions: { get: () => undefined }, get: () => undefined }, 'x'), undefined)
  const ctx3 = {
    sessions: { get: () => ({ header: { cwd: 'relative/dir' } }) },
    workingDirectory: { get: () => undefined },
    get(name) { return name === 'sessions' ? this.sessions : name === 'workingDirectory' ? this.workingDirectory : undefined },
  }
  assert.equal(resolveSessionCwd(ctx3, 's1'), undefined)
})

test('findElabRoot 需要同时存在 projects/ 与 elab.host.yaml', async () => {
  const found = await findElabRoot(join(ROOT, 'repo/fw/alpha'))
  assert.equal(norm(found), norm(join(ROOT, 'repo')))
  assert.equal(await findElabRoot(join(ROOT, 'nowhere')), undefined)
})

test('readAdaptedProjects 求值 ${ELAB_ROOT}（本仓库全部 yaml 的真实写法）', async () => {
  await mk('repo2/elab.host.yaml', 'version: 1\n')
  await mk('repo2/projects/x.yaml', 'name: x\nroot: ${ELAB_ROOT}/somewhere\n')
  await mk('repo2/projects/y.yaml', 'name: y\nroot: ${ROOT}/elsewhere\n')
  await mk('repo2/projects/z.yaml', 'name: z\nroot: ${UNKNOWN_VAR}/nope\n')
  await mk('repo2/projects/rel.yaml', 'name: rel\nroot: fw/app\n')
  await mk('repo2/projects/bad.yaml', '::: not yaml :::\n')
  const list = await readAdaptedProjects(join(ROOT, 'repo2'))
  const byName = Object.fromEntries(list.map((e) => [e.name, e.root]))
  const base = norm(join(ROOT, 'repo2'))
  assert.equal(norm(byName.x), `${base}/somewhere`)
  assert.equal(norm(byName.y), `${base}/elsewhere`)
  assert.equal(byName.z, undefined) // 未识别变量 → 跳过，不瞎猜
  assert.equal(norm(byName.rel), `${base}/fw/app`) // 相对路径 → 相对 elabRoot
  assert.equal(byName.bad, undefined)
})

test('expandRootExpr 只认 ELAB_ROOT / ROOT', () => {
  const r = 'C:/repo'
  assert.equal(expandRootExpr('${ELAB_ROOT}/a', r), 'C:/repo/a')
  assert.equal(expandRootExpr('${ROOT}/b', r), 'C:/repo/b')
  assert.equal(expandRootExpr('${OTHER}/c', r), undefined)
  assert.equal(expandRootExpr('', r), undefined)
  assert.equal(expandRootExpr('C:/abs/d', r), 'C:/abs/d')
})
