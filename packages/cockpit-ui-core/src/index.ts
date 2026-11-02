/**
 * @elab/cockpit-ui-core —— 驾驶舱 UI 中性共享层。
 *
 * 只放**纯 TS 逻辑**：ANSI 解析、字节投影、日志环形缓冲。
 * 禁止：React、fetch/EventSource、node: 内置模块、任何业务层（services / cockpit）
 * 与任意宿主适配器（见 test/purity.test.mjs 门禁）。
 */

export * from "./ansi.ts";
export * from "./bytes.ts";
export * from "./log-buffer.ts";
