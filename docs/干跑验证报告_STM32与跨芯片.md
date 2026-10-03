# 干跑验证报告（二）：STM32 接入与跨芯片验证

> 承接 `docs/干跑验证报告_AT32接入.md`。
> 本次目标：用**与 AT32 完全相同的工具链与工作流**驱动 `STM32_TEST`，
> 验证 elab-Flow 的初衷——"一套工具链和开发流程，可以跑不同的芯片"。

---

## 0. 结论

**成立。** 两个形态完全不同的工程，用同一套 `elab.host.yaml` + 同一份 `toolchains/gcc.cmake`
+ 同一个 ninja + **同一个 arm-gcc（DevEnv 13.3.1）**，各自一次 configure + build 通过，
且**两个业务工程均零改动**。

| | AT32_TEST | STM32_TEST |
|---|---|---|
| 芯片 | AT32F421G8U7 | STM32F103xB |
| 内核 | Cortex-M4 / **soft-float** | Cortex-M3 / **无 FPU** |
| 工程形态 | **B 类**（工具链在 CMakeLists 内 hard include） | **A 类**（工具链由 preset `toolchainFile` 指定） |
| 生成器 | AT32 WorkBench | STM32CubeMX |
| 编译状态 | ✅ 成功 | ✅ 成功 |
| FLASH | 4840 B / 64 KB = **7.39%** | 37780 B / 64 KB = **57.65%** |
| RAM | 1576 B / 16 KB = **9.62%** | 8712 B / 20 KB = **42.54%** |
| 链接脚本份数 | **1**（已修双重叠加） | **1** |
| 业务工程改动 | **0** | **0** |
| 共用工具链 | `C:/DevEnv/GNU-tools-for-STM32` 13.3.1 | ← 同一个 |
| 共用 ninja | `at32-tools/ninja/V1.11.1/ninja.exe` | ← 同一个 |

内存占用与两份 `chips/*.yaml` 的 `verify.expect_memory` **完全吻合** → doctor 校验会通过。

---

## 1. A 类 vs B 类：都需要 inject，但原因不同

这是本次最有价值的认识。两类工程都能"编过"，但**必须挂 `CMAKE_PROJECT_INCLUDE` 的理由不一样**：

| | B 类（AT32_TEST） | A 类（STM32_TEST） |
|---|---|---|
| 工程工具链的接入点 | CMakeLists **内** `include()`（line 22） | preset 的 `toolchainFile`（命令行级） |
| 是否被 elab 覆盖 | 是 → **参数被抢走** | 否 → 工具链文件**根本没被加载** |
| inject 的作用 | **抢回来**（重设 flags / 链接，并清 `CMAKE_C_LINK_FLAGS`） | **补回来**（工程自述变量丢失） |
| 不挂 inject 的后果 | 链接参数**双重叠加**（两个 `-T`）→ 潜在静默错误 | 构建"成功"但**产物改名**（`TEST` 而非 `TEST.elf`）→ 后续 flash 找不到文件 |

### 1.1 A 类新发现：**静默丢约定**

V1（不挂 inject）的 STM32 构建**是成功的**，产物叫 `TEST`（无后缀）：

```
[37/37] Linking C executable TEST
```

而 AT32 的产物是 `TEST.elf`。根因不在 elab 的 flags，而在工程自带工具链文件里的一行**约定**：

```cmake
# STM32_TEST/cmake/gcc-arm-none-eabi.cmake  line 18-20
set(CMAKE_EXECUTABLE_SUFFIX_C ".elf")
```

elab 用 `-DCMAKE_TOOLCHAIN_FILE` 接管工具链后，这个文件不再被加载 → 约定丢失。
**这类失败不会报错**，但会让 `projects/*.yaml` 里的 `artifacts.elf` 指向不存在的文件，
把故障推迟到 flash 阶段才爆发。

→ 修法：把 `.elf` 后缀作为 **elab 通用约定**写进 `toolchains/gcc.cmake`（对所有芯片一致）。

### 1.2 A 类第二个"丢失项"

```
# STM32_TEST/cmake/gcc-arm-none-eabi.cmake
set(TOOLCHAIN_LINK_LIBRARIES "m")     ← 被 cmake/stm32cubemx/CMakeLists.txt 的 MX_LINK_LIBS 引用
```

被 elab 接管后该变量为 undefined，`MX_LINK_LIBS` 变成 `STM32_Drivers ;; FreeRTOS`。
实测本次**恰好没导致链接失败**（HAL + FreeRTOS 未用到 libm 符号），但这属于**侥幸**。
→ 修法：`inject.cmake` 里补回，并在日志中明示：

```
-- [elab] 补齐 TOOLCHAIN_LINK_LIBRARIES=m（工程自述变量，原属其自带工具链文件）
```

> **归纳**：A 类工程的工具链文件不只是"编译器设置文件"，它还是**工程自述约定的载体**
> （产物后缀、附加链接库、查找路径……）。elab 接管工具链 = 接管了这份契约，
> 因此必须**显式补齐**，而不能假设"工程自己的 CMakeLists 已经写清楚了一切"。

---

## 2. 顺带证实：主机路径分散比想象中更严重

上一份报告发现 3 套 arm-gcc，本次又查出更多：

### 2.1 arm-gcc — 实测**四套**

| # | 路径 | 状态 |
|---|---|---|
| a | `C:/DevEnv/GNU-tools-for-STM32` | 13.3.1，**elab 选定** |
| b | `C:/Users/xiao1/AppData/Local/at32-tools/gcc-arm-none-eabi/V10.3` | 装了没用 |
| c | `C:/Users/xiao1/AppData/Local/stm32cube/bundles/gnu-tools-for-stm32/13.3.1+st.9` | 未用 |
| d | `C:/Users/xiao1/AppData/Local/stm32cube/bundles/gnu-tools-for-stm32/14.3.1+st.2` | **STM32_TEST 旧 build 用的就是它** |

### 2.2 ninja — 实测**两套**

| # | 路径 |
|---|---|
| a | `at32-tools/ninja/V1.11.1/ninja.exe` ← elab 选定（AT32 旧 build 用它） |
| b | `stm32cube/bundles/ninja/1.13.1+st.1/bin/ninja.exe` ← STM32 旧 build 用它 |

### 2.3 陈旧产物 — 两份工程都是"搬过来的"

| 工程 | `build/` 里记录的路径 | 现状 |
|---|---|---|
| AT32_TEST | `C:/Users/xiao1/Desktop/AT32/TEST` | 该目录存在（是原件），但**不是本仓库** |
| STM32_TEST | `C:/Users/xiao1/Desktop/vscode-STM32/TEST` | 同上 |

两份 `build/` 都是从别处拷来的陈旧产物，clangd 读它们的 `compile_commands.json`
会索引到**别的目录**的源文件 → 跳转/补全静默给出错误结果。

> **教训**：这正是 `elab.host.yaml`（L0）必须存在的原因——
> "一台机器上到底有几套 GCC"这个问题，此前没有任何单一文件能回答。
> 现在 `elab.host.yaml` 是唯一答案，且 `elab doctor` 可校验。

---

## 3. 已落地的三项决策（用户确认）

| # | 决策 | 落点 |
|---|---|---|
| D1 | **elab 调 cmake 前把 `toolchains.root/bin` 前置进 PATH** | 本次实验已按此执行（`PATH="/c/DevEnv/.../bin:$PATH"`）；解决工程内 `set(CMAKE_C_COMPILER arm-none-eabi-gcc)` 裸名依赖 PATH 的问题 |
| D2 | **链接脚本归工程所有** | `projects/*.yaml` 的 `build.linker_script` 指向工程自带 ld；`chips/*.yaml` 的 `linker.owner: project`，只记内存布局用于校验 |
| D3 | **建议业务工程都纳入版本管理** | `guard` 的 `git status` 校验因此可成立；同时消除"陈旧 build 指向别处"这类问题 |

---

## 4. 更新后的架构约束（累计）

| # | 约束 | 依据 | 状态 |
|---|---|---|---|
| C1 | B 类必须挂 inject；inject 要盖 flags + 盖链接 + **清 `CMAKE_C_LINK_FLAGS`** | AT32 V1 链接参数双重叠加 | ✅ 已实现 |
| C2 | `add_compile_options` **必须拆独立参数**，不能传整串 | AT32 V2 首次构建失败 | ✅ 已实现 |
| C3 | inject **不盖 defines / include**（工程自己的准确，再注入只制造双源） | AT32 V2 实测 defines/include 全部来自工程 | ✅ 已实现 |
| C4 | `guard` **不能依赖 git**，用文件树快照 | 两份工程都不是 git 仓库 | ✅ 已改 yaml（`snapshot: true`） |
| **C5** | **A 类也必须挂 inject**——不是为参数，是为**补齐工程自述约定**；且 `.elf` 后缀应进 **通用** `gcc.cmake` | STM32 V1 产物改名 `TEST`（不报错） | ✅ 已实现 |
| **C6** | **hex/bin 由 elab 统一产出**，不依赖工程自带 POST_BUILD | STM32_TEST 的 CMakeLists **没有** POST_BUILD objcopy（AT32 有）→ 行为必须统一 | ⏳ 待 CLI 实现 |
| **C7** | **FPU 取值需支持 `none`** | STM32F103 是 Cortex-M3 无 FPU，不能产出 `-mfloat-abi` | ✅ 已实现 |

---

## 5. 本次交付清单

```
elab-flow/
├── chips/
│   ├── artery/at32f421g8.yaml      （已有）
│   └── st/stm32f103xb.yaml          ← 新增
├── projects/
│   ├── at32_test.yaml              （已有，guard 段更新）
│   └── stm32_test.yaml              ← 新增（archetype: A）
└── toolchains/
    ├── gcc.cmake                    ← 更新：支持 fpu=none、补 .elf 后缀
    └── inject.cmake                 ← 更新：补 TOOLCHAIN_LINK_LIBRARIES、fpu=none
```

**未改动**：`AT32_TEST/`、`STM32_TEST/` 下任何文件。

---

## 6. 复现命令（两条，只差芯片参数）

```bash
# 公共前置：PATH 前置工具链 bin（决策 D1）
export PATH="/c/DevEnv/GNU-tools-for-STM32/bin:$PATH"
NINJA="C:/Users/xiao1/AppData/Local/at32-tools/ninja/V1.11.1/ninja.exe"

# ── AT32（B 类，Cortex-M4 soft）─────────────────────────────
cmake -S AT32_TEST  -B elab-flow/.work/at32_v3 -G Ninja -DCMAKE_MAKE_PROGRAM="$NINJA" \
  -DCMAKE_TOOLCHAIN_FILE=elab-flow/toolchains/gcc.cmake \
  -DCMAKE_PROJECT_INCLUDE=elab-flow/toolchains/inject.cmake \
  -DELAB_ARM_GCC_ROOT="C:/DevEnv/GNU-tools-for-STM32" \
  -DELAB_CPU=cortex-m4 -DELAB_FPU=soft -DELAB_CHIP=at32f421g8 \
  -DELAB_LD="AT32_TEST/AT32F421x8_FLASH.ld" -DCMAKE_BUILD_TYPE=Debug
cmake --build elab-flow/.work/at32_v3

# ── STM32（A 类，Cortex-M3 none）────────────────────────────
cmake -S STM32_TEST -B elab-flow/.work/stm32_v2 -G Ninja -DCMAKE_MAKE_PROGRAM="$NINJA" \
  -DCMAKE_TOOLCHAIN_FILE=elab-flow/toolchains/gcc.cmake \
  -DCMAKE_PROJECT_INCLUDE=elab-flow/toolchains/inject.cmake \
  -DELAB_ARM_GCC_ROOT="C:/DevEnv/GNU-tools-for-STM32" \
  -DELAB_CPU=cortex-m3 -DELAB_FPU=none -DELAB_CHIP=stm32f103xb \
  -DELAB_LD="STM32_TEST/STM32F103XX_FLASH.ld" -DCMAKE_BUILD_TYPE=Debug
cmake --build elab-flow/.work/stm32_v2
```

> 两条命令**只差 4 个值**（`-ELAB_CPU` / `-ELAB_FPU` / `-ELAB_LD` / `-S` 路径）。
> 这正是 `elab build --project X` 要自动化掉的东西——**参数全部来自 YAML**。

---

## 7. 下一步（M1 → M2）

1. **实现 `elab doctor`**：读 `chips/*.yaml` 的 `verify` + `projects/*.yaml`，
   比对实际编译参数与内存布局 → 检测两源漂移；并校验 L0 里所有路径可达。
2. **实现 `elab build`**：把上面那条命令用 YAML 驱动起来，含
   PATH 前置（D1）、`-D` 注入、**统一产出 hex/bin（C6）**、size 统计、`--json` 输出。
3. **实现 `elab flash` / `debug`**：`openocd + gdb`，两份工程各有一套 target/interface cfg，
   已在 `chips/*.yaml` 声明。
4. 补两份工程的 `svd`（当前为 `null`）。
5. 建议把 `AT32_TEST` / `STM32_TEST` 纳入 git（决策 D3），`guard` 恢复 `git status` 校验。
