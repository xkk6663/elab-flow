# ELAB-Flow

> **一套工具链 + 一套流程，驱动不同芯片的编译 / 烧录 / 调试闭环。**
>
> 业务代码留在自己的文件夹里一个字不动，elab 挂在外面把流水线接上去。

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

界面是三列：**工程轨**（YAML 驱动的工程卡 + 芯片卡）→ **阶段轨**（四态状态带、
内存占位、产物、零改动守卫、阶段账本）→ **证据轨**（构建/烧录/串口三合一实时日志）。

| 关键设计 | 为什么 |
|---|---|
| 事件**只追加**、每 run 一个文件、`seq` 全局单调 | 重放不需要额外机制：读文件按 `seq` 过滤即可；断线续传直接复用 `Last-Event-ID` |
| **单写者**：只有 `elab run --emit-events` 一个进程写 | 不加文件锁；唯一豁免是「取消」时父进程补一条 `run/cancel`（此时写者已死） |
| 推送走 **SSE**（stdlib 手写）、触发走 `POST` | SSE 有浏览器原生重连 + `Last-Event-ID`，零实现成本；长任务在**子进程**里跑，绝不钉死服务线程 |
| `proc/*` **100ms 合并**成一帧 | 一次编译上万行；不合并会把 SSE 打成"每行一个 HTTP 帧" |
| 日志渲染**不进 React 树**（环形缓冲 + 命令式 DOM 追加） | 上万行走 reconciler 会直接卡死界面 |
| 内存占位**取自 `.map`** | 增量构建不 relink 时链接器不输出 `--print-memory-usage`，`.map` 是唯一可得的口径（与链接器自报逐字节一致） |

**实测验收（真浏览器点「跑全闭环」，doctor + build）**：实时日志滚动到 36 行、
状态 `ok`、内存 FLASH 7.39% / RAM 9.62%、产物 ELF/HEX/BIN/**MAP** 齐全、
零改动守卫 153 文件未触碰、**页面与控制台零报错**。

> 契约见 `docs/ICD_cockpit_events.md`，实现记录见 `docs/技术方案_闭环驾驶舱.md`。
> ⚠️ 一条容易踩的硬约束：SSE 用的是**命名事件**，`EventSource.onmessage`
> **只接收没有 `event:` 字段的帧** —— 新增 topic 必须**两端同时**改
> （`cockpit/server.py` 的 `SSE_TOPICS` + `cockpit/web/src/api/types.ts` 的
> `KNOWN_TOPICS`），否则该 topic 的全部事件在浏览器里**静默消失**。
> 已加守卫用例 `tests/it_cockpit_server.py::test_known_topics_covers_server_emitted` 拦截。

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

### 自测

```bash
python tests/test_kernel_events.py        # 事件流：seq 前缀性质、并发写、明文通道（16 例）
python tests/test_map_memory.py           # .map → 内存口径（11 例）
python tests/it_cockpit_server.py         # 后端集成 + 浏览器侧回归（12 例，会真编译，约 40s）
```

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
| `elab loop -p N [--clean] [--no-debug] [--no-monitor] [--dry-run] [-v]` | ★ 一键闭环：doctor → build → flash → debug → monitor |
| `elab run -p N [--steps S] [--emit-events] [--actor agent\|human] [--keep-going] …` | ★ 事件驱动运行：跑一串步骤，可选发射驾驶舱事件流 |
| `elab ci [--onhw] [--job J\|-p N] [--clean] [--json]` | 按 `ci/matrix.yaml` 跑 CI 矩阵 |
| `elab skill [--all\|-p N\|--chip C] [--json]` | 由 `chips/*.yaml` 生成 per-chip skill |
| `elab adapt [path] [--probe\|--write\|--check\|--verify] [-n NAME] [--force]` | ★ 确定性适配图形配置器工程 → 生成 `projects/*.yaml`（带 `provenance` 证据链） |
| `python -m cockpit.server [--port P] [--reload] [-v]` | ★ L7 闭环驾驶舱后端（零第三方依赖；`--reload` 只提供 API 不托管 dist） |

全局：`--root` 覆盖 ELAB_ROOT，`--json` 机器可读输出（AI/CI 用）。

`elab run` 的 `--steps` 可取：`doctor` / `doctor_deep` / `build` / `flash` / `debug_verify` / `monitor`
（默认 `doctor,build`；默认失败即停，`--keep-going` 改为继续）。

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
| **全闭环** | ✅ 五步全绿 | ⚠️ 未上板 | ✅ **`elab loop` 五步全绿** |

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

---

## 11. 已知限制（未验证的部分，不计入完成）

| 项 | 状态 | 说明 |
|---|---|---|
| STM32 上板烧录/调试 | ⚠️ 未验证 | 本机接的是 AT32 板；命令已生成（只差 target cfg） |
| `at32f421g8u7` 上板 | ✅ **已验证** | `elab loop` 五步全绿：烧录 `Verified OK`、断到 `main.c:103`、串口闭环 OK |
| GitHub Actions 云端运行 | ✅ **已验证** | `host-gate` 在 `ubuntu-latest` 上全绿（见 §8.1）；`onhw-gate` 仍需 self-hosted 探针 |
| 云端 `host-gate` 含新工程 | ⚠️ 已加入，**待首跑** | `at32f421g8u7` 已进 `ci/matrix.yaml`；本地同矩阵三工程全绿，云端待下一次 push 确认 |
| `elab monitor`（串口读） | ✅ **已验证** | 判据引擎（`close_on`/`fail_on`/静默超时 → `ok`/`failed`/`inconclusive`）单测 12/12；真机实测：`loop` 第 5 步自动选到 `COM10`（排除 6 个蓝牙口）、`ctypes` L1 后端、2.6s 命中 `[alive]`。**无需 `--reset-port`** —— `loop` 的顺序（…→debug→monitor）天然保证 `openocd` 完全退出后才读串口（详见 N5 约束） |
| 驾驶舱串口 Tab 的**写通道** / 波特率切换 | ❌ 未实现 | M3 范围；当前输入框明确置灰并注明"将在 M3 落地"，不做假按钮 |
| 驾驶舱 `profiles/*.yaml` 插件化装配 | ❌ 未实现 | M4 范围；当前三轨是硬装配 |
| 前端产物一致性守卫（CI job） | ✅ **已实现** | `web-dist-guard`：`npm ci` → `npm run build` → `git diff --exit-code cockpit/web/dist/`。**本地已验**：重建后 `dist/` 逐字一致（可复现）。Node 用主版本 `22`（精确版本在 runner 上未必可用，取不到会让守卫永久失效） |
| `stream/overrun`（背压截断事件） | ❌ 未实现 | 契约 §6.2 已规定语义（队列溢出时先丢 `proc/*`、补发一条截断提示），服务端**尚未发出**该事件（`_fanout` 只累加 `ar.dropped`） |
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
