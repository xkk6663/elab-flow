# elab-Flow 驾驶舱 → DSH 插件移植 · 技术方案

> **状态**：调研定稿 v2（Q1–Q5 已拍板，待施工） · **日期**：2026-10-25 · **仓库**：`C:\Users\xiao1\Desktop\ELAB\dsh-elab-flow`（由 `elab-flow` fork，HEAD `5b837bc`，工作树干净）
>
> **一句话**：把 elab 驾驶舱的三轨**窄栏化重构为「阶梯 + 日志尾」**，以 DSH **原生右栏槽位**（`sidebar.right.pane.tab`）形式装进 DSH Web，语义层（事件契约 / 归约 / 环形缓冲）**零改动**移植；Python 内核**不迁移**，由 Host 半托管为 loopback 子进程；**AI 跑闭环（过程可视）与人工按键并存**，触发面只有三种（单步 / 一键三连 / 一键闭环），互斥规则由 Host 半统一仲裁。
>
> 相关事实源：[ICD_cockpit_events.md](ICD_cockpit_events.md) · [技术方案_闭环驾驶舱.md](技术方案_闭环驾驶舱.md) · `cockpit/server.py` · `cockpit/web/src/**`
>
> **v2 修订记录（2026-10-25 评审结论）**
> 1. Q1–Q5 全部按建议落定（§11 改为"已决策"，逐条记录）。
> 2. **P0 改为 iframe 探针先行**（§8.0），半天验证"右栏装得下、桥接通"；`dsh-elab-iframe` 独立成包，P3 之后可长期共存为"大屏模式"。
> 3. 触发面收敛为 **三档一键流**（P-basic / P-triple / P-loop），**不做**"勾选部分步骤"多选（§6.6 新增，含前置条件校验与降级规则）。
> 4. 新增 §4.6 源码研究结论：`services/elab` **确为纯标准库**（import 清单实读），Host 半不接管环境，只转交 `--root`。

---

## 0. 一页纸结论

| 维度 | 结论 |
|---|---|
| **fork 位置** | `C:\Users\xiao1\Desktop\ELAB\dsh-elab-flow`（`cp -r`，`.git` / `node_modules` / `.work` 一并保留，可直接回滚） |
| **插件落点** | 两个平级子包：`packages/dsh-elab-cockpit/`（正式窄栏，主线）+ `packages/dsh-elab-iframe/`（P0 探针，长期保留为"大屏模式"） |
| **P0 策略** | **iframe 探针先行**：Host 半托管 Python → 槽位内 `<iframe src="http://127.0.0.1:<port>/?embed=1">`；用于实测右栏可用宽度、主题跟随、交互手感，并作为 P3 的对照基线 |
| **UI 形态** | DSH 原生右栏 tab（keyed slot `dsh-elab-cockpit`），**不自建 body 根**（区别于 dsh-better-sidebar 的做法；理由见 §3.2） |
| **信息层级** | **阶梯**（StageLadder）= 状态 + 单步入口；**控制条** = 三档一键流；**日志尾**（EvidenceTail）= 焦点步骤的实时输出；顶部**工程条**（可折叠） |
| **数据通路** | Host 半 `spawn(python -m cockpit.server)` → `127.0.0.1:<随机端>` → 反代 `/elab/api/*` + **SSE 透传**（不降级为 WS） |
| **语义层复用** | `api/types.ts`（486 行）、`store/runStore.ts`（276 行）、`store/logs.ts`（241 行）、`theme/ansi.ts`（91 行）、`workspaces.ts` 的 `channelOfEvent` —— **合计约 1100 行零改动** |
| **视图层重写** | 三轨 + AppFrame + layoutStore ≈ **1700 行 → 窄栏组件 ≈ 900 行**，原子层换 DSH `ui-primitives` |
| **人工按键** | 阶梯行首 **▶** = 单步；控制条 = **P-basic / P-triple / P-loop** 三档 + 取消 + 预览；串口行内输入框；AI 在跑时**不是全灰**，见 §6.3 |
| **触发面（已定）** | 单步 \| **一键三连**（编译→烧录→调试校验）\| **一键闭环**（全流程）；**不做**部分步骤多选（§6.6） |
| **boot + app** | **框架已内建**（Q13，§6.7）：`build` 自动级联编 boot、`flash` 一次 openocd 会话原子烧 boot+app（冻结台账决定 boot 是否进会话）。**插件零 Python 改动，只做可视化** |
| **工程选择** | **会话级**（Q10）：每个会话各自记住当前工程，切会话不串台 |
| **发现与接入** | 打开仓库即列出会话 cwd 下未接入的 CMake 工程；**探测复用 `elab adapt`（13 步探测 / 6 级证据 / 三分类裁决），插件只换入口不造逻辑**；写入保持两段式，**不提供 `--force` UI**（§13） |
| **`debug_verify`** | openocd **硬件寄存器级调试**（断 `main`），不是 CI 专用（Q14）；日志尾独立 `debug` 通道 |
| **"AI 跟上"机制** | Host 半内存 `lastRun` + 面板可见时拉取；**不新增 ICD 事件、不改 Python**（决策 D3） |
| **主题跟随** | **原生跟随**（路径一，§5.5）：令牌映射到 DSH 的 18 个 `--dsw-alias-*`，不订阅、不做主题 UI；唯一例外是 ANSI 16 色需按 `active.colorScheme` 选一套（6 行） |
| **里程碑** | **P0 iframe 探针 0.5d** → P1 Host 骨架 1.5d → P2 事件通道 1d → **P3 阶梯+日志尾 2.5d** → P4 融合 1d → P5 工具化与并存 1d（约 7.5 人日） |

---

## 1. 输入盘点（源码实读，非推测）

### 1.1 待迁移方：elab 驾驶舱

| 层 | 文件 | 行数 | 迁移判定 |
|---|---|---:|---|
| Host 服务 | `cockpit/server.py` | 1352 | **不迁移**；进程托管 + 反代 |
| 业务内核 | `services/elab/**` | 1.2 MB | **不迁移**；保持 Python 侧唯一实现 |
| 事件契约 | `docs/ICD_cockpit_events.md` + `kernel/events.py` | — | **不动**（兼容性承诺） |
| API 类型 | `cockpit/web/src/api/types.ts` | 486 | **原样复用** |
| API 客户端 | `api/client.ts` | 188 | 改 baseURL（`/api/` → `/elab/api/`），逻辑不动 |
| 事件通道 | `events/sse.ts` | 161 | **保留 SSE**，仅改端点 + 重连语义对齐 Host 半 |
| 归约 | `store/runStore.ts` | 276 | **原样复用** |
| 日志 | `store/logs.ts` | 241 | **原样复用**（环形缓冲 + 命令式 DOM 追加，禁用 React 状态承接 proc 流） |
| 通道归类 | `workspaces.ts#channelOfEvent` | ~40 | 抽取为纯函数复用 |
| ANSI | `theme/ansi.ts` | 91 | 原样复用 |
| 视图 | `rails/{Projects,Stage,Evidence}Rail.tsx` | 451+622+462 | **重写为窄栏**（保留纯函数：`fullLoopSteps`、`stepLabel`、置灰判定） |
| 渲染 | `render/{LogView,MemoryGauge}.tsx` | 223+65 | `LogView` 复用命令式追加内核，缩窄排版；`MemoryGauge` 参数化复用 |
| 原子 | `primitives/*`（11 个） | ~700 | **不复用**，换 DSH `@deepseek-ai/dsh-client-ui-primitives` |
| 外壳 | `App.tsx` / `AppFrame.tsx` / `App.module.css` | ~700 | **删除**（宽度/折叠/Tab 交给 DSH `ctx.layout`） |
| 令牌 | `theme/tokens.css` + `global.css`（43 KB 产物级） | ~400 | **删除**，换 DSH Theme token |

### 1.2 模仿对象：dsh-better-sidebar v0.28.0（实读源码）

| 事实 | 对本次移植的意义 |
|---|---|
| Host 半 `export const inject = ['webServer','sessions','connection','tools']`，用 `ctx.webServer.register({kind:'exact'\|'prefix', path, handler})` 挂路由，`ctx.effect()` 返回 disposer | **照抄**路由注册与生命周期写法 |
| 每条路由先跑 `ctx.connection.requestRejection(req)`，拒绝即 403 | **必须照抄**：不自己发明鉴权 |
| 推流用 `registerUpgrade` + `ws`，不是 SSE | **不照抄**：SSE 透传改动面更小（见 §4.3 选型对比） |
| Client 半 `ctx.provide('betterSidebar', service)`，`registerTab/registerFileViewer` 返回 disposer | 若未来要做"elab tab 注册服务"可参考，本方案不需要 |
| Client 半用 **`document.createElement('div')` 挂 `<body>` + `createRoot`** 自渲染整块面板，槽位只注册 `settings.section` | **不照抄**：原因见 §3.2（两套侧栏抢右列、DSH 主题不自动生效） |
| `package.json` 有 `dsh.bundle.patch` + `dsh.client.inject`（宿主包清单）；`cordis.patch.yml` 单条 `insert` + `!!js` 防重复挂载 | **照抄**打包与挂载形制 |
| 多入口分包 `lib/{index,client,client-editor,...}.js`（大依赖 lazy chunk） | 本插件首版只有 2 入口（`index.js` / `client.js`），无大依赖 |

### 1.3 DSH 侧可用扩展点（`cordis_inspect_query` 实读，2026-10-25）

| 扩展点 | 形态 | 用途 |
|---|---|---|
| `sidebar.right.pane.tab` | keyed slot，session scope，接收 `standardProps`（`useSessions`/`useSession`/`useProjection`/`sessionId`…） | **主面板** |
| `sidebar.right.pane.tab.title` | keyed slot，同 key | tab 标题（可显示阶梯进度小徽标） |
| `sidebar.right.tab.menu.item` | list slot | 「在新窗口全屏打开」等 |
| `sidebar.panellist` | list slot | 左栏入口图标（一键打开右栏） |
| `settings.section` | list slot | 插件设置页（pythonPath / elabRoot / 自动托管开关） |
| `ctx.layout.openRightbar(track, fullscreen)` / `closeRightbar()` | Client Service | 从工具/聊天跳转打开 |
| Host Service：`webServer` / `sessions` / `connection` / `tools` / `settings` | Host | 路由、会话 cwd、鉴权、工具注册、配置 |

> **关键**：`sidebar.right.pane.tab` 的 keyDomain 是"open"（无编译期 key 集），这意味着**注册一个自有 key 不会与 better-sidebar / 官方文件预览冲突**（实测该槽位已有 18 个 occupant）。

---

## 2. 目标与非目标

### 2.1 目标（对应本次需求原话）

1. **fork 完成**，在 fork 内做插件移植与新前端，不动原 `elab-flow` 仓库。
2. 驾驶舱以 **DSH 右栏窄栏面板**形态存在，**阶梯 + 日志尾**为主信息层级。
3. **AI 在跑闭环时，阶梯与日志尾同时可视化**（谁发起、到哪一步、输出实时滚动）。
4. **人工按键功能完整保留**：单步执行、全闭环、取消、命令预览、串口手写、工程切换、适配。
5. 交付一份**可施工**的详细技术方案（本文）。

### 2.2 非目标（本期明确不做）

- 不把 `services/elab` 移植到 Node/TS（工具链、OpenOCD、串口已验证在 Python 侧）。
- 不做自有侧栏（不复刻 better-sidebar 的 body 挂载方案）。
- 不改 `EVENT_SCHEMA_VERSION`，不改 ICD 中已有字段语义。
- 不重做 `cockpit.cmd` / Edge `--app` 独立窗口路线（保留为"独立驾驶舱"入口，二者可并存）。
- 不做移动端/远程暴露（Python 服务继续只绑 `127.0.0.1`）。

---

## 3. 架构

### 3.1 分层总览

```
┌─ DSH Web (127.0.0.1:6869) ─────────────────────────────────────────────┐
│                                                                        │
│  Client 半：packages/dsh-elab-cockpit/src/client/index.ts             │
│   inject: ['slots','sessions','locale','connection']                   │
│   ├ slots.register(sidebar.right.pane.tab,      key: 'dsh-elab-cockpit')
│   ├ slots.register(sidebar.right.pane.tab.title,key: 'dsh-elab-cockpit')
│   ├ slots.register(sidebar.panellist,           id:  'elab-cockpit')   │
│   └ slots.register(settings.section,            id:  'elab-cockpit')   │
│                                                                        │
│   <CockpitPane/>                                                       │
│    ├ ProjectStrip   ← 工程条（折叠态一行 / 展开态卡片行）+「＋适配」     │
│    ├ StageLadder    ← 阶梯：步骤即按钮，状态点+耗时+单行 detail         │
│    ├ ManualBar      ← ▶全闭环  ■取消  👁预览  ⚙选项（clean/-j）         │
│    ├ EvidenceTail   ← 日志尾：通道切换 + 命令式追加 + 串口输入行         │
│    └ StatusHint     ← 阻塞/互斥/背压的显式说明（一句话，不弹窗）         │
│                                                                        │
│  ← /elab/api/* (JSON)  /elab/events (SSE 透传)  /elab/host (健康/控制)  │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ 同进程 HTTP（SSRF 面收敛到 loopback）
┌─ Host 半：packages/dsh-elab-cockpit/src/index.ts ──────────────────────┐
│  inject: ['webServer','sessions','connection','tools']                 │
│   ├ ElabHostProcess（托管生命周期）                                     │
│   │   spawn(python, ['-m','cockpit.server','--port','0','--root',…])   │
│   │   ← 从 stdout 首行正则取真实端口；SIGTERM 优雅退出；崩溃退避重启     │
│   ├ /elab/api (prefix)  → 白名单方法转发 → Python /api/*                │
│   ├ /elab/events        → SSE 字节级透传（保留 id/event/data 帧）        │
│   ├ /elab/host          → 健康、重启、环境体检（只读为主）               │
│   ├ RunArbiter          → run 归属仲裁 + 串口互斥（§6）                  │
│   └ tools               → elab_build / elab_loop / elab_serial …        │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
                    python -m cockpit.server (loopback, 随机端口)
                                │
                    services/elab/**（零改动）
```

### 3.2 为什么**不**照抄 better-sidebar 的自建栏（决策 D1）

| 方案 | 做法 | 问题 |
|---|---|---|
| B. 自建 body 根 | `document.body` 追加 div + `createRoot` + 自己的侧栏轨道 | ①与 better-sidebar 的右栏轨道**抢几何**（两者都会调 `ctx.layout.openRightbar`）；②DSH 主题/字号/密度变化不自动作用于面板；③组件不享受 `standardProps` 里的 `sessionId`/`useSessions` 等会话上下文；④DSH 升级改了布局，自建栏要跟着改。 |
| **C. 原生槽位（选定）** | 注册 `sidebar.right.pane.tab` + `title` + `panellist` | 面板由 DSH 右栏承载，主题/宽度/浮动/全屏全部复用宿主；会话上下文直接来自 `standardProps`；升级面小。 |

**代价**：右栏默认宽度约 320–360 px，三轨必须窄栏化 —— 这正是本次需求要做的"阶梯 + 日志尾"。

### 3.3 窄栏信息架构（本次需求的核心）

```
┌─ DSH 右栏 · 320px ──────────────────────────┐
│ ▸ f411_boot            ● running 12.4s   ↻  │  ← 工程条折叠态（点开切换工程）
│ ┌─────────────────────────────────────────┐ │
│ │ ● 体检        ok      0.42s             │ │  ← 阶梯：每行 = 一步 = 一个按钮
│ │ ● 编译        ok      4.80s  FLASH 7.4% │ │     状态点 / 名称 / 耗时 / 单行 detail
│ │ ● 烧录        ok      2.10s             │ │     hover 显示完整指令（预览）
│ │ ◐ 调试校验    running 1.2s  ▶ 单步     │ │     ▶ = 只跑这一步；点行体 = 聚焦日志
│ │ ○ 串口闭环    pending                  │ │
│ ├─────────────────────────────────────────┤ │
│ │ ▶闭环  ▶▶三连  ▶编译  ■取消  👁  ⚙     │ │  ← 三档一键流 + 取消/预览/选项（常驻）
│ │ 探针 ● 在位   串口 ● 空闲    12.4s       │ │  ← 环境行：按钮为什么点不了，看这里
│ ├─────────────────────────────────────────┤ │
│ │ 构建 │ 烧录 │ 串口 │ 工具      ▾ 跟随    │ │  ← 日志尾：通道 = 阶梯步骤的投影
│ │ [ 12:03:41 ] configure ...              │ │
│ │ [ 12:03:44 ] Building C object ...      │ │     命令式追加，最多 1500 行环形（窄栏）
│ │ [ 12:03:47 ] FLASH 7.39% RAM 9.62%      │ │
│ │ > 手敲一行发给设备            [115200]   │ │  ← 仅串口通道出现
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**四条映射关系（本方案的形式化定义）**

1. **阶梯 = 步骤状态机的一维投影**：`runStore.steps[]` 直接渲染；`state ∈ {pending, running, ok, failed, skipped, cancelled}` 由 `reduce()` 决定，组件**不推导**。
2. **日志尾 = 当前焦点步骤的通道**：`focusStep`（用户点行体 或 自动跟随 `currentStep`）→ `channelOfEvent` 映射到 `build|flash|serial|tools` → `logs.ring(channel)`。焦点切换**不会**丢日志（每通道独立环形缓冲）。
3. **手动按键 = 阶梯节点的同一份可用性判定**：`card.steps[id].ok/reason`（服务端算好）同时驱动①▶ 是否可点、②置灰 tooltip、③三档一键流的过滤与拒绝（§6.6）。**一份判定，人机共用**，不存在"按钮能点但实际会失败"的缝。
4. **触发面只有三层**（Q7）：单步（阶梯 ▶）→ 三连（`build,flash,debug_verify`）→ 闭环（全流程过滤）。没有第四种"自定义步骤链"，因此 UI 上任何"选一部分"的念头都落回单步。

---

## 4. Host 半设计（详细）

### 4.1 Python 进程托管（`elab-host-process.ts`）

```ts
// 骨架（示意，非最终代码）
interface HostHandle { baseUrl: string; pid: number; port: number }

function spawnCockpit(opts: { python: string; root: string; dist?: string }): Promise<HostHandle> {
  // --port 0 由 OS 分配后由 python 打印；正则解析 stdout 首行
  // 失败模式：python 缺失 / 端口被占 / dist 缺失（--reload 模式仍可用 API）
}
```

- **端口**：固定 `--port 0` 让 OS 分配 —— 避开 8333（默认）与 3333（OpenOCD）冲突，也避开"多个 DSH 实例并存"。
- **root**：取自 `ctx.sessions.get(sessionId)` 的 cwd 或 `workingDirectory` 服务；缺省用 `Config.elabRoot`。**会话级**而非全局，符合 DSH 的会话模型（同一 DSH 里两个工程目录的会话，各自一个 cockpit 实例，见 §4.5 的实例池）。
- **生命周期**：`ctx.effect(() => () => kill(-pid))`（POSIX 进程组；Windows 用 `taskkill /T /F`，见 R3）。DSH 崩溃留下的孤儿进程由**下次启动时的端口探测 + `--owner-token`** 识别并回收。
- **健康**：`GET /elab/host` 返回 `{alive, port, pid, schemaVersion, python, distReady, restarts}`；前端首屏拿它画"内核未就绪"态，而不是白屏。
- **重启退避**：崩溃 3 次内指数退避（0.5s/1s/2s），之后标 `degraded` 并在面板上给「重试」按钮（手动按键原则的延伸）。

### 4.2 API 反代（`/elab/api/*`）

| 关注点 | 设计 |
|---|---|
| 路由形制 | `ctx.webServer.register({ kind: 'prefix', path: '/elab/api', handler })`，`ctx.effect()` 管理 |
| 鉴权 | **每条请求先 `ctx.connection.requestRejection(req)`**，非空即 403（照抄 better-sidebar 的 fence） |
| 方法白名单 | `GET`：capabilities/projects/runs/plan/run-events/serial/console/serial/monitor；`POST`：run/cancel/serial/serialMonitor/adapt。**其余一律 404**，不做通配转发（避免"上游新增危险端点被自动暴露"） |
| 归一化 | 只做三件事：①补齐 `actor`（见 §6）②错误信封统一为 `{ok:false,error:{code,message}}`（服务端已是 `{error: string}`，包一层，前端 `client.ts` 的 `msg` 读取兼容）③注入 `project` 缺省值（会话 cwd 推断出的工程名） |
| 超时 | 透传 `AbortSignal`；上游 30s 无响应 → 504（`/api/run` 是 202 立即返回，不存在长连接） |
| 日志 | 转发层只记 `method + 状态码 + 耗时`，**不记 body**（避免把串口数据写进 DSH 日志） |

### 4.3 事件通道：SSE 透传 vs WS 重封装（决策 D2）

| 维度 | A. SSE 字节级透传（**选定**） | B. WS 重封装（better-sidebar 的做法） |
|---|---|---|
| 改动面 | Host 半 ~80 行（`pipe` + 头透传），前端 `sse.ts` 仅改 URL | Host 半 ~250 行（升级、心跳、背压、二进制帧、重连状态机）+ 前端换 `EventSource`→`WebSocket` |
| 断线续传 | 天然：浏览器/自实现客户端带 `Last-Event-ID`，服务端 `max(from, leid)` 已实现 | 必须自己在握手 query 里带 `from`，并复刻服务端的 `max()` 语义 |
| 服务端已做的两件难事 | `proc/stdout-batch` 100ms 合帧 + `stream/overrun` 背压丢弃计数 + `stream/closed` 显式收尾 —— **全部免费继承** | 需要重写同语义（已知它们是踩过坑才有的，见 `docs/技术方案_闭环驾驶舱.md` §17.3） |
| 风险 | 面板不可见（tab 未选中）时 `EventSource` 仍连，浪费连接（`MAX_SSE_CONNS` 上限）→ 用"不可见即断开、可见即 `from=lastSeq` 重连"解决 | 无此问题（可主动 close） |
| 结论 | **首选**，并把"可见性驱动的连接开关"写进 P2 验收 | 仅当未来要跨进程/跨设备推送时再考虑 |

**SSE 透传的三个必须处理的细节**（否则日志会"不动"）：

1. **关闭压缩/缓冲**：`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no` 透传；Host 半不得对响应体做 `res.write` 之外的处理。
2. **空闲超时**：Node 默认 `server.keepAliveTimeout` 可能掐断长连接 → 在 `res` 上 `setTimeout(()=>{}, 0).unref()` 或 `res.socket.setTimeout(0)`；同时保留服务端 `: ping` 心跳（`SSE_HEARTBEAT_S`）作为活体信号。
3. **`stream/closed` 是终止信号**：前端收到即 `EventSource.close()`，**不在 `onerror` 里关**（`sse.ts` 顶部注释已写明这是实测事故的产物）。

### 4.4 配置（`Config`，schemastery）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 行级开关（`cordis.patch.yml` 的 `disabled` 也可） |
| `pythonPath` | `auto` | `auto` → 依次尝试 `python3`/`python`/`py -3`，并校验 `--version ≥ 3.10` |
| `elabRoot` | `auto` | `auto` → 当前会话 cwd 向上找含 `elab.host.yaml` 的目录；找不到则面板显示「未接入 elab 仓库」 |
| `hostIdleKillSec` | `600` | 无活动 run 且面板不可见超过此秒数 → 杀掉 Python 进程（下次可见时重启，约 300ms） |
| `maxInstances` | `2` | 多会话不同 cwd → 实例池上限（超出 LRU 淘汰） |
| `autoExposeTools` | `true` | 是否注册 `elab_*` 工具给 Agent |
| `allowAgentWrite` | `false` | 允许 agent 写硬件/写盘（串口、适配落盘；§6.2 规则 6） |
| `allowAgentWrite` | `false` | Agent 可发起的**写操作白名单**：`false` = 只允许 run 闭环/取消；`true` = 另允许串口手写、适配写入（高风险，默认关） |

### 4.5 实例池（多会话）

```
sessionId ──► cwd ──(向上找 elab.host.yaml)──► rootKey
                                              │
                         Map<rootKey, HostHandle>  (LRU, maxInstances)
```

- 同一 `rootKey` 的多个会话**共享**一个 cockpit 进程（与 CLI 行为一致：`runs/` 是仓库级目录）。
- 前端从不直连 Python 端口，只连 `/elab/api`；Host 半按 `sessionId` 查 rootKey 决定转发目标。

### 4.6 补充源码研究结论（v2 新增，均为实读证据）

| # | 结论 | 证据 | 对方案的影响 |
|---|---|---|---|
| S1 | **`services/elab` 确为纯标准库** | `grep '^import\|^from'` 全量清单仅：`__future__, argparse, collections, dataclasses, datetime, hashlib, json, os, pathlib, re, secrets, shlex, shutil, subprocess, sys, threading, time` | Host 半**不做环境接管**（不建 venv、不碰 PATH），只把 `--root` 转交；`pythonPath` 只做版本校验（≥3.10） |
| S2 | **驾驶舱服务端无任何 CSP / X-Frame-Options / frame-ancestors** | `grep -rn "Content-Security-Policy\|X-Frame-Options\|frame-ancestors" cockpit/` 无命中 | **iframe 探针（P0）可行**；但反向也意味着 DSH 页面的 iframe 策略需实测（P0 第一件事） |
| S3 | `POST /api/run` 缺省 `steps` = `("doctor","build")` | `services/elab/run.py:45` | 三档一键流**必须显式传 steps**（§6.6.1）；这是"跑全闭环只跑了编译"旧事故的根因 |
| S4 | `/api/events` 是 **SSE + chunked + `id:` 帧 + 心跳 + `stream/closed` 收尾** | `cockpit/server.py:1046-1200` | 透传必须保留 `id:` 帧（`Last-Event-ID` 续传依赖它），不得改写为自定义帧 |
| S5 | 服务端**硬绑 `127.0.0.1`**，`--port` 可覆盖，`--reload` 可只跑 API | `cockpit/server.py:48, 1292-1330` | P0/P5 用 `--port 0`（OS 分配，打印后解析）+ `--reload`（不托管 dist）两种模式都要支持 |
| S6 | 卡片已含 `tools: [{name,label}]`、`ota`、`steps:{[id]:{ok,reason}}`、`boot_owner`、`derived.built` | `cockpit/server.py:560-580` | 窄栏**零推导**：阶梯、三连可用性、工具按钮全部读卡片 |
| S7 | 现有前端 `primitives/*` 共 11 个 + 4.1 万行 CSS 产物，完全自研 | `cockpit/web/dist/assets/index.css` 43 KB | P4 换 DSH token 时必须**逐条对照**（R7），不能只换根变量 |
| S8 | better-sidebar 的 `package.json` 声明了 `dsh.client.inject` 的 6 个宿主包 | `~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/package.json` | 我们只需 3 个（locale / ui-slots / ui-primitives），少了 sidebar-right 这一层耦合 |

---

## 5. Client 半设计（详细）

### 5.1 文件规划

```
packages/dsh-elab-cockpit/
├─ package.json                  # dsh.bundle.patch + dsh.client.inject
├─ cordis.patch.yml              # insert: elab-cockpit（含 !!js 防重复挂载）
├─ icon.svg / locale/{zh-CN,en}.json
├─ src/
│  ├─ index.ts                   # Host 半：路由 + 进程托管 + 工具
│  ├─ config.ts                  # schemastery Config
│  ├─ elab-host-process.ts       # spawn/健康/回收
│  ├─ run-arbiter.ts             # run 归属与串口互斥（§6）
│  ├─ tools.ts                   # elab_build / elab_triple / elab_loop / elab_status / elab_log
│  ├─ plans.ts                   # 三档一键流解析（§6.6），人机共用
│  ├─ wire.ts                    # 统一错误信封 / 上游转发
│  └─ client/
│     ├─ index.tsx               # 槽位注册 + 面板根
│     ├─ api/client.ts           # ← 移植自 cockpit/web/src/api/client.ts（改 baseURL）
│     ├─ api/types.ts            # ← 原样移植（486 行）
│     ├─ events/sse.ts           # ← 移植（URL 改 /elab/events，可见性驱动开关）
│     ├─ store/runStore.ts       # ← 原样移植
│     ├─ store/logs.ts           # ← 原样移植
│     ├─ model/channels.ts       # ← 从 workspaces.ts 抽取 channelOfEvent + stepLabel
│     ├─ model/ladder.ts         # ← 从 StageRail 抽 fullLoopSteps / 置灰判定
│     ├─ model/plans.ts          # ← 三档一键流（§6.6）的前端同构判定 + useRunPlans()
│     ├─ theme/ansi.ts           # ← 原样移植（配色改读 --elab-ansi-*，见 §5.5.3）
│     ├─ theme/dsw-map.css       # ★ 新增：--elab-* → --dsw-alias-* 唯一映射文件（§5.5.2）
│     ├─ CockpitPane.tsx         # 窄栏根（gutter 自适应：320 窄 / ≥520 宽双栏）
│     ├─ ProjectStrip.tsx        # 工程条 + 适配流程图
│     ├─ StageLadder.tsx         # 阶梯（状态点 + 单步 ▶ + 聚焦日志）
│     ├─ ManualBar.tsx           # 全闭环 / 三连 / 编译 / 取消 / 预览 / ⚙选项
│     ├─ EvidenceTail.tsx        # 日志尾
│     └─ *.module.css            # 全部类名加 elab- 前缀
└─ vite.config.ts                # 双入口 lib 构建（index.js / client.js）
```

> **程序集边界铁律**：`client/` 只 import 无 Node 依赖、能打进前端的模块。已核对：`store/logs.ts` 只依赖 `theme/ansi.ts` 与 `workspaces.ts#channelOfEvent`；`api/types.ts` 零运行时依赖；`runStore.ts` 只依赖 `types.ts` —— 三者可原样进前端 bundle。
> **两处判定必须同构**：Host 半 `plans.ts`（`plan` → `steps`）与前端 `model/plans.ts`（按钮可用性）共用同一份步骤集常量；P3 用一条 vitest 对照用例（同一 `card/caps` 夹具，两处输出逐项相等）钉死，防止"按钮能点但后端拒绝"。

### 5.2 组件契约（Props 与副作用边界）

```ts
// CockpitPane：唯一的容器。数据全部从 store 订阅，不向下传"可变引用"。
interface CockpitPaneProps extends StandardSlotProps {  // sessionId 等由宿主注入
  visible: boolean      // 由 DSH 决定（tab 是否选中 & 面板是否展开）
}

// StageLadder：纯展示 + 单步回调；steps 来自 useRun()
interface StageLadderProps {
  steps: StepView[]
  card: ProjectCard | null           // 置灰判定唯一来源
  focusStep: string | null
  onFocus(step: string): void        // 点行 → 焦点切日志尾
  onRunOne(step: StepId): void       // 点行首状态点右侧「▶」→ 单步
  disabled: boolean                  // 仅"另一个 run 正在跑"时为 true
  disabledReason: string
}

// EvidenceTail：命令式 DOM 追加（LogView 内核），React 只管骨架
interface EvidenceTailProps {
  channel: string                    // build | flash | serial | tools
  onChannel(id: string): void
  follow: boolean                    // "跟随焦点步骤"开关
  serial?: { writable: boolean; port: string; baud: number; onSend(line: string): void }
}
```

**性能红线**（沿用驾驶舱既有结论）：`proc/*` 上万行**绝不进 React 状态**；`LogView` 用环形缓冲 + `appendChild`，一次事件最多 `requestAnimationFrame` 合并一次滚动。窄栏里再缩短每条日志的 DOM 深度（单层 `div`，省掉时间戳独立节点）。

### 5.4 宽度自适应（关键交互设计）

| 面板宽度 | 布局 |
|---|---|
| < 420 px（默认） | 单列：工程条(折叠) → 阶梯 → 控制条 → 日志尾 |
| 420–700 px | 单列，阶梯行显示 `detail` 全宽 + 产物 chips |
| > 700 px（`openRightbar(track=false, fullscreen=true)` 浮动/全屏） | 双栏：左阶梯（40%）+ 右日志尾（60%）；`MemoryGauge` 完整版 |

用 `ResizeObserver` 切档（不需要用户配置），三档只有**同一套组件的不同 density 参数**，不是三套组件。

> **P0 初步读数（2026-10-26，用户真机截图）**：右栏常规宽度 ~430px → 窄档单列正常；
> 拖宽 / 底部工作台 ~1150px → wide 双栏自动生效、左 40% 阶梯 + 右 60% 日志尾比例合理。
> 420/700 阈值暂定可用；若后续在 400–450 区间出现拥挤再微调。

> 阈值待 P0 实测校准（§8.0.2 的 T1/T2 会把真实右栏宽度区间写回本节）。

### 5.5 主题与视觉令牌契约（**已决策：路径一，原生跟随**）

> **结论**：正式窄栏**完全跟随 DSH 主题**——不订阅、不搬运、不做主题切换 UI。DSH 的 18 个令牌全是 CSS 自定义属性且 `requiresLightAndDark: true`，换主题（含第三方主题、系统深浅色翻转）时**变量值就地变化**，组件自带跟随。
> **不做**（决策 D7）：不调 `ctx.theme.setTheme()`（那是宿主用户偏好，插件无权改）、不做自研三态主题、不留 `localStorage["elab.theme"]`。

#### 5.5.1 令牌来源（`cordis_inspect_query(client, Theme, listTokens)` 实读，2026-10-25）

| 令牌 | 语义 | 驾驶舱映射到 |
|---|---|---|
| `--dsw-alias-bg-base` | 应用底色 | `--elab-bg-canvas` / 面板根背景 |
| `--dsw-alias-bg-layer-1` | 一级抬升面 | `--elab-bg-surface`（阶梯行、控制条底） |
| `--dsw-alias-bg-layer-2` | 二级嵌套面 | `--elab-bg-raised`（展开的选项区、日志尾底） |
| `--dsw-alias-bg-overlay` | 浮层/popover | Tooltip、⚙ 菜单、适配面板 |
| `--dsw-alias-border-l1` | 弱分隔线 | `--elab-border`（阶梯行分隔、卡片描边） |
| `--dsw-alias-border-l2` | 强分隔线 | `--elab-border-strong`（输入框、选中态描边） |
| `--dsw-alias-label-primary` | 主文字 | `--elab-fg-primary`（步骤名、数值） |
| `--dsw-alias-label-secondary` | 次文字 | `--elab-fg-secondary`（detail、耗时） |
| `--dsw-alias-label-tertiary` / `-caption` | 弱文字 | `--elab-fg-muted` / `--elab-fg-faint`（环境行、单位） |
| `--dsw-alias-label-primary-dimmed` | 置灰文字 | 不可用步骤的文案（`pending`/`skipped`） |
| `--dsw-alias-state-success-primary` | 成功 | `--elab-status-ok`（阶梯 ● ok、`run/end.ok`） |
| `--dsw-alias-state-error-primary` | 失败 | `--elab-status-fail`（● failed、危险按钮） |
| `--dsw-alias-state-warn-primary` | 警告 | `--elab-status-run`（取消/背压 overrun 提示） |
| `--dsw-alias-state-idle-primary` | 空闲 | `--elab-status-idle`（○ pending、探针未在位） |
| `--dsw-alias-brand-primary` | 主色 | `--elab-accent`（运行中呼吸点、primary 按钮、焦点环） |
| `--dsw-specific-sidebar-fill` | 侧栏底色 | 面板根背景的兜底（与右栏融为一体） |

**字号与字体**：不写 `px` 字面量，改用 `ctx.theme` 的三个 font role 对应的宿主变量（P4 首日以实际变量名落地）。原 `--elab-font-scale` 全局缩放率**删除**——它属于"DSH 之外的自研全局控件"，缩放交给 DSH 的字号设置。

#### 5.5.2 映射文件（唯一新增的 CSS，约 40 行）

```css
/* client/theme/dsw-map.css —— 全仓唯一允许出现 --dsw-* 字面量的文件 */
.elab-root {
  /* 面 */
  --elab-bg-canvas: var(--dsw-alias-bg-base);
  --elab-bg-surface: var(--dsw-alias-bg-layer-1);
  --elab-bg-raised: var(--dsw-alias-bg-layer-2);
  --elab-bg-overlay: var(--dsw-alias-bg-overlay);
  /* 线 */
  --elab-border: var(--dsw-alias-border-l1);
  --elab-border-strong: var(--dsw-alias-border-l2);
  /* 字 */
  --elab-fg-primary: var(--dsw-alias-label-primary);
  --elab-fg-secondary: var(--dsw-alias-label-secondary);
  --elab-fg-muted: var(--dsw-alias-label-tertiary);
  --elab-fg-faint: var(--dsw-alias-label-caption);
  /* 态 */
  --elab-status-ok: var(--dsw-alias-state-success-primary);
  --elab-status-fail: var(--dsw-alias-state-error-primary);
  --elab-status-run: var(--dsw-alias-state-warn-primary);
  --elab-status-idle: var(--dsw-alias-state-idle-primary);
  --elab-accent: var(--dsw-alias-brand-primary);
  /* 几何（与主题无关，保留本地常量） */
  --elab-space-1: 4px;  --elab-space-2: 8px;  --elab-space-3: 12px;
  --elab-radius: 8px;   --elab-ease: cubic-bezier(.4,0,.2,1);
}
```

**为什么不映射到 `:root`**：插件样式必须作用域在面板根（`.elab-root`）内，避免污染 DSH 全局；同理所有类名带 `elab-` 前缀。

#### 5.5.3 原 `tokens.css`（167 行 / 357 个变量）的去向

| 原层 | 变量 | 处置 |
|---|---|---|
| 第一层 原色 `--elab-c-*`（27 个） | blue/green/amber/red/violet/gray 各档 | **删除**。DSH 语义色已覆盖用途；需要中间色用 `color-mix(in srgb, var(--elab-accent) 12%, transparent)` |
| 间距/圆角/缓动（12 个） | `--elab-space-*` / `--elab-radius*` / `--elab-ease` | **保留为本地常量**（与主题无关） |
| 语义 alias `--elab-bg-*` `--elab-fg-*` `--elab-border*` `--elab-status-*` `--elab-accent*` | 约 30 个 | **改名映射到 DSW**（见 5.5.1），组件的 `var(--elab-*)` 调用**一行不改** |
| 阴影/张力 `--elab-shadow*` / `--elab-glass` / `--elab-shimmer` / `--elab-*-grad` | 玻璃拟态、渐变 | **删除**。DSH 的基础面板不用玻璃/渐变（`bg-overlay` 已有正确的不透明度）；保留会与宿主风格打架 |
| **ANSI 16 色**（`--elab-ansi-*`，两套） | 日志着色 | **保留，且必须保留两套 `light`/`dark`**。这是唯一不来自 DSW 的一族：DSH 没有"终端色板"令牌。实现上不用 `data-theme`，改用 `@media (prefers-color-scheme: dark)` **不够**（DSH 主题可独立于系统），故改为写在 `.elab-root[data-elab-scheme="dark"]` 上，由 Client 半从 `ctx.theme.getTheme().active.colorScheme` 写入该属性（**这是全方案唯一的主题订阅点，约 6 行**） |

> ANSI 这一条是原 `tokens.css` 硬规则 2 的原话："ANSI 16 色**必须**按主题各映射一套，否则暗色下编译器输出看不清"——它救过一次现场，不能丢。

#### 5.5.4 硬规则（写进 lint 与评审清单）

1. **禁止字面色值**（`#rgb` / `rgb()` / `hsl()`），唯一例外 `transparent` 与 `currentColor`。
   - 落地手段：P4 加一条 `stylelint` 规则（`color-no-hex` + `declaration-property-value-allowed-list`），CI 门禁。
   - 现状核对：`rails/`、`render/`、`App.tsx` **已无字面色值**（实测 grep 无命中），规则天然守得住。
2. **`--dsw-*` 只允许出现在 `dsw-map.css`**（其余文件出现即视为绕过设计系统）。
3. **组件不得读 `ctx.theme` 做配色**（除 ANSI 那一处）。
4. **不得 `localStorage` 存主题**；不得调 `ctx.theme.setTheme()`。
5. 第三方主题下必须可读：P4 验收用"注册一个极简第三方主题（仅覆盖 `bg-layer-1` + `label-primary`）→ 面板不应出现低对比块"作为可断言用例。

#### 5.5.5 iframe 探针（P0）的边界说明

P0 的 `dsh-elab-iframe` **不走**本节的令牌映射（跨文档拿不到 CSS 变量）。它只保留原驾驶舱自带的三态主题（`?embed=1` 时默认 `dark`），目的是先量宽度与手感；主题跟随在**路径一（正式窄栏）**里天然满足。若 P0 结论要求探针长期可见，再按"令牌搬运"补 30 行（不在本期范围）。

### 5.6 复用清单（逐文件判定，可施工）

| 原文件 | 去向 | 改法 |
|---|---|---|
| `api/types.ts` | `client/api/types.ts` | 原样（`EVENT_SCHEMA_VERSION` 不动） |
| `api/client.ts` | `client/api/client.ts` | `fetch(path)` → `fetch('/elab/api' + path)`；错误信封兼容 |
| `events/sse.ts` | `client/events/sse.ts` | URL `/api/events` → `/elab/events`；增 `attach(visible)` 开关；其余（批量、`stream/closed` 关闭、`ingestHistogram`）原样 |
| `store/runStore.ts` | `client/store/runStore.ts` | 原样 |
| `store/logs.ts` | `client/store/logs.ts` | 原样 |
| `theme/ansi.ts` | `client/theme/ansi.ts` | 原样 |
| `workspaces.ts` | `client/model/channels.ts` | 只取 `channelOfEvent`；`WorkspaceDef` 的 UI 元数据并入 `model/ladder.ts`（窄栏不做"工作区 Tab"，日志通道直接由步骤投影） |
| `StageRail.tsx` | `client/model/ladder.ts` + `StageLadder.tsx` | 抽 `fullLoopSteps`/`stepLabel`/`fmtDur`/置灰判定为纯函数；渲染重写 |
| `ProjectsRail.tsx` | `ProjectStrip.tsx` | 卡片 → 折叠行 + 展开列表；保留 boot 子工程缩进与「＋适配」两步流程 |
| `EvidenceRail.tsx` | `EvidenceTail.tsx` + `ManualBar.tsx` | 串口监视/手写保留（写通道逻辑几乎原样）；工作区 Tab → 通道切换；单步按钮上移到阶梯 |
| `render/LogView.tsx` | `EvidenceTail.tsx` 内核 | 保留环形缓冲追加；删时间戳列的独立节点 |
| `render/MemoryGauge.tsx` | 内联进阶梯 `build` 行 | 数字 + 细条两形态 |
| `primitives/*` | **删除** | 换 `@deepseek-ai/dsh-client-ui-primitives`（Button/Tooltip/Switch/SegmentedTabs/Menu） |
| `theme/tokens.css`（167 行 / 357 变量） | `client/theme/dsw-map.css`（约 40 行） | 原色层/玻璃/渐变删；语义层映射到 `--dsw-*`；**ANSI 16 色两套保留**（§5.5.3） |
| `store/themeStore.ts`（92 行） | **删除** | 主题交给 DSH；仅保留 §5.5.3 的 6 行 `colorScheme` 订阅供 ANSI 选色 |
| `App.tsx`/`AppFrame.tsx`/`layoutStore.ts` | **删除** | 宽度/折叠/Tab 交给 DSH；`--elab-font-scale` 交给 DSH 字号设置 |

---

## 6. 「AI 跑闭环 + 人工按键」并存机制（本次新增，重点）

这是需求里最容易被做错的一环。现有驾驶舱的假设是"**同一时刻只有一个 run，且由人点**"，窄栏场景下这个假设不成立：Agent 会在聊天里发起闭环，用户会同时在面板上按单步。

### 6.1 归属：`actor` 是已有的一等公民

ICD §2 已规定每条事件必带 `actor: "agent" | "human"`。窄栏因此可以**直接可视化"谁在跑"**：

- 工程条右侧徽标：`agent` 蓝 / `我点的` 紫（沿用 `runStore.actor`）；
- 阶梯当前步行：`◐ running` + 发起者小标；
- 日志尾首行 marker：`── run r-7f3a1c02 由 agent 发起 ──`。

### 6.2 写操作的两条入口与仲裁（`run-arbiter.ts`）

| 发起者 | 入口 | `actor` |
|---|---|---|
| 用户在面板点「▶全闭环 / 单步」 | Client → `/elab/api/run` | `human` |
| Agent 调 `elab_loop` / `elab_build` 工具 | Host 工具 → 内部 `/api/run` | `agent` |
| 用户在聊天里说"帮我编译"（Agent 转调工具） | 同上 | `agent`（**正确**：确实不是人直接点的） |

**仲裁规则（Host 半唯一执行点，前端只展示结果）**

1. **同一 rootKey 同时最多 1 个 run**（Python `RunManager.spawn` **不检查已有活动 run**，`cockpit/server.py:229-290` 实读：它只分配 run id 并起子进程，多个 run 会并行跑 —— 因此**必须由插件 Host 半串行化**）。`inFlight` 互斥，第二个请求返回 `409 busy` 且带 `holder: {run, actor, steps}`。
2. **串口互斥**：`serialmon` 会话与 `flash/debug_verify/monitor` 步骤互斥（服务端已有 409，Host 半提前拦截以给出更好文案）。
3. **AI 不得抢占人工**：若 `allowAgentWrite=false`，Agent 的写工具在 `human` run 进行中直接返回结构化拒绝（`{code:'human-busy', nextAction:'等待或取消'}`），而不是排进队列 —— 静默排队会让用户觉得"我点了取消它怎么又跑了"。
4. **人工可抢占 AI**：用户在面板点「■ 取消」永远可用（即使 run 由 agent 发起），取消事件 `run/cancel.by='human'` 已能表达。
5. **跨进程不做互斥（已决策 Q12）**：同一台机器上"同一时间只用一个入口"是**用户约定**，写进面板底部的环境行提示；插件**不实现**跨进程文件锁（`cockpit.cmd` 与插件并存时，两个进程抢串口/探针由 openocd/串口驱动自身报错，已有清晰错误信息）。理由：跨进程锁要处理崩溃残留锁、权限、多用户，收益远小于复杂度。
6. **Agent 闭环不预先审批（已决策 Q11）**：Agent 调 `elab_loop` / `elab_triple` **直接跑**，不弹审批。可观测性由面板保证：run 一起，工程条出现 `agent` 蓝标、阶梯开始点亮、日志尾实时滚动，用户看到即可取消。`allowAgentWrite` 仍控制串口/适配写盘（不可撤销、无声）。

### 6.3 窄栏的"并存"表现（不是二选一）

| AI 在跑时 | 人工按键的表现 |
|---|---|
| 阶梯行首 **▶**（单步） | **可点** —— 点了即进入"明确选择"：行内展开三选一（非模态框）：「另起一轮 / 等当前结束 / 取消当前再跑」，默认焦点**等当前结束**（决策 Q4）。 |
| 「P-basic / P-triple / P-loop」 | 置灰 + tooltip：`agent 正在跑 r-7f3a1c02（build），点「取消」可抢占` |
| 「■ 取消」 | **永远可用**（人的最高优先权） |
| 串口手写 | 若当前 run 含 `monitor`/`flash` → 置灰并说明「闭环占用串口（N5）」；否则可用 |
| 「👁 预览」 | **永远可用**（只读，不 spawn）—— 这正是"AI 在跑时人还能做点事"的典型 |
| 工程切换 | 置灰（避免"看 A 的日志、跑的是 B"），但**日志尾可切通道**看历史 |
| 日志尾 | 跟随 `currentStep`；用户手动切通道后停止跟随（显示「↺ 恢复跟随」小按钮） |
| 阶梯行**本体**（非 ▶） | 永远可点 = 聚焦该步日志（只读操作，不受 run 状态影响） |

### 6.4 「AI 发起 → 窄栏自动跟上」（需要一小条派生事件）

问题：Agent 在聊天里调 `elab_loop`，**面板没有任何事件通知**它"有个 run 刚起来"，除非面板一直挂着 SSE（但面板可能不可见，我们主动断开了）。

方案（决策 D3）：Host 半在**代理层**记录最近一次 `POST /elab/api/run` 的返回 `{run, project, actor}`，并在 `/elab/host` 快照里带 `lastRun`；同时前端在面板变可见时**先 `GET /elab/host`**（1 次请求，几 ms），若 `lastRun` 比本地 `lastSeq` 所属 run 新 → 自动 `openRightbar(track=true)`（若未开）+ `from=0` 追平。

- **不改 Python、不改 ICD**（纯 Host 半内存 + 前端一次性查询）。
- 若未来要"run 一启动就点亮面板"，再加一条 Host 半内存派生的 `stream/run-changed`（只在 `/elab/events` 透传层注入，前端 `reduce` 里按未知 topic 忽略 → 前向兼容，符合 ICD §7）。

### 6.5 工具契约（Agent 可见面）

| 工具 | 参数 | 返回 | 需要审批 |
|---|---|---|---|
| `elab_status` | `{project?}` | 工程列表 + 各步可用性 + 当前 run 快照 | 否（只读） |
| `elab_build` | `{project, clean?, jobs?}` | `{run, actor:'agent'}` | 否 |
| `elab_triple` | `{project}` | 同 `elab_build`，步骤固定 `build,flash,debug_verify` | 否 |
| `elab_loop` | `{project}` | 同上；步骤 = `fullLoopSteps(card, caps)` 的等价过滤 | 否 |
| `elab_cancel` | `{run?}` | `{ok}` | 否 |
| `elab_serial` | `{project, data, baud?}` | 同 `/api/serial` 返回 | **是**（写硬件） |
| `elab_adapt` | `{path, write: false}` | 只读探测报告 | `write=true` 时**是** |
| `elab_log` | `{run, step?, tail?=200}` | 该 run（可选步骤）尾部 N 行纯文本 | 否（只读） |

> 工具一律回**结构化**结果（含 `run` id），禁止把上万行日志塞进工具输出 —— 日志在面板里看，Agent 需要时用 `elab_log`。
> **三个工具 = 三档一键流的同一份实现**：`elab_triple` / `elab_loop` 只做"步骤集解析"，写操作全部落到 `POST /api/run`，因此**人按的按钮与 Agent 调的工具有完全相同的语义**（同一 `PlanSet` 解析函数，见 §6.6），这是"终端里看到的与面板里看到的不会漂移"的延伸。

### 6.6 三档一键流（触发面收敛，**已决策**）

> **需求原话**：不要"只跑部分步骤"多选；只要 **可以单步**、**可以一键三连**（编译→烧录→调试）、**可以一键闭环**。

#### 6.6.1 三个按钮的精确语义

| 按钮 | 步骤集（声明序） | 需探针 | 需串口 | 失败即停 |
|---|---|---|---|---|
| **P-basic**（编译） | `build`（组合工程会自动级联编 boot，见 §6.7） | 否 | 否 | — |
| **P-triple**（三连） | `build` → `flash` → `debug_verify` | 是（三连全程 ONHW） | 否（debug_verify 用 SWD） | 是，任一步失败则整轮失败 |
| **P-loop**（闭环） | `doctor` → `build` → `flash` → `debug_verify` → `monitor`，按 `fullLoopSteps(card, caps)` 过滤 | 否（doctor/build 可无探针） | monitor 需要 | 是 |
| **单步 ▶** | 该行一个步骤（`tool:<name>` 亦为单步） | 该步 `onhw` 时需要 | monitor 时需要 | 不适用 |

- P-loop 的步骤集**必须显式传给 `POST /api/run`**：服务端缺省 `DEFAULT_STEPS = ("doctor","build")`（`services/elab/run.py:45` 实读），那是"默认两步"而非闭环 —— 原驾驶舱「跑全闭环」曾因不传 steps 而跑完编译就停，此坑已在 `StageRail.tsx:30-40` 注释里记录，本次迁移**把这个注释连同 `fullLoopSteps` 一起搬走**。
- `doctor_deep` **不进入任何一键流**（它是 doctor 的重型变体，会真跑一次 configure），仅作为单步按钮存在。
- **"boot + app"不需要新的步骤类型**：boot 的构建与烧录由框架在 `build` / `flash` 内部级联完成（§6.7），因此三档一键流的步骤集**不因工程类型而变**——这是本方案能"零 Python 改动"的关键前提。

#### 6.6.2 可用性判定（唯一来源，人机共用）

```
avail(step)      = card.steps[step].ok            // 服务端算好
reason(step)     = card.steps[step].reason
onhw(step)       = caps.steps.onhw includes step  // flash/debug_verify/monitor
serialFree()     = !caps.serial.monitor.active && !activeRunUsesSerial
```

三档的可用性判定（**按钮若不可用，必须在按钮下方一行说明"缺什么"**，而不是只置灰）：

| 档位 | 条件 | 不可用时的文案 |
|---|---|---|
| P-basic | `avail('build')` | `编译不可用：${reason('build')}` |
| P-triple | `avail('build') && avail('flash') && avail('debug_verify')` | `三连需要探针在位：${第一个不可用步骤的 reason}` |
| P-loop | `avail('build')`（其余步自动降级） | 见下 |

#### 6.6.3 降级规则（**P-loop 与 P-triple 一致：都剔除，不拒绝** — 2026-10-25 定）

- **两者一致**：不可用步骤**静默剔除**（不再是"三连拒绝"），但在按钮 tooltip / 日志首行**显式写明** `本次跳过：flash（未检测到探针）`。
- 依据：两个按钮若一个"尽力"一个"拒绝"，用户会误以为点了同一件事却得到不同结果；而"必须到板"的承诺已经由**按钮可用性判定**保证——缺探针时 `avail('flash')=false`，按钮直接置灰并说明，用户不会误以为跑到了板。
- **与 §6.6.2 的关系**：可用性判定（置灰）仍然严格；"剔除"只发生在**部分步骤不可用但主体可跑**的情形（如 monitor 判据缺失），避免"一个可选步骤拖垮整轮"。

#### 6.6.4 UI 落位（窄栏）

```
│ ▶ 全闭环   ▶▶ 三连   ▶ 编译   ■ 取消  👁 │   ← 控制条：按"耗时/风险"由左到右
│ 探针 ● 在位   串口 ● 空闲    run ○ 空闲   │   ← 环境行（12px 高，置灰时这行解释原因）
```

- 四个动作按钮宽度按窄栏刻度分配：`全闭环` 与 `三连` 为主按钮（primary），`编译` 为次级，`取消` 为危险色（仅 running 时着色）。
- **不做**：多选勾选、步骤拖拽排序、自定义步骤链（`--clean`/`-j` 收进 ⚙ 折叠选项，沿原驾驶舱做法）。

#### 6.6.5 接入点

| 位置 | 用法 |
|---|---|
| `POST /elab/api/run` | body `{project, plan: 'basic'\|'triple'\|'loop'\|null, steps?, clean?, jobs?}`；`plan` 由 Host 半解析成 `steps` 再转发（**Python 收到的仍是 `steps`**，无需改服务端） |
| Agent 工具 | `elab_build` → `plan:'basic'`；`elab_triple` → `plan:'triple'`；`elab_loop` → `plan:'loop'` |
| 前端 | 三个按钮共用 `useRunPlans()` hook，返回 `{plans: [{id, label, steps, enabled, reason}]}` |

### 6.7 组合工程（boot + app）：**框架已内建，插件只做可视化**

> **调研结论（源码实读 2026-10-25）**：这不是要新增的能力，`elab` 已经实现"build app 自动级联编 boot + flash 一次会话原子烧 boot+app"的完整链路。**插件只需把它显示出来**，无需改 Python。

> **需求澄清（用户原话）**："我原本那个仓库是想实现一个通用的一级 boot 引导跨芯片跨平台，然后二级引导不同芯片不一样，然后通过 boot 来烧当前工程的固件，所以每次应该是 boot+app。"
> → **完全可实现**，且正是现有 `ota_layout.boot_project` + `flash.images` 的设计意图（见 6.7.1/6.7.2）。不存在"回归传统编当前工程→烧当前工程"的退路需求。

#### 6.7.1 已存在的三个机制

| 机制 | 实现位置 | 行为 |
|---|---|---|
| **C1 级联构建** | `services/elab/builder.py:30-60` `build_with_boot()` | app 构建**成功后自动构建 boot 工程**；`seen` 集合防同批重复；boot 自身不再级联（`resolve_boot_project` 对自引用返回 `""`，`plan.py:147-170`） |
| **C2 冻结台账** | `services/elab/flash.py:100-140` `boot_flash_decision()` | 按 `md5(boot.bin)` 与 `.work/<boot>/flash_stamp.json` 比对：一致→`skip`（boot 零触碰），不一致/无台账/`--reflash-boot`→`flash` |
| **C3 原子烧录** | `services/elab/flash.py:226-260` `_flash_images()` | **一次 openocd 会话**按声明序 program 全部镜像，收尾统一 `reset run` + `shutdown`；bin 镜像**必须显式地址**（否则 openocd 向下对齐会吞掉 boot 尾部 2KB——历史实锤） |

#### 6.7.2 声明方式（唯一事实源，不在插件里）

```yaml
# chips/*.yaml —— 分区表 + boot 工程名
ota_layout:
  boot:   { addr: 0x08000000, size: 0x8000 }
  state:  { addr: 0x08008000, size: 0x4000 }
  offset: { addr: 0x0800C000, size: 0x4000 }
  app:    { addr: 0x08010000, size: 0x70000 }
  boot_project: f411_boot        # ★ app 工程级联的 boot 工程名
  slots:
    - { addr: 0x08010000, size: 0x30000 }
    - { addr: 0x08040000, size: 0x40000 }

# projects/<app>.yaml —— 烧录镜像清单（boot 由台账判定是否进会话）
flash:
  images:
    - { path: ${ELAB_ROOT}/.work/f411_boot/f411_boot.bin, format: bin, address: "0x08000000", ld: ...}
    - { path: ${work_dir}/411.bin, format: bin, address: "0x08010000", ld: ...}
```

> **与你描述的"一级 boot 跨平台 + 二级引导按芯片"完全对得上**：`boot_project` 是 chips 层声明（同一 chip 族共享），boot 工程与 app 共用同一份 chips yaml；换芯片 = 换 chips yaml 的 `boot_project` 指向，app 工程 yaml 不用动。

#### 6.7.3 插件侧要做什么（工作量：**0 行 Python，约 120 行 TS/TSX**）

| 位置 | 改动 | 说明 |
|---|---|---|
| **卡片读取** | 复用 `ProjectCard.ota` / `boot_owner`（`server.py:560-580` 已有） | 无需新增接口 |
| **工程条** | boot 子工程缩进显示在宿主卡下方（沿用 `ProjectsRail.tsx:104` 的 `↳` 语义） | 已有实现，搬过来 |
| **阶梯** | `build` 行展示级联信息：`编译 ✓（app 4.8s · boot 1.2s）`；`flash` 行展示 `boot 冻结 → 跳过` 或 `boot 已更新 → 随本次烧录` | 数据来自 `run/step-exit.detail`；若 detail 未含，退回日志尾首行 marker |
| **单步 `build`** | 提示语改为 `编译 app（会自动级联 boot）` | 文案 |
| **单步 `flash`** | 提示语 `烧录 boot+app（boot 已冻结则只烧 app）` | 文案 |
| **工具页** | OTA 工具（`tool:ota`）保持独立单步，**不塞进三连** | 三连是"原子烧录"，OTA 是"在线升级"，语义不同 |

#### 6.7.4 一个必须说清的边界

- **OTA 在线升级 ≠ 三连烧录**。三连走 SWD（openocd 一次会话烧 boot+app），OTA 走串口（boot 升级窗口接收新固件）。**两者都可能让板子"变砖"**，但只有 OTA 有 A/B 回滚保护。面板上它们必须是**两个不同的入口**，不能合并。
- 三连的"boot 是否进会话"由 C2 台账决定，**插件不参与判定、也不允许用户强制**（`--reflash-boot` 留作 CLI 能力，首个版本不进 UI）。

---

## 7. 打包、构建与挂载

### 7.1 `package.json`（形制照 better-sidebar）

```jsonc
{
  "name": "dsh-elab-cockpit",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-primitives"
      ],
      "platform": "web"
    },
    "manifestVersion": 1
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.5",
    "@deepseek-ai/dsh-client-ui-slots": "^0.2.1-rc.1",
    "@deepseek-ai/dsh-client-ui-primitives": "^0.2.1-rc.1",
    "react": "^18.2.0", "react-dom": "^18.2.0"
  }
}
```

> **不需要** `@deepseek-ai/dsh-client-ui-sidebar-right` —— 我们只消费通用槽位，不扩它的 tab 类型。

### 7.2 `cordis.patch.yml`

```yaml
- insert:
    - id: elab-cockpit
      name: 'dsh-elab-cockpit'
      disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-elab-cockpit' && e.options.id !== 'elab-cockpit' && !e.disabled)"
```

### 7.3 构建

- Vite **lib 模式**双入口；`external` 掉 `react`/`react-dom`/`@deepseek-ai/*`；产物文件名**不带 hash**（沿用原仓库"产物入库即可 diff"的守卫，同时利于 bundles 里多入口互相引用）。
- CSS：CSS Modules 由 Vite 输出 `lib/client.css`，由 `client.js` 里的 `import './client.css'?inline'` 或 DSH 的样式注入约定处理（P4 首日确认；若宿主不注入外部 CSS，则改为 `adoptedStyleSheets` 注入）。
- 类型：`tsc --noEmit` 作为 CI 门槛；`pnpm run typecheck`。
- 测试：
  - 纯函数层（`reduce/channelOfEvent/fullLoopSteps`）→ vitest，**直接照搬**原仓库 `tests/` 里的等价用例思想；
  - Host 半 → vitest + 假 `webServer`/`connection` 桩；
  - E2E → 本机 `dsh web` + Tabbit 截图核对（320 / 700 / 全屏三档）。

### 7.4 安装与自测回路

```
① 在 dsh-elab-flow 内建包 → pnpm build
② plugin_manager install_bundle（绝对路径 packages/dsh-elab-cockpit）
③ 重启 dsh → 右栏 + 菜单出现「elab 驾驶舱」
④ cordis_inspect_query(Slots.listSubTree, root='sidebar.right.pane.tab') 看到 key='dsh-elab-cockpit' 的 occupant 即注册成功
```

---

## 8. 里程碑与验收（可断言）

### 8.0 P0 · iframe 探针（**先行**，已定）

> **目标**：半天内回答三个只能用眼睛和尺子回答的问题，并把答案沉淀成 P3 的设计输入。
> **产物**：独立小包 `packages/dsh-elab-iframe/`（**不复用** P1 的骨架，避免探针污染主线代码）。

#### 8.0.1 实现（最小可跑，约 120 行 TS）

```
packages/dsh-elab-iframe/
├─ package.json                 # dsh.bundle.patch + dsh.client.inject（无 ui-primitives 依赖）
├─ cordis.patch.yml
├─ src/index.ts                 # Host：spawn python（--port 0）+ /elab-iframe/url 返回 {url}
└─ src/client.tsx               # Client：注册 sidebar.right.pane.tab，渲染 <iframe>
```

- Host 半：`spawn(python -m cockpit.server --port 0 --root <会话 cwd>)`，正则解析 `监听 http://127.0.0.1:(\d+)/`（`cockpit/server.py` main 的打印格式实读）；暴露 `GET /elab-iframe/url`（同样过 `ctx.connection.requestRejection`）。
- Client 半：拿到 url 后渲染 `<iframe src={url} title="elab cockpit" style={{width:'100%',height:'100%',border:0}} />`；外加一条 12px 高的诊断条显示 `port / width / height`（`ResizeObserver` 实测值），**这条诊断条是探针的全部价值**。
- **iframe 与 DSH 同源策略**：驾驶舱页面无 CSP / `X-Frame-Options`（见 §4.6 S2），因此可嵌入；但 DSH 页面若有 `frame-src` 限制则会被浏览器拦，**这是 P0 的第一项检查**（打开 devtools 看 console 的 CSP 拒绝信息，一票否决则改 `<object>` 或直接跳到"独立窗口 + 一键唤起"路线）。

#### 8.0.2 要测的五件事（每项记一行结论回填本文）

| # | 测什么 | 怎么测 | 通过标准 / 回填到哪 |
|---|---|---|---|
| T1 | **右栏默认宽度与可拖拽范围** | 打开面板，读诊断条的 `width`；尝试拖到 240 / 320 / 480 / 700 | 记录实际区间 → 决定 §5.3 三档阈值 |
| T2 | **驾驶舱三列在窄宽度下的崩坏点** | 在 iframe 里拖到最窄，截图 | 找出"三列堆叠/横向滚动条出现"的临界宽度 → P3 的 StageLadder 行高与字体下限 |
| T3 | **主题跟随** | DSH 切浅色/深色，同时改 `cockpit` 的 `localStorage["elab.theme"]` | 记录是否可**自动**跟随（预期：**不会**，iframe 内是独立 document）→ 决定 P4 是否需要注入 `postMessage` 主题同步；若 P0 就要修，加 30 行 `window.parent.postMessage({type:'theme'})` + 驾驶舱侧监听（**保持 Python 侧不改**：在 iframe 外层包一层 `?embed=1` 的 shim HTML，由插件 Host 半托管静态 shim，不碰 Python） |
| T4 | **键盘与滚动抢占** | 在 iframe 内滚日志、敲串口输入；在 DSH 聊天框敲同样的键 | 记录是否有焦点逃逸/快捷键冲突（如 Esc、Ctrl+K）→ 决定 P3 是否禁用全局快捷键代理 |
| T5 | **性能手感** | 跑一次 `build`，看日志滚动是否顺滑；对比原生驾驶舱窗口 | 记录肉眼可辨的卡顿点 → 决定 P3 的批渲染阈值 |

#### 8.0.3 探针的长期归宿（**保留，不删**）

P0 结束后探针**不拆**，升级为「大屏模式」入口：用户在控制条点「⤢ 独立窗口」→ `elab-iframe` 的另一种挂载（`shell.overlay` 全屏浮层，或直接 `shell.openExternal` 打开系统浏览器）。理由：

1. 窄栏天生放不下完整三轨，总会有"我要看全屏"的时刻；
2. 这条路径与 `cockpit.cmd`（Edge `--app` 独立窗口）**共用同一个服务**，不增加运行时代价；
3. 它也是**降级兜底**（Q2）：`pythonPath` 检测失败时，面板给的不是死路，而是"点这里用独立窗口打开驾驶舱"。

#### 8.0.4 验收

- [ ] 右栏出现「elab 驾驶舱（探针）」tab，iframe 内显示真实驾驶舱首页
- [ ] 诊断条显示 `port / width / height`，且 `width` 随拖拽实时变化
- [ ] T1–T5 五项各有一行结论写回 §5.3 / §9 的对应处
- [ ] 关掉 DSH 后 `tasklist | findstr python` 无残留

### 8.1 里程碑表

| 里程碑 | 内容 | 验收（可机器判定） | 工期 |
|---|---|---|---|
| **P0 探针** | `dsh-elab-iframe`：托管 Python + iframe 面板 + 诊断条 | 见 §8.0.4；T1–T5 全部回填 | 0.5d |
| **P1 Host 骨架** | `dsh-elab-cockpit`：实例池、方法白名单、`requestRejection` fence、`plans.ts`、**工程发现扫描**、配置页 | 未过 fence 的请求 403；白名单外方法 404；改 `pythonPath` 后下次 spawn 生效；DSH 退出后无孤儿 python（`tasklist` 断言）；`plans.ts` 的 basic/triple/loop 三档解析有单测；`/elab/api/discover` 在只含 `CMakeLists.txt` 的夹具目录返回 1 个候选且**不写盘** | 1.5d |
| **P2 事件通道** | SSE 透传 + 可见性开关 + 断线续传 | 手动断网 30s 后恢复，`seq` 无空洞无重复（与 `runs/<id>.jsonl` 逐条比对）；面板不可见时 `/elab/events` 连接数为 0 | 1d |
| **P3 阶梯+日志尾** | `CockpitPane` 三区 + 三档密度 + 三档一键流 UI + **boot 子工程可视化** | 阶梯状态与 `runStore.steps` 逐项一致；日志尾切通道不丢行；320px 下无横向滚动；**三档按钮可用性与 `plans.ts` 逐项一致**（对照用例通过）；组合工程在阶梯上能看出 `app 已编 · boot 已级联` 与 `boot 冻结 → 跳过烧录` | 2.5d |
| **P4 融合** | 宿主 primitives / **主题令牌映射（§5.5）** / 串口写 / 设置页 / 大屏入口 | 深浅主题切换无残留色；**注册一个极简第三方主题后面板仍可读**；ANSI 在浅/深两套下编译器输出可辨；`color-no-hex` lint 通过；串口手写与 `serial/console` 留档一致；设置页 7 项均可读写；「⤢ 独立窗口」能打开全屏驾驶舱 | 1d |
| **P5 工具化与并存** | `elab_*` 工具（含 `elab_triple`）+ RunArbiter + `lastRun` 追赶 | 聊天里 `elab_loop` 后，面板打开即显示该 run（≤2s）；人工取消 agent run 生效且事件 `run/cancel.by='human'`；agent 在人工 run 期间被拒并给出 `human-busy` | 1d |

---

## 9. 风险登记

| # | 风险 | 触发条件 | 缓解 | 归属 |
|---|---|---|---|---|
| R1 | 右栏太窄，阶梯+日志尾挤 | 320px 下高度不足 | 阶梯行固定 28px、日志尾最小 120px、控制条 36px；三档密度；必要时「日志尾可折叠成一行状态摘要」 | P3 |
| R2 | Python 进程孤儿 | DSH 崩溃 / 强杀 | 端口随机 + `--owner-token` 写临时文件；下次启动扫描并回收；Windows 用 `taskkill /T` | P1 |
| R3 | SSE 透传被 Node 缓冲 | 反向代理/压缩头缺失 | 透传 `no-transform`/`X-Accel-Buffering`；禁止 gzip 中间件；保留心跳 | P2 |
| R4 | 与 better-sidebar 争右栏 | 两者都调 `openRightbar` | 我们只用槽位，不接管轨道；打开动作带 `track=true` 幂等 | P0 |
| R5 | 事件契约漂移 | 上游改字段 | `types.ts` + `EVENT_SCHEMA_VERSION` 原样；不一致显式报错（现有行为） | P2 |
| R6 | AI/人工竞态 | 双入口同时点击 | RunArbiter 单点仲裁 + 409 带 holder + 前端行内三选一 | P5 |
| R7 | 主题/字号不生效 | 用了自研 tokens | **已解**（§5.5 路径一）：语义层映射到 `--dsw-alias-*`；`color-no-hex` 进 CI；第三方主题可读性列 P4 验收 | P4 |
| R8 | 打包产物入仓导致 DSH 包巨大 | 单包 >5MB | 只入 `lib/`（不含 sourcemap）；CSS 压缩；**不带 examples/**（Q5） | P4 |
| **R9** | **DSH 页面 CSP 禁止嵌入 iframe** | `frame-src` 不允许 `http://127.0.0.1:*` | P0 第一项检查（devtools console）；被拦则退到 `<object>` 或「窗口 + 一键唤起」，P0 结论回填 §8.0.3 | **P0** |
| **R10** | iframe 内主题不跟随 DSH | 两套 document 各自维护 `data-theme` | **P0 探针不做**（只量宽度与手感，默认 dark）；正式窄栏原生跟随（§5.5），故本条不再作用于主线 | P0 |
| **R11** | 三连误触上板 | 用户手滑点「三连」 | 三连按钮在 `onhw` 齐备时**二次确认**（行内确认，非模态）；编译/闭环不确认 | P3 |
| **R12** | 两处判定（Host `plans.ts` / Client `model/plans.ts`）不同步 | 后续只改了一边 | 共用常量 + P3 对照用例（同一夹具逐项相等） | P1/P3 |
| **R13** | **组合工程被"三连"烧坏** | 用户对 OTA 工程点三连，只烧了 app 槽、丢 boot | 框架已保证（C2 台账 + C3 原子会话），**插件侧只需如实显示**：阶梯 `flash` 行必须出现 `boot 已冻结 → 跳过` 或 `boot 会随本次烧录` 之一；两者都不显示视为 bug | P3 |
| **R14** | 并发 run（Python 不拦） | 人+AI 同时发起 | Host 半 `inFlight` 互斥（§6.2 第 1 条），P1 单测覆盖 | P1 |
| **R15** | 工程发现误扫大目录 | 会话 cwd 是 monorepo 根 | 深度 ≤3、排除表、上限 50 个；只读不写 | P1 |

---

## 10. 决策记录

| 编号 | 决策 | 理由 | 备选与否决原因 |
|---|---|---|---|
| D1 | 用 DSH 原生 `sidebar.right.pane.tab`，不自建 body 根 | 主题/几何/会话上下文免费；升级面小 | 自建栏（better-sidebar 式）：抢轨道、丢 standardProps |
| D2 | 事件通道用 **SSE 透传** | 继承合帧/背压/收尾/续传；改动 ~80 行 | WS 重封装：需重写 4 个已踩坑语义 |
| D3 | "AI 发起 → 面板跟上"用 Host 半 `lastRun` + 可见时拉取；**不新增 ICD 事件** | 零 Python 改动；前向兼容 | 新增 `stream/run-changed`：需改契约（留作后续可选） |
| D4 | Python 不迁移，进程托管 | 工具链/串口/OpenOCD 已验证；零标准库依赖易部署 | Node 重写：工作量大、串口与 OpenOCD 交互风险高 |
| D5 | 窄栏不做"工作区 Tab"，改为**步骤 → 日志通道**投影 | 320px 放不下两级导航；且与阶梯天然同构 | 保留四工作区 Tab：与阶梯重复表达 |
| D6 | 人工按键在 AI 跑时**部分可用**（取消/预览/切通道），而非全灰 | 人的最高优先权 + "看得见才能干预" | 全灰：窄栏变成只读屏，违背本次需求 |
| **D7** | **主题走路径一：原生跟随 DSH 令牌**（`--dsw-alias-*` 映射进 `--elab-*`），插件不持有任何主题状态 | DSH 18 个令牌全为 `requiresLightAndDark` 的 CSS 变量，换主题时变量就地变化，组件零监听；第三方主题自动生效；升级面最小 | 路径二（iframe 令牌搬运）：仅作 P0 探针的备选，长期不用于主线 |
| **D8** | 原 `--elab-*` 原色层/玻璃/渐变**删除**，仅保留语义层映射 + 间距常量 + ANSI 两套 | 避免"自研设计系统 + 宿主设计系统"两套并存导致的视觉割裂与升级维护 | 全量保留 357 变量：与 DSH 主题必然冲突（R7 原形态） |

---

## 11. 评审结论（Q1–Q14 已决策，2026-10-25）

| # | 问题 | **决策** | 落点 |
|---|---|---|---|
| **Q1** | 阶梯行交互 | **点行 = 聚焦日志；点行首 ▶ = 单步执行**（防误触烧录） | §6.3、§5.2 |
| **Q2** | `pythonPath` 检测失败 | **面板内报错 + 设置入口**，并额外给「⤢ 用独立窗口打开驾驶舱」兜底（**不**静默退回 iframe 主界面） | §8.0.3、§4.4 |
| **Q3** | `allowAgentWrite` 默认值 | **`false`**：Agent 默认能发起闭环/三连/取消，**不能**写串口、不能适配写盘 | §4.4、§6.5 |
| **Q4** | AI 跑时人工点单步 | **行内三选一**（另起一轮 / 等当前结束 / 取消当前再跑），默认焦点「等当前结束」 | §6.3 |
| **Q5** | 插件是否携带 `examples/` | **不带**；`examples/` 与 `.work/` 留在仓库，插件包只含 `lib/` + locale + icon | §7.1、R8 |
| **Q6** | P0 形态 | **iframe 探针先行**（`dsh-elab-iframe` 独立包），测完保留为「大屏模式」 | §8.0 |
| **Q7** | 是否要"只跑部分步骤"多选 | **不要**。触发面 = **单步 / 一键三连 / 一键闭环** | §6.6 |
| **Q8** | 插件 UI 是否跟随 DSH 主题 | **必须跟随，且走路径一**：原生令牌映射，插件零主题状态；原色层/玻璃/渐变删除，仅 ANSI 保留两套 | §5.5、D7、D8 |
| **Q9** | 三连与闭环对"不可用步骤" | **两者一致：都剔除**（不拒绝），并在 tooltip / 日志首行写明跳过了什么 | §6.6.3 |
| **Q10** | 工程选择是全局还是会话级 | **每个会话各记各的**（`sessionId → project`），切会话不串台 | §5.2、§4.5 |
| **Q11** | Agent 跑闭环要不要审批 | **直接跑**，不预先审批；可观测性由面板（蓝标 actor + 阶梯点亮 + 日志滚动 + 随时取消）保证 | §6.2 第 6 条 |
| **Q12** | 是否做跨进程互斥 | **不做**。同机"同一时间只用一个入口"作为用户约定写在环境行；不实现文件锁 | §6.2 第 5 条 |
| **Q13** | 一键三连烧谁 | **boot + app**：由 `ota_layout.boot_project` + `flash.images` 在框架内级联（**零 Python 改动**），插件只做可视化 | §6.7 |
| **Q14** | `debug_verify` 的定位 | **不是 CI 专用**：它是 **openocd 硬件寄存器级调试**（断到 `main` 后观察 MCU 运行状态），是"很重要"的日常能力 → 必须进三连、必须有单步入口、日志尾要能显示 gdb 断点输出 | §6.7.5 |

> 施工约束（据 Q7 收敛）：`ManualBar` 只有 4 个动作按钮 + 1 个 ⚙；**禁止**引入步骤勾选/排序/自定义链，任何"部分步骤"能力只能通过**单步**实现。
> 施工约束（据 Q10）：`project` 存在**会话作用域**（Client 侧按 `sessionId` 分片持久化，或直接挂到 DSH 的 session state 上），**不得**写进插件全局 prefs。

### 11.1 `debug_verify` 的正式定义（Q14 澄清后新增）

| 维度 | 定义 |
|---|---|
| **做什么** | 用 `arm-none-eabi-gdb` 挂 openocd（SWD），加载 `toolchains/gdb/break_main.gdb`：`target extended-remote | reset halt | load | break main | continue` —— 断在 `main`，证明"镜像能跑且入口正确" |
| **产出什么** | `run/step-exit.detail` 一行摘要（如 `断点命中 main @0x0801xxxx`）+ 日志尾里的 gdb 输出（寄存器、栈帧） |
| **为什么重要** | 烧录成功 ≠ 固件能跑。`debug_verify` 是唯一能区分"烧进去了"与"跑起来了"的步骤，也是寄存器级观察 MCU 状态的入口 |
| **面板上的位置** | ① 阶梯固定一行（`调试校验`）；② 三连的第三步；③ 日志尾有一个 `debug` 通道（`channelOfEvent` 现有规则里 `debug_verify` 归 `flash` 通道，**本次改为独立 `debug` 通道**，便于 gdb 输出单独看） |
| **首版不做的** | 交互式 gdb（下断点/单步/看寄存器面板）。首版只做"跑一次 `break_main` 并展示输出"；交互式调试留给将来的独立视图 |

---

## 12. 遗留待定（不阻塞 P0，P1 前需定）

| # | 事项 | 建议默认值 | 影响 |
|---|---|---|---|
| ~~O1~~ | ~~三连里 `debug_verify` 是否允许无探针~~ | **已关闭（Q9/Q14）**：不允许，且 debug_verify 定位为重要的硬件调试 | §6.6.3、§11.1 |
| O2 | 面板不可见时是否保留 SSE 连接 | **断开**（可见时 `from=lastSeq` 追平） | §4.3、P2 验收 |
| O3 | `hostIdleKillSec` 默认 600s 是否太激进 | 保留 600，可在设置页调 | §4.4 |
| O4 | 日志尾默认保留行数（原 4000） | 窄栏降到 **1500**（内存/绘制平衡） | P3 |
| O5 | 是否把 `elab_log` 工具暴露给 Agent | 是（只读，200 行上限） | §6.5 |
| **O6（新）** | 未接入工程的探测（"打开仓库就能一键接入"）：探测到什么程度？ | **已定（§13.7）**：扫描只出候选 + 厂商预判；探测复用 `adapt.probe_project`（只读）；写入复用 `adapt.write`（六道保护）；**不提供 `--force` 的 UI 通道** | §13 |
| **O8（新）** | 候选扫描起点：会话 cwd 还是 `elabRoot`？ | 会话 cwd 优先，`elabRoot` 兜底（二者都扫，去重） | §13.3 |
| **O9（新）** | 漂移检测（`adapt --check` → `drift`）的频率 | 面板可见时每 5 分钟一次，Host 半缓存；不可见时完全不跑 | §13.2 G3 |
| **O10（新）** | 适配后的 verify run 是否算"污染"主阶梯 | **不算**：独立小状态条 `AdaptVerify`，与主阶梯分离 | §13.6 |
| **O7（新）** | `debug` 独立通道是否需要 `channelOfEvent` 改动 | 需要：在插件的 `model/channels.ts` 里把 `debug_verify` 从 `flash` 拆出（**只改前端**，因为 `channelOfEvent` 本来就是前端函数） | §11.1 |
---

## 13. 工程发现与"一键接入"（完善原有 adapt 构想）

> **需求原话**："打开一个仓库，就看到能一键接入的工程。"
>
> **核心判断（源码实读后修正）**：`elab adapt` **不是"顺便加个扫描"就能用上的功能**——它是一台**确定性探测机**，设计目标就是"人/agent 拿着报告裁决"，只是当前入口错配在 CLI（要手打绝对路径）和驾驶舱（要点「＋适配」粘贴路径）。**插件要做的不是发明探测逻辑，而是给已有的 13 步探测 + 6 级证据 + 三分类裁决换一个入口：从"用户找工程"变成"工程来找用户"。**

### 13.1 原有实现盘点（`services/elab/adapt.py`，862 行）

| 维度 | 现状 | 对插件的影响 |
|---|---|---|
| **探测能力** | 13 步流水线：厂商/生成器 → archetype → 工程名 → 工具链 → 链接脚本 → 编译 flags → 芯片宏 → 芯片匹配 → 内存布局 → 生成器模板 → 内存一致性 → FreeRTOS → 串口输出能力 | **能力已足够**，无需新增探测 |
| **证据体系** | 6 级 `E1编译 > E2元数据 > E3链接 > E4结构 > E5模板 > E6文件名`；每条 `Fact{key,value,level,evidence}` 带出处 | 报告可直接渲染成 UI 的证据链（无需转换） |
| **裁决三分类** | `conflicts`（低级证据被高级否决，不阻断）/ `ambiguities`（未决项，**阻断写入**）/ `notes`（提示，不阻断） | **这就是现成的"红/黄/绿"三级状态**，前端照搬即可 |
| **置信度** | `high`（无冲突）/ `medium`（有冲突）/ `low`（有未决项） | 工程条上直接显示三色点 |
| **写盘保护** | ① `T3` 拒绝（无 CMakeLists）② 有 `ambiguities` 且非 `force` → 拒 ③ 芯片未匹配 → 拒 ④ `generated-by` 标记缺失 → 判定"人工接管"不覆盖 ⑤ 内容相同 → `identical` 跳过 ⑥ 内容不同 → `differs` 要求 `--force`（写前备份 `.bak`） | **六道保护已在服务端，插件不能也不应绕过** |
| **确定性** | 头部注释明写"本文件不含时间戳：同一工程重复生成必得同样内容" `--check` 有 `identical/drift/missing` 三态 | **这是最大的红利**：可以在面板上做"漂移检测"（工程变了 → 接入声明过期），而无需任何额外设计 |
| **现有入口** | CLI `elab adapt <path> --write/--check/--force`；HTTP `POST /api/adapt {action: probe\|write}` | 插件**直接复用 HTTP 端点**，零新增 |
| **两段式纪律** | 代码注释："probe 永远在前，落不落盘不许藏在同一个按钮里" | 插件 UI 必须保持两段（已有 `AdaptPanel` 就是这么做的） |

### 13.2 现状缺口（4 个，**只在插件侧补**）

| # | 缺口 | 证据 | 插件补法 |
|---|---|---|---|
| **G1** | **用户必须自己知道工程路径**（要粘贴绝对路径；相对路径被硬性拒绝，`server.py:990-993`） | 当前入口假设"用户已经知道要接哪个工程" | `GET /elab/api/discover`：扫会话 cwd 出候选列表（13.3） |
| **G3** | **改动后没有"已过期"提示** | `--check` 能力存在但无任何 UI 入口 | 工程条上对已接入工程周期跑一次 `adapt --check`（仅在面板可见时，缓存在 Host 半 5 分钟），`drift` → 卡片上出现黄色 `↻ 工程已变更，建议重新探测` |
| **G4** | **验证链条断开** | 服务端注释："刻意不做三绿灯 verify（那是 build 级长任务，会把服务线程钉死）" → 返回 `next: {steps:["doctor_deep","build"]}` 让前端转去跑 run | 插件在写入成功后**自动起一个 `doctor_deep+build` 的 run**（P-loop 之外的第四种内部 run，**不经 ManualBar**），并把三绿灯结论（doctor 全绿 / 出 elf / guard.untouched）直接渲染在适配报告卡片底部 |
| **G5** | **失败后无处可去** | `ambiguities` 的文案是给人读的长句（如"archetype 判为 B 类…但工具链用的是 CMAKE_EXE_LINKER_FLAGS…"） | 每条 `ambiguity` 渲染成**可展开项**：原文 + 涉及的文件/行（`evidence` 字段已有出处）+「用 Agent 分析这个阻断项」按钮（把这个 probe 报告作为上下文发给聊天，让 AI 出建议） |

> **G2 已消除**：原以为需要新写探测，实读后确认 `probe_project` 是**纯只读函数**（`adapt.py:491`，只 `_read()` 文件），可直接被「发现」流程按候选路径调用，无需先写入。

### 13.3 扫描器的精确设计（`/elab/api/discover`）—— **已实现并有实测**

> 实现：`packages/dsh-elab-cockpit/src/host/discovery.ts`（扫描核心 356 行）+ `discover-route.ts`（接线 349 行）
> 测试：`test/discovery.test.mjs`（11）+ `test/discover-route.test.mjs`（10）= **21/21 通过**
> 冒烟：`scripts/smoke-discover.mjs`（真起 HTTP 服务打这个路由，含 403/200/缓存/POST 四条路径）

**实测数据（本仓库 `dsh-elab-flow`，2026-10-25）**：

```
dirsVisited: 65   elapsedMs: 35   truncated: false   adaptedCount: 4
candidates:
  AT32F421G8U7@d2                        ← 未接入
  411@d3                                 ← 未接入（嵌套工程）
  AT32_TEST@d2        (已接入:at32_test)
  F411CEU6_BOOT@d2    (已接入:f411_boot)
  STM32F411CEU6@d2    (已接入:f411)
  STM32_TEST@d2       (已接入:stm32_test)
```

**调研→实现阶段修正的 4 个错误判断（都是真跑了才发现的）**：

| # | 起初的判断 | 修正 |
|---|---|---|
| **D-a** | "见到 `CMakeLists.txt` 就是一个工程" | **错**。本仓库 7 个命中里 `components/ota`、`components/serial` 是 `add_subdirectory()` 的子目录 CMake（无 `project()`/`CMAKE_PROJECT_NAME`），接进 elab 必然探测失败 → **改为"声明了工程名才算根工程"**（覆盖 `project()` 与 CubeMX/WorkBench 的 `set(CMAKE_PROJECT_NAME …)`） |
| **D-b** | "含 `${ELAB_ROOT}` 的条目跳过即可" | **错**。本仓库**全部** `projects/*.yaml` 都用 `${ELAB_ROOT}/examples/…`，跳过会让 `adaptedCount` 恒为 0、已接入标记形同虚设 → **求值 `${ELAB_ROOT}`/`${ROOT}`**，其余变量才跳过 |
| **D-c** | 响应用 `{...result}` 展开 | **错**。`result.root`（字符串）与 `scanRoot`（对象）字段名冲突，展开时 `source` 被覆盖 → **字段名互斥** |
| **D-d** | `replace(/\\/g,"/")` 直接写 | 反斜杠字面量会经工具层折叠成 `\`，`C:\repo\ok` 变 `C:epook` → 改用 `String.fromCharCode(92)` 构造，并加回归用例 |

**扫描规则（最终形态）**：

| 规则 | 取值 | 依据 |
|---|---|---|
| 起点 | 显式 `elabRoot` > 会话 cwd > 从 cwd 向上找（`projects/`+`elab.host.yaml` 同时存在）> home | 响应带 `scanRoot.source` 让 UI 如实说明"在哪儿扫的" |
| 深度 | ≤ 3 | 本仓库真实布局 `examples/<PROJ>`（d2）；离线工程常见 `repo/fw/app`（d3） |
| 命中 | `CMakeLists.txt` **且**声明工程名 | D-a |
| 排除 | `build/` `cmake-build-*` `.work/` `node_modules/` `third_party/` `vendor/` `out/` `dist/` 及所有 `.` 开头 | 进 `build/` 会撞上 `_deps/` 上千目录 |
| 上限 | 50，超出 `truncated: true` | 不静默截断 |
| 排序 | 未接入优先 → 深度浅优先 → 路径字典序 | 新发现的浮上来；确定性可断言 |
| 缓存 | 30s TTL（键=起点+depth+limit）；`refresh=1` 绕过；并发请求合并为一次 | 面板变可见即拉 |

**接口契约（已实现）**：

```
GET /elab/api/discover?sessionId=<id>&refresh=1
  ├ fence: ctx.connection.requestRejection(req) 非空 → 403
  ├ 非 GET → 405 + Allow: GET
  ├ sessionId 非法（非 [A-Za-z0-9._:-]{1,128}）→ 400
  └ 200 → { ok, scanRoot:{path,source}, elabRoot, adaptedCount, cached,
            candidates:[{path,dirname,depth,hints:{ioc,atwp,generatorDir,linkerScripts},adaptedAs}],
            maxDepth, truncated, dirsVisited, elapsedMs, root }
```

**设计红线（已写进实现注释）**：
- **不 spawn Python**：纯文件系统扫描，35ms 量级，不依赖 cockpit 进程起来。
- **绝不写盘**：写仍走 Python 的 `POST /api/adapt`（六道保护在那一边）。
- 坏 YAML 单文件不影响整表；单目录权限失败不影响整次扫描（均有测试）。
- `yaml` 依赖在 profile 中已随 better-sidebar 存在（`yaml@2.9.1`），声明进 `dependencies` 即可。

### 13.4 完整交互链路（三段式，与现有两段式衔接）

```
打开仓库/会话 ──► ①发现（只读扫描）──► 候选列表（带厂商预判）
                                          │
                                     点击「探测」
                                          ▼
                          ②探测（adapt.action=probe，只读）
                                          │
                      ┌───────────────────┴───────────────────┐
                  有 ambiguities                          无阻断项
                      │                                       │
             阻断项可展开 +                              「写入」按钮
             「让 Agent 分析」                                 │
                                                         ③写入
                                                              │
                                                     ④自动 verify run
                                                    （doctor_deep+build）
                                                              │
                                                    三绿灯结论上屏
```

### 13.5 面板呈现（窄栏，与 §3.3 的工程条一体）

```
│ 工程 ▾ f411              ＋2 发现  ↻        │
│  ├ ▸ f411   ● ●●  (APP · 已接入)            │   ← ●●● = doctor/build/flash 可用性
│  │   ↳ f411_boot   (BOOT · 冻结 v0.2.0)     │
│  ├ ○ STM32_TEST  CubeMX?  [探测]            │   ← 预判来自 *.ioc 存在
│  └ ○ AT32_TEST   WorkBench?  [探测]         │
│                                             │
│  ── 探测报告（行内展开，不跳页）──────────  │
│  T1 · 置信度 high · 芯片 st/stm32f103xb     │
│  证据链 ▸ 6 条（按 E1→E5 排序，可展开原文）  │
│  ✓ doctor/build 可用   ✓ 已生成 monitor 判据 │
│  [写入 projects/stm32_test.yaml]            │
└─────────────────────────────────────────────┘
```

### 13.6 与"一键三连/闭环"的衔接（G4 的细节）

写入成功后的 verify run **不是**第六个按钮，而是：
- 适配卡片底部显示「接入验证中…」（一个独立的小 run 状态条，与主阶梯**分离**，避免污染当前工作流的阶梯）；
- 三绿灯结论直接以三行徽标呈现：`[✓] doctor --deep` / `[✓] build 出 elf` / `[✓] guard.untouched (+0 -0 ~0)`；
- **`untouched=false` 时红色告警**："业务工程被改动了 —— 违背适配≠改造"（服务端 CLI 里就是这么判的，`__main__.py:700`）；
- 用户可「跳过验证」直接进入驾驶舱（不阻塞主流程）。

### 13.7 边界与红线

- **扫描绝不写盘**；写入仍走 `adapt.write` 的六道保护，插件**不提供绕过 `--force` 的 UI**（需要强制时提示用 CLI，保持"危险操作只在终端里做"）。
- **不跨仓库**：只扫会话 cwd，不看 `.git` 远端（用户明确"打开一个仓库"）。
- **不自动接入**：发现 ≠ 接入。永远需要"探测 → 写入"两次显式点击（沿用 `server.py:965-982` 的两段式纪律）。
- **不改 Python**：`/api/adapt` 已有 `probe`/`write` 两个 action，`/api/discover` 是 Host 半新增的路由（不碰 Python）。
- **候选为空时的兜底文案**要具体：`当前会话目录（<path>）下 3 层内未发现 CMakeLists.txt。若工程在别处，可在设置页改 elabRoot，或用「＋适配」直接粘贴绝对路径。`

### 13.8 新增工作量评估

| 项 | 位置 | 工作量 |
|---|---|---|
| `/elab/api/discover` 扫描器 + 缓存 | Host 半 `discovery.ts` | 120 行 |
| `/elab/api/adapt` 代理（复用现有） | Host 半 `wire.ts` 白名单加一条 | 10 行 |
| 候选列表 + 预判标签 | `ProjectStrip.tsx` 扩展 | 90 行 |
| 探测报告卡片（证据链可展开、三分类） | 新 `AdaptReport.tsx` | 180 行 |
| 漂移检测（`--check` 周期化） | Host 半 `drift.ts` + 卡片角标 | 60 行 |
| verify run 衔接 + 三绿灯徽标 | `AdaptVerify.tsx` | 80 行 |
| **合计** | | **约 540 行 TS/TSX，0 行 Python** |

> 工期影响：P1 的"工程发现扫描"从 0.5d 提升到 **1d**（含报告卡片），P3 的工程条从 0.5d 提升到 1d。总工期约 7.5 人日。

---

## 附 A：fork 操作记录

```bash
cd "C:/Users/xiao1/Desktop/ELAB"
cp -r elab-flow dsh-elab-flow        # 保留 .git（HEAD 5b837bc）、node_modules、.work
cd dsh-elab-flow && git status       # 工作树干净，可随时回滚/对比
```

- 原仓库 `elab-flow` **未被修改**；后续所有改动只在 `dsh-elab-flow` 内。
- 建议首个 commit：`chore: fork for dsh plugin port (docs only)`，只含本文档，便于评审 diff。

## 附 B：证据清单（本文所有"实读"结论的出处）

| 结论 | 文件:行 |
|---|---|
| 服务端只绑 127.0.0.1 / 默认 8333 | `cockpit/server.py:48, 51` |
| SSE 帧格式、心跳、`stream/closed` | `cockpit/server.py:1046-1200` |
| `DEFAULT_STEPS` 只有两步 | `services/elab/run.py:45` |
| `ALL_STEPS` 六步 / ONHW 三步 | `services/elab/run.py:38-48` |
| 卡片字段（tools/ota/steps/boot_owner/derived） | `cockpit/server.py:560-580` |
| `fullLoopSteps` 的注释与语义 | `cockpit/web/src/rails/StageRail.tsx:30-47` |
| `reduce()` 是纯函数、未识别 topic 原样返回 | `cockpit/web/src/store/runStore.ts:93-207` |
| 日志不进 React store | `cockpit/web/src/store/logs.ts:1-12` |
| SSE 客户端"收到 stream/closed 才关闭" | `cockpit/web/src/events/sse.ts:1-24` |
| 事件→通道归类规则 | `cockpit/web/src/workspaces.ts#channelOfEvent` |
| better-sidebar 路由注册与 fence | `~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/src/index.ts:112, 1312, 1447-1500` |
| better-sidebar 自建 body 根 | 同上 `src/client/index.tsx:158-330` |
| better-sidebar 扩展点 `ctx.betterSidebar` | 同上 `src/client/index.tsx:172`、`src/client/service.ts:616-622` |
| DSH 槽位拓扑（`sidebar.right.pane.tab` 等） | `cordis_inspect_query(client, Slots, listSubTree)` 2026-10-25 |
| DSH Client 服务 `ctx.layout.openRightbar` | `cordis_inspect_query(client, Service, listService)` |
| 18 个设计令牌与 `requiresLightAndDark` 契约 | `cordis_inspect_query(client, Theme, listTokens)` 2026-10-25 |
| `theme` 服务（`getTheme`/`register`/`overrideTokens`，第三方主题走 alias 层） | `cordis_inspect_query(client, Service, listService, service='theme')` |
| 原驾驶舱 167 行 tokens（357 变量、两层结构、ANSI 两套） | `cockpit/web/src/theme/tokens.css` |
| 组件层无字面色值（规则天然可守） | `grep -rno '#[0-9a-fA-F]{3,6}' cockpit/web/src/{rails,render,App.tsx}` → 无命中 |
| DSH Client 动态半可用 `styles.insert(css)` 注入样式 | `cordis_inspect_query(client, Builtin, listBuiltins)` |
| **C1 boot 级联构建**（`build_with_boot`，app 成功后自动编 boot，防递归） | `services/elab/builder.py:30-60` |
| **C2 boot 冻结台账**（md5 比对 `flash_stamp.json` → skip/flash） | `services/elab/flash.py:65-140` |
| **C3 一次 openocd 会话原子烧多镜像**（bin 必须显式地址，防向下对齐吞 boot 尾） | `services/elab/flash.py:226-260` |
| `boot_project` 解析与自引用语义 | `services/elab/plan.py:147-170` |
| `ota_layout` 分区表与 `boot_project` 声明 | `chips/st/stm32f411ceux.yaml:36-52` |
| 组合工程 app 的 `flash.images` 双镜像声明 | `projects/f411.yaml:36-45` |
| **`RunManager.spawn` 不检查已有活动 run**（故必须插件侧串行化） | `cockpit/server.py:229-290` |
| `elab adapt` 只读探测入口 `probe_project` / 写盘 `write` | `services/elab/adapt.py:491, 745` |
| **adapt 六道写盘保护**（T3/ambiguities/芯片未匹配/人工接管/identical/differs+备份） | `services/elab/adapt.py:744-805` |
| **adapt 确定性**（无时间戳，`--check` 三态 missing/identical/drift） | `services/elab/adapt.py:625-640, 770-790` |
| **adapt 证据六级 + 三分类**（conflicts/ambiguities/notes + confidence） | `services/elab/adapt.py:31-116` |
| **adapt 13 步探测流水线** | `services/elab/adapt.py:491-620` |
| **adapt 两段式纪律**（probe 永远在前，不做同步 verify） | `cockpit/server.py:965-982` |
| `/api/adapt` 已有 probe/write 两 action + 写后原子重载 Config | `cockpit/server.py:955-1022` |
| CLI `adapt --verify` 三绿灯判据（doctor_deep/build/guard.untouched） | `services/elab/__main__.py:644-706` |
| 冷启动 329ms / capabilities 140ms / projects 72ms | `scripts/bench-host.py` 实测 2026-10-26 |
| 全量 clean build 推流仅 5 行（**改前**） | `scripts/bench-clean-build.py` + `bench-from-events.py`，run `r-09de17f4` |
| **流式化后 59 行 / 28 条进度 / 10.5 帧每秒**（**改后**） | run `r-ca3ffae4`，`scripts/verify-stream-build.py` |
| **Ninja 在非 TTY 管道下逐行输出 `[n/28]`**（32 行 / 28 条进度） | `scripts/bench-ninja-full.py` 实测 |
| **`verbose=True` 也不流**（`subprocess.run` 无 stdout → 输出到继承终端） | `services/elab/builder.py:487-497` + 实测 |
| 构建 `capture_output=True` 一次性捕获，构建期间零流 | `services/elab/builder.py:493-496` |
| `runs/` 无索引文件，`list_runs` 靠文件名+首尾事件重建 | `services/elab/kernel/events.py:523-538` |
| 子进程需 `-u` + UTF-8，否则管道缓冲/GBK 解码爆炸 | 实测（见 §14.3） |

---

## 14. 实测结论与 Q15–Q19 决策（2026-10-26）

> 本节所有数字来自 `packages/dsh-elab-cockpit/scripts/bench-*.py`，可复跑。
> 复跑前提：`cd dsh-elab-flow && python packages/dsh-elab-cockpit/scripts/bench-host.py`。

### 14.1 性能基线（推翻了文档里两个悲观假设）

| 指标 | 实测 | 对设计的影响 |
|---|---|---|
| 冷启动到监听 | **329 ms** | `hostIdleKillSec` 可放宽到 30 分钟；杀进程重启的代价可忽略 |
| `/api/capabilities` | 140 ms | 首屏可直接拿 |
| `/api/projects` | 72 ms | 工程条刷新无感 |
| **一次全量 clean build 的 SSE 推流** | **仅 5 行**（configure → ✓ → build → ✓ → 守卫） | ⚠️ **原方案担心的"上万行洪水"不存在**。日志尾是"看结论"而非"看过程" |
| `runs/` 现状 | 768 个 run / 3.4 MB / 最大单 run 12 KB | 回放上限可从 1500 提到 **4000**，无内存压力 |

**根因（决定了 Q15 的解法）**：`builder._run()` 用 `subprocess.run(capture_output=True)` **一次性捕获**（`builder.py:493-496`），构建结束后才把摘要交给 `sink()`。所以构建期间**没有任何数据流**——不是"行太少"，是"根本不流"。
另外实测 `verbose=True` 也没用：那条分支 `subprocess.run(cmd, text=True, **win)` 没设 `stdout`，输出直接进继承终端，**不经过 `log` 回调**。

### 14.2 Q15 · 进度条：**已实现并验证**（路径 B 落地）

**实测（`scripts/bench-ninja-full.py`）**：Ninja 在**非 TTY 管道**下照样逐行输出真进度：

```
[1/28] Building ASM object CMakeFiles/TEST.dir/startup_at32f421.s.obj
[2/28] Building C object cmake/at32_workbench/CMakeFiles/AT32_Drivers.dir/.../sr.c.obj
...
[28/28] Linking C executable TEST.elf
Memory region   Used Size  Region Size  %age Used
       FLASH:      4840 B      64 KB      7.39%
         RAM:      1576 B      16 KB      9.62%
```
- 默认模式 32 行；`-v` 同样 32 行但每行是完整 gcc 命令行（更适合"终端式"视图）。
- 共 **28 条 `[n/m]` 进度行**，符合 `^\[(\d+)/(\d+)\]`，可直接算百分比。

**实现（已合入 `services/elab/builder.py`）**：

| 改动 | 内容 |
|---|---|
| 新增 `_stream(cmd, env, cwd, log)` | `Popen` + 逐行读：**每行先 `log()`（→ 事件 sink）再累积进 stdout**；`encoding="utf-8"`、`errors="replace"`；`log()` 抛异常被吞掉（上报端故障不能打断构建） |
| `_run(..., *, stream=False, log=None)` | 新增两个关键字参数；`stream=True` 走 `_stream`，否则维持原行为（含 `verbose` 分支） |
| 两个调用点 | `configure_cmd()`（`:377`）与 `build_command()`（`:390`）改为 `stream=True, log=log` |

**为什么流式不能取代累积 stdout**：`build_project` 后续依赖 `out` 做两件事——
① 提取 `link_line`（`[elab] ✓ build ([28/28] Linking …)`）；
② `_parse_memory(out)`（FLASH/RAM 占位，来自链接器 `--print-memory-usage`）。
逐行透传若丢掉累积，这两处会**静默退化成空值**（正是 N6 那类"声明了却拿不到、还不出声"的坑）。故 `_stream` 同时返回累积串。

**验证（`scripts/verify-stream-build.py`）**：

| 指标 | 改前 | 改后 |
|---|---|---|
| 单次全量 build 的 log 回调条数 | 5 | **59** |
| 其中 `[n/m]` 进度行 | 0 | **28** |
| 进度行时间跨度 | — | 0.67s（证明是流式而非一次性倾倒） |
| `res.memory` | `FLASH 7.39% / RAM 9.62%` | **不变** |
| `res.artifacts` | elf/hex/bin/map | **不变** |
| `guard.untouched` | True | **True** |
| 仓库既有测试 | 209 passed | **209 passed** |

**端到端（经 cockpit → SSE → 事件文件）**：

```
run r-ca3ffae4:  proc.jsonl 12.4 KB（改前 0.9 KB）
总帧 63 / proc 行 59 / 平均 10.5 帧每秒 / 跨度 6.00s
```
> 注意 `proc/stdout` 逐条出现（不是 `stdout-batch` 合帧）——因为每行都是独立事件，说明**流式是真的**，而非结束时批量倾倒。

**窄栏进度条形态**：`▓▓▓▓▓▓░░░ 21/28 · 75% · 3.5s`；Linking 阶段显示 `[28/28] Linking…` 并点亮 FLASH/RAM 徽标。**进度条吃 `[n/m]`，日志尾保留摘要**（两层信息各取所需）。

**一个诚实的观察**：Ninja 在构建初期会攒一批（实测 [1/28] 与 configure 完成之间约 2s），之后才密集推进。所以进度条在**前 2 秒会停在 0%**，这是 Ninja 自身行为（它先扫描依赖图），不是我们的缺陷。UI 上应显示"准备中…"而非静止的 0%。

**工期影响**：P3 +0.3d（比预估的 0.5d 少，因为改动集中在两个函数）。

### 14.3 Q17 · 进程托管的两个坑（**已在插件侧解决**）

| 坑 | 现象 | 根因 | 插件侧对策 |
|---|---|---|---|
| **管道缓冲** | Host 半等"监听那一行"永久挂起（实测挂死一次） | Python stdout 走管道时是**块缓冲**，~4KB 才 flush | spawn 时加 **`-u`**（unbuffered） |
| **GBK 解码炸** | `UnicodeDecodeError: 'gbk' codec can't decode 0xab` | 服务端输出含 `✓`/中文，Windows 默认 GBK | spawn env 加 **`PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`**，读取端显式 `encoding:'utf-8'` |

**决策**：在**插件侧**解决（`elab-host-process.ts` 固化这三条），`cockpit/server.py` 一行不改。
> 备注：`server.py` 自己的 `--logfile` 分支已经显式 utf-8，说明上游遇到过同类问题；但我们不改上游。

### 14.4 Q16 · 工具子进程孤儿：用 Windows Job Object（已定）

`services/elab/run.py:200-204` 自认："取消杀的是 `elab run`，工具子进程会变孤儿继续跑，持有的串口在它退出前不可复用。"

**决策：B，用 Windows Job Object 一并终结。**
- 实现位置：**插件 Host 半**（spawn cockpit 时创建 Job，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），cockpit 的整棵进程树（python → cmake → ninja → gcc → openocd / OTA 上位机）都挂在 Job 下；插件卸载/DSH 退出 → 关 Job → 全树终结。
- **不需要改 Python**：Job 是 Host 半在 spawn 时施加的，`cockpit/server.py` 无感。
- 顺带解决 §16 提到的另一个产物：**独立窗口版**（`elab-iframe`）与插件共用同一 Job 归属时，也不会互相留下孤儿。
- 实现要点（Node 侧）：`node:child_process` 的 `windowsHide` + 外部 `CreateJobObject`（需 `koffi`/`node-ffi-napi` 或 PowerShell 垫片；**P1 首日做可行性验证**，若 FFI 不可用则退到 `taskkill /T /F` 按 PID 树杀）。

### 14.5 Q18 · `--clean` 二次确认（已定）

- 窄栏**提供** `--clean`，收在 ⚙ 选项里；**勾选时立即弹行内二次确认**（非模态）：
  `将先删除 .work/at32_test（153 个文件旁证，不可逆），继续？[确认] [取消]`
- 删除目标路径来自 `GET /api/plan --clean` 的预览（该接口已能给出"先删除工作目录（不可逆）"），**不自己拼路径** —— 与"预览即真相"同一条纪律。
- 二次确认只在"勾选 + 点运行"两个时刻触发一次，不重复打扰。

### 14.6 Q19 · runs/ 自动清理（已定：插件侧周期清理）

**安全性已核实**：`runs/` 是纯平铺目录（`r-<id>.jsonl` + `.proc.jsonl` + `.log` 三件套），**没有索引文件**；`list_runs()` 靠"文件名 + 首尾事件"重建（`kernel/events.py:523-538`），删任何历史 run 都不会破坏一致性。

**策略（无需人工干预）**：

| 参数 | 默认 | 说明 |
|---|---|---|
| 保留条数 | **200** | 超出部分按 mtime 从旧到新删 |
| 保留天数 | 14 天 | 双条件取"并集保留"（两者都满足才删） |
| 总容量 | 50 MB | 兜底：超过则从最旧开始删到阈值以下 |
| 豁免 | **活动 run**（`/api/runs.active` 中的 id）与**最近一次** run | 永不删 |
| 触发时机 | 每次 run 正常结束后（延迟 10s，避免与 SSE 读尾冲突）+ 面板变可见时若已超阈值 | 不常驻定时器 |
| 干跑 | `Config.cleanupDryRun: true` 时只记日志不删 | 便于排查 |

**实现位置**：插件 Host 半 `run-retention.ts`（纯 TS，读目录 + 按规则删），**不改 Python**。
**红线**：只删 `r-*` 三件套中**同时存在**且 id 在历史列表里的文件；任何一条判断不通过就跳过并记 warn。

### 14.7 决策汇总（Q15–Q19）

| # | 问题 | 决策 | 改 Python？ | 工期 |
|---|---|---|---|---|
| Q15 | 日志更细 / 进度条 | **已实现**：`builder._stream()` 逐行透传，`_run(stream=True)` 两次调用 | **是**（`builder.py` 一处，~70 行含注释） | 已完成 |
| Q16 | 工具孤儿 | **已实现**：Windows Job Object 全树终结，Host 半施加 | 否 | 已完成 |
| Q17 | 管道/编码 | **已实现**：`-u` + `PYTHONUTF8` + utf-8 解码 | 否 | 已完成 |
| Q18 | `--clean` | **提供**，⏹ 勾选即行内二次确认，路径取自 `/api/plan` | 否 | 待 P3（UI 层） |
| Q19 | runs 自动清理 | **已实现**：200 条 / 14 天 / 50MB，豁免活动与最近一次 | 否 | 已完成 |

> **总工期修正**：约 **8.3 人日**（Q15 已完成不计；新增约 1.3d：Job Object 0.5d + 清理 0.3d + `--clean` 确认 0.2d + 进度条 UI 0.3d）。

---

## 15. 实施进度（P1 已完成）

### 15.1 已落地的代码（`packages/dsh-elab-cockpit/`）

| 模块 | 行数 | 职责 |
|---|---:|---|
| `src/host/discovery.ts` | 356 | 工程发现扫描核心（纯函数，fs 可注入） |
| `src/host/discover-route.ts` | 349 | `/elab/api/discover` 路由 + 缓存 + `${ELAB_ROOT}` 求值 |
| `src/host/host-process.ts` | ~250 | cockpit 进程托管（`-u`/UTF-8/`--port 0`/就绪探活/空闲回收） |
| `src/host/job-object.ts` | ~200 | Windows Job Object 垫片（全树终结 + taskkill 降级） |
| `src/host/run-retention.ts` | ~190 | runs 自动清理（三规则并集 + 豁免 + 干跑） |
| `src/host/routes.ts` | ~260 | `/elab/api/*` 白名单代理 + `/elab/events` SSE 透传 + actor 注入 |
| `src/host/index.ts` | ~180 | 主装配：lazy 启停 + 定时清理 + disposer |
| `src/index.ts` | ~110 | cordis 入口（`name` / `inject` / `Config` / `apply`） |
| **测试** | 4 个文件 | **42 个用例全绿** |

### 15.2 端到端验证结果（2026-10-26）

| 验证项 | 结果 |
|---|---|
| fence 拒绝 | 403 ✅ |
| 白名单外端点 | 404 ✅ / 方法不允许 405 + `Allow` ✅ |
| 首次拉起 cockpit | 1410 ms，`job: "armed"` ✅ |
| `/elab/api/projects` | 200，5 个工程 ✅ |
| `POST /elab/api/run` | 202，`actor: "human"`（注入正确）✅ |
| `/elab/events` SSE | 200，收到 5 个 event 帧且**每帧带 `id:`**（续传游标保留）✅ |
| dispose 后进程树 | cockpit 与其子进程**同时消失**（Job Object 生效）✅ |
| 插件单测 | **42/42** ✅ |
| Python 回归 | **209/209** ✅ |

### 15.3 实施中踩到并修掉的 5 个真问题（都写进了代码注释）

| # | 问题 | 现象 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | **`--port 0` 打印的是请求值 0** | 拿到端口 0，连不上 | `server.py:1337` 打印 `args.port` 而非 `srv.server_address[1]` | **改 Python 一行**：打印实际绑定端口（`--port 8333` 时行为不变） |
| 2 | **横幅先于 `serve_forever()`** | 解析到端口仍 `ECONNREFUSED` | 打印在 `serve_forever()` 之前，accept 循环未启动 | 增加**就绪探活**（轮询 `/api/capabilities`），不让调用方撞运气 |
| 3 | **Job 垫片退出即杀树** | cockpit 刚 armed 就 `exit 0`，服务永远不可达 | 垫片持 Job 句柄，它退出 → 句柄回收 → `KILL_ON_JOB_CLOSE` 立即生效 | 垫片**长期存活**，阻塞 `ReadLine`，只在 `kill()` 时收到 `KILL` 才退出 |
| 4 | **`LISTEN_RE` 正则写错** | 抓到错误端口 | `https?:\/\/[^:]+:(\d+)` 中 `[^:]+` 被 `http:` 的冒号截断 | **改用纯字符串解析**（`parsePortFromBanner`），彻底规避转义问题 |
| 5 | **编辑链路的反斜杠折叠** | `/\s+/` 落盘成 `/s+/`、`\\` 落盘成 `\` | 工具层对转义序列的处理不稳定 | 关键正则改为**无转义写法**（`String.fromCharCode` / 纯字符串操作） |

> 第 1 项是 `cockpit/server.py` 的**第二处** Python 改动（第一处是 `builder.py` 的流式构建）。
> 两处都只修正事实错误、不改变既有语义，且 Python 209 个测试保持全绿。

### 15.4 P0 结论：iframe 方案**被官方规则否决**（重大修正）

> **2026-10-26 实测 + 官方文档确认。这推翻了原方案 §8.0.3「探针保留为大屏模式」的设想。**

`references/practices.md` 第 33 行明确规定：

> Do not serve an HTML page from the Host and embed it in an iframe: an iframe
> document does not receive the host's theme tokens, light/dark switching, or `ctx.locale`.

这与用户需求（**插件 UI 必须跟随 DSH 主题**，§5.5 路径一）**原理性冲突**：

| 方案 | 主题跟随 | 结论 |
|---|---|---|
| iframe 嵌入 cockpit 页面 | ❌ 拿不到 `--dsw-alias-*`、深浅色、locale | **否决** |
| 宿主 React 树内渲染 | ✅ 原生令牌 | **采用** |

**处置**：`packages/dsh-elab-iframe/` 已从 profile 卸载（包体保留在仓库里作为历史记录，
其 Host 半代码可复用于"独立窗口"跳转，但**不再作为面板形态**）。
宽度测量改为 `dsh-elab-cockpit` 内的一个临时 React 面板（同槽位、同令牌），
测完即删，读数回填 §5.4。

### 15.5 Client 半加载的 5 个真问题（全部实测踩到并修掉）

> 这一段是本次实施最贵的教训：**Client 半不出现时没有任何报错**，只能靠
> `cordis_inspect_query(Slots.listSubTree)` 的 occupant 列表二分定位。

| # | 问题 | 现象 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | **`inject` 指向不存在的包**（★★ 后证伪：inject 名单里无 graph 行的包名只是被静默跳过，并非阻塞；见 §15.5b-2） | 槽位 occupant 永远没有它 | 写了 `@deepseek-ai/dsh-client-ui-slots`，当时误判为“不在 profile 里解析不到”；真正根因见 §15.5b（keyed 槽位缺 `key`） | inject 维持 `[dsh-client-runtime]` 即可 |
| 2 | **缺 `immediately: true`** | 同上 | 该字段决定 Client 半是否随页面启动加载 | 补上 |
| 3 | **工厂被 IIFE 包裹** | 同上 | 写了 `(function(){ ... loader.load(...) })()` 与 `if (loader === undefined) return` 守卫；宿主不认这种形态 | **直接执行** `window.__ModuleLoader__.load({...})` |
| 4 | **`require` 任何 `@deepseek-ai/*`** | 组件抛错时整个槽位空白 | practices.md 明令禁止 | 只用 `require('react')` |
| 5 | **React 单例形状** | `Cannot read properties of undefined (reading 'createElement')` | 宿主 `require('react')` 是 CJS，不一定有 `.default`；打包器的垫片写死 `.default` 就崩 | 垫片改为 `const __d = __r.default ?? __r` |

**另一个实施层问题（已修复并单测）**：`install_bundle` 重新安装时，如果上一次的 fiber 未销毁，
会报 `webserver: duplicate exact route "/elab/api/discover"`。

这不是代码 bug（`apply` 里每个路由只注册一次，已逐行核对），而是 **enable 阶段新旧 fiber 短暂并存**。
后果比"报个错"严重得多：**整行 activate 失败 → 插件从未真正生效 → Client 半也不加载**。

修复：`src/host/route-guard.ts` 的 `registerOnce()` —— 模块级 Set 记录本进程已注册的
`(kind, path)`，重复注册返回 no-op disposer，让先到的 fiber 保有其路由。
6 个用例覆盖：首次注册 / 重复不抛 / 不同 path / 同 path 不同 kind / 宿主已占用时静默让出 / 释放后可重注册。

> **教训**：DSH 的 `application: applied` 不等于"插件在跑"。
> 必须用 `cordis_inspect_query(Slots.listSubTree)` 看 occupant，或 curl 一条路由看状态码，
> 才能确认。这次是靠 `duplicate route` 的报错才意识到插件从来没激活过。

### 15.5b Client 半不加载 —— 根因已定位并修复（2026-10-26）

> **结论先行**：`sidebar.right.pane.tab` 是 **keyed 槽位**，register 的 options 里
> **必须有 `key`**；此前只给了 `id`，宿主抛 `keyed slot "sidebar.right.pane.tab"
> requires options.key`，但该错误走 entry-error 通道被吞——fiber 照样 ACTIVE、
> occupant 永不出现、UI 无致命报错。加 `key: 'dsh-elab-cockpit'` 后立即生效
> （HMR 热装载，无需重启 DSH）。

| 修复内容 | 位置 |
|---|---|
| `register({ name, key: 'dsh-elab-cockpit', id, inject:(sid)=>({sessionId}) }, CockpitPane)` + 同 key 配对注册 `.title` | `scripts/build-client.mjs` 工厂模板 → `lib/client.js` |
| **入口卡**：`ctx.inject(['sidebarRightTabs'], …)` → `sidebarRightTabs.register({ id, kind: 'dsh-elab-cockpit', title, guide: [{ order: 90, title, description, icon }] })`。右栏"开始"页的卡片列表来自这个**服务**，不是 `guide.entry` 槽位（对照 profile 里的 dsh-context）；点击卡片 → `openTab(kind)` → 激活同 key 的 `pane.tab`。缺这层 = 面板注册了也**没有入口可点** | 同上 |
| 注册回调 try/catch + console.error（防再次静默吞错） | 同上 |
| 契约自检升级：模拟宿主的 keyed 校验（缺 `key` 必须失败）、只许 `require('react')`、body+title 双注册断言 | `scripts/verify-client-contract.mjs` |

**验证链（全部实跑）**：esbuild 重建 → 契约自检 PASS → 70/70 用例绿（cwd=仓库根）→
client/host 双 tsc 零输出 → 真机页面（宿主 0.2.1-rc.2）刷新后 `dsh-elab-cockpit`
同时出现在 `sidebar.right.pane.tab` 与 `.title` occupant（19 个 tab）；沙箱渲染
CockpitPane 出完整降级 UI（无 ELAB 根时的"驾驶舱未就绪"文案）。
**入口卡二次验证**：HMR 热装载新 rev 后，`sidebarRightTabs` 注册表 kinds 含
`dsh-elab-cockpit`（与 guide/dsh-context/editor/git/terminal 并列），guideEntries
中本卡形状与官方卡一致（id/order/title/description/icon/kind/providerId）——
四项全绿：pane.tab occupant ✓ / .title occupant ✓ / 入口卡 ✓ / fiber ACTIVE ✓。

### 15.5c 面板「未就绪」链修复（2026-10-26 第二轮）

**现象**：入口卡能点开面板，但显示「未找到 elab 仓库根」——即使会话就停在
合法 elab 仓根（`Desktop\\ELAB\\elab-flow`）。

**实锤证据（旧代码、真实宿主）**：

| 请求（带真实 sessionId） | 结果 |
|---|---|
| `GET /elab/host?sessionId=…` | 200 `elabRoot: null`（旧路由忽略 sessionId，只向上扫 DSH 进程 cwd） |
| `GET /elab/api/discover?sessionId=…` | **500 `cannot get property "sessions" without inject`** —— cordis 内核拒绝：宿主半契约没注入 `sessions` 服务，会话 cwd 解析在真实宿主上从未工作过 |

**修复（四层，全部编译进 `lib/`）**：

| 层 | 修复 |
|---|---|
| 契约 | `src/index.ts` `inject = ['webServer', 'connection', 'sessions']`（对齐 better-sidebar 宿主半的 `[webServer, sessions, connection, tools]`） |
| Host 路由 | `/elab/host`、`/elab/api/*`、`/elab/events` 全部从 query 取 `sessionId` → `resolveRoot(sessionId)` / `ensureHost(sessionId)`；进程首次启动的仓根由第一个触发请求的会话决定 |
| Client | `elabApi` 全部方法带 `sessionId`（`withSession()` 拼 query）；CockpitPane 各调用点传入；SSE URL 带 `sessionId` |
| 测试 | `routes.test.mjs` 新增 2 条回归：临时 fixture 仓根 + 假 sessions → `/elab/host?sessionId` 必须返回 fixture；api/events 必须把 sessionId 透传给 ensureHost |
| **ctx 代理陷阱（第二轮重启后追补）** | 重启后实测 `/elab/host?sessionId` → 400 空体 = handler 抛错：`ctx.workingDirectory?.get(...)` 直接读未 inject 的服务属性，cordis 代理抛 `cannot get property … without inject`，webserver 派发层兜底 400。修复：两个 cwd 解析器改走 `ctx.get('sessions'/'workingDirectory')`（better-sidebar 同款，服务缺席返回 undefined）；测试桩同步改为 `get` 供服务 |
| **底部入口（二次修正）** | 首版误用 `shell.bottom`（全宽窄条，占窗口高度且不在用户指定位置），已撤。改注册 **dsh-better-sidebar 的 `betterSidebar.registerTab({ id: 'elab-cockpit', bottomOnly: true, single: true, order: 60, component })`**：只出现在折叠底部面板的「+」菜单（终端同款形态），component 收 `{ scope, visible }`、`scope.sessionId` 接 CockpitPane。要点：① 服务名 `betterSidebar`（`ctx.provide`）；② `bottomOnly: true` 才不会重复注册进原生右栏（`sync()` 会跳过 bottomOnly）；③ 菜单列表 = `getTabs()` 过滤 `!hidden && isTabEnabled(id)`（未知 id 默认启用）按 `order ?? 100` 排序；④ descriptor.icon 是 `(size) => element`。真机验证：`getTabs()` 含 elab-cockpit、`shell.bottom` 只剩 DSH 自家 inspector |

**校验链**：72/72 用例绿（新增 2 条）→ 双 tsc 零输出 → esbuild 重建
（52973 chars）→ 宿主半 `tsc -p tsconfig.host.json --outDir lib` 重编（`lib/host/*.js`
含 sessionId 提取、`lib/index.js` 契约含 sessions）→ 契约自检 PASS。
**生效条件：重启 DSH**（Node 侧插件不热载；浏览器半 HMR 可热载但宿主半不行）。
**教训**：宿主半不能只靠单测假 ctx —— 真实 cordis ctx 是代理，未 inject 的
服务属性访问即抛；必须在真实宿主上打一条路由验证（本节两次都是真机才暴露）。

★ 宿主与侧边栏增强（better-sidebar）双入口并存：右栏 pane.tab（原生）+
底部工作台 tab（bottomOnly）都会挂 CockpitPane，两者同时可见时会开两条 SSE
（上游 MAX_SSE_CONNS 有上限）——后续 P4 可做互斥或单实例协调。

### 15.5b-1 排查方法论（比结论更值钱）

1. **app.asar 是普通文件**，Node 按 asar 头（u32 headerSize + JSON 目录）即可
   离线解析；宿主 client 扫描器 = `@deepseek-ai/dsh-client-modules/lib/{client,index}.js`。
   （旧结论"只能用宿主进程读"不成立。）
2. **页面里 `globalThis.__dshSidebarModuleSystem__` 就是活的 ClientModuleSystem**
   （better-sidebar 调试钩子）：graphRows / factories / loadCache / importErrors /
   entries.managed(fiber.state) / slots._core.records 全部可查。
3. **webserver 认证**：launch token 拿不到，但 `.credentials.yaml` 的
   `client-connection/browser-session` secret 可以按宿主同款算法伪造 v1 cookie
   （`dsh-auth-<sha256(authority)>` = `v1.<b64url(payload)>.<hmac>`），HTTP 全通。
4. **occupant 二分**：`slots._core.records.get('<slot>').entries[].options.key`。

### 15.5b-2 已证伪的假设（不要再试）

| 假设 | 证伪证据 |
|---|---|
| `dsh.client.inject` 缺 `@deepseek-ai/dsh-client-ui-slots` 导致不加载 | 实取 `window.__DSH_BOOT__`（86 entries）：**`dsh-client-runtime`、`dsh-client-ui-slots` 都没有 graph 行**；inject 名单里无行的包名在浏览器侧被静默跳过（`arriveGraphRow` 的 `if (dependency !== void 0)`）。dsh-m 声明 ui-slots 照样解析不到，但 dsh-m 能加载。ui-slots/ui-primitives 是**平台 seed**（`__dshSidebarModuleSystem__.seed` 可见），不需要 inject。 |
| §15.5 问题 1 的旧诊断"ui-slots 不在 profile 里所以宿主解析不到就跳过整个 Client 半" | `dsh-client-runtime` 同样不在 profile，wallpaper-engine 只声明它照样加载；当时真正卡住的是后面几个问题顺序掩蔽 |
| "宿主读取 app.asar 需要宿主自身进程" | asar 公开格式，离线可解析（见 15.5b-1） |

### 15.6 P1/P3 已落地代码

| 模块 | 行数 | 职责 | 状态 |
|---|---:|---|---|
| `src/host/discovery.ts` | 356 | 工程发现扫描（纯函数） | ✅ 11 用例 |
| `src/host/discover-route.ts` | 349 | `/elab/api/discover` + 缓存 + 变量求值 | ✅ 10 用例 |
| `src/host/host-process.ts` | ~260 | 进程托管（`-u`/UTF-8/`--port 0`/探活/空闲回收） | ✅ E2E |
| `src/host/job-object.ts` | ~210 | Windows Job Object 全树终结 + 降级 | ✅ E2E |
| `src/host/run-retention.ts` | 209 | runs 清理（三规则并集 + 豁免） | ✅ 12 用例 |
| `src/host/routes.ts` | 250 | 白名单代理 + SSE 透传 + actor 注入 | ✅ 9 用例 |
| `src/host/plans.ts` | ~110 | 三档一键流解析（Host 侧） | ✅ 与 Client 同构 |
| `src/client/model/plans.ts` | ~180 | 三档一键流（Client 侧）+ 进度折叠 | ✅ 22 对照用例 |
| `src/client/StageLadder.tsx` | ~250 | 阶梯：六态 + 单步 ▶ + 失败灰底 | ✅ 编译通过 |
| `src/client/ManualBar.tsx` | ~240 | 三档 + 取消 + 预览 + `--clean` 行内确认 | ✅ 编译通过 |
| `src/client/EvidenceTail.tsx` | ~330 | 通道切换 + 进度条 + 失败告警条 + 串口输入 | ✅ 编译通过 |
| `src/client/CockpitPane.tsx` | ~600 | 容器：SSE 接线 + 可见性驱动 + 状态归约 | ✅ 编译通过 |
| **测试合计** | — | **64 个用例全绿** | ✅ |

### 15.6b P4 融合落地（2026-10-26）

| 块 | 内容 | 验证 |
|---|---|---|
| **主题令牌层（§5.5）** | `theme/dsw-map.ts`：唯一允许 `--dsw-*`/`--dsh-*` 的文件（§5.5.4 规则 2），注入 `<style data-plugin>`；组件全部改读 `--elab-*` 别名；ANSI 双主题色板自旧 tokens.css 原样迁移，由 `html[data-elab-scheme]` 切换（唯一主题订阅点：`ctx.inject(['theme'])` + `theme/change`） | 真机：样式注入 3399B、scheme=dark、`--elab-accent/--elab-ansi-red/--elab-font-mono` 全部解析出值 |
| **硬规则门禁** | `test/style-rules.test.mjs` ×3：无字面色值（ANSI 仅限 dsw-map.ts）/ 宿主令牌不外逸 / `--elab-*` 引用必须有定义 | 76/76 用例绿 |
| **宽度三档（§5.4）** | CockpitPane `usePaneWidth`（ResizeObserver）+ `tier`（420/700 初值，待 P0 校准）：narrow 单列；mid 单列 + 阶梯 detail 全宽；wide 双栏（左 40% 阶梯+控制条 / 右 60% 日志尾）；StageLadder 接 `density` | 契约自检 + tsc；真机目视待用户会话 |
| **设置页** | `settings.section` 列槽（id/order/label，导航行已实测出现在设置 → ELAB 驾驶舱）；`SettingsSection`（elabRoot / pythonPath / 空闲回收 / 发现深度+上限）；宿主 `GET/POST /elab/config`（白名单+范围校验+热更新+持久化 `~/.dsh/dsh-elab-cockpit.config.json`，启动叠加在行配置之上） | 注册+组件挂载真机实测；路由 404→待重启；单测覆盖 200/400/夹取/落盘 |
| **ANSI 渲染修复** | 旧 parseAnsi 把色变推成空 span（颜色全丢）；改状态机实现；EvidenceTail 接 `parseAnsi` 渲染真彩日志（服务端不剥 ANSI，此前会显示 `[0m` 乱码）；等宽字体走 `--dsh-font-family-code-default` |
| **主按钮对比度** | 用户实测：绿色主题下 `--dsw-alias-brand-primary` 偏深，主按钮（accent 当填充）变黑块。改用宿主按钮专用令牌对：`--elab-btn-primary-bg: var(--dsw-alias-button-primary-fill)` + `--elab-btn-primary-fg: var(--dsw-alias-brand-primary-invert)`（宿主保证对比度）；ManualBar 主档与设置页保存键已换 |
| **elab-flow 检出镜像补丁** | 用户会话仓库根是旧检出 `Desktop\\ELAB\\elab-flow`，其 `cockpit/server.py` 仍是「打印请求端口 0」的旧版 → 宿主等端口 15s 超时（§15.3 问题 1 在另一检出复现）。已把同款 `bound_port` 修复镜像过去（py_compile 通过）；教训：**宿主半的 Python 侧修复必须覆盖所有可能成为 elabRoot 的检出**，P5 工具化时考虑在 spawn 前自检横幅版本 | 单测与构建；浅/深目视待用户会话 |

**P4 备注**：① 宿主无字号令牌（其自身 CSS 也用 px）→ 字号保留 px、字体走 `--elab-font-mono`（§5.5「三个 font role」前提不成立，实测修正）；② `dsw-map.css` 落为 `dsw-map.ts`（client 无 CSS 管线，注入式，单一文件意图不变）；③ 右栏 pane.tab 与底部工作台双入口并存，同时可见会开两条 SSE（P5 再做单实例协调）；④ **设置页与 /elab/config 需重启 DSH 生效**（宿主半），client 部分 HMR 已热载。

| **elab-flow 检出镜像补丁** | 用户会话仓库根是旧检出 `Desktop\\ELAB\\elab-flow`，其 `cockpit/server.py` 仍是「打印请求端口 0」的旧版 → 宿主等端口 15s 超时（§15.3 问题 1 在另一检出复现）。已把同款 `bound_port` 修复镜像过去（py_compile 通过）；教训：**宿主半的 Python 侧修复必须覆盖所有可能成为 elabRoot 的检出**，P5 工具化时考虑在 spawn 前自检横幅版本 |

### 15.6c P5 工具化落地（2026-10-26）

| 块 | 内容 |
|---|---|
| **RunArbiter（§6.2）** | `host/run-arbiter.ts`：同一 rootKey 同时最多 1 个 run（Python RunManager.spawn 不查重，实测实读）；agent 请求撞人工 run → `human-busy` + nextAction（不静默排队）；惰性活性回收（下次 acquire 查 `/api/runs` 活动列表，不解析 SSE）；串行化链防双飞。7 条单测 |
| **工具门（面板路径）** | `routes.ts` POST /elab/api/run：actor 注入后先过仲裁，409 返回结构化 `{ error.code, holder, nextAction }`；成功回填 run id，上游失败撤销占用 |
| **8 个工具** | `host/tools.ts`：`elab_status` / `elab_build`(plan basic) / `elab_triple`(triple) / `elab_loop`(loop) / `elab_cancel` / `elab_serial`(写硬件) / `elab_adapt`(写盘) / `elab_log`(尾部 N 行)。人机共用 `resolveRunSteps`；defineTool 来自 `@deepseek-ai/dsh-tools@0.2.1-rc.2`（与内核同版本，已入包依赖）；`allowAgentWrite`（默认 false）门控串口/写盘 |
| **接线** | 契约 inject += `tools`；`autoExposeTools`（默认 true）门控注册；控制器暴露 `ensureHost` 给仲裁活性检查 |

**P5 备注**：① 工具 rootKey 固定 `'tool'`（agent 侧不分会话，保守串行）；② 串口互斥目前透传服务端 409（预判拦截留 P5 后续）；③ 需重启 DSH 生效（宿主半）。

### 15.7 失败即中断（用户确认的硬要求）

源码核实：`services/elab/run.py:528` `if not keep_going: break` ——
任一步失败立即跳出循环，后续步骤**不执行**（`keep_going` 仅 `elab ci` 使用）。

插件侧对应实现：

| 环节 | 行为 |
|---|---|
| 阶梯 | 失败步标 `✗` 红色；**未执行到的步骤显示灰底 `skipped`**（Q21 选 B） |
| 日志尾 | 失败通道自动聚焦；末尾插入 `✗ 步骤失败：<detail>` 行 |
| 告警条 | 常驻一条 `✗ 失败 <step>：<detail>`，可点击跳到日志末尾 |
| 状态 | `run/end.ok=false` → 顶部状态徽标转 `failed`；不自动重试、不跳过继续 |
| API 层 | 不提供任何"忽略错误继续"参数（`keep_going` 不对插件暴露） |

### 15.8 下一步

| 里程碑 | 状态 |
|---|---|
| P0 宽度实测 | 代码就绪，client 半已激活（§15.5b），**待真实会话内读数**（§5.4 阈值仍待校准） |
| **P1 Host 骨架** | ✅ **完成** |
| P2 事件通道 | ✅ **完成**（可见性驱动 + 续传验证：合帧语义下 63/63 精确一致） |
| P3 阶梯+日志尾 | ✅ **代码完成**（70 用例 + 编译通过）；装载已验证：occupant 在列、CockpitPane 沙箱渲染通过（§15.5b），待真实会话目视 |
| P4 融合（设置页/主题核对/大屏入口） | ✅ **完成**（大屏入口已被 §15.4 否决剔除）：设置页 + 主题令牌层 + 宽度三档，见 §15.6b |
| P5 工具化与并存（`elab_*` 工具 + RunArbiter） | ✅ **代码完成**（§15.6c：8 工具 + 仲裁 + 面板门），待重启后真会话验证 |
| **P0 宽度实测** | 档位机制已实装（§15.6b）；待真实会话读数回填 §5.4 阈值 |

---

## 16 分层解耦设计（2026-10-26，回应「工具与业务离得太近」）

### 16.1 定位重申

> **插件 = 开发工具整合器**：给 agent 一个 CLI/工具面调闭环，给开发者一个可视化面板。
> **业务 = elab 内核**（services/elab + cockpit/server.py + projects/）：闭环怎么做、步骤叫什么、档位怎么分 —— 全是业务的事。

### 16.2 耦合现状清单（诚实盘点）

| 耦合点 | 现状 | 应属层 |
|---|---|---|
| 步骤标签（编译/烧录…） | 硬编码在插件 channels.ts / StageLadder.stepLabelOf | 内核（STEP_META） |
| 三档定义（basic/triple/loop） | 硬编码在插件 host/plans.ts + client/plans.ts | 内核（KERNEL_PLANS） |
| 通道划分（build/flash/debug/serial） | 硬编码在插件 channels.ts | 内核（meta.channels） |
| plans 解析 / 事件归约 / ICD 契约 | 插件只讲 ICD，不 import 业务代码 | **本来就在正确的层** |
| 进程托管 / 代理 / 仲裁 / 工具 | 通用壳 + elab 语义的工具描述 | 工具层（定位本身） |
| 内核版本无握手 | 旧检出（2.0.0）打爆新工具（今天两次） | 需要握手 + 降级 |

### 16.3 边界与唯一缝隙

```
DSH 插件（通用壳）  ←—— 唯一缝隙：loopback HTTP ICD + capabilities 自描述 ——→  elab 业务内核
   工具面：elab_* 工具 / CLI（elab.cmd）                         自描述：meta（标签/通道/档位）+ 版本
```

**Agent 调闭环的两条等价路**：CLI（`elab.cmd`，业务仓自带）与 `elab_*` 工具（同一 HTTP 面）——插件只是把内核「装进 DSH」并让两者可见，不再是业务语义的归属地。

### 16.4 已落地（本轮）

1. **内核自描述**：capabilities.meta = STEP_META（标签/通道）/ KERNEL_PLANS（档位）——业务词汇的唯一事实源回到内核；两个检出（dsh-elab-flow 2.1.0 / elab-flow 2.0.0）均已携带。
2. **版本握手 + 降级**：宿主就绪探针捕获 `cockpit.version` 与 meta 有无；面板在 meta 缺失时显示降级提示（标签/档位退回插件内置默认，不阻塞）。
3. **内核过旧从「事故」变「提示」**：旧检出不再把工具打爆（镜像补丁类问题就此终结）。

### 16.5 三步走

| 步 | 内容 | 状态 |
|---|---|---|
| ① | 内核自描述 meta + 版本握手 + 面板降级提示 | ✅ 本轮 |
| ② | 插件消费 meta（标签/档位标题/宿主档位定义已接；**Agent 边界规则**入仓 AGENTS.md；分层门禁 test/boundary.test.mjs ×2）| ✅ 二轮（剩余：通道标签、client 步骤集全量消费——内核档位变更时以宿主解析为准） |
| ③ | 插件出仓：发 npm（dsh-market 安装），与业务仓彻底解耦；多内核版本兼容矩阵 | 待做 |
