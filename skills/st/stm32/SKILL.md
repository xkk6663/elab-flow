---
name: stm32
description: "stm32 平台芯片（STM32F103xB、STM32F411xE）在 elab-Flow 下的编译/烧录/调试闭环。当需要在 STM32F103xB/STM32F411xE 上改动固件并验证、或遇到构建/烧录/调试问题时使用。触发词：stm32、STM32F103xB、STM32F411xE、f411、stm32_test、elab build/flash/debug/monitor。"
agent_created: true
---

# stm32 平台开发闭环（elab-Flow）

> 本文件由 `elab skill` 从 `chips/*.yaml` 自动生成，**请勿手改**——改芯片参数请改 YAML 后重跑 `elab skill`。同一平台多颗芯片聚合在本文件里，按章节区分。

## 0. 你只需要记住一句话

**业务代码不动，工作流用 `elab` 一条命令走完。**
elab 是「外骨骼」：它挂在既有工程外面负责 configure / build / flash / debug / monitor，
不改工程的任何文件（构建前后会用文件树快照自证零改动）。
加 `--json` 可拿到机器可读输出。**产物一律落在 `elab-flow/.work/<project>/`**，不会污染业务工程目录。

## 1. 平台接入的芯片

| 芯片 | 内核 |
|---|---|
| `STM32F103xB` | `cortex-m3` |
| `STM32F411xE` | `cortex-m4` |

---

## 芯片 STM32F103xB（数据源：`chips/st/stm32f103xb.yaml`）

| 项 | 值 |
|---|---|
| 型号 | `STM32F103xB` |
| 内核 | `cortex-m3` |
| 浮点 | `none` — ★ 无 FPU → 不产出 -mfloat-abi |
| FLASH | 0x10000 (65536 B) @ `0x8000000` |
| RAM | 0x5000 (20480 B) @ `0x20000000` |
| 链接脚本 | `STM32F103XX_FLASH.ld`（归工程所有） |
| openocd target | `target/stm32f1x.cfg` |
| SVD | `STM32F103.svd` |

### 接入的工程

| 工程 | 形态 | 业务工程目录（elab 只读，不改） |
|---|---|---|
| `stm32_test` | A 类 | `${ELAB_ROOT}/examples/STM32_TEST` |

### 闭环命令（以工程 `stm32_test` 为例）

```bash
elab loop  -p stm32_test            # ★ 一键闭环：doctor→build→flash→debug→monitor
elab doctor -p stm32_test --deep     # 体检 + 校验实际编译参数未漂移
elab build  -p stm32_test --clean    # 编译，产出 elf/hex/bin 到 .work/
elab flash  -p stm32_test            # openocd 烧录 + verify
elab debug  -p stm32_test --verify    # 断到 main 自检（非交互）
elab monitor -p stm32_test           # 串口闭环判据：ok / failed / inconclusive
```

### 坑位（先读这一节，能省掉大部分调试时间）

1. 本工程是 **A 类**：工具链由 preset 的 `toolchainFile` 指定（命令行级）。elab 用 -DCMAKE_TOOLCHAIN_FILE 接管后，工程自带工具链文件**根本不会被加载**。
2. **静默丢约定（最危险）**：工程自带工具链里有 `set(CMAKE_EXECUTABLE_SUFFIX_C ".elf")`。接管后该约定丢失，产物会从 `TEST.elf` 变成无后缀的 `TEST`——**构建照样成功、不报错**，故障推迟到 flash 阶段才爆发。修法：`.elf` 后缀写进**通用** `toolchains/gcc.cmake`（对所有芯片一致）。
3. **第二个丢失项**：`set(TOOLCHAIN_LINK_LIBRARIES "m")` 被 `cmake/stm32cubemx/CMakeLists.txt` 的 `MX_LINK_LIBS` 引用；接管后该变量 undefined，libm 不会参与链接。inject.cmake 必须补回（本次恰好没用到 libm 符号而侥幸通过，属隐患）。
4. **Cortex-M3 无 FPU**：`fpu: none` 时**绝不能**产出 `-mfloat-abi`。`gcc.cmake` 与 `inject.cmake` 都按 `none` 分支跳过该参数。
5. 本工程 ld 只声明 **64K flash**（`STM32F103xB` 官方标称 128K）——**以 ld 为准**，因为 ld 才是链接器实际使用的边界。
6. 本工程 CMakeLists **没有** POST_BUILD objcopy，hex/bin 由 elab build 统一产出（约束 C6）。


---

## 芯片 STM32F411xE（数据源：`chips/st/stm32f411ceux.yaml`）

| 项 | 值 |
|---|---|
| 型号 | `STM32F411xE` |
| 内核 | `cortex-m4` |
| 浮点 | `hard` — -mfloat-abi=hard + -mfpu=fpv4-sp-d16 |
| FLASH | 0x80000 (524288 B) @ `0x8000000` |
| RAM | 0x20000 (131072 B) @ `0x20000000` |
| 链接脚本 | `STM32F411XX_FLASH.ld`（归工程所有） |
| openocd target | `target/stm32f4x.cfg` |
| SVD | `STM32F411.svd` |

### 接入的工程

| 工程 | 形态 | 业务工程目录（elab 只读，不改） |
|---|---|---|
| `f411` | A 类 | `${ELAB_ROOT}/examples/STM32F411CEU6` |

### 闭环命令（以工程 `f411` 为例）

```bash
elab loop  -p f411            # ★ 一键闭环：doctor→build→flash→debug→monitor
elab doctor -p f411 --deep     # 体检 + 校验实际编译参数未漂移
elab build  -p f411 --clean    # 编译，产出 elf/hex/bin 到 .work/
elab flash  -p f411            # openocd 烧录 + verify
elab debug  -p f411 --verify    # 断到 main 自检（非交互）
elab monitor -p f411           # 串口闭环判据：ok / failed / inconclusive
```

### 坑位（先读这一节，能省掉大部分调试时间）

1. 本工程是 **A 类**：工具链由 preset 的 `toolchainFile` 指定（命令行级）。elab 用 -DCMAKE_TOOLCHAIN_FILE 接管后，工程自带工具链文件**根本不会被加载**。
2. **自述变量丢失**：工程自带工具链里 `set(TOOLCHAIN_LINK_LIBRARIES "m")` 被 `cmake/stm32cubemx/CMakeLists.txt` 的 `MX_LINK_LIBS` 引用；接管后该变量 undefined，libm 不会参与链接。inject.cmake 必须补回（与 F103 同款坑）。
3. **`.elf` 后缀约定**：工程自带工具链设了 CMAKE_EXECUTABLE_SUFFIX_*=\".elf\"，接管后丢失 → 产物变无后缀 `411`。通用 `toolchains/gcc.cmake` 已统一带该约定（约束 C5）。
4. **M4F hard float**：`fpu: hard` + `mfpu: fpv4-sp-d16` 两个值都要下传；只写 `-mfloat-abi=hard` 虽能靠 GCC 默认 FPU 通过，但无法被 doctor 的 expect_flags 校验到真实参数。
5. **嵌套副本**：examples/STM32F411CEU6/411/ 是同一工程的完整嵌套副本（含自己的 build/）。elab 只认**外层** CMakeLists.txt；guard 快照会连副本一起扫，切勿在副本里改文件造成误报。
6. **ioc 的 CPN vs 编译宏**：411.ioc 的 Mcu.CPN=STM32F411CEU6 是封装具体型号，编译宏 STM32F411xE 是族级宏 —— 两者本就不同，以编译宏（E1）为准。
7. **工程根 build/ 有 IDE 旧构建**（STM32Cube bundles 14.3.1 产物 411.elf）：elab 一律在 .work/<project>/ 独立构建，**不复用也不清理**业务工程的 build/。
8. **printf 需要 __io_putchar 强定义**：CubeMX 生成的 syscalls.c 只有 weak 声明，无定义时 printf 的 _write() 会调到地址 0（跳飞）。本工程已在 usart.c USER CODE 区补了带函数体的定义 + freertos.c 心跳打印。


## 通用验收清单（改完代码后逐条核对）

**工程 `f411`**

- [ ] `elab doctor -p f411` 全绿（含漂移校验）
- [ ] `elab build -p f411` 通过，`guard.untouched == true`（业务工程零改动）
- [ ] `elab debug -p f411 --verify` 断到 `main`
- [ ] `elab monitor -p f411` 判 **ok**（`^\[(boot|alive)\]` 判据命中）

**工程 `stm32_test`**

- [ ] `elab doctor -p stm32_test` 全绿（含漂移校验）
- [ ] `elab build -p stm32_test` 通过，`guard.untouched == true`（业务工程零改动）
- [ ] `elab debug -p stm32_test --verify` 断到 `main`
- [ ] `elab monitor -p stm32_test` 判 **ok**（`^\[(boot|alive)\]` 判据命中）

## 通用定位顺序（出问题先走这条）

1. `elab doctor` 先跑一遍——它会把「主机路径不可达」「两源漂移」直接指出来。
2. 编译参数怪 → `elab doctor --deep`（它会真跑 configure，
   从 `compile_commands.json` 取**实际编译命令**作证据）。
3. 产物名不对/找不到 elf → 检查通用工具链的 `.elf` 后缀约定（约束 C5）。
4. 烧录失败 → `elab flash -p … --dry-run` 看 openocd 命令行，
   再确认探针已插好、`elab.host.yaml` 的 openocd 路径正确。
5. **串口能打开却 0 字节** → 两个已知原因：① MCU 停在 halt 态（debug 收尾没有 `reset run`）——重跑 `elab flash`（自带 Resetting Target）即可；② openocd/第三方串口工具占用 VCP（约束 N5，serial 与 debug 不可并行）。

