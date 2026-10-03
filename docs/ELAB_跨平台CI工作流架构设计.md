# ELAB-Flow：跨芯片编译 / 烧录 / 调试工作流架构设计

> **对齐修订版 v2**。定位：一条**跨芯片**的编译工作链 + 开发工作流，效仿 GCC / GDB / OpenOCD / CMake 主流工具链，
> 全 CI 化、AI 可接入、主机无关、去平台插件依赖。
> 以 `ELAB_Lesson` 的分层经验为参考，以 `STM32_TEST` / `AT32_TEST` 两套真实工程为验证对象。

---

## 0. 设计边界（先明确不做什么）

> ⚠️ 本节是对齐后的**硬约束**，后面所有设计不得越界。

| | 内容 |
|---|---|
| ✅ **做** | 跨芯片的**编译工作链**（configure/build/flash/debug 一条命令跑通任意芯片） |
| ✅ **做** | 跨芯片的**开发工作流**（统一入口、CI 可跑、AI 可驱动） |
| ✅ **做** | 主机无关（Windows/Linux 同一套流程）、去 IDE 插件依赖、分层解耦 |
| ❌ **不做** | 「一套业务代码跑在不同平台」那种 OS 式可移植层 |
| ❌ **不做** | 把业务代码搬进统一目录、统一框架、统一抽象 |
| ❌ **不做** | 弱符号端口层 / 运行时 platform abstraction / host-target 双跑这类**代码级**移植机制 |

### 0.1 一句话定位

> **业务代码是器官，elab 是外骨骼。外骨骼不改器官，只负责把器官接到流水线上编 / 烧 / 调。**

### 0.2 「外骨骼原则」——本设计的最高准则

```
你的代码仓库（不动）                      elab 工作流仓库（新增，物理分离）
├── AT32_TEST/          ← 原地不动        ├── elab.host.yaml    主机路径唯一配置
│   ├── CMakeLists.txt                   ├── chips/*.yaml       芯片参数
│   └── project/src/    ← 你的业务代码     ├── toolchains/*       四件套
├── STM32_TEST/         ← 原地不动        ├── projects/*.yaml    ★ 项目接入描述
└── ELAB_Lesson/        ← 原地不动        ├── elab              CLI
    └── .../usr/        ← 你的业务代码     └── skills/*/SKILL.md  AI 接入
```

接入一个已有工程，**只新增一份 `projects/<name>.yaml`**，不改它一行源码、一个目录结构。

### 0.3 「跨平台 / 跨设备 / 跨芯片」的准确定义（对齐后）

| 词 | 含义 | 由谁承载 |
|---|---|---|
| 跨平台 | **工作流本身**能跑在 Windows / Linux / macOS 主机上（不是代码可移植） | L0 `elab.host.yaml` |
| 跨设备 | 跨开发板 + 跨调试探针（AT-Link / ST-Link / J-Link…） | L0 `probes` + L1 `chip.yaml` |
| 跨芯片 | 跨 MCU（STM32F1 / AT32F421 / ESP32-S3…） | L1 `chip.yaml` |
| 不依赖主机 | 所有主机路径**一份文件**配置完 | L0 `elab.host.yaml` |
| 不依赖平台插件 | 不用 cortex-debug / EIDE / Keil 插件也能编烧调 | L2 GCC/GDB/OpenOCD/CMake |

---

## 1. 现状解剖：ELAB_Lesson（作为"被挂载对象"来看）

### 1.1 三层结构（ELAB 自己内部的组织方式）

每个课程模块 `0.` ~ `7.` 都是同一套三明治结构：

```
<module>/
├── elab/{common,elib,3rd}/      # 框架库 → elab_libaray (STATIC)
├── mcu/<chip>/{CMSIS,HAL}/      # 厂商 SDK + 芯片脏活 → <chip>_libaray (STATIC)
└── project/<chip>/
    ├── usr/                     # ★ 业务代码（main.c / bsp / core）—— 原地不动
    └── ide/{gcc,keil,eide}/     # IDE 视图
```

### 1.2 关键事实：业务代码本来就住在自己的文件夹里

`project/<chip>/usr/` 里是 `main.c` / `bsp/` / `core/`，`elab/` 是它依赖的库。
**这正好符合你要的形态**——所以 elab-Flow 要做的不是"重构它"，而是**原样挂载它**。

### 1.3 明确边界：ELAB 的 host/target 双跑 ≠ 本设计目标

ELAB 确实让同一个 `elab/` 既编 ARM 固件、又被 `example/{win32,linux,unity_test}` 用本机编译器编单测
（靠 `elab_common.c` 的 `ELAB_WEAK` 端口 + `elab_def.h` 的编译器宏分支）。

> **这是 ELAB 自己的内部选择，不是 elab-Flow 的设计目标。** 本设计只借用它的**构建分层**思路
> （芯片差异收敛、工具链参数分离），**不引入任何代码级移植机制**。

### 1.4 现有 CI 覆盖面（`.github/workflows/main.yml`）

```
ubuntu-latest → cppcheck/MISRA 静态检查 → 构建 unity_test → expect 驱动跑测 → artifact 上传
```
**只覆盖 host 单测**；**没有 target 固件构建、烧录、调试**。这是要补的闭环。

### 1.5 六个断点（gap）

| # | 断点 | 证据 |
|---|---|---|
| G1 | **文件清单多真相源** | CMake 一份、`eide.json` 一份、`.uvprojx` 一份；加文件要改 3 处 |
| G2 | **工具链路径不统一** | `ENV{QTOOLS}` / `ENV{CUBE_BUNDLE_PATH}` / AT32 插件命令，各写各的 |
| G3 | **调试依赖 IDE 插件** | AT32 `launch.json` 依赖 `cortex-debug` + `${command:at32.get.*}` |
| G4 | **绝对路径硬编码** | AT32 `launch.json` 的 elf 指向 `c:/Users/xiao1/Desktop/AT32/TEST/...`——**不是本仓库路径** |
| G5 | **无统一 CLI / 无机器可读输出** | AI 无法稳定驱动与解析 |
| G6 | **无芯片知识沉淀载体** | 芯片差异靠人脑 + 注释 |

---

## 2. STM32_TEST / AT32_TEST 工具链解剖

| 项 | STM32_TEST（CubeMX） | AT32_TEST（WorkBench） |
|---|---|---|
| 构建入口 | `CMakeLists.txt` + `CMakePresets.json` | `CMakeLists.txt` + `CMakePresets.json` |
| 工具链 | `cmake/gcc-arm-none-eabi.cmake`（由 preset 的 `toolchainFile` 指定） | `cmake/gcc-arm-none-eabi.cmake`（在 CMakeLists 里 `include()` 进来） |
| 芯片参数 | `cmake/stm32cubemx/CMakeLists.txt`：INTERFACE `stm32cubemx` 装宏+include | `cmake/at32_workbench/CMakeLists.txt`：INTERFACE `at32_workbench` 装宏+include |
| 驱动源 | OBJECT `STM32_Drivers` + `FreeRTOS` | OBJECT `AT32_Drivers` |
| 架构 flag | `-mcpu=cortex-m3`（`TARGET_FLAGS`） | `-mcpu=cortex-m4 -mfloat-abi=soft` |
| 链接脚本 | 工具链文件里 `-T STM32F103XX_FLASH.ld` | 工具链文件里 `-T AT32F421x8_FLASH.ld` |
| 调试 | ❌ 无 `launch.json` | ✅ `cortex-debug` + OpenOCD（**绑插件 + 绝对路径**） |
| 业务代码 | `Key/key.c` | `project/src/*.c` |

**共性**：都遵循「INTERFACE 库装宏+include / OBJECT 库装源」这一干净模式；toolchain 文件结构几乎相同。
**差异点**：两个**工具链注入位置不同**（一个靠 preset 命令行，一个靠 CMakeLists 内 `include()`）——这点直接决定接入方式（见 §3.7.2）。

---

## 3. 目标架构：ELAB-Flow

### 3.1 设计原则（对齐后）

| 原则 | 落点 |
|---|---|
| P1 **业务代码零改动** | L4 只做"外挂描述"，不搬代码、不改目录 |
| P2 全 CI 化 | L5：configure/build/flash/debug/test 全部脚本化 |
| P3 仿主流工具链 | L2 只认 GCC/GDB/OpenOCD/CMake 四种接口 |
| P4 AI 易接入 | L3 CLI `--json` + L6 per-chip skill |
| P5 分层解耦 / 分门别类 | 七层单向依赖，目录按职责分栏 |
| P6 跨芯片 | L1 芯片参数化，新芯片 = 新增一份 YAML |
| P7 不依赖主机 | L0 一份 `elab.host.yaml` 收敛所有主机路径 |
| P8 不依赖平台插件 | CMake 取代 eide/uvprojx；openocd+gdb 取代 cortex-debug |

### 3.2 七层总览

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L6  AI 接入层      skills/<chip>/SKILL.md   教 AI 如何在本工作流干活          │
├──────────────────────────────────────────────────────────────────────────┤
│ L5  CI 编排层      ci/matrix.yaml           {chip×toolchain×project×host}   │
├──────────────────────────────────────────────────────────────────────────┤
│ L4  项目接入层     projects/<name>.yaml     ★ 现有工程零改动挂载              │
├──────────────────────────────────────────────────────────────────────────┤
│ L3  闭环服务层     elab CLI: configure/build/flash/debug/test/monitor/doctor│
├──────────────────────────────────────────────────────────────────────────┤
│ L2  工具链适配层   toolchains/{gcc,gdb,openocd}  ← 四件套接口                │
├──────────────────────────────────────────────────────────────────────────┤
│ L1  芯片参数层     chips/<vendor>/<part>.yaml  ← core/mem/宏/ld/svd/probe    │
├──────────────────────────────────────────────────────────────────────────┤
│ L0  主机环境层     elab.host.yaml  ← 所有主机路径/工具/探针 唯一配置点         │
└──────────────────────────────────────────────────────────────────────────┘
     业务代码在 elab 之外、原地不动；elab 只"读"它，从不"写"它
```

### 3.3 L0 主机环境层：一份 `elab.host.yaml`

**"不依赖主机"的唯一答案**——所有路径/工具在此声明，任何层都禁止自己拼绝对路径。

```yaml
# elab.host.yaml —— 唯一的"主机事实源"，可用 ELAB_HOST 环境变量指向别处
version: 1
host: { os: auto, workspace: ${ELAB_ROOT}, exec_ext: auto }   # auto → Windows=.exe

toolchains:                                   # 交叉编译工具链（可多版本共存）
  arm-none-eabi: { root: ${ELAB_ROOT}/tools/gnu_arm-none-eabi }  # 或 C:/Qt/Tools/...
  riscv32-esp-elf: { root: C:/Users/xiao1/.espressif/tools/riscv32-esp-elf/... }

tools:                                        # 主机侧工具（auto = 从 PATH 探测）
  cmake:  { path: auto, min: "3.22" }
  ninja:  { path: auto }
  gdb:    { path: auto }
  openocd:
    path:    C:/Users/xiao1/AppData/Local/at32-tools/OpenOCD/V2.0.9/bin/openocd
    scripts: C:/Users/xiao1/AppData/Local/at32-tools/OpenOCD/V2.0.9/scripts
  pyocd:  { path: auto }                      # 可选后端

probes:                                       # 探针（interface cfg 属于探针，与芯片正交）
  default: atlink
  list:
    atlink: { backend: cmsis-dap, interface_cfg: interface/atlink.cfg, transport: swd, speed: 5000 }
    dap:    { backend: cmsis-dap, interface_cfg: interface/cmsis-dap.cfg, transport: swd, speed: 5000 }
    stlink: { backend: stlink,    interface_cfg: interface/stlink.cfg,    transport: swd, speed: 4000 }
    jlink:  { backend: jlink,     interface_cfg: interface/jlink.cfg,     transport: swd, speed: 8000 }

serial: { default: auto }                     # auto = 探测第一个可用口
```

> **探针与芯片正交**（实测）：同一个 DAP-Link，只换 target cfg 就能连不同厂家的芯片。
> `interface/*.cfg` 只描述探针，`target/*.cfg` 只描述芯片 —— 不存在"某芯片必须用某品牌探针"。
> 因此 interface 归 **L0（探针）**，target 归 **L1（芯片）**。


> 相当于把散在 `ENV{QTOOLS}` / `ENV{CUBE_BUNDLE_PATH}` / `.vscode/settings.json` / 插件命令里的东西
> **全部收编到一个文件**。

### 3.4 L1 芯片参数层：`chips/<vendor>/<part>.yaml`

把芯片差异做成纯数据（只给工具链用，**不侵入业务代码**）：

```yaml
# chips/artery/at32f421g8.yaml
id: at32f421g8
vendor: artery
core: { arch: arm, cpu: cortex-m4, fpu: soft }        # → -mcpu=cortex-m4 -mfloat-abi=soft
compiler_defines: [USE_STDPERIPH_DRIVER, AT32F421G8U7]
memory:
  flash: { origin: 0x08000000, length: 0x10000 }      # 64KB
  ram:   { origin: 0x20000000, length: 0x4000  }      # 16KB
linker:  { script: chips/artery/ld/AT32F421x8_FLASH.ld }
debug:
  openocd_target: target/at32f421xx.cfg               # 相对 host.openocd.scripts
  svd: chips/artery/svd/AT32F421xx.svd
```

→ **新芯片接入 = 新增一个 YAML，零 CMake 代码、零业务代码改动。**

### 3.5 L2 工具链适配层：四件套

| 接口 | 文件 | 职责 | 取代谁 |
|---|---|---|---|
| **CMake** | `toolchains/gcc.cmake` | 读 L0+L1 → 生成工具链（编译器路径、flags、链接） | 每芯片手写 `gcc-arm-none-eabi.cmake` |
| **GCC** | 同上 + `toolchains/inject.cmake` | `-mcpu/-mfloat-abi`、Debug `-Og -g3`/Release `-Os -g0` | Keil AC5/AC6、IAR 私有选项 |
| **GDB** | `toolchains/gdb/{flash,debug,reset}.gdb` | `monitor reset halt` / `load` / `verify` / `reset run` | cortex-debug 插件 |
| **OpenOCD** | `toolchains/openocd/openocd.cfg.j2` | interface+transport+speed+target+flash | `tmp_dap_interface.cfg` + 插件命令 |

OpenOCD 配置由 `elab.host.yaml.probes` + `chip.yaml.debug` 渲染，落到 build 目录（注明"生成物，勿改"）：

```tcl
adapter driver cmsis-dap
transport select swd
adapter speed 5000
cmsis_dap_backend usb_bulk
cmsis_dap_usb interface 3
source [find target/at32f421xx.cfg]
```

烧录就是一句 GDB 批处理，无需任何 IDE：

```gdb
target extended-remote :3333
monitor reset halt
load
compare-sections
monitor reset run
detach
quit
```

### 3.6 L3 闭环服务层：`elab` CLI

**人与 AI 共用的唯一入口**。幂等、无绝对路径、支持 `--json`。

**零第三方依赖（仅标准库）**：`elab` 不依赖 PyYAML——内置 `services/elab/_yaml.py`
覆盖本项目全部配置用到的 YAML 子集。任何装了 python3 的机器/CI 都能直接跑，
不需要任何 `pip install`。**这本身就是"不依赖主机"的一部分**。

| 子命令 | 作用 | 状态 |
|---|---|---|
| `elab list` | 列出主机 / 芯片 / 项目 | ✅ 已实现 |
| `elab doctor [-p N] [--deep]` | 环境体检 + **两源漂移校验** | ✅ 已实现 |
| `elab build -p N [--clean\|--all\|--dry-run]` | configure + build + **统一产出 hex/bin（C6）** | ✅ 已实现 |
| `elab flash -p N [--dry-run]` | openocd 烧录 + `verify` | ✅ **已上板验证**（`Verified OK`） |
| `elab debug -p N [--run\|--verify]` | openocd + gdb；`--verify` 为非交互自检 | ✅ **已上板验证**（断在 `main.c:78`） |
| `elab loop -p N` | **一键闭环**：doctor → build → flash → debug | ✅ **已上板验证** |
| `elab ci [--onhw\|--job J]` | 跑 `ci/matrix.yaml` 矩阵（本地/云端同一份） | ✅ 本地已验证 |
| `elab skill [--all\|-p N\|--chip C]` | 由 `chips/*.yaml` 生成 per-chip skill | ✅ 已实现 |
| `elab monitor` | 串口日志 + `--expect` 断言 | ⏳ 待决策（标准库无跨平台串口） |

实现落点：`services/elab/`
（`__main__` 命令分发 · `config` L0/L1/L4 解析与插值 · `plan` 构建计划 ·
`doctor` 体检 · `builder` 构建 · `flash` 烧录调试 · `ci` 矩阵 ·
`skillgen` skill 生成 · `_yaml` 零依赖解析器）。

> ★ **关键设计：`doctor` 与 `build` 共用同一份 `plan`。**
> 校验用的命令行与执行的命令行由同一段代码生成，
> 从根上杜绝"**校验的那条命令 ≠ 实际跑的那条命令**"这种最隐蔽的漂移。

`--json` 输出契约（AI 稳定解析的锚点）：

```json
[ { "project": "at32_test", "status": "ok", "chip": "at32f421g8",
    "cpu": "cortex-m4", "fpu": "soft",
    "memory": { "FLASH": {"used":4840,"region":65536,"pct":7.39},
                "RAM":   {"used":1576,"region":16384,"pct":9.62} },
    "size": { "text": 4828, "data": 12, "bss": 1572 },
    "artifacts": { "elf": {"path":"...","bytes":159780}, "hex": {...}, "bin": {...} },
    "guard": { "untouched": true, "files_before": 153,
               "added": [], "removed": [], "changed": [] },
    "elapsed_s": 31.82 } ]
```


### 3.7 L4 项目接入层（★ 本设计核心）

**它解决的问题**：如何让 elab 驱动一个**已经存在、且不许改动**的工程。

#### 3.7.1 项目接入描述符 `projects/<name>.yaml`

它只回答四个问题：**在哪、用哪颗芯片、入口构建是什么、产物叫什么**。

```yaml
# projects/at32_test.yaml
name: at32_test
root: ${ELAB_ROOT}/AT32_TEST              # ★ 业务代码原地不动，这里只是"指针"
chip: artery/at32f421g8                    # → 去 L1 取 core/宏/ld/svd

build:
  kind: cmake                              # cmake | cmake-wrapper | make
  source: ${root}/CMakeLists.txt           # 工程已有的入口，不新建
  work_dir: ${ELAB_WORK}/at32_test
  generator: Ninja
  toolchain_file: ${ELAB_ROOT}/toolchains/gcc.cmake    # elab 自己的工具链
  project_include: ${ELAB_ROOT}/toolchains/inject.cmake # ★ CMake 原生注入点
  cache_vars: { CMAKE_BUILD_TYPE: Debug }

artifacts:                                 # 告诉 elab 产物在哪（用于烧录/size 统计）
  elf: ${work_dir}/TEST.elf
  hex: ${work_dir}/TEST.hex
  bin: ${work_dir}/TEST.bin

debug:
  gdb_script: ${ELAB_ROOT}/toolchains/gdb/break_main.gdb
```

#### 3.7.2 三类现有工程的接入方式（**全部零源码改动**）

| 工程形态 | 例子 | 接入机制 | 业务代码改动 |
|---|---|---|---|
| A. 工具链由命令行/preset 指定 | `STM32_TEST`（`toolchainFile` 在 preset 里） | elab 直接用 `-DCMAKE_TOOLCHAIN_FILE=elab/gcc.cmake` 覆盖 | **0** |
| B. 工具链在 CMakeLists 里 `include()` | `AT32_TEST`（line 22 硬 include） | elab 除工具链外，再挂 `-DCMAKE_PROJECT_INCLUDE=elab/inject.cmake`，在 `project()` 之后**重申**芯片 flags/宏/链接脚本 | **0** |
| C. 无 CMake（纯 Keil/IAR/Makefile） | 老工程 | elab 在 **work 目录**生成包装 CMake，列出源文件与 include（读原工程的文件清单，**不改原文件**） | **0** |
| D. ELAB 式 | `ELAB_Lesson/.../usr` | 与 A 同：命令行 toolchain 先生效，其内部 `set(CMAKE_TOOLCHAIN_FILE)` 自然失效（正合我意） | **0** |

**关键机制 `CMAKE_PROJECT_INCLUDE`**（CMake ≥3.15 原生支持，无需改源码）：

```cmake
# toolchains/inject.cmake —— elab 注入，在 project() 之后执行
# 作用：重申由 chip.yaml 决定的芯片参数，覆盖工程内硬编码
set(ELAB_CPU  "cortex-m4")
set(ELAB_FPU  "soft")
add_compile_definitions(USE_STDPERIPH_DRIVER AT32F421G8U7)
add_compile_options(-mcpu=${ELAB_CPU} -mfloat-abi=${ELAB_FPU})
add_link_options(-T ${ELAB_ROOT}/chips/artery/ld/AT32F421x8_FLASH.ld)
```

> **没有这个机制会怎样**：AT32 这类工程会把自带工具链的 `-mcpu=cortex-m4` 重新盖回来，
> elab 的芯片参数失效 → 烧进去的是"参数不对"的固件。`CMAKE_PROJECT_INCLUDE` 是**不改源码也能盖章**的唯一干净位置。

**★ 已实测验证（见 `docs/干跑验证报告_AT32接入.md`）**，得出 4 条硬约束：

| # | 约束 | 依据 |
|---|---|---|
| C1 | B 类工程必须挂 `CMAKE_PROJECT_INCLUDE`，且 `inject.cmake` 要**盖 flags + 盖链接 + 清掉 `CMAKE_C_LINK_FLAGS`** | 只用 `-DCMAKE_TOOLCHAIN_FILE` 时，链接行出现**两遍 `-T`**（工程用 `CMAKE_C_LINK_FLAGS`，elab 用 `CMAKE_EXE_LINKER_FLAGS`，不同名叠加）——当前只是冗余，一旦两源不一致就是**静默错误** |
| C2 | `inject.cmake` 里 `add_compile_options` **必须拆成独立参数** | 传整串会被引号包住 → `unrecognized -mcpu target: cortex-m4 -mfloat-abi=soft` |
| C3 | `inject.cmake` **不盖 defines / include** | B 类工程的 defines/include 由工程自己的 INTERFACE target 提供且准确，elab 再注入只制造双源；`chip.yaml` 的 defines 降级为**仅供 doctor 校验** |
| C4 | `guard` **不能依赖 git**，要用文件树快照（路径+size+mtime） | `AT32_TEST` 是从别处拷来的裸目录，**不是 git 仓库** |
| **C5** | **A 类也必须挂 `CMAKE_PROJECT_INCLUDE`**——不是为参数，而是为**补齐"工程自述约定"**；且 `.elf` 后缀应放进**通用** `gcc.cmake` | STM32 V1（不挂 inject）构建"成功"但产物改名 `TEST`（无后缀），**不报错**，故障推迟到 flash 才爆发 |
| **C6** | **hex/bin 由 elab 统一产出**，不依赖工程自带 POST_BUILD | AT32 的 CMakeLists 有 POST_BUILD objcopy，STM32 的**没有** → 行为必须由 elab 统一 |
| **C7** | 芯片 `fpu` 取值需支持 **`none`** | STM32F103 是 Cortex-M3 无 FPU，不能产出 `-mfloat-abi` |

> 实测结果：V2 成功编译，`FLASH 7.39% / RAM 9.62%`，与 `chip.yaml` 声明完全吻合；
> `AT32_TEST/` 目录时间戳保持原样、无新增文件 → **零改动成立**。
> 并顺带证实断点 G2：**本机并存三套 arm-gcc**（DevEnv 13.3.1 / at32-tools 10.3 / Qt 不存在），
> `AT32_TEST/build/compile_commands.json` 还指向已搬迁的旧绝对路径。

**★ 跨芯片验证（见 `docs/干跑验证报告_STM32与跨芯片.md`）**：用**同一套工具链**（DevEnv 13.3.1 + at32-tools ninja）
驱动两个形态完全不同的工程，均一次通过、零改动：

| | AT32_TEST（B 类） | STM32_TEST（A 类） |
|---|---|---|
| 芯片 | AT32F421G8U7 / Cortex-M4 soft | STM32F103xB / Cortex-M3 **无 FPU** |
| 生成器 | AT32 WorkBench | STM32CubeMX |
| 结果 | ✅ FLASH 7.39% / RAM 9.62% | ✅ FLASH 57.65% / RAM 42.54% |
| 业务工程改动 | **0** | **0** |

> 进一步实测：本机其实并存**四套** arm-gcc、**两套** ninja。
> 这正是 L0 `elab.host.yaml` 存在的意义——"一台机器上有几套 GCC"此前无人能回答。



#### 3.7.3 零改动保证（可验证）

```
接入前后对业务工程执行：
  git -C <project_root> status --porcelain    →  必须为空
即在 projects/*.yaml 里完成全部接入，业务仓库 diff 恒为 0。
```

### 3.8 L5 CI 编排层

```yaml
# ci/matrix.yaml
projects: [at32_test, stm32_test, elab_unity]
chips:    [at32f421g8, stm32f103zet6]
hosts:    [ubuntu-latest, windows-latest]
stages:
  lint:  { tools: [cppcheck, clang-format], misra: true }        # 继承现有 CI
  build: { needs: lint }                                          # 新增：全项目×全芯片
  test:  { needs: build, runner: host }                           # 继承 unity_test
  onhw:  { needs: test, runner: self-hosted[probe], optional: true }  # 新增：上板冒烟
```

上板冒烟（CI 里跑真板）：

```bash
elab doctor  --project at32_test
elab build   --project at32_test --json
elab flash   --project at32_test --json              # gdb: load + verify
elab monitor --project at32_test --timeout 3s --expect "ALIVE"
```

### 3.9 L6 AI 接入层：per-chip skill

每个芯片一个 skill，**内容 = 芯片 YAML 的人读镜像 + 工作流规范 + 坑位清单 + 验收清单**：

```
skills/artery/at32f421g8/SKILL.md
├─ 芯片速查：core / flash+ram / 宏 / ld / openocd target / 探针
├─ 工作流规范：只用 `elab <verb> --project <X>`，禁止手写 gcc/openocd 命令行
├─ 已知坑位：软浮点 ABI、DAP interface=3、reset halt 时序…
└─ 验收 checklist：build 出 hex/bin → size 合理 → flash verify 通过 → 串口见启动日志
```

骨架可由 `chip.yaml` **自动生成**（`elab skill-gen --chip X`），人只补"坑位"与"验收"。
（示例见 `docs/skills-template/artery_at32f421g8/SKILL.md`）

---

## 4. 关键机制

### 4.1 主机无关：路径解析三段式

```
逻辑名（--project X / 探针 atlink / 工具 openocd）
      ↓ 解析器（读 elab.host.yaml，环境变量可覆盖）
物理路径（仅运行时内存中）
```
规则：仓库内文件一律相对 `${ELAB_ROOT}`；主机工具只写逻辑名；环境变量优先级最高（CI 注入）。

### 4.2 去插件化对照表

| 插件能力 | 私有依赖 | elab-Flow 等价物 |
|---|---|---|
| 编译 | `eide.json` / `.uvprojx` | `cmake --build` |
| 烧录 | cortex-debug upload | `openocd -f cfg` + `gdb flash.gdb` |
| 调试 | `cortex-debug` | `openocd` server + `gdb -x debug.gdb` |
| 芯片参数 | `at32_chip.json` | `chip.yaml` |
| 头文件索引 | 插件 clangd | `clangd` 读 `compile_commands.json`（CMake 产，CMake 原生导出） |

### 4.3 闭环六步时序

```
[1] configure → cmake -S <project_root> -B <work> -G Ninja
                     -DCMAKE_TOOLCHAIN_FILE=elab/gcc.cmake
                     -DCMAKE_PROJECT_INCLUDE=elab/inject.cmake -DELAB_CHIP=<chip>
[2] build     → ninja → elf → objcopy → hex/bin + map + size.json
[3] doctor    → 校验 工具/探针/openocd脚本/串口 可达（失败即早退）
[4] flash     → openocd(:3333) + gdb: reset halt → load → verify → reset run → quit
[5] debug     → openocd 常驻 + gdb -x debug.gdb（--batch 可供 CI）
[6] monitor   → 串口抓日志，按 --expect 正则断言
                     ↓  任一步 exit!=0 → 上传 elab.log + 报告
```

---

## 5. 目录树：业务代码 vs 工作流（物理分离）

**当前阶段（2026-10-03 整理后）**：`elab-flow/` **本身就是项目根**，
架构文档（`docs/`）与示例工程（`examples/`）都收在其内，整个仓库自包含、可单独交付。

真实业务工程仍可放在仓库之外 —— `projects/*.yaml` 的 `root:` 写任意路径即可。

```
elab-flow/                                ← ★ 项目根 / 未来的 git 仓库根
├── README.md                             ← 项目说明（是什么 / 亮点 / 怎么用）
├── elab.host.yaml                        ← L0 主机唯一配置（可用 ELAB_HOST 换一份）
├── elab / elab.cmd                       ← L3 CLI 入口
├── docs/                                 ← 架构文档与验证报告
├── examples/                             ← 示例工程（业务代码，elab 只读不改）
│   ├── AT32_TEST/                        ← AT32F421G8U7 / Cortex-M4 / WorkBench / B 类
│   └── STM32_TEST/                       ← STM32F103xB / Cortex-M3 / CubeMX / A 类
├── chips/                                ← L1
│   ├── st/stm32f103xb.yaml
│   └── artery/at32f421g8.yaml
├── toolchains/                           ← L2
│   ├── gcc.cmake                         ← 通用工具链（跨芯片，只由 ELAB_CPU/FPU 驱动）
│   ├── inject.cmake                      ★ 芯片参数盖章点（CMAKE_PROJECT_INCLUDE）
│   ├── gdb/break_main.gdb                ← 断到 main（交互调试用）
│   └── openocd/                          ← openocd 模板（cfg 复用工具链自带）
├── projects/                             ← L4 ★ 项目接入描述（指向业务工程，只读）
│   ├── at32_test.yaml                    ← B 类（工具链在 CMakeLists 内 include）
│   └── stm32_test.yaml                   ← A 类（工具链由 preset toolchainFile 指定）
├── services/elab/                        ← L3 实现（零第三方依赖，仅标准库）
│   ├── __main__.py                       ← 命令分发
│   ├── config.py                         ← L0/L1/L4 加载 + ${} 插值 + Host 视图
│   ├── plan.py                           ← (项目,芯片,主机) → 构建计划
│   ├── doctor.py                         ← 环境体检 + 两源漂移校验
│   ├── builder.py                        ← configure+build+统一产物+零改动快照
│   ├── flash.py                          ← openocd 烧录 / gdb 调试
│   ├── ci.py                             ← CI 矩阵执行
│   ├── skillgen.py                       ← 由 chip.yaml 生成 per-chip skill
│   └── _yaml.py                          ← 零依赖 YAML 子集解析器
├── skills/                               ← L6（★ 由 `elab skill` 生成，勿手改）
│   ├── artery/at32f421g8/SKILL.md
│   └── st/stm32f103xb/SKILL.md
├── ci/                                   ← L5
│   ├── matrix.yaml                       ← ★ 本地与云端共用的矩阵
│   ├── host.ci.yaml                      ← CI 版 L0（换环境不换流程）
│   └── workflows/elab.yml                ← 复制到 .github/workflows/ 即生效
└── .work/                                ← 全部构建产物（git 忽略，不污染业务工程）
```

> **没有任何 `framework/` 或 `apps/` 目录** —— 业务代码不归 elab-Flow 管。
> `elab-flow/projects/*.yaml` 里的 `root:` 是**指向业务工程的指针**，只读，不复制、不搬移。

---

## 6. 迁移映射表

| 现状 | 目标落点 | 动作 |
|---|---|---|
| `AT32_TEST/`（原样） | `projects/at32_test.yaml` | **新增一份 yaml**，工程内 0 改动 |
| `STM32_TEST/`（原样） | `projects/stm32_test.yaml` | 同上 |
| `ELAB_Lesson/<m>/project/.../usr`（原样） | `projects/elab_<m>.yaml` | 同上 |
| `.vscode/launch.json`（cortex-debug） | `toolchains/gdb/*.gdb` + `openocd.cfg.j2` | 删除 .vscode 依赖 |
| `.vscode/at32_chip.json` | `chips/artery/at32f421g8.yaml` | 数据化 |
| `tmp_dap_interface.cfg` | `elab.host.yaml: probes.atlink` | 集中化 |
| `ENV{QTOOLS}` / `CUBE_BUNDLE_PATH` | `elab.host.yaml: toolchains` | 集中化 |
| 各工程自带的 `cmake/gcc-arm-none-eabi.cmake` | `toolchains/gcc.cmake` | 统一，各工程内文件保留不删（不生效即可） |
| `.github/workflows/main.yml`（host 单测） | `ci/workflows/*.yml` | 扩展 + 保留 |

---

## 7. 分阶段落地计划

| 阶段 | 目标 | 交付物 | 验收 | 状态 |
|---|---|---|---|---|
| **M0 主机收敛** | 一份 `elab.host.yaml` | L0 | `elab doctor` 全绿 | ✅ **完成**（doctor 全绿，含版本漂移校验） |
| **M1 首项目接入** | 跑通 `AT32_TEST`（B 类） | L4 yaml + L2 `gcc.cmake`/`inject.cmake` | 出 hex/bin；业务工程零改动 | ✅ **完成**（FLASH 7.39% / RAM 9.62%；153 文件未触碰） |
| **M2 CLI 化** | 手工命令 → YAML 驱动 | `services/elab/*` | `elab build -p X` 复现手工结果 | ✅ **完成**（两芯片均一次通过） |
| **M3 跨芯片验证** | 同一命令跑通第二颗芯片 | `projects/stm32_test.yaml` + `chips/st/stm32f103xb.yaml` | 同样成功，无新增 CMake 代码 | ✅ **完成**（M4 soft-float 与 M3 无 FPU 共用同一链/同一流程） |
| **M2′ 烧录调试** | gdb + openocd 脚本化 | L2 gdb 脚本 + `elab flash/debug` | 板上 `elab flash` 成功；`elab debug` 断到 main | ✅ **完成（AT32 上板）**：`Verified OK` + 断在 `main.c:78` |
| **M4 全 CI 化** | 矩阵 + 上板冒烟 | L5 `ci/matrix.yaml` + `elab ci` | 本地与云端同一份矩阵；artifact 齐全 | ✅ **本地达成**（host-gate + onhw-gate 双通过）／⚠️ 云端未验证 |
| **M5 AI 接入** | per-chip skill + `--json` | L6 `elab skill` 由 `chips/*.yaml` 生成 | AI 仅凭 skill 完成"改代码→编译→烧录→看日志" | ✅ **已实现**（2 份 SKILL.md 生成，含坑位/验收清单） |
| **M6 串口监控** | `elab monitor` + `--expect` | L3 monitor | 抓到启动日志并断言 | ⏳ 待决策（标准库无跨平台串口） |

> **M1/M3 是本设计的关键验证点**，现已双双达成：同一个 `elab build` 命令 + 同一套 L2，
> 驱动两个形态完全不同的既有工程（B 类 AT32 / A 类 STM32），
> 且两份业务工程的文件树**逐文件未变**（`guard.untouched == true`）。
> 做到这一步，"跨芯片编译工作链"就成立了。
>
> **M2′ 也已闭环**：`elab loop -p at32_test` 在真机上走通
> 体检 → 编译 → 烧录（`Verified OK`）→ 断在 `main`。
> 见 `docs/干跑验证报告_上板闭环.md`。
>
> 仍未验证的两项：**STM32 上板**（探针与芯片正交 —— 同一个 AT-Link/DAP-Link 只换 target cfg 即可连 STM32，
> 尚未实机跑 `elab loop -p stm32_test` 补证据，**不是缺探针**）
> 与 **GitHub Actions 云端运行**（本机无云端 runner，`ci/host.ci.yaml` 的 Linux 路径需首次接入时校正）。

---

## 8. 风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| CMake 版本要求 | `CMAKE_PROJECT_INCLUDE` 需 ≥3.15，`PRESETS` 需 ≥3.19 | `elab doctor` 校验 `cmake.min` |
| 工程硬编码工具链 | B 类工程会盖回自己的 flags | `inject.cmake` 在 `project()` 后重申；`elab doctor` 校验最终 flags |
| 厂商工具重生成 | CubeMX/WorkBench 会重写 `cmake/*.cmake` | 我们不改这些文件，生成后 elab 重新盖章即可；`git diff` 应只含 SDK 变化 |
| 纯 Keil 工程 | 无 CMake 可挂 | C 类：work 目录生成包装 CMake，读原文件清单 |
| 上板 CI 需自托管 | 云 runner 无探针 | `onhw` 标 `optional: true` + self-hosted runner 标签 |
| 调试 UI 体验 | 离开 cortex-debug 无图形断点 | GDB CLI + 可选 DAP（`gdb --interpreter=dap`）桥接任意编辑器 |

---

## 9. 结论

1. **本设计的对象是"工作链"，不是"代码"**：elab 挂在现有工程外面，负责 configure / build / flash / debug / CI / AI 六件事，
   **业务代码原地不动、组织形态不变**（`git diff` 恒为 0）。
2. **三个收敛点**：
   - 主机路径 → `elab.host.yaml` 一份；
   - 芯片差异 → `chip.yaml` 一份；
   - 工程接入 → `projects/<name>.yaml` 一份（新增，不动原工程）。
3. **两个技术支点**：
   - `-DCMAKE_TOOLCHAIN_FILE` + `-DCMAKE_PROJECT_INCLUDE` → **不改源码注入工具链与芯片参数**；
   - `openocd + gdb` CLI → **不依赖任何 IDE 插件** 完成烧录与调试。
4. **验证标准**：同一句 `elab build/flash --project X`，对 STM32(CubeMX)、AT32(WorkBench)、ELAB 三类工程同样成立，
   且业务仓库零改动——**这就是"跨芯片编译工作链"的达成态**。
