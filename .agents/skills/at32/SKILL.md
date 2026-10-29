---
name: at32
description: "at32 平台芯片（AT32F421G8U7）在 elab-Flow 下的编译/烧录/调试闭环。当需要在 AT32F421G8U7 上改动固件并验证、或遇到构建/烧录/调试问题时使用。触发词：at32、AT32F421G8U7、at32_test、at32f421g8u7、elab build/flash/debug/monitor。"
agent_created: true
---

# at32 平台开发闭环（elab-Flow）

> 本文件由 `elab skill` 从 `chips/*.yaml` 自动生成，**请勿手改**——改芯片参数请改 YAML 后重跑 `elab skill`。同一平台多颗芯片聚合在本文件里，按章节区分。

## 0. 你只需要记住一句话

**业务代码不动，工作流用 `elab` 一条命令走完。**
elab 是「外骨骼」：它挂在既有工程外面负责 configure / build / flash / debug / monitor，
不改工程的任何文件（构建前后会用文件树快照自证零改动）。
加 `--json` 可拿到机器可读输出。**产物一律落在 `elab-flow/.work/<project>/`**，不会污染业务工程目录。

## 1. 平台接入的芯片

| 芯片 | 内核 |
|---|---|
| `AT32F421G8U7` | `cortex-m4` |

---

## 芯片 AT32F421G8U7（数据源：`chips/artery/at32f421g8.yaml`）

| 项 | 值 |
|---|---|
| 型号 | `AT32F421G8U7` |
| 内核 | `cortex-m4` |
| 浮点 | `soft` — -mfloat-abi=soft |
| FLASH | 0x10000 (65536 B) @ `0x8000000` |
| RAM | 0x4000 (16384 B) @ `0x20000000` |
| 链接脚本 | `AT32F421x8_FLASH.ld`（归工程所有） |
| openocd target | `target/at32f421xx.cfg` |
| SVD | `AT32F421xx_v2.svd` |

### 接入的工程

| 工程 | 形态 | 业务工程目录（elab 只读，不改） |
|---|---|---|
| `at32_test` | B 类 | `${ELAB_ROOT}/examples/AT32_TEST` |
| `at32f421g8u7` | B 类 | `${ELAB_ROOT}/examples/AT32F421G8U7` |

### 闭环命令（以工程 `at32_test` 为例）

```bash
elab loop  -p at32_test            # ★ 一键闭环：doctor→build→flash→debug→monitor
elab doctor -p at32_test --deep     # 体检 + 校验实际编译参数未漂移
elab build  -p at32_test --clean    # 编译，产出 elf/hex/bin 到 .work/
elab flash  -p at32_test            # openocd 烧录 + verify
elab debug  -p at32_test --verify    # 断到 main 自检（非交互）
elab monitor -p at32_test           # 串口闭环判据：ok / failed / inconclusive
```

### 坑位（先读这一节，能省掉大部分调试时间）

1. 本工程是 **B 类**：CMakeLists 第 22 行 `include(cmake/gcc-arm-none-eabi.cmake)` 硬挂自带工具链。elab 用 -DCMAKE_TOOLCHAIN_FILE 接管后，该文件仍会被 include，把 flags/链接参数盖回去 → 必须挂 inject.cmake 抢回。
2. **链接参数双重叠加**：工程用 `CMAKE_C_LINK_FLAGS`，elab 用 `CMAKE_EXE_LINKER_FLAGS`——两者不同名，CMake 会把两份都拼进链接行，出现两遍 -T/-mcpu。inject.cmake 必须 `unset(CMAKE_C_LINK_FLAGS)` 清掉工程那份，否则一旦两源不一致就是**静默错误**（后者生效）。
3. `add_compile_options()` 必须拆成独立参数（`-mcpu=X -mfloat-abi=Y`），整串会被当成**单个带引号的参数**，gcc 报 `unrecognized -mcpu target: cortex-m4 -mfloat-abi=soft`。
4. 链接脚本由 AT32 WorkBench 随工程生成（`AT32F421x8_FLASH.ld`），**归工程所有**；chip.yaml 只记内存布局用于 doctor 校验，不另存一份，避免双源漂移。
5. inject **不注入 defines/include**：AT32 工程的 defines 由其 INTERFACE target 提供且准确，再注入只会制造双源。chip.yaml 的 `compiler_defines` 仅供 doctor 校验。


## 通用验收清单（改完代码后逐条核对）

**工程 `at32_test`**

- [ ] `elab doctor -p at32_test` 全绿（含漂移校验）
- [ ] `elab build -p at32_test` 通过，`guard.untouched == true`（业务工程零改动）
- [ ] `elab debug -p at32_test --verify` 断到 `main`
- [ ] `elab monitor -p at32_test` 判 **ok**（`^\[(boot|alive)\]` 判据命中）

**工程 `at32f421g8u7`**

- [ ] `elab doctor -p at32f421g8u7` 全绿（含漂移校验）
- [ ] `elab build -p at32f421g8u7` 通过，`guard.untouched == true`（业务工程零改动）
- [ ] `elab debug -p at32f421g8u7 --verify` 断到 `main`
- [ ] `elab monitor -p at32f421g8u7` 判 **ok**（`^\[(boot|alive)\]` 判据命中）

## 通用定位顺序（出问题先走这条）

1. `elab doctor` 先跑一遍——它会把「主机路径不可达」「两源漂移」直接指出来。
2. 编译参数怪 → `elab doctor --deep`（它会真跑 configure，
   从 `compile_commands.json` 取**实际编译命令**作证据）。
3. 产物名不对/找不到 elf → 检查通用工具链的 `.elf` 后缀约定（约束 C5）。
4. 烧录失败 → `elab flash -p … --dry-run` 看 openocd 命令行，
   再确认探针已插好、`elab.host.yaml` 的 openocd 路径正确。
5. **串口能打开却 0 字节** → 两个已知原因：① MCU 停在 halt 态（debug 收尾没有 `reset run`）——重跑 `elab flash`（自带 Resetting Target）即可；② openocd/第三方串口工具占用 VCP（约束 N5，serial 与 debug 不可并行）。

