# dsh-elab-cockpit

> 本目录即插件包本体，位于主仓 [`xkk6663/elab-flow`](https://github.com/xkk6663/elab-flow)
> 的 `packages/dsh-elab-cockpit/`。插件市场按该子目录安装，npm 也从该目录发布 ——
> 没有额外的镜像/分发仓。开发、提 issue、跑门禁请到主仓（cwd = 本目录）。

elab-Flow 闭环驾驶舱的 DSH 插件 —— 一块**嵌入式闭环开发**面板，也是一个**给用户看的驾驶舱**。

> agent 在面板里发起「发现 → 适配 → 编译 → 烧录 → 调试校验 → 串口闭环」，用户在同一块窄栏里实时看到
> 阶梯进度、日志尾、RAM/FLASH 占用、串口四视图与波形 —— 不是“agent 闷头跑完再报一句结果”。
> 串口发送面板（**自动格式识别 / 发送历史 / 定时发送**）在 DSH 窄栏与独立 WebUI 右侧栏是同一套：
> 同一条 loopback ICD、同一份内核编码入口（`serialterm.resolve_payload`）、同一个预览口径。
> 参数化发送组件仍保留给 **agent**（`elab_serial_widget`，按固定格式发送），面板不再展示组件 UI。

**插件瘦、依赖自动补齐**：插件只含工具层（面板 / 进程托管 / `elab_*` agent 工具），不内置内核源码、
芯片数据或工具二进制。首次打开面板会**自动下载内核归档并安装工具链**，唯一需要事先准备的是主机 Python 3.10+。

## 面板长什么样（真实 DSH 宿主截图）

截图全部取自真实的 DSH Desktop 右侧栏（`sidebar.right` 槽位，宽 440 px），硬件是
STM32F411CEU6 + CMSIS-DAP + COM10，工程 `f411`；同一次运行里串口正在输出 FireWater 两通道正弦。

### 行视图：设备原始数据 + 真流量统计

`[alive] tick=…` 心跳与 `-0.486,0.486` 正弦逐行滚动；右上角 `72 044 B · 275 批` 是真实 RX 流量；
底部是通用发送栏（自动格式 / 发送历史 / 定时）。**跟随**只由「▾ 跟随 / ↺ 恢复」按钮控制，始终贴最新一行。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/packages/dsh-elab-cockpit/assets/dsh-serial-lines.png" width="330" alt="DSH 窄栏·串口行视图：正弦数值与心跳">

### 波形视图：数字变曲线，通道可绑定

FireWater 解码器把 ASCII 行解成 2 通道；「通道绑定」CH0 / CH1 决定当前面板画哪几条，
面板级「❚❚ 暂停跟随」冻结时间窗，「− / ＋ / ⤾」控制缩放与平移。总帧数、通道数与
「帧环挤出」（内核帧环为高流量兜底的滑动窗口）都如实标注。

<img src="https://raw.githubusercontent.com/xkk6663/elab-flow/main/packages/dsh-elab-cockpit/assets/dsh-serial-wave.png" width="330" alt="DSH 窄栏·串口波形视图：双通道正弦、通道绑定与缩放">

### 通用发送：自动识别 → 服务端预览 → 历史 → 定时

输入框默认 `自动` 格式：`0x0A 0xFF`、`0A,FF` 这类明确 HEX 写法按字节发；裸 `1234` 按文本发
（避免误判）。预览字节由**服务端**渲染，与真正发送共用 `resolve_payload`，所以“看到的就是发出去的”。
发送过的内容按 `{文本, 格式, 行尾}` 记入历史（最多 50 条），点历史即可重发。

`⏵ 定时` 按固定间隔重复发送输入框内容（内核瞬态任务，不落盘、不写工程文件）；
`■ 停止定时` 立即 `cancelled`，1 s 内退出、不再发后续轮次。

### 波形面板功能（独立 WebUI 实机）

下面三张来自独立 WebUI 的串口波形页，与 DSH 窄栏共用同一套 `WaveChart` 与 ICD
（只是宽度与主题令牌不同）。**使用绝对地址**，市场页才能把 README 里的图片渲染出来。

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
| 工具链 | `arm-none-eabi-gcc` / `cmake` / `ninja` / `openocd`：缺件时**自动安装**到 `~/.dsh/elab/env`（官方上游直链 + sha256，约 400 MB，仅 Windows x64）；已装过自己的则跳过 |
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
├ 单步：▶ 构建 / ▶ 烧录 / ▶ 调试 / ▶ 串口
├ 通道页签：构建 | 烧录 | 调试 | 串口   （每通道独立日志 / 进度 / 占用）
└ 串口工作区：行 | 字节 | 终端 | 波形     （＋ 组件行 ＋ 发送栏）
```

- **阶梯灯**来自内核自描述（`cockpit/server.py` 的 `STEP_META` / `KERNEL_PLANS`），插件只渲染、不写死步骤。
- **RAM / FLASH 占用**是从 elf 里读出的实数，不是估算。
- 档位不可用的步骤会置灰（例如没有探针时 `onhw` 步骤被剔除），命令视图与面板视图来自同一判定。
- 一键闭环的每一步都走内核编排；SSE 事件原样透传，断线可用 `id:` 游标续传。

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
- 截图：见 [串口面板使用教程](../../docs/tutorials/wave-panel-usage.md)

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
