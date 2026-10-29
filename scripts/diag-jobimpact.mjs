/** 验证：把 cockpit 进程放进 Job 后，服务是否还能响应。 */
import { spawn } from 'node:child_process'
import { armJobForPid } from '../src/adapters/kernel-process/job-object.ts'

const root = process.argv[2]
const useJob = process.argv[3] !== 'nojob'

const child = spawn('python', ['-u', '-m', 'cockpit.server', '--port', '0', '--reload'], {
  cwd: root,
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: `${root}/services` },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let port
let buf = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => console.log('[stderr]', String(d).slice(0, 300)))
child.stdout.on('data', async (d) => {
  buf += d
  if (port === undefined) {
    const line = buf.split('\n').find((l) => l.includes('127.0.0.1:') && l.includes('监听'))
    if (line) {
      port = Number(line.slice(line.lastIndexOf(':') + 1).replace(/[^0-9]/g, ''))
      console.log('port =', port, '| useJob =', useJob)
      if (useJob) {
        const r = await armJobForPid(child.pid)
        console.log('armJob =>', JSON.stringify(r))
      }
      void probe()
    }
  }
})

async function probe() {
  for (let i = 0; i < 15; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/capabilities`, { signal: AbortSignal.timeout(1200) })
      console.log(`try ${i}: HTTP ${r.status}`)
      if (r.ok) {
        console.log('RESULT: OK')
        child.kill()
        process.exit(0)
      }
    } catch (e) {
      console.log(`try ${i}: FAIL ${e.cause?.code ?? e.message}`)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  console.log('RESULT: never reachable')
  child.kill()
  process.exit(1)
}
