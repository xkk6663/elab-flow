/**
 * 事件与 API 的类型契约 —— **薄转发壳**。
 *
 * ★ 定义住在 `@elab/cockpit-ui-core/src/icd.ts`（含 `EVENT_SCHEMA_VERSION` /
 *   `KNOWN_TOPICS`）；本文件只让 WebUI 内部的 `from "./types"` 保持原样，不复制合同。
 *   DSH 插件 `domain/icd.ts` 因 host 构建的 rootDir 限制仍是自包含镜像（内容同源）。
 *   改字段名/语义仍须三处同步：`docs/ICD_cockpit_events.md`、
 *   `services/elab/kernel/events.py`、共享层 `icd.ts`（ICD §7）。
 */

export * from "@elab/cockpit-ui-core";
