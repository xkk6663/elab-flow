/**
 * 端到端验证：spawn cockpit → 拿到端口 → 打 API → 杀进程 → 确认全树消失。
 *
 * 验证三件事：
 *   1. `-u` + UTF-8 + 端口解析都正确（否则会超时/乱码/解析失败）；
 *   2. Job Object 真的 armed；
 *   3. dispose 后进程树确实没了（含 python 子进程）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { CockpitHost, looksLikeElabRoot } from '../src/host/host-process.ts'

const execFileAsync = promisify(execFile)
const root = process.argv[2] ?? process.cwd()

console.log('root :', root)
console.log('looks like elab root:', looksLikeElabRoot(root))

const t0 = Date.now()
const host = await CockpitHost.start({ elabRoot: root })
const info = host.info
console.log(`started: pid=${info.pid} port=${info.port} bootMs=${info.bootMs} job=${info.job}`, info.jobReason ?? '')

const caps = await (await fetch(`${info.baseUrl}/api/capabilities`)).json()
console.log('capabilities: schema =', caps.schema_version, '| python =', caps.python?.version)

const projects = await (await fetch(`${info.baseUrl}/api/projects`)).json()
const cardCount = (projects.projects ?? projects.cards ?? []).length
console.log('projects:', cardCount)

// 记录 python 进程树
async function tree(pids) {
  const out = {}
  for (const pid of pids) {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`],
        { windowsHide: true },
      )
      out[pid] = stdout.trim().split(/\s+/).filter(Boolean)
    } catch { out[pid] = [] }
  }
  return out
}

const kids = await tree([info.pid])
console.log('children of cockpit:', JSON.stringify(kids))

console.log('disposing (关 Job → 应连带终结子进程)…')
await host.dispose()
await new Promise((r) => setTimeout(r, 1500))

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

console.log(`cockpit pid ${info.pid} alive: ${alive(info.pid)}`)
for (const list of Object.values(kids)) {
  for (const k of list) console.log(`  child ${k} alive: ${alive(Number(k))}`)
}
console.log(`总耗时: ${Date.now() - t0} ms`)
