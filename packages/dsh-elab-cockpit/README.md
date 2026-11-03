# dsh-elab-cockpit

> 本目录即插件包本体，位于主仓 [`xkk6663/elab-flow`](https://github.com/xkk6663/elab-flow)
> 的 `packages/dsh-elab-cockpit/`。插件市场按该子目录安装，npm 也从该目录发布 ——
> 没有额外的镜像/分发仓。开发、提 issue、跑门禁请到主仓（cwd = 本目录）。

elab-Flow 闭环驾驶舱的 DSH 插件 —— 一块**嵌入式闭环开发**面板，也是一个**给用户看的驾驶舱**。

> agent 在面板里发起「发现 → 适配 → 编译 → 烧录 → 调试校验 → 串口闭环」，用户在同一块窄栏里实时看到
> 阶梯进度、日志尾、RAM/FLASH 占用、串口四视图、波形与**调试工作区**（单步 / 断点 / 变量 / 寄存器）——
> 不是“agent 闷头跑完再报一句结果”。
> 串口发送面板（**自动格式识别 / 发送历史 / 定时发送**）在 DSH 窄栏与独立 WebUI 右侧栏是同一套：
> 同一条 loopback ICD、同一份内核编码入口（`serialterm.resolve_payload`）、同一个预览口径。
> 参数化发送组件仍保留给 **agent**（`elab_serial_widget`，按固定格式发送），面板不再展示组件 UI。

**插件瘦、依赖自动补齐**：插件只含工具层（面板 / 进程托管 / `elab_*` agent 工具），不内置内核源码、
芯片数据或工具二进制。首次打开面板会**自动下载内核归档并安装工具链**，唯一需要事先准备的是主机 Python 3.10+。

## 面板长什么样（真实 DSH 宿主截图）

闭环 / 串口 / 调试截图取自同一台实机、同一次 DSH 会话：STM32F103C8T6 + CMSIS-DAP + COM10@115200，
DSH Desktop 深色主题（2026-11-03）。**全部为绝对地址**，市场页可直接渲染。

### 认清面板：一个右侧栏，三块信息

页签行（`ELAB` + 刷新/设置 + **`▶|` 调试工作区入口**）→ 工程行（下拉 / 归属 / 内核状态 / ↻）→
适配横幅（自动探测结论，只读不落盘）→ 阶段梯（`编译 烧录 调试校验`：状态点 · 用时 · 证据）→
手动条（`三连` `闭环` `取消` `预览` + 单步 `▶ 构建 / 烧录 / 调试 / 串口`）→
通道日志（`构建|烧录|调试|串口` 页签 + 过滤/搜索/导出 + 面板放大/恢复）→ 底部串口工作区（行/字节/终端/波形 + 通用发送框）。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/docs/tutorials/assets/dsh/01-auto-probe-full.png" width="330" alt="DSH 全窗口：右侧栏 ELAB 面板">

### 闭环三连：每一步落账用时与证据

编译 `RAM 57.58% · FLASH 58.66%`（取自 `.map`）→ 烧录 `Verified OK`（探针回读）→
调试校验停在 `main.c:79`。零改动时显示 `ninja: no work to do.`（构建系统确认无变更，阶段照常继续）；
任何一步失败即中断，失败行以红色语气落在对应通道。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/docs/tutorials/assets/dsh/10-triple-ok.png" width="330" alt="三连全绿：用时与证据逐行落账">

### 串口心跳：判活两条硬指标

`▶ 串口` 自动选口 @115200：相邻 `[alive]` 间隔 ≈ 1.000 s、每次 `toggles` 严格 +2（与板载 LED 同一时基）。
运行中按钮变 **`■ 关闭监视`**，再点即关闭并释放串口。判定纪律（C36）：agent 只凭串口计数判活，
「LED 均匀闪烁」必须由人肉眼确认。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/docs/tutorials/assets/dsh/11-serial-alive.png" width="330" alt="串口 1 Hz 心跳：tick 递增、toggles 每次 +2">

### 调试工作区（`▶|` 入口）

面板右上角 `▶|` → 「开始调试」：内核起 `openocd` + `arm-none-eabi-gdb` → `monitor reset halt` →
下载 ELF → 停在 `main`。工具栏（继续 / 暂停 / 单步 / 步入 / 步出 / 指令 / 复位 / 关闭）+ 位置条（函数 @ 文件：行 · PC）+
子页签（调用栈 / 变量 / 寄存器 / 断点 / 监视 / 内存 / 反汇编 / 外设 / RTOS 栈 / 审计 / 输出，按内核 `meta.debug.features` 出现）。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/docs/tutorials/assets/dsh/04-debug-stopped.png" width="330" alt="停在 main：工具栏 + 位置条 + 调用栈">

函数断点：窄栏没有源码 gutter，用**函数 / 地址断点**（可加条件）。复位 → 继续 → 命中计数 `×1`，
调用栈同时给出 `#0 HAL_UART_Receive_IT` 与 `#1 main` 两级帧。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/docs/tutorials/assets/dsh/12-debug-hit-bp.png" width="330" alt="断点命中：两级栈帧 + 各自文件/行/地址">

寄存器按内核分组，十六进制 + 自然值，`xPSR` 带标志位；与 Agent 读到的是同一份会话数据（人机同源）。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/docs/tutorials/assets/dsh/06-debug-regs.png" width="330" alt="内核寄存器：pc 与位置条一致">

「关闭」= `monitor reset run`：目标复位并恢复运行，openocd/gdb 退出，面板回到「开始调试」、输出保留。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/docs/tutorials/assets/dsh/09-debug-closed.png" width="330" alt="关闭会话：自动恢复运行">

### 波形面板功能（独立 WebUI 实机）

下面三张来自独立 WebUI 的串口波形页，与 DSH 窄栏共用同一套 `WaveChart` 与 ICD
（只是宽度与主题令牌不同）。

默认视图：FireWater 双通道正弦，帧环、窗口与挤出计数如实标注。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/docs/tutorials/assets/wave-panel/01-wave-default.png" width="330" alt="波形默认视图：FireWater 双通道正弦">

＋新建面板：每个面板独立缩放 / 平移 / 跟随，互不影响。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/docs/tutorials/assets/wave-panel/02-new-panel.png" width="330" alt="新建面板：独立缩放与通道">

通道绑定：CH0 / CH1 决定当前面板画哪几条曲线。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/docs/tutorials/assets/wave-panel/03-bind-ch0.png" width="330" alt="通道绑定 CH0">

## 与独立 WebUI（右侧栏）的一致性

| 面 | DSH 窄栏 | 独立 WebUI 右侧栏 | 一致性 |
|---|---|---|---|
| 数据通道 | loopback HTTP ICD（`/elab/api/serial/*`） | 同一 ICD | 同一份契约，工具层不 import 内核 |
| 发送编码 | `serialterm.resolve_payload`（`auto/utf8/gbk/hex` + 行尾） | 同一函数 | 预览字节 = 发送字节 |
| 历史 / 定时 | `{text,format,eol}` × 50；`POST /api/serial/loop` | 同一份 UI 核心纯函数 | 同一去重与轮询语义 |
| 波形 | 多面板 + 通道绑定 + 面板级跟随 | 同一套 `WaveChart` 行为 | 只是宽度与主题令牌不同 |

窄栏只做两件事上的取舍：**布局更紧凑**（发送栏与预览行更短），以及
**跟随口径**——文本视图（行 / 字节 / 终端）跟随最新数据，波形视图不参与文本跟随（它有自己的面板级跟随），
否则窄栏内容溢出时贴底滚动会把「全部 / ＋新建面板 / 通道绑定」整行滚出可视区。

## 前置条件

| 依赖 | 说明 |
|---|---|
| **elab 内核** | 首次打开自动下载（固定版本 `v<ver>` → `~/.dsh/elab/kernels/v<ver>/`）；下载失败自动回落浅克隆；也可在设置页指定已有检出 |
| **Python 3.10+** | **唯一不能自动安装**的依赖：需在 PATH 里，或在设置页把「python 路径」填成绝对路径（缺失时自动准备暂停并给出指引） |
| 可选 `pyserial` | 串口读写；缺失时其它功能不受影响 |
| 工具链 | `arm-none-eabi-gcc 13.3.1` / `CMake 3.28.1` / `Ninja 1.11.1` / `OpenOCD 0.12.0-3`：缺件时**自动安装**到 `~/.dsh/elab/env`（xpack / Kitware / ninja-build 官方上游直链 + sha256，约 400 MB，仅 Windows x64）；已装过自己的则跳过。版本清单见 [`envpacks/manifest.json`](envpacks/manifest.json) |
| 探针 | 不绑定品牌：`elab.host.yaml: probes.list` 内置 `atlink` / `dap` / `stlink` / `jlink`，工程接入文件用 `debug.probe` 选择。ST-Link 免装厂商软件；J-Link 需先装 SEGGER 驱动（仍由 OpenOCD 驱动） |
| DSH | `>= 0.2.0-rc.1` |

也可以手动准备内核（三种入口共用同一内核事件流）：

```bash
git clone --depth 1 https://github.com/xkk6663/elab-flow.git D:\elab-flow
```

仓库内的 `elab.cmd`（Windows）或 `python -m elab` 也可单独使用。

## 首次打开：自动准备（零前置）

面板未找到内核时不再是一行错误 + 一堆手动按钮，而是**自动准备**：

1. **环境自检**——只读探测 python / pyserial / git（`GET /elab/env`，不启动内核）；
2. **Python 缺失即暂停**——只显示安装指引（插件**绝不代装** Python）；
3. **内核就绪**——自动下载固定版本归档到 `~/.dsh/elab/kernels/v<ver>/`；下载失败自动回落
   浅克隆（`~/.dsh/elab/kernels/clone`）；两条都失败才显示「重试」；
4. **工具链就绪**——探测缺件（arm-gcc / cmake / ninja / openocd）时自动下载环境包
   （sha256 校验 → 解压 → 版本探测，失败即中断）；已齐全则跳过；
5. **工程接入**——内核就绪后用面板里的「＋适配」接入固件目录。

自动流程幂等（已完成的不重复下载）、同一时间只跑一份、失败/暂停可单独「重试」；
设置页可关闭（`autoProvision=false`），关闭后回到原四步手动向导。
不做自动 `pip install`、不自动 `git pull`（升级内核仍手动 `git -C <elabRoot> pull --ff-only`）。

工具链装好后靠环境变量（`ELAB_ARM_GCC_ROOT` / `ELAB_CMAKE` / `ELAB_NINJA` /
`ELAB_OPENOCD` / `ELAB_OPENOCD_SCRIPTS`）注入内核子进程，**不会改写**你仓库里的
`elab.host.yaml`；你自己已装好的工具链仍然优先生效（清单里装过的目录只是前置进 PATH）。

设置页（DSH 设置 → ELAB 驾驶舱）可改 `elabRoot` / `pythonPath`，保存即热更新并写入
`~/.dsh/dsh-elab-cockpit.config.json`，重启仍生效；同页的「环境」分段复用同一探测结果。

## 面板结构

```
┌ 工程选择（会话 cwd 自动发现；↻ 重载 / ⚙ 设置）
├ 档位：三连（编译+烧录+调试） / 闭环（体检→编译→烧录→调试→串口闭环） / 取消 / 预览
├ 单步：▶ 构建 / ▶ 烧录 / ▶ 调试 / ▶ 串口（监视运行时变 ■ 关闭监视，再点即关闭并释放串口）
├ 通道页签：构建 | 烧录 | 调试 | 串口   （每通道独立日志 / 进度 / 占用）
└ 串口工作区：行 | 字节 | 终端 | 波形     （＋ 组件行 ＋ 发送栏）
```

- **阶梯灯**来自内核自描述（`cockpit/server.py` 的 `STEP_META` / `KERNEL_PLANS`），插件只渲染、不写死步骤。
- **RAM / FLASH 占用**是从 elf 里读出的实数，不是估算。
- 档位不可用的步骤会置灰（例如没有探针时 `onhw` 步骤被剔除），命令视图与面板视图来自同一判定。
- 一键闭环的每一步都走内核编排；SSE 事件原样透传，断线可用 `id:` 游标续传。

## DSH 界面：agent 调用教程（跨工程生效）

### 上手流程

1. **装**：`dsh plugin --profile web add github:xkk6663/elab-flow#path:/packages/dsh-elab-cockpit`，重载窗口后右栏出现 **ELAB** tab。
2. **开**：点开 ELAB tab，保持与对话同屏。面板按会话 cwd 找 elab 根，工程轨列出 `projects/*.yaml` 与芯片事实。
3. **说**：第一次先让它调 `elab_guide` 自检；之后直接下指令（见下方话术表）。
4. **看**：agent 发起 run 后，面板**自动切到对应工程**，阶梯与四通道实时刷新，发起方标 `agent`，你随时可点「■ 取消」。

装好插件后，**不需要在每个新工程里再写 `AGENTS.md` 或 skill**，agent 就能知道这些工具该怎么用：

| 机制 | 生效范围 | 内容 |
|---|---|---|
| `elab_*` 工具注册 | 进程级（所有会话） | 编译 / 烧录 / 调试 / 串口的结构化工具；`autoExposeTools` 默认开 |
| 常驻系统提示段 | 进程级（所有会话） | 插件挂载时注册 `plugin:elab-cockpit`：工具有哪些、推荐顺序、单飞/互斥/写门控/判活纪律 |
| `elab_guide` 工具 | 按需调用 | 完整工具清单 + 规则 + 面板说明；只读、不启动内核，第一次接手工程或不确定用哪个工具时先调它 |
| `.agents/skills` / `AGENTS.md` | 工作区级 | 只留给芯片长尾知识（引脚、坑位、验收清单）与工程约定，不再是必需项 |

> 常驻段依赖宿主挂载 `@deepseek-ai/dsh-system-prompt`；未挂载时插件静默跳过这一层，
> 工具照常可用，agent 可调 `elab_guide` 得到同一份文案。

### 一句话使唤它

```
你：用 elab 跑三连，把 RAM/FLASH 占用和失败日志给我。
agent：elab_status（拿工程名）→ elab_triple → elab_log
```

| 你想要 | 让 agent 走的顺序 |
|---|---|
| 只编译 / 看占用 | `elab_status` → `elab_build` → `elab_log` |
| 编译 + 烧录 + 调试校验 | `elab_status` → `elab_triple` → `elab_log` |
| 完整体检 + 串口闭环 | `elab_status` → `elab_loop` → `elab_log` |
| 看运行日志 / 判活 | `elab_serial_monitor(open)` → `elab_serial_wait`（等 `[alive]`）→ `elab_serial_read` |
| 单步 / 断点 / 寄存器 | `elab_debug_open` → `elab_debug_control` → `elab_debug_inspect` → `elab_debug_close` |
| 接新工程 / 换芯片包 | `elab_adapt`（`write=false` 先探测）→ `elab_pkg(install/activate)` |

### 三条硬纪律（agent 会从提示段与 `elab_guide` 读到）

- **单飞**：同一会话同时最多 1 个 run；`human-busy` 时等结束或请用户点「■ 取消」，不重试刷屏。
- **互斥与门控**：串口监视占用时烧录/调试返回 `serial-busy`；串口写、适配写盘、录制默认被
  `allowAgentWrite` 拒绝（设置页可开），被拒时如实告知用户，不绕路。
- **判活**：agent 只凭串口 `tick` / `toggles` 判活；「LED 均匀闪烁」必须由用户肉眼确认（C36）。

### 可视化与人机同源

agent 发起的 run 会带 `agent` 标落在右栏面板，阶梯自动点亮、四通道日志实时滚动，用户随时可取消；
agent 读的 `elab_status` / `elab_log` / 调试会话与面板显示的是**同一份内核数据**，不存在两套状态。

## 串口工作区

| 能力 | 说明 |
|---|---|
| 四视图 | **行**（解行后的文本）/ **字节**（原始批次）/ **终端**（ANSI 着色）/ **波形**（解码折线） |
| 选口 | 默认 `auto`（自动选口），也可指定 COMx；波特率默认 115200 |
| 方向 / 编码 | 方向过滤（全部 / RX / TX…）；HEX / ASCII 显示；行尾 CRLF / LF / none |
| 跟随 | 文本视图贴最新：按钮在「▾ 跟随 / ↺ 恢复」间切换，**只**由按钮控制（不反推 scroll 事件） |
| 缓冲上限 | 本地保留 行 2000 / 批 4096 / 字节 1 MB / 解码帧 1024；高流量时内核帧环兜底并标注「帧环挤出」 |
| 录制 / 回放 | `录制` 落盘可回放；`回放` 读录制文件按同一解码路径重画 |
| 导出 / 清空 | 当前视图导出；清空只清面板缓冲，不影响内核任务 |
| 解码器 | JustFloat（`N×4` 小端 float + 尾 `00 00 80 7F`）与 FireWater（ASCII 每行一个采样）等；可会话级共享（agent 选 / 人选） |
| 多面板 / 通道绑定 | `＋新建面板` 独立缩放平移；「通道绑定」CH0…CHn 决定该面板画哪几条；面板级「暂停跟随」冻结时间窗 |
| 自动格式 | 发送框默认 `自动`：明确 HEX 写法（`0x`/`\x` 前缀或分隔符 + 全十六进制 + 偶数字节）按字节发，其余按文本 |
| 发送历史 | 记住前 50 条 `{文本, 格式, 行尾}`，同内容去重移尾，点历史即回填并可直接重发 |
| 定时发送 | `⏵ 定时` 按固定间隔重复发送（`POST /api/serial/loop`，内核瞬态任务），`■ 停止定时` 立即取消 |

> 波形页若只看到 `0 帧 · 0 通道` 且「半帧」字节数一直涨，多半是解码器没选对（设备发 ASCII 就别选 JustFloat）。

## 通用发送面板

面板只保留一个入口：**输入内容 → 自动/手动选格式与行尾 → 预览字节 → 单次或定时发送**。
编码与预览都在服务端完成（`serialterm.resolve_payload`），前端不另立一套规则，
因此两个检出、两块面板看到的字节永远一致。

- 格式：`自动 / ascii / utf8 / gbk / hex`；HEX 不追加行尾，文本按选择追加 `none/LF/CR/CRLF/Tab`。
- 历史：见上表；升级前保存的纯字符串历史会被自动迁移成 `{text, format, eol}`。
- 定时：间隔 ≥ 20 ms、总时长 ≤ 600 s，固定节拍，上一轮没跑完记 `跳过`、不补发。

### 参数化组件（仅 agent）

`projects/<name>.widgets.json` 的组件模型（send/delay/wait 序列、`repeat`、`rev` 乐观锁）仍然保留，
但**不在面板展示**：它作为 agent 的「固定格式发送夹具」，通过 `elab_serial_widget`
（list / run / status / cancel / save / delete）使用。`allowAgentWrite=false`（默认）时运行与落盘被拒。

组件边界不变：文件 ≤ 64 KB、≤ 64 组件、≤ 20 步、≤ 32 参数；单次运行 ≤ 60 s、周期总时长 ≤ 600 s。

## 实机验证（2026-11-03，STM32F103C8T6 / COM10）

- 硬件：STM32F103C8T6（64 KB Flash / 20 KB RAM）+ CMSIS-DAP 探针 + COM10，工程 `STM32F103C8T6`
- 闭环：`doctor` → `build --clean` → `flash`（Verified OK）→ `monitor` 判 **ok**
- 串口：`auto` 选口 @115200；复位后打印 `[log] HAL init / clock / GPIO / DMA / UART1 / main loop`，
  主循环每秒 `[alive] test tick=…` 心跳；串口日志能直接看出程序跑到哪一步
- 收发：`PING` → `[cmd] PING -> PONG`；`STAT` 返回 `stage=main_loop` / tick / cmds / rx 字节；
  `ECHO hello-elab` 原样回显——TX → 设备 → RX 全链路验证
- 自动格式：`0x0A 0xFF` 预览 `2 B · 0A FF · 识别为 HEX`，与真发字节一致
- 定时发送：`STAT` / 200ms 实测运行态连续回显，`■ 停止定时` 后 1s 内退出
- 历史：`↑` 恢复上一条 `STAT`（含格式与行尾）
- 截图：见 [波形面板使用教程](../../docs/tutorials/07-波形面板使用.md)
- DSH 右侧栏全流程（含**调试工作区**：单步 / 断点 / 变量 / 寄存器 / 关闭恢复）：
  见 [DSH 插件实机上手](../../docs/tutorials/05-DSH插件上手_STM32F103C8T6.md)

### 既有验证（2026-11-02，STM32F411CEU6 波形）

- 硬件：STM32F411CEU6（512 KB Flash / 128 KB RAM）+ CMSIS-DAP 探针 + COM10，工程 `f411`
- 串口：`auto` 选口 @115200；FireWater 两通道正弦 + 每秒 `[alive] tick=…` 心跳
- 波形：`1024 帧（显示）· 共 4773 帧 · 2 通道 · 跳过 58`（「跳过」正是心跳等非数字行）
- 组件（历史，M2 时期的面板 UI）：`PING 周期（100ms）` 实测 `运行中 · 第 35 轮 · 280 B`，板子回 `PONG:7`；
  暂停 → `已暂停 · 第 50 轮 · 400 B`；停止 → `已停止 · 400 B`
- 跟随：行缓冲封顶 2000 行后仍持续贴最新行；点「↺ 恢复」立即回底，点「▾ 跟随」后上滚保持位置

## 已知限制

- 不内置内核、不随包分发工具二进制；内核与工具链**首次打开自动下载**，可关闭自动准备。
- **主机 Python 3.10+ 必须事先存在**（插件不打包、不代装）。
- 环境包当前只覆盖 **Windows x64**；其它平台先用本机工具链（探测仍可正常工作）。
- 离线环境需预先准备内核检出与环境包解压目录。
- 环境包清单里的 `sha256` 未核对的条目会按首次下载记录（TOFU）并给出告警。
- 芯片支持来自适配包（`packs/official/**` 与社区市场），插件不承载芯片知识。
- 内核版本低于 `2.1.0` 时只提示，不阻断；步骤标签会退回插件内置默认。
- 常驻系统提示段依赖宿主挂载 `@deepseek-ai/dsh-system-prompt`；缺失时只剩工具 schema 与 `elab_guide`，agent 不一定主动想起这些工具。
- 串口组件（仅 agent）只支持 UTF-8 / HEX 文本模板；二进制大块灌装（OTA 之外的固件下载）不在组件模型内。
- 自动格式是**保守识别**：裸十六进制字符串（如 `1234`）按文本发送，要发字节请写 `0x12 0x34` 或 `12,34`。

## 故障排查

| 现象 | 处理 |
|---|---|
| 向导第 1 步 python 红 | 装 Python 3.10+ 或在设置页填绝对路径 |
| 第 2 步一直找不到内核 | 确认目录同时有 `cockpit/server.py` 与 `services/elab` |
| 面板能开但编译按钮报错 | 看设置页「环境」红灯项；内核 `elab doctor` 给更准确的结论 |
| 串口打不开 | 装 `pyserial`（`pip install pyserial`），并确认没有被其它进程占用 |
| 波形 `0 帧 · 0 通道` | 解码器与设备输出协议不匹配（ASCII 行请选 FireWater） |
| 定时发送不动 | 上一轮未发完会记「跳过」；检查间隔 ≥ 20 ms、闭环/组件任务是否占用串口 |
| 自动识别成了文本 | 裸十六进制按文本处理；改写 `0xNN` 或 `NN,NN` 后看预览行确认 |
| 面板提示"内核旧" | `git -C <elabRoot> pull --ff-only` 后重开面板 |
| agent 不会用 elab，只回 "Install or manage DSH plugins" | 插件未启用 / `autoExposeTools` 被关 / 宿主未挂 `dsh-system-prompt` | 启用插件并让 agent 调 `elab_guide` 验证工具面；仍不行则整体重启 DSH Desktop |

## 安装

本目录即插件包本体（`package.json` 自带 `dsh.bundle` / `dsh.client` 声明）。

```bash
# DSH 市场（条目指向主仓子目录）
dsh plugin --profile web add github:xkk6663/elab-flow#path:/packages/dsh-elab-cockpit

# npm
npm install dsh-elab-cockpit
```

本地开发时把本目录链接进 DSH profile 的 `node_modules` 即可，无需拷贝源码。

## 开发与验证（cwd = 主仓的 `packages/dsh-elab-cockpit`）

```bash
npm install          # devDeps：typescript / esbuild / @types/*
npm test             # 单测（含 boundary / style-rules / envpack 门禁）
npm run build        # Host 半 tsc → lib + Client 半打包 + 契约校验
```

分层纪律：工具层不 import 内核源码，只走 loopback HTTP ICD；门禁见 `test/boundary.test.mjs`。
主题纪律：组件只用 `--elab-*` 令牌，`--dsw-*` 只在 `src/adapters/dsh-web/theme/dsw-map.ts`；门禁见 `test/style-rules.test.mjs`。

## License

MIT
