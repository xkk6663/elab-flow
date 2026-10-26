/**
 * route-guard 单测：幂等注册。
 *
 * 场景来自真实故障（2026-10-26）：`install_bundle` 的 enable 阶段新旧 fiber
 * 短暂并存，第二次注册同一 path 会让宿主抛 `duplicate exact route`，
 * 导致整行 activate 失败、Client 半也不加载。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerOnce, registeredRoutes } from '../src/host/route-guard.ts'

/** 假宿主：重复 path 一律抛 duplicate（与真实 webServer 行为一致）。 */
function makeHost() {
  const paths = new Set()
  const registered = []
  return {
    paths,
    registered,
    webServer: {
      register(route) {
        const key = `${route.kind}:${route.path}`
        if (paths.has(key)) {
          throw new Error(`webserver: duplicate exact route "${route.path}"`)
        }
        paths.add(key)
        registered.push(route.path)
        return () => {
          paths.delete(key)
          const i = registered.indexOf(route.path)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    },
  }
}

// 状态按 ctx 隔离（WeakMap），每个用例新建 host 即天然隔离，无需手动重置

test('首次注册成功，路由进宿主', () => {
  const host = makeHost()
  const dispose = registerOnce(host, { kind: 'exact', path: '/elab/host', handler: () => {} })
  assert.deepEqual(host.registered, ['/elab/host'])
  assert.deepEqual(registeredRoutes(host), ['exact:/elab/host'])
  dispose()
  assert.deepEqual(host.registered, [])
})

test('重复注册不抛错、不重复挂载（新旧 fiber 并存场景）', () => {
  const host = makeHost()
  const d1 = registerOnce(host, { kind: 'exact', path: '/elab/host', handler: () => {} })
  // 第二个 fiber 也来注册同一路径 —— 不应抛
  const d2 = registerOnce(host, { kind: 'exact', path: '/elab/host', handler: () => {} })
  assert.deepEqual(host.registered, ['/elab/host'], '宿主里只有一份')
  // 释放任意一个都不影响另一个的存在性（no-op 语义）
  d2()
  assert.deepEqual(host.registered, ['/elab/host'], 'no-op 释放不应移除路由')
  d1()
  assert.deepEqual(host.registered, [])
})

test('不同 path 互不影响', () => {
  const host = makeHost()
  registerOnce(host, { kind: 'exact', path: '/elab/host', handler: () => {} })
  registerOnce(host, { kind: 'prefix', path: '/elab/api', handler: () => {} })
  assert.deepEqual(host.registered.sort(), ['/elab/api', '/elab/host'])
})

test('同 path 不同 kind 视为不同路由', () => {
  const host = makeHost()
  registerOnce(host, { kind: 'exact', path: '/x', handler: () => {} })
  registerOnce(host, { kind: 'prefix', path: '/x', handler: () => {} })
  assert.equal(host.registered.length, 2)
})

test('宿主自身已有同名路由（别的插件占用）→ 静默让出，不炸', () => {
  const host = makeHost()
  // 先占用（模拟别的插件注册过）
  host.webServer.register({ kind: 'exact', path: '/taken', handler: () => {} })
  // 我们的守卫不知道，会尝试 register → 抛 duplicate → 应被吞掉
  const d = registerOnce(host, { kind: 'exact', path: '/taken', handler: () => {} })
  assert.equal(typeof d, 'function')
  assert.deepEqual(registeredRoutes(host).includes('exact:/taken'), false, '失败时应回滚登记')
  d() // 不应抛
})

test('释放后可以重新注册（重装成功路径）', () => {
  const host = makeHost()
  const d1 = registerOnce(host, { kind: 'exact', path: '/elab/host', handler: () => {} })
  d1()
  assert.deepEqual(registeredRoutes(host), [])
  const d2 = registerOnce(host, { kind: 'exact', path: '/elab/host', handler: () => {} })
  assert.deepEqual(host.registered, ['/elab/host'])
  d2()
})
