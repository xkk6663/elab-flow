/**
 * 打包入口 —— 只导出组件，把 cordis 契约留给外层 factory。
 *
 * 为什么这样拆：`window.__ModuleLoader__.load` 的 factory 是**宿主调用**的，
 * 它返回 `{ inject, apply }`。若把工厂本身也打包进去，打包器会把返回值折叠成
 * 模块导出，外层拿到的是空对象（实测 inject 为 undefined）。
 * 所以这里只暴露组件，契约在 build-client.mjs 里手写。
 */
export { CockpitPane } from './CockpitPane.tsx'
export { SettingsSection } from './SettingsSection.tsx'
export { ensureThemeStyle, applyThemeScheme } from './theme/dsw-map.ts'
