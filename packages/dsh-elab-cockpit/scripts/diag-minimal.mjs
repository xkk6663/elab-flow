/** 最小复现：spawn → 解析端口 → fetch，逐步打印。 */
import { spawn } from 'node:child_process'

const root = process.argv[2]
const child = spawn('python', ['-u', '-m', 'cockpit.server', '--port', '0', '--reload'], {
  cwd: root,
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: `${root}/services` },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let port
let buf = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (d) => {
  buf += d
  if (port === undefined && buf.includes('/')) {
    const line = buf.split('\n').find((l) => l.includes('127.0.0.1'))
    if (line) {
      const i = line.lastIndexOf(':')
      port = Number(line.slice(i + 1).replace(/[^0-9]/g, ''))
      console.log('parsed port =', port)
      void probe()
    }
  }
})
async function probe() {
  for (let i = 0; i < 20; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/capabilities`, { signal: AbortSignal.timeout(1500) })
      console.log(`try ${i}: HTTP ${r.status}`)
      if (r.ok) {
        const j = await r.json()
        console.log('OK schema=', j.schema_version)
        child.kill()
        process.exit(0)
      }
    } catch (e) {
      console.log(`try ${i}: FAIL`, e.cause?.code ?? e.message)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  child.kill()
  process.exit(1)
}
