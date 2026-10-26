/**
 * E2E 冒烟：真起 HTTP 服务 → 真发起请求 → 打印响应。
 *   node --experimental-strip-types packages/dsh-elab-cockpit/scripts/smoke-discover.mjs <elabRoot>
 *
 * 用最小 ctx 假件挂上 `/elab/api/discover`，验证"路由 + fence + JSON"整条链路，
 * 而不是只测纯函数。
 */
import { createServer } from 'node:http'

import { applyDiscover } from '../src/host/discover-route.ts'

const elabRoot = process.argv[2] ?? process.cwd()
const routes = []

const ctx = {
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  // 演示 fence：带上 token 头才放行（真实环境由 DSH connection 服务负责）
  connection: { requestRejection: (req) => (req.headers['x-smoke'] === 'ok' ? undefined : { denied: true }) },
  sessions: { get: () => undefined },
  workingDirectory: { get: () => undefined },
  logger: { warn: (m) => console.error('[warn]', m) },
  effect: () => {},
  get: () => undefined,
}

applyDiscover(ctx, { elabRoot })

const server = createServer((req, res) => {
  const route = routes.find((r) => r.path === new URL(req.url, 'http://x').pathname)
  if (route === undefined) { res.statusCode = 404; res.end('no route'); return }
  void route.handler(req, res)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

async function hit(label, url, headers = {}) {
  const res = await fetch(url, { headers })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  console.log(`\n### ${label} → HTTP ${res.status}`)
  if (typeof body === 'string') { console.log(body); return }
  console.log(JSON.stringify({
    ok: body.ok,
    scanRoot: body.scanRoot,
    elabRoot: body.elabRoot,
    adaptedCount: body.adaptedCount,
    cached: body.cached,
    truncated: body.truncated,
    dirsVisited: body.dirsVisited,
    elapsedMs: body.elapsedMs,
    candidates: (body.candidates ?? []).map((c) => `${c.dirname}@d${c.depth}${c.adaptedAs ? `(已接入:${c.adaptedAs})` : ''}`),
    error: body.error,
  }, null, 2))
}

await hit('无 token（应 403）', `${base}/elab/api/discover`)
await hit('有 token（真扫描）', `${base}/elab/api/discover`, { 'x-smoke': 'ok' })
await hit('再请求（应命中缓存）', `${base}/elab/api/discover`, { 'x-smoke': 'ok' })
await hit('refresh=1（绕过缓存）', `${base}/elab/api/discover?refresh=1`, { 'x-smoke': 'ok' })

const post = await fetch(`${base}/elab/api/discover`, { method: 'POST', headers: { 'x-smoke': 'ok' } })
console.log(`\n### POST → HTTP ${post.status} Allow=${post.headers.get('allow')}`)

server.close()
