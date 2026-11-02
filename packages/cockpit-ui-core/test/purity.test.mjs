/**
 * 共享层纯净门禁（方案 §6.5 G1/G2）：
 *   - 不得 import react / 业务层 / 任一宿主包；
 *   - 不得 fetch / EventSource / node: 内置模块（保证能被两侧内联成纯函数）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.ts$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(SRC)
const rel = (f) => f.slice(SRC.length + 1).replace(/\\/g, '/')

test('G1：不得 import react / 业务层 / 插件包', () => {
  const FORBIDDEN = [/from\s+['"]react['"]/, /from\s+['"][^'"]*services\/elab/, /from\s+['"][^'"]*\/cockpit\//, /from\s+['"][^'"]*dsh-elab-cockpit/]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const re of FORBIDDEN) {
      const m = src.match(re)
      assert.equal(m, null, `${rel(f)} 违反共享层边界: ${m?.[0]}`)
    }
  }
})

test('G2：不得做网络 I/O 或依赖 node: 内置模块', () => {
  const FORBIDDEN = [/\bfetch\s*\(/, /\bnew\s+EventSource\s*\(/, /from\s+['"]node:/]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const re of FORBIDDEN) {
      const m = src.match(re)
      assert.equal(m, null, `${rel(f)} 违反纯函数约束: ${m?.[0]}`)
    }
  }
})
