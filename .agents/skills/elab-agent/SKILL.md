---
name: elab-agent
description: elab-Flow 仓库的 agent 入口：动手前先读本 skill。给出任务路由（编译/烧录/调试/串口/OTA/适配/芯片包/provider/驾驶舱）、事实源、硬边界与验收命令。触发：在 elab-Flow 仓库里做嵌入式开发、改固件、跑闭环、接新工程或新芯片、使用 elab 命令或驾驶舱。
---

# elab-Flow —— agent 入口

## 0. 仓库是什么

- 业务层：`services/elab/**`（内核：编排/构建/烧录/串口/OTA/包）+ `cockpit/server.py`（HTTP 面与自描述）
- 数据层：`packs/**`（芯片事实）、`providers/**`（工具链命令模板）、`market/index.json`（零服务器市场索引）
- 工具层：`packages/dsh-elab-cockpit/**`（DSH 插件，只经 loopback HTTP ICD 访问内核）
- 工程：`examples/**`（固件）+ `projects/*.yaml`（绑定/串口/步骤）

**先找事实，再动手。** 不要凭目录名猜工程名，不要绕过 elab 直接拼 `cmake`/`idf.py`。

## 0.5 架构：芯片和工具链怎么接进来（入口）

**芯片 ≠ 工具链**，两者是独立数据包，工程只做绑定；内核只解析和执行。

```text
packs/<vendor>/<pack>/pack.yaml + <chip>.yaml   芯片事实：内核/内存/外设/OTA 布局/厂商指纹/provider_hint
providers/<vendor>/<name>/provider.yaml         工具链事实：各步骤命令模板/env/产物/主机前提
projects/<name>.yaml                            绑定：pack + chip + provider + serial（可显式覆盖 steps.<step>: tool:<name>）
services/elab/**                                解析（ResolvedToolchain）→ 执行 → 事件；monitor/debug_verify 判定不外包
```

接一颗新芯片，只碰这三个入口：

| 要接的东西 | 放哪 / 怎么装 | 工程里怎么写 |
|---|---|---|
| **芯片**（内核、内存、外设、OTA、指纹） | `packs/**/<chip>.yaml`；`elab pkg install <vendor>/<pack>`（`--from` 本地目录） | `pack: <vendor>/<pack>` + `chip: <id>` |
| **工具链**（编译器/烧录/校验命令） | `providers/**/provider.yaml`；`elab provider install <vendor>/<name>` | `provider: <vendor>/<name>@>=1 <2` |
| **主机路径**（本机工具位置） | `elab.host.yaml` 的 `tools.*`，provider/工程只引用 `${host:...}` | 不写绝对路径 |

- 接现有工程：`elab adapt <path> --probe` → `--write` → `--verify`；指纹命中 pack 时会自动建议 `provider:`（不命中再手写 `projects/*.yaml`）。
- 换工具链 = 只改项目里的 `provider:`；换同平台芯片 = 只改 `pack/chip`；内核与 provider 不动。
- `monitor` / `doctor_deep` 永远由内核提供；provider 缺某步骤 → 该步骤直接不可用（不回退原生链）。
- 细读：[Provider 工具链架构](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/docs/design/技术方案_Provider工具链架构.md) §2–§10；真实样例 [ESP-IDF provider.yaml](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/providers/official/espressif/idf/provider.yaml)。

## 1. 动手前（必做）

```powershell
.\elab.cmd list --json                     # 主机/芯片/工程/包
.\elab.cmd setup -p <project> --json       # 装包后的环境自检：芯片包/provider/host/串口，缺什么给下一步
.\elab.cmd doctor -p <project> --json      # 主机/芯片/工程三层体检
.\elab.cmd run -p <project> --dry-run      # 本轮将执行的 argv（什么都不跑）
```

- 工程名来自 `projects/*.yaml` 的 `name`；`list` 里没有就先走「适配」。
- `--dry-run` 与真实执行共享同一份解析结果，看到的外部命令就是实跑命令。
- 写操作前确认串口空闲：驾驶舱监视打开时先 `elab_serial(action="monitor", op="close")` 关闭，或 `POST /api/serial/monitor {"action":"close"}`。

## 2. 任务路由

| 目标 | 命令 / 入口 | 说明 |
|---|---|---|
| 只编译 | `.\elab.cmd build -p <project>` | 自动级联 boot（F411） |
| 三连（编译+烧录+调试校验） | `.\elab.cmd run -p <project> --steps build,flash,debug_verify` | 等价 `loop --no-monitor`（后者多跑 doctor） |
| 完整闭环 | `.\elab.cmd loop -p <project>` | doctor→build→flash→debug_verify→monitor |
| 无探针/无板 | `.\elab.cmd loop -p <project> --no-flash --no-debug --no-monitor` | 只 doctor+build |
| 串口判据 | `.\elab.cmd monitor -p <project>` | 退出码 0=ok / 1=failed / 2=inconclusive |
| 手写串口 | `.\elab.cmd serial -p <project> --data "..."` | 与面板共用 console 留档 |
| 调试自检 | `.\elab.cmd debug -p <project> --verify` | 断到 main 取证后退出；需探针 |
| 事件流 | `.\elab.cmd run -p <project> --steps ... --emit-events` | JSONL + SSE，契约见 `docs/design/ICD_cockpit_events.md` |
| 接新工程 | `.\elab.cmd adapt <path> --probe` → `--write` → `--verify` | `--verify` = doctor --deep + build + guard.untouched |
| 芯片包 | `.\elab.cmd pkg search/install/list/verify` | 芯片知识只进 `packs/**` |
| 工具链 | `.\elab.cmd provider list/install/remove` | 入口见 §0.5；契约见方案 §2–§10 |
| 双槽 OTA | `.\elab.cmd run -p stm32f411ceu6 --steps tool:ota` | 流程见 `examples/STM32F411CEU6/README.md` |
| 驾驶舱 | `.\cockpit.cmd` 或 `python -m cockpit.server` | 默认 `127.0.0.1:8333`（避开 openocd 3333） |
| DSH 面板工具 | `elab_status` / `elab_run(action="build")` / `elab_run(action="loop")` / ... | 见 `elab-loop` skill |

需要机器可读输出时给所有命令加 `--json`。完整工具索引（任务→CLI/HTTP/`elab_*` 三列对照）见 `elab-tools` skill。

## 3. 事实源（改哪个文件）

| 事实 | 唯一宿主 | 不要写在哪 |
|---|---|---|
| 工程绑定、串口、步骤覆盖、OTA 工具 | `projects/*.yaml` | 内核代码 / 插件 |
| 机器路径（编译器、IDF、venv、探针） | `elab.host.yaml`（`${host:...}`） | 项目 YAML / provider |
| 芯片参数、指纹、OTA 布局 | `packs/**`（经 `elab pkg`） | `services/**` / `cockpit/**` |
| 工具链命令模板/env/产物/主机前提 | `providers/**/provider.yaml` | 项目 YAML / 芯片包 |
| 版本锁定 | `elab.lock.yaml`（`elab lock`） | 手写 |
| 步骤名/标签/三档 | `services/elab/flow.py` 的 `STEP_META` / `KERNEL_PLANS` | 插件默认值 |
| 事件契约 | `docs/design/ICD_cockpit_events.md` | 散落在前端 |

规范步骤：`doctor` `doctor_deep` `build` `flash` `debug_verify` `monitor`。三档 plan：`basic=[build]`、`triple=[build,flash,debug_verify]`、`loop=[doctor,build,flash,debug_verify,monitor]`。

## 4. 硬边界（违反会被门禁或运行期拒绝）

- **单飞**：同一会话最多 1 个 run；不要并发发起 build/flash。
- **串口独占**：监视会话占用时不能 flash/debug；先关闭监视。
- **`monitor` / `doctor_deep` 永不由 provider 提供**：串口三态与深度体检留在内核。
- **provider 缺步骤 = 该步骤不可用**，不回退原生链；不要写“兜底分支”掩盖。
- **工具层不做业务**：改闭环行为写 `services/elab/**`；插件只经 HTTP ICD，门禁 `packages/dsh-elab-cockpit/test/boundary.test.mjs`。
- **`packs/installed/`、`providers/installed/` 不入库**；随仓只提交 official 源与 `market/index.json`。
- **产物目录**：`.work/` 是本地状态，不入库；`cockpit/web/dist/**` 与插件 `lib/**` 是入库产物，改源码后必须重建，不要手改。
- **硬件结论**：只认实跑证据。串口心跳可由 agent 判定；「LED 均匀闪烁」必须由人肉眼确认后才能宣布第一关通过（AGENTS C36）。

## 5. 验收（提交前）

| 范围 | 命令 |
|---|---|
| 内核单测 | `$env:PYTHONPATH="services"; python -m unittest discover -s tests -p "test_*.py"` |
| 体检 | `.\elab.cmd doctor`（版本漂移严格模式 `--strict-lock`） |
| 市场/索引漂移 | `.\elab.cmd pkg index --check` |
| 锁文件 | `.\elab.cmd lock --check --strict` |
| CI 矩阵 | `.\elab.cmd ci --job host-gate --json` |
| 插件（cwd=`packages/dsh-elab-cockpit`） | `npm test`、`npx tsc -p tsconfig.host.json --noEmit`、`npx tsc -p tsconfig.client.json --noEmit`、`npm run build` |
| 前端 dist（cwd=`cockpit/web`） | `npm run build` 后 `git diff --exit-code dist/` |

## 6. 遇到问题先看哪里

- 编译/烧录失败：`elab_log` 或 `elab run --steps <step> -v`；再用 `doctor --deep` 取真实命令证据。
- 某步骤不可用：看 `/api/projects` 卡片 `steps` 的 `kind/reason`，或 `run --dry-run` 的 `blocked`。
- provider 报错：`elab provider list` 看 installed/steps，再对照方案 §8 的失败表。
- 串口收不到/判据 inconclusive：先看 `GET /api/capabilities` 的 `meta.serial`，再用 `elab monitor --caps`。
- 版本/发布：`elab-release` skill（版本落点、门禁、tag、npm 发布、**GitHub Release 同步发布**、
  **插件市场展示面 = 卡片图（`assets/` + `screenshots.json`）+ 中英简介**）。
