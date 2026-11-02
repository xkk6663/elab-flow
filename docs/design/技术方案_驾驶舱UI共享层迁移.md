# 技术方案：驾驶舱 UI 共享层迁移（WebUI 与 DSH 面板）

> **状态**：方案待评审，未动代码 · **日期**：2026-11-02 · **范围**：`cockpit/web/src` + `packages/dsh-elab-cockpit/src/adapters/dsh-web`
>
> **一句话**：先抽**纯逻辑层**（日志环、ANSI、字节面、事件归约）让两侧共用；再把 **窄栏面板**做成可换宿主的
> `cockpit-panel`——DSH 插件是宿主 A，未来自研 harness（主界面=agent）是宿主 B，右侧栏同一份代码。
> 三列全屏布局不参与共享。

---

## 1. 现状核对（源码事实）

### 1.1 两套 UI 的差异（不是同一份代码）

| 维度 | 独立 WebUI | DSH 插件面板 |
|---|---|---|
| 源码 | `cockpit/web/src/**`（约 5.6k 行） | `packages/dsh-elab-cockpit/src/adapters/dsh-web/**`（约 4.5k 行） |
| 构建 | vite + `@vitejs/plugin-react`，`dist/` 入库（[vite.config.ts](../../cockpit/web/vite.config.ts)） | esbuild 单文件；`external: ['react']`，React 由宿主模块表注入（[build-client.mjs](../../packages/dsh-elab-cockpit/scripts/build-client.mjs)） |
| 主题 | 自带 `theme/tokens.css` + CSS Modules | `theme/dsw-map.ts` 映射 DSH `--dsw-*` 令牌，无 CSS Modules |
| 数据源 | 直接 `fetch('/api/*')` + SSE（`api/client.ts`） | host 适配器 + `app/ports.ts`；双入口共享 SSE、按 `sessionId` 隔离 |
| 形态 | 三列全屏：工程轨 / 阶段轨 / 证据轨（`AppFrame.tsx`） | 窄栏单列 + 设置页 + 首启向导（`CockpitPane.tsx`） |

**唯一共享的是契约**：`/api/*` 路由 + `/api/events` 事件 topic（内核 `STEP_META` / `KERNEL_PLANS` / `SERIAL_META`）。
两套 UI 静态 import 关系为零。

### 1.2 重复度实测（按 trim 后行重合率）

| 模块对 | 重合率 | 判断 |
|---|---:|---|
| `store/logs.ts` ↔ `store/logs.ts` | **99%** | 纯拷贝，首选抽取 |
| `theme/ansi.ts` ↔ `theme/ansi.ts` | **84%** | 解析同源，色板不同 → 抽解析器、色板注入 |
| `serial/bytes.ts` ↔ `serial/bytes.ts` | 40% | 概念同源、实现分叉 |
| `serial/ansiTerminal.ts` ↔ 同名 | 34% | 已分叉，需先对齐语义 |
| `store/runStore.ts` ↔ `events/run-events.ts` + `store/run-store.ts` | 26% | 归约逻辑同源，状态承载不同 |
| `serial/useSerialStream.ts` ↔ 同名 | 24% | **不建议共享**（传输/会话模型不同） |
| `events/sse.ts` ↔ 同名 | 12% | 不建议共享（web 直连 vs 插件 hub） |
| `api/types.ts` ↔ `domain/icd.ts` | 镜像关系 | 类型可抽，但要处理 domain 门禁 |

结论：**逻辑层该抽，视图层不该抽**。视图层的"重复"是形态差异，抽了会两头别扭。

---

## 2. 硬约束（决定方案形状）

| # | 约束 | 出处 | 对方案的影响 |
|---|---|---|---|
| C1 | 工具层不得 import 业务层（含 `cockpit/` 前端） | [boundary.test.mjs §规则 A](../../packages/dsh-elab-cockpit/test/boundary.test.mjs#L61-L70) | 插件不能 `import` `cockpit/web/src`；共享包必须在业务层与工具层之外 |
| C2 | 插件 `src` 的相对 import 不得逃出包根 | [boundary.test.mjs §规则 B-5](../../packages/dsh-elab-cockpit/test/boundary.test.mjs#L72-L81) | 只能走**裸包名**（`@elab/cockpit-ui-core`），不能 `../../../shared/...` |
| C3 | `domain/` 只准 `./xxx` | [boundary.test.mjs §4.4-1](../../packages/dsh-elab-cockpit/test/boundary.test.mjs#L83-L94) | 若 `domain/icd.ts` 改为转发共享类型，需给门禁加一条**显式白名单** |
| C4 | 适配器隔离：`adapters/<dir>` 不得 import 兄弟目录 | [§4.4-3](../../packages/dsh-elab-cockpit/test/boundary.test.mjs#L120-L140) | 共享包不算适配器，不受此限 |
| C5 | 插件 client 半单文件、React 外部化 | [build-client.mjs](../../packages/dsh-elab-cockpit/scripts/build-client.mjs) | 共享包必须能被 **esbuild 内联**，且**不得 import react** |
| C6 | 镜像仓是 `packages/dsh-elab-cockpit` 的 subtree | [AGENTS.md §2](../../AGENTS.md) | 共享包**不能**位于插件包外并被镜像仓"源码构建"——镜像只承载 `lib/` 产物 |
| C7 | WebUI 运行时只有 Python，`dist/` 入库 | [AGENTS.md 分层表](../../AGENTS.md)、[vite.config.ts](../../cockpit/web/vite.config.ts) | 共享包只在**构建期**参与，产物仍落 `dist/` |
| C8 | 设计约束 C33（工具层不复制内核判据） | [设计约束](设计约束.md) | 共享包不得包含步骤/档位/芯片判据，只能是 UI 侧纯函数 |

---

## 3. 目标与非目标

### 3.1 目标

1. 新增中性包 `packages/cockpit-ui-core/`：**纯 TS、零 React、零 I/O、零运行时依赖**。
2. WebUI 与插件都从它取：ICD 类型、日志环、ANSI 解析、字节面、事件归约。
3. 插件侧通过 esbuild **内联**进 `lib/client.js`，npm 包不新增运行时依赖。
4. WebUI 侧通过 vite alias + tsconfig paths 引用源码，`dist/` 照旧入库。
5. 同一套单测跑在共享包上，两边消费。

### 3.2 非目标（明确不做）

- ❌ 不共享三列 / 窄栏布局、DSH 槽位注册、`BootstrapWizard`、`PackSettingsView` 宽度适配。
- ❌ 不把两套布局合并成一个响应式壳（见 §7 路线 C）；但**面板组件本身**按"可换宿主"设计（见 §11）。
- ❌ 不把 `useSerialStream` / `sse.ts` 合并（传输与会话模型不同，强行合并会引入宿主判断）。
- ❌ 不让共享包反向依赖 `services/**`、`cockpit/**`、`packages/dsh-elab-cockpit/**`。

---

## 4. 目标结构

```text
packages/
├─ cockpit-ui-core/                  ← 新增（中性，构建期共享）
│  ├─ package.json                   name=@elab/cockpit-ui-core, private, type=module
│  ├─ README.md                      "中性共享层：不得 import react / services / cockpit / 插件"
│  ├─ src/
│  │  ├─ index.ts                    统一出口
│  │  ├─ icd.ts                      ICD 类型（事件 topic、serial 帧、capabilities）
│  │  ├─ log-buffer.ts               有界日志环（截断 / 序号 / 批量取尾）
│  │  ├─ ansi.ts                     SGR 解析（色板由调用方注入）
│  │  ├─ bytes.ts                    字节面格式化 / HEX / 分块
│  │  └─ run-events.ts               事件 → 阶段/档位/证据的纯归约
│  └─ test/*.test.mjs                共享单测（node --experimental-strip-types）
├─ dsh-elab-cockpit/                 现有插件（只改 import 与构建别名）
└─ ...
cockpit/web/src/                     现有 WebUI（只改 import 与 vite/tsconfig 接线）
```

依赖方向（仍然单向）：

```text
cockpit/web/src ─┐
                 ├─→ packages/cockpit-ui-core （纯 TS，无 React、无 I/O）
dsh-elab-cockpit ┘        ↑ 只被构建期内联/打包，不成为任何一侧的运行时依赖
```

---

## 5. 迁移清单（按批次）

### 5.1 第 1 批：类型 + 日志环（低风险，收益最大）

| # | 源 | 目标 | 处理 |
|---|---|---|---|
| 1 | `cockpit/web/src/api/types.ts`（566 行） | `core/src/icd.ts` | 抽纯类型；web 保留 `api/types.ts` 作为 `export * from '@elab/cockpit-ui-core'` 的兼容壳 |
| 2 | `packages/dsh-elab-cockpit/src/domain/icd.ts` | `core/src/icd.ts` | 同上；**门禁加白名单**（见 §6.2） |
| 3 | 两侧 `store/logs.ts`（214 / 214，99%） | `core/src/log-buffer.ts` | 直接合并为一份；两侧改为薄适配（各自导出原函数名，避免改调用点） |

验收：两侧行为不变；日志截断/序号用例在共享包里跑。

### 5.2 第 2 批：ANSI + 字节面

| # | 源 | 目标 | 处理 |
|---|---|---|---|
| 4 | 两侧 `theme/ansi.ts`（84%） | `core/src/ansi.ts` | 拆成 `parseSgr()` 纯函数 + `palette` 参数；web 传自带色板，插件传 `dsw-map` 映射后的色板 |
| 5 | 两侧 `serial/bytes.ts`（40%） | `core/src/bytes.ts` | 以 web 版为基准（功能更全），插件侧删掉分叉实现；差异点先列清单再合并 |

验收：ANSI 双主题截图对比（终端里跑同一段带 SGR 的字节流），HEX 视图一致。

### 5.3 第 3 批：事件归约

| # | 源 | 目标 | 处理 |
|---|---|---|---|
| 6 | web `store/runStore.ts` + 插件 `events/run-events.ts` / `store/run-store.ts` | `core/src/run-events.ts` | 抽**纯归约函数**（事件 → `{stage, plan, evidence, memory}`）；两侧各自保留 store 外壳（web 用 `useSyncExternalStore`，插件用 host 会话） |

验收：用同一份 `.jsonl` 录制回放，两侧阶梯与证据尾渲染结果一致。

### 5.4 暂不迁移

`serial/useSerialStream.ts`、`events/sse.ts`、`SerialWorkspace.tsx` / `SerialPane.tsx`、全部布局组件。
理由：它们承载"传输 + 会话 + 形态"三件事，共享会把两套产品的差异压进参数，反而更难维护。

---

## 6. 工程接线

### 6.1 共享包 `package.json`

```json
{
  "name": "@elab/cockpit-ui-core",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "node --experimental-strip-types --test \"test/*.test.mjs\"" }
}
```

不发布、不安装：两侧都用**源码路径别名**引用，避免引入 npm workspace 与 lockfile 变更。

### 6.2 插件侧接线

1. `build-client.mjs` 的 esbuild 配置加别名（内联，不产生运行时依赖）：

```js
alias: { '@elab/cockpit-ui-core': resolve(pkg, '../cockpit-ui-core/src/index.ts') }
```

2. `tsconfig.client.json` 加 `paths` 供编辑器与类型检查：

```json
"baseUrl": ".",
"paths": { "@elab/cockpit-ui-core": ["../cockpit-ui-core/src/index.ts"] }
```

3. `domain/icd.ts` 改为 `export * from '@elab/cockpit-ui-core'` 会导致 §4.4-1 失败，
   因此 [boundary.test.mjs](../../packages/dsh-elab-cockpit/test/boundary.test.mjs#L83-L94) 需加一条**显式白名单**：
   `domain/**` 允许 `@elab/cockpit-ui-core`（并在注释里写明"纯类型，无 React/I/O"）。
4. `package.json` 的 `files` **不变**（`lib/` 已内联）；`dependencies` **不变**。

### 6.3 WebUI 侧接线

1. [vite.config.ts](../../cockpit/web/vite.config.ts) 加别名（构建期解析，dev server 同样生效）：

```ts
resolve: { alias: { '@elab/cockpit-ui-core': fileURLToPath(new URL('../../packages/cockpit-ui-core/src', import.meta.url)) } }
```

2. [tsconfig.json](../../cockpit/web/tsconfig.json) 加 `baseUrl` + `paths`，并把 `include` 补上共享包
   源码目录（否则 `noUnusedLocals` 等检查不会覆盖它）。
3. `dist/` 重新构建后入库（保持"改了 tsx 就必须重新 build"的 diff 守卫）。

### 6.4 镜像仓与 npm 的影响

- **npm 包**：`lib/client.js` 已内联共享代码 → 安装者无感知，`files` 不变。
- **镜像仓**：subtree 只含 `packages/dsh-elab-cockpit`，**不含** `packages/cockpit-ui-core`。
  镜像定位仍是"只读分发"，不支持从镜像源码构建；文档与 README 需注明这一点。
- **CI**：`plugin.yml` 在完整主仓检出上构建，共享包存在，构建链不受影响。

### 6.5 新增门禁（建议）

| 规则 | 内容 |
|---|---|
| G1 | `packages/cockpit-ui-core/**` 不得 import `react`、`services/`、`cockpit/`、`packages/dsh-elab-cockpit/` |
| G2 | 共享包不得出现 `fetch` / `EventSource` / `node:` 前缀（保证纯函数） |
| G3 | 两侧同名文件重复度守卫：若再出现同名模块且重合率 > 60%，CI 提示（防止回退成拷贝） |

---

## 7. 路线对比（为什么选"逻辑共享"而不是"UI 合一"）

| 路线 | 做法 | 主要成本 | 主要风险 | 结论 |
|---|---|---|---|---|
| **A（本方案）逻辑共享** | 抽 `cockpit-ui-core`，视图各自保留 | 3 批机械迁移 + 门禁白名单 | 低（纯重构，可逐批回滚） | **推荐** |
| B 逻辑 + primitives | 再抽 `Button/Tag/StateDot/MemoryGauge`，主题走 CSS 变量 | 需重构 web 的 CSS Modules；插件改样式注入 | 中（观感回归风险） | 可作为二期 |
| C 一份 UI 双形态 | web 改成 `mode="full" \| "pane"` 响应式壳 | 布局 / CSS 体系重写；DSH 槽位适配 | 高（两套产品形态被绑死） | 暂不做（自研 harness 走"共享面板 + 独立主界面"，见 §11） |
| D iframe 嵌 web 页面 | 插件 iframe 指向 `127.0.0.1:8333` | 零 | **不可行**：官方规则明确禁止 iframe，拿不到主题令牌 | 否决 |
| E 维持现状 | 只靠人工同步 | 0 | 逻辑继续分叉，bug 双改 | 不推荐 |

---

## 8. 验收矩阵

| # | 场景 | 期望 |
|---|---|---|
| V1 | `packages/cockpit-ui-core` 单测 | 全绿；无 React / I/O import |
| V2 | 插件 `npm test`（含 `boundary.test.mjs`） | 全绿；规则 A / B-5 不回归；新增 domain 白名单有用例 |
| V3 | 插件 `npm run build` + `verify:contract` | 通过；`lib/client.js` 体积变化在预期内（内联共享代码） |
| V4 | WebUI `npm run build`（tsc + vite） | 通过；`dist/` 有对应 diff |
| V5 | 真机闭环截图 | 阶梯 / 日志尾 / 串口终端 / HEX 与迁移前一致 |
| V6 | 录制回放对齐 | 同一份 `.jsonl` 在两套 UI 中阶段与证据一致 |
| V7 | 镜像构建链 | CI（主仓检出）仍可 `git subtree split` 并强推；镜像 `lib/` 自足 |

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 共享包被当成"第三层"，日后塞进业务判据 | README + G1/G2 门禁；C8 约束写进注释 |
| 插件 `lib/client.js` 体积膨胀 | 共享层只放纯函数；构建时看产物大小，超过阈值拆批 |
| 镜像仓源码不可构建引起误解 | 在插件 README 与镜像 README 注明"分发形态，开发请回主仓" |
| 两侧 store 外壳仍分叉 | 只承诺"归约逻辑"共享，外壳差异写进文档，避免过度承诺 |
| 迁移期双份代码短暂并存 | 每批一个 commit，删旧实现与接线同批完成，避免长期双跑 |

回滚：每批都是纯重构（行为不变），直接 `git revert` 该批 commit 即可；`dist/` 与 `lib/` 随源码一起回滚。

---

## 10. 执行顺序（不动代码，先评审）

1. 评审本方案（结构、门禁白名单、镜像说明）。
2. 第 1 批：类型 + 日志环（含门禁调整与共享单测）。
3. 第 2 批：ANSI + 字节面（含双主题截图对比）。
4. 第 3 批：事件归约（含 `.jsonl` 回放对齐）。
5. 补 G1–G3 门禁与 README 说明；插件版本按语义化升 minor（源码重组，行为不变）。

---

## 11. 面向自研 harness 的双宿主规划

> **前提**：后续自研 agent 时，独立 WebUI 的**主区域**做自己的 harness（会话 / 计划 / 工具调用），
> **右侧栏**直接沿用 DSH 插件面板，并要求"改一处、两边同步"。

### 11.1 结论：共享单元从"逻辑"升级为"逻辑 + 面板"

| 层 | 是否共享 | 说明 |
|---|---|---|
| 纯逻辑（ICD / 日志 / ANSI / 字节 / 事件归约） | ✅ | `packages/cockpit-ui-core`（§4） |
| 窄栏面板视图（阶梯 / 证据尾 / 手动条 / 串口 / 设置 / 向导） | ✅ | 新增 `packages/cockpit-panel`，只依赖 core + React peer |
| DSH 宿主壳（槽位注册、token 映射、进程托管） | ❌ | `packages/dsh-elab-cockpit` 保留为**宿主 A** |
| 自研 harness 主界面（对话 / 计划 / 工具 UI） | ❌ | 未来独立开发，**不共享** |
| WebUI 三列轨（`cockpit/web/src/rails/**`） | ❌ | 旧形态，自研 harness 就绪后被替换；**不再投入共享改造** |

目标结构（双宿主、一份面板）：

```text
                 ┌──────────────────────────────┐
                 │ packages/cockpit-ui-core     │ 纯 TS：ICD/日志/ANSI/字节/归约
                 └──────────────┬───────────────┘
                                │
                 ┌──────────────▼───────────────┐
                 │ packages/cockpit-panel       │ React 面板（窄栏全功能）
                 │  + host 契约（PanelHost）     │
                 └───────┬──────────────┬───────┘
                         │              │
        ┌────────────────▼───┐      ┌───▼──────────────────────┐
        │ DSH 宿主（现有插件） │      │ 自研 harness 宿主（未来）  │
        │ 槽位/令牌/进程托管   │      │ 主界面=agent，右栏=panel  │
        └────────────────────┘      └──────────────────────────┘
```

### 11.2 宿主契约（`PanelHost`，面板唯一的外部依赖）

面板组件不得直接 `fetch`、不得直接读 `localStorage`、不得 spawn 进程，一律经宿主注入：

```ts
export interface PanelHost {
  icd: IcdClient;                  // baseUrl 或反代前缀由宿主决定
  session: { id: string };         // 双入口/多会话隔离
  theme: ThemeTokens;              // 语义令牌，见 11.3
  storage: { get(k: string): string | null; set(k: string, v: string): void };
  clipboard: { write(text: string): Promise<void> };
  logSink?: { export(name: string, text: string): void };  // 导出落盘由宿主负责
  lifecycle: { onMount?(): void; onUnmount?(): void };
}
```

DSH 宿主实现：`icd` 走 `/elab` 反代、`theme` 由 `dsw-map` 产出、`storage` 走配置白名单、`logSink` 走下载。
自研 harness 宿主实现：`icd` 直连 `127.0.0.1:8333`、`theme` 用自己的 token 表、`storage` 走本地偏好。

### 11.3 为"换宿主"必须现在就定的三件事

1. **语义令牌层**：面板只使用 `--elab-*`（如 `--elab-bg`, `--elab-fg-dim`, `--elab-accent`），
   宿主各自提供映射。现状已很接近——DSH 令牌只在 `theme/dsw-map.ts` 一个文件出现（[dsw-map.ts](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/theme/dsw-map.ts)），
   改造面比想象小。
2. **样式交付方式**：插件走 esbuild、harness 可走 vite，**不能用 CSS Modules**。
   面板样式收敛为一份普通 CSS，两种构建都以"文本注入 `<style>`"方式带上（esbuild 加 text loader，vite 走 `?inline`）。
3. **React 作为 peer**：面板不得打包 React、不得假设 React 单例来源；两侧都是 React 18，宿主提供实例。
   若未来 harness 换 React 版本，面板需保持无 Context 依赖，只用 props。

### 11.4 分期（在原三批之上追加）

| 期 | 内容 | 依赖 |
|---|---|---|
| P0 | `cockpit-ui-core`：类型 / 日志 / ANSI / 字节 / 归约（§5 三批） | 无 |
| P1 | 抽 `cockpit-panel`：把 `CockpitPane` / `StageLadder` / `EvidenceTail` / `ManualBar` / `SerialPane` / `PackSettingsView` / `BootstrapWizard` 迁入，宿主差异全部外提到 `PanelHost`；DSH 成为首个宿主，真机验收 | P0 |
| P2 | 自研 harness 宿主：主区域做 agent，右栏挂 `cockpit-panel`；同时退役 `cockpit/web/src/rails/**` | P1 |
| P3（可选） | 抽 `packages/cockpit-host`：把现在插件里与 DSH 无关的宿主能力（Python 探测、内核下载、子进程托管、环境包安装）复用给 harness，避免第二套进程管理 | P1 |

P1 的额外验收：用一个最小"假宿主"（内存 storage + mock ICD）渲染面板，跑通阶梯 / 日志 / 串口；
证明面板没有隐藏的 DSH 依赖。这是"未来能换宿主"的唯一硬证据。

### 11.5 P1 文件级拆分边界（调研结果）

**口径**：插件 `src/` 共 46 文件 / 13,199 行（`adapters` 33 / 9,904，`app` 4 / 1,527，`domain` 9 / 1,768）。
按"是否依赖 DSH / 是否依赖浏览器 I/O"分四类：

| 去向 | 文件（行数） | 理由 |
|---|---|---|
| **`cockpit-ui-core`（纯 TS）** | `domain/icd.ts`(797) `run.ts`(201) `pipeline.ts`(238) `channels.ts`(79) `adapt.ts`(128) `arbiter.ts`(95) `bootstrap.ts`(84) `envpack.ts`(97) `kernel-meta.ts`(49)；`app/cockpit-service.ts`(666)；`app/ports.ts` 的**客户端端口段**（`IcdPort`/`SerialPort`/`RunEventsPort`/`RunEventSink`/`RunEventConnection`）；`store/logs.ts`(214)；`theme/ansi.ts`(88)；`serial/bytes.ts`(122) | 无 React、无 I/O、无宿主假设；`cockpit-service` 只 import domain + ports 类型，已可直接迁 |
| **`cockpit-panel`（React + 浏览器）** | `CockpitPane.tsx`(914) `SerialPane.tsx`(1,413) `PackSettingsView.tsx`(656) `BootstrapWizard.tsx`(457) `SettingsSection.tsx`(291) `EvidenceTail.tsx`(307) `ManualBar.tsx`(266) `StageLadder.tsx`(239)；`serial/useSerialStream.ts`(380) `serial/ansiTerminal.ts`(188)；`events/sse.ts`(217) `events/run-events.ts`(88)；`kernel-http/icd-client.ts`(272，改为 `createIcdClient({ base: '/elab' })`） | 纯浏览器/React，只依赖 core + 注入的宿主端口 |
| **留 DSH 宿主壳** | `entry.ts`(11) `index.tsx`(28)；`theme/dsw-map.ts`(127，改为把 DSH 令牌映射成 `--elab-*`）；`app/host-app.ts`(444) `app/auto-provision.ts`(228)；`kernel-http/*` 的宿主半（`routes.ts`/`discovery.ts`/`discover-route.ts`/`route-guard.ts`）；`adapters/kernel-process/**`、`adapters/env/**`、`adapters/dsh-tools/**`、`adapters/fs-store/**`、`main.ts` | 承载 DSH 槽位、cordis 生命周期、BFF 路由、Python/内核/工具链托管 |
| **`app/ports.ts` 的宿主端口段** | `KernelPort` / `KernelProxyDeps` / `ToolDeps` / `RetentionConfig` / `SerialMutexPort` | 只被宿主半消费，留在插件里；文件拆分时按段切割 |

**逐点耦合清单（P1 必须改的行）**

| 位置 | 现状 | 改法 |
|---|---|---|
| [CockpitPane.tsx#L34](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/CockpitPane.tsx#L34) | `import { elabApi }` | 改为从 `host` 取 `api`/`events` |
| [CockpitPane.tsx#L310](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/CockpitPane.tsx#L310) | `createCockpitService({ api: elabApi, events: createRunEventsPort(), sessionId })` | `createCockpitService({ api: host.api, events: host.events, sessionId: host.sessionId })`，删掉 `createRunEventsPort` 直连 |
| [CockpitPane.tsx#L80-L99](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/CockpitPane.tsx#L80-L99) | `window.localStorage` 读写串口偏好 | 改 `host.storage.get/set`（宿主禁写时自动降级为内存） |
| [BootstrapWizard.tsx#L173-L474](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/BootstrapWizard.tsx#L173-L474) | `globalThis.localStorage` 存"已关闭"时间 | 同上，键前缀由宿主决定 |
| [PackSettingsView.tsx#L23](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/PackSettingsView.tsx#L23) + [L115](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/PackSettingsView.tsx#L115) | `import elabApi`，`api: typeof elabApi` | 改为 `api: PanelApi`（`IcdPort & SerialPort & 包市场子集`） |
| [SettingsSection.tsx#L13](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/SettingsSection.tsx#L13) + [L77-L138](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/SettingsSection.tsx#L77-L138) | 直接调 `elabApi.env/getConfig/saveConfig/bootstrap` | 改为 `host.api` + `host.capabilities`（无 env 探测的宿主隐藏该段） |
| [serial/useSerialStream.ts#L72](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/serial/useSerialStream.ts#L72) | 已声明 `SerialPort` 端口 | 无需改结构，只把实例从 `elabApi` 换成 `host.serial` |
| [index.tsx#L26](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/index.tsx#L26) | `ctx.slots.register(...)` | 留在 DSH 壳，不改 |

**修订后的 `PanelHost`（比 §11.2 更具体）**

```ts
export interface PanelHost {
  api: PanelApi          // IcdPort & SerialPort & 包市场子集（packs/pkgInstall/pkgVerify/...）
  events: RunEventsPort  // SSE 实现由宿主给（DSH 走 /elab/events；harness 直连 /api/events）
  sessionId?: string
  visible?: boolean
  storage: { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void }
  download?: (name: string, text: string) => void      // 日志/录制导出
  openExternal?: (url: string) => void                 // 引导向导里的下载页
  capabilities: {
    envProbe: boolean         // /elab/env
    bootstrap: boolean        // /elab/bootstrap（clone/装工具链/下内核）
    packMarket: boolean       // 芯片市场安装
  }
  themeScheme: 'dark' | 'light'
}
```

**三条关键调研结论**

1. **端口抽象已经就位**：`app/ports.ts` 早就把 `IcdPort` / `SerialPort` / `RunEventsPort` 声明成接口，编排层 `cockpit-service` 只依赖类型，不 import 实现。面板迁出主要是"把两个组件的直接 import 换成 props"，不是重构业务。
2. **宿主专属能力要显式降级**：`/elab/host`、`/elab/env`、`/elab/bootstrap`、`/elab/config` 是**插件宿主半**的实现，内核并没有同形端点。自研 harness **挂一套同形 `/elab` BFF（已定，见 §11.7）**，复用 P3 的 `cockpit-host`；面板的 `capabilities` 只用于"BFF 尚未实现某段"时的降级，不作为默认路径。
3. **DSH 特有面已被收窄到一个文件**：DSH 令牌只出现在 `theme/dsw-map.ts`；槽位注册只在 `index.tsx`（28 行）。其余"适配"是宿主半能力（进程/环境/工具），与面板无关。

**P1 施工顺序（纯搬迁，不改行为）**

1. 建 `packages/cockpit-panel`，先把组件**整目录搬入**（不改写），用 esbuild 别名指向 core；
2. 把 `elabApi` 直连改为 `host` 注入口（上表 7 处）；
3. `dsw-web` 残留只留 `entry/index/dsw-map`，由 DSH 壳构造 `host`（`api` 来自既有 `elabApi`，`theme` 来自 `dsw-map`）；
4. 用"假宿主"（mock `api` + 内存 storage + 假 `events`）渲染 `CockpitPane` 冒烟：阶梯/日志/串口三块走通；
5. 真机回归：DSH 面板功能与迁移前逐项对照（阶梯、三档、串口四视图、设置页、向导）；
6. 回归 `boundary.test.mjs`：把"dsh-web → kernel-http"白名单改成"panel 只依赖 core + host 端口"，防止再长出直连。

**P1 验收补充**：`packages/cockpit-panel` 不得出现 `elabApi`、`window.localStorage`、`/elab/` 字面量（后两者由宿主注入）；出现即视为迁移不完整。

### 11.6 对现有计划的调整

- **不做的**：不再为 `cockpit/web` 的三列轨做共享改造（它是过渡形态，改造成本收不回来）。
- **要做的**：把 `cockpit-panel` 的抽取提前到 P1，和 core 一起成为"唯一面板实现"。
- **保持的**：逻辑层共享仍是第一步；`cockpit/web` 继续可运行，直到 harness 宿主接管。
- **注意**：面板迁出插件包后，镜像仓（subtree 只含 `packages/dsh-elab-cockpit`）依旧只承载 `lib/` 产物，
  源码开发回主仓；`npm` 包靠 esbuild 内联，不新增运行时依赖（§6.4 不变）。

---

### 11.7 同形 `/elab` BFF 契约（已定）

自研 harness 提供与插件宿主半**同形**的 `/elab` 前缀，面板与 `icd-client` 不改路径常量，
只由宿主给 `base: '/elab'`。

| BFF 路由 | 后端来源 | 说明 |
|---|---|---|
| `GET /elab/host` | harness 自身 | 返回 `elabRoot / running / port / kernelVersion`（面板头部与版本徽标用） |
| `GET /elab/env` | harness 环境探测 | 六项白名单版本探测（python/git/cmake/ninja/arm-gcc/openocd），**不 spawn 内核** |
| `POST /elab/bootstrap` | harness 写动作 | `set-root` / `clone` / `install-toolchain` / `download-kernel`，写操作要 `confirm:true` |
| `GET/POST /elab/config` | harness 配置 | 白名单键（`elabRoot` / `pythonPath` / `autoProvision` / `bootstrap`） |
| `/elab/api/*` | 反代内核 `/api/*` | 路径改写，保留 query 与 `x-elab-actor` 头 |
| `/elab/events` | 反代内核 `/api/events` | SSE 直通：`run` / `from` 透传，见下方约束 |
| `/elab/api/pkg/*` | 反代内核 `/api/pkg/*` | 芯片市场安装/校验 |

**SSE 直通约束（必须）**：

- 不缓冲、不 gzip：`Cache-Control: no-cache`、`X-Accel-Buffering: no`、逐帧 flush；
- 保留 `run` / `from` 查询参数，断线重连由 `EventSource` 自动带 `Last-Event-ID`；
- 15 s 心跳由内核发，BFF 不得改写；
- `stream/closed` 事件不可丢——面板据此收尾阶梯与证据。

**会话映射**：`?session=` 由 BFF 解析为"workspace → 内核实例/端口"，维持面板的
`sessionId` 语义；同一 harness 下多 workspace 各起一个内核（端口从 8333 起递增）。

**实现归属**：BFF 与进程托管一并由 P3 的 `packages/cockpit-host` 提供，
harness 只做路由挂载与 workspace 选择，不复制 `host-app.ts` 的业务分支。

---

## 12. 相关文档

- [架构分析和项目仓库的依赖关系](../architecture/架构分析和项目仓库的依赖关系.md)
- [技术方案_dsh-elab-flow插件移植](技术方案_dsh-elab-flow插件移植.md)（§16 分层边界）
- [技术迁移方案_串口监视与调试可视化](技术迁移方案_串口监视与调试可视化.md)（串口数据面与解码）
- [设计约束](设计约束.md)（C33：工具层不复制内核判据）
