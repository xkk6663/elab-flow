# @elab/cockpit-ui-core

驾驶舱 UI 的**中性共享层**：`cockpit/web`（独立 WebUI）与 `packages/dsh-elab-cockpit`（DSH 插件）
在构建期共用同一份纯逻辑，避免"改一处、另一处漂移"。

## 只放什么

- ANSI SGR 解析 / 纯文本化 / 语气判定（`ansi.ts`）
- 串口字节投影：HEX / ASCII / 文本 / 粒度网格 / capture 导出（`bytes.ts`）
- 有界日志环形缓冲 + 事件 → 日志行展开（`log-buffer.ts`）

## 禁止什么（`test/purity.test.mjs` 会拦）

- `react`（共享层不是组件层）
- `fetch` / `EventSource` / `node:` 内置模块（保证纯函数、可被两端内联）
- 业务层路径（`services/`、`cockpit/`）与插件包路径（`packages/dsh-elab-cockpit/`）
- 任何"事件属于哪个通道"的业务归类 —— 由宿主注入 `ChannelResolver`

## 消费方式

两侧都通过**源码别名**引用（不发布 npm 包、不引入 workspace）：

- web：`cockpit/web/vite.config.ts` alias + `tsconfig.json` paths
- 插件：`scripts/build-client.mjs` 的 esbuild alias 内联进 `lib/client.js`；`tsconfig.client.json` paths 仅供类型检查

改这里等于同时改两套 UI —— 改动前先确认行为对两个宿主都成立。
