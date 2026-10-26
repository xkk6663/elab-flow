/**
 * 诊断：宿主是否把 client bundle 提供给浏览器。
 *
 * 思路：DSH 的 client 半由 web-app 的 module loader 按 `dsh.client` 清单动态提供。
 * 这里直接抓 index.html（带认证）看它引用了哪些 client 脚本。
 *
 * 认证：DSH web 用一次性 token，从启动横幅/环境里拿。拿不到就只看能看的部分。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const profile = 'C:/Users/xiao1/.dsh/profiles/desktop'

// 1) 宿主如何在 boot 里列出 client 包？找它的清单产物
const candidates = [
  join(profile, '.plugin-manager'),
  join(profile, 'cordis.yml'),
]
for (const c of candidates) {
  try {
    const st = readdirSync(c)
    console.log(c, '->', st.slice(0, 5))
  } catch {
    console.log(c, '-> (不可读)')
  }
}

// 2) cordis.yml / patch 里 elab 行长什么样
try {
  const yml = readFileSync(join(profile, 'cordis.yml'), 'utf8')
  const has = yml.includes('elab')
  console.log('\ncordis.yml 含 elab:', has)
  if (has) {
    const lines = yml.split('\n')
    const i = lines.findIndex((l) => l.includes('elab'))
    console.log(lines.slice(Math.max(0, i - 3), i + 6).join('\n'))
  }
} catch (e) {
  console.log('cordis.yml 读不到:', e.message)
}
