<div align="center">

# ELAB-Flow

**一套工具链 + 一条流程：不同芯片的工程，跑同一句 `elab build / flash / debug / monitor`。**

业务工程源码零改动 · 内核仅 Python 标准库 · 前端产物已入仓（运行时不需要 Node）

[![release](https://img.shields.io/github/v/release/xkk6663/elab-flow?style=flat&label=release&color=4D6BFE)](https://github.com/xkk6663/elab-flow/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/xkk6663/elab-flow/elab.yml?branch=main&style=flat&label=CI)](https://github.com/xkk6663/elab-flow/actions/workflows/elab.yml)
[![Python](https://img.shields.io/badge/Python-%E2%89%A53.10%20%E4%BB%85%E6%A0%87%E5%87%86%E5%BA%93-4D6BFE?style=flat)](README.md#快速开始)
[![platform](https://img.shields.io/badge/Windows%20%7C%20Linux-4493F8?style=flat-square)](README.md#快速开始)

[项目定位](#position) · [是什么](#what) · [功能](#features) · [怎么用](#quickstart) · [仓库结构](#repo) · [文档](#docs)

<img src="docs/tutorials/assets/debug-panel/02-overview.png" width="100%" alt="elab cockpit 闭环驾驶舱实机">

*实机（STM32F103C8T6 + AT-Link）：左工程轨 · 中阶段轨与证据轨 · 右调试工作区（HardFault 调用栈）*

</div>

---

<a id="position"></a>

## 项目定位

嵌入式项目里最重复的一段劳动：**每换一颗芯片，工程、工具链、烧录参数、验证脚本都要重搭一遍**。
CubeMX 一套、WorkBench 一套、Keil/IAR 又各一套，工具版本靠 PATH 运气，真机验证全靠手工。

ELAB-Flow 做的是 **"一套工具链和流程跑不同芯片"**，不是"一套代码跑不同平台"。
业务代码是器官，elab 是外骨骼：**外骨骼不改器官，只负责把器官接上流水线**。

| ELAB-Flow 做 | ELAB-Flow **不**做 |
|---|---|
| 同一句 `elab build -p X` 编译不同厂商、不同内核的芯片 | 代码级可移植层 / 运行时平台抽象 |
| 业务代码原地不动（构建前后文件树快照可断言 `untouched`） | 搬代码、重组目录、建 `apps/` `framework/` |
| 一份通用 `gcc.cmake`，差异只由芯片 YAML 驱动 | 每颗芯片各写一份工具链文件 |

**一个内核，三种入口** —— 同一份事件流、同一个串口会话、同一套步骤定义，区别只在"谁在看、屏幕多大"：

| 入口 | 启动方式 | 适合 |
|---|---|---|
| **CLI `elab`** | `./elab loop -p <name>`（Windows 用 `elab.cmd`） | 脚本 / CI / 无人值守 / agent 直接调用 |
| **独立驾驶舱** | 双击 `cockpit.cmd` 或 `python -m cockpit.server` → `http://127.0.0.1:8333/` | 桌面前盯全程：工程轨 / 阶段轨 / 证据轨三列全屏 |
| **DSH 右栏面板** | 安装插件 `dsh-elab-cockpit`，右栏开 elab tab | agent 在跑、你顺手看：窄栏阶梯 + 日志尾 + 串口页 |

<a id="what"></a>

## 这是什么

```text
工具层  packages/dsh-elab-cockpit      面板 / elab_* agent 工具 / 进程托管（可卸载）
   │  唯一缝隙：loopback HTTP ICD（/api/* 命令 + /events SSE）
业务层  services/elab/** + cockpit/server.py
   │  编排 / 编译 / 烧录 / 调试 / 串口；STEP_META、KERNEL_PLANS、SERIAL_META 是词汇唯一事实源
   │  只读协议：pack.yaml（elab.pkg），不 import 包内文件
业务层  cockpit/web/**                 零依赖驾驶舱 UI（React 产物已入仓）
数据层  packs/** + market/index.json   芯片参数 / 厂商指纹 / 平台坑位 / 社区市场索引
工程    projects/**、examples/**       工程接入 YAML 与实弹样例
```

- 四层依赖**严格单向**，反向依赖被 `packages/dsh-elab-cockpit/test/boundary.test.mjs` 拦截。
- 三个收敛点：主机路径 → [`elab.host.yaml`](elab.host.yaml)；芯片差异 → `packs/**/chips/*.yaml`；工程接入 → `projects/*.yaml`。
- 工具层不 import 内核源码、不复制业务逻辑：它 `spawn` 同一个 `python -m cockpit.server`，把 API 与 SSE 反代过来。内核加一步，面板与 agent 工具自动跟上。

<a id="features"></a>

## 有什么功能

### ① 自动接入工程：不重搭，只探测

给一个工程目录，驾驶舱「＋ 适配」或 `elab adapt <path>` 自动探测芯片、框架类型、构建入口与置信度；写入后生成 `projects/<name>.yaml`，**人工接管的文件绝不覆盖**。

<img src="docs/tutorials/assets/webui/B-02-adapt-written.png" width="100%" alt="自动适配写入报告">

*`T1 可写 / 置信度 high`，写入后工程卡片自动出现并选中；只读探测在前，落盘在后*

### ② 一键闭环：编译 → 烧录 → 调试校验 → 串口判据

`elab loop -p <name>` 依次跑五个阶段，每步都留下可 grep 的证据行；也可只跑一步（`elab run --steps build`）。串口判据给出三态结论：`ok` / `failed` / `inconclusive`（能开但没收到约定关键字 = 未验证，不冒充成功）。

<div align="center">
<table>
<tr>
<td><img src="docs/tutorials/assets/webui/A-07-build-evidence.png" width="440" alt="五阶段全绿与内存占位"><br><sub>五阶段全绿：RAM 16.29% · FLASH 9.39%，产物 / 零改动守卫同屏</sub></td>
<td><img src="docs/tutorials/assets/webui/A-08-flash-ok.png" width="440" alt="烧录与校验证据"><br><sub>烧录 + 校验：双镜像 <code>Verified OK</code>，断到 <code>main.c:84</code></sub></td>
</tr>
</table>
</div>

### ③ 调试工作区：从一次真实 HardFault 收网

会话式调试器：开始 / 继续 / 暂停 / 单步 / 步入 / 步出 / 复位 / 关闭，十一个页签（调用栈、变量、寄存器、断点、监视、内存、反汇编、外设、RTOS 栈、审计、输出）。断点与监视持久化到 `projects/<name>.debug.json`（`rev` 乐观锁），关闭会话固定 `monitor reset run`，不会把板子留在 halt。

<div align="center">
<table>
<tr>
<td><img src="docs/tutorials/assets/debug-panel/03-callstack.png" width="420" alt="HardFault 调用栈"><br><sub>调用栈直接指出 <code>#2 0x54535250</code> 非法地址 → <code>#3 heartbeat_pack_buggy</code></sub></td>
<td><img src="docs/tutorials/assets/debug-panel/08-rtos.png" width="420" alt="FreeRTOS 栈水位"><br><sub>RTOS 栈水位：<code>heartbeat</code> 任务剩 0 字（红色 critical）</sub></td>
</tr>
</table>
</div>

`P1` 监视求值 · `P2` CMSIS-SVD 外设字段解码 · `P3` FreeRTOS 任务枚举与栈高水位；能力自描述在 `capabilities.meta.debug.features`，面板按它显示页签。

### ④ 串口工作区：字节为真值，文本只是投影

每个字节批次都带 `seq / dir / t / len / gap`，方向过滤、搜索、换表示全在客户端做，切视图不丢游标。四个视图：**行 / 字节 / 终端 / 波形**；发送面板支持文本 / ASCII / GBK / HEX + 行尾，TX 与 RX 同构入面。

<div align="center">
<table>
<tr>
<td><img src="docs/tutorials/assets/wave-panel/06-all-panel.png" width="340" alt="波形页与发送组件"><br><sub>波形页：FireWater 双通道正弦 · 多面板独立缩放 · 发送组件（PING 周期）</sub></td>
<td><img src="docs/tutorials/assets/wave-panel/07-full.png" width="580" alt="串口行视图"><br><sub>行视图：<code>[alive] tick=…</code> 心跳与固件启动日志同屏</sub></td>
</tr>
</table>
</div>

- 解码器是**会话属性**：agent 用 `elab_serial_monitor` / `elab_serial_decode` 选定后，面板波形页标「agent 选定」，读的是内核帧环的同一份帧。
- 监视是"看"不是证据：实时流只活环形缓冲；可复核判定走闭环 `monitor`。串口监视与闭环 run **双向 409 互斥**，agent 会话带租约到期自动释放端口。

### ⑤ 适配包与社区市场：芯片知识只住在数据层

骨架仓本身零芯片。芯片参数、厂商指纹、平台坑位全部来自适配包；包之间互不依赖，改包后 `elab pkg index` 重生成索引，CI 用 `--check` 拦漂移。

<div align="center">
<table>
<tr>
<td><img src="docs/tutorials/assets/webui/C-02-market-search.png" width="440" alt="市场搜索安装"><br><sub>市场搜索：<code>at32</code> 一键安装（来源 / 版本 / 芯片列表）</sub></td>
<td><img src="docs/tutorials/assets/webui/C-04-installed.png" width="440" alt="已安装包管理"><br><sub>已安装管理：启用 / 校验 / 更新 / 卸载，一次只启用一套</sub></td>
</tr>
</table>
</div>

内置 `st/stm32` 用 `elab pkg bootstrap`；其它厂商（如 `artery/at32`）走外置 GitHub 包仓 + 市场索引。贡献新芯片见 [market/CONTRIBUTING.md](market/CONTRIBUTING.md)。

### ⑥ DSH 面板：agent 在跑，你在旁边看

窄栏里是同一个闭环：阶梯进度、日志尾、FLASH/RAM 占位、构建/烧录/调试/串口四通道、串口四视图、调试工作区。插件首次打开自动下载内核归档并补齐工具链，宿主只需 Python ≥ 3.10。

<div align="center">
<table>
<tr>
<td><img src="docs/tutorials/assets/dsh/01-auto-probe-full.png" width="520" alt="DSH 右栏面板"><br><sub>DSH 右栏：对话与 ELAB 面板同屏；agent 发起 run 自动切到对应工程</sub></td>
<td><img src="docs/tutorials/assets/dsh/10-triple-ok.png" width="340" alt="DSH 三连全绿"><br><sub>三连全绿：编译（RAM/FLASH）→ 烧录 → 调试校验逐行落账</sub></td>
</tr>
</table>
</div>

安装：`dsh plugin --profile web add github:xkk6663/elab-flow#path:/packages/dsh-elab-cockpit`（或 `npm install dsh-elab-cockpit`），重载窗口后右栏出现 elab tab。

### ⑦ CLI：一条命令跑完，也能被 CI 直接调用

终端每行按类型着色：编译进度、warning、烧录 `Verified OK`、串口心跳不会混成一片灰字。退出码即结论：`0` ok / `1` failed / `2` inconclusive。

<div align="center">
<table>
<tr>
<td><img src="docs/tutorials/assets/cli-terminal/06-full-loop.png" width="520" alt="elab loop 终端输出"><br><sub><code>elab loop -p f411 -v</code>：五阶段分色，doctor 全绿 + build 进度</sub></td>
<td><img src="docs/tutorials/assets/cli-terminal/05-monitor.png" width="440" alt="monitor 阶段"><br><sub>monitor：波形行与心跳同屏，命中判据即退出</sub></td>
</tr>
</table>
</div>

### ⑧ OTA 双槽升级（F411CEU6 实弹样例）

`examples/STM32F411CEU6` + `examples/F411CEU6_BOOT` 是完整参考实现：boot / APP / 上位机 / 异常注入 / 双槽回滚全链路验证。

- **分区表唯一事实源**：适配包 `chips/*.yaml` 的 `ota_layout:`，构建期注入 `ota_layout_gen.h`，`doctor --deep` 三方对账。
- **坏固件自动回滚**：新固件写 INACTIVE 槽 → 试运行（trial 先记后跳）→ 耗尽打印 `=== ROLLBACK ===`；心跳正常则 `OTA_Confirm()` 晋级。
- **停等协议**：`AA [01|02] SEQ LEN DATA CRC32 EOF 55`，CRC 错 NAK 重传；每 1KB 记页，支持断点续传。
- **组合工程**：`ota_layout.boot_project: f411_boot` 让 `elab build -p f411` 级联构建；`elab flash` 按 boot bin 的 md5 指纹冻结台账。

### ⑨ Agent 工具：24 个 `elab_*`，与面板同源

写硬件 / 写盘的工具统一受 `allowAgentWrite`（默认关）；参数里的枚举来自内核自描述，面板不写死业务字段。

| 组 | 工具 |
|---|---|
| 看 | `elab_status` · `elab_preview`（只读 argv）· `elab_log` |
| 闭环 | `elab_build` · `elab_triple` · `elab_loop` · `elab_step` · `elab_cancel` |
| 工程与包 | `elab_adapt`（`write=false` 先看只读报告）· `elab_pkg` |
| 调试 | `elab_debug_open / control / inspect / breakpoint / wait / close` |
| 串口 | `elab_serial` · `_monitor` · `_read` · `_wait` · `_decode` · `_decoded` · `_capture` · `_widget` |

<a id="quickstart"></a>

## 怎么用

```bash
git clone git@github.com:xkk6663/elab-flow.git
cd elab-flow

./elab pkg bootstrap      # ① 安装内置包 st/stm32
./elab doctor             # ② 环境体检，先全绿再往下
./elab adapt ./my-project --write   # ③ 接入自己的工程（可先不加 --write 看只读报告）
./elab loop -p my-project -v        # ④ 一键闭环：体检→编译→烧录→调试校验→串口
python -m cockpit.server            # ⑤ 驾驶舱 → http://127.0.0.1:8333/
```

- 要求：**Python ≥ 3.10（无第三方依赖）**；上板另需 CMake + Ninja + ARM GCC + OpenOCD。Windows 用 `elab.cmd`，桌面场景直接双击 `cockpit.cmd`（幂等，已在跑只开 UI）。
- 没有探针时 `doctor` / `build` / `ci` 照样可跑，`loop` 会在 flash 步失败。
- 门禁：`elab ci` 与 GitHub Actions 共用 `ci/matrix.yaml`；门禁绿却零产物 → 红。

> 已实测：AT32F421G8U7（WorkBench 工程，自动接入）、STM32F103C8T6、STM32F411CEU6（CubeMX + boot 组合工程 / OTA 双槽），业务工程文件树均为 `untouched`。

**工具链**（DSH 插件首次打开会按官方上游直链自动安装，仅 Windows x64；其它平台先探测本机 PATH）：

| 工具 | 版本 | 覆盖环境变量 |
|---|---|---|
| `arm-none-eabi-gcc` | 13.3.1 | `ELAB_ARM_GCC_ROOT` |
| CMake | 3.28.1 | `ELAB_CMAKE` |
| Ninja | 1.11.1 | `ELAB_NINJA` |
| OpenOCD | 0.12.0-3 | `ELAB_OPENOCD` / `ELAB_OPENOCD_SCRIPTS` |

**探针是数据不是代码**：`elab.host.yaml` 的 `probes.list` 内置 `atlink` / `dap` / `stlink` / `jlink`，工程接入文件只声明用哪个（默认取 `probes.default`）：

```yaml
# projects/<name>.yaml
debug:
  probe: stlink     # atlink | dap | stlink | jlink
```

`interface cfg` 属于探针、`target cfg` 属于芯片，两者正交 —— 同一个 CMSIS-DAP 换 target cfg 就能连不同厂商的芯片。新探针在 `probes.list` 加一条 `{backend, interface_cfg, transport, speed}` 即可。

<a id="repo"></a>

## 仓库结构

```text
services/elab/**          内核：闭环编排、编译/烧录/调试、串口字节面、OTA、适配包协议
cockpit/server.py         内核 HTTP 面 + 自描述（STEP_META / KERNEL_PLANS）
cockpit/web/**            独立驾驶舱 UI（产物已入仓）
packs/official|installed  芯片适配包（骨架仓不含芯片；installed/ 不入库）
market/index.json         零服务器社区市场索引
packages/dsh-elab-cockpit DSH 插件（面板 / 进程托管 / elab_* 工具）
projects/**               工程接入 YAML
examples/**               实弹样例（F411 OTA、STM32/AT32 工程）
tests/ · ci/              内核测试与本地/云端门禁
docs/**                   教程、设计约束、架构分析
```

- 市场与 npm 都直接取自本仓 `packages/dsh-elab-cockpit` 子目录，没有镜像/分发仓。
- 分层规则见 [AGENTS.md](AGENTS.md)；`packs/installed/` 是用户按需安装的落点，随仓只提交 `packs/official/**` 与 `market/index.json`。

<a id="docs"></a>

## 文档

| # | 教程 | 适合 |
|---|---|---|
| 01 | [芯片开发上手 · 独立 WebUI 全流程](docs/tutorials/01-芯片开发上手_独立WebUI.md) | 换新芯片 / 新板，先过心跳第一关 |
| 02 | [市场适配包贡献](docs/tutorials/02-市场适配包贡献.md) | 给新厂商做适配包并上市场 |
| 03 | [插件市场使用 · 独立 WebUI](docs/tutorials/03-插件市场使用_独立WebUI.md) | 零环境装插件 + 首启向导 |
| 04 | [调试工作区上手 · 真实 HardFault 排错](docs/tutorials/04-调试面板上手_STM32F103C8T6.md) | 断点 / 监视 / 外设 / RTOS 栈 |
| 05 | [DSH 插件上手 · 右栏闭环 + 调试页签](docs/tutorials/05-DSH插件上手_STM32F103C8T6.md) | DSH 主线 |
| 06 | [CLI 终端闭环 · 真机 5 阶段](docs/tutorials/06-CLI终端闭环上手.md) | 只想用命令行 |
| 07 | [波形面板使用](docs/tutorials/07-波形面板使用.md) | 解码器 / 多面板 / 缩放暂停 |
| 08 | [串口压力测试报告 · STM32F411CEU6](docs/tutorials/08-串口压力测试报告_STM32F411CEU6.md) | 高吞吐与丢数判定 |

深度文档（架构 / 设计约束 C1–C36 / ICD / OTA）见 [docs/README.md](docs/README.md)，版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 已知限制

- `onhw-gate` 需 self-hosted 探针（云端编译门禁不受影响）；`profiles/*.yaml` 插件化装配与 `elab skill --adapt` 未实现。
- 常驻监视的实时流只活环形缓冲（重启即失）；要证据走闭环 `monitor` 或「录制」。
- 字节视图只渲染最近若干批（驾驶舱 300 / DSH 200）；波形共享解码最多看帧环 1024 帧，更早的用「导出 / 录制」留档。
- 录制产物是有界 JSONL（可回放），界面暂无回放器；双槽传输中拔电续传待复验。
