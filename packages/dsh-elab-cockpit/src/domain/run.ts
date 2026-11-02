/**
 * run 域模型 —— **薄转发壳**。
 *
 * ★ 纯函数归约住在 `@elab/cockpit-ui-core/src/run-events.ts`（与 `cockpit/web` 的
 *   单例 store 共用同一份 `reduce`/`IDLE`/`markStreamClosed`）。本文件只为让
 *   `app/cockpit-service.ts` 与 `adapters/dsh-web/store/run-store.ts` 的相对 import
 *   保持原样；**不要**在这里补业务分支（任何分叉都会让两套 UI 漂移）。
 */

export { IDLE, markStreamClosed, patch, reduce } from '@elab/cockpit-ui-core'
export type { RunSnapshot, StepView } from '@elab/cockpit-ui-core'
