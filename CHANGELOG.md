# 更新日志（Changelog）

所有显著变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

---

## [V2.0.0] — 2026-10-08（OTA 平台化 · 双槽 A/B Bank · 组合工程）

V1.0.0 交付的是"闭环工作链"（build / flash / debug / monitor / CI / 事件流 / 驾驶舱）；
**V2.0.0 在其上把 OTA 从"单点能力"升级为"平台能力"**，并以 STM32F411CEU6 完成
全链路实板验收：

- **OTA 组件化**（`components/ota`）：`core/` 场景层芯片无关、`port/<platform>/`
  平台层（flash HAL / Jump / 按键 / 复位）—— boot 侧 `OtaBootFlow`、APP 侧
  `OtaAppHook`（串口扫 `!` 复位进 boot）。参考实现 `examples/STM32F411CEU6`（APP）
  与 `examples/F411CEU6_BOOT`（boot），含上位机 CLI 与驾驶舱工具页可视化。
- **双槽 A/B Bank + 坏固件自动回滚**：bank 记录 append-only（20B/条 + CRC32，
  存状态扇区上半段）；升级完成后 trial 试运行（**先减并落盘再跳**，3 次上电耗尽
  → `=== ROLLBACK ===` 回老槽）；APP 心跳第 3 次 `OTA_Confirm()` 晋级（幂等）；
  metadata `0x02` 防回滚（设备版本 ≥ 固件版本拒收）；`0x17/0x25` 版本查询
  （自迭代判据）。**实弹四件套真机全绿**：正常升级 / 坏固件回滚（CRC 合法但
  Reset 向量劫持 → 3 周期挂死 → 自动回滚 → 老固件心跳恢复）/ 版本决策同版 skip /
  槽位交替（openocd 直读 bank 记录：active 0→1→0）。实弹还抓出并修复
  **EraseRange 双语义潜伏 bug**（向上对齐误用于整片擦除 → S4 含 Reset 向量永不擦
  → 0xFFFFFFFF 劫持=按位与空操作 → 坏固件"复活"；新增 `EraseRangeFull` 向下对齐）。
- **组合工程（约束 C35）**：chips yaml 一字段 `ota_layout.boot_project` ——
  `elab build -p f411` 自动**级联构建** boot（C1）；boot 烧录走 **md5 指纹台账**
  （`--reflash-boot` 强制），日常 app 迭代 boot **字节级零触碰**（C2/C3 冻结策略）；
  驾驶舱工程轨把 boot 子工程**嵌在宿主卡正下方**（缩进 + 连接线 + 可收起披露组）
  并显示 OTA 双槽与冻结状态（C4）。
- **分区表单一事实源**：`chips/*.yaml` 的 `ota_layout:` 节 → 构建期生成
  `ota_layout_gen.h` 经 `-include` 强制注入（M1/方案 A）→ `doctor --deep` 三方
  对账（yaml 分区 ↔ 烧录地址 ↔ ld ORIGIN）；`ELAB_MFPU` 下传 `-mfpu`
  （Cortex-M4F 硬浮点，f411 实测）。
- **skill 平台化**：per-chip SKILL.md **淘汰**，改为平台聚合
  （`skills/st/stm32`、`skills/artery/at32`），具体型号作为平台条目——
  新增同族芯片不再新写 skill。
- **驾驶舱 UI 重构**：工作区注册表 `workspaces.ts` 成为右列**单一事实源**
  （加 Tab/加工具零散改动归零）；工具页**可换行启动按钮行**；默认端口
  3333→**8333**（C34，避开 openocd gdb server 3333）。
- 质量门：单测 151→**209**（+boot 组合 16 例、ota_layout、flash.images 20 例），
  集成 37/37；五工程（AT32×2 / STM32F103 / F411 app+boot）全绿，
  **STM32 上板烧录/调试/OTA 全链路实板验证**（V1.0 已知限制清零）。

### OTA 双镜像烧录（约束 C33）

- **`projects/*.yaml` 新增 `flash.images` 节**：声明 `{path, format: elf|bin,
  address?, ld?}` 烧录序列 —— 一次 openocd 会话按序 program 全部镜像，末尾
  `reset run` 收尾。bin 项**强制**显式地址（M2 教训：`program app.elf` 从擦除
  粒度边界向下对齐起擦，会覆盖 Bootloader 尾部）。首个落地工程：
  `at32f421g8u7_workbench`（SguanESC 电调台架，Boot 18K + APP 44K）。
- **`build.link_channel`**（`exe_flags` 默认 / `c_flags`）：B 类 OTA 工程必须走
  `c_flags` —— inject 盖章进 `CMAKE_C_LINK_FLAGS` 并清空 EXE 通道，让业务
  bootloader 的 `string(REPLACE ...)` 防身在 elab 接管下继续生效（M1 双 -T 根除，
  零改动业务工程）。实测：boot `.isr_vector`@0x08000000、APP@0x08004800，链接行
  单份 specs。
- **doctor 镜像级内存对账**：声明 `flash.images` 的项目改按「region ⊆ 芯片物理
  范围 + flash 分区互斥 + bin address == ld FLASH 起点」校验（单镜像工程维持
  逐字节相等口径不变）。
- **debug 镜像模式跳过 gdb `load`**（同样的向下擦除风险；闭环顺序 flash 在前，
  固件已在位）。
- **builder 校验声明镜像存在性**（缺席即 WARN，build 阶段暴露而非烧录时）。

### 修复

- **`elab adapt` 输出能力探测漏报**：只认 `__io_putchar` 与 `{` 同行的定义，
  WorkBench 生成代码的 Allman 风格（`{` 换行）被误判为"无输出能力"→ 错误放弃
  生成 monitor 判据（实测 `at32f421_int.c:279`）。现两种 C 风格均识别。
- **debug 步骤的误导性失败（约束 C34）**：驾驶舱旧默认端口 3333 与 openocd gdb
  server 冲突——端口被占时 openocd 静默退出，`_wait_port` 只测 TCP 可连导致 gdb
  连到 HTTP 服务上满屏 packet error。修复：① 驾驶舱默认端口改 **8333**；
  ② `flash.py` 检查 openocd 进程存活，占用时明确报错并给出排查命令。

### 变更

- **兼容性专项工程移出仓库**：`at32f421g8u7_workbench`（外部 BLDC 电调 OTA
  双镜像工程，用户另有备份）完成 C33 全链路验证后按用户要求移出——删除
  `examples/AT32F421G8U7_WorkBench/` 与接入 yaml，CI matrix 恢复三工程。
  C33 框架能力（flash.images / link_channel / 镜像级对账 / debug 跳 load）全部
  保留并由 20 例单测守卫。验证实录：boot `.isr_vector`@0x08000000 /
  APP@0x08004800、芯片 Flash 与 bin 逐字节一致、guard 592 文件零改动。

### 测试

- 新增 `tests/test_flash_images.py` 20 例（plan 校验 / 双镜像命令构造 / 镜像级
  对账 / putchar 探测）；新增 `tests/test_boot_combo.py` 16 例（boot 组合工程
  resolve / 冻结决策 / 台账与 _samefile）与 `tests/test_ota_layout.py`（分区表
  下传与对账）；全量回归 **209 单测 + 37 集成** 全绿。

---

## [V1.0.0] — 2026-10-05（首个正式发布）

**一套工具链 + 一套流程，驱动不同芯片的编译 / 烧录 / 调试 / 串口闭环 —— 业务工程源码零改动。**

V1.0.0 是 elab-Flow 的第一个正式版本：八层架构（L0 芯片卡 → L3 CLI → L5 CI →
L6 事件流 → L7 驾驶舱）全部贯通，三个真实工程（AT32 两个 + STM32 一个）接入并
完成上板验收。零第三方依赖 —— Python 侧仅标准库，前端产物已入仓（运行时不需要
Node）。

### ✨ 功能总览

**接入与构建（L0–L2）**

- **YAML 驱动接入**：一个 `projects/<name>.yaml` 接入一个工程；芯片参数
  （`chips/*.yaml`）声明一次全局复用。
- **两类图形配置器工程的原样接入**（约束 C1/C2 的技术支点）：
  - A 类（STM32CubeMX）：`-DCMAKE_TOOLCHAIN_FILE` 接管工具链 + inject 在
    `project()` 之后"**补回来**"（`-lm`、`.elf` 后缀等）；
  - B 类（AT32 WorkBench）：工具链行内 `include()` → inject "**抢回来**"
    （重置 `CMAKE_C_FLAGS`、清链接旗标）。
- **确定性适配器（`elab adapt`）**：扫描图形配置器导出的工程 → 生成接入 YAML
  （probe / write / check / verify 四段式）；人工接管的文件**绝不覆盖**（A7 保护）；
  **UI 一键适配**（probe 只读在前 → write 落盘 → 卡片自动出现，写入后服务端
  热重载 Config，约束 C29）。

**闭环与 CLI（L3）**

- **五步闭环**（`elab loop -p <name>`）：`doctor → build → flash → debug --verify
  → monitor`，三个工程实测全绿（含上板烧录 `** Verified OK **`、断点自检、
  串口闭环命中）。
- **串口闭环判据引擎**（`elab monitor`）：`close_on` / `fail_on` / 静默超时 →
  `ok / failed / inconclusive` 三态；`failed` 必须有正面失败证据；`fail_on`
  对整缓冲区绝对优先（防"报活即崩"被掩盖）；`judge()` 为纯函数、38 例离线单测。
- **串口手写通道**（`elab serial`，M3-b）：无状态往返（open→write→read→close），
  与闭环天然串行；CLI 与驾驶舱共用同一份实现。
- **只读命令预览**（`elab run/loop --dry-run`、`GET /api/plan`）：`--clean` 的
  删目录副作用显式标出（约束 C26：预览与实跑只有一份命令构造）。

**CI（L5）**

- **本地与云端同源**（K9）：本地 `elab ci` 与 GitHub Actions 共用同一份
  `ci/matrix.yaml`。三个 job：`host-gate`（三工程编译，云端已验证全绿）、
  `onhw-gate`（上板步骤，self-hosted 门控）、`web-dist-guard`（前端产物一致性）。
- 产物路径由 `elab ci --json` 的 build 步骤**自报**（约束 C22）—— 接入新工程
  **无需改 workflow**；门禁绿却零产物 → `exit 1`（C23）。

**事件流（L6）**

- `elab run --emit-events` 把每步写成**只追加的 JSONL 事件流**（每 run 一个
  文件、`seq` 全局单调、**单写者** C17）；`serial/*` 域事件链
  （open → line → close → closed-loop）把"串口到底说了什么"落档。
- SSE 推送：`proc/*` 100ms 合并、背压丢弃**留痕**（`stream/overrun`，C25）、
  控制帧绝不丢（C26）、SSE 合并判据只用 `is_batched`（C24 —— 实测事故的反向修复）。

**驾驶舱（L7）**

- 三列布局：工程轨（YAML 卡片 + 芯片卡 + 一键适配面板）→ 阶段轨（流水线状态带、
  内存占位取自 `.map`、产物、零改动守卫、阶段账本）→ 证据轨（构建/烧录/串口
  三合一实时日志，环形缓冲 + 命令式 DOM 追加，上万行不卡）。
- **单步执行 = 独立按钮**（C30）：阶段轨一排六颗；证据轨各 Tab 内对应按钮；
  可用性与置灰理由同源 `card.steps[id].ok`。**「跑全闭环」显式传步序**，
  空闲骨架与按钮同源。
- **串口 Tab 常驻监视**（C31，serialmon）：「打开监视 / 关闭监视」—— 读线程
  异常自愈、单例一键关闭、写通道路由进会话；输出只活服务端环形缓冲
  （`seq` 增量 + `gap` 丢行报告）+ 前端 600ms 轮询，**不进事件流也不落留档**。
  监视与闭环双向 409 互斥、指名道姓。
- **TX/RX 独立留档**（C28）：`serial-console.jsonl`（有上限、会滚动、原子替换），
  界面进工程/起闭环时按工程回填最近 60 条。
- **桌面一键启动**：仓库根 `cockpit.cmd` + 桌面快捷方式（图标 `cockpit.ico`）。
  幂等（已在跑只开 UI）；UI 走 **Edge `--app` 独立窗口**（无地址栏、任务栏独立
  图标，观感即原生应用且零依赖），Edge 缺失回落默认浏览器；裸 TCP 探测不受
  系统代理/TUN 影响；**stdio UTF-8 守卫**（C32 —— 修复"双击起服务后 UI 不弹"）。
- 真浏览器验收：日志实时滚动、页面与控制台零报错、契约版本先校验再渲染。

### 📜 设计约束（本仓库的"为什么"）

[docs/设计约束.md](docs/设计约束.md) 收录 **C1–C32** 共 32 条硬约束，每条都附"为什么"与（多数情况下）
一次真实事故。精选：

| # | 一句话 |
|---|---|
| C17 | 事件流**单写者**：只有 `elab run --emit-events` 写，其余一律不碰 |
| C22/C23 | CI 不写死产物路径；门禁绿却零产物 → 红 |
| C24–C26 | SSE 合并只认进程输出；背压丢弃留痕；控制帧绝不丢 |
| C28/C31 | 手写留档、常驻监视输出都**不进事件流**（两条道互不污染） |
| C29/C30 | 适配写入后热重载 Config；「跑全闭环」必须显式传步序 |
| C32 | stdout 被重定向 + GBK 区域编码会崩 CLI/服务 —— 包入口统一守卫 |

### ✅ 验收证据（仓库内可复核）

- 单元测试 **151/151**：`python -m unittest discover -s tests -p "test_*.py"`（约 35s）
- 后端集成 **37/37**（真起服务、真编译）：`python -m unittest tests.it_cockpit_server`（约 1min）
- 上板验收：`at32f421g8u7` 五步全绿（烧录 Verified OK / 断到 `main.c:103` /
  串口 2.6s 命中 `[alive]`，**无需 `--reset-port`**）
- GitHub Actions：`host-gate` 在 `ubuntu-latest` 全绿（§8.1）
- 前端产物一致性：重建后 `git diff --exit-code cockpit/web/dist/` 零差异

### ⚠️ 已知限制（诚实清单）

- STM32 上板烧录/调试**未验证**（本机只有 AT32 板；命令已生成、只差 target cfg）
- `onhw-gate` 需要 self-hosted 探针（云端编译门禁不受影响）
- SVD 在 IDE 中实际加载未实测
- 驾驶舱 `profiles/*.yaml` 插件化装配（M4）、`elab skill --adapt`（M5.5）未实现
- 常驻监视的实时流只活服务端环形缓冲 + 浏览器本地缓冲（重启即失 —— 它是
  "看"，不是"证据"；要证据走闭环 monitor 步骤）

### 📦 从源码运行

```bash
git clone git@github.com:xkk6663/elab-flow.git
cd elab-flow
python -m cockpit.server        # → http://127.0.0.1:3333/（Windows 亦可双击 cockpit.cmd）
elab doctor_deep --all          # 或 ./elab …（MSYS）/ elab.cmd …（cmd）
```

要求：Python ≥ 3.10（仅标准库；3.12 / 3.13 实测）；可选：CMake + Ninja + ARM GCC 工具链 +
openocd（上板闭环用）。前端运行时不需要 Node（`dist/` 已入仓）。

---

## [0.x] — 2025-09 ~ 2026-10（开发期）

M0–M5.6 里程碑的演进史见 `docs/技术方案_闭环驾驶舱.md`（§20 实现记录，含每轮
真实事故与修复）与 [docs/设计约束.md](docs/设计约束.md) 约束表 —— 本仓库把"踩过的坑"当作一等公民文档化。
