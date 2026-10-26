/**
 * dsh-elab-cockpit —— Client 半入口。
 *
 * 格式遵循 `references/ui-plugin.md` 与已安装插件的实际产物：
 *   直接调用 `window.__ModuleLoader__.load({ id, factory })`；
 *   **不要**包 IIFE 或前置 `if (loader === undefined)` 守卫
 *   （实测：包了之后宿主不认，Client 半永远不激活）。
 *
 * React 从模块表取；不 require 任何 `@deepseek-ai/*` Client 包。
 */

import { CockpitPane } from './CockpitPane.tsx'

const PACKAGE_ID = 'dsh-elab-cockpit'
const SLOT = 'sidebar.right.pane.tab'

window.__ModuleLoader__.load({
  id: PACKAGE_ID,
  factory(require: (name: string) => any) {
    const React = require('react')
    void React

    return {
      inject: ['slots'],
      apply(ctx: ClientSlotContext) {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: PACKAGE_ID }, CockpitPane),
        )
      },
    }
  },
})
