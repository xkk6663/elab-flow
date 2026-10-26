/**
 * 模拟宿主加载 client.js：验证 ModuleLoader 契约、factory 形状、apply 行为。
 * 不真渲染（那是浏览器的活），只验证"宿主能否成功装载并注册槽位"。
 *
 * ★ 校验规则对齐真实宿主（@deepseek-ai/dsh-cordis-client-runner 的 guardedSlots
 *   + 槽位核心）：
 *   - sidebar.right.pane.tab 是 keyed 槽位：register 必须带 options.key，
 *     只给 id 会抛 "keyed slot ... requires options.key"（2026-10-26 真机实测）。
 *   - factory 只允许 require('react')（practices 禁令 + 模块表白名单）。
 *   - body 与 .title 两个槽位都要注册（title 用同 key 配对）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const code = readFileSync(resolve('lib/client.js'), 'utf8')

let captured = null
const fakeLoader = {
  load(entry) {
    captured = entry
  },
}

// 假的 React（只够让模块求值不炸）
const fakeReactCore = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useSyncExternalStore: () => undefined,
}
// 真实宿主里 require('react') 同时支持命名访问与 default 访问
const fakeReact = { ...fakeReactCore, default: fakeReactCore }

const registered = []
const tabsRegistered = []
const betterTabsRegistered = []
const KEYED_SLOTS = new Set(['sidebar.right.pane.tab'])
const fakeCtx = {
  inject(services, cb) {
    assert.ok(
      Array.isArray(services) && services.length === 1 && ['sidebarRightTabs', 'betterSidebar', 'theme'].includes(services[0]),
      `apply 应通过 ctx.inject 注入 sidebarRightTabs / betterSidebar / theme，收到 ${JSON.stringify(services)}`,
    )
    const fakeServices = {
      // 模板读的是 ctx 属性（c.sidebarRightTabs / c.theme / c.betterSidebar）
      sidebarRightTabs: fakeCtx,
      theme: { theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) } },
      betterSidebar: { betterSidebar: { registerTab(def) { betterTabsRegistered.push(def); return () => {} } } },
    }
    cb(fakeServices[services[0]])
    return () => {}
  },
  on() {},
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(ownerKey, cb) {
      assert.ok(
        ownerKey === 'sidebar.right.pane.tab' || ownerKey === 'sidebar.right.pane.tab.title' || ownerKey === 'settings.section',
        `inject 必须用目标槽位，收到 ${ownerKey}`,
      )
      const dispose = cb()
      return dispose
    },
    register(entry, component) {
      // —— 真宿主守卫的第一道校验：必须给 name ——
      assert.ok(entry && typeof entry === 'object' && typeof entry.name === 'string' && entry.name.length > 0,
        'slots.register(options, component) needs an options object with a `name`')
      // —— 真宿主守卫的第二道校验：keyed 槽位必须给 key（§15.5b 根因）——
      if (KEYED_SLOTS.has(entry.name)) {
        assert.ok(typeof entry.key === 'string' && entry.key.length > 0,
          `keyed slot "${entry.name}" requires options.key`)
      }
      assert.equal(typeof component, 'function', 'component 必须是函数')
      registered.push({ entry, component })
      return () => {}
    },
  },
  sidebarRightTabs: {
    register(definition) {
      // —— 真宿主 SidebarRightTabRegistry.register 的校验 ——
      assert.ok(definition && typeof definition.id === 'string' && definition.id.length > 0, 'tabs.register 需要 id')
      assert.ok(typeof definition.kind === 'string' && definition.kind.length > 0, 'tabs.register 需要 kind')
      assert.ok(!tabsRegistered.some((d) => d.id === definition.id), `sidebarRight: tab type id "${definition.id}" is already registered`)
      const guide = definition.guide ?? []
      assert.ok(new Set(guide.map((g) => g.id)).size === guide.length, 'duplicate guide entry id')
      for (const g of guide) {
        assert.equal(typeof g.title, 'function', 'guide.title 应为 () => string')
        assert.equal(typeof g.icon, 'function', 'guide.icon 应为图标组件（函数）')
      }
      tabsRegistered.push(definition)
      return () => {}
    },
  },
}

// 在受控作用域里执行
const fn = new Function('window', 'module', 'exports', 'console', code)
fn({ __ModuleLoader__: fakeLoader }, { exports: {} }, {}, console)

assert.ok(captured !== null, 'load() 没有被调用')
assert.equal(captured.id, 'dsh-elab-cockpit', 'id 必须是包名')
assert.equal(typeof captured.factory, 'function', 'factory 必须是函数')

// 用假 React 跑 factory
const mod = captured.factory((name) => {
  assert.equal(name, 'react', '只应 require react')
  return fakeReact
})

assert.ok(mod !== null && typeof mod === 'object', 'factory 必须返回对象')
assert.deepEqual(mod.inject, ['slots'], 'inject 应为 slots')
assert.equal(typeof mod.apply, 'function', 'apply 必须是函数')

// 跑 apply，验证槽位注册
mod.apply(fakeCtx)
assert.equal(registered.length, 3, '应注册 3 个槽位项（body + title + 设置节）')
assert.equal(tabsRegistered.length, 1, '应注册 1 个入口卡（sidebarRightTabs）')
assert.equal(betterTabsRegistered.length, 1, '应注册 1 个底部工作台工具（betterSidebar.registerTab）')
const settingsReg = registered.find((r) => r.entry.name === 'settings.section')
assert.ok(settingsReg, '缺少设置节注册（settings.section）')
assert.equal(settingsReg.entry.id, 'dsh-elab-cockpit', '设置节 id')
assert.equal(typeof settingsReg.entry.label, 'function', '设置节 label 应为 () => string')
assert.equal(typeof settingsReg.component, 'function', '设置节组件必须是函数')
const betterTab = betterTabsRegistered[0]
assert.equal(betterTab.id, 'elab-cockpit', '底部工作台工具 id')
assert.equal(betterTab.bottomOnly, true, '必须是 bottomOnly（只进底部面板，不重复进原生右栏）')
assert.equal(betterTab.single, true, 'single：只开一个实例')
assert.equal(typeof betterTab.title, 'function', 'title 应为 () => string')
assert.equal(typeof betterTab.icon, 'function', 'icon 应为 (size) => element')
assert.equal(typeof betterTab.component, 'function', 'component 应为 ({ scope, visible }) => element')
const tabsDef = tabsRegistered[0]
assert.equal(tabsDef.kind, 'dsh-elab-cockpit', '入口卡 kind 必须与 pane.tab 的 key 一致（openTab 依此激活）')

const body = registered.find((r) => r.entry.name === 'sidebar.right.pane.tab')
const title = registered.find((r) => r.entry.name === 'sidebar.right.pane.tab.title')
assert.ok(body, '缺少 body 注册（sidebar.right.pane.tab）')
assert.ok(title, '缺少 title 注册（sidebar.right.pane.tab.title）')
assert.equal(body.entry.key, 'dsh-elab-cockpit', 'body 的 key 必须是包名（keyed 槽位身份）')
assert.equal(body.entry.id, 'dsh-elab-cockpit', 'body 保留 id 字段（诊断用）')
assert.equal(typeof body.entry.inject, 'function', 'body 需要 inject(sessionId) 提供 props')
assert.equal(title.entry.key, 'dsh-elab-cockpit', 'title 的 key 必须与 body 同 key 配对')
assert.equal(tabsDef.kind, body.entry.key, 'kind 与 pane.tab key 不一致会导致入口卡点不开面板')

// 组件能被"渲染"成元素树（不抛）
const tree = body.component({ sessionId: 's1', visible: true })
assert.ok(tree !== null && typeof tree === 'object', '组件应返回元素')
const titleTree = title.component({})
assert.ok(titleTree !== null && typeof titleTree === 'object', 'title 组件应返回元素')

console.log('PASS: client.js 满足宿主 ModuleLoader 契约（含 keyed 槽位 key 校验）')
console.log('  id       :', captured.id)
console.log('  inject   :', mod.inject)
console.log('  body slot:', body.entry.name, 'key=' + body.entry.key)
console.log('  title slot:', title.entry.name, 'key=' + title.entry.key)
console.log('  guide card:', tabsDef.id, 'kind=' + tabsDef.kind, 'guide=' + tabsDef.guide.length)
console.log('  bottom workbench:', betterTab.id, 'bottomOnly=' + betterTab.bottomOnly)
console.log('  settings section:', settingsReg.entry.id, 'order=' + String(settingsReg.entry.order))
console.log('  component:', body.component.name || '(anonymous)')
