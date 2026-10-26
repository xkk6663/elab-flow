import { createServer } from 'node:http'
import { apply } from './lib/index.js'
const routes = []
const ctx = { webServer: { register: (r) => { routes.push(r); return () => {} } }, connection: { requestRejection: () => undefined }, effect: () => {} }
const dispose = apply(ctx, { elabRoot: 'C:/Users/xiao1/Desktop/ELAB/dsh-elab-flow' })
const srv = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  const r = routes.find((x) => x.path === p)
  if (!r) { res.statusCode = 404; res.end('nope'); return }
  void r.handler(req, res)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`
console.log('routes:', routes.map(r => r.path).join(', '))
const a = await (await fetch(`${base}/elab-iframe/host`)).json()
console.log('host(before):', JSON.stringify(a))
const b = await (await fetch(`${base}/elab-iframe/url`)).json()
console.log('url:', JSON.stringify(b))
if (b.ok) {
  const r = await fetch(b.url)
  console.log('iframe fetch status:', r.status, '| content-type:', r.headers.get('content-type'))
  const html = await r.text()
  console.log('index.html 含 root:', html.includes('id="root"'), '| bytes:', html.length)
}
dispose(); srv.close()
await new Promise(r => setTimeout(r, 1200))
