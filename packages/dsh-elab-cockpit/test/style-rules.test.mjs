/**
 * §5.5.4 硬规则门禁（自动化，替代 stylelint —— client 无 CSS 管线）：
 *
 *  1. 禁止字面色值（#rgb… / rgb( / hsl(）；唯一例外：theme/dsw-map.ts 的
 *     ANSI 16 色板（§5.5.3「唯一不来自 DSW 的一族」）。
 *  2. `--dsw-*` / `--dsh-*` 只允许出现在 theme/dsw-map.ts。
 *  3. 组件引用的每个 `--elab-*` 变量必须在 dsw-map.ts 里有定义。
 *
 * 违例即测试失败（CI 与本地 `node --test` 同门禁）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'adapters', 'dsh-web')
const MAP_FILE = /theme[/\\]dsw-map\.ts$/

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(tsx|ts)$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(CLIENT_DIR)
const mapSrc = readFileSync(files.find((f) => MAP_FILE.test(f)), 'utf8')
const componentFiles = files.filter((f) => !MAP_FILE.test(f))

test('硬规则 1：client 源码无字面色值（ANSI 色板仅限 dsw-map.ts）', () => {
  const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g
  for (const f of componentFiles) {
    const src = readFileSync(f, 'utf8')
    const hits = [...src.matchAll(COLOR_RE)].filter((m) => m[0] !== 'currentColor')
    assert.deepEqual(hits, [], `${f} 出现字面色值: ${hits.map((h) => h[0]).join(', ')}`)
  }
})

test('硬规则 2：--dsw-* / --dsh-* 只出现在 theme/dsw-map.ts', () => {
  for (const f of componentFiles) {
    const src = readFileSync(f, 'utf8')
    const hits = [...src.matchAll(/--(dsw|dsh)-[\w-]+/g)].map((h) => h[0])
    assert.deepEqual(hits, [], `${f} 出现宿主令牌直读（应改用 --elab-* 别名）: ${[...new Set(hits)].join(', ')}`)
  }
  assert.ok(mapSrc.includes('--dsw-alias-'), 'dsw-map.ts 应包含 --dsw-alias-* 映射')
})

test('硬规则 3：组件引用的 --elab-* 都在 dsw-map.ts 中定义', () => {
  const defined = new Set([...mapSrc.matchAll(/(--elab-[\w-]+)\s*:/g)].map((m) => m[1]))
  // ANSI 16 色由 ansiBlock() 从 ANSI_DARK / ANSI_LIGHT 数组生成，源码里没有字面定义；
  // 名字取自数组首列（`['bright-cyan', '#…']`），与生成逻辑同源。
  for (const m of mapSrc.matchAll(/^\s*\['([a-z-]+)', '#[0-9a-fA-F]{3,8}'\],/gm)) {
    defined.add(`--elab-ansi-${m[1]}`)
  }
  assert.ok(defined.size >= 20, `dsw-map.ts 定义数异常: ${defined.size}`)
  for (const f of componentFiles) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/var\((--elab-[\w-]+)\)/g)) {
      assert.ok(defined.has(m[1]), `${f} 引用了未定义的 ${m[1]}（应在 dsw-map.ts 补映射）`)
    }
  }
})
