/**
 * 引导向导单测：写动作校验（不静默写盘 / 不覆盖已有检出）+ 状态机转移。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateBootstrapRequest } from '../src/adapters/env/bootstrap.ts'
import {
  MIN_KERNEL_VERSION,
  compareVersion,
  deriveBootstrapPhase,
  isKernelOld,
  stepStates,
} from '../src/domain/bootstrap.ts'

let ROOT
const isElabRoot = (dir) => dir.replace(/\\/g, '/').endsWith('/repo')

before(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'elab-bootstrap-'))
})

after(async () => {
  if (ROOT !== undefined) await rm(ROOT, { recursive: true, force: true })
})

test('set-root：非绝对路径 / 非 elab 根 → 明确错误码（不写盘）', () => {
  const bad = validateBootstrapRequest({ action: 'set-root', dir: 'relative/dir' }, isElabRoot)
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'bad-dir')

  const notRoot = validateBootstrapRequest({ action: 'set-root', dir: join(ROOT, 'other') }, isElabRoot)
  assert.equal(notRoot.ok, false)
  assert.equal(notRoot.code, 'not-elab-root')

  const good = validateBootstrapRequest({ action: 'set-root', dir: join(ROOT, 'repo') }, isElabRoot)
  assert.equal(good.ok, true)
  assert.equal(good.request.dir, join(ROOT, 'repo'))
})

test('clone：必须 confirm:true 且只接受 https', () => {
  const noConfirm = validateBootstrapRequest(
    { action: 'clone', url: 'https://github.com/a/b', dir: join(ROOT, 'empty1') },
    isElabRoot,
  )
  assert.equal(noConfirm.ok, false)
  assert.equal(noConfirm.code, 'confirm-required')

  const sshUrl = validateBootstrapRequest(
    { action: 'clone', url: 'git@github.com:a/b.git', dir: join(ROOT, 'empty2'), confirm: true },
    isElabRoot,
  )
  assert.equal(sshUrl.ok, false)
  assert.equal(sshUrl.code, 'bad-url')

  const ok = validateBootstrapRequest(
    { action: 'clone', url: 'https://github.com/a/b', dir: join(ROOT, 'empty3'), confirm: true },
    isElabRoot,
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.request.action, 'clone')
})

test('clone：目标目录已存在且非空 → 拒绝（不覆盖用户检出）', async () => {
  const dir = join(ROOT, 'occupied')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'keep.txt'), 'user work\n', 'utf8')
  const r = validateBootstrapRequest(
    { action: 'clone', url: 'https://github.com/a/b', dir, confirm: true },
    isElabRoot,
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'dir-not-empty')

  // 空目录允许
  const empty = join(ROOT, 'empty4')
  await mkdir(empty, { recursive: true })
  const ok = validateBootstrapRequest(
    { action: 'clone', url: 'https://github.com/a/b', dir: empty, confirm: true },
    isElabRoot,
  )
  assert.equal(ok.ok, true)
})

test('未知 action / 非对象 → 400 形状', () => {
  assert.equal(validateBootstrapRequest(null, isElabRoot).code, 'bad-request')
  assert.equal(validateBootstrapRequest({ action: 'pull' }, isElabRoot).code, 'unknown-action')
})

test('状态机：unbound → env-ok → root-set → kernel-ok → ready', () => {
  const base = { elabRoot: null, hostOk: null, pythonOk: null, projectCount: 0 }
  assert.equal(deriveBootstrapPhase(base), 'unbound')
  assert.equal(deriveBootstrapPhase({ ...base, pythonOk: true }), 'env-ok')
  assert.equal(deriveBootstrapPhase({ ...base, pythonOk: true, elabRoot: 'C:/repo' }), 'root-set')
  assert.equal(deriveBootstrapPhase({ ...base, elabRoot: 'C:/repo', hostOk: true }), 'kernel-ok')
  assert.equal(
    deriveBootstrapPhase({ ...base, elabRoot: 'C:/repo', hostOk: true, projectCount: 2 }),
    'ready',
  )
  // host 已就绪时，python 探测结果不参与判定（状态不倒退）
  assert.equal(deriveBootstrapPhase({ ...base, hostOk: true, pythonOk: false }), 'kernel-ok')
})

test('四步状态：工具链缺件只 warn，不阻断', () => {
  assert.deepEqual(stepStates('ready').toolchain, 'warn')
  assert.deepEqual(stepStates('unbound').toolchain, 'warn')
  assert.equal(stepStates('env-ok').kernel, 'blocked')
  assert.equal(stepStates('ready').project, 'done')
})

test('内核版本：仅提示，不阻断', () => {
  assert.equal(isKernelOld('2.0.0'), true)
  assert.equal(isKernelOld(MIN_KERNEL_VERSION), false)
  assert.equal(isKernelOld('2.1.3'), false)
  assert.equal(isKernelOld(undefined), false) // 版本未知 → 不判定
  assert.equal(compareVersion('2.0.10', '2.1.0'), -1)
  assert.equal(compareVersion('2.1.0', '2.1.0'), 0)
})
