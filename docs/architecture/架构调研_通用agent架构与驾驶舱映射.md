# 驾驶舱通用架构调研与分析
## —— 把 DSH 开发工具插件映射到「领域/应用/适配器」通用 agent 架构

> 版本 v1（调研定稿） · 2026-10-29 · 仓库 `dsh-elab-flow`（插件 c624321…3f76ae3 之后）
> 定位输入（用户原话）：一套 DSH 插件**下载即用**的通用型开发工具插件；**脱离芯片依赖、跨平台跨芯片**；**开发流程插件化**；agent 闭环 + CLI 流程可视化；**插件仅仅是开发工具框架，不接触项目开发的业务代码**；初次在项目代码中打开会话后**一键适配工程**；之后新建会话**自动识别并适配**。
> 交付物：本文（技术架构调研与分析）。

---

## 0. TL;DR

1. **参考架构（截图）的本质**是六边形架构（端口-适配器）+ 组装根：纯域模型不碰 I/O，用例只依赖端口，一切 I/O 是适配器，`main` 负责组装。它对 agent 框架特别合适，因为 agent 的可变性恰好都在边缘：模型供应商、存储、传输、工具集。
2. **关键发现：你的内核（services/elab）已经按这个思路建好了**——YAML 驱动（config.py：「所有参数都来自 YAML，CLI 里没有任何硬编码路径」）、L0–L4 分层适配（serialport 的 L0/L1/L2 就是适配器退化层级）、连 **AI skill 都是从 `chips/*.yaml` + `projects/*.yaml` 生成的**（skillgen.py：「单一数据源」原则贯彻到 AI 接入层）。
3. **真正的差距在插件壳（packages/dsh-elab-cockpit）**：它是后加的第二个应用，还没有继承内核的纪律——业务词汇（步骤标签/档位/通道）一度硬编码（§16 已修一半）、编排逻辑混在 React 组件里、端口以匿名回调形式散落。
4. **结论：不需要"重构成 agent 框架"，需要"把插件拉到内核已经在用的同一套纪律上"**——目录对齐参考架构、端口显式化、编排下沉，全部是低风险的机械迁移，已有门禁测试护航。
5. 「一键适配 / 自动识别」不需要新发明：内核的 `elab adapt --write`（只产出 `projects/<name>.yaml`，业务工程零改动）+ 已实现的会话 cwd → 仓库根 → 工程发现，拼成一条显式的**适配状态机**即可。

---

## 1. 参考架构解读（截图 = 通用 agent 架构）

```
agent/
├─ domain/    领域层：Session / Message / ToolCall / Tool / roles —— 纯概念，零 I/O
├─ app/       应用层：ports（ModelClient / SessionStore 等接口）+ service（AgentService 用例编排）
├─ adapters/  适配层：models/（Anthropic/OpenAI/Google 客户端）、stores/（jsonl 持久化）、
│             api/（web 传输）、tools/（bash 工具）—— 一切可替换的 I/O
└─ main.py    组装根：把具体适配器注入端口，装配出可运行的 agent
```

### 1.1 四条铁律

| 铁律 | 含义 | 为什么 agent 框架天然适合 |
|---|---|---|
| 依赖方向向内 | domain ← app ← adapters ← main；domain 不知道任何 I/O | agent 的核心（会话/消息/工具调用循环）是纯逻辑 |
| 端口在 app 定义 | 接口（ModelClient/SessionStore）属于用例，实现属于边缘 | 换模型/换存储 = 换适配器，域与应用零改动 |
| 组装根唯一 | main 是唯一知道"哪个具体实现被用"的地方 | 可测试性：测试里注入假适配器 |
| 适配器成对 | 每个端口至少有"真实实现 + 测试替身"两个消费者，避免抽象悬空 | **只有一个实现时不要抽接口**（见 §6 风险） |

### 1.2 与经典 Clean Architecture 的差异点（agent 特有）

- `adapters/models` 是 agent 特有的可变边缘（模型供应商），对应驾驶舱里的可变边缘是**内核进程**与**芯片工具链**；
- `skills/知识` 在参考架构外——但在 elab 里已经有生成式方案（skillgen），映射时作为"知识端口"补入。

---

## 2. 现状盘点：两个代码库逐文件映射

### 2.1 插件侧（packages/dsh-elab-cockpit/src，31 文件 / 5,592 行）

| 参考架构位置 | 现有代码（行数） | 判定 |
|---|---|---|
| **main 组装根** | `index.ts`（294）——apply() 是唯一组装点：discover/arbiter/serialMutex/tools/configRoute 全部在此接线 | ✅ 已是组装根（策略与接线混在函数里，需下沉） |
| **domain** | `client/model/plans.ts`（158）`channels.ts`（68）`kernel-meta.ts`（45）+ `client/store/runStore.ts` 的 reduce（231 中的纯归约部分）+ `host/plans.ts`（79）+ `host/run-arbiter.ts`（86，纯规则）+ ICD 类型（api/types.ts 410 中的事件契约段） | ✅ 基本全是纯类型/纯函数（plans-parity 等测试钉住），**但没有 domain 目录**，散在 model/store |
| **app/ports** | 隐式存在：`ProxyDeps`、`ToolsDeps`、`HostController`、`RunArbiter` 的 isRunActive 回调、`SerialMutexTracker`——都是端口，但以参数对象/回调形式散落 | ⚠️ 有实无名 |
| **app/service（编排）** | 宿主侧分散在 index.ts + routes.ts；**客户端编排混在 CockpitPane（656 行）的 useEffect 里**（发现→适配→发起→订阅的链没有显式服务） | ✗ 最大缺口 |
| **adapters/api（HTTP 面）** | `host/routes.ts`（314，白名单代理+SSE+仲裁门）+ `discover-route.ts`（334） | ✅ 已是适配器 |
| **adapters/models（外部系统）** | `host/host-process.ts`（265）+ `job-object.ts`（192）——**被适配的外部系统就是 elab 内核进程**（参考架构里"模型供应商"的位置） | ✅ 概念对应成立：内核可整体替换 |
| **adapters/stores** | `host/run-retention.ts`（181）+ runs_dir 约定；客户端环形缓冲（非持久） | ⚠️ 无名 |
| **adapters/tools** | `host/tools.ts`（356，8 个 defineTool） | ✅ 已是适配器 |
| **adapters/ui（DSH slots）** | `client/CockpitPane.tsx` + StageLadder/EvidenceTail/ManualBar/SettingsSection + theme/dsw-map.ts | ✅ 已是适配器（slots 由宿主定形态） |

### 2.2 内核侧（services/elab 6,141 行 + cockpit/server.py 1,044 行）

| 参考架构位置 | 现有代码（行数） | 判定 |
|---|---|---|
| **domain** | `run.py`（428）`plan.py`（231）——步骤/流程/归档模型；`kernel/events.py`（409）事件契约 | ✅ |
| **adapters/models（芯片/工具链）** | `serialport.py`（397，L0 pyserial / L1 ctypes / L2 不可用三级退化）`flash.py`（347，openocd）`builder.py`（455，cmake/ninja）`doctor.py`（479）`monitor.py`（290）`ota_layout.py`（148）`serialterm/serialmon/serialconsole` | ✅ **这就是"跨芯片"的机制本体**：换芯片=换 YAML + 工具链适配器 |
| **app/service（用例编排）** | `ci.py`（98）`run.py` 的编排段 + `__main__.py`（593，CLI） | ✅ 且 CLI 已自述「所有参数都来自 YAML，CLI 里没有任何硬编码路径」 |
| **adapters/知识（生成式）** | `skillgen.py`（192）：AI skill **从 chips/*.yaml + projects/*.yaml 渲染**，按平台聚合（`skills/<vendor>/<platform>/SKILL.md`） | ✅ 单一数据源贯彻到 AI 接入层——多数 agent 项目做不到 |
| **adapters/api（HTTP 面）** | `cockpit/server.py`（1044）：路由 + capabilities + plan 预览 + SSE | ⚠️ HTTP 面与部分业务内联（capabilities/_plan_preview 定义在 server.py 内） |
| **stores** | runs_dir jsonl（kernel/events.py 的持久化段） | ✅ |
| **config（ports 的数据形态）** | `config.py`（240）：L0 主机 / L1 芯片 / L4 工程 YAML 树 | ✅ 声明式配置即端口参数 |

### 2.3 唯一缝隙（ICD）现状

| 能力 | 状态 |
|---|---|
| 运行时通信 | ✅ loopback HTTP + SSE（字节级透传，事件契约 vN） |
| 内核自描述 | ✅ §16 已落地：capabilities.meta（STEP_META 标签/通道 + KERNEL_PLANS 档位）+ cockpit.version |
| 版本握手 | ✅ 宿主就绪探针捕获 + 面板降级提示 |
| 生成 skill 的发现 | ✗ 内核生成到 `<root>/skills/<vendor>/<platform>/SKILL.md`，DSH 发现路径是 `<project>/.agents/skills` / `.dsh/skills` —— **生成物与发现路径错位**（§5 批 3 修） |
| 适配状态机 | ✗ 零件齐全（cwd→root→discover→adapt API），没有显式状态机与 UI 呈现 |

---

## 3. 定位逐条 → 架构机制映射

| 你的定位（原话） | 架构机制 | 现状 |
|---|---|---|
| 一套 DSH 插件**下载即用**的通用开发工具插件 | 插件不含业务词汇（meta 自描述）+ npm 出仓 + 内核版本握手 | ①③ 部分完成，出仓待做 |
| **脱离芯片依赖、跨平台跨芯片** | 芯片语义全部在**内核适配器**（openocd/pyserial/cmake + chips/*.yaml）；插件只讲 Step/Run/Channel/Event 通用域模型——跨芯片 = 换 YAML/适配器，**插件零改动** | ✅ 内核已达成；插件侧需把残留的芯片词汇清干净（标签已走 meta ✓） |
| **开发流程插件化** | 流程 = 声明式对象（KERNEL_PLANS 已是雏形）→ 下一步把"流程"升级为内核的 flow manifest（声明式步骤序列 + 可选钩子），插件按 manifest 渲染 | ⚠️ 雏形 |
| agent 闭环 + **CLI 流程可视化** | 三个等价触发面（面板按钮 / elab_* 工具 / CLI）共用同一内核服务；可视化唯一数据源 = 事件流（已实现字节级透传 + 归约） | ✅ |
| **插件不接触业务代码** | 端口化依赖规则 + boundary 门禁（已有 ×2）+ AGENTS.md（已有）+ §16.5 步 ③ | ⚠️ 机制已立，词汇未清完 |
| 初次打开会话**一键适配** | 会话 cwd → 仓库根 → 发现（已实现）→ `elab adapt --write`（内核已有，只产出 projects/<name>.yaml）→ 适配态 | ⚠️ 零件齐，缺状态机 |
| 新建会话**自动识别** | resolveSessionCwd + findElabRoot + capabilities.root 比对（已实现）→ 命中工程即绑定 | ⚠️ 同上 |

---

## 4. 目标架构提案

### 4.1 插件侧（TS）目标分层——只动目录与名字，不改行为

```
packages/dsh-elab-cockpit/src/
├─ main.ts                       组装根（现 index.ts）：读配置 → new 适配器 → 注入 service
├─ domain/                       纯：零 I/O、零宿主类型
│   ├─ run.ts                    Run/Step/State + 归约（自 store/runStore.ts 的纯段）
│   ├─ pipeline.ts               Plan/PlanDef + resolveRunSteps（自 host/plans.ts，与 client/model/plans.ts 对齐）
│   ├─ events.ts                 ICD 事件类型（自 api/types.ts 契约段）
│   ├─ arbiter.ts                run-arbiter.ts（纯规则，已是）
│   └─ kernel-meta.ts            内核自描述消费（已是）
├─ app/
│   ├─ ports.ts                  KernelPort / HostProcessPort / ToolPort / UiPort / StorePort（现 ProxyDeps/ToolsDeps 收敛）
│   └─ cockpit-service.ts        编排服务：发现→适配→发起→订阅→回收（自 index.ts + CockpitPane 的 useEffect 链下沉）
└─ adapters/
    ├─ kernel-http/              ICD HTTP 客户端 + SSE + 白名单路由（自 routes.ts + client/api）
    ├─ kernel-process/           spawn/health/job-object（自 host-process.ts + job-object.ts）
    ├─ dsh-web/                  slots UI（现 client/*：CockpitPane/StageLadder/…）
    ├─ dsh-tools/                门面工具（domain/tools.ts 定契约 + adapters/*-ops.ts 实现）
    └─ fs-store/                 run-retention + runs_dir 约定
```

### 4.2 内核侧（Python）——只微调，不重构

内核已经达标 90%：YAML 驱动 + L 级适配器 + 生成式 skill。仅两处收敛：
- `cockpit/server.py` 的 capabilities / _plan_preview 等业务段下沉到 `services/elab/`（server.py 收敛为纯 HTTP 面，目标 ≤ 400 行）；
- ~~flow manifest 正式化~~ ✅ **已落地（2026-11-06）**：STEP_META / KERNEL_PLANS 已挪到 `services/elab/flow.py`，server.py 引用之（回归测试 `tests/test_flow_manifest.py`）。

### 4.3 总图

```
        ┌──────────────────────── DSH 宿主（agent 框架）────────────────────────┐
        │  slots(UI)   tools(工具面)   skills(知识)   sessions/cwd(上下文)      │
        └──────────▲──────────────────▲──────────────────▲───────────────────┘
                   │                  │                  │
        ┌──────────┴──────────────────┴──────────────────▼───────────────────┐
        │ 插件（开发工具整合器，TS）—— 本文档的目标分层                       │
        │ main ← app(CockpitService + ports) ← domain(Run/Step/Plan/Event)   │
        │            │                                                       │
        │   adapters: kernel-http ── kernel-process ── dsh-web ── dsh-tools  │
        └──────────────────────────┬─────────────────────────────────────────┘
                                   │ loopback HTTP ICD（唯一缝隙，含自描述 meta + 版本握手）
        ┌──────────────────────────▼─────────────────────────────────────────┐
        │ elab 内核（Python，业务）—— 已按同套纪律存在                        │
        │ __main__(CLI) ← app(ci/run 编排) ← domain(run/plan/flow)            │
        │      adapters: serialport(L0-L2) / flash(openocd) / builder(ninja) │
        │                skillgen(生成式 AI 接入) / config(L0-L4 YAML)        │
        └────────────────────────────────────────────────────────────────────┘
```

### 4.4 依赖规则（可进 CI 的 6 条）

1. `domain/` 不得 import `adapters/`、`app/`、`node:` 之外的宿主模块；
2. `app/` 只能 import `domain/` 与 `ports.ts`；
3. `adapters/` 不得相互 import（只经 main 组装）；
4. `src/**` 禁止出现 `services/elab`、业务仓路径（已有 boundary.test.mjs）；
5. ICD 契约：client 与 host 的 plans/events 同构由 parity 测试钉住（已有 plans-parity，推广到 meta/events）；
6. 内核侧对称规则：`server.py` 不得新增业务函数（新增必须进 services/elab）。

---

## 5. 差距与迁移路径（四批，每批独立可交付）

| 批 | 内容 | 风险 | 规模 |
|---|---|---|---|
| **批 1 目录重组** | src → main/domain/app/adapters（纯移动+重命名，零行为变化）；门禁测试升级为依赖方向规则（§4.4 全部 6 条）；lib/ 构建路径同步 | 低（机械移动，测试护航） | 0.5d |
| **批 2 端口显式化 + 编排下沉** | ports.ts 收敛现有回调端口；CockpitPane 的发现/适配/发起链下沉 `app/cockpit-service.ts`，面板只剩渲染；/elab/config 等保持不变 | 中（要小心 React 副作用搬迁） | 1d |
| **批 3 适配状态机 + skill 桥** | app 层显式状态机：`unbound → discovered(未适配工程 N 个) → adapting(一键适配) → bound(工程绑定)`；UI 呈现；内核 skillgen 增发生成物到 `<root>/.agents/skills/<platform>/`（或插件挂载时映射 `<root>/skills`）→ DSH agent 自动获得平台 skill | 中（跨 TS/Python，但两端零件都在） | 1d |
| **批 4 出仓与矩阵** | 插件发 npm（dsh-market）；内核版本兼容矩阵（meta/flow 特性检测，机制已有）；多内核并存（多会话多 rootKey） | 中高（发布流程 + 版本策略） | 1–2d |

> 批 1 完成后，参考架构的**形**就位；批 2 完成后，**实**（依赖方向）就位；批 3 对应你定位里"一键适配/自动识别"的产品闭环；批 4 是"下载即用"的分发形态。

---

## 6. 风险与权衡

| 风险 | 判断 | 对策 |
|---|---|---|
| 过度抽象（为抽接口而抽接口） | 真实存在：KernelPort 当前只有一个实现 | 只做"**命名即架构**"（adapter 目录 + 端口类型），不引入 DI 框架；第二个内核实现出现前不造工厂 |
| DSH 宿主约束 | slots/tools/skills 的形态由宿主定，插件改不了 | `adapters/dsh-*` 层吸收宿主特殊性；domain/app 保持纯净 |
| 双栈域模型重复（TS/Python 各一份 Step/Plan） | 重复是 ICD 的代价 | 契约测试钉住（plans-parity 已有，推广到 meta/events——批 1 顺带） |
| 迁移期与 HMR/门禁冲突 | 移动文件会改 rev 与测试路径 | 批 1 一次性完成 + 全量测试跑绿再提交 |
| 内核 2.0/2.1 兼容矩阵 | 特性检测已立（meta 缺失→降级提示） | 新特性一律走 capabilities 特性检测，不做版本号硬比较 |
| skillgen 生成物路径变更影响面 | 只加不改（新增 .agents/skills 镜像） | 保留原 `skills/` 输出，双写过渡 |

---

## 7. 结论与建议的下一动作

1. **方向判断**：参考架构与本项目高度同构——内核已按它的纪律存在，插件是欠账的一方；不需要引入新框架，需要把插件"拉齐 + 摆正"。
2. **第一动作**：批 1 目录重组（纯机械、测试护航、半天量级）——完成后"工具层/业务层"的分层从文档约束升级为目录事实。
3. **第二动作**：批 2 编排下沉——这是"agent 很容易把业务写进工具"的根治点：业务流程的编排只能发生在 `app/cockpit-service.ts`，UI 与工具都是薄适配器。
4. **第三动作**：批 3 适配状态机——把"一键适配/自动识别"做成看得见的产品闭环（内核与插件两侧零件已齐）。
5. **不做的事**：不引入 DI 容器、不抽多内核接口（单实现）、不改 DSH 宿主、不动 elab 内核的行为语义（kernel 零改动是适配器存在的意义）。

---

## 附 A：证据清单（本文引用的事实）

| 事实 | 出处 |
|---|---|
| 内核 YAML 驱动、CLI 无硬编码路径 | `services/elab/__main__.py` 模块 docstring |
| skill 由 chips/projects 生成、按平台聚合 | `services/elab/skillgen.py:1-16, 231`（`cfg.root/skills/<vendor>/<platform>/SKILL.md`） |
| 适配只产出 projects/<name>.yaml，业务工程零改动 | `services/elab/adapt.py:5, 17` |
| L0/L1/L2 串口适配退化层级 | `services/elab/serialport.py` + `capabilities()` 的 layer 字段 |
| 事件契约版本化 | `cockpit/server.py` capabilities 的 `schema_version`（EVENT_SCHEMA_VERSION） |
| 插件组装根/端口/适配器盘点 | §2.1（31 文件 / 5,592 行逐文件判定） |
| keyed 槽位 / ctx 代理陷阱 / meta 自描述 | `docs/design/技术方案_dsh-elab-flow插件移植.md` §15.5b/c、§16 |
