/**
 * §16/§4.4 分层守卫：工具层（packages/dsh-elab-cockpit）的依赖方向门禁。
 *
 * 两级规则：
 *   A. 工具层 ↔ 业务层：唯一合法缝隙 = loopback HTTP ICD（运行时 fetch），
 *      任何静态 import 都不得指向业务仓（services/elab / cockpit 前端）。
 *   B. 插件内部分层（docs/架构调研 §4.4 六条，批 1/2 起生效）：
 *      1. domain/ 纯净：只能 import 同目录（'./xxx'）—— 零 I/O、零宿主、零框架；
 *      2. app/ 纯净：ports.ts 与 cockpit-service.ts 只准 import domain 与互相；
 *         （豁免：host-app.ts 是 host 半组装单元 —— 等价第二个组装根，见其文件头）
 *      3. 适配器隔离：adapters/<dir>/** 不得 import 兄弟适配器目录
 *         （kernel-http / kernel-process / dsh-tools / dsh-web / fs-store），
 *         组装只发生在 main.ts / host-app.ts / CockpitPane（客户端半组装点）；
 *      4. src/** 不得 import main.ts / app/host-app.ts（组装根不回引）；
 *      5. 相对 import 不得逃出包根。
 *
 * 违例即测试失败（CI 同门禁）。改目录/挪文件后先跑本文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relative, resolve } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

const ADAPTER_DIRS = ['kernel-http', 'kernel-process', 'dsh-tools', 'dsh-web', 'fs-store']

/** 客户端半组装点：DSH 把槽位 props 传给组件（不是 factory），所以浏览器
 *  bundle 里唯一能同时拿到 icd-client 与 service 的地方就是面板组件；
 *  SettingsSection 是设置叶组件（直接消费 /elab/config，同一 ICD 客户端）。 */
const CROSS_ADAPTER_ALLOWED = [
  // from → to（精确到文件）：CockpitPane 组装客户端半（elabApi 注入 service）
  ['adapters/dsh-web/CockpitPane.tsx', 'adapters/kernel-http/icd-client.ts'],
  ['adapters/dsh-web/SettingsSection.tsx', 'adapters/kernel-http/icd-client.ts'],
  // 芯片包设置视图：设置叶组件（直接消费 /api/packs 与 /api/pkg/*，同一 ICD 客户端）
  ['adapters/dsh-web/PackSettingsView.tsx', 'adapters/kernel-http/icd-client.ts'],
]

/**
 * domain/ 的白名单：只允许这几个文件引用**中性共享层**。
 * `@elab/cockpit-ui-core` 是纯 TS（零 React、零 I/O、零业务/宿主依赖，
 * 见 packages/cockpit-ui-core/test/purity.test.mjs）；它是"共享合同"，
 * 不是第三层业务代码。除此之外 domain 仍只准 `./xxx`。
 *
 * ★ `domain/icd.ts` **不在**白名单：它是 host 半也引用的类型合同，而
 *   host 构建（`tsc -p tsconfig.host.json`，rootDir=src）无法把 core 源文件
 *   纳入同一 program（TS6059）。故 icd 仍是自包含镜像（与 core `src/icd.ts`
 *   内容同源，改动需两处同步）；只有纯 client 侧的 channels/run 走共享层
 *   （客户端半由 esbuild alias 内联，不受 rootDir 约束）。
 */
const DOMAIN_CORE_ALLOWED = ['domain/channels.ts', 'domain/run.ts']
const CORE_PKG = '@elab/cockpit-ui-core'

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(SRC)
const rel = (f) => relative(SRC, f).replace(/\\/g, '/')

/** 解析相对 import 到 src 内的规范路径；逃出 src 的返回 null。 */
function resolveFrom(fromFile, spec) {
  const target = resolve(fromFile, '..', spec)
  const r = relative(SRC, target)
  if (r.startsWith('..')) return null
  return r.replace(/\\/g, '/')
}

test('§16 工具层不得 import 业务层（services/elab、cockpit 前端、业务仓路径）', () => {
  const FORBIDDEN = [/from\s+['"][^'"]*services\/elab/, /from\s+['"][^'"]*\/cockpit\//, /require\(\s*['"][^'"]*services\/elab/]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const re of FORBIDDEN) {
      const m = src.match(re)
      assert.equal(m, null, `${rel(f)} 出现业务层依赖（应改走 loopback HTTP ICD）: ${m?.[0]}`)
    }
  }
})

test('§4.4-5 工具层 src 的相对 import 不得逃出包根', () => {
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+['"](\.\.\/)+/g)) {
      const depth = (m[1].match(/\.\.\//g) ?? []).length
      // 最深文件在 adapters/<dir>/<sub>/x.ts，到 src 是 3 层（src/domain）—— 4 层即越界
      assert.ok(depth <= 3, `${rel(f)} 相对 import 层级过深（越出 src）: ${m[0]}…`)
    }
  }
})

test('§4.4-1 domain/ 纯净：只准 import 同目录与 `@elab/cockpit-ui-core`（白名单文件）', () => {
  for (const f of files.filter((f) => rel(f).startsWith('domain/'))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      const ok =
        spec.startsWith('./') ||
        (spec === CORE_PKG && DOMAIN_CORE_ALLOWED.includes(rel(f)))
      assert.ok(
        ok,
        `${rel(f)} 违反 domain 纯净：import '${spec}'（domain 只准同目录 './xxx'；` +
          `共享层仅在 ${DOMAIN_CORE_ALLOWED.join(' / ')} 白名单内）`,
      )
    }
  }
})

test('§4.4-2 app/ 纯净：ports/cockpit-service 只准 import domain 与互相（host-app 豁免=组装单元）', () => {
  const PURE = ['app/ports.ts', 'app/cockpit-service.ts']
  for (const f of files.filter((f) => PURE.includes(rel(f)))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      const ok =
        spec.startsWith('./') ||
        spec.startsWith('../domain/') ||
        spec.startsWith('node:') ||
        spec === 'react'
      assert.ok(ok, `${rel(f)} 违反 app 纯净：import '${spec}'（只准 domain / ./ports / node:）`)
    }
  }
})

test('§4.4-4 组装根不回引：src/** 不得 import main.ts / app/host-app.ts', () => {
  for (const f of files.filter((f) => rel(f) !== 'main.ts' && rel(f) !== 'app/host-app.ts')) {
    const src = readFileSync(f, 'utf8')
    assert.ok(!/from\s+['"][^'"]*\/?main\.ts['"]/.test(src), `${rel(f)} 不得 import 组装根 main.ts`)
    assert.ok(!/from\s+['"][^'"]*host-app\.ts['"]/.test(src), `${rel(f)} 不得 import 组装单元 host-app.ts`)
  }
})

test('§4.4-3 适配器隔离：adapters/<dir> 不得 import 兄弟适配器（组装只在组装根）', () => {
  const re = new RegExp(`(\\.\\./)+(${ADAPTER_DIRS.join('|')})/`)
  for (const f of files.filter((f) => rel(f).startsWith('adapters/'))) {
    const own = rel(f).split('/')[1]
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const hit = m[1].match(re)
      if (hit === null) continue
      const targetDir = hit[2]
      if (targetDir === own) continue
      // 少数白名单：客户端半组装点（见 CROSS_ADAPTER_ALLOWED 注释）
      const fromRel = rel(f)
      const toRel = resolveFrom(f, m[1])
      const allowed = CROSS_ADAPTER_ALLOWED.some(([a, b]) => fromRel === a && toRel === b)
      assert.ok(
        allowed,
        `${fromRel} 违反适配器隔离：import '${m[1]}'（跨到 ${targetDir}；组装应上移 main.ts / host-app.ts / 面板组装点）`,
      )
    }
  }
})

test('分层事实：domain 无 React / node:fs / node:http；adapters 不 import app/cockpit-service（编排唯一入口是组装点）', () => {
  for (const f of files.filter((f) => rel(f).startsWith('domain/'))) {
    const src = readFileSync(f, 'utf8')
    assert.ok(!/from\s+['"]react['"]/.test(src), `${rel(f)} domain 不得依赖 React`)
    assert.ok(!/from\s+['"]node:\/(fs|http|child_process|net)/.test(src), `${rel(f)} domain 不得做 I/O`)
  }
  for (const f of files.filter((f) => rel(f).startsWith('adapters/'))) {
    const src = readFileSync(f, 'utf8')
    assert.ok(
      !/from\s+['"][^'"]*app\/cockpit-service\.ts['"]/.test(src) || rel(f) === 'adapters/dsh-web/CockpitPane.tsx',
      `${rel(f)}：编排服务的消费只在组装点（CockpitPane），其余适配器走 props/端口拿数据`,
    )
  }
})
