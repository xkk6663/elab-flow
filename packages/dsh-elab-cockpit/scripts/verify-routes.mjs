/**
 * 端到端：真起 HTTP 服务，挂上 /elab/api + /elab/events + /elab/host，
 * 走一遍"列工程 → 起 run → 读 SSE → 健康"。
 */
import { createServer } from 'node:http'

import { apply } from '../src/app/host-app.ts'

const root = process.argv[2] ?? process.cwd()
const routes = []

const ctx = {
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  connection: { requestRejection: (req) => (req.headers['x-smoke'] === 'ok' ? undefined : { denied: true }) },
  sessions: { get: () => undefined },
  workingDirectory: { get: () => undefined },
  logger: { warn: (m) => console.error('[warn]', m), info: (m) => console.log('[info]', m) },
  effect: (fn) => { void fn },
  get: () => undefined,
}

const dispose = apply(ctx, { config: { elabRoot: root } })

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  // prefix 优先
  const exact = routes.find((r) => r.kind === 'exact' && r.path === path)
  const prefix = routes.find((r) => r.kind === 'prefix' && (path === r.path || path.startsWith(`${r.path}/`)))
  const route = exact ?? prefix
  if (route === undefined) { res.statusCode = 404; res.end('no route'); return }
  void route.handler(req, res)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
const H = { 'x-smoke': 'ok' }

async function j(url, init) {
  const r = await fetch(url, init)
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t.slice(0, 200) } }
}

console.log('\n### 1. 无 token → 403')
console.log((await j(`${base}/elab/api/capabilities`)).status)

console.log('\n### 2. /elab/host 健康')
const host = await j(`${base}/elab/host`, { headers: H })
console.log(JSON.stringify(host.body))

console.log('\n### 3. /elab/api/capabilities（首次会拉起 cockpit）')
const caps = await j(`${base}/elab/api/capabilities`, { headers: H })
console.log('status', caps.status, '| schema', caps.body?.schema_version, '| python', caps.body?.python?.version)

console.log('\n### 4. /elab/api/projects')
const projs = await j(`${base}/elab/api/projects`, { headers: H })
console.log('status', projs.status, '| n =', (projs.body?.projects ?? projs.body?.cards ?? []).length)

console.log('\n### 5. 白名单外端点 → 404')
console.log((await j(`${base}/elab/api/__proto__`, { headers: H })).status)

console.log('\n### 6. 方法不允许 → 405')
console.log((await j(`${base}/elab/api/projects`, { method: 'DELETE', headers: H })).status)

console.log('\n### 7. 起一个 run（actor 注入为 human）')
const run = await j(`${base}/elab/api/run`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ project: 'at32_test', steps: ['build'] }),
})
console.log('status', run.status, '| run', run.body?.run, '| actor', run.body?.actor)
const runId = run.body?.run

console.log('\n### 8. 读 SSE（前 400ms）')
if (runId) {
  const ac = new AbortController()
  const resp = await fetch(`${base}/elab/events?run=${encodeURIComponent(runId)}&from=0`, {
    headers: H, signal: ac.signal,
  })
  console.log('sse status', resp.status, '| content-type', resp.headers.get('content-type'))
  const reader = resp.body.getReader()
  let text = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 6000) {
    const { done, value } = await reader.read()
    if (done) break
    text += Buffer.from(value).toString('utf8')
    if (text.includes('stream/closed') || text.includes('"run/end"')) break
  }
  ac.abort()
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1].trim())
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].length
  console.log('收到 event 行:', events.length, '| 带 id 帧:', ids)
  console.log('topic 抽样:', [...new Set(events)].slice(0, 8).join(', '))
}

console.log('\n### 9. /elab/host 再看一次（应 running=true）')
console.log(JSON.stringify((await j(`${base}/elab/host`, { headers: H })).body))

console.log('\n--- 关闭 ---')
dispose()
server.close()
await new Promise((r) => setTimeout(r, 1200))
