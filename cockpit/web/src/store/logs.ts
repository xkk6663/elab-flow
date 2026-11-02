/**
 * 日志环形缓冲的**组装点** —— 纯逻辑在 `@elab/cockpit-ui-core`（与 DSH 面板共用）。
 *
 * 本文件只剩一件"本宿主的事"：注入"事件 → 通道"的归类规则
 * （`workspaces.ts#channelOfEvent`：构建 / 烧录 / 串口 / 工具）。
 *
 * 为什么日志不进 React store（§15.5）：一次编译能刷上万行 `proc/*`，
 * 每条事件都触发归约 + 渲染协调会直接卡死界面（风险 K7）。
 * 故：环形缓冲 + 命令式 DOM 追加（见 `render/LogView.tsx`）。
 */

import { LogBook } from "@elab/cockpit-ui-core";
import type { ElabEvent } from "../api/types";
import { channelOfEvent } from "../workspaces";

export { LogBook, LogRing, createLogBook, linesOfEvent } from "@elab/cockpit-ui-core";
export type {
  ChannelResolver,
  LogChannel,
  LogEvent,
  LogLine,
  LogTab,
} from "@elab/cockpit-ui-core";

export const logs = new LogBook<ElabEvent>(channelOfEvent);
