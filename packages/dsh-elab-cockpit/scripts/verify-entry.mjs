/**
 * 从插件主入口 `apply()` 挂载，验证所有路由都被注册且可用。
 * 这是"装进 DSH 之前"的最后一道自测：入口契约 + 两条路由族。
 */
import { createServer } from 'node:http'

import { apply, name, inject, resolveConfig } from '../src/index.ts'

const root = process.argv[2] ?? process.cwd()
console.log('plugin name:', name, '| inject:', JSON.stringify(inject))
console.log('resolved config:', JSON.stringify(resolveConfig({ elabRoot: root }), null, 2))

const routes = []
const ctx = {
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  connection: { requestRejection: () => undefined },
  sessions: { get: () => undefined },
  workingDirectory: { get: () => undefined },
  logger: { warn: (m) => console.error('[warn]', m), info: (m) => console.log('[info]', m) },
  effect: () => {},
  get: () => undefined,
}

const dispose = apply(ctx, { elabRoot: root })
console.log('\n注册的路由:')
for (const r of routes) console.log(`  [${r.kind}] ${r.path}`)

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const exact = routes.find((r) => r.kind === 'exact' && r.path === path)
  const prefix = routes.find((r) => r.kind === 'prefix' && (path === r.path || path.startsWith(`${r.path}/`)))
  const route = exact ?? prefix
  if (!route) { res.statusCode = 404; res.end('no route'); return }
  void route.handler(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

async function get(path) {
  const r = await fetch(`${base}${path}`)
  const t = await r.text()
  try { return { s: r.status, b: JSON.parse(t) } } catch { return { s: r.status, b: t.slice(0, 120) } }
}

const host = await get('/elab/host')
console.log('\n/elab/host →', host.s, '| elabRoot', host.b.elabRoot)

const disc = await get('/elab/api/discover')
console.log('/elab/api/discover →', disc.s, '| 候选', disc.b.candidates?.length, '| 已接入', disc.b.adaptedCount)

const caps = await get('/elab/api/capabilities')
console.log('/elab/api/capabilities →', caps.s, '| schema', caps.b?.schema_version)

dispose()
server.close()
await new Promise((r) => setTimeout(r, 1500))
console.log('\n--- 已关闭 ---')
