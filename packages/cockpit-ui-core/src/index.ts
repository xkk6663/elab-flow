/**
 * @elab/cockpit-ui-core —— 驾驶舱 UI 中性共享层。
 *
 * 只放**纯 TS 逻辑**：ICD 类型、ANSI 解析、字节投影、日志环形缓冲、
 * 事件 → 通道归类、run 事件归约。
 * 禁止：React、fetch/EventSource、node: 内置模块、任何业务层（services / cockpit）
 * 与任意宿主适配器（见 test/purity.test.mjs 门禁）。
 *
 * ★ 两侧的**宿主差异**只能是参数，不在这里分叉：
 *   `channelOfEvent(e, { debugChannel })` —— WebUI 默认把 debug_verify 并进烧录，
 *   DSH 窄栏显式传 true 拆出调试通道。
 */

export * from "./ansi.ts";
export * from "./bytes.ts";
export * from "./channels.ts";
export * from "./icd.ts";
export * from "./log-buffer.ts";
export * from "./run-events.ts";
export * from "./send-history.ts";
