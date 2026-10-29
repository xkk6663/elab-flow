/**
 * discovery 单测（node --test，零依赖）。
 *
 * 用**内存文件系统**驱动：`readdir`/`readFile` 全注入，
 * 因此不需要临时目录、不碰真实磁盘，断言可重复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  declaresProjectName,
  discoverProjects,
  normalizePath,
  stripComments,
  DEFAULT_MAX_DEPTH,
} from '../src/adapters/kernel-http/discovery.ts'

/** 构造内存 fs。keys 用正斜杠绝对路径。 */
function fakeFs(files, dirsOverride) {
  const sets = new Map()
  const put = (p, isDir) => {
    const n = normalizePath(p)
    const parent = n.slice(0, n.lastIndexOf('/'))
    const base = n.slice(n.lastIndexOf('/') + 1)
    if (parent === '' || base === '') return
    if (!sets.has(parent)) sets.set(parent, [])
    sets.get(parent).push({ name: base, dir: isDir })
  }
  for (const f of Object.keys(files)) put(f, false)
  for (const d of dirsOverride ?? []) put(d, true)
  // 由文件路径反推中间目录
  for (const f of Object.keys(files)) {
    let p = normalizePath(f)
    while (true) {
      p = p.slice(0, p.lastIndexOf('/'))
      if (p === '' || p === 'C:' || p.endsWith(':')) break
      if (!Array.from(sets.keys()).some((k) => k === p)) {
        if (!sets.has(p)) sets.set(p, [])
      }
      const parent = p.slice(0, p.lastIndexOf('/'))
      if (parent === '' || parent.endsWith(':')) break
      const base = p.slice(p.lastIndexOf('/') + 1)
      if (!sets.has(parent)) sets.set(parent, [])
      if (!sets.get(parent).some((e) => e.name === base)) {
        sets.get(parent).push({ name: base, dir: true })
      }
    }
  }
  return {
    readdir: async (dir) => {
      const list = sets.get(normalizePath(dir))
      if (list === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return list.map((e) => ({
        name: e.name,
        isDirectory: () => e.dir,
        isFile: () => !e.dir,
        isSymbolicLink: () => false,
      }))
    },
    readFile: async (p) => {
      const n = normalizePath(p)
      if (!(n in files)) throw new Error(`ENOENT ${n}`)
      return files[n]
    },
  }
}

const ROOT = 'C:/repo'

test('stripComments 去掉行注释与块注释', () => {
  // 行注释整段替换为单个空格：`a ` + ` ` + `\nb`
  assert.equal(stripComments('a # comment\nb'), 'a  \nb')
  // CMake 的块注释必须以 `#[[` 开头、**以换行结尾的 `]]`** 收尾；`]]x` 不合语法，
  // 因此按「无块注释」处理，只被行注释规则吃掉第一行 `#` 到行尾
  assert.equal(stripComments('#[[]]] bad\nx'), ' \nx')
  assert.equal(stripComments('#[[ multi\nline ]]x'), ' \nline ]]x')
  // 合法块注释（单独成行的 ]]）被整体替换为一个空格
  assert.equal(stripComments('#[[ multi\nline ]]\nx'), ' \nx')
})

test('declaresProjectName 识别 project() 与 CMAKE_PROJECT_NAME', () => {
  assert.equal(declaresProjectName('project(Foo C CXX)'), 'Foo')
  assert.equal(declaresProjectName('set(CMAKE_PROJECT_NAME TEST)'), 'TEST')
  assert.equal(declaresProjectName('# project(Commented)\nset(CMAKE_PROJECT_NAME Real)'), 'Real')
  assert.equal(declaresProjectName('# project(OnlyComment)'), undefined)
})

test('子目录 CMakeLists（无 project 声明）不算候选 —— 本仓库 components/ 的真实形态', async () => {
  const fs = fakeFs({
    'C:/repo/components/ota/CMakeLists.txt': 'set(OTA_DIR ${CMAKE_CURRENT_SOURCE_DIR})\nmessage(STATUS hi)\n',
    'C:/repo/examples/AT32_TEST/CMakeLists.txt': 'cmake_minimum_required(VERSION 3.22)\nset(CMAKE_PROJECT_NAME TEST)\n',
  })
  const r = await discoverProjects({ root: ROOT }, fs)
  assert.deepEqual(r.candidates.map((c) => c.dirname), ['AT32_TEST'])
})

test('深度限制：maxDepth=3 时 d3 命中、d4 不命中', async () => {
  const fs = fakeFs({
    'C:/repo/a/b/c/CMakeLists.txt': 'project(D3)',
    'C:/repo/a/b/c/d/CMakeLists.txt': 'project(D4)',
  })
  const r = await discoverProjects({ root: ROOT, maxDepth: 3 }, fs)
  assert.deepEqual(r.candidates.map((c) => c.dirname).sort(), ['c'])
  assert.equal(r.candidates[0].depth, 3)
})

test('排除目录：build/.work/node_modules/third_party/点目录 一律不进', async () => {
  const fs = fakeFs({
    'C:/repo/build/CMakeLists.txt': 'project(Build)',
    'C:/repo/.work/x/CMakeLists.txt': 'project(Work)',
    'C:/repo/node_modules/y/CMakeLists.txt': 'project(NM)',
    'C:/repo/third_party/z/CMakeLists.txt': 'project(TP)',
    'C:/repo/.hidden/w/CMakeLists.txt': 'project(Hidden)',
    'C:/repo/app/CMakeLists.txt': 'project(App)',
  })
  const r = await discoverProjects({ root: ROOT }, fs)
  assert.deepEqual(r.candidates.map((c) => c.dirname), ['app'])
})

test('上限触发 truncated，且不静默截断', async () => {
  const files = {}
  for (let i = 0; i < 5; i += 1) files[`C:/repo/p${i}/CMakeLists.txt`] = `project(P${i})`
  const fs = fakeFs(files)
  const r = await discoverProjects({ root: ROOT, limit: 3 }, fs)
  assert.equal(r.candidates.length, 3)
  assert.equal(r.truncated, true)
})

test('已接入标记：adaptedAs 命中且排序置后', async () => {
  const fs = fakeFs({
    'C:/repo/a/CMakeLists.txt': 'project(A)',
    'C:/repo/b/CMakeLists.txt': 'project(B)',
  })
  const r = await discoverProjects(
    { root: ROOT, adapted: [{ name: 'alpha', root: 'C:\\repo\\a' }] },
    fs,
  )
  // b 未接入 → 排前面；a 已接入 → 排后面且标记
  assert.deepEqual(r.candidates.map((c) => c.dirname), ['b', 'a'])
  assert.equal(r.candidates[1].adaptedAs, 'alpha')
})

test('生成器线索：.ioc / .ATWP / .ld 被收集', async () => {
  const fs = fakeFs({
    'C:/repo/stm/app/CMakeLists.txt': 'project(App)',
    'C:/repo/stm/app/app.ioc': '',
    'C:/repo/stm/app/STM32.ld': '',
    'C:/repo/at/CMakeLists.txt': 'project(At)',
    'C:/repo/at/template.ATWP': '',
  })
  const r = await discoverProjects({ root: ROOT }, fs)
  const byName = Object.fromEntries(r.candidates.map((c) => [c.dirname, c.hints]))
  assert.equal(byName.app.ioc, 'app.ioc')
  assert.deepEqual(byName.app.linkerScripts, ['STM32.ld'])
  assert.equal(byName.at.atwp, 'template.ATWP')
})

test('读取失败不炸整次扫描（权限/竞态）', async () => {
  const inner = fakeFs({
    'C:/repo/ok/CMakeLists.txt': 'project(OK)',
    'C:/repo/broken/CMakeLists.txt': 'project(Broken)',
  })
  const fs = {
    readdir: async (d) => {
      if (normalizePath(d) === 'C:/repo/broken') throw new Error('EACCES')
      return inner.readdir(d)
    },
    readFile: inner.readFile,
  }
  const r = await discoverProjects({ root: ROOT }, fs)
  assert.deepEqual(r.candidates.map((c) => c.dirname), ['ok'])
})

test('默认参数：maxDepth=3、limit=50', async () => {
  const fs = fakeFs({ 'C:/repo/x/CMakeLists.txt': 'project(X)' })
  const r = await discoverProjects({ root: ROOT }, fs)
  assert.equal(r.maxDepth, DEFAULT_MAX_DEPTH)
  assert.equal(DEFAULT_MAX_DEPTH, 3)
})

test('确定性：同一输入两次扫描结果一致', async () => {
  const files = {}
  for (const n of ['zeta', 'alpha', 'mid']) files[`C:/repo/${n}/CMakeLists.txt`] = `project(${n})`
  const fs = fakeFs(files)
  const a = await discoverProjects({ root: ROOT }, fs)
  const b = await discoverProjects({ root: ROOT }, fs)
  assert.deepEqual(a.candidates.map((c) => c.path), b.candidates.map((c) => c.path))
})
