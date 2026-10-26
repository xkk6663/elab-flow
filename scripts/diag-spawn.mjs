/** 诊断：手动 spawn 观察 stdout 全量输出与进程存活。 */
import { spawn } from 'node:child_process'

const root = process.argv[2] ?? process.cwd()
const child = spawn('python', ['-u', '-m', 'cockpit.server', '--port', '0', '--reload'], {
  cwd: root,
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: `${root}/services` },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (d) => console.log('[out]', JSON.stringify(d)))
child.stderr.on('data', (d) => console.log('[err]', JSON.stringify(d)))
child.once('error', (e) => console.log('[spawn error]', e.message))
child.once('exit', (c, s) => console.log('[exit]', c, s))
setTimeout(async () => {
  console.log('[alive]', child.exitCode === null, 'pid', child.pid)
  const m = /:(\d+)/.exec(process.env.LAST_PORT ?? '')
  child.kill()
  process.exit(0)
}, 4000)
