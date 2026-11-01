/**
 * 手工探针脚本（非测试）：对着真实仓库跑一次 discovery，看命中与耗时。
 *   node --experimental-strip-types packages/dsh-elab-cockpit/scripts/probe-discover.mjs <root>
 */
import { discoverProjects } from '../src/adapters/kernel-http/discovery.ts'

const root = process.argv[2] ?? process.cwd()
const r = await discoverProjects({ root })
console.log('root:       ', r.root)
console.log('dirsVisited:', r.dirsVisited, '| elapsedMs:', r.elapsedMs, '| truncated:', r.truncated)
console.log('candidates: ', r.candidates.length)
for (const c of r.candidates) {
  const gen = c.hints.ioc ?? c.hints.atwp ?? c.hints.generatorDir ?? '-'
  console.log(`  [d${c.depth}] ${c.dirname.padEnd(18)} gen=${String(gen).padEnd(16)} ld=${c.hints.linkerScripts.join(',') || '-'}`)
}
