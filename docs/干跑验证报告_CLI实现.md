# 干跑验证报告（三）：CLI 实现与跨芯片回归

> 承接：
> - `docs/干跑验证报告_AT32接入.md`（B 类，手工命令）
> - `docs/干跑验证报告_STM32与跨芯片.md`（A 类 + 跨芯片，手工命令）
>
> 本次目标：把前两份报告里**手写的 `cmake` 命令**变成 YAML 驱动的 `elab` CLI，
> 并用 CLI 再跑一次跨芯片回归，确认"**两条手工命令 → 一条 CLI**"无行为损失。

---

## 0. 结论

**达成 M2（CLI 化）+ 巩固 M3（跨芯片）。**

`elab build -p at32_test` 与 `elab build -p stm32_test` 各一次通过，
内存占用与两份 `chips/*.yaml` 的 `verify.expect_memory` **逐位吻合**，
两份业务工程的文件树**逐文件未变**（`guard.untouched == true`）。

| | AT32_TEST | STM32_TEST |
|---|---|---|
| CLI 命令 | `elab build -p at32_test --clean` | `elab build -p stm32_test --clean` |
| 芯片 / 内核 | AT32F421G8U7 / Cortex-M4 | STM32F103xB / Cortex-M3 |
| 工程形态 | **B 类**（CMakeLists 内 `include`） | **A 类**（preset `toolchainFile`） |
| configure | ✅ | ✅ |
| build | ✅ `[28/28] Linking C executable TEST.elf` | ✅ `[37/37] Linking C executable TEST.elf` |
| FLASH | 4840 B / 64 KB = **7.39%** | 37780 B / 64 KB = **57.65%** |
| RAM | 1576 B / 16 KB = **9.62%** | 8712 B / 20 KB = **42.54%** |
| size(text/data/bss) | 4828 / 12 / 1572 | **37668** / 108 / 8604 |
| 统一产物 | elf + hex + **bin** | elf + hex + **bin** |
| 零改动 | ✅ 153 文件未触碰 | ✅ 1145 文件未触碰 |
| 两源漂移校验 | ✅ ld MEMORY 与 chip.yaml 一致 | ✅ 一致 |

**关键点**：以上两个工程用的是**同一句命令、同一份 `toolchains/gcc.cmake`、
同一个 arm-gcc（DevEnv 13.3.1）、同一个 ninja**。
跨芯片差异的全部内容，就是 `chips/*.yaml` 里那几个值（`cpu` / `fpu` / 内存布局 / ld）。

---

## 1. 交付清单（全部为本次新增，业务工程 0 改动）

```
elab-flow/
├── elab                                  ← CLI 入口（bash 壳，Git Bash/Linux）
├── elab.cmd                              ← CLI 入口（Windows cmd / CI）
├── services/elab/
│   ├── __init__.py
│   ├── __main__.py                       ← 命令分发 list/doctor/build/flash/debug
│   ├── _yaml.py                          ← 零依赖 YAML 子集解析器（仅标准库）
│   ├── config.py                         ← L0/L1/L4 加载 + ${} 插值 + Host 视图
│   ├── plan.py                           ← (项目,芯片,主机) → 构建计划
│   ├── doctor.py                         ← 环境体检 + 两源漂移校验
│   ├── builder.py                        ← configure+build+统一产物+零改动快照
│   └── flash.py                          ← openocd 烧录 / gdb 调试
└── projects/at32_test.yaml               ← guard 段改为文件树快照（C4 全面落地）
```

**未改动**：`AT32_TEST/`、`STM32_TEST/` 下任何文件。

### 1.1 一个刻意的取舍：**不依赖 PyYAML**

`elab` 只用标准库。配置文件是本项目自己写的**受限 YAML 子集**
（块映射/块序列、流式 `[]`/`{}`、标量、注释、序列项为映射），
`_yaml.py` 用约 250 行覆盖之，且**已对 5 个真实配置文件逐一验证**解析结果类型正确
（`0x10000 → 65536`、`true → True`、`-mcpu=...` 列表、嵌套流式映射等）。

理由：`elab.host.yaml` 的第一原则是"不依赖主机"。
若 `elab` 需要 `pip install pyyaml`，那它就先**依赖了主机的 Python 环境**——
在干净的 CI runner 上会多一步 bootstrap。零依赖让它开箱即跑。

---

## 2. 架构落地：`doctor` 与 `build` **共用一份 plan**

这是本次实现里最重要的结构性决定。

```
projects/*.yaml ─┐
chips/*.yaml ────┼─→ plan.py ─→ Plan(configure_cmd, artifacts, ...)
elab.host.yaml ──┘              ├─→ doctor  : 拿 Plan 去校验
                                └─→ builder : 拿同一个 Plan 去执行
```

`Plan.configure_cmd()` 是**唯一**生成 `cmake ...` 命令行的代码。
`doctor --deep` 与 `build` 都调它。
→ 从根上杜绝"**校验的那条命令 ≠ 实际跑的那条命令**"这一最隐蔽的漂移。

生成的命令行（`elab build -p stm32_test --dry-run` 实测输出）：

```
cmake -S C:/Users/xiao1/Desktop/ELAB/STM32_TEST
      -B C:/Users/xiao1/Desktop/ELAB/elab-flow/.work/stm32_test
      -G Ninja
      -DCMAKE_MAKE_PROGRAM=C:/Users/xiao1/AppData/Local/at32-tools/ninja/V1.11.1/ninja.exe
      -DCMAKE_TOOLCHAIN_FILE=C:/Users/xiao1/Desktop/ELAB/elab-flow/toolchains/gcc.cmake
      -DCMAKE_PROJECT_INCLUDE=C:/Users/xiao1/Desktop/ELAB/elab-flow/toolchains/inject.cmake
      -DELAB_ARM_GCC_ROOT=C:/DevEnv/GNU-tools-for-STM32
      -DELAB_CPU=cortex-m3  -DELAB_FPU=none  -DELAB_CHIP=stm32f103xb
      -DELAB_LD=C:/Users/xiao1/Desktop/ELAB/STM32_TEST/STM32F103XX_FLASH.ld
      -DCMAKE_BUILD_TYPE=Debug
```

与第二份报告 §6 的手工命令**逐字一致**，只是路径全部由 YAML 插值而来。

> **没有一处路径是手写的**：`-S`（`projects.root`）、`-B`（`projects.build.work_dir`）、
> `ninja`（`elab.host.yaml: tools.ninja.path`）、`-DELAB_LD`（`projects.build.linker_script`）、
> `-DELAB_CPU/FPU`（`chips.core`）。

---

## 3. `elab doctor` 实测输出（静态，全绿）

```
[elab] doctor @ C:\Users\xiao1\Desktop\ELAB\elab-flow
  [OK  ] toolchain.root     C:/DevEnv/GNU-tools-for-STM32  (声明版本 13.3.1)
  [OK  ] toolchain.version  13.3.1 == 声明值          ← 声明值 vs 实测值 漂移校验
  [OK  ] tools.ninja        .../at32-tools/ninja/V1.11.1/ninja.exe
  [OK  ] tools.cmake        ...Python312/Scripts/cmake.EXE (auto，要求 ≥ 3.22)
  [OK  ] tools.openocd      .../OpenOCD/V2.0.9/bin/openocd.exe
  [OK  ] tools.gdb          arm-none-eabi-gdb.exe
  [OK  ] chip.at32f421g8.cpu      cortex-m4
  [info] chip.at32f421g8.fpu      soft → -mfloat-abi=soft
  [OK  ] chip.at32f421g8.target   target/at32f421xx.cfg
  [OK  ] chip.at32f421g8.interface interface/atlink.cfg
  ...
  [OK  ] drift.at32_test.memory   ld MEMORY 与 chip.yaml 一致 [flash=0x10000, ram=0x4000]
  [OK  ] convention.at32_test.elf 通用工具链带 .elf 后缀约定 (C5)
  [info] chip.stm32f103xb.fpu     none → 不产出 -mfloat-abi
  [OK  ] drift.stm32_test.memory  ld MEMORY 与 chip.yaml 一致 [flash=0x10000, ram=0x5000]
  [OK  ] convention.stm32_test.elf 通用工具链带 .elf 后缀约定 (C5)

[elab] ✓ 体检通过
```

### 3.1 `--deep`：拿**实际编译命令**当证据

`doctor --deep` 会真跑一次 configure（落 `.work/<name>.doctor`），
再从 `compile_commands.json` 取代表源文件（优先 `main.c`）的编译命令，
把"实际参数"与 `chip.yaml` 的 `verify.expect_*` 比对：

```
AT32:  [OK] deep.at32_test.flag    -mcpu=cortex-m4      (来自 main.c)
       [OK] deep.at32_test.flag    -mfloat-abi=soft    (来自 main.c)
       [OK] deep.at32_test.define  -DAT32F421G8U7
       [OK] deep.at32_test.define  -DUSE_STDPERIPH_DRIVER

STM32: [OK] deep.stm32_test.flag   -mcpu=cortex-m3      (来自 main.c)
       [OK] deep.stm32_test.define -DSTM32F103xB
       [OK] deep.stm32_test.define -DUSE_HAL_DRIVER
       （无 -mfloat-abi —— C7 校验通过：M3 无 FPU 就不该出现该参数）
```

> 这才是 `chip.yaml` 的真正价值：**它不是"提供参数"（工程里已有），
> 而是"提供一份可校验的单一真相"**。doctor 拿它去发现两源漂移。

---

## 4. `elab build` 实测输出（两芯片）

### 4.1 AT32_TEST（B 类）

```
[elab] configure → .../elab-flow/.work/at32_test
[elab] ✓ configure
[elab] build  → Ninja
[elab] ✓ build  ([28/28] Linking C executable TEST.elf)

  project   at32_test    chip=at32f421g8  cpu=cortex-m4  fpu=soft
  memory
    FLASH     4840 B /   65536 B   7.39%  [#...................]
    RAM       1576 B /   16384 B   9.62%  [##..................]
  size      text=4828  data=12  bss=1572
  artifacts
    elf    159780 B  .../at32_test/TEST.elf
    hex     13709 B  .../at32_test/TEST.hex
    bin      4840 B  .../at32_test/TEST.bin
  elapsed   31.82 s
```

### 4.2 STM32_TEST（A 类）

```
[elab] configure → .../elab-flow/.work/stm32_test
[elab] ✓ configure
[elab] build  → Ninja
[elab] ✓ build  ([37/37] Linking C executable TEST.elf)
[elab] ✓ 零改动保证：.../STM32_TEST 的 1145 个文件均未被触碰

  project   stm32_test   chip=stm32f103xb  cpu=cortex-m3  fpu=none
  memory
    RAM       8712 B /   20480 B  42.54%  [#########...........]
    FLASH    37780 B /   65536 B  57.65%  [############........]
  size      text=37668  data=108  bss=8604
  artifacts
    elf   1161480 B  .../stm32_test/TEST.elf
    hex    106335 B  .../stm32_test/TEST.hex
    bin     37780 B  .../stm32_test/TEST.bin
  guard     ✓ untouched=True  (+0 -0 ~0)
  elapsed   33.06 s
```

### 4.3 `--json` 契约（AI 解析锚点）

`elab build --all --json` 输出**纯净 JSON**（进度日志在 `--json` 下自动静默）：

```json
[ { "project": "at32_test", "status": "ok", "chip": "at32f421g8",
    "cpu": "cortex-m4", "fpu": "soft",
    "memory": { "FLASH": {"used":4840,"region":65536,"pct":7.39},
                "RAM":   {"used":1576,"region":16384,"pct":9.62} },
    "size": { "text": 4828, "data": 12, "bss": 1572 },
    "artifacts": { "elf": {...}, "hex": {...}, "bin": {...} },
    "guard": { "untouched": true, "files_before": 153,
               "added": [], "removed": [], "changed": [] },
    "elapsed_s": 31.82 } ]
```

---

## 5. `elab flash` / `elab debug` 命令生成

两者都已实现，命令由 **chip.yaml（cfg）+ host.yaml（openocd）+ projects.yaml（探针）** 三方拼装。

```
# elab flash -p at32_test --dry-run
openocd.exe -s <scripts> -f interface/atlink.cfg -f target/at32f421xx.cfg \
            -c "adapter speed 5000" \
            -c "program {<work>/TEST.elf} verify reset exit"

# elab flash -p stm32_test --dry-run   （同一个 AT-Link 探针，只换 target cfg）
openocd.exe -s <scripts> -f interface/atlink.cfg -f target/stm32f1x.cfg \
            -c "adapter speed 5000" \
            -c "program {<work>/TEST.elf} verify reset exit"

# elab debug -p stm32_test
① openocd.exe -s <scripts> -f interface/atlink.cfg -f target/stm32f1x.cfg
② arm-none-eabi-gdb.exe <work>/TEST.elf \
     -ex "target extended-remote localhost:3333" \
     -ex "monitor reset halt" -ex load \
     -x <elab>/toolchains/gdb/break_main.gdb -ex "monitor reset init"
```

**唯一未闭环的环节是"上板"**——需要真实探针接在机器上，属于 M2′，不阻塞工作链本身。

---

## 6. 本次新增的约束与发现

| # | 约束 / 发现 | 依据 | 状态 |
|---|---|---|---|
| **C8** | **`--json` 模式下必须静默人类进度日志** | 首次 `\|\| --json` 时 `[elab] configure → ...` 混入 stdout，`json.load` 直接报 `Expecting value: line 1 column 2` | ✅ 已修（`log=no-op`） |
| **C9** | **openocd interface 优先级：`chip.yaml` 显式声明 > 探针 backend 推导** | 探针 `atlink` 的 `backend: cmsis-dap` 会推出 `cmsis-dap.cfg`，覆盖掉芯片作者按实测选定的 `atlink.cfg`（后者才处理 AT-Link 专属细节） | ✅ 已修（`flash.py`） |
| **C10** | **AT32 的 `guard` 也要用文件树快照**（C4 只改了 STM32） | `at32_test.yaml` 仍留着 `check: "git -C ..."`，而 AT32_TEST 非 git 仓库 → 校验恒不成立且被静默跳过 | ✅ 已改 yaml |
| **C11** | **增量构建不产出 `--print-memory-usage`** → `memory` 段为空；`size` 始终可用 | 无 relink 就没有链接器输出。doctor/build 的"内存口径"应以 `size`（永远有）为准，`memory` 只在有链接时出现 | 记录（非缺陷） |

---

## 7. 与手工干跑的一致性对照

| 项 | 手工（报告一/二） | CLI（本次） | 一致？ |
|---|---|---|---|
| AT32 FLASH | 4840 B / 7.39% | 4840 B / 7.39% | ✅ |
| AT32 RAM | 1576 B / 9.62% | 1576 B / 9.62% | ✅ |
| STM32 FLASH | 37780 B / 57.65% | 37780 B / 57.65% | ✅ |
| STM32 RAM | 8712 B / 42.54% | 8712 B / 42.54% | ✅ |
| AT32 链接脚本份数 | 1 | 1（`inject.cmake` 清 `CMAKE_C_LINK_FLAGS`） | ✅ |
| 产物名 | `TEST.elf` | `TEST.elf` | ✅ |
| hex/bin | 靠工程 POST_BUILD（AT32 有、STM32 无） | **统一由 elab objcopy 产出（C6）** | ✅ 改进 |
| 零改动 | 手工 `git status` ❌ 不成立 | 文件树快照 ✅ 可验证 | ✅ 改进 |

---

## 8. 下一步

1. **M2′ 上板**：接上探针，跑 `elab flash -p at32_test`，并补 `toolchains/gdb/break_main.gdb`，
   再跑 `elab debug -p at32_test` 确认断到 `main`。
2. **补 `svd`**：两份 `chips/*.yaml` 的 `svd` 仍为 `null`（只影响 IDE 寄存器视图）。
3. **`elab monitor`**：串口日志 + `--expect` 断言，为 M4 上板冒烟做准备。
4. **L5 CI**：写 `ci/matrix.yaml`，让 `elab build --all --json` 成为 CI 的构建步骤。
5. **L6 AI skill**：把 `chips/*.yaml` 作为唯一数据源，生成 per-chip skill 骨架
   （让 AI 只读 skill 就能完成"改代码 → 编译 → 烧录 → 看日志"）。
6. **建议把 `AT32_TEST` / `STM32_TEST` 纳入 git**（决策 D3），
   这样 `guard` 可升级为"快照 + git 双保险"，并顺带消除"陈旧 build 指向别处"的问题。
