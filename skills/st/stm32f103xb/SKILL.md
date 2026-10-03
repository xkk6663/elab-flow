---
name: st_stm32f103xb
description: "STM32F103xB（cortex-m3）在 elab-Flow 下的编译/烧录/调试闭环。当需要在 STM32F103xB 上改动固件并验证、或遇到构建/烧录/调试问题时使用。触发词：stm32f103xb、STM32F103xB、stm32_test、elab build/flash/debug。"
agent_created: true
---

# STM32F103xB 芯片开发闭环（elab-Flow）

> 本文件由 `elab skill` 从 `chips/*.yaml` 自动生成，**请勿手改**——改芯片参数请改 YAML 后重跑 `elab skill`。

## 0. 你只需要记住一句话

**业务代码不动，工作流用 `elab` 一条命令走完。**
elab 是「外骨骼」：它挂在既有工程外面负责 configure / build / flash / debug，
不改工程的任何文件（构建前后会用文件树快照自证零改动）。

## 1. 芯片身份（数据源：`chips/st/stm32f103xb.yaml`）

| 项 | 值 |
|---|---|
| 型号 | `STM32F103xB` |
| 内核 | `cortex-m3` |
| 浮点 | `none` — ★ 无 FPU → 不产出 -mfloat-abi |
| FLASH | 0x10000 (65536 B) @ `0x8000000` |
| RAM | 0x5000 (20480 B) @ `0x20000000` |
| 链接脚本 | `STM32F103XX_FLASH.ld`（归工程所有） |
| openocd target | `target/stm32f1x.cfg` |
| openocd interface | `?` |
| SVD | `STM32F103.svd` |

## 2. 接入的工程

| 工程 | 形态 | 业务工程目录（elab 只读，不改） |
|---|---|---|
| `stm32_test` | A 类 | `${ELAB_ROOT}/examples/STM32_TEST` |

## 3. 闭环命令

```bash
elab loop  -p stm32_test            # ★ 一键闭环：doctor→build→flash→debug
elab doctor -p stm32_test --deep     # 体检 + 校验实际编译参数未漂移
elab build  -p stm32_test --clean    # 编译，产出 elf/hex/bin 到 .work/
elab flash  -p stm32_test            # openocd 烧录 + verify
elab debug  -p stm32_test --verify    # 断到 main 自检（非交互）
elab debug  -p stm32_test --run       # 交互式 gdb 调试
```

加 `--json` 可拿到机器可读输出。**产物一律落在 `elab-flow/.work/<project>/`**，不会污染业务工程目录。

## 4. 坑位（先读这一节，能省掉大部分调试时间）

1. 本工程是 **A 类**：工具链由 preset 的 `toolchainFile` 指定（命令行级）。elab 用 -DCMAKE_TOOLCHAIN_FILE 接管后，工程自带工具链文件**根本不会被加载**。
2. **静默丢约定（最危险）**：工程自带工具链里有 `set(CMAKE_EXECUTABLE_SUFFIX_C ".elf")`。接管后该约定丢失，产物会从 `TEST.elf` 变成无后缀的 `TEST`——**构建照样成功、不报错**，故障推迟到 flash 阶段才爆发。修法：`.elf` 后缀写进**通用** `toolchains/gcc.cmake`（对所有芯片一致）。
3. **第二个丢失项**：`set(TOOLCHAIN_LINK_LIBRARIES "m")` 被 `cmake/stm32cubemx/CMakeLists.txt` 的 `MX_LINK_LIBS` 引用；接管后该变量 undefined，libm 不会参与链接。inject.cmake 必须补回（本次恰好没用到 libm 符号而侥幸通过，属隐患）。
4. **Cortex-M3 无 FPU**：`fpu: none` 时**绝不能**产出 `-mfloat-abi`。`gcc.cmake` 与 `inject.cmake` 都按 `none` 分支跳过该参数。
5. 本工程 ld 只声明 **64K flash**（`STM32F103xB` 官方标称 128K）——**以 ld 为准**，因为 ld 才是链接器实际使用的边界。
6. 本工程 CMakeLists **没有** POST_BUILD objcopy，hex/bin 由 elab build 统一产出（约束 C6）。

## 5. 验收清单（改完代码后逐条核对）

- [ ] `elab doctor -p stm32_test` 全绿（含漂移校验）
- [ ] `elab build -p stm32_test` 通过，且内存占用与 chip.yaml 一致（期望 FLASH 0x10000 (65536 B)、RAM 0x5000 (20480 B)）
- [ ] `guard.untouched == true`（业务工程零改动）
- [ ] `elab debug -p stm32_test --verify` 断到 `main`

## 6. 出问题时的定位顺序

1. `elab doctor` 先跑一遍——它会把「主机路径不可达」「两源漂移」直接指出来。
2. 编译参数怪 → `elab doctor --deep`（它会真跑 configure，
   从 `compile_commands.json` 取**实际编译命令**作证据）。
3. 产物名不对/找不到 elf → 检查通用工具链的 `.elf` 后缀约定（约束 C5）。
4. 烧录失败 → `elab flash -p … --dry-run` 看 openocd 命令行，
   再确认探针已插好、`elab.host.yaml` 的 openocd 路径正确。

