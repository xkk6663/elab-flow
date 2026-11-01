/**
 * 批 2 编排服务（app/cockpit-service.ts）—— 用假端口验证整条链。
 *
 * 覆盖：
 *  - init：健康 → meta 探测 → 工程 → 发现 → 可用性 → 三档视图；
 *  - 发现 → 适配状态机联动（discovered → 一键适配 → bound + 自动绑定）；
 *  - 发起：plan 视图过滤后的 effectiveSteps 传给 startRun；SSE 随发起建立；
 *  - 事件归约：run/start 重建快照、step-exit 落状态、run/end 断流；
 *  - 可见性：setVisible 传导到连接；stream/closed 兜底判失败；
 *  - 取消 / 预览的错误通道。
 *
 * ★ 全部走假端口 —— 本测试证明 app 层零 I/O（domain 纯函数 + 注入端口）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCockpitService } from '../src/app/cockpit-service.ts'

/** 可编程假 ICD：记录调用，返回预设响应。 */
function fakeApi(overrides = {}) {
  const calls = { startRun: [], adapt: [], cancel: [], plan: [], discover: [] }
  const api = {
    host: async () => ({ ok: true, elabRoot: 'C:/elab', running: false, port: 1, pid: 1, job: 'j', bootMs: 1 }),
    capabilities: async () => ({ meta: { steps: {}, plans: [] } }),
    projects: async () => ({
      projects: [
        {
          name: 'led',
          steps: {
            build: { ok: true },
            flash: { ok: false, reason: '未检测到探针' },
            debug_verify: { ok: false, reason: '未检测到探针' },
          },
        },
      ],
    }),
    discover: async (_s, refresh) => {
      calls.discover.push(refresh ?? false)
      // adapt 之后（内核已重载 Config）sensor 变为已接入
      const adapted = calls.adapt.length > 0
      return {
        ok: true,
        scanRoot: { path: 'C:/proj', source: 'session-cwd' },
        adaptedCount: adapted ? 2 : 1,
        cached: false,
        candidates: [
          { path: 'C:/proj/led', dirname: 'led', depth: 1, hints: {}, adaptedAs: 'led' },
          { path: 'C:/proj/sensor', dirname: 'sensor', depth: 1, hints: {}, ...(adapted ? { adaptedAs: 'sensor' } : {}) },
        ],
        maxDepth: 3,
        truncated: false,
        dirsVisited: 1,
        elapsedMs: 1,
      }
    },
    adapt: async (opts) => {
      calls.adapt.push(opts)
      return {
        action: 'write',
        probe: {},
        tier: 'T1',
        confidence: 'high',
        name: 'sensor',
        result: { name: 'sensor', path: 'C:/elab/projects/sensor.yaml', written: true, status: 'written' },
        next: { steps: ['doctor_deep', 'build'], hint: '' },
      }
    },
    startRun: async (opts) => {
      calls.startRun.push(opts)
      return { run: 'r-1', project: opts.project, steps: opts.steps, actor: 'human' }
    },
    cancel: async (run, reason) => {
      calls.cancel.push({ run, reason })
      return { ok: true }
    },
    plan: async (opts) => {
      calls.plan.push(opts)
      return {
        project: opts.project,
        steps: opts.steps ?? [],
        clean: opts.clean === true,
        jobs: opts.jobs ?? null,
        plan: [{ step: 'build', spawns: true, commands: [['ninja']], effects: [], blocked: false, note: '' }],
        warnings: [],
      }
    },
    ...overrides,
  }
  return { api, calls }
}

/** 可编程假事件端口：握住 sink，手动投喂事件；记录 connect/setVisible/dispose。 */
function fakeEvents() {
  const log = { connect: [], setVisible: [], dispose: 0 }
  let current = null
  return {
    log,
    emit(e) {
      if (current !== null) current.sink.onEvent(e)
    },
    close(reason) {
      if (current !== null) current.sink.onClosed(reason)
    },
    port: {
      connect(run, sessionId, sink) {
        log.connect.push({ run, sessionId })
        current = { sink }
        return {
          setVisible: (v) => log.setVisible.push(v),
          dispose: () => {
            log.dispose += 1
            current = null
          },
        }
      },
    },
  }
}

const ev = (topic, extra = {}) => ({ ts: 1, run: 'r-1', topic, seq: extra.seq ?? 1, actor: 'human', ...extra })

test('init：健康 → meta → 工程 → 发现 → 可用性（发现未接入工程 → discovered）', async () => {
  const { api } = fakeApi()
  const { port, log } = fakeEvents()
  const svc = createCockpitService({ api, events: port, sessionId: 's1' })
  await svc.init()

  const s = svc.getSnapshot()
  assert.equal(s.hostOk, true)
  assert.equal(s.kernelOld, false) // capabilities 带 meta
  assert.deepEqual(s.projects.map((p) => p.name), ['led'])
  assert.equal(s.project, 'led')
  assert.deepEqual(s.availability, {
    build: { ok: true, reason: undefined },
    flash: { ok: false, reason: '未检测到探针' },
    debug_verify: { ok: false, reason: '未检测到探针' },
  })
  // 三档视图：flash 不可用 → triple 剔除 flash（只剩 build）→ enabled
  const triple = s.plans.find((p) => p.id === 'triple')
  assert.deepEqual(triple.effectiveSteps, ['build'])
  assert.equal(triple.enabled, true)
  // 适配状态机：有 1 个未接入候选
  assert.equal(s.adapt.phase, 'discovered')
  assert.equal(s.adapt.candidates.filter((c) => c.adaptedAs === undefined).length, 1)
})

test('meta 缺失 → kernelOld=true（内核过旧提示的数据源）', async () => {
  const { api } = fakeApi({ capabilities: async () => ({}) })
  const { port, log } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()
  assert.equal(svc.getSnapshot().kernelOld, true)
})

test('host 不就绪 → hostOk=false + unbound，不再拉工程', async () => {
  const { api } = fakeApi({ host: async () => ({ ok: false, elabRoot: null, running: false, port: null, pid: null, job: null, bootMs: null }) })
  const { port, log } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()
  const s = svc.getSnapshot()
  assert.equal(s.hostOk, false)
  assert.match(s.hostError, /未找到 elab 仓库根/)
  assert.equal(s.adapt.phase, 'unbound')
  assert.equal(s.projects.length, 0)
})

test('一键适配：write → 重载工程 → 自动绑定新工程 → bound', async () => {
  const { api, calls } = fakeApi({
    // 适配后 projects 里多出 sensor（内核已重载 Config）
    projects: async () => ({
      projects: [
        { name: 'led', steps: { build: { ok: true } } },
        { name: 'sensor', steps: { build: { ok: true } } },
      ],
    }),
  })
  const { port, log } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()
  assert.equal(svc.getSnapshot().project, 'led')

  await svc.adaptProject('C:/proj/sensor')
  assert.equal(calls.adapt.length, 1)
  assert.equal(calls.adapt[0].action, 'write')
  assert.equal(calls.adapt[0].path, 'C:/proj/sensor')

  const s = svc.getSnapshot()
  assert.equal(s.adapt.phase, 'bound')
  assert.equal(s.adapt.lastAdapted, 'sensor')
  assert.equal(s.project, 'sensor') // 自动绑定
  assert.deepEqual(s.adapt.candidates.filter((c) => c.adaptedAs === undefined).length, 0) // discover(refresh) 已刷新
})

test('一键适配失败 → discovered + error 透传（内核 ElabError 文案）', async () => {
  const { api } = fakeApi({
    adapt: async () => {
      throw new Error('芯片未匹配：chips/ 下没有与编译宏匹配的芯片')
    },
  })
  const { port, log } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()
  await svc.adaptProject('C:/proj/sensor')
  const s = svc.getSnapshot()
  assert.equal(s.adapt.phase, 'discovered')
  assert.match(s.adapt.error, /芯片未匹配/)
})

test('发起：triple 用过滤后的 effectiveSteps；SSE 随发起建立并投喂事件', async () => {
  const { api, calls } = fakeApi()
  const { port, log, emit, close } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()

  await svc.startPlan('triple', { clean: false, jobs: null })
  assert.equal(calls.startRun.length, 1)
  assert.deepEqual(calls.startRun[0].steps, ['build']) // flash 不可用被剔除
  assert.deepEqual(log.connect, [{ run: 'r-1', sessionId: undefined }])

  // 事件归约：run/start 重建步骤序列
  emit(ev('run/start', { seq: 1, steps: ['build'], project: 'led' }))
  emit(ev('run/step-enter', { seq: 2, step: 'build' }))
  emit(ev('run/step-exit', { seq: 3, step: 'build', ok: true, detail: '', duration_s: 2 }))
  emit(ev('run/end', { seq: 4, ok: true }))

  const s = svc.getSnapshot()
  assert.equal(s.run.status, 'ok')
  assert.equal(s.run.steps[0].state, 'ok')
  assert.equal(log.dispose, 1) // run/end → 断流
  // ★ 主动断流后 onClosed 不会再来，busy 必须在这里复位（否则按钮永久变灰）
  assert.equal(s.busy, false)

  close('run-finished') // 迟到的 closed 不再改变状态
  assert.equal(svc.getSnapshot().run.status, 'ok')
})

test('stream/closed 兜底：running 态丢收尾 → 显式 failed', async () => {
  const { api } = fakeApi()
  const { port, log, emit, close } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()
  await svc.startPlan('basic', { clean: false, jobs: null })
  emit(ev('run/start', { steps: ['build'] }))
  close('unknown-run')
  const s = svc.getSnapshot()
  assert.equal(s.run.status, 'failed')
  assert.match(s.run.steps[0].detail, /流已关闭/)
  assert.equal(s.busy, false)
})

test('可见性传导到连接；原始事件喂给 onRawEvent 订阅者', async () => {
  const { api } = fakeApi()
  const { port, log, emit } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()

  const seen = []
  svc.onRawEvent((e) => seen.push(e.topic))
  svc.setVisible(false) // 还没有连接：不产生记录
  assert.deepEqual(log.setVisible, [])

  await svc.startPlan('basic', { clean: false, jobs: null })
  assert.deepEqual(log.setVisible, [false]) // 连接建立时同步当前可见性

  emit(ev('proc/stdout', { line: 'hello', step: 'build' }))
  assert.deepEqual(seen, ['proc/stdout'])
  // 进度折叠：proc/stdout 不是 [n/m] 帧 → progress 仍为 null
  assert.equal(svc.getSnapshot().progress, null)
})

test('不可见时发起：连接建立后立即置不可见（不占 SSE 槽位）', async () => {
  const { api } = fakeApi()
  const { port, log } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()
  svc.setVisible(false) // 还没有连接：只记状态
  await svc.startPlan('basic', { clean: false, jobs: null })
  assert.deepEqual(log.setVisible, [false]) // 连接建立时同步当前可见性
})

test('取消与预览：参数透传 + 错误进 error 通道', async () => {
  const { api, calls } = fakeApi({
    cancel: async (run, reason) => {
      calls.cancel.push({ run, reason })
      throw new Error('run 已结束')
    },
  })
  const { port, log } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()

  const previews = []
  svc.onPreview((p) => previews.push(p))
  await svc.preview({ clean: true, jobs: 4 })
  assert.equal(calls.plan.length, 1)
  assert.equal(calls.plan[0].clean, true)
  assert.equal(previews.length, 1)

  await svc.startPlan('basic', { clean: false, jobs: null })
  await svc.cancel()
  assert.equal(calls.cancel.length, 1)
  assert.equal(calls.cancel[0].run, 'r-1')
  assert.match(svc.getSnapshot().error, /run 已结束/)
})

test('不可用档发起是无操作（面板置灰的命令面兜底）', async () => {
  const { api, calls } = fakeApi({
    projects: async () => ({
      projects: [{ name: 'led', steps: { build: { ok: false, reason: '工程配置缺失' } } }],
    }),
  })
  const { port, log } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()
  assert.equal(svc.getSnapshot().plans.find((p) => p.id === 'basic').enabled, false)
  await svc.startPlan('basic', { clean: false, jobs: null })
  assert.equal(calls.startRun.length, 0) // 没有悄悄发 run
})

test('显式步骤 runOne 不经过档位过滤（单步是用户点名）', async () => {
  const { api, calls } = fakeApi()
  const { port, log } = fakeEvents()
  const svc = createCockpitService({ api, events: port })
  await svc.init()
  await svc.runOne('doctor')
  assert.deepEqual(calls.startRun[0].steps, ['doctor'])
})
