# AGENTS.md — elab-Flow 仓库工作规则（给本仓工作的 agent）

本仓库 = **业务层（elab 内核）+ 工具层（DSH 插件）**。分层边界见
`docs/design/技术方案_dsh-elab-flow插件移植.md` §16。

> **Agent 动手前先读** [`.agents/skills/elab-agent/SKILL.md`](.agents/skills/elab-agent/SKILL.md)：
> 能力入口、任务路由，以及「芯片 pack / 工具链 provider / 工程绑定」的接入架构。
> 具体调用查 [`.agents/skills/elab-tools/SKILL.md`](.agents/skills/elab-tools/SKILL.md)（CLI / HTTP / `elab_*` 工具索引）。

## 层与归属

| 层 | 路径 | 说明 |
|---|---|---|
| **业务层** | `services/elab/**` | elab 内核：闭环编排、烧录、串口、OTA（改功能/修缺陷写这里） |
| **业务层** | `cockpit/server.py` | 内核 HTTP 面 + **内核自描述**（`STEP_META` / `KERNEL_PLANS`：步骤标签、通道、三档定义的唯一事实源） |
| **业务层** | `projects/**`、`examples/**` | 工程适配与示例 |
| **数据层（适配包）** | `packs/official/**`、`packs/installed/**` | 芯片参数 / 厂商指纹 / 平台坑位 —— **芯片知识的唯一宿主**；骨架仓不内置任何芯片 |
| **数据层（工具链 provider）** | `providers/official/**`、`providers/installed/**` | 声明式 `provider.yaml`（命令模板/env/产物/主机前提），**不是可执行插件**；`providers/installed/` 不入库 |
| **数据层（市场）** | `market/index.json` | 零服务器社区市场索引（包内容留在作者仓库，索引只记 name/version/source/sha256/requires/license） |
| **工具层** | `packages/dsh-elab-cockpit/**` | DSH 插件（开发工具整合器）：面板可视化、进程托管、`elab_*` agent 工具；源码在本仓。市场与 npm 都直接取自该子目录，无额外分发仓 |

## Agent 边界规则（硬）

1. **业务代码只写业务层**：改闭环行为/步骤/档位/串口 → `services/elab/**`；
   改步骤标签、加步骤、调三档定义 → `cockpit/server.py` 的 `STEP_META` / `KERNEL_PLANS`（内核自描述，工具层自动跟随，**不要**去改插件的内置默认——那只是内核过旧时的兑底）。
2. **DSH 插件源码只在本仓** `packages/dsh-elab-cockpit/**`：改面板/工具/进程托管写这里。
   插件市场按子目录安装（`github:xkk6663/elab-flow#path:/packages/dsh-elab-cockpit`），
   npm 也直接从该目录 `npm publish` —— **没有镜像仓 / 分发仓**；插件版本只由
   `package.json`、npm 与 `CHANGELOG.md` 体现，**不再打 `plugin-v*` tag**。业务逻辑
   写进工具层 = 分层违规。
3. **唯一合法缝隙是 loopback HTTP ICD**：工具层与内核之间不 import 源码、不共享文件；
   门禁测试在 `packages/dsh-elab-cockpit/test/boundary.test.mjs` 会拦。
4. 插件内的内核版本探测：`capabilities.meta` 缺失 = 内核过旧（面板会提示同步），不要在工具层为新业务字段写死兼容分支——先把内核同步了。
5. **芯片知识只写适配包**：新增/修改厂商支持（芯片 YAML、`vendor_fingerprints`、
   平台坑位）一律落在 `packs/**`，**不得**写进 `services/elab/**` 或 `cockpit/**`；
   内核只认 `pack.yaml` 协议（`elab.pkg`），不 import 任何包内文件、不为某厂商开分支。
6. **适配包相互独立**：包不得 `import` / 依赖另一个包；跨包共享能力走内核
   `pack.yaml` 协议或市场索引。改包后必须重生成 `market/index.json`
   （`elab pkg index`），CI 用 `elab pkg index --check` 拦漂移。
7. **`packs/installed/` 不入库**：它是用户按需安装的落点（见 `.gitignore`）；
   随仓只提交 `packs/official/**` 与 `market/index.json`。
8. **内置 vs 外置**：`st/stm32` 是内置包（`packs/official/st/stm32`，`elab pkg bootstrap` 安装）；
   其它厂商包（如 `artery/at32`）必须是**外置 GitHub 仓库**，只通过市场索引登记，
   **不得**放进 `packs/official/**`。市场索引仓：`xkk6663/elab-pack-market`；
   外置包示例仓：`xkk6663/elab-pack-artery-at32`。
9. **外置包仓库必须带 `.gitattributes`（`* -text`）**：内容哈希按字节计算，
   换行转换会导致 `sha256` 校验失败。
10. **Provider 与芯片包分离**：工具链命令模板只写 `providers/**`，**不得**塞进
    `packs/**` 或内核；provider 只是数据，内核 `services/elab/provider.py` 负责解析，
    执行器只接受不可变的 `ResolvedToolchain`。`monitor` / `doctor_deep` 永不由
    provider 提供；provider 缺步骤时该步骤直接报错，**不回退**原生链。
    项目可显式 `steps.<step>: tool:<name>` 覆盖，但必须写明。

## 芯片闭环第一关（硬）

接一颗**新芯片**（或换新板）的第一件事**不是**跑业务工程，而是先跑 heartbeat bring-up：

1. **串口心跳给 agent 看**：1Hz `[alive]`，行内必须带可核对的 `tick` / `toggles` / `stage`。
   这是事实源——agent 用串口抓包判定（相邻间隔 ≈1.000s、每次心跳 `toggles` 严格 +2）。
2. **板载 LED 给人看**：与心跳**同一时基**驱动，每 500ms 翻转（亮灭周期 1s）。
   agent 物理上看不到灯，只能读 `toggles`；**「LED 均匀闪烁」必须由用户肉眼确认后回报**，
   agent 不得只凭串口计数单方面宣布通过。
3. **两方都收到信息（agent 拿到心跳 + 人确认灯在闪）才算第一关通过**，之后才接业务外设 / OTA / boot。
4. 主循环**禁止阻塞延时**（`HAL_Delay`、忙等、长 `printf`）；不许占用 SWD / 串口复用脚；
   注意 LED 极性（STM32F103C8T6 的 PC13 是**低电平点亮**）。
5. 板子没有用户 LED 时，用空闲 GPIO + 示波器/逻辑分析仪；判据回落到 `toggles` 递增 + `elab monitor` ok。

依据与实现样例见 [设计约束 C36](docs/design/设计约束.md)、
[01-芯片开发上手 §第一关](docs/tutorials/01-芯片开发上手_独立WebUI.md)。

## 验证

- 插件：`npm test` / `tsc --noEmit`（host + client）/ `npm run build`（cwd = `packages/dsh-elab-cockpit`）；
  CI 见 `.github/workflows/plugin.yml`（唯一的插件门禁工作流）
- 内核：`elab.cmd doctor`（或 `python -m elab doctor`，需 `PYTHONPATH=services`）
- 改 `cockpit/server.py` 后**只维护本仓**（旧的 elab-flow 工作检出已废弃，不再同步）
