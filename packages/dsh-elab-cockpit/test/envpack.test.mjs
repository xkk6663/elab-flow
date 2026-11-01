/**
 * 一键环境包单测：清单纯函数（零 I/O）+ 两个新写动作的校验分支。
 *
 * 判据来源：
 *   - 清单只记官方上游直链 / sha256 / ELAB_* 注入，不内置二进制（plugin 瘦）；
 *   - 写盘动作必须 `confirm:true`（不静默下载）；内核版本号只接受 x.y / x.y.z。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { validateBootstrapRequest } from '../src/adapters/env/bootstrap.ts'
import {
  expandTemplate,
  findPack,
  isValidKernelVersion,
  kernelArchiveUrl,
  packEnv,
  packPathDirs,
  platformKey,
  toolEnv,
  toolPathDirs,
} from '../src/domain/envpack.ts'

const MANIFEST = JSON.parse(
  readFileSync(new URL('../envpacks/manifest.json', import.meta.url), 'utf8'),
)
const PACK = MANIFEST.packs[0]

test('platformKey/findPack：按平台键取包，取不到返回 null', () => {
  assert.equal(platformKey('win32', 'x64'), 'win32-x64')
  assert.equal(findPack(MANIFEST, 'win32-x64').id, 'win32-x64')
  assert.equal(findPack(MANIFEST, 'darwin-arm64'), null)
  assert.equal(findPack(null, 'win32-x64'), null)
})

test('清单形状：直链必须是 https，env 只注入 ELAB_*，探测用相对路径', () => {
  for (const tool of PACK.tools) {
    assert.match(tool.url, /^https:\/\/[^/\s]+/)
    for (const key of Object.keys(tool.env)) assert.match(key, /^ELAB_/)
    assert.ok(tool.path.length > 0)
    if (tool.probe !== undefined) assert.ok(!tool.probe[0].startsWith('/'))
  }
})

test('expandTemplate：多次出现的 ${root} 全部展开', () => {
  assert.equal(expandTemplate('${root}/bin/cmake.exe', 'C:/env/cmake'), 'C:/env/cmake/bin/cmake.exe')
  assert.equal(expandTemplate('${root}${root}', 'C:/x'), 'C:/xC:/x')
  assert.equal(expandTemplate('no-placeholder', 'C:/x'), 'no-placeholder')
})

test('toolEnv/toolPathDirs：${root} 展开；"." 与 "" 直接取根', () => {
  const gcc = PACK.tools.find((t) => t.id === 'arm-gcc')
  assert.deepEqual(toolEnv(gcc, 'C:/env/gcc'), { ELAB_ARM_GCC_ROOT: 'C:/env/gcc' })
  assert.deepEqual(toolPathDirs(gcc, 'C:/env/gcc'), ['C:/env/gcc/bin'])

  const ninja = PACK.tools.find((t) => t.id === 'ninja')
  assert.deepEqual(toolPathDirs(ninja, 'C:/env/ninja'), ['C:/env/ninja'])

  const c = { id: 'c', label: 'c', version: '1', url: 'https://e/c.zip', sha256: '', env: {}, path: [''] }
  assert.deepEqual(toolPathDirs(c, 'C:/env/c'), ['C:/env/c'])
})

test('packEnv/packPathDirs：只纳入已装（有 record）的工具，并合并', () => {
  const roots = { 'arm-gcc': 'C:/env/gcc', openocd: 'C:/env/openocd' }
  const env = packEnv(PACK, roots)
  assert.deepEqual(env, {
    ELAB_ARM_GCC_ROOT: 'C:/env/gcc',
    ELAB_OPENOCD: 'C:/env/openocd/bin/openocd.exe',
    ELAB_OPENOCD_SCRIPTS: 'C:/env/openocd/scripts',
  })
  assert.deepEqual(packPathDirs(PACK, roots), ['C:/env/gcc/bin', 'C:/env/openocd/bin'])

  assert.deepEqual(packEnv(PACK, {}), {})
  assert.deepEqual(packPathDirs(PACK, {}), [])
})

test('kernelArchiveUrl：剥掉 .git 后拼 tag 归档', () => {
  const base = 'https://github.com/xkk6663/elab-flow'
  assert.equal(kernelArchiveUrl(base, '2.1.0'), `${base}/archive/refs/tags/v2.1.0.zip`)
  assert.equal(kernelArchiveUrl(`${base}.git`, '2.1.0'), `${base}/archive/refs/tags/v2.1.0.zip`)
})

test('isValidKernelVersion：只放行 x.y / x.y.z（防任意串拼进 URL）', () => {
  assert.equal(isValidKernelVersion('2.1'), true)
  assert.equal(isValidKernelVersion('2.1.0'), true)
  assert.equal(isValidKernelVersion('2'), false)
  assert.equal(isValidKernelVersion('main'), false)
  assert.equal(isValidKernelVersion('2.1.0-rc.1'), false)
  assert.equal(isValidKernelVersion('../etc'), false)
})

const isElabRoot = () => true

test('install-toolchain：必须 confirm:true；pack 可省略、空白归一为省略', () => {
  const noConfirm = validateBootstrapRequest({ action: 'install-toolchain' }, isElabRoot)
  assert.equal(noConfirm.ok, false)
  assert.equal(noConfirm.code, 'confirm-required')

  const ok = validateBootstrapRequest({ action: 'install-toolchain', confirm: true }, isElabRoot)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.request, { action: 'install-toolchain' })

  const blank = validateBootstrapRequest(
    { action: 'install-toolchain', confirm: true, pack: '   ' },
    isElabRoot,
  )
  assert.deepEqual(blank.request, { action: 'install-toolchain' })

  const named = validateBootstrapRequest(
    { action: 'install-toolchain', confirm: true, pack: ' win32-x64 ' },
    isElabRoot,
  )
  assert.deepEqual(named.request, { action: 'install-toolchain', pack: 'win32-x64' })
  // pack 不做格式限制：清单里没有的键由适配器层报 no-pack（不在此处臆造校验）
  const unknown = validateBootstrapRequest(
    { action: 'install-toolchain', confirm: true, pack: '../x' },
    isElabRoot,
  )
  assert.equal(unknown.ok, true)
})

test('download-kernel：必须 confirm:true；版本归一化且非法就拒', () => {
  const noConfirm = validateBootstrapRequest({ action: 'download-kernel', version: '2.1.0' }, isElabRoot)
  assert.equal(noConfirm.code, 'confirm-required')

  const bad = validateBootstrapRequest(
    { action: 'download-kernel', version: 'latest', confirm: true },
    isElabRoot,
  )
  assert.equal(bad.code, 'bad-version')

  const empty = validateBootstrapRequest({ action: 'download-kernel', confirm: true }, isElabRoot)
  assert.equal(empty.code, 'bad-version')

  const ok = validateBootstrapRequest(
    { action: 'download-kernel', version: ' v2.1.0 ', confirm: true },
    isElabRoot,
  )
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.request, { action: 'download-kernel', version: '2.1.0' })
})
