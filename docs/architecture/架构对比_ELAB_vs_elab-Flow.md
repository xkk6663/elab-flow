# 架构横向对比：ELAB vs elab-Flow

> 目的：在动手前把两个架构的关系摆清楚——哪些是**同类问题的不同解法**，哪些**根本不重叠**，
> 哪些思想该**继承**，哪些该**刻意不继承**。

---

## 1. 一句话定性：品类不同

| | ELAB | elab-Flow |
|---|---|---|
| 品类 | **代码框架**（framework） | **工具链编排**（toolchain orchestration） |
| 是个什么词 | 名词 —— 你的代码**长什么样** | 动词 —— 你**跑什么命令** |
| 解决的问题 | 代码怎么写、怎么分层、芯片差异怎么挡住 | 代码怎么编、怎么烧、怎么调、怎么进 CI |
| 作用对象 | **源码**（`.c` / `.h` / `CMakeLists.txt`） | **工具**（GCC / GDB / OpenOCD / CMake） |
| 变更时动谁 | **动业务仓库** | **只动工作流仓库**（业务仓库零改动） |
| 物理位置 | 业务仓库内（`elab/` `mcu/` `project/`） | 业务仓库外（`ELAB/elab-flow/`） |

---

## 2. 最本质的一刀：芯片差异"屏蔽给谁看"

这是两个架构最核心的分野，也是最容易被混淆的地方（因为我上一版就是在这里跑偏的）：

| | ELAB | elab-Flow |
|---|---|---|
| 芯片差异的载体 | `mcu/<chip>/` 目录 + 其 `CMakeLists.txt` | `chips/<vendor>/<part>.yaml`（纯数据） |
| 屏蔽差异**给谁看** | 给**业务代码**看 → 让 `usr/` 里的代码能跨芯片复用 | 给**工具链**看 → 让同一套命令能编不同芯片的工程 |
| "跨芯片"的含义 | 让**代码**跨芯片（需要抽象层、需要适配代码） | 让**命令**跨芯片（代码该改还得改，Flow 不管） |
| 承担者 | `elab/` 框架 + `mcu/` 适配（**代码级**） | `chip.yaml` + `gcc.cmake`（**参数级**） |

> **一句话**：ELAB 的适配层是**给代码吃的**，elab-Flow 的芯片描述是**给工具链吃的**。
> 这就是"不做 OS 式可移植层"这条边界在架构上的落点。

---

## 3. 逐维度横向对照

| # | 维度 | ELAB | elab-Flow | 关系 |
|---|---|---|---|---|
| 1 | 分层依据 | 按**代码依赖**分（谁 link 谁） | 按**职责**分（谁管工具） | 不同轴 |
| 2 | 层数 | 3 层代码 + 1 层视图（`elab` / `mcu` / `project` + `ide`） | 7 层（L0~L6） | 不同轴 |
| 3 | 芯片差异载体 | 代码（`mcu/<chip>/CMakeLists.txt`） | 数据（`chip.yaml`） | **同类问题，不同载体** |
| 4 | 工具链差异载体 | 每芯片一份 `armgcc_cm3.cmake` | 模板一份 `toolchains/gcc.cmake` + 数据 | **同类问题，不同解法** |
| 5 | 构建描述位置 | **仓库内**（`usr/CMakeLists.txt`） | **仓库外**（`projects/*.yaml`） | 关键分野 |
| 6 | IDE 视图 | `ide/{gcc,keil,eide}` 三份，真相源重复 | 删除，CMake 唯一真相源 | Flow 收敛了 |
| 7 | 主机路径 | 散在 `ENV{QTOOLS}` / `.vscode` | `elab.host.yaml` 一份 | Flow 新增 |
| 8 | 烧录 | ❌ 未做 | `openocd + gdb` 脚本化 | Flow 新增 |
| 9 | 调试 | ❌ 未做（AT32 靠插件） | `gdb -x *.gdb`，零插件 | Flow 新增 |
| 10 | CI 覆盖 | host 单测 + MISRA | 全矩阵 + 可选上板冒烟 | Flow 扩展 |
| 11 | AI 接入 | ❌ 无契约 | `elab --json` + per-chip skill | Flow 新增 |
| 12 | 改芯片成本 | 新增/替换一个 `mcu/` 目录 + 改工程 | 新增一份 `chip.yaml` + 改一个字段 | Flow 更轻 |
| 13 | 改芯片是否动业务仓库 | **会动**（构建入口在仓库里） | **不动**（构建入口在仓库外） | ★ 核心差异 |
| 14 | 是否提供代码级移植 | ✅ 提供（框架 + 适配层） | ❌ 不提供（刻意不做） | ★ 核心差异 |

---

## 4. 分层的横向映射

把 ELAB 的层**投影**到 elab-Flow 的层上，能看清谁替代了谁、谁是新增的：

| ELAB 的层 | 对应 elab-Flow 的层 | 关系 |
|---|---|---|
| `elab/` 框架层（可移植代码） | —— **无对应** | ★ 刻意不接管，它属于业务侧 |
| `mcu/<chip>/` 芯片适配层 | **L1** `chips/*.yaml` | 同类问题：**代码 → 数据** |
| `project/<chip>/usr/` 应用层 | **L4** `projects/*.yaml` | 一个是"住进去"，一个是"挂上去" |
| `project/<chip>/ide/gcc/` | **L2** `toolchains/gcc.cmake` | 同类问题：**每芯片一份 → 模板一份** |
| `project/<chip>/ide/{keil,eide}/` | —— **删除** | 去插件化 |
| —— | **L0** `elab.host.yaml` | Flow 新增 |
| —— | **L3** `elab` CLI | Flow 新增 |
| `.github/workflows/main.yml`（host 单测） | **L5** `ci/*.yml` | 继承 + 扩展 |
| —— | **L6** `skills/*/SKILL.md` | Flow 新增 |

**读法**：ELAB 的 4 层里有 3 层能在 Flow 里找到"同类问题的另一种解法"，1 层（`elab/` 框架）Flow 刻意不管；
Flow 另外新增了 4 层，全是 ELAB 没做的（主机收敛 / 统一入口 / 烧录调试 / AI 契约）。

---

## 5. 同一个任务，两边各怎么做

**任务：把 `STM32_TEST` 这个工程接进流水线，能编出 hex/bin**

### ELAB 的做法（把工程"住进"框架）

```
1. 建 mcu/stm32f103zet6/           → 拷 CMSIS + HAL，写 CMakeLists（宏 STM32F103xE、-T ld）
2. 建 project/stm32f103zet6/usr/   → 把业务代码搬进来，写 CMakeLists（add_subdirectory + link）
3. 建 project/.../ide/gcc/scripts/cmake/armgcc_cm3.cmake    → 工具链文件
4. 建 ide/keil/Template.uvprojx + ide/eide/.eide/eide.json  → 各自再枚举一遍文件清单
5. cmake configure → build
```
→ **业务代码被搬动、目录结构被重塑、文件清单维护 3 份。**

### elab-Flow 的做法（把工程"挂上"流水线）

```
1. 写 chips/st/stm32f103zet6.yaml     （~15 行：core/宏/内存/ld/svd/target）
2. 写 projects/stm32_test.yaml         （~15 行：root 指针 / chip / 入口 / 产物）
3. elab build --project stm32_test
```
→ **业务仓库 `git status` 恒为空。**

> 同一个目标，ELAB 用"**结构化你的代码**"实现，Flow 用"**结构化你的参数**"实现。

---

## 6. 唯一的重叠区与冲突点（需要小心的地方）

两者在**同一件事**上重叠：**"构建该怎么做"**。

- ELAB 用**仓库内的 `CMakeLists.txt`** 表达；
- elab-Flow 用**仓库外的 `projects/*.yaml`** 表达。

接入 ELAB 式工程时，冲突点具体在两处：

| 冲突点 | 现象 | 解法 |
|---|---|---|
| 工具链文件 | `usr/CMakeLists.txt` 里 `set(CMAKE_TOOLCHAIN_FILE ...)` 想用自己的 `armgcc_cm3.cmake` | Flow 用命令行 `-DCMAKE_TOOLCHAIN_FILE` 接管；其内部 set 自然失效（正合意） |
| 芯片参数盖章顺序 | `mcu/<chip>/CMakeLists.txt` 会按 `__CHIP_TYPE__` **再设一次**宏与 `-T ld` | 二选一：**(a)** Flow 传 `-D__CHIP_TYPE__=...` 与 `chip.yaml` 保持一致；**(b)** `inject.cmake` 作为最后一道盖章，必要时做 target 级干预 |

> 这是整个方案**唯一需要逐工程核对**的地方，也是 M1 验证时要重点看 `elab doctor` 输出的原因。

---

## 7. 两者关系：正交，可叠加，可独立

```
        ┌────────────────────────────────────────────┐
        │  你的业务仓库                                │
        │  ┌──────────────┐   ┌────────────────────┐ │
        │  │ ELAB 架构    │   │ 普通工程           │ │
        │  │ elab/ mcu/   │   │ AT32_TEST          │ │
        │  │ project/     │   │ STM32_TEST         │ │
        │  └──────┬───────┘   └─────────┬──────────┘ │
        └─────────┼─────────────────────┼────────────┘
                  │  只读挂载（L4 指针） │
        ┌─────────┴─────────────────────┴────────────┐
        │  elab-Flow（ELAB/elab-flow/）                │
        │  L0 host · L1 chips · L2 toolchains          │
        │  L3 CLI · L4 projects · L5 ci · L6 skills    │
        └──────────────────────────────────────────────┘
```

| 组合 | 是否成立 | 说明 |
|---|---|---|
| 只用 ELAB，不用 Flow | ✅ | ELAB 现状（CMake + IDE 插件 + host 单测 CI） |
| 只用 Flow，不用 ELAB | ✅ | Flow 的 D 类以外工程（CubeMX / WorkBench / 纯 Keil） |
| ELAB + Flow | ✅ | ELAB 工程作为 **D 类**被 Flow 挂载，二者**互不侵入** |
| Flow 替代 ELAB | ❌ | 概念错位——Flow 不提供任何代码侧能力 |

> **正交的含义**：ELAB 决定"代码怎么写"，Flow 决定"命令怎么跑"。改一个不影响另一个。

---

## 8. 该从 ELAB 继承什么 / 该刻意不继承什么

### ✅ 继承（4 条思想）

| 继承 | ELAB 里的体现 | 在 Flow 里的落点 |
|---|---|---|
| 1. **芯片差异必须收敛到一个点** | `mcu/<chip>/CMakeLists.txt` | `chip.yaml` |
| 2. **工具链参数与代码分离** | `ide/gcc/scripts/cmake/` 独立于 `usr/` | `toolchains/` 独立于 `projects/` |
| 3. **分层解耦、依赖单向** | app→{elab,mcu} 单向 | L0→L6 单向 |
| 4. **构建真相单一化** | CMake 为主（虽然 EIDE/Keil 没收敛干净） | CMake 唯一真相源，删掉 eide/uvprojx |
| 5. **CI 作为质量门** | cppcheck/MISRA + 单测 | 同一套思路扩到全矩阵 |

### ❌ 刻意不继承（4 条）

| 不继承 | ELAB 里的体现 | 理由 |
|---|---|---|
| 1. **弱符号端口层** | `elab_common.c` 的 `ELAB_WEAK` | 那是**代码级**移植机制，属 OS 式可移植，越界 |
| 2. **host/target 双跑** | `example/{win32,linux,unity_test}` | 同上；Flow 不关心代码能否在本机编译 |
| 3. **多份 IDE 视图** | `ide/{gcc,keil,eide}` | 真相源重复，正是要消掉的断点 G1 |
| 4. **构建描述写进业务仓库** | `usr/CMakeLists.txt` | 与"业务仓库零改动"直接冲突 |

---

## 9. 结论

1. **不是替代关系，是正交关系**：ELAB 管代码，Flow 管工具。一个工程可以只用其一，也可以叠加。
2. **三个"同一个词、两种含义"**要记牢：
   - **分层**：ELAB 分**代码依赖**，Flow 分**工具职责**；
   - **芯片适配**：ELAB 适配给**代码**用，Flow 适配给**工具链**用；
   - **跨芯片**：ELAB 让**代码**跨芯片，Flow 让**命令**跨芯片。
3. **唯一重叠区**是"构建怎么做"，靠 `-DCMAKE_TOOLCHAIN_FILE` + `-DCMAKE_PROJECT_INCLUDE` 解决，
   且只需对 **D 类（ELAB 式）** 工程做一次逐工程核对。
4. **Flow 真正的新增价值**全在 ELAB 没做的四件事上：
   **主机收敛（L0）· 统一入口（L3）· 烧录调试闭环（L2+gdb/openocd）· AI 契约（L6）**。
