/**
 * 测试期模块解析钩子：把裸包名 `@elab/cockpit-ui-core` 指向共享层源码。
 *
 * ★ 为什么需要：C2 规则要求插件 `src` 只用裸包名引用共享层（不得相对逃出包根）；
 *   而 `npm test` 用 `node --experimental-strip-types` 直接跑源码，没有构建别名，
 *   Node 也不会去 npm 解析一个未安装的本地包。这个钩子只在测试期生效
 *   （生产路径仍由 esbuild alias 内联，见 scripts/build-client.mjs）。
 */

const CORE_INDEX = new URL('../../cockpit-ui-core/src/index.ts', import.meta.url).href

export function resolve(specifier, context, next) {
  if (specifier === '@elab/cockpit-ui-core') {
    return { url: CORE_INDEX, shortCircuit: true }
  }
  return next(specifier, context)
}
