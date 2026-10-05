# 更新日志（Changelog）

所有显著变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### 新增 —— OTA 双镜像烧录（约束 C33）

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

### 测试

- 新增 `tests/test_flash_images.py` 20 例（plan 校验 / 双镜像命令构造 / 镜像级
  对账 / putchar 探测）；全量回归 171/171 绿。

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

要求：Python ≥ 3.11（仅标准库）；可选：CMake + Ninja + ARM GCC 工具链 +
openocd（上板闭环用）。前端运行时不需要 Node（`dist/` 已入仓）。

---

## [0.x] — 2025-09 ~ 2026-10（开发期）

M0–M5.6 里程碑的演进史见 `docs/技术方案_闭环驾驶舱.md`（§20 实现记录，含每轮
真实事故与修复）与 [docs/设计约束.md](docs/设计约束.md) 约束表 —— 本仓库把"踩过的坑"当作一等公民文档化。
