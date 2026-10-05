# ELAB-Flow

> **一套工具链 + 一套流程，驱动不同芯片的编译 / 烧录 / 调试闭环。**
>
> 业务代码留在自己的文件夹里一个字不动，elab 挂在外面把流水线接上去。

**当前版本 V1.0.0（2026-10-05，首个正式发布）** · Python 仅标准库 · 前端产物已入仓
· 上板验收：AT32 ×2 + STM32 ×1 · 单元 151/151 · 集成 37/37

- 📋 **发布说明**：[CHANGELOG.md](CHANGELOG.md)（V1.0.0 功能总览 / 验收证据 / 已知限制）
- 🚀 **三十秒上手**：双击 `cockpit.cmd`（Windows 桌面一键启动），或
  `python -m cockpit.server` → <http://127.0.0.1:3333/>
- 🏗️ **架构**：八层（芯片卡 → YAML 接入 → CLI 闭环 → CI → 事件流 → 驾驶舱），
  逐层细节见下文

---

## 1. 这是什么

嵌入式项目常见的问题是：**每换一颗芯片，就要重搭一遍工程、重配一遍工具链、重写一遍构建脚本**。
STM32CubeMX 生成一套、AT32 WorkBench 生成一套、Keil/IAR 又各一套 —— 工具链版本靠 PATH 运气，
烧录参数散落在 IDE 配置里，CI 只能编个 host 单测，真机验证全靠手工。

**ELAB-Flow 要做的不是"一套代码跑不同平台"，而是"一套工具链和流程跑不同芯片"。**

| | ELAB-Flow 做 | ELAB-Flow **不**做 |
|---|---|---|
| 跨芯片 | ✅ 同一句 `elab build -p X` 编译不同厂商、不同内核的芯片 | ❌ 不做代码级可移植层 / 弱符号端口 / 运行时平台抽象 |
| 业务代码 | ✅ 原地不动，一个字不改 | ❌ 不搬代码、不重组目录、不建 `apps/` `framework/` |
| 工具链 | ✅ 一份通用的 `gcc.cmake`，差异只由芯片 YAML 驱动 | ❌ 不为每颗芯片各写一份工具链文件 |
| 主机环境 | ✅ 所有主机路径集中在一份 `elab.host.yaml` | ❌ 不在各处硬编码绝对路径 |

### 「外骨骼原则」

业务代码是**器官**，elab 是**外骨骼**：外骨骼不改器官，只负责把器官接到流水线上。
构建前后 elab 会对业务工程做**文件树快照**（路径 + size + mtime），
自动验证 `untouched == true` —— 这不是一句承诺，是一个可断言的结果。

> 想看它到底调了哪些**主流工具链命令**？**直接跳 §2.0**（GCC / CMake / Ninja / GDB / OpenOCD 的完整闭环）。

---

## 2. 亮点

### 2.0 ★ 主流工具链调用闭环（GCC / CMake / Ninja / GDB / OpenOCD）

**elab 不发明工具链，也不封装私有格式 —— 它只是把主流工具链串成一条可复现的闭环。**
每一条 `elab` 子命令，落到底都是你早就认识的那一行命令（加 `--dry-run` 就能原样打印出来）：

| elab 子命令 | 底层调用的主流工具链 | 做什么 |
|---|---|---|
| `elab build` | **CMake** 配置 → **Ninja** → **arm-none-eabi-gcc** | 编译 + 链接，统一产出 `elf / hex / bin / map` |
| `elab flash` | **OpenOCD**（探针：CMSIS-DAP / ST-Link / J-Link） | `program … verify reset exit`（含读回比对） |
| `elab debug` | **OpenOCD** 作 GDB server + **arm-none-eabi-gdb** | 断到 `main` 自检 / 交互式调试 |
| `elab doctor` | **CMake**（真跑一次 configure 取证） | 环境体检 + 两源漂移校验 |

①②③ 三个阶段的实际命令行（真实输出，长路径折叠为 `…`）：

```text
# ── ① 构建：CMake → Ninja → GCC ──────────────────────────────────────────
cmake -S …/examples/AT32_TEST -B …/.work/at32_test -G Ninja \
      -DCMAKE_MAKE_PROGRAM=…/ninja.exe \
      -DCMAKE_TOOLCHAIN_FILE=…/toolchains/gcc.cmake \
      -DCMAKE_PROJECT_INCLUDE=…/toolchains/inject.cmake \
      -DELAB_ARM_GCC_ROOT=…/GNU-tools-for-STM32 \
      -DELAB_CPU=cortex-m4 -DELAB_FPU=soft -DELAB_CHIP=at32f421g8 \
      -DELAB_LD=…/examples/AT32_TEST/AT32F421x8_FLASH.ld \
      -DCMAKE_BUILD_TYPE=Debug

# ── ② 烧录：OpenOCD ──────────────────────────────────────────────────────
openocd -s …/OpenOCD/scripts -f interface/atlink.cfg -f target/at32f421xx.cfg \
        -c "adapter speed 5000" \
        -c "program {…/.work/at32_test/TEST.elf} verify reset exit"

# ── ③ 调试：OpenOCD 作 GDB server + arm-none-eabi-gdb ────────────────────
openocd -s …/OpenOCD/scripts -f interface/atlink.cfg -f target/at32f421xx.cfg \
        -c "adapter speed 5000"          # 前台服务，监听 localhost:3333

arm-none-eabi-gdb …/.work/at32_test/TEST.elf \
        -ex "target extended-remote localhost:3333" \
        -ex "monitor reset halt" -ex load \
        -x …/toolchains/gdb/break_main.gdb   # break main → monitor reset init → continue
```

**跨芯片时这条链只换一个参数**（`target` cfg），探针与后续命令一字不改：

```text
AT32 :  -f interface/atlink.cfg  -f target/at32f421xx.cfg     ← 同一根 DAP-Link
STM32:  -f interface/atlink.cfg  -f target/stm32f1x.cfg       ← 只换 target
```

> 为什么要专门强调：**工具链是你随时能自己敲的公开命令，不是 elab 的私有封装。**
> elab 只做一件事 —— 把"该填哪个参数"从 `elab.host.yaml` / `chips/*.yaml` / `projects/*.yaml`
> 三份数据里取出来填进去，其余原样交给 CMake / Ninja / GCC / OpenOCD / GDB。
> 所以换台机器、换个人、进 CI，看到的都是同一条命令
> （本机 Windows 与云端 ubuntu-latest 跑的就是这套，见 §8）。

### 2.1 芯片差异 = 一份 YAML 里的几个值

跨芯片的全部差异，浓缩在 `chips/<vendor>/<id>.yaml` 里：

```yaml
core:
  cpu: cortex-m3     # → -mcpu=cortex-m3
  fpu: none          # → 不产出 -mfloat-abi（M3 无 FPU）
memory:
  flash: { origin: 0x08000000, length: 0x10000 }
```

驱动编译的命令行，两条只差 4 个值：

```bash
# AT32（Cortex-M4 soft-float）
-DELAB_CPU=cortex-m4 -DELAB_FPU=soft -DELAB_CHIP=at32f421g8 -DELAB_LD=.../AT32F421x8_FLASH.ld
# STM32（Cortex-M3 无 FPU）
-DELAB_CPU=cortex-m3  -DELAB_FPU=none -DELAB_CHIP=stm32f103xb  -DELAB_LD=.../STM32F103XX_FLASH.ld
```

**实测**：同一份 `toolchains/gcc.cmake` + 同一个 arm-gcc + 同一个 ninja，
驱动 B 类（AT32 WorkBench）与 A 类（STM32CubeMX）两个形态完全不同的工程，均一次通过。

### 2.2 不改源码接管工具链：两个 `-D` 支点

```bash
-DCMAKE_TOOLCHAIN_FILE=<elab>/toolchains/gcc.cmake      # 命令行接管工具链
-DCMAKE_PROJECT_INCLUDE=<elab>/toolchains/inject.cmake  # project() 之后"盖章"芯片参数
```

`CMAKE_PROJECT_INCLUDE` 是关键：它在顶层 `project()` **之后**执行，
所以即使工程在 `CMakeLists.txt` 里硬 `include()` 了自己的工具链，elab 也能把参数抢回来。

实测两类工程都能接管，但**原因不同**（这是本项目最有价值的发现之一）：

| | A 类（STM32CubeMX） | B 类（AT32 WorkBench） |
|---|---|---|
| 工具链接入点 | preset 的 `toolchainFile`（命令行级） | `CMakeLists.txt` 内 `include()` |
| 被 elab 接管后 | 原文件**根本不被加载** | 仍被加载，把参数**盖回去** |
| inject 的作用 | **补回来**（工程自述约定丢失） | **抢回来**（重设 flags / 清掉重复链接参数） |
| 不挂 inject 的后果 | 构建"成功"但产物**静默改名**（`TEST` 而非 `TEST.elf`） | 链接参数**双重叠加**（两个 `-T`，后者生效） |

> 这两类失败**都不会报错**，是典型的"静默错误"。elab 把它们变成了显式约束（见 §9）。

### 2.3 `doctor`：拿"工程的参数"和"YAML 的参数"对账

对自带 CMake 的工程，芯片参数其实**工程里已经有一份**。
所以 `chip.yaml` 的价值不是"提供参数"，而是**提供一份可校验的单一真相**。

```bash
$ elab doctor --deep
[OK] drift.at32_test.memory  ld MEMORY 与 chip.yaml 一致 [flash=0x10000, ram=0x4000]
[OK] deep.at32_test.flag     -mcpu=cortex-m4      (来自 main.c 的实际编译命令)
[OK] deep.at32_test.define   -DAT32F421G8U7
```

`--deep` 会**真跑一次 configure**，从 `compile_commands.json` 取代表源文件的
**实际编译命令**作证据 —— 不是读 YAML 自说自话。

> **`doctor` 与 `build` 共用同一份 `plan`。** 校验用的命令行与执行的命令行
> 由同一段代码（`plan.py`）生成，从根上杜绝"校验的命令 ≠ 实际跑的命令"。

### 2.4 零第三方依赖

`elab` **只用 Python 标准库**（内置 `_yaml.py` 覆盖本项目配置用到的 YAML 子集）。
不需要 `pip install pyyaml` —— 因为如果 elab 需要 pip，它就先依赖了主机的 Python 环境。

### 2.5 主机路径只有一份来源（L0 可替换）

```bash
$ ELAB_HOST=ci/host.ci.yaml ./elab build -p stm32_test --dry-run
  -DELAB_ARM_GCC_ROOT=/usr            ← 变成 Linux 侧
  -DCMAKE_MAKE_PROGRAM=/usr/bin/ninja ← 变成 Linux 侧
```

同一份 `elab` / `gcc.cmake` / `projects` / `chips`，**只换一份 L0 就整体切换主机环境**。
`toolchains/gcc.cmake` 连 `.exe` 后缀都是按 `CMAKE_HOST_SYSTEM_NAME` 判断的。

### 2.6 探针与芯片正交：SWD 就是 SWD

**interface cfg 属于探针，target cfg 属于芯片**，两者互不相干。
实测同一个 DAP-Link 探针：

| 组合 | 结果 |
|---|---|
| `interface/atlink.cfg` + `target/at32f421xx.cfg` | `[at32f421xx.cpu] Cortex-M4 r0p1 detected` |
| `interface/atlink.cfg` + `target/stm32f1x.cfg` | `[stm32f1x.cpu] Cortex-M4 r0p1 detected` |

所以**不存在"某芯片必须用某品牌探针"**。换芯片只换 target cfg。

### 2.7 AI 拿到的 skill 由数据生成

`elab skill` 从 `chips/*.yaml` 渲染出 `skills/<vendor>/<id>/SKILL.md`：
芯片身份表 + 闭环命令 + **坑位** + 验收清单 + 排障顺序。

AI 要读的提示，和 doctor 要校验的参数，**来自同一份 YAML** ——
芯片参数一改重跑 `elab skill` 即可，skill 不会悄悄过期。

### 2.8 ★ 事件流（L6）+ 闭环驾驶舱（L7）：把"此刻在哪一步"变成可观测的

前面六层解决的是"**命令能跑通**"；这一层解决"**跑的时候人看得见**"。

`elab run --emit-events` 把每一步写成**只追加的 JSONL 事件流**，驾驶舱跟读它：

```bash
python -m cockpit.server          # → http://127.0.0.1:3333/   （零第三方依赖）
```

**桌面一键启动**：双击仓库根的 `cockpit.cmd`（或桌面快捷方式 `elab驾驶舱`，图标
`cockpit.ico`；重建快捷方式用 `python tests/manual/make_shortcut.py`，需系统 Python 带
pywin32）。脚本幂等：3333 端口没起服务就**最小化**起一个（日志在
`%TEMP%\elab-cockpit.log`），然后打开默认浏览器；服务已在跑时只多开一个标签页。
端口探测用**裸 TCP socket**（PowerShell TcpClient），不受系统代理/TUN 影响；
`PATH` 前置 System32，防 MSYS 环境的 `python` shim 顶替。干跑守卫：
`python tests/manual/dryrun_cockpit_cmd.py`（三 variant 覆盖"已起/起不来/真探测"，stderr 必须为空）。

界面是三列：**工程轨**（YAML 驱动的工程卡 + 芯片卡）→ **阶段轨**（四态状态带、
内存占位、产物、零改动守卫、阶段账本）→ **证据轨**（构建/烧录/串口三合一实时日志）。

| 关键设计 | 为什么 |
|---|---|
| 事件**只追加**、每 run 一个文件、`seq` 全局单调 | 重放不需要额外机制：读文件按 `seq` 过滤即可；断线续传直接复用 `Last-Event-ID` |
| **单写者**：只有 `elab run --emit-events` 一个进程写 | 不加文件锁；唯一豁免是「取消」时父进程补一条 `run/cancel`（此时写者已死） |
| 推送走 **SSE**（stdlib 手写）、触发走 `POST` | SSE 有浏览器原生重连 + `Last-Event-ID`，零实现成本；长任务在**子进程**里跑，绝不钉死服务线程 |
| `proc/*` **100ms 合并**成一帧 | 一次编译上万行；不合并会把 SSE 打成"每行一个 HTTP 帧"。★ **只有"进程输出"才合并**（`is_batched`）—— `serial/*` 是域事件，必须各自成帧（见约束 C24） |
| 日志渲染**不进 React 树**（环形缓冲 + 命令式 DOM 追加） | 上万行走 reconciler 会直接卡死界面 |
| 内存占位**取自 `.map`** | 增量构建不 relink 时链接器不输出 `--print-memory-usage`，`.map` 是唯一可得的口径（与链接器自报逐字节一致） |
| 背压丢弃**留痕**（`stream/overrun`） | 客户端太慢时丢 `proc/*` 是允许的，但**不允许悄悄丢**：服务端如实报告损失，界面显示"服务端背压截断"。`run/*` 与 `stream/closed` 绝不丢 |
| 只读**命令预览**（`GET /api/plan`、`elab run/loop --dry-run`） | `--clean` 会真删工作目录、flash 会真烧板 —— 按下前必须能看清"到底会执行什么"（约束 C26） |
| 串口**手写通道**（`POST /api/serial`、`elab serial`）：写一条 → 收一段回显 | 串口是**独占资源**：常驻会话会与 `elab run` 的 monitor 互斥，且持口线程一旦僵死就没人释放（只能重启驾驶舱）。"无状态往返"把占用压进**一次请求**，天然与 monitor 串行（约束 C27） |
| 手写通道的 TX/RX **独立留档**（`serial-console.jsonl`） | 写通道不属于任何 run，那些行**不能**进 run 事件流（会破坏 C17 单写者）。故另立一份**有上限、会滚动**的 console 日志（约束 C28）：CLI 与界面写**同一份**，重载页面可从它回填"最近敲过什么" —— 但它**不是 state**，滚动会丢最旧的，不可当验收判据 |
| UI **一键适配**（probe/write 两段式） | "落不落盘"必须是用户看得见的独立动作：先只读探测（tier/置信度/芯片/证据链），再显式写入。三绿灯 verify **不在 HTTP 里同步做**（build 级长任务会钉死服务线程），由 `next.steps` 引导走现有 run 通道。写入与 CLI `elab adapt` 共用同一份实现（`adapt.write`），未决项不猜、人工接管不覆盖 |
| **单步执行 = 界面里的独立按钮**（阶段轨一排六颗 + 证据轨各 Tab 内对应按钮） | "只跑编译/烧录/串口"是最高频的操作，藏进下拉菜单等于每次多两跳。阶段轨一排六颗（体检/深度体检/编译/烧录/调试校验/串口闭环），可用性来自服务端算好的 `card.steps[id].ok`，置灰时 tooltip 直接说原因；证据轨按"干这件事的界面放对应的钮"：构建 Tab 有「编译」、烧录 Tab 有「烧录/调试校验」。**「跑全闭环」显式传步序**（约束 C30），空闲骨架与它同源（同一个 `fullLoopSteps()`），不会出现"骨架画五步、点下去跑两步"的自相矛盾 |
| 串口 Tab 的**常驻监视**（「打开监视 / 关闭监视」，serialmon） | 人要看的是设备实时输出，不是跑闭环判定 —— 闭环按钮留在阶段轨就够了。M3-b 曾裁定"不做常驻会话"（N5：串口独占、持口线程僵死没人释放），这个结论不推翻，所以会话带三道防身：**进程内单例 + 一键显式关闭**；**读线程异常自愈**（拔线/口被抢 → 记 error、自动收摊，绝不带死口挂着）；**写通道路由进会话**（同一口直接写，不重开口，回显走实时流）。★ 输出**不进 run 事件流**（不属于任何 run，C17）也**不落 console 留档**（留档是"我敲过什么"，监视是设备喋喋不休的心跳，落盘只会撑爆它）—— 只活在服务端环形缓冲 + 浏览器本地缓冲，前端 600ms 轮询增量拉取（`gap` 显式报告丢行，不抹平）。监视开着时起闭环 → 409 指名道姓"先关闭监视"（约束 C31） |

**实测验收（真浏览器点「跑全闭环」，doctor + build）**：实时日志滚动到 36 行、
状态 `ok`、内存 FLASH 7.39% / RAM 9.62%、产物 ELF/HEX/BIN/**MAP** 齐全、
零改动守卫 153 文件未触碰、**页面与控制台零报错**。

**实测验收（串口手写通道，M3-b，真机 + 真浏览器）**：在证据轨「串口」Tab 输入
`status` 回车 → 面板依次出现 `TX → status`、`✓ 已发送 8B → COM10@115200（ctypes/L1）`、
`← [alive] tick=1235`（设备真的收到了，心跳照常）；波特率下拉可直接切
（9600…921600）。同一条链路 `elab serial -p at32f421g8u7 --data help` 输出一致 ——
**CLI 与界面共用 `serialterm.roundtrip()`，只有一份实现**。

**实测验收（TX/RX 落盘 + 读回，M3-b2，真机）**：`elab serial -p at32f421g8u7 --data help`
→ `.work/.cockpit/serial-console.jsonl` 出现一对记录（`tx: help` + `rx: [alive] tick=2695`，
均带 `project`）；再跑 `tests/manual/probe_serial_write.py`（真机 + 真服务）——
失败的那次写（COM99）**也留了痕**、成功的写与两条回显逐条落档、
`GET /api/serial/console` 把它们全部读回（`count 2 → 6`），退出码 0。
闭环这边同样验证过边界：`elab loop` 五步全绿后留档**仍是** 6 条 —— monitor 属于
run，写事件流；手写通道不属于 run，写 console 留档，**两条道互不污染**。

> 契约见 `docs/ICD_cockpit_events.md`，实现记录见 `docs/技术方案_闭环驾驶舱.md`。
> ⚠️ 一条容易踩的硬约束：SSE 用的是**命名事件**，`EventSource.onmessage`
> **只接收没有 `event:` 字段的帧** —— 新增 topic 必须**两端同时**改
> （`cockpit/server.py` 的 `SSE_TOPICS` + `cockpit/web/src/api/types.ts` 的
> `KNOWN_TOPICS`），否则该 topic 的全部事件在浏览器里**静默消失**。
> 已加守卫用例 `tests/it_cockpit_server.py::test_known_topics_covers_server_emitted` 拦截。
>
> ⚠️ 第二条同族的坑（C24）：**能把事件发出去 ≠ 前端收得到**。事件会先经过
> "合并成 `proc/stdout-batch`"这一步 —— 若把域事件（`serial/*`）也合并进去，
> 它们就变成一行**空文本**。判断"哪些该合并"必须用 `is_batched()`（只有进程输出），
> **不能**用落盘通道分类 `is_activity()`。守卫：
> `test_live_sse_keeps_domain_events_as_named_frames`（已做变异检验）。

---

## 3. 快速开始

```bash
cd elab-flow

# ① 环境体检（先全绿再往下）
./elab list
./elab doctor

# ② 一条命令走完闭环：体检 → 编译 → 烧录 → 断到 main 自检
./elab loop -p at32_test

# ③ 也可以分步来
./elab build -p at32_test --clean
./elab flash -p at32_test
./elab debug -p at32_test --run      # 交互式 gdb

# ④ 闭环驾驶舱：起后端，浏览器里看"此刻在哪一步"（零第三方依赖）
python -m cockpit.server             # → http://127.0.0.1:3333/
```

> 需要 Python ≥ 3.8（无第三方依赖）。Windows 上可用 `elab.cmd`；Git Bash 用 `./elab`。
> 没有探针时，`doctor` / `build` / `ci` 照样可跑（`loop` 会在 flash 步失败）。
> 驾驶舱的**前端产物 `cockpit/web/dist/` 已随仓库提交**，所以最终用户不需要装 Node；
> 只有在改前端时才需要 `npm --prefix cockpit/web run build`。

### 接入你自己的工程（三种方式，同一份实现）

把图形配置器（AT32 WorkBench / STM32CubeMX）**以 CMake 工具链导出**的工程接进 elab：

| 方式 | 操作 | 适合 |
|---|---|---|
| **驾驶舱一键适配**（M5.6） | 工程轨标题栏「＋ 适配」→ 粘贴工程根目录**绝对路径** → 「探测」（只读，显示 T1/T3、置信度、芯片、波特率与证据链）→ 「写入」→ 新卡片自动出现并选中 → 点「体检 + 编译」看三绿灯 | 日常使用，全程不碰命令行 |
| CLI | `./elab adapt <path> --write` → `./elab adapt <path> --verify`（三绿灯自证） | agent / 脚本化 |
| 手写 YAML | 照 `projects/at32_test.yaml` 抄一份 | 探测器覆盖不了的特殊工程 |

三者的**写入与拒绝逻辑是同一份代码**（`adapt.write`）：有未决项不猜（`--force` 可越）、
芯片未匹配拒绝、**人工接管保护**（接入文件头部的 `generated-by` 标记被删 → 视为手改，
一律不覆盖）。`T3`（没有 CMakeLists.txt）不是错误而是探测结论 —— 请回图形配置器把
工具链切到 CMake 重新导出。

### 自测

```bash
python tests/test_kernel_events.py        # 事件流：seq 前缀性质、并发写、明文通道（16 例）
python tests/test_map_memory.py           # .map → 内存口径（11 例）
python tests/test_monitor_judge.py        # ★ 串口判据引擎三态 + 两条铁律（38 例，无需硬件）
python tests/test_cockpit_backpressure.py # ★ 背压留痕 / run/* 不可丢 / list_active 以日志为准（14 例）
python tests/test_serialterm.py           # ★ 串口写通道：载荷/对症报错/往返（30 例）
python tests/test_serialconsole.py        # ★ TX/RX 落盘：滚动/原子替换/坏行容错（26 例）
python tests/it_cockpit_server.py         # 后端集成 + 浏览器侧回归（37 例，会真编译，约 1min）
```

> `tests/test_monitor_judge.py` 是补上的：`monitor.py` 的 docstring 与本文档此前都声称
> 判据引擎"单测 12/12"，但那份用例跑在**会话临时文件**里、从未入库 ——
> 于是两条铁律（`fail_on` 绝对优先、`settle` 后再收工）的修复**完全没有守卫**。
> 它们看起来都可以被"顺手简化"成一个逐行 `if`，而退化的症状是
> **HardFault 的板子被报成通过**（假通过比失败难发现得多）。

### 实测输出（真实硬件）

```
$ ./elab loop -p at32_test --clean
[1/4] doctor   ✓ 全绿
[2/4] build    ✓ [28/28] Linking C executable TEST.elf
               FLASH  4840 B / 65536 B   7.39%
               RAM    1576 B / 16384 B   9.62%
               guard  ✓ untouched=True (+0 -0 ~0)
[3/4] flash    ✓ ** Programming Finished ** → ** Verified OK **
[4/4] debug    ✓ Breakpoint 1, main () at .../main.c:78   pc=0x8000ecc <main+4>
[elab] ✓✓ 闭环完成：at32_test
```

---

## 4. 目录结构

```
elab-flow/                          ← 项目根
├── README.md                       ← 本文件
├── elab.host.yaml                  ← ★ L0 主机唯一配置（工具链/工具/探针/串口/SVD 根）
├── elab / elab.cmd                 ← L3 CLI 入口
│
├── chips/                          ← L1 芯片参数（跨芯片差异的唯一数据源）
│   ├── artery/at32f421g8.yaml
│   └── st/stm32f103xb.yaml
│
├── toolchains/                     ← L2 工具链适配
│   ├── gcc.cmake                   ← 通用工具链（只由 ELAB_CPU / ELAB_FPU 驱动）
│   ├── inject.cmake                ← 芯片参数"盖章"点
│   └── gdb/break_main.gdb          ← 断到 main
│
├── projects/                       ← L4 项目接入（指向业务工程，只读）
│   ├── at32_test.yaml              ← B 类（手写）
│   ├── at32f421g8u7.yaml           ← B 类（★ 由 `elab adapt` 生成，带 provenance 证据链）
│   └── stm32_test.yaml             ← A 类（手写）
│
├── services/elab/                  ← L3 实现（零第三方依赖）
│   ├── __main__.py                 ← 命令分发
│   ├── config.py                   ← L0/L1/L4 加载 + ${} 插值 + Host 视图
│   ├── plan.py                     ← (项目,芯片,主机) → 构建计划
│   ├── doctor.py                   ← 体检 + 两源漂移校验
│   ├── builder.py                  ← configure + build + 统一产物 + 零改动快照
│   ├── flash.py                    ← openocd 烧录 / gdb 调试
│   ├── monitor.py                  ← 串口闭环判据（ok / failed / inconclusive）
│   ├── serialport.py               ← 串口后端（pyserial 或零依赖 ctypes，优雅降级）
│   ├── adapt.py                    ← ★ 确定性探测器：图形配置器工程 → projects/*.yaml
│   ├── run.py                      ← ★ 事件驱动运行（`elab run --emit-events`）
│   ├── kernel/                     ← ★ 事件流内核（只追加 JSONL、seq 单调、单写者）
│   ├── ci.py                       ← CI 矩阵执行
│   ├── skillgen.py                 ← 由 chip.yaml 生成 per-chip skill
│   └── _yaml.py                    ← 零依赖 YAML 子集解析器
│
├── ci/                             ← L5 CI
│   ├── matrix.yaml                 ← ★ 本地与云端共用同一份矩阵
│   ├── host.ci.yaml                ← CI 版 L0（换环境不换流程）
│   └── workflows/elab.yml          ← 复制到 .github/workflows/ 即生效
│
├── skills/                         ← L6 per-chip AI skill（★ 由 `elab skill` 生成，勿手改）
│   ├── artery/at32f421g8/SKILL.md
│   └── st/stm32f103xb/SKILL.md
│
├── cockpit/                        ← L7 闭环驾驶舱
│   ├── server.py                   ← ★ 后端：stdlib HTTP + SSE（零第三方依赖）
│   └── web/                        ← 前端工程（Vite + React + TS）
│       ├── src/                    ← 三轨 + 环形缓冲日志渲染 + ctx.layout
│       └── dist/                   ← ★ 构建产物，**已提交入仓**（最终用户不需要 Node）
│
├── tests/                          ← 测试
│   ├── test_kernel_events.py       ← 事件流（seq 前缀性质 / 并发写 / 明文通道）
│   ├── test_map_memory.py          ← .map → 内存口径
│   └── it_cockpit_server.py        ← 后端集成 + 浏览器侧回归（真编译）
│
├── docs/                           ← 架构设计、验证报告、事件契约
├── examples/                       ← 示例工程（业务代码，elab 只读不改）
│   ├── AT32_TEST/                  ← AT32F421G8U7 / Cortex-M4 / WorkBench / B 类
│   ├── AT32F421G8U7/               ← 同上芯片的另一份导出（`elab adapt` 的验证样本）
│   └── STM32_TEST/                 ← STM32F103xB / Cortex-M3 / CubeMX / A 类
└── .work/                          ← 全部构建产物（git 忽略）
```

**没有任何 `framework/` 或 `apps/` 目录** —— 业务代码不归 elab 管。
`examples/` 下就是普通工程，`projects/*.yaml` 里的 `root:` 只是指向它的指针。

---

## 5. 命令参考

| 命令 | 作用 |
|---|---|
| `elab list [--json]` | 列出主机 / 芯片 / 项目 |
| `elab doctor [-p N] [--deep] [--json]` | 环境体检 + 两源漂移校验 |
| `elab build [-p N\|--all] [--clean] [--dry-run] [--no-guard] [-j J] [-v]` | 编译 + 统一产出 elf/hex/bin/**map** + 零改动快照 |
| `elab flash -p N [--dry-run] [--json]` | openocd 烧录 + `verify` |
| `elab debug -p N [--run\|--verify]` | `--run` 交互式 gdb；`--verify` 非交互断到 main 自检 |
| `elab monitor -p N [--port P] [--seconds S] [--reset-port] [--caps] [-q] [--json]` | ★ 串口闭环判据：读串口 → 判 `ok` / `failed` / `inconclusive` |
| `elab serial -p N --data S [--port P] [--baud B] [--read-ms MS] [--no-newline] [--hex] [--json]` | ★ 串口**手写通道**（M3-b）：写一条 → 收一段回显。默认按文本发并附加 `CRLF`；`--hex` 按二进制发。退出码 `0`=写成功（**不代表**设备一定回应），`1`=写失败 |
| `elab loop -p N [--clean] [--no-flash] [--no-debug] [--no-monitor] [--dry-run] [-v]` | ★ 一键闭环：doctor → build → flash → debug → monitor |
| `elab run -p N [--steps S] [--emit-events] [--dry-run] [--clean] [-j J] [--actor agent\|human] [--keep-going] …` | ★ 事件驱动运行：跑一串步骤，可选发射驾驶舱事件流；`--dry-run` = **只读预览** |
| `elab ci [--onhw] [--job J\|-p N] [--clean] [--json]` | 按 `ci/matrix.yaml` 跑 CI 矩阵 |
| `elab skill [--all\|-p N\|--chip C] [--json]` | 由 `chips/*.yaml` 生成 per-chip skill |
| `elab adapt [path] [--probe\|--write\|--check\|--verify] [-n NAME] [--force]` | ★ 确定性适配图形配置器工程 → 生成 `projects/*.yaml`（带 `provenance` 证据链）。M5.6 起驾驶舱有**同源**入口：`POST /api/adapt`（probe/write 两段式）+ 工程轨「＋ 适配」面板 |
| `python -m cockpit.server [--port P] [--reload] [-v]` | ★ L7 闭环驾驶舱后端（零第三方依赖；`--reload` 只提供 API 不托管 dist） |

全局：`--root` 覆盖 ELAB_ROOT，`--json` 机器可读输出（AI/CI 用）。

`elab run` 的 `--steps` 可取：`doctor` / `doctor_deep` / `build` / `flash` / `debug_verify` / `monitor`
（默认 `doctor,build`；默认失败即停，`--keep-going` 改为继续）。

### `--dry-run` 只有一个意思：**只读预览**

```bash
$ elab loop -p at32f421g8u7 --dry-run
project=at32f421g8u7  steps=doctor,build,flash,debug_verify,monitor
（只读预览：下列命令**不会**被执行）

── build
   ⚠ 先删除工作目录（不可逆）：…/.work/at32f421g8u7
   $ cmake -S …/examples/AT32F421G8U7 -B …/.work/at32f421g8u7 -G Ninja \
       -DCMAKE_TOOLCHAIN_FILE=…/toolchains/gcc.cmake … -DELAB_CPU=cortex-m4 …
   $ cmake --build …/.work/at32f421g8u7
── flash
   $ openocd.exe -s …/scripts -f interface/atlink.cfg -f target/at32f421xx.cfg \
       -c "adapter speed 5000" -c "program {…AT32F421G8U7.elf} verify reset exit"
── monitor
   串口 auto@115200  close_on=[{kind:regex, pattern:^\[(boot|alive)\]} …]
```

预览**复用各模块自己的 dry-run/print 分支**（`builder.build_command()` / `plan.shell_preview()` /
`flash(dry_run=True)` / `debug(mode="print")`），不另拼一份命令 —— 预览与实跑分叉是**静默**的，
而"预览说的和实跑的不一样"比没有预览更坏。硬件层同样有守卫：`flash`/`debug` 新增
`allow_missing_elf=`，只在预览时放开"ELF 还没 build"这一条，命令构造仍只有一处。

> ⚠ **兼容性说明**：`elab loop --dry-run` 早期是"跑到 build 就停"（**真编译**、不烧录），
> 与 `elab build/flash --dry-run` 的"只打印命令"**同名不同义** —— 用户以为在预览，
> 结果真编译了（带 `--clean` 时还会删掉工作目录）。现已统一为"只读预览"；
> 原来那个能力**没有丢**，用 `--no-flash --no-debug --no-monitor` 即可（新增 `--no-flash` 以补齐对称性）。
>
> 同一份预览也通过 HTTP 暴露：`GET /api/plan?project=N&steps=…&clean=1&jobs=4`
> —— **只读**（不 spawn、不写盘、不发射事件），驾驶舱的「预览」按钮就用它。

`--json` 契约示例：

```json
[ { "project": "at32_test", "status": "ok", "chip": "at32f421g8",
    "cpu": "cortex-m4", "fpu": "soft",
    "memory": { "FLASH": {"used":4840,"region":65536,"pct":7.39},
                "RAM":   {"used":1576,"region":16384,"pct":9.62} },
    "size": { "text": 4828, "data": 12, "bss": 1572 },
    "artifacts": { "elf": {...}, "hex": {...}, "bin": {...}, "map": {...} },
    "guard": { "untouched": true, "files_before": 153,
               "added": [], "removed": [], "changed": [] } } ]
```

> `artifacts.map` 由 **elab 自己盖章**（`plan.py` 下传 `-DELAB_MAP_FILE=<abs>`，
> `gcc.cmake` 与 `inject.cmake` 用同一变量），不再依赖工程自带工具链是否碰巧带上 `-Wl,-Map`。
> 内存占位也随之多了一条不依赖链接器输出的口径：增量构建未 relink 时从 `.map` 反推。

---

## 6. 怎么接一颗新芯片（3 步）

**① 写芯片参数** `chips/<vendor>/<id>.yaml`：

```yaml
id: stm32f407zg
vendor: st
part: STM32F407ZGT6
core: { arch: arm, cpu: cortex-m4, fpu: hard, std: gnu11 }
compiler_defines: [STM32F407xx, USE_HAL_DRIVER]
memory:
  flash: { origin: 0x08000000, length: 0x100000 }
  ram:   { origin: 0x20000000, length: 0x20000 }
linker: { owner: project, filename: STM32F407XX_FLASH.ld }
debug:
  openocd_target: target/stm32f4x.cfg     # ← 只写 target；interface 归探针
  svd: STM32F407.svd                       # 文件名即可，目录在 elab.host.yaml: svd_roots
  device: STM32F407ZGT6
verify:                                    # ← doctor 用它来发现两源漂移
  expect_defines: [STM32F407xx, USE_HAL_DRIVER]
  expect_flags:   ["-mcpu=cortex-m4", "-mfloat-abi=hard"]
  expect_memory:  { flash: 0x100000, ram: 0x20000 }
pitfalls:                                  # ← 生成 per-chip skill 的内容源
  - "本工程是 B 类……"
```

**② 写项目接入** `projects/<name>.yaml`：`root` / `chip` / `archetype` / `toolchain_file` / `linker_script`。

**③ 跑起来**：

```bash
./elab doctor -p <name> --deep     # 对账
./elab loop   -p <name>            # 闭环
./elab skill  -p <name>            # 生成该芯片的 AI skill
```

新芯片**不需要**改 `services/` 下任何代码，也不需要新增 CMake 文件。

---

## 7. 主机环境配置（L0）

所有主机路径只写一次，在 `elab.host.yaml`：

```yaml
toolchains:
  arm-none-eabi:
    root: C:/DevEnv/GNU-tools-for-STM32   # 交叉编译器（elab 会前置其 bin 到 PATH）
    version: "13.3.1"                     # doctor 校验"声明值 vs 实测值"
    prepend_path: true
tools:
  cmake:  { path: auto, min: "3.22" }
  ninja:  { path: C:/.../ninja/V1.11.1/ninja.exe }
  gdb:    { from: arm-none-eabi }
  openocd:{ path: C:/.../OpenOCD/V2.0.9/bin/openocd.exe, scripts: C:/.../scripts }
probes:
  default: atlink
  list:
    atlink: { backend: cmsis-dap, interface_cfg: interface/atlink.cfg, speed: 5000 }
svd_roots: [ C:/path/to/vendor/svd ]
serial: { default: auto, baud: 115200 }
```

换机器 / 上 CI 时，用 `ELAB_HOST` 指向另一份 L0 即可 —— 见 `ci/host.ci.yaml`。

> 实测本机并存**四套 arm-gcc**、**两套 ninja**，PATH 上的 `gdb` 还是错的 x86 版。
> "一台机器上到底有几套 GCC"这个问题，此前没有任何单一文件能回答；现在 L0 是唯一答案。

---

## 8. CI

`ci/matrix.yaml` 定义门禁，**本地 `elab ci` 与 GitHub Actions 共用同一份**：

| job | 内容 | Runner |
|---|---|---|
| `host-gate` | `doctor --deep` + `build`（**三颗芯片全跑**） | 云端可跑 |
| `onhw-gate` | `flash` + `debug --verify` | **self-hosted**（需探针），`optional: true` |
| `web-dist-guard` | 重建 `cockpit/web/dist/` 后 `git diff --exit-code` | 云端可跑 |

```
$ ./elab ci
[ci] [✓] at32_test      doctor_deep  全绿
[ci] [✓] at32_test      build        FLASH 7.39% RAM 9.62%
[ci] [✓] stm32_test     doctor_deep  全绿
[ci] [✓] stm32_test     build        RAM 42.54% FLASH 57.65%
[ci] [✓] at32f421g8u7   doctor_deep  全绿
[ci] [✓] at32f421g8u7   build        FLASH 17.99% RAM 12.26%
[ci] —— 跳过 onhw-gate（上板门禁，需 --onhw）
[elab] ✓ CI 通过
```

> 为什么分档：云端 runner 没有探针。把没有硬件变成**已知的跳过**，
> 而不是"看起来像失败的红灯"。

### 8.1 云端实测（GitHub Actions）

`.github/workflows/elab.yml` 已接入，push 即触发，在 **`ubuntu-latest`** 上真跑
（`ci/workflows/elab.yml` 是仓库内定义源，两者逐字一致，工作流第一步会 diff 校验）：

```text
✓ 工作流双源一致性守卫     ci/workflows/elab.yml == .github/workflows/elab.yml
✓ 主机依赖 / 交叉工具链     ninja + cmake + gcc-arm-none-eabi（含 newlib/nano.specs）
✓ 跑主机门禁               at32_test ✓   stm32_test ✓   at32f421g8u7 ✓
✓ 收集固件产物             12 个（3 工程 × elf/hex/bin/map，按 CI 报告自报的路径）
✓ 上传固件产物             ci-firmware/          ← 不再写死 TEST.*
✓ 校验 dist/ 与源码同步     cockpit/web/dist/ 可复现（web-dist-guard）
```

> **云端首跑就抓出一条真实缺陷**：`examples/STM32_TEST/Key/key.c` 里写的是
> `#include "Key.h"`，而磁盘上的真实文件名是 `key.h` ——
> **Windows 大小写不敏感能编过，Linux 直接 `No such file or directory`。**
>
> 这正是"上云"的价值：把只在**大小写敏感文件系统**上才暴露的问题，
> 变成 CI 里一条红灯，而不是交付到别人机器上才炸。
> （`elab ci` 的失败详情会经"失败摘要注解"转成 check-run 注解，无需 token 即可读取。）
> 第三颗芯片接入前已按同一手法做过本地大小写审计（99 文件，零命中）。

**踩过的三个云端坑（都已固化进工作流注释）**：

| 坑 | 现象 | 真相 |
|---|---|---|
| `apt install --no-install-recommends gcc-arm-none-eabi` | configure 通过、链接失败、不产出 `.elf` | Debian/Ubuntu 把 newlib（`nano.specs`/`stdio.h`）放在 **Recommends** 里，精简安装会把它裁掉 |
| 把上传路径写死成 `.work/*/TEST.*` | 构建**绿**、固件却传不上来 | **产物文件名是按工程定的**：`at32_test` → `TEST.elf`，`at32f421g8u7` → `AT32F421G8U7.elf`。且该 glob 还用不上 `include-hidden-files`（`.work/` 是隐藏目录，v4 默认跳过）。**修法**：产物路径由 `elab ci --json` 的 `build` 步骤**自报**，工作流按报告收集到 `ci-firmware/` 再上传 —— 接入新工程**无需改 workflow** |
| 收集脚本"没收集到也当成功" | 门禁绿、工件为空，仍是绿灯 | 收集步骤在**门禁为 success 却零产物**时显式 `exit 1`（"假绿"必须变红灯）；门禁本身失败时只告警，不重复报错 |

> **实测**：该收集脚本用真实报告跑出 **12 个产物**（3 工程 × 4 种），
> 其中 `at32f421g8u7.AT32F421G8U7.elf` 在旧的 `TEST.*` glob 下会**收集到 0 个文件**。
> 三条分支（正常 / 有缺失 / 门禁失败）均已用 fixture 验过退出码。

---

## 9. 已实测证据（真实硬件）

| 项 | AT32_TEST | STM32_TEST | at32f421g8u7 ★ |
|---|---|---|---|
| 芯片 / 内核 | AT32F421G8U7 / Cortex-M4 | STM32F103xB / Cortex-M3 | AT32F421G8U7 / Cortex-M4 |
| 工程形态 | B 类（WorkBench） | A 类（CubeMX） | B 类（WorkBench，另一份导出） |
| 接入方式 | 手写 `projects/*.yaml` | 手写 `projects/*.yaml` | **`elab adapt` 自动生成**（带 `provenance` 证据链） |
| 编译 | ✅ `[28/28] Linking C executable TEST.elf` | ✅ `[37/37] Linking C executable TEST.elf` | ✅ 一次通过（6.7s） |
| FLASH | 4840 B / 64 KB = **7.39%** | 37780 B / 64 KB = **57.65%** | 11788 B / 64 KB = **17.99%** |
| RAM | 1576 B / 16 KB = **9.62%** | 8712 B / 20 KB = **42.54%** | 2008 B / 16 KB = **12.26%** |
| 零改动 | ✅ 153 文件未触碰 | ✅ 1145 文件未触碰 | ✅ 99 文件未触碰 |
| 产物 | elf/hex/bin/map | elf/hex/bin/map | elf 328900 B · hex 33226 B · bin 11788 B · **map 324896 B**（`memory_source=map`） |
| 烧录 | ✅ `Verified OK`（读回逐字节比对） | ⚠️ 未上板（需 STM32 板） | ✅ `Verified OK` |
| 调试 | ✅ 断在 `main.c:78`，`pc=0x8000ecc <main+4>` | ⚠️ 未上板 | ✅ 断在 `main.c:103`，`pc=0x8001714 <main+4>` |
| 串口闭环 | — | — | ✅ `monitor` OK：`COM10@115200`（排除 6 个蓝牙口），2.6s 内命中 `[alive] tick=N` |
| **串口事件链到浏览器** | — | — | ✅ **真服务 + 真板子**：`serial/open`(id=6) → `serial/line`×2 → `serial/close` → `serial/closed-loop`(id=10, `verdict=ok`, `rule`/`evidence` 均非空) 全部以**命名帧**到达 SSE |
| **串口手写通道**（M3-b） | — | — | ✅ **真机 + 真浏览器**：界面输入 `status` → `TX → status` / `✓ 已发送 8B → COM10@115200（ctypes/L1）` / `← [alive] tick=1235`；CLI `elab serial` 同源同结果 |
| **手写通道 TX/RX 落盘 + 读回**（M3-b2） | — | — | ✅ **真机 + 真服务**：写一条 → `serial-console.jsonl` 落一对 (tx, rx)，均带 `project`；**失败的写也留痕**；`GET /api/serial/console` 全部读回（`count 2 → 6`）。闭环（monitor）写事件流、手写通道写留档，**互不污染**（闭环后留档条数不变） |
| **UI 一键适配**（M5.6） | — | — | ✅ **真浏览器 + 真服务**：`＋ 适配` → 粘贴路径 → 探测（`T1 · 可适配 / 置信度 medium / artery/at32f421g8`）→ 写入新名 → 卡片**立即出现并自动选中**；对已被人工接管的工程正确拒绝（A7 保护）。探测/写入与 CLI 共用 `adapt.py`，集成守卫 6 例 |
| **全闭环** | ✅ 五步全绿 | ⚠️ 未上板 | ✅ **`elab loop` 五步全绿**；事件版 `elab run --emit-events`（同五步）`r-7ba259ce` 落档 66 条事件，驾驶舱 `GET /api/run-events` 全量读回、5 步全 `ok` |

**"串口闭环落在时间线上"的一次完整验收**（`POST /api/run {at32f421g8u7, monitor}` + 真 SSE 客户端）：

```text
event=serial/open        id=6  {"port":"COM10","baud":115200,"backend":"ctypes"}
event=serial/line        id=7  {"line":"[alive] tick=19","t":0.94}
event=serial/line        id=8  {"line":"[alive] tick=20","t":1.94}
event=serial/close       id=9  {"port":"COM10","bytes":32,"lines":2}
event=serial/closed-loop id=10 {"verdict":"ok",
                                "rule":"regex:^\\[(boot|alive)\\] within_s=10",
                                "evidence":"[alive] tick=20"}
event=stream/closed      (无 id) {"reason":"run-finished","rc":0}
```

> 这条验收抓出的缺陷值得单独记：`serial/*` 事件**写进了文件**、REST 回放也能读到，
> 但**实时 SSE** 把它们合并进 `proc/stdout-batch` 了 —— 而 `serial/open`/`close`/`closed-loop`
> 都没有 `line` 字段，合并出来是一行**空文本**。于是驾驶舱「串口闭环」那段永远是死的，
> 且只在**实时**路径上复现（刷新页面反而正常）。根因是把**落盘通道**的分类
> `is_activity()` 当成了**传输层**的合并判据。这就是约束 **C24**。

`at32f421g8u7` 是第三个样本，价值在于：**它的 `projects/*.yaml` 不是人写的**，而是
`elab adapt` 从工程结构里确定性探测出来的（`--verify` 跑三绿灯：`doctor --deep` +
`build` + `guard.untouched`），文末 `provenance` 逐条记「结论 ← 哪个文件的什么内容」。
这证明"接一颗新芯片"可以被机器完成，而不只是被机器辅助。

**驾驶舱（L7）实测**：真浏览器里点「跑全闭环」，实时日志滚动到 36 行、状态 `ok`、
徽标/元信息/DOM 行数三者一致、内存 FLASH 7.39% / RAM 9.62%、产物 ELF/HEX/BIN/**MAP**、
零改动守卫可见、**页面与控制台零报错**。

探针：AT-Link（CMSIS-DAP FW 0253），`SWD DPIDR 0x2ba01477`。
芯片报出的主 flash `0x10000` 与 `chip.yaml` 的声明**一致** —— doctor 的内存校验与硬件吻合。

**云端（GitHub Actions / ubuntu-latest）**：`host-gate` 全绿，**三颗芯片**的
`doctor --deep` 与 `build` 均在 Linux 上通过 —— 同一份 `ci/matrix.yaml`，
只换了一份 L0（`ci/host.ci.yaml`）。详见 §8.1。

---

## 10. 设计约束（踩过的坑，全部已固化为代码）

| # | 约束 | 依据 |
|---|---|---|
| C1 | B 类必须挂 `inject`；要**清 `CMAKE_C_LINK_FLAGS`** | 工程与 elab 用了不同名的链接变量 → 两份都拼进链接行 |
| C2 | `add_compile_options` **必须拆独立参数** | 整串会被当成单个带引号参数 → gcc 报 `unrecognized -mcpu target` |
| C3 | inject **不盖 defines / include** | 工程自带的准确，再注入只制造双源 |
| C4 | `guard` **不能依赖 git**，用文件树快照 | 示例工程不是 git 仓库 |
| C5 | A 类也必须挂 inject（为补工程自述约定）；`.elf` 后缀进**通用**工具链 | 接管后产物静默改名 `TEST` |
| C6 | hex/bin **由 elab 统一产出** | 有的工程没有 POST_BUILD objcopy |
| C7 | `fpu` 需支持 `none` | M3 无 FPU，不能产出 `-mfloat-abi` |
| C8 | `--json` 下必须静默人类日志 | 否则 stdout 被进度行污染，JSON 解析失败 |
| C9 | interface cfg 优先级：**探针 > 芯片** | interface 属于探针，与芯片正交 |
| C10 | AT32 的 `guard` 也要用快照 | 与 C4 一致，避免静默跳过 |
| C11 | 增量构建无 relink → `memory` 段为空；内存口径以 `size` 为准 | 无链接则无 `--print-memory-usage` |
| C12 | `elab flash` **必须回显 openocd 证据行** | 只打一行摘要等于把证据换成信任 |
| C13 | 必须有非交互 `debug --verify` | 交互式 gdb 进不了 CI，也无法"证明"链路通 |
| C14 | debug 的 openocd 后台进程必须 `finally terminate()` | 否则占住 3333 端口 |
| C15 | SVD：**chip 声明文件名 + host 声明搜索根** | 禁止在 chip.yaml 写主机绝对路径 |
| C16 | CI 与本地共用同一份 `matrix.yaml` | 否则必然"本地绿、CI 红" |
| C17 | 事件流**单写者**：只有 `elab run --emit-events` 一个进程写；`seq` 分配与落盘必须在**同一把锁**内 | 唯有如此，磁盘上的事件才恒为连续 `seq` 前缀 —— 重放/断线续传才成立。取消时父进程补 `run/cancel` 是**唯一豁免**（前置条件：写者已死） |
| C18 | SSE 是**命名事件**：新增 topic 必须**两端同时**改 `SSE_TOPICS` + `KNOWN_TOPICS` | `EventSource.onmessage` 只接收**没有 `event:` 字段**的帧；漏一个 topic = 该 topic 全部事件在浏览器里静默消失。**实测事故**：漏了 `proc/stdout-batch` → 实时编译日志 100% 不可见（而 run 结束后重放却正常，极易误判）。守卫：`test_known_topics_covers_server_emitted` |
| C19 | HTTP/1.1 keep-alive 下，**每条请求**都要重置 handler 的实例级标志 | 一个 handler **实例**服务的是一整条**连接**。`_sent_headers` 不重置 → 第二条请求起一个字节都不写：页面 `readyState` 卡 `interactive`、控制台**零报错**，而 curl（每次新连接）全绿 |
| C20 | 日志**不进 React 树**；且"列表为空"的判据必须能识别"**被清空**" | 上万行走进 reconciler 会卡死；`clearAll()` 既不改"被裁计数"也不满足"指针越界"，只按这两条判会**既不重建也不追加** → 切工程后显示的还是上一次的日志 |
| C21 | `/api/runs.active` 只能是**活着的** run；登记簿 ≠ 活动列表 | 登记簿要保留已结束的条目（SSE 靠它判"已结束→重放完收尾"），但把它当活动列表返回会让前端挂到**最早那条已结束的 run**（症状：跑新 run 显示旧 run 的日志） |
| C22 | CI **不许写死产物路径**；产物路径必须由 `elab ci --json` 的 `build` 步骤自报 | 文件基名是**按工程定的**（`at32_test` → `TEST.*`，`at32f421g8u7` → `AT32F421G8U7.*`）。写死 glob 的后果是**绿着却没有固件产物**（`if-no-files-found: warn` 静默降级）。自报之后，接入新工程无需改 workflow —— 这是"可接入性"的直接体现 |
| C23 | 门禁为 success 却**零产物**，收集步骤必须 `exit 1` | "假绿"比"红"危险得多：绿着、工件为空，问题会被带到下一次。门禁本身失败时只告警（不重复报错），但门禁绿时缺失一律红灯 |
| C24 | SSE 的**合并**判据只能用"**是进程输出**"（`is_batched`），**不许**用落盘通道分类 `is_activity` | 落盘通道把 `serial/*`/`stream/*` 也算了进去，而"合并"是**传输层**动作。**实测事故**：`serial/open`/`close`/`closed-loop` 没有 `line` 字段 → 被合并成一行**空文本** → 浏览器什么都收不到，且**只在实时路径**复现（REST 重放逐条成帧，刷新页面反而正常，与 C18/N12 同形）。守卫：`test_live_sse_keeps_domain_events_as_named_frames` |
| C25 | 背压丢弃**必须留痕**（`stream/overrun`），且 `stream/closed` 属**控制帧**、与 `run/*` 同级不可丢 | 只 `dropped += 1` 而不发事件 = 服务端如实记了损失、界面一个像素都没变（"静默丢事件"的又一种形态）。`stream/closed` 的 `is_activity()` 为真，队列满时会被当可丢事件丢掉 → 浏览器唯一的"run 结束了"信号没了 → 界面**永远显示"运行中"**，唯一兜底是 ≈2 分钟后心跳断开重连（症状是"卡住"而不是"报错"） |
| C26 | 只读预览（`--dry-run` / `GET /api/plan`）**不许另拼一份命令** | 预览的全部价值是"我说的就是待会儿真跑的"；两处分叉是**静默**的，而"预览说的和实跑不一样"比没有预览更坏。故 `builder.build_command()` 抽成函数、`flash`/`debug` 用 `allow_missing_elf=` 开预览口子 —— 命令构造始终只有一处 |
| C27 | 串口写通道用**无状态往返**（open→write→read→close），**不做常驻会话**；且**不发射事件** | 串口**独占**：常驻会话会与 `elab run` 的 monitor 互斥，且持口线程一旦僵死就没人释放（只能重启驾驶舱）。无状态把占用压进一次请求，**天然与 monitor 串行**。不发射事件是因为写通道不属于任何 run（它与 monitor 互斥，没有可挂的 run 上下文）。★ 与 `flash`/`debug_verify`/`monitor` 几步**互斥**：那几步占串口/SWD（N5），检测到就返回 409 并**指名道姓**（否则用户只看到 `ERROR_ACCESS_DENIED`，只会去拔插） |
| C28 | 手写通道的 TX/RX 落**独立的** console 留档（`serial-console.jsonl`），**绝不**写进 run 事件流；留档**有上限、会滚动**（尾部 N 条 + `os.replace` 原子替换）；CLI 与界面写**同一份** | 写进 run 流会同时破坏"每条事件带 run"与**单写者**（C17）。滚动是必要之恶：留一份"永不清理"的文件不是好习惯 —— 代价是可能丢最旧的记录。**正因为它会改写，它就不是 state**：不可当验收判据、不可做增量同步；界面渲染的只是"最近的历史"。实测边界：`elab loop` 五步全绿后留档条数**不变**（monitor 走事件流、手写通道走留档，两条道互不污染） |
| C29 | 一键适配**真写出**新 `projects/<name>.yaml` 后，服务端必须**热重载 Config**（替换 handler 配置与 `RunManager.cfg`） | 服务进程的 `Config` 在启动时固化 —— 不重载则新工程对 `/api/projects` 与 `/api/run` **双双不可见**，症状是"写入成功、卡片永远不出现"，比报错更迷惑。CLI `_adapt_verify` 早有"写入后重载"的对应逻辑，服务端漏了同款（**真浏览器实测抓出**，集成守卫：`test_adapt_write_creates_new_project_file`）。赋值原子，在途请求仍握旧引用跑完 —— 旧配置对旧工程自洽 |
| C30 | UI 的「跑全闭环」必须**显式传步序**（全部步骤去掉 `doctor_deep`、再按工程可用性过滤）；后端 `DEFAULT_STEPS = doctor+build` 只是 API 默认值，**不是**全闭环 | 不传 steps 时 `POST /api/run` 只跑 doctor+build —— 按钮写着"全闭环"、跑完编译就停，行为与承诺**静默背离**（实测抓出）。修在**前端**（`fullLoopSteps()`）而非改后端默认：CLI/API 的"轻量默认"是对的（点一下看看不必烧板），错的是 UI 把自己的语义寄托在别人的默认值上。可用性过滤复用服务端算好的 `card.steps[id].ok`（没接板不把 flash/monitor 排进去 —— "点一下必然失败"的按钮等于骗点击） |
| C31 | 常驻串口监视会话（serialmon）必须：**单例 + 一键显式关闭**、**读线程异常自愈**（任何异常 → 记 error、自动收摊，绝不带死口挂着）、**写通道路由进会话**（不重开口）；输出**不进 run 事件流也不落 console 留档** | N5 的物理事实不因 UI 需求改变：串口独占、持口线程僵死没人释放（M3-b 裁定"不做常驻"的依据）。三道防身就是让"常驻"重新变得可接受的最小代价。输出两条道都不走：进事件流破坏 C17 单写者，落留档则被设备心跳撑爆（留档是"我敲过什么"，不是"设备说了什么"）。★ 实现坑：读线程**绝不能**用 `with self.io`（`__enter__` 会二次 open 同一个口，撞上自己持有的独占句柄 → ACCESS_DENIED，真机首测即抓出）。互斥双向闭环：监视开着 → 起含串口步骤的闭环 409；闭环在跑 → 打开监视 409，两边都指名道姓 |

---

## 11. 已知限制（未验证的部分，不计入完成）

| 项 | 状态 | 说明 |
|---|---|---|
| STM32 上板烧录/调试 | ⚠️ 未验证 | 本机接的是 AT32 板；命令已生成（只差 target cfg） |
| `at32f421g8u7` 上板 | ✅ **已验证** | `elab loop` 五步全绿：烧录 `Verified OK`、断到 `main.c:103`、串口闭环 OK |
| GitHub Actions 云端运行 | ✅ **已验证** | `host-gate` 在 `ubuntu-latest` 上全绿（见 §8.1）；`onhw-gate` 仍需 self-hosted 探针 |
| 云端 `host-gate` 含新工程 | ⚠️ 已加入，**待首跑** | `at32f421g8u7` 已进 `ci/matrix.yaml`；本地同矩阵三工程全绿，云端待下一次 push 确认 |
| `elab monitor`（串口读） | ✅ **已验证** | 判据引擎（`close_on`/`fail_on`/静默超时 → `ok`/`failed`/`inconclusive`）单测 **38/38**（`tests/test_monitor_judge.py`，离线、不插板）；真机实测：`loop` 第 5 步自动选到 `COM10`（排除 6 个蓝牙口）、`ctypes` L1 后端、2.6s 命中 `[alive]`。**无需 `--reset-port`** —— `loop` 的顺序（…→debug→monitor）天然保证 `openocd` 完全退出后才读串口（详见 N5 约束） |
| `serial/*` 事件链 + `serial/closed-loop` 时间线 | ✅ **已验证（M3-a）** | `monitor.run()` 三个回调 → `run.py` 发 `serial/open` → `serial/line`(逐行) → `serial/close` → `serial/closed-loop`；**真机 + 真服务**实测全链路到浏览器（见 §9）。`rule`/`evidence` 取 `judge()` 已算好的 `evidence[0]`，**不解析 `reason` 文案** |
| `elab run`/`loop --dry-run` 只读命令预览 | ✅ **已实现** | 复用各模块 dry-run/print 分支（不另拼命令）；CLI + `GET /api/plan` 两个入口；`--clean` 的**副作用**（删工作目录）被显式标出。守卫：`test_plan_preview_carries_commands_and_effects` / `test_plan_is_read_only` |
| `/api/runs.active` 的元数据来源 | ✅ **已改为以事件日志为准** | `project`/`steps`/`actor`/`started_at` 回读 `run/start`；内存那份只在"首行未落盘"时当占位，且用 `meta_source` 标明 |
| 驾驶舱串口 Tab 的**写通道** / 波特率切换 | ✅ **已实现（M3-b）** | `POST /api/serial` + `elab serial`，**共用** `serialterm.roundtrip()`（只有一份实现）；输入框与波特率下拉已启用。真机 + 真浏览器验收见 §9。★ 与正在跑 `flash`/`debug_verify`/`monitor` 的闭环**互斥**（409 + 指名道姓）—— 那几步占着串口/SWD（N5） |
| 串口写通道的 TX/RX **落盘** | ✅ **已实现（M3-b2）** | 独立 console 留档 `.work/.cockpit/serial-console.jsonl`（**不是** run 事件流 —— 约束 C28）：`POST /api/serial` 与 `elab serial` 写**同一份**；有上限（512 KB）、会滚动（保尾部 2000 条，原子替换）；`GET /api/serial/console?limit=N` 读回、`capabilities.serial.console` 报位置与条数；界面进工程/起闭环时自动回填最近 60 条（按工程过滤，带时间戳与前缀 `✎ hh:mm:ss TX →` / `←`）。**失败的写也留痕**。真机验收见 §9 |
| UI 一键适配新工程 | ✅ **已实现（M5.6）** | `POST /api/adapt`（probe/write **两段式**，probe 只读在前）+ 工程轨「＋ 适配」面板（探测结果带 tier/置信度/芯片/证据链 → 写入 → 卡片自动出现并选中）。三绿灯 verify **刻意不**在 HTTP 里同步做（build 级长任务会钉死服务线程），由 `next.steps` 引导走现有 run 通道跑 `doctor_deep + build`。写入与 CLI 共用 `adapt.write`（未决项拒写 / 人工接管保护）。★ 适配真写出文件后**热重载 Config**（真浏览器实测抓出的缺陷：不重载则新工程对驾驶舱不可见）。守卫：集成 6 例 |
| 单步独立按钮 + 「跑全闭环」显式步序 | ✅ **已实现（C30）** | 阶段轨「单步」下拉改为**一排六颗独立按钮**；证据轨三个 Tab 内各放对应按钮（构建→编译、烧录→烧录/调试校验、串口→串口闭环），可用性同源 `card.steps[id].ok`、置灰带原因 tooltip。★ 「跑全闭环」修复：原实现不传 steps → 后端只跑 `DEFAULT_STEPS=doctor+build`（跑完编译就停，与按钮承诺不符）；现 `onRunAll` 显式传 `fullLoopSteps()`（全部步骤 − `doctor_deep` − 不可用项），空闲骨架与它同源。**真浏览器 + 路由拦截验收**：点击后 `POST /api/run` 请求体带 `steps=["doctor","build","flash","debug_verify"]`（at32_test 无 monitor 判据 → 被可用性过滤正确排除）；单步「烧录」按钮真机实测 `r-c61be04b` 烧录 `ok` |
| 桌面一键启动驾驶舱 | ✅ **已实现** | 仓库根 `cockpit.cmd` + 桌面快捷方式 `elab驾驶舱.lnk`（图标 `cockpit.ico`，重建用 `tests/manual/make_shortcut.py`，需系统 Python 带 pywin32）。幂等：3333 已有服务只开浏览器；没有就**最小化**起一个（日志 `%TEMP%\elab-cockpit.log`）。裸 TCP 探测不受代理影响、System32 PATH 前置防 MSYS shim。**干跑三 variant 全过（stderr 全空）+ 真实双击路径 e2e 全通**（首击起服务 HTTP 200、二击幂等、系统 Python 零依赖跑通）；守卫 `tests/manual/dryrun_cockpit_cmd.py`（手动，不进 CI） |
| 串口 Tab 的常驻监视（打开/关闭监视） | ✅ **已实现（serialmon + C31）** | `services/elab/serialmon.py`：单例会话（读线程 200ms 超时循环 + 2000 行环形缓冲 + `seq` 增量游标 + `gap` 丢行报告 + 残留半行 1s 冲刷）；`GET /api/serial/monitor?after=N` 增量读回、`POST …` open/close（open 前查闭环占用 409）；**写通道路由进会话**（`via:"monitor"`，回显走实时流，TX 照落留档）；capabilities 报 `serial.monitor` 快照。前端：串口 Tab「打开监视/关闭监视」按钮 + 600ms 轮询增量入缓冲（不进 React 树）。守卫：`tests/test_serialmon.py`（16 例，假 IO 离线）+ 集成 +4（37/37）。**真机实测**：开监视 → `[alive] tick=1124…` 每秒一行实时流入、`tail(after)` 增量正确、写 `status` 8B 走会话、监视中起 monitor 闭环 409 指名道姓、关闭释放（共收 35 行） |
| 驾驶舱 `profiles/*.yaml` 插件化装配 | ❌ 未实现 | M4 范围；当前三轨是硬装配 |
| 前端产物一致性守卫（CI job） | ✅ **已实现** | `web-dist-guard`：`npm ci` → `npm run build` → `git diff --exit-code cockpit/web/dist/`。**本地已验**：重建后 `dist/` 逐字一致（可复现）。Node 用主版本 `22`（精确版本在 runner 上未必可用，取不到会让守卫永久失效） |
| `stream/overrun`（背压截断事件） | ✅ **已实现** | `_fanout` 溢出时按契约发出（一个 episode 只报一次，`dropped` 就地刷新）；SSE 侧在**去重之前**显式成帧（带 `id` 会让重连游标越过它自己）；前端 `reduce()` 归约 → 证据轨显示"服务端背压截断"。守卫：`tests/test_cockpit_backpressure.py`（14 例） |
| SSE 合并判据 | ✅ **已修正** | 原来用 `is_activity()`（**落盘通道**分类，范围过大）→ `serial/*` 被合并成空文本、实时路径整条静默丢失。现改用 `is_batched()`（**只有进程输出**）。守卫：`test_live_sse_keeps_domain_events_as_named_frames`（已做**变异检验**：改回旧判据必红） |
| SVD 在 IDE 中实际加载 | ⚠️ 未验证 | 路径已解析正确，IDE 寄存器视图未实测 |

---

## 12. 文档索引

| 文档 | 内容 |
|---|---|
| `docs/ELAB_跨平台CI工作流架构设计.md` | 架构设计（七层分层、设计边界、里程碑） |
| `docs/架构对比_ELAB_vs_elab-Flow.md` | 与 ELAB 框架的横向对比 |
| `docs/干跑验证报告_AT32接入.md` | AT32 接入（C1–C4 的来源） |
| `docs/干跑验证报告_STM32与跨芯片.md` | 跨芯片验证（C5–C7 的来源） |
| `docs/干跑验证报告_CLI实现.md` | CLI 落地（C8–C11 的来源） |
| `docs/干跑验证报告_上板闭环.md` | 上板闭环 + CI + Skill（C12–C16 的来源） |
| `docs/ICD_cockpit_events.md` | ★ **事件契约（ICD v1）**：topic 全集、事件信封、SSE 帧格式、兼容性承诺 |
| `docs/技术方案_闭环驾驶舱.md` | ★ **驾驶舱方案与实现记录**：决策 D1–D6、约束 N1–N12、串口闭环判据 §16、前端实现记录 §20 |

---

## 13. 设计边界（再强调一次）

- **对象是"工作链"，不是"代码"**：elab 负责 configure / build / flash / debug / monitor / CI / AI / **事件流** 八件事。
- **三个收敛点**：主机路径 → `elab.host.yaml`；芯片差异 → `chips/*.yaml`；工程接入 → `projects/*.yaml`。
- **两个技术支点**：`-DCMAKE_TOOLCHAIN_FILE` + `-DCMAKE_PROJECT_INCLUDE`（不改源码）；
  `openocd + gdb` CLI（不依赖任何 IDE 插件 / 平台插件）。
- **两条"看不出来"的边界**：① 业务代码**一个字不改**，用文件树快照证明（`guard.untouched`）；
  ② 每一步都在**只追加事件流**里留痕，"此刻在哪一步"由事件决定，而不是由界面自己猜
  （Model-visible means logged）。
- **验收标准**：同一句 `elab build/flash -p X`，对不同厂商、不同内核、不同生成器的工程同样成立，
  且业务工程文件树恒为 `untouched`。
