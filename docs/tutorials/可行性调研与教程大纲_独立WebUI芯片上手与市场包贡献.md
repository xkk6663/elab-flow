# 可行性调研与教程大纲：独立 WebUI 芯片上手 + 插件市场 + 市场包贡献

> **状态**：调研结论 + 教程大纲（**未接板、未截图、未改代码**） · **日期**：2026-11-02 · **仓库**：`dsh-elab-flow`
>
> **口径**：只写仓库里可验证的事实（源码 / 文档 / 本机 CLI 输出）。
> 本次交付**不含任何图片**，也不生成占位假图；所有图位以 `[图 A-xx]` / `[图 B-xx]` / `[图 C-xx]` 标记，
> 待实机、CLI 与市场 UI 实拍后回填。教程正文最终落在 `docs/tutorials/`。

---

## 0. 结论先行

| 教程 | 内容可行性 | 配图可行性 | 唯一阻塞 | 判定 |
|---|---|---|---|---|
| **A. 独立 WebUI 芯片开发上手** | ✅ README 已有完整闭环流程，WebUI 源码状态齐全 | ⚠️ 需接探针 + 板 + 判据固件 | 实机未接（临时） | **可行，待实拍** |
| **B. 市场适配包贡献** | ✅ [`market/CONTRIBUTING.md`](../../market/CONTRIBUTING.md) 已是完整事实源 | ✅ CLI 本机可跑；结构/流程用图 | 无 | **可行，可先做** |
| **C. 独立 WebUI 插件市场使用** | ✅ 现有 DSH 市场视图功能完整，正在移植进独立 WebUI | ⚠️ 依赖移植落地后的真实界面 | 移植进行中 | **可行，待 UI 落地** |

**一句结论**：三篇教程都可交付；缺口分别在图的三处来源——实机（A）、CLI（B）、移植后的市场 UI（C）。

**口径调整记录**：
1. 原判断"独立 WebUI 没有市场 UI"只对**当前 commit**成立；用户正在把 DSH 右栏移植进独立 WebUI，
   落地后会有插件市场，因此**新增 C 篇**。
2. B 篇（作者侧贡献）仍以 CLI + 仓库结构为主：贡献流程本身不经过 WebUI 市场页
   （市场页是**用户侧安装入口**，作者侧是建仓/校验/上架）。

---

## 1. 事实核对（决定可行性的硬边界）

### 1.1 独立 WebUI 的能力边界

| 事实 | 证据 |
|---|---|
| 入口：`cockpit.cmd` 或 `python -m cockpit.server` → `http://127.0.0.1:8333/` | [README](../../README.md) 「一个内核，三种入口」 |
| 形态：三列全屏（工程轨 / 阶段轨 / 证据轨），右列工作区为 **构建 \| 烧录 \| 串口 \| 工具** | [web.yaml](../../cockpit/profiles/web.yaml)、[AppFrame.tsx](../../cockpit/web/src/AppFrame.tsx) |
| 有工程接入：「＋ 适配」→ 只读探测（T1/T3、置信度、芯片、证据链）→ 写入 | [ProjectsRail.tsx](../../cockpit/web/src/rails/ProjectsRail.tsx) |
| 有单步与全闭环：「▶ 跑全闭环」、「单步执行」、「运行选项 → 预览」 | [README](../../README.md) 「闭环驾驶舱」六步表 |
| 有证据面：RAM/FLASH 实数（取 `.map`）、产物 elf/hex/bin/map、零改动守卫、日志导出 | [EvidenceRail.tsx](../../cockpit/web/src/rails/EvidenceRail.tsx)、[MemoryGauge.tsx](../../cockpit/web/src/render/MemoryGauge.tsx) |
| 有串口工作台：行 / 字节 / 终端 / 波形、发送、录制、端口与波特率、会话解码器 | [SerialWorkspace.tsx](../../cockpit/web/src/serial/SerialWorkspace.tsx)、[README](../../README.md) 「串口工作区」 |
| **当前 commit 没有市场视图**：`cockpit/web/src` 对 `packs` / `market` 零命中 | 源码检索结果 |
| **市场视图正在移植**：共享逻辑包 `packages/cockpit-ui-core/` 已出现（未入库）；DSH 侧 `PackSettingsView` 是移植母本 | `packages/cockpit-ui-core/`（untracked）、[PackSettingsView.tsx](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/PackSettingsView.tsx) |
| 内核只读 `GET /api/packs` + 写动作 `POST /api/pkg/{install,remove,verify,update,activate,market}` 已存在 | [server.py](../../cockpit/server.py)（`/api/pkg/` 分发） |

> **口径冲突提醒**：[UI 共享层方案](../design/技术方案_驾驶舱UI共享层迁移.md) §3.2 目前仍写着
> "`PackSettingsView` 不参与共享"。移植落地后必须同步更新该方案，否则文档之间自相矛盾（见 §8 R7）。

### 1.2 「agent 闭环」与 WebUI 是否同源（截图能否成立的关键）

| 事实 | 证据 |
|---|---|
| `POST /api/run` 接受 `actor` 字段，agent 发起的 run 会带 `actor: "agent"` | [server.py](../../cockpit/server.py) `spawn(..., actor=body.get("actor") or "human")` |
| 阶段轨顶栏把 actor 渲染成标签：`agent` / `我点的` | [StageRail.tsx](../../cockpit/web/src/rails/StageRail.tsx#L188-L192) |
| WebUI 通过 SSE 订阅同一份 run 事件；`/api/run` 返回 202 + run id | [server.py](../../cockpit/server.py)、[App.tsx](../../cockpit/web/src/App.tsx) |
| 串口监视 `POST /api/serial/monitor` 支持 `open/close/decoder/clear/pause/resume`，带 `actor` 与 `lease_s` | [server.py](../../cockpit/server.py#L1199-L1241) |

> 结论：agent 走 loopback ICD 发 `/api/run`，独立 WebUI 实时显示同一次 run，并在阶段轨打上 `agent` 标签。
> 这就是"agent 闭环执行时上机显示的 UI 截图"的技术前提，且不违反分层（只走 HTTP ICD）。

### 1.3 包与市场现状

| 事实 | 证据 |
|---|---|
| 已装：`st/stm32`（启用，official）、`artery/at32`（community） | `python -m elab pkg list` 实测 |
| 市场索引已登记 at32 外置包（git + commit + sha256） | [`market/index.json`](../../market/index.json) |
| 市场视图三页签：**市场 / 已安装 / 内核设置**；右上「← 返回」回闭环面板 | [PackSettingsView.tsx](../../packages/dsh-elab-cockpit/src/adapters/dsh-web/PackSettingsView.tsx#L36-L38) |
| 市场首屏**自动遍历 GitHub** 上全部 `elab-pack` 仓库（异步 job，只写缓存、**不冻结闭环**） | 同上（`action=market`） |
| 安装 / 卸载 / 启用 / 校验 / 更新均为异步 job；**包操作期间闭环冻结**（`POST /api/run` 409） | [server.py](../../cockpit/server.py#L1083-L1093)、[market/README.md](../../market/README.md) |
| 一次只启用一套，其余包保留本地；`elab pkg activate` 切换 | [market/README.md](../../market/README.md) |
| 贡献规则、准入清单、`.gitattributes` 要求、上架流程已完整成文 | [`market/CONTRIBUTING.md`](../../market/CONTRIBUTING.md) |

### 1.4 截图条件现状

| 项 | 现状 |
|---|---|
| 调试探针 | 本机当前**未识别到** CMSIS-DAP / AT-Link（USB 设备列表无调试器）；拍摄前接入 |
| 串口 | 当前可见 COM3–COM8（多为虚拟口）；主线固定 COM10 |
| 上次真机成功态 | STM32F411CEU6 + CMSIS-DAP + COM10，2026-11-01（[插件 README](../../packages/dsh-elab-cockpit/README.md#L105-L106)） |
| 已有截图资产 | `packages/dsh-elab-cockpit/assets/` 12 张（**DSH 窄栏面板**，非 WebUI 三列）；`docs/assets/serial/` 6 张（来源待核） |
| 复用限制 | DSH 截图**不能**冒充独立 WebUI 截图（形态不同）；A/C 两篇必须重拍 |

### 1.5 已锁定的拍摄口径（本次确认）

| 项 | 锁定值 |
|---|---|
| 主线板 | **STM32F411CEU6**（工程 `f411`；OTA 双槽时 `f411_boot`） |
| 探针 | **CMSIS-DAP**（atlink） |
| 串口 | **COM10**，115200（拍摄当天若枚举变化，以实际口为准并在页脚记录） |
| 主题 | **深色** |
| 语言 | **仅中文**，不提供英文版 |
| 画布 | 1600×1000，应用区域截图 |
| 固件 | `examples/STM32F411CEU6`（0.5 Hz 正弦 + `[alive]` 心跳，FireWater 协议） |

---

## 2. 教程 A 大纲：独立 WebUI 芯片开发上手

**目标读者**：第一次用 elab-Flow 的嵌入式开发者。
**读完能做什么**：启动独立 WebUI → 装芯片包（见 C 篇）→ 接入工程 → 跑通全闭环 → 看懂证据 →
用串口工作台验证设备输出。

**前置条件**：

| 类别 | 要求 |
|---|---|
| 主机 | Python ≥ 3.10；Windows 用 `cockpit.cmd` / `elab.cmd` |
| 工具链 | CMake、Ninja、ARM GCC、OpenOCD（`elab doctor` 逐项体检） |
| 硬件 | STM32F411CEU6 + CMSIS-DAP + COM10 |
| 固件 | `examples/STM32F411CEU6`（正弦 + 心跳） |

### 章节结构

| 章 | 标题 | 要点 | 图 |
|---|---|---|---|
| 0 | 你将得到什么 | 三列界面 + "一次闭环 = 体检→编译→烧录→调试→串口"地图 | 1 张总览 |
| 1 | 启动独立 WebUI | `cockpit.cmd` / `python -m cockpit.server`；8333 幂等；三列/四工作区 | A-01 |
| 2 | 装一颗芯片 | **主路径见 C 篇（插件市场）**；无市场版本给出 CLI 兜底（`pkg bootstrap/search/install/activate`） | 引用 C-01…C-06 |
| 3 | 接入你的工程 | 「＋ 适配」→ 绝对路径 →「探测」→ 只读报告（T1/T3、置信度、芯片、证据链）→「写入」 | A-02、A-03、A-04 |
| 4 | 跑一次全闭环 | 「▶ 跑全闭环」；阶段灯点亮；不可用步骤给 tooltip 理由；agent 发起的 run 带 `agent` 标签 | A-05 |
| 5 | 单步执行与预览 | 构建 / 烧录 / 调试校验三键；「预览」只读 argv；取消 run | A-06 |
| 6 | 读懂证据 | RAM/FLASH 实数；产物；零改动守卫；日志导出；"成功"的判据 | A-07、A-08、A-09 |
| 7 | 串口工作台 | 行 / 字节 / 终端 / 波形；端口与波特率；会话解码器；发送与录制 | A-10、A-11、A-12 |
| 8 | 常见故障 | 残留 openocd 占用探针；闭环与监视 409；无心跳判据 monitor 不可用；适配漂移 | A-13（可选） |
| 附录 | 命令速查 | `doctor / build / triple / loop / pkg / serial` 与 WebUI 按钮对照 | 无 |

**每章写法**：一段"为什么"（≤3 句）→ 编号步骤 → 一张图 → "你应该看到"表格（数字须与图同源）→ 一句常见坑。

---

## 3. 教程 B 大纲：市场适配包贡献（作者侧）

**目标读者**：想把自己芯片接入 elab 的社区贡献者（会写 YAML 即可）。
**读完能做什么**：独立 GitHub 仓库 → 合格适配包 → 本地自测 → 打 topic 自动上架 → 被拒自查。

**事实源**：[`market/CONTRIBUTING.md`](../../market/CONTRIBUTING.md) + [`market/README.md`](../../market/README.md) +
[`packs/official/st/stm32/pack.yaml`](../../packs/official/st/stm32/pack.yaml)。

| 章 | 标题 | 要点 | 图 |
|---|---|---|---|
| 0 | 包是数据，不是代码 | 内核不认识厂商；芯片知识唯一宿主 = 适配包 | B-00 结构图 |
| 1 | 市场链路一张图 | topic `elab-pack` → 市场仓每小时发现 → 校验 → 机器人算 sha256 → `index.json` | B-01 流程图 |
| 2 | 建仓骨架 | `pack.yaml` / `chips/*.yaml` / `.gitattributes` / `LICENSE` / `README.md`；`requires` | B-02 目录树 + 代码块 |
| 3 | 用探测把事实填对 | `elab adapt <vendor-project> --probe`；E1–E6 证据链 | B-03 CLI |
| 4 | 本地先跑通 | `install --from` → `verify` → `activate` → `doctor --deep` → `build`/`triple` | B-04、B-05 CLI |
| 5 | 上架 | 独立仓 → topic `elab-pack` → tag；ref 固定；sha256 由机器人算 | B-06 时序图 |
| 6 | 机器准入 7 条 | schema / requires / 安全审计 / 芯片 / `.gitattributes` / 哈希重算 / 同名取最高 | 表格 |
| 7 | 版本、下架与封禁 | 改内容升版本；删 topic 下架；`blocklist.json` | 表格 |
| 8 | 常见被拒与自查 | 哈希漂移=换行；搜不到=topic/缓存；脚本/二进制命中；requires 不诚实 | 症状→修法表 |
| 附录 | 官方包怎么写 | `packs/official/st/stm32` 自吃狗粮；`pkg index --check` 门禁 | 代码块 |

**写法约束**：
- 读者侧入口是"建仓 + CLI + 上架"，**不是** WebUI 市场页；市场页只作为"上架后用户怎么装"的收尾引用（链到 C 篇）。
- 上架环节（GitHub topic / Actions / report）默认不配截图，用文字 + 流程图。

---

## 4. 教程 C 大纲（新增）：独立 WebUI 插件市场使用

**目标读者**：已经能启动 WebUI 的用户（可作为 A 篇第 2 章的展开版，也可独立阅读）。
**读完能做什么**：在市场里找到自己的芯片包 → 安装 → 启用 → 校验/更新/卸载 → 回到工程轨适配并跑闭环。

**前置条件**：移植落地后的独立 WebUI（有「设置」入口）；能访问 GitHub（市场索引远程读取）；
本机已装内核。

### 章节结构

| 章 | 标题 | 要点 | 图 |
|---|---|---|---|
| 0 | 市场是什么 | 零服务器：索引只记元数据 + 哈希，包内容留在作者仓库；官方包离线随仓 | C-00 链路图 |
| 1 | 进入设置 | 顶栏「设置」→ 整幅设置视图；三页签 **市场 / 已安装 / 内核设置**；「← 返回」回闭环 | C-01 |
| 2 | 市场页：浏览与搜索 | 首屏自动遍历 GitHub（异步 job，进度可见）；搜索框（名称/厂商/平台，如 `stm32`、`at32`）；列表字段：official/community、license、sha256、requires、chips | C-02 |
| 3 | 安装 | 只传包名；异步 job；**安装/卸载/启用期间闭环冻结**（此时发起 run 会 409，界面必须明说）；市场遍历本身不冻结 | C-03 |
| 4 | 已安装页 | 启用中 / 已安装徽标；启用（一次只启用一套，其余保留本地）、校验（内容哈希一致）、更新、卸载 | C-04、C-05 |
| 5 | 启用与生效 | 顶栏「启用：`vendor/platform`」；切包后工程轨的芯片能力随之变化；装完自动重生成平台 skill | C-06 |
| 6 | 回到闭环 | 启用后去工程轨「＋ 适配」→ 探测 → 写入 → 跑闭环（与 A 篇衔接） | C-07 |
| 7 | 异常与兜底 | 市场索引读取失败 → 回退本仓索引 / 显示上次缓存；搜索不到 → topic 与缓存；包与内核不兼容 → 安装按钮置灰 | C-08（可选） |
| 8 | agent 代装（可选小节） | agent 走 `POST /api/pkg/install`（只收包名）；与人工共用同一 job 与冻结规则 | 无强制图 |

**写法约束**：
- 以**移植落地后的真实界面**为准；移植期间界面可能微调，截图必须来自落地后的 commit。
- 不写 DSH 专属入口（右栏 tab / 槽位）；只写独立 WebUI 的设置入口。
- 市场页是**安装入口**；作者如何上架见 B 篇，两边互相链接、不重复。

---

## 5. 截图清单（Shot List）

> 统一口径：同一次环境、同一个 commit；数据不修改；只允许裁剪空白边与统一画布。

### A 篇（实机 · STM32F411CEU6 / CMSIS-DAP / COM10 / 深色）

| 编号 | 教程位置 | 画面必须同时出现的事实 | 触发 | 前置 |
|---|---|---|---|---|
| A-01 | 第 1 章 | 三列布局；工程卡；右列四工作区；顶栏主题/字号 | 打开 `127.0.0.1:8333` | 服务已启动 |
| A-02 | 第 3 章 | 「＋ 适配」展开 + 绝对路径输入 | 人点开适配面板 | 有厂商工程 |
| A-03 | 第 3 章 | 探测报告：T1/T3、置信度、芯片、证据链 | 人点「探测」 | 同上 |
| A-04 | 第 3 章 | 写入后新工程卡出现并选中 | 人点「写入」 | 同上 |
| A-05 | 第 4 章 | 运行中阶段轨 + `agent` 标签 + run id | agent `POST /api/run` | 板 + 探针 |
| A-06 | 第 5 章 | 「预览」argv 列表（`--clean` 标红如展示） | 人点「预览」 | 无硬件也可 |
| A-07 | 第 6 章 | 构建成功结束行 + RAM/FLASH 百分比 + 产物区 | 人/agent 构建 | 工具链 |
| A-08 | 第 6 章 | `Programming finished` / `verified OK` + 目标芯片名 | 人/agent 烧录 | 板 + 探针 |
| A-09 | 第 6 章 | `✓ 调试闭环成立：已断到 main` + 源文件行号 | 人/agent 调试 | 板 + 探针 |
| A-10 | 第 7 章 | 串口「行」视图 + 字节/批次统计 | 人/agent 开监视 | COM10 |
| A-11 | 第 7 章 | 「波形」曲线 + 帧数徽标 + 解码器 FireWater | 切波形 + 选解码器 | 正弦固件 |
| A-12 | 第 7 章 | 发送面板 + 录制状态/产物 | 人发送一条/开录制 | COM10 |
| A-13 | 第 8 章（可选） | 409 互斥提示或探针占用原文 | 复现故障 | 可构造 |

### B 篇（CLI + 图）

| 编号 | 教程位置 | 画面必须同时出现的事实 | 触发 | 前置 |
|---|---|---|---|---|
| B-00 | 第 0 章 | 内核 ↔ `pack.yaml` ↔ `chips/` 的边界 | 结构图 | — |
| B-01 | 第 1 章 | topic → 发现 → 校验 → 索引 → 安装 闭环 | 流程图 | — |
| B-02 | 第 2 章 | 目录树 + `pack.yaml` 必填字段 | 目录树 + 代码块 | — |
| B-03 | 第 3 章 | `elab adapt ... --probe` 证据行 | CLI 实拍 | 厂商工程 |
| B-04 | 第 4 章 | `pkg install --from` + `pkg verify` OK | CLI 实拍 | 示例包 |
| B-05 | 第 4 章 | `pkg activate` 后 `pkg list` 启用标记 + `doctor` 结论 | CLI 实拍 | 同上 |
| B-06 | 第 5 章 | 作者仓 → 市场仓 bot → 用户安装 | 时序图 | — |

### C 篇（移植后的独立 WebUI 市场 · 深色）

| 编号 | 教程位置 | 画面必须同时出现的事实 | 触发 | 前置 |
|---|---|---|---|---|
| C-00 | 第 0 章 | 索引 / 作者仓 / 本地包 三者关系 | 链路图 | — |
| C-01 | 第 1 章 | 设置入口；三页签；「← 返回」；顶栏「启用：…」 | 人点设置 | 移植落地 |
| C-02 | 第 2 章 | 市场首屏（GitHub 发现 N 个）+ 搜索框 + 包条目字段 | 打开市场页签 | 能访问 GitHub |
| C-03 | 第 3 章 | 安装 job 进度 + 闭环冻结提示 | 点「安装」 | 同上 |
| C-04 | 第 4 章 | 已安装列表：启用中/已安装徽标 + 四个动作按钮 | 切「已安装」 | 已装包 |
| C-05 | 第 4 章 | 校验通过（内容哈希一致）结论 | 点「校验」 | 已装包 |
| C-06 | 第 5 章 | 启用切换后顶栏「启用：…」变化 + 工程轨芯片能力 | 点「启用」 | 至少两套包 |
| C-07 | 第 6 章 | 装包后「＋ 适配」探测成功（衔接 A-03/A-04） | 去适配 | 厂商工程 |
| C-08 | 第 7 章（可选） | 市场索引读取失败/回退提示 | 断网或改索引地址 | 可构造 |

> 顺序建议：**B（无硬件）→ C（等移植落地）→ A（等接板）**。

---

## 6. 拍摄协议（可复现，不摆拍）

### 6.1 环境固定

- 页脚必须记录：commit / 日期 / `COCKPIT_VERSION` / 适配包版本 / 板型 / 探针 / 串口 / 主题。
- 视口 1600×1000，深色主题，隐藏书签栏与无关标签页；终端 120 列、UTF-8、截图前清屏。

### 6.2 agent 发起 run（同源显示）

```powershell
python -m cockpit.server

$body = @{ project = "f411"; steps = @("doctor","build","flash","debug_verify","monitor"); actor = "agent" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8333/api/run" -ContentType "application/json" -Body $body
```

截图等待点（满足其一即判定稳定）：
- 阶段轨目标步骤灯变绿，且顶栏出现结束时间；
- 证据轨最后一行出现 `verified OK` 或 `✓ 调试闭环成立：已断到 main`；
- 串口波形徽标帧数 > 0 且连续两批不再增长。

### 6.3 agent 打开串口监视（面板同图）

```powershell
$body = @{ action = "open"; project = "f411"; port = "COM10"; baud = 115200; actor = "agent"; decoder = "firewater" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8333/api/serial/monitor" -ContentType "application/json" -Body $body
```

### 6.4 市场篇（C）拍摄

- 从「设置」进入，先截市场首屏（自动遍历可能仍在跑 → 等列表出现再截）；
- 安装一个**已装包之外的**包（如 `artery/at32`）以拍到 job 与冻结提示；截完再切回原启用包；
- 界面文案以落地 commit 为准，不按本文档猜写。

### 6.5 CLI 截图

- 用 `python -m elab ...`（`PYTHONPATH=services`），不用 `elab.cmd`：
  本机实测 `elab.cmd` 在 PowerShell 下会多打印两行乱码，不适合入教程。

### 6.6 禁止事项

1. 禁止用 DSH 窄栏截图冒充独立 WebUI。
2. 禁止 P 图改数字、状态灯、报错。
3. 禁止用"模拟成功"的假 run 生成成功态图。
4. 失败态只能出现在故障章节并如实标注。

### 6.7 落盘

```text
docs/tutorials/assets/webui/A-01-launch.png
docs/tutorials/assets/webui/C-04-installed.png
docs/tutorials/assets/packs/B-03-adapt-probe.png
docs/tutorials/assets/diagrams/C-00-market-chain.svg
```

---

## 7. 目录与文档规范

```text
docs/tutorials/
├── 可行性调研与教程大纲_独立WebUI芯片上手与市场包贡献.md   # 本文
├── 01-芯片开发上手_独立WebUI.md            # A 篇（待接板）
├── 02-市场适配包贡献_CLI.md                # B 篇（可先落稿）
├── 03-插件市场使用_独立WebUI.md            # C 篇（等移植落地）
└── assets/
    ├── webui/                              # A / C 篇界面截图（深色）
    ├── packs/                              # B 篇 CLI 实拍
    └── diagrams/                           # SVG / Mermaid 导出
```

- 新增文档需在 [docs/README.md](../README.md) 登记（仓库既有约定）。
- 每个数字都要能对应到图里同一处；无法对应的不写。
- 图注统一：`[图 C-04] 已安装页：启用中/已安装与四个动作（f411 · 2026-xx-xx）`。

---

## 8. 风险与待确认

| # | 风险 / 未知 | 影响 | 处置 |
|---|---|---|---|
| R1 | 实机未接（当前无探针） | A 篇成功态图拍不了 | 接板后按 §5 一次跑完；此前只落文字骨架 |
| R2 | 固件判据 | monitor 不可用、波形为空 | 固定用 `examples/STM32F411CEU6`（正弦 + 心跳） |
| R3 | 移植中市场 UI 未落地/细节变动 | C 篇无法拍、文案可能过期 | 等落地 commit；先落 C 篇文字骨架；不按旧 DSH 图猜 |
| R4 | 串口被占 / 闭环与监视 409 | 拍摄中断 | 先关监视再跑闭环；一次只留一个 run |
| R5 | 市场篇口径分叉（B 作者侧 vs C 用户侧） | 读者混淆 | B/C 互相链接；B 明确"上架不经过市场页" |
| R6 | GitHub 上架页属外部网页 | 图片口径不一致 | B 篇默认不拍；仅文字 + 流程图 |
| R7 | [UI 共享层方案](../design/技术方案_驾驶舱UI共享层迁移.md) 仍写 `PackSettingsView` 不共享 | 文档自相矛盾 | 移植落地后同步更新该方案；本文以新决定为准 |
| R8 | Windows 终端编码/换行 | CLI 图乱码、哈希误判 | 终端 UTF-8；包仓强制 `.gitattributes: * -text` |

**已锁定，无需再确认**：主线板 STM32F411CEU6、CMSIS-DAP、COM10、深色主题、仅中文（见 §1.5）。

---

## 9. 验收标准

- [ ] A 篇：≥ 8 张图，全部来自同一次实机运行；含构建 / 烧录 / 调试 / 串口成功态；
- [ ] A 篇：装包主路径指向 C 篇，CLI 兜底可复制执行；
- [ ] B 篇：CLI 图来自真实执行；7 条机器准入与 `CONTRIBUTING.md` 逐条对齐；
- [ ] B 篇：不出现 WebUI 市场页作为作者入口；上架环节用文字 + 流程图；
- [ ] C 篇：界面与落地 commit 一致；三页签、返回、冻结提示、一次只启用一套均如实描述；
- [ ] C 篇：不出现 DSH 专属入口；不把市场页写成作者上架工具；
- [ ] 三篇：页脚标注 commit / 版本 / 板型 / 探针 / 串口 / 主题 / 日期；
- [ ] 三篇：登记进 `docs/README.md`；相对链接可达；
- [ ] 全仓无占位假图、无 DSH 截图冒充 WebUI 截图。

---

## 10. 下一步（按阶段，不估工期）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P0（本次）** | 可行性 + 三篇大纲 + 截图清单 + 拍摄协议 + 口径锁定 | 无 |
| P1 | B 篇落稿（CLI 实拍 + 图） | 本机 CLI、示例包 |
| P2 | C 篇落稿（市场 UI 实拍） | 移植落地 |
| P3 | A 篇实拍与落稿 | 接板 + f411 固件 |
| P4 | 三篇交叉校对、登记索引、最终验收 | P1–P3 完成 |

> 本次不做的：不改业务代码；不跑实机；不生成任何图片。
