/**
 * §16 分层守卫：工具层（packages/dsh-elab-cockpit）不得依赖业务代码。
 *
 * 唯一合法缝隙 = loopback HTTP ICD（运行时 fetch），任何静态 import 都不该
 * 指向业务仓的 services/elab 或 cockpit 前端。违例即测试失败（CI 同门禁）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p)
  }
  return out
}

test('§16 工具层不得 import 业务层（services/elab、cockpit 前端、业务仓路径）', () => {
  const FORBIDDEN = [/from\s+['"][^'"]*services\/elab/, /from\s+['"][^'"]*\/cockpit\//, /require\(\s*['"][^'"]*services\/elab/]
  for (const f of walk(PKG_DIR)) {
    const src = readFileSync(f, 'utf8')
    for (const re of FORBIDDEN) {
      const m = src.match(re)
      assert.equal(m, null, `${f} 出现业务层依赖（应改走 loopback HTTP ICD）: ${m?.[0]}`)
    }
  }
})

test('§16 工具层 src 的相对 import 不得逃出包根', () => {
  for (const f of walk(PKG_DIR)) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+['"](\.\.\/)+/g)) {
      const depth = (m[1].match(/\.\.\//g) ?? []).length
      // src/client/** 与 src/host/** 距包根最多 3 层（src/client/api/x.ts → ../../..）
      assert.ok(depth <= 3, `${f} 相对 import 层级过深（越出包根）: ${m[0]}…`)
    }
  }
})
