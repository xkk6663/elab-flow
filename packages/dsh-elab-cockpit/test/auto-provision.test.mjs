/**
 * 零前置自动准备单测（纯编排，不联网 / 不写真机）：
 *   probe / download / clone / install 全部注入假实现，只验状态机与调用纪律。
 *
 * 覆盖：python 缺失 → blocked 且零下载；下载失败回落浅克隆；两条都失败可重试；
 *       工具链齐全跳过安装；autoProvision=false 不跑；幂等（已有根不下载、第二次 start 不重跑）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createAutoProvisioner } from '../src/app/auto-provision.ts'
import { DEFAULT_KERNEL_VERSION, findPack } from '../src/domain/envpack.ts'

const item = (ok) => ({ ok })

/**
 * 读内核仓库当前版本（`cockpit/server.py` 的 `COCKPIT_VERSION`）。
 * 插件默认下载的内核版本必须与它一致 —— 这里读源码而不是写死版本字面量，
 * 避免每次内核 bump 都要改测试（改了就会漂移）。
 */
function readKernelVersion() {
  const src = readFileSync(new URL('../../../cockpit/server.py', import.meta.url), 'utf8')
  const m = src.match(/^COCKPIT_VERSION\s*=\s*["']([^"']+)["']/m)
  assert.ok(m, 'cockpit/server.py 里找不到 COCKPIT_VERSION')
  return m[1]
}

/** 探测结果假值：tools=false 表示四个工具都缺。 */
function makeEnv({ python = true, tools = true } = {}) {
  return {
    ok: true,
    checkedAt: Date.now(),
    python: python ? { ok: true, version: '3.12.4' } : { ok: false, error: '未找到 python' },
    git: item(true),
    cmake: item(tools),
    ninja: item(tools),
    armGcc: item(tools),
    openocd: item(tools),
    pyserial: item(true),
  }
}

/**
 * 组装注入依赖，并记录调用次数 / 阶段文案。
 * @param opts.root 当前可解析的内核根（undefined → null）
 */
function harness(opts = {}) {
  const calls = { probe: 0, download: 0, clone: 0, install: 0, toolchain: 0 }
  const stages = []
  const roots = []
  const deps = {
    probe: async () => {
      calls.probe += 1
      return opts.env ?? makeEnv()
    },
    resolveRoot: () => (opts.root === undefined ? null : opts.root),
    toolchainInstalled: () => opts.toolchainInstalled === true,
    downloadKernel: async (version, onStage) => {
      calls.download += 1
      onStage(`下载内核 v${version}…`)
      if (opts.download !== undefined) return opts.download()
      return { ok: true, dir: `C:/kernels/v${version}`, version }
    },
    cloneKernel: async () => {
      calls.clone += 1
      if (opts.clone !== undefined) return opts.clone()
      return { ok: true, dir: 'C:/kernels/clone' }
    },
    installToolchain: async (onProgress) => {
      calls.install += 1
      onProgress({ phase: 'download', toolId: 'cmake', message: '下载 CMake…' })
      if (opts.install !== undefined) return opts.install()
      return { ok: true, packId: 'win32-x64', tools: 4 }
    },
    onRootReady: (dir) => roots.push(dir),
    onToolchainInstalled: () => {
      calls.toolchain += 1
    },
  }
  return { deps, calls, roots, stages }
}

function make(opts, provisionerOpts = {}) {
  const h = harness(opts)
  const provisioner = createAutoProvisioner(h.deps, {
    kernelVersion: DEFAULT_KERNEL_VERSION,
    enabled: () => provisionerOpts.enabled ?? true,
    onStatus: (s) => h.stages.push(s.stage),
  })
  return { provisioner, ...h }
}

test('默认内核版本可被环境包清单/UI 共用', () => {
  // 不写死版本字面量：断言「插件默认下载的内核版本 == 内核仓库当前版本」，
  // 两者必须同步 bump（写死字面量则每次内核发版都要改测试，必然漂移）。
  assert.equal(DEFAULT_KERNEL_VERSION, readKernelVersion())
  // 常量与清单无绑定关系（这里只断言它非空且形状合法）
  assert.match(DEFAULT_KERNEL_VERSION, /^[0-9]+\.[0-9]+(\.[0-9]+)?$/)
  // findPack 至少能被调用（导入路径正确）
  assert.equal(findPack(null, 'win32-x64'), null)
})

test('python 缺失 → blocked，且绝不触发下载 / 克隆 / 安装', async () => {
  const { provisioner, calls } = make({ env: makeEnv({ python: false }) })
  const started = provisioner.start()
  const s = await started.settled

  assert.equal(s.phase, 'blocked')
  assert.equal(s.step, 'probe')
  assert.equal(s.blocked.code, 'python-missing')
  assert.ok(s.blocked.hint.length > 0, 'blocked 必须带可执行指引')
  assert.equal(s.error, null)

  assert.equal(calls.probe, 1)
  assert.equal(calls.download, 0, 'python 缺失时不应下载内核')
  assert.equal(calls.clone, 0, 'python 缺失时不应克隆')
  assert.equal(calls.install, 0, 'python 缺失时不应安装工具链')
})

test('内核下载失败 → 自动回落浅克隆（不直接报错）', async () => {
  const { provisioner, calls, roots } = make({
    env: makeEnv({ tools: false }),
    download: () => ({ ok: false, code: 'tag-not-found', message: 'tag v2.1.0 不存在' }),
  })
  const s = await provisioner.start().settled

  assert.equal(calls.download, 1)
  assert.equal(calls.clone, 1, '下载失败后应尝试浅克隆')
  assert.deepEqual(roots, ['C:/kernels/clone'])
  assert.equal(s.phase, 'done', '克隆成功后继续装工具链并完成')
  assert.equal(calls.install, 1)
  assert.equal(calls.toolchain, 1, '装完工具链要丢弃旧内核进程')
})

test('下载与克隆都失败 → failed（可重试的人话错误）', async () => {
  const { provisioner, calls } = make({
    download: () => ({ ok: false, code: 'network', message: '网络中断' }),
    clone: () => ({ ok: false, code: 'clone-failed', message: 'git clone 失败' }),
  })
  const s = await provisioner.start().settled

  assert.equal(calls.download, 1)
  assert.equal(calls.clone, 1)
  assert.equal(s.phase, 'failed')
  assert.equal(s.step, 'kernel')
  assert.equal(s.error.code, 'kernel-unavailable')
  assert.equal(s.error.retryable, true)
  assert.ok(!s.error.message.includes('network'), '错误文案不应回显原始异常/错误码串')
  assert.equal(calls.install, 0, '内核没准备好不应装工具链')

  // 重试：同一流程重新跑（下载 + 克隆各再来一次）
  const again = provisioner.retry()
  const s2 = await again.settled
  assert.equal(calls.download, 2)
  assert.equal(calls.clone, 2)
  assert.equal(s2.phase, 'failed')
})

test('工具链已齐全 → 跳过安装，直接 done', async () => {
  const { provisioner, calls } = make({ env: makeEnv({ tools: true }) })
  const s = await provisioner.start().settled

  assert.equal(s.phase, 'done')
  assert.equal(calls.install, 0, '四个工具都可用时不应下载环境包')
  assert.equal(calls.toolchain, 0)
})

test('环境包已装（宿主 PATH 看不到）→ 也跳过安装', async () => {
  const { provisioner, calls } = make({ env: makeEnv({ tools: false }), toolchainInstalled: true })
  const s = await provisioner.start().settled

  assert.equal(s.phase, 'done')
  assert.equal(calls.install, 0, '已装环境包不应重复下载')
})

test('工具链安装失败 → failed（retryable）', async () => {
  const { provisioner, calls } = make({
    env: makeEnv({ tools: false }),
    install: () => ({ ok: false, code: 'sha256-mismatch', message: '哈希不符' }),
  })
  const s = await provisioner.start().settled

  assert.equal(calls.install, 1)
  assert.equal(s.phase, 'failed')
  assert.equal(s.step, 'toolchain')
  assert.equal(s.error.code, 'toolchain-failed')
  assert.equal(s.error.retryable, true)
})

test('autoProvision=false → disabled，且一次依赖都不调用', async () => {
  const { provisioner, calls } = make({}, { enabled: false })
  const s = await provisioner.start().settled

  assert.equal(s.phase, 'disabled')
  assert.equal(calls.probe, 0)
  assert.equal(calls.download, 0)
  assert.equal(calls.clone, 0)
  assert.equal(calls.install, 0)
})

test('幂等：已有内核根 → 不下载；第二次 start 不重跑', async () => {
  const { provisioner, calls } = make({ root: 'C:/repo', env: makeEnv({ tools: false }) })
  const s = await provisioner.start().settled
  assert.equal(s.phase, 'done')
  assert.equal(calls.download, 0, '已有根不应再下载')
  assert.equal(calls.clone, 0, '已有根不应再克隆')
  assert.equal(calls.probe, 1)
  assert.equal(calls.install, 1)

  // 终态后再 start：直接返回、零新调用（面板重复打开不会重下）
  const second = await provisioner.start().settled
  assert.equal(second.phase, 'done')
  assert.equal(calls.probe, 1)
  assert.equal(calls.download, 0)
  assert.equal(calls.install, 1)
})

test('单飞：运行中重复 start 共享同一个完成 promise', async () => {
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const { provisioner, calls } = make({
    env: makeEnv({ tools: false }),
    download: async () => {
      await gate
      return { ok: true, dir: 'C:/kernels/v2.1.0', version: DEFAULT_KERNEL_VERSION }
    },
  })
  const a = provisioner.start()
  const b = provisioner.start()
  assert.equal(a.settled, b.settled, '同一时间只跑一份')
  release()
  const s = await a.settled
  assert.equal(s.phase, 'done')
  assert.equal(calls.download, 1)
})

test('阶段文案：running 状态带人话 stage（下载 / 安装）', async () => {
  const seen = []
  const h = harness({ env: makeEnv({ tools: false }) })
  const provisioner = createAutoProvisioner(h.deps, {
    kernelVersion: DEFAULT_KERNEL_VERSION,
    enabled: () => true,
    onStatus: (s) => {
      if (s.phase === 'running') seen.push(`${s.step}:${s.stage}`)
    },
  })
  await provisioner.start().settled
  assert.ok(seen.some((x) => x.startsWith('probe:')), '应有环境自检阶段')
  assert.ok(seen.some((x) => x.startsWith('kernel:下载内核')), '应有内核下载阶段')
  assert.ok(seen.some((x) => x.startsWith('toolchain:')), '应有工具链安装阶段')
  assert.ok(!seen.some((x) => x.includes('undefined')), '阶段文案不应出现 undefined')
})
