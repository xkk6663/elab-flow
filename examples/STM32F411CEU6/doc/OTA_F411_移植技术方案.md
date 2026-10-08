# STM32-OTA-QT → F411CEU6 平台化移植技术方案

> 工程：`examples/STM32F411CEU6`（APP，FreeRTOS）＋ 新建 `examples/F411CEU6_BOOT`（Bootloader）
> 源工程：`C:/Users/xiao1/Desktop/STM32-OTA-QT`（STM32F103C8 IAP + PyQt6 上位机）
> 组件真身：`C:/Users/xiao1/Desktop/AT32/AT32F421G8U7_WorkBench/ota/`（core 已双平台回归）
> 目标：**0 功能阉割**移植，按 elab「一切皆组件」原则把 OTA 收进框架，上位机全功能复现。
> 状态：**方案评审稿**（M0 未动工）

---

## 0. 源码盘点结论（已读完毕）

### 0.1 三份资产

| 资产 | 位置 | 状态 |
|---|---|---|
| MCU 协议/状态机/断点续传 | STM32-OTA-QT `IAP-Bootloader/`（F103C8 标准库，~1000 行） | 可用，但 Hardware 层是 F1 专用 |
| **ota/core 组件（芯片无关）** | AT32F421G8U7_WorkBench `ota/core/`（820 行：protocol/flash_store/offset/upgrade_state/crc32/transport） | ★ 已被 STM32-OTA-QT `USE_SHARED_OTA_CORE` 开关双平台回归（git `db1db05`），**这是移植基线** |
| 上位机（PyQt6 + CLI） | STM32-OTA-QT `iap_host_tool/`（2712 行） | 已 profile 化（git `bb56404`），加 F411 profile 即可，**其余零改动** |

### 0.2 关键既有机制（移植时必须原样保留）

| 机制 | 说明 | 0 阉割对应上位机功能 |
|---|---|---|
| 帧协议 `AA/55 + CRC32 + 长度定界` | 数据帧 `AA 01 SEQ LEN DATA CRC32 55`；命令帧 `AA 02 CMD CRC32 55`；应答统一 `{STATUS,SEQ,PAGES}` | TX/RX 包视图逐字节对拍 |
| SEQ 重传 ×3 | CRC 错 → ACK `STATUS=1` → 主机重发同 SEQ | `cli_flash.py --corrupt-frame N`（人为破坏第 N 帧 CRC 验证重传） |
| 断点续传 | 每 1024B 存 offset（slot 磨损均衡）；`STATE_UPGRADING` 复电恢复运行 CRC + 擦剩余区 | `cli_flash.py --throttle P`（限发百分比后断电重启续传） |
| 5 状态机 | RUNNING / UPGRADE_READY / UPGRADING / CRC_FAIL / UPGRADE_SUCCESS（append-only slot 存储） | `CMD_QUERY_STATE(0x14)` 查询 |
| `'!'×5` 触发 | APP 收 5 连 `'!'` → 写 READY → 复位；boot 2s 窗口收 `'!'`/`0xAA`/KEY | 上位机触发逻辑（AT32 profile 同款 `bang5`） |
| Transport 抽象 | `init/deinit/read/write/available` 五函数指针，`Transport_Attach` 注册 | 协议层与介质解耦，F411 复用同一协议 |
| CMD_SET | QUERY_OFFSET(0x12) / RESET_UPGRADE(0x13) / QUERY_STATE(0x14)，未知命令回 NAK | CLI 全部命令 |
| **CMD_QUERY_COMPONENTS(0x15)（新扩展 v1.2）** | 应答 `RSP_COMPONENTS(0x24)` = 4B 组件位图 LE（bit0=ota, bit1=serial） | **上位机按设备真实能力动态出 UI**（§6.2）；旧固件回 NAK → 上位机回落 profile 静态声明，存量行为零变化 |

### 0.3 已固化的踩坑（必须继承，出处 AT32 ota port 注释）

1. **MSP 原子跳转**（AT32 `ota_jump.c` §25）：`__set_MSP()` 后不能再用 C 函数调用跳转——编译器在函数返回前会 `ldmia sp!,{...}` 读已换掉的栈。必须内联汇编 `msr msp, %0 / bx %1` 原子完成。F411 的 `ota_jump.c` 照抄此结构。
2. **SysTick CLKSOURCE 保留**（AT32 `ota_delay.c` §24）：配 LOAD 后必须 `SysTick->CTRL |= TICKINT|ENABLE`，直接 `=` 会清 CLKSOURCE 位，时基慢 8 倍，2s 窗口变 16s。
3. **boot 清 DMA 残留**：`Boot_CheckState()` 开头先排空 Transport 缓冲（防升级后残留 `'U'`/`0xAA` 误触发）。
4. **跳转前复意外设时钟**（F1 `RCC_DeInit()` / AT32 `crm_reset()`）：F411 用 `HAL_RCC_DeInit()` + 清 SysTick（CTRL=0、VAL=0）+ `HAL_MspDeInit` 语义。

---

## 1. F411CEU6 差异分析（F103C8 → F411CEU6）

| 维度 | 源（F103C8） | 目标（F411CEU6） | 影响 |
|---|---|---|---|
| 内核 | Cortex-M3，无 FPU | Cortex-M4F（hard float） | elab N7 已支持 `-mfpu` 下传；boot 工程同配 |
| Flash 模型 | **1KB 均匀页**，半字/字编程 | **非均匀扇区**（4×16K + 1×64K + 3×128K），字节/半字/字/双字编程 | 擦除逻辑必须扇区表驱动（§3.3） |
| Flash 总量 | 64KB（Boot 18K + APP 44K + 2×1K 参数页） | 512KB | 分区重排（§2） |
| 库 | StdPeriph（`FLASH_ErasePage` 等） | HAL（`HAL_FLASH_Unlock/Ex_Erase/Program`） | 新写 `port/stm32f4/` |
| DMA RX | DMA1_Channel5（USART1_RX）环形 | **DMA2_Stream2 Ch4**（本工程 usart.c 已配 Stream2=RX、Stream7=TX） | F4 transport 独立自配，不复用 FreeRTOS 侧 usart.c |
| APP 向量偏移 | `NVIC_SetVectorTable(FLASH, 0x4800)` | `system_stm32f4xx.c: VECT_TAB_OFFSET` 或 `SCB->VTOR` | §5.2 |
| APP 运行时 | 裸机 while(1) | **FreeRTOS**（fputc=DMA+互斥锁） | `'!'` 扫描挂 USART1 中断，消费在任务里（§5.3） |
| 上位机 | STM32 profile（单 `'!'`×10） | 新增 F411 profile（`bang5`，与 AT32 同语义） | §6.1，其余零改动 |

---

## 2. Flash 分区方案（F411 512KB）

```
0x08000000 ┌────────────────────────────┐ S0
           │     Bootloader  32KB       │ S1      （Boot = S0+S1）
0x08008000 ├────────────────────────────┤ S2
           │  Upgrade State   16KB      │         （4096 槽 @ 32bit）
0x0800C000 ├────────────────────────────┤ S3
           │  Offset Record   16KB      │         （4096 槽 @ 32bit）
0x08010000 ├────────────────────────────┤ S4
           │                            │
           │     APP  448KB             │ S5~S7   （S4=64K + S5..S7=3×128K）
           │   （FreeRTOS + OTA 客户端） │
0x08080000 └────────────────────────────┘
```

**设计取舍**：
- Boot 32K：HAL 版 boot（USART1+DMA+GPIO+FLASH）+ ota core 实测预期 18~26K（-Os），余量充足。
- State 与 Offset **分占两个独立 16K 扇区**：不能像 F1 那样两页紧挨——F4 扇区大，若共用扇区，`OFFSET_Init()` 擦扇区会把 state 一并抹掉（F1 上两页独立无此问题）。分开后互不波及。
- slot 数 256→4096：append-only 磨损均衡的擦除频率再降 16 倍（同一份算法，只是 `OTA_STORE_SLOT_COUNT` 参数化）。
- 传输页粒度 **保持 1024B**（`PACKET_SIZE=128` 不变）：协议层 `PAGES` 字段语义、上位机进度条、offset 记录节奏全部不变——这是上位机零改动的关键。
- APP 起始 `0x08010000` 与 elab F411 现有 ld 分离：现 `STM32F411XX_FLASH.ld` 是单镜像布局（0x08000000 起），M2 起改为 APP 布局新 ld `STM32F411CEU6_APP.ld`（boot 区不进 APP 链接视图）。

---

## 3. elab「一切皆组件」：components/ota 设计

### 3.1 组件目录（elab-flow 仓库新增）

```
elab-flow/components/
├── components.cmake            # 组件注册入口（被业务工程 include）
├── serial/                     # ★ 串口组件（一切皆组件：串口能力独立成件）
│   ├── CMakeLists.txt          # serial_port_<plat> STATIC 库
│   ├── README.md               # 组件契约（Transport 五函数接口 + 波特率/缓冲配置）
│   ├── core/                   # serial_config.h（波特率/缓冲大小/口号线束的配置骨架）
│   └── port/
│       ├── stm32f4/
│       │   └── serial_usart1_dma.c/.h  # USART1 + DMA2_Stream2 环形接收
│       │                               # （实现 ota 的 Transport 五函数接口；
│       │                               #   DMA 通道/流/线束参数由 serial_config.h 可调）
│       ├── at32/               # 从 AT32 ota port 提炼
│       └── stm32f1/            # 从 STM32-OTA-QT My_Usart 提炼
└── ota/
    ├── CMakeLists.txt          # ota_core STATIC 库 + port 选择
    ├── README.md               # 组件契约（接入方式/配置项/验收）
    ├── core/                   # ★ 唯一真源：从 AT32 ota/core 原样提升
    │   ├── ota_common.h        #   布局常量 → 改由 port 布局头提供（见 3.2）
    │   ├── ota_protocol.c/.h   #   帧状态机（零改动）
    │   ├── ota_flash_store.c/.h#   slot 存储（零改动）
    │   ├── ota_offset.c/.h     #   断点续传（零改动）
    │   ├── ota_upgrade_state.c/.h
    │   ├── ota_crc32.c/.h
    │   ├── ota_transport.c/.h  #   Transport 抽象（零改动；实现来自 serial 组件）
    │   ├── ota_cap.c/.h        #   ★ 新增可选模块：组件发现（注册 CMD 0x15 应答，
    │   │                       #     报告本固件组件位图；不编入则 0x15 走 NAK）
    │   └── ota_boot_flow.c/.h  #   ★ boot 流程场景层（芯片无关部分）：
    │                           #     Boot_CheckState / ProcessRX 状态机（从各工程
    │                           #     User/boot.c 提升，G_RxBuffer 等收编为组件内部态）；
    │                           #     芯片相关的 Jump_To_App 留在各 port（ota_jump.c）
    └── port/
        ├── at32/               # 搬迁 + **去业务化**（见 §3.5）：ota_app_hook 的
        │                       #   Sguan.Func_Stop / TMR1 PWM 引用 → 弱回调注册
        ├── stm32f1/            # 从 STM32-OTA-QT 提炼（F103 老工程回归用）
        └── stm32f4/            # ★ 新写：本次移植核心
            ├── ota_layout_f411.h      # 分区常量 + OTA_STORE_SLOT_COUNT
            ├── ota_flash_hal.c        # HAL_FLASH 扇区表实现
            ├── ota_delay.c/.h         # SysTick 忙等（boot 用）
            ├── ota_jump.c/.h          # MSP 原子跳转（继承 §0.3-1 坑）
            ├── ota_app_hook.c/.h      # APP 侧 '!'×5 + FreeRTOS 停机链
            └── ota_printf.c           # boot 侧日志（printf → Transport）
```

> **串口为何独立成组件**：原方案把 `ota_usart_hal.c` 塞在 ota/port 里——但串口是
> 跨组件通用能力（boot 要 DMA 环形收包、APP 的 fputc 已占 DMA、未来任何
> 通信类组件都要用），塞在 ota 里会形成"接 ota 才有串口"的伪依赖。
> 依赖方向：`ota(VARIANT boot) → serial(stm32f4)`（ota 通过 Transport 五函数
> 抽象使用 serial 的实现实例），ota core 不感知 serial 存在。
> **APP 侧可选**：APP 的 CubeMX usart.c（fputc DMA 链）保持不动，`ota_app_hook`
> 字节源默认挂现有 USART1 中断；serial 组件在 APP 是**可选并行接入**（独立
> 实例/独立 DMA 流配置时才需要），boot 是必接。

### 3.2 core 的四处「配置面」改造（功能零改动）

`0 阉割` 约束 = **core 的功能代码一行不动**（协议/状态机/磨损均衡/续传逻辑照搬已回归版本）。但布局常量是 per-chip 配置，需把三处常量从硬编码改为 port 注入：

| # | 现状（core 硬编码） | 改造后 | 影响文件 |
|---|---|---|---|
| 1 | `ota_common.h` 硬编码 F1 布局（`APP_START_ADDRESS=0x08004800` 等） | 布局宏由 `port/<plat>/ota_layout_<chip>.h` 定义，`ota_common.h` 只 `#include OTA_LAYOUT_HEADER` | ota_common.h + 各 port |
| 2 | `ota_flash_store.h: FLASH_STORE_SLOT_COUNT 256` | 改 `OTA_STORE_SLOT_COUNT`，由 layout 头提供（F1=256，F4=4096） | ota_flash_store.h |
| 3 | 擦除粒度 = 1K 页（boot.c 按 `APP_PAGE_COUNT×1K` 循环调 `ErasePage`） | HAL 新增 `OtaFlashHal_EraseRange(start, end)`：F1/AT32 按页循环、**F4 按扇区表遍历**（详见 3.3）。boot.c（per-project 层，非 core）改调新原语 | ota_flash_hal.h + 各 port + boot.c |
| 4 | 协议分发器（`ota_protocol.c`）命令表硬编码 0x12/0x13/0x14，未知回 NAK | 新增 `OtaProtocol_RegisterExtCmd(cmd, handler)` 注册接口：分发器查完内置表后查注册表，未命中仍回 NAK。**0x12~0x14 路径与回归版本逐字节一致** | ota_protocol.h/.c + ota_cap.c（消费方） |

> 改造 #4 是「组件发现」（§6.2）的 MCU 侧地基：`ota_cap.c` 用注册接口挂 0x15，
> 不侵入既有命令路径。四个改造点全部属于「接口/配置面」，core 六文件的
> 功能逻辑（状态机/协议/磨损均衡/续传）依旧一行不动。

### 3.3 F4 擦除的语义修正（本次移植最大陷阱）

F1 的 `My_Flash_Erase(addr, N页)` 按 1K 粒度循环。F4 上：

- **APP 区擦除**：`EraseRange(0x08010000, 0x08080000)` = 擦 S4..S7，4 次扇区擦除（F1 要 44 次，F4 反而更快）。
- **断点续传擦"剩余区"**：`done_bytes = N×1024` 落在扇区中间时，**不能擦 done_bytes 所在扇区**（该扇区前段已写入有效数据），也不能不擦（后续扇区未编程）。规则：
  ```
  erase_from = ALIGN_SECTOR_UP(done_bytes)   # 向上取整到扇区边界
  EraseRange(APP_START + erase_from, APP_END)
  ```
  done_bytes 所在扇区的未编程尾段保持已擦状态（F4 编程只做 1→0，续写合法）。
- **F4 编程约束**：字编程（PSIZE=32bit，VDD≥2.7V ✓3.3V）；boot 全程在 flash 取指，编程时硬件自动 stall（单 bank F411 无需 RAM 拷贝运行，与 F1 现状一致）。

### 3.4 「选择性添加」接入契约（v1）

**组件是被工程主动引用的，elab 不强塞**（C4 零改动原则的自然延伸）：

```cmake
# 业务工程顶层 CMakeLists.txt（CubeMX 注释声明"User is free to modify"的自由区）
set(ELAB_ROOT "C:/Users/xiao1/Desktop/ELAB/elab-flow" CACHE PATH "elab-flow root")
include(${ELAB_ROOT}/components/components.cmake)      # 注册组件
elab_use_component(serial                              # ① 先接串口组件
    PLATFORM stm32f4
    INSTANCE usart1_dma)                               #   实例：USART1+DMA 环形
elab_use_component(ota                                 # ② 再接 OTA（自动带依赖）
    PLATFORM stm32f4
    VARIANT boot)                                      #   boot / app 两种裁剪
```

- `elab_use_component()` 内部 = `add_subdirectory(components/<name>)` + `target_link_libraries(<proj> <name>_port_<plat>)` + 按 VARIANT 选 include（ota 的 boot 变体不含 app_hook；app 变体不含 boot 状态机）。**组件声明 `DEPENDS serial` 时自动递归接入**（ota boot 变体依赖 serial；app 变体不依赖——字节源挂现有 USART1 中断）。
- 组件注册表（components.cmake）里每个组件声明：名称 / 依赖 / 提供的 Transport 实例 / **能力位图位号**（ota=bit0、serial=bit1——与 §6.2 发现协议一致，单一数据源）。
- `projects/*.yaml` 同步声明（信息性 + doctor/CI 可校验一致性）：
  ```yaml
  components:            # elab 组件接入声明（v1：doctor 展示 + guard 范围提示）
    - name: serial
      platform: stm32f4
      instance: usart1_dma
    - name: ota
      platform: stm32f4
      variant: boot      # f411_boot.yaml / app  # f411.yaml
  ```
- 组件源码在 elab 仓库内 → **guard 快照范围不变**（快照的是业务工程 root；组件在 ELAB_ROOT 下由 git 管）。
- 上位机/协议回归安全网：AT32 工程 `USE_SHARED_OTA_CORE` 改指 elab `components/ota/core` 后重跑 AT32 build（逐字节对比旧 ota_core 归档），证明提升动作零漂移（M0 验收）。

### 3.5 组件准入规则（★ 框架侧零业务代码的保证）

**elab 框架（services/ toolchains/ cockpit/ chips/）保持零业务代码；`components/`
是框架新增的「可复用中间件层」，性质等同 toolchains 的通用资产。组件 ≠ 业务，
准入按以下硬规则判定（M0 起由 CI 扫描强制）：**

| # | 准入规则 | 违例示例（本次审查发现） |
|---|---|---|
| 1 | 组件代码不得 include 任何产品/工程头文件（`SguanESC.h`、`main.h`、`KEY.h`…） | AT32 `ota_app_hook.c` 带 `#include "SguanESC.h"` + `Sguan.Func_Stop()` + `tmr_output_enable(TMR1,...)` —— **搬入前必须解耦** |
| 2 | 产品差异点一律用**弱回调/注册**注入：`OtaHook_SetOnUpgradeReady(cb)`，业务工程注册自己的停机链；不注册 = 该环节为空 | 同上：停机链是 BLDC 业务，组件只提供"触发→写 READY→延时→复位"通用时序 |
| 3 | 组件分 core（芯片无关）/ port（HAL 映射，只准调芯片 SDK 与组件 core）/ scenes（场景层：boot 流程、app 钩子骨架——**只含协议时序，不含产品行为**） | boot.c 若原样搬，`Key_Init`/LED 等工程私货会混入 → 提升时剥离 |
| 4 | 每组件必须有 README 契约（接口/配置/验收）+ ≥1 个工程引用 + `projects/*.yaml` 声明（§3.4） | — |
| 5 | CI 扫描：`grep -rE '#include "(Sguan\|main\.h\|KEY\.h\|.*ESC.*)"' components/` 必须为空 + doctor 校验 yaml 声明与 CMake 实接一致 | — |

**boot.c 的归属裁决**：boot 流程状态机（CheckState/ProcessRX）是 OTA 协议的
实现主体而非产品业务 → 芯片无关部分提升为 `components/ota/core/ota_boot_flow.c`
（G_RxBuffer/G_RunningCRC 等全局收编为组件内部态）；芯片相关 `Jump_To_App`
留在各 port（AT32 `ota_jump.c` 已验证此拆分）。F411_BOOT 工程 main.c 只剩
`Transport_Attach + OtaBootFlow_Run` 十余行——**业务工程更薄，框架不增业务**。
APP 的 LED/按键/FreeRTOS 业务全部留在 F411 工程（组件只提供 `ota_app_hook`
骨架与触发回调位），F411 侧无任何东西需要"收回"。

---

## 4. 双工程接入 elab

| 工程 | root | 说明 |
|---|---|---|
| `f411_boot`（新） | `examples/F411CEU6_BOOT/` | 精简 bare-metal CMake 工程（无 CubeMX）：startup（复用 APP 的 `startup_stm32f411xe.s`）+ `BOOT.ld`（32K）+ 薄 main.c（`Transport_Attach + OtaBootFlow_Run`，流程在组件 §3.5）+ 组件 `VARIANT boot` |
| `f411`（现有） | `examples/STM32F411CEU6/` | APP：改 APP 布局 ld + VTOR + 组件 `VARIANT app`（FreeRTOS 侧集成） |

- `f411_boot.yaml`：archetype=A（无 preset/无行内 include，elab `-D` 全接管）；产物 `411_boot.elf/bin`。
- **C33 双镜像烧录**：`f411` 的 flash 段配置 `images:`（boot.bin@0x08000000 + app.bin@0x08010000），`link_channel: c_flags` 沿用 AT32 双镜像经验（本工程 APP 无 bootloader 子目录，属"温和 B 场景"，`exe_flags` 通道亦可——M3 实测定通道）。
- **debug 镜像模式**：C33 已支持跳 load 改设 SP/PC（`debug.images` 语义），断点 `main` 同样可验。
- **monitor 判据**（两工程分开跑，N5 串口互斥天然满足）：
  - `f411_boot`：`close_on: "=== Bootloader Start|Upgrade requested|Resuming from page"`（boot.c 原生 printf，115200）
  - `f411`：现有 `^\[(boot|alive)\]` 不变

---

## 5. APP 侧（FreeRTOS 工程）改造点

### 5.1 ld 与向量

```ld
/* STM32F411CEU6_APP.ld */
FLASH (rx) : ORIGIN = 0x08010000, LENGTH = 448K
```
`system_stm32f4xx.c`：`#define VECT_TAB_OFFSET 0x00010000`（或运行时 `SCB->VTOR = 0x08010000`，二选一，M2 固化前者）。

### 5.2 组件接入（VARIANT app）

- `USART1_IRQHandler`（`stm32f4xx_it.c` USER CODE 区）加一行：`OtaAppHook_ScanChar((char)(huart1.Instance->DR & 0xFF));`（RQCP 残留字节一并喂入）。
- `StartTask02`（现有串口任务）循环里消费：
  ```c
  if (OtaAppHook_IsTriggered()) {
      printf("[ota] upgrade requested, reboot to bootloader\r\n");
      UPGRADE_SetState(STATE_UPGRADE_READY);
      osDelay(2000);              /* 排空串口 + 让上位机 '!'×10 发完 */
      NVIC_SystemReset();
  }
  ```
  （F411 无电机停机链——按 §3.5 准入规则 #2，停机属产品业务，组件只提供
  `OtaHook_SetOnUpgradeReady(cb)` 注册位；F411 **不注册**即自然为空，AT32 工程
  后续注册自己的 `Func_Stop`+PWM 全关。组件内不出现任何产品头文件。）
- APP 侧的组件发现应答：`ota_app_hook` 变体内置轻量命令帧解析，收到
  `CMD_QUERY_COMPONENTS(0x15)` 即回本固件位图（§6.2）——APP 在运行态也
  能向上位机宣告能力。
- KEY（PC13，`KEY.c` 已有）保留本地业务语义，不接入 boot 触发（boot 的 KEY 用 PC13 裸读，见 §5.3）。

### 5.3 boot 侧 KEY/触发

boot 无 FreeRTOS，`port/stm32f4` 自带 `ota_key.c`（PC13 GPIO 输入轮询，等价 F1 `My_Key`）；2s 窗口逻辑在 boot.c 原样保留（收 `'!'`/`0xAA`/KEY 任一进入升级）。

---

## 6. 上位机：组件化重构 + 按需 UI（ota 全功能复现计划）

> 设计原则：**设备接了什么组件，上位机才出现什么面板**——能力由设备端
> `CMD_QUERY_COMPONENTS` 在线宣告，上位机不做死绑定。现有 2712 行
> （协议/worker/固件解析/UI 主题/包视图）是 ota 面板的资产底座，**只搬家不改逻辑**。

### 6.1 两种接入姿态

| 姿态 | 机制 | 用途 |
|---|---|---|
| **在线发现（主）** | 连上串口后先发 `CMD_QUERY_COMPONENTS(0x15)` → 设备回 4B 组件位图 → 上位机动态注册对应面板 | 设备接了 ota 才出升级面板、接了 serial 才出串口监视面板；没接的面板不出现 |
| **profile 兜底（辅）** | 0x15 得到 NAK/超时（旧固件 F103/AT32 存量、或设备在深度升级态）→ 回落 `config.py` profile 的静态 `components` 声明 | 向后兼容存量工程，行为与今天完全一致 |

位图与组件名的映射表**单一数据源**：`components/components.cmake` 注册表（§3.4）
生成 `host/capabilities.json`（M0 构建时产出），MCU 位图 ↔ host 面板名永远对齐。

### 6.2 组件发现协议（新扩展 v1.2，向后兼容）

```
TX: AA 02 15 [CRC32(0x02+0x15)] 55                 # CMD_QUERY_COMPONENTS
RX: AA 02 24 04 <BITMAP[4] LE> [CRC32] 55          # RSP_COMPONENTS
    BITMAP: bit0=ota, bit1=serial（bit2+ 预留）
```

- **boot 与 APP 都实现**：boot 侧经协议分发器正常应答（2s 窗口过后也活着）；
  APP 侧在 USART1 中断喂 `ota_app_hook` 的同一字节流上挂一个轻量帧解析
  （仅命令帧，实现于 `ota_app_hook` stm32f4 变体）。
- 旧固件（未编入 `ota_cap.c`）收到 0x15 → 走既有 RSP_NAK 路径 → host 回落 profile。
  **存量 F103/AT32 工程零改动、零行为变化。**
- MCU 实现落点：`ota_cap.c`（可选编译模块）经 `OtaProtocol_RegisterExtCmd()`
  注册处理器（§3.2 改造 #4）——core 六文件功能代码不动。

### 6.3 上位机 panel 化重构（目录与资产去向）

```
iap_host_tool/
├── main.py                  # 改：启动时先做能力探测 → 组装面板（35 行，微改）
├── config.py                # 改：F411 profile + components 静态声明（兜底用）
├── core/                    # 不动（协议/worker/固件解析 = ota 引擎，面板共享）
│   ├── protocol.py  iap_worker.py  firmware.py
│   └── capability.py        # ★ 新增：QUERY_COMPONENTS 封装 + 位图→面板名翻译
├── panels/                  # ★ 新增：面板注册表（"按需出现"的实现点）
│   ├── registry.py          #   PANEL_REGISTRY = {"ota": OtaPanel, "serial": SerialPanel}
│   │                        #   主窗口按发现结果择一实例化，未发现的面板不实例化
│   ├── ota/
│   │   ├── panel.py         #   = 现 upgrade_widget.py(831行) 迁入 + 改继承自 PanelBase
│   │   └── cli.py           #   = 现 cli_flash.py(318行) 迁入（CLI 与 GUI 同面板双入口）
│   └── serial/
│       └── panel.py         #   新增轻量面板：串口状态/波特率/收发计数（复用 packet_viewer）
├── ui/
│   ├── theme.py             # 不动（375 行主题系统全组件面板共享）
│   └── main_window.py       # 改：Tab/StackedWidget 由 registry 动态填充（41 行→~70 行）
└── widgets/                 # 不动（com_selector/log_viewer/packet_viewer 三件套）
```

- **PanelBase 契约**：`name / capability_bit / on_attach(profile) / on_detach()`；
  registry 只呈现「capability_bit ∈ 设备位图」的面板——这就是
  "添加后才出现相对应的上位机 UI 检测画面"。
- 未来新组件（如按键监视、传感器遥测）= 新目录 + registry 一行注册 +
  components.cmake 注册表加位号，**主窗口零改动**。

### 6.4 ota 面板功能复现清单（0 阉割逐项落点）

| 现有功能（upgrade_widget.py / cli_flash.py） | panel 化后落点 | 验证方式 |
|---|---|---|
| 固件拖拽加载 + bin 解析（firmware.py 77 行） | `panels/ota/panel.py` 原样引用 | 拖入 411.bin 显示 size/CRC32 |
| COM 口选择 + 连接（com_selector.py） | 共享 widgets，ota 面板顶部复用 | 连接后状态栏显示设备组件位图（如 `0x00000003 = ota+serial`） |
| **实时进度条**（PAGES 回读驱动） | iap_worker.py 不动，信号接 panel | 烧 448K APP，进度与 `PAGES` 单调一致 |
| **TX/RX 彩色包视图**（packet_viewer 150 行） | 共享 widgets | 看到逐帧 `AA 01 SEQ 80 ...` / `AA 02 20 03 ...` |
| **百分比限发**（--throttle，M4 新增） | `panels/ota/panel.py` 加"限发%"输入框 + cli.py 参数 | 限发 40% 后面板显示"等待续传"状态 |
| **CRC 破坏注入**（--corrupt-frame，M4 新增） | panel 加 N 框号输入 + cli 参数 | 破坏帧后包视图红显、STATUS=1、重发成功 |
| 断点续传恢复（QUERY_OFFSET 对账） | iap_worker 不动 | 复电后面板显示"从第 N 页续传" |
| 触发升级（bang5 '!'×10@400ms） | iap_worker 不动 | APP 日志 `Upgrade requested!` |
| 查询状态/offset/强制重升 | panel 三个按钮（对应既有 worker 方法） | 按钮回显 STATE/OFFSET 值 |
| profile 切换（AT32/STM32/**F411**） | config.py 加 F411 条目 | 切 F411 后自动用 bang5/0x08010000/448K |
| CLI 全参数（--throttle/--corrupt-frame/--reset-dir/--listen） | `panels/ota/cli.py` 原样迁移 | §7 M4/M5 的 grep 验收全走 CLI |
| 主题/日志窗口（theme.py/log_viewer.py） | 共享 | 视觉零变化 |

> 即：**ota 面板 = 现有全部功能原样复现 + 新增两个 M4 调试控件（限发/破坏注入的
> GUI 化）**；内核代码（core/ 466+152+77 行）零改动。

### 6.5 serial 面板（串口组件的 UI 存在感）

- 能力位 bit1 命中时出现：显示端口参数（115200 8N1）、RX/TX 字节计数、
  最近 N 帧十六进制流水（复用 packet_viewer）。
- F411 场景的价值：boot 2s 窗口/升级接收态的串口可视化，不用再开第三方串口助手
  （呼应 N5 占口教训——**上位机自身就是合规的串口占用者**）。

### 6.6 全功能对照表（0 阉割证明单）

| 上位机功能 | 实现层 | F411 落点 |
|---|---|---|
| GUI 拖拽加载固件、bin 解析（firmware.py） | host | 零改动（迁入 ota panel） |
| 实时进度（PAGES 回读）、TX/RX 彩色包视图 | host | 零改动（协议不变） |
| CRC 错误重传 ×3 | host+boot | core 零改动 |
| 断点续传（限发+复电续跑） | host+boot | core 零改动 + F4 `EraseRange` 语义（§3.3） |
| 百分比限发调试（`--throttle`） | host CLI + panel 控件 | 零改动（M4 控件 GUI 化） |
| CRC 破坏注入（`--corrupt-frame`） | host CLI + panel 控件 | 零改动（M4 控件 GUI 化） |
| 查询 offset / state / 强制重升（CLI 三命令） | host+boot | core 零改动 |
| `'!'` 触发复位（bang5） | host+APP | `ota_app_hook` stm32f4 变体 |
| profile 切换（AT32/STM32/F411） | host config | 新增 F411 profile |
| 组件发现 → 按需面板 | host capability+registry | **新增能力**（0x15/0x24），旧固件回落 profile |
| GUI 主题/日志窗口/COM 选择器 | host ui/widgets | 零改动 |

---

## 7. 分步实施计划（可执行，逐步验收）

> 每步的验收判据都给出 **可 grep 日志关键字** 或机器可查产物；改完代码用 `.workbuddy/probe_idf_syntax.py` 预检后交 elab 闭环。

### M0 组件入库（不动任何工程）
1. 建 `components/serial/`（core 配置骨架 + port/{at32,stm32f1,stm32f4}，stm32f4 实现 USART1+DMA2_Stream2 环形）。
2. 建 `components/ota/`：core 从 AT32 原样提升 + port/{at32,stm32f1} 搬迁 + `ota_boot_flow.c` 场景层提升（boot 状态机芯片无关化）+ `ota_cap.c` 组件发现 + 四处配置面改造（§3.2）+ **port/at32 去业务化**（Sguan 引用 → 回调注册，§3.5 规则 #2）+ `components.cmake` 注册器（含能力位图单一数据源）。
3. AT32 工程 `USE_SHARED_OTA_CORE` 指向 elab 组件重编译。
   **验收**：AT32 build 通过；`arm-none-eabi-objdump` 对比新旧 ota_core 目标码一致；STM32-OTA-QT `--check` 幂等不 drift。
4. 新写 ota `port/stm32f4/`（layout/hal/delay/jump/app_hook/printf）。
   **验收**：`components/` 单独 configure 通过；`OtaFlashHal_*` 与 `ota_protocol.c` 编译零警告（-Wall -Wextra）；**准入扫描**（§3.5 规则 #5）grep 组件目录产品头文件命中数为 0。
5. 生成 `host/capabilities.json`（组件注册表 → 上位机能力位图翻译，§6.1 单一数据源）。

### M1 boot 工程（examples/F411CEU6_BOOT）
1. 手写 CMake + `BOOT.ld`（32K）+ main.c + boot.c（F4 化：`HAL_RCC_DeInit` 跳转、`EraseRange`）。
2. `projects/f411_boot.yaml` + `elab doctor -p f411_boot --deep`。
   **验收**：doctor 全绿（`deep.f411_boot.flag` 含 `-mfpu=fpv4-sp-d16`）；build 产物 `411_boot.bin ≤ 32K`。
3. boot 单烧验证（DAP-Link）。
   **验收**：monitor 命中 `"=== Bootloader Start ==="`；2s 后打 `"No upgrade request, jumping to APP..."`（APP 未烧时合法进入 RX 循环）。

### M2 APP 改造
1. `STM32F411CEU6_APP.ld`（0x08010000/448K）+ `VECT_TAB_OFFSET 0x00010000`。
2. 接入组件 `VARIANT app`（CMakeLists 用户区 §3.4 两行）+ `stm32f4xx_it.c`/`StartTask02` 挂 `OtaAppHook`。
3. `elab build -p f411`。
   **验收**：`411.bin` 首地址（objdump 向量表）= 0x08010000；`[alive]` 心跳照常；`grep -c "OtaAppHook" compile_commands.json ≥ 1`。

### M3 双镜像闭环（elab）
1. `f411.yaml` 配 `flash.images`（boot@0x08000000 + app@0x08010000）+ 链接通道实测。
2. `elab run -p f411 --steps doctor,build,flash,debug_verify,monitor --emit-events`。
   **验收**：五步全绿；boot 2s 窗口日志后 `"Jumping to APP"`；APP `[alive] tick=` 命中；驾驶舱事件流可见双镜像烧录轨迹。

### M4 上位机 panel 化 + 端到端 ✅（2026-10-08 验收 PASS）
> 实际落地与计划的差异：CLI 入口为 `panels/ota/cli_flash.py`（profile 驱动，
> `--port/--firmware/--listen/--emit-events`）；并在方案外完成了 **OTA 一键入舱**
> （驾驶舱卡片「工具 | OTA 升级」按钮，见 10.10）。端到端实测：
> `[cap] 0x15 bitmap=0x00000003` → trigger → `[tx] 100% (36060/36060)`，
> 53 帧/s → `Final CRC: 0x4A4A2679` 逐位一致 → openocd 硬复位 → 心跳 9 条 → `[result] PASS`（26.4s）。
> 开发过程实弹问题见 §10.1~10.12。
1. **panel 重构**（§6.3）：`core/capability.py`（0x15 探测）+ `panels/registry.py` + `upgrade_widget.py`/`cli_flash.py` 迁入 `panels/ota/`（逻辑零改动）+ 新增 `panels/serial/` + `main_window.py` 动态填充 + `config.py` 加 F411 profile 与静态 components 兜底声明。
   **验收**：
   - 连 F411 设备（boot 或 APP）→ 主窗口出现 **OTA 面板 + 串口面板**，状态栏显示 `components: ota, serial`；
   - 连旧固件（F103 存量）→ 0x15 回 NAK → 只出现 OTA 面板（profile 兜底），**行为与今天完全一致**（回归）；
   - 现有 GUI 全功能手动回归一遍（拖拽/进度/包视图/profile 切换）。
2. CLI 全流程：`python iap_host_tool/panels/ota/cli.py --port COM10 --firmware .work/f411/411.bin --listen 8`。
   **验收**（grep 关键字，按升级时序）：
   - APP 侧：`Upgrade requested!` → 复位
   - boot 侧：`Upgrade requested. Erasing APP flash` → `Erase done, ready to receive firmware.`
   - 逐包：`Addr 0x08xx | RUN_CRC 0x..`（ACK 流）
   - 收尾：`=== Upgrade complete. Final CRC: 0x..` → `Upgrade verified OK. Jumping to APP` → `[alive] tick=`
   - host 侧：进度 100%、CRC 校验通过。

### M5 异常注入（0 阉割的最终证明）✅（2026-10-08 三项实弹全 PASS）
> **实施中发现真实缺口（→§10.13）**：`STATE_CRC_FAIL` 全工程只有消费分支、从未被置位
> ——boot 完成传输后无条件 SUCCESS，"截断固件→boot 判 CRC_FAIL"链路缺"预期 CRC 下发"环节。
> 本次补齐：seq=0xFF 元数据帧下发预期 CRC（正常帧 seq 改 1~254 循环永不碰撞）+ boot 完成时
> 比对 + `OtaSystemReset`（port 新增）+ CRC_FAIL 置位。AT32 legacy 走 profile 门控零回归。
> 注入入口全部挂成项目工具（驾驶舱动态工作区）：`ota-corrupt` / `ota-throttle` / `ota-crcfail`。
>
> **实弹验收**（板子在线，事件流 r-6a834a56 / r-8ffe5cc4 / r-35a32c9c 可回看）：
> ① `ota-corrupt` PASS 24.9s：`[corrupt] 帧 3 CRC 已破坏` → `[retry] 帧 3 CRC_ERR 重传 第1次`
>   （boot NAK STATUS=1 → host 重传）→ Final CRC 0x4A4A2679 → 心跳 9 条；
> ② `ota-crcfail` PASS 32.3s：截断 20000B → boot 打 `CRC mismatch!` → 置 CRC_FAIL → 复位 →
>   CLI 重开串口发 `'!'` → offset=0 全量重传 → `[upgrade] 恢复成功` → 心跳 9 条；
> ③ **断电续传** PASS：0.25s/帧限速传输中**真拔电**（上位机 `WriteFile PermissionError(13)`
>   = 设备消失铁证）→ 重插 → 重跑升级 → **`[go] offset=14336`（14 页断点生效，未从头传）**
>   → Final CRC 与整包逐位一致 → 心跳 9 条。
1. **CRC 重传**：`--corrupt-frame 3` → boot ACK `STATUS=1 SEQ=3`，host 重发。
   **验收**：boot 日志出现 ACK err 序列且升级最终 SUCCESS。→ 工具 `ota-corrupt`
2. **断点续传**：`--throttle 40` 限发后拔电 → 重插 → 重跑 CLI。
   **验收**：boot 打 `Resuming from page N (N×1024 bytes already written)`；最终 CRC 与整包一致。
   → 工具 `ota-throttle`（0.06s/帧 ≈ 20s 拔电窗口）+ 完成拔插后跑 `ota`（自动续传）
3. **CRC_FAIL 恢复**：升级中改坏固件（截断 bin）→ boot 进 `STATE_CRC_FAIL` → 发 `'!!!!!'` 重升。
   **验收**：`WARNING: Previous upgrade CRC failed!` → 重升成功。
   ★ 实测修正：CRC_FAIL 分支等的是**单个 `'!'`**（或 KEY），非 5 连叹号；
   完整闭环 = `ota-crcfail` 一条 run：注入→mismatch→CRC_FAIL→重开串口→'!'→全量重传→SUCCESS。

---

## 8. 风险清单（M1 前置评审）

| 风险 | 等级 | 缓解 |
|---|---|---|
| F4 编程时 CPU 自 flash 取指 stall 导致串口 ACK 超时 | 中 | F411 单 bank 硬件自动 stall（数据手册行为）；ACK 在每 128B 包后发出，逐字编程 stall 微秒级，实测 M4 确认 |
| HAL 版 boot 体积超 32K | 低 | `-Os` + `--specs=nano.specs`；超限时 printf 精简（M1 实测卡点，预留 `ota_printf` 可裁剪） |
| `EraseRange` 语义在 AT32/F1 回归漂移 | 中 | M0 用旧目标码对比 + STM32-OTA-QT `--check` 双保险（§3.4） |
| FreeRTOS 侧 fputc（DMA+互斥）与 OTA 触发回显竞争 | 低 | 触发后只 `osDelay(2000)` 复位，不再回显长文本；boot 接管后与 APP 无关 |
| boot 与 APP 串口收发时序（复位瞬间字节丢失） | 低 | 上位机 `--listen 8` 已含重试探测；boot `Boot_CheckState` 排空逻辑保留 |
| elab flash.images 用于 stm32f4 尚无先例 | 中 | M3 首验；若镜像模式不适配，退路 = 分两次 `elab flash`（boot/app 各自项目），C33 语义不破坏 |
| `ota_boot_flow.c` 提升时引入行为漂移（boot 状态机搬家） | 中 | M1 用 F411 boot monitor 日志逐状态对拍源工程；`'!'`/`0xAA`/KEY 三触发路径全验 |
| panel 重构碰坏现有 GUI（831 行 upgrade_widget 迁移） | 中 | 只搬家不改逻辑 + 旧 F103 工程连真机回归（§7 M4-1）；git 单独提交可回退 |
| 0x15 组件发现与升级态并发（boot 收包中收到查询） | 低 | 帧协议本身串行 ACK；`ota_cap.c` 处理器查状态寄存器实现为纯读 |
| 组件准入扫描误报/漏报 | 低 | 规则 #5 的 grep 白名单收敛到精确头文件名；先 warn 后 error 两档 |

---

## 9. 约定与不变量（写代码前最后核对）

1. **core 功能零改动**：`ota_protocol/ota_flash_store/ota_offset/ota_upgrade_state/ota_crc32/ota_transport` 六文件逻辑与 AT32 版逐行一致（配置面四处除外，§3.2）。
2. **★ 框架侧零业务代码**（用户原则，M0 起 CI 强制）：
   - elab 框架本体（services/ toolchains/ cockpit/ chips/）依旧零业务代码；
   - `components/` 是「可复用中间件层」，准入按 §3.5 五条硬规则（无产品头文件、
     差异点弱回调注入、core/port/scenes 分层、README 契约、CI 扫描）；
   - 产品业务（LED/按键/FreeRTOS 任务/BLDC 停机链）一律留在业务工程。
3. **上位机内核零改动**：core/（协议/worker/固件解析）与 ui/theme、widgets/ 三件套
   逻辑不动；改动面 = config.py + main_window.py + 新增 capability.py / panels/（§6.3）。
4. **elab 框架零改动**（组件目录 + 两个 projects yaml + F411 工程与 BOOT 工程
   CMake 自由区；`EraseRange`/`RegisterExtCmd` 属组件接口扩展，不动框架）。
5. 每步产物/日志关键字见 §7；全部走 `elab` 闭环验证，业务工程 guard.untouched 为真。
6. 组件能力位图（bit0=ota, bit1=serial）单一数据源在 `components.cmake` 注册表，
   MCU `ota_cap.c` 与上位机 `capabilities.json`/registry 都从它派生，禁止各自硬编码。

## 10. 开发问题实录（实机调试沉淀，2026-10-07）

> M3/M4 上板联调实际踩到的坑，按"症状 → 根因 → 修法 → 落点"记录，供后续芯片移植复用。

### 10.1 BOOT 拿到垃圾状态页后卡死不跳 APP（M3）

- **症状**：BOOT 心跳正常（tick 递增）但永不跳 APP。
- **定位**：openocd `mdw 0x08008000` 读状态页发现全页垃圾（0x460507da…，疑似烧录器
  残留/擦除不完整），`FlashStore_Read` 扫到页尾非 0xFF slot 返回垃圾值，
  `switch(state)` 无 default 分支 → 直接落穿 → 不跳转。
- **修法**：`ota_boot_flow.c` 加 `default:` 分支——打印 Invalid state → 擦状态页 →
  `UPGRADE_SetState(STATE_RUNNING)` → 跳 APP（自愈式恢复）。
- **落点**：`components/ota/core/ota_boot_flow.c`。

### 10.2 F411 的 SP 校验掩码沿用 F103 导致拒绝合法栈顶（M3）

- **症状**：状态页修好后 BOOT 仍不跳，串口有心跳（说明跳转后死回了 BOOT）。
- **根因**：`ota_jump.c` 校验 app_sp 用 F103 的掩码 `0x2FFE0000`（按 64KB RAM 推算），
  F411 是 128KB RAM，`_estack = 0x20020000` 被误判非法。
- **修法**：掩码改 `0xFFFC0000`（只校验"落在 SRAM 区间"这一语义），
  `if ((app_sp & 0xFFFC0000UL) == 0x20000000UL)`。
- **落点**：`components/ota/port/stm32f4/ota_jump.c`（已注释"f411 实测坑"）。

### 10.3 上位机帧接收无 deadline，被固件心跳"饿死"（M4，cli_flash.py）

- **症状**：CLI 打印 `[crc] expected` 后永久无输出（连 `[trigger]` 都不到）。
- **根因**：`CliIAP._recv_frame()` 帧头扫描 `while True` 无超时——F411 固件 APP/BOOT
  均每秒打 `[alive] tick` 心跳，串口上持续有字节流，扫描循环永不返回。
  `_query_offset()` 第一次调用即饿死。此前"COM10 掉线"只是巧合叠加。
- **修法**：`_recv_frame(deadline=None)` 全程受绝对截止时刻约束（扫头/逐字节循环
  均检查）；`_wait_ack/_query_offset/_query_state` 传入各自 deadline。
  `core/capability.py` 的 `probe_components` 本就是"缓冲积累 + deadline"模式，未受影响。
- **落点**：`iap_host_tool/panels/ota/cli_flash.py`。

### 10.4 APP 侧 IDLE 集中读 DR → ORE 丢字节 → 触发/发现双双失效（M4，★本次最有价值）

- **症状**：① 发 15 个 `!` 设备不进升级模式；② 0x15 组件发现始终无应答（此前一直
  走静态兜底）。两症状同源。
- **根因**：APP 只使能 `UART_IT_IDLE`，字节读取集中在 IDLE 中断里做。5 连 `!`
  在 115200 波特率下约 0.43ms 发完，IDLE 要等线路空闲才触发——期间 RXNE 只保住
  第 1 字节，后 4 个全部 ORE 溢出丢失 → `ScanChar` 只喂进 1 个 `!`（计数 1≠5）；
  0x15 帧同理只见到 SOF 一个字节。
- **修法**：RXNE 逐字节中断喂 `OtaAppHook_ScanChar`，IDLE 仅清标志：
  - `main.c`：追加 `__HAL_UART_ENABLE_IT(&huart1, UART_IT_RXNE);`
  - `stm32f4xx_it.c` USER CODE 0：先 RXNE 消费 DR（读 SR+DR 序同时清 ORE），
    再清 IDLEF。USER CODE 0 先于 `HAL_UART_IRQHandler` 执行，DR 已被消费，
    HAL 的 RXNE 分支不会重复取字节。
- **落点**：`examples/STM32F411CEU6/Core/Src/main.c`、`Core/Src/stm32f4xx_it.c`。
- **复用提示**：后续芯片接入凡用"逐字节扫描"类触发（bang5/协议发现），
  中断设计必须 RXNE 逐字节喂，禁止 IDLE 收尾集中读——多字节突发必然丢字节。

### 10.5 上位机扫描器切帧差一 → parse_response struct.error（M4，capability.py）

- **症状**：APP 修复后 0x15 首次真应答，上位机反而崩
  `struct.error: unpack requires a buffer of 4 bytes`。
- **根因**：`_scan_response` 切帧 `data[i+1 : i+3+param_len+4]` 比实际短 1 字节
  （漏掉最后一个 CRC 字节）。此前从未暴露——设备从未真正回应过 0x15，
  第一次真应答即触发。
- **修法**：切帧端点改 `data[i+1 : frame_end]`（含 4B CRC、不含 EOF）；
  `parse_response` 加长度防御（不完整帧返回 (None,None) 而非崩）。
- **落点**：`iap_host_tool/core/capability.py`、`core/protocol.py`。

### 10.6 BOOT 串口组件 CR3.DMAR 未置位 → RX 全静默（M4，★组件级）

- **症状**：BOOT 心跳正常、能收发文本，但对 QUERY_OFFSET/STATE/'!' 触发完全无响应
  （连未知命令 NAK 都没有）。
- **根因**：`serial_usart1_dma.c`（M0 新写的 F4 零中断串口）`USART1->CR3 = 0`——
  STM32F4 的 USART 必须置 **CR3.DMAR** 才会发出 RX DMA 请求；DMAR=0 → DMA2_Stream2
  空转、NDTR 恒 1024 → `available()≡0` → 整条 RX 路径死。M1 验收只覆盖了 TX
  （心跳+banner），RX 是 M4 第一次真实使用。
- **修法**：`USART1->CR3 = USART_CR3_DMAR`（TX 走轮询不需要 DMAT）；
  顺带把 `serial_rx_read` 判空改为与 `available()` 同公式（NDTR 回卷边界一致性）。
- **旁证**：APP 侧 0x15 能通是因为 APP 用自己的 RXNE 中断路径喂 ScanChar，
  不经 Transport——这正是 10.4 修复后 0x15 先于 BOOT RX 打通的原因。
- **落点**：`components/serial/port/stm32f4/serial_usart1_dma.c`。

### 10.7 停等协议 × BOOT 主循环 1s 心跳延时 → 吞吐钉死 1 帧/秒（M4，★BOOT 工程）

- **症状**：升级传输 ~1 帧/秒，37KB 要跑 5 分钟（CLI 两次被外层超时杀掉）。
- **根因**：上位机是停等协议（发一帧→等 ACK）；BOOT 主循环
  `ProcessRX(); printf(心跳); HAL_Delay(1000);`——每处理完一帧缓冲必空，
  每帧都陪主循环睡 1s。注意"缓冲非空才延时"的修法**无效**（停等下缓冲恒空）。
- **修法**：HAL_GetTick 节拍——1s 最多一条心跳、仅空闲时打印、绝不阻塞收包。
- **教训**：**任何**无条件/判空式 delay 都会与停等协议相乘；心跳必须基于时基节拍。
- **落点**：`examples/F411CEU6_BOOT/main.c`。

### 10.8 升级后硬件复位与存活判定关键字平台化（M4，上位机）

- BOOT 置 SUCCESS 后 `while(1)` 防噪声（0 阉割设计），串口复位命令无效，
  必须 openocd 硬复位。CLI 的 `--reset-dir` 原本写死 `at32f421xx.cfg`。
- **修法**：profile 新增 `openocd_scripts / openocd_interface / openocd_target`
  （F411 = at32-tools OpenOCD + `interface/atlink.cfg` + `target/stm32f4x.cfg`，
  与 chips yaml/elab.host.yaml 同源），profile 带 openocd_scripts 即自动走硬件复位；
  复位后存活判定关键字 `heartbeat_keyword` 亦按 profile 配
  （elab 约定 `[alive]`，AT32 老工程默认 `heartbeat`）。存量 profile 行为零变化。
- **落点**：`iap_host_tool/panels/ota/cli_flash.py`、`config.py`。

### 10.9 构建依赖坑：f411_boot 不随 `elab run -p f411 --steps build` 自动重编

- **症状**：改了 serial 组件源码，`run -p f411` 的 build 只重链 `411.elf`（APP），
  flash 烧的是 `.work/f411_boot/` 里的**旧** f411_boot.bin —— 组件修复看似无效。
- **根因**：`f411.yaml` 的 `flash.images` 引用 BOOT 产物路径，但 BOOT 是独立项目
  （`projects/f411_boot.yaml`），不构成 CMake/ninja 依赖；elab build 只构建当前项目。
- **对策**：改组件后必须显式 `elab run -p f411_boot --steps build` 再 flash。
  验证手段：`arm-none-eabi-objdump -d` 直接核对目标寄存器写入序列
  （本次即以 `movs r2,#0x40; str r2,[r3,#20]` 确认 CR3=DMAR 真的进了固件）。
  ★ 后续可考虑 elab 侧把 flash.images 的产物来源项目纳入构建依赖（框架增强项）。

### 10.10 OTA 一键入舱：tool: 机制 + 事件 project 必须写 elab 卡片名（M4+，★框架协同）
- **需求**：OTA 流程要能从驾驶舱一键发起、独立 Tab 可视化，而不是混在构建日志里。
- **方案**：框架新增通用 `tool:<name>` 步骤——命令声明在 `projects/*.yaml` 的 `tools:` 节，
  框架只做模板替换（`${serial_port}` 自动选口排蓝牙）+ 子进程逐行事件化；业务工具通过
  `--emit-events <runs_dir>` 充当 ICD 生产者（ envelope `{ts,run,topic,seq}` → run/*.jsonl），
  **框架零业务代码**。★ 两个独立的步骤校验点（`run.parse_steps` 与 `cockpit/server.py spawn()`）
  必须同时放行 `tool:` 前缀——只改一处时 POST /api/run 报"未知步骤"。
- **踩坑**：事件 `project` 字段写了自创名 `f411-ota` → UI 整条 run 不可见。
  根因：`App.tsx` 按**卡片名**过滤（`runs.filter(r => r.project === 选中卡片名)`）。
  修法：`CockpitRun(project=profile_name().lower())`，事件 project 必须等于 elab 卡片名。
  ★ 教训：只验 API 不验 UI = 没验完——事件落盘、SSE、API 三层都绿，UI 照样不可见。

### 10.11 驾驶舱白屏：LogBook 漏注册新 Tab 的 ring（M4+，★前端三键假设）
- **症状**：加 OTA Tab 后驾驶舱整页空白（React 树崩）。
- **根因**：`logs.ts` 的 LogBook 只有 build/flash/serial 三个 ring，`logs.for("ota")` 返回
  `undefined` → `undefined.push` 在首条日志到达时抛异常，崩掉整棵 React 树。
- **为何类型闸门没拦住**：`vite build` 不做类型检查，当时绕过 package.json 的
  `tsc --noEmit && vite build` 直接跑 vite——tsc 对 `Record<LogTab,...>` 缺 key 会报错。
- **检查清单**：新增一个 LogTab 必改 6 处：①LogTab 联合类型 ②LogBook ring ③clearAll
  ④counts() ⑤tabOfEvent ⑥EvidenceRail 的 tabs/TAB_STEPS/counts 订阅/emptyTextFor；
  且构建必须走完整 `npm run build`（tsc 闸门在内），不许裸跑 vite。

### 10.12 cockpit.cmd 双击闪退：.bat/.cmd 必须 ASCII-only（M4+，★字节级坑）
- **症状**：桌面双击 cockpit.cmd 窗口一闪即没，服务没起、UI 打不开。
- **根因**：cmd.exe 按 ANSI 代码页（zh-CN = GBK）逐字节解析 .cmd；文件里的 **UTF-8 中文注释**
  造成字节错位——多字节序列吞掉后续字节（甚至行尾 CR，把两行拼成一行），
  cmd 把碎片当命令执行（实测报 `'LAB_PYTHON")' 不是内部或外部命令`）→ 解析爆炸即闪退。
- **修法**：cockpit.cmd 全量改纯 ASCII（英文注释），并写入 ASCII-ONLY RULE 注释防复发。
- **方法论教训**：此前的 Python 干跑器（echo 改写副作用行）验证通过是假阴性——
  干跑器不复现 cmd 的字节级解析。**.bat/.cmd 的验证必须在真 cmd.exe 下过一遍**；
  修复后实测：冷启动 11s 全链路通（探测→pythonw 拉起→端口就绪→Edge --app 开窗→幂等 exit 0）。

### 10.13 CRC_FAIL 从未被置位：协议缺"预期 CRC 下发"环节（M5 实施发现，★业务协议缺口）
- **发现时机**：实施 M5.3 时通读 `ota_boot_flow.c`——传输完成处 `s_RunningCRC = CRC32_Finish()`
  后**无条件** `UPGRADE_SetState(STATE_UPGRADE_SUCCESS)`；全工程 `STATE_CRC_FAIL` 只有
  CheckState 的消费分支，**没有任何置位点**。"截断固件 → boot 判 CRC_FAIL"根本不可能发生。
  （M4 验收时 CLI 里那句 `Final CRC 逐位一致` 是**上位机文本比对**，不是设备侧判定。）
- **根因**：协议没有"预期 CRC"的下发通道——boot 无法知道收到的固件"应该"是什么 CRC。
  这是源工程继承下来的设计缺口（业务/协议层，非 elab 框架 bug）。
- **修法（三方协同，legacy 零回归）**：
  ① **元数据帧**：复用 DATA 帧格式，`seq=0xFF` 保留为元数据（正常帧 seq 改 `(i%254)+1`
  循环 1~254，永不占用 0x00/0xFF——boot 只回显 seq 不校验连续性，改策略零风险）；
  载荷 `[0x01][预期 CRC32 4B LE]`，boot 特判不写 flash、不推进 RunningCRC。
  ② **boot**：完成时 `s_ExpectedCRC != 0 && != Final` → 打印 mismatch → 置 CRC_FAIL →
  `OtaSystemReset()`（port 新增，stm32f4/at32 双实现）→ 重启命中既有 CRC_FAIL 分支。
  ③ **上位机**：`--truncate N`（内存截断，预期 CRC 仍按完整固件计算）+ `--crcfail-test`
  （注入→检测→重开串口→'!' 重升→全量重传→SUCCESS 一条 run 闭环）+ profile 门控
  `expected_crc: True`（仅 F411；AT32 legacy boot 无特判，元数据帧会被当数据写 flash）。
- **坑**：boot 解析器 CMD 帧**不支持载荷**（PARSER_CMD 收完 CMD 直接进 CRC 状态），
  host `build_cmd_frame` 的零载荷帧也不含 PARAM_LEN 字节——两者字节级自洽但都无法
  携带 4 字节参数，改 parser 会破坏 AT32 legacy 兼容，故走 DATA 帧 seq=0xFF 方案。
- **验收标准**（插板）：`[meta] 预期 CRC 下发: OK` → `[inject] 只传前 20000B` →
  boot 打 `CRC mismatch! expected..got..` → `WARNING: Previous upgrade CRC failed!` →
  `[recover] '!' 重升` → 全量 `[tx] 100%` → `Upgrade complete. Final CRC` → `[result] PASS`。

### 10.14 小结

十二例分四类：① **组件级**（10.1/10.2/10.6）——跨芯片移植语义差异，源码级修复+注释；
② **协议交互类**（10.3/10.4/10.5/10.7）——上位机与固件的时序耦合，只有真机联调才暴露；
③ **流程类**（10.8/10.9）——平台化配置面；④ **入舱/交付类**（10.10/10.11/10.12）——
可视化链路与桌面交付的坑，共同点是**"中间层全绿、最后一层不可见/即崩"**，
验收必须做到最终用户视角（开 UI 点按钮/双击图标）。协议解析器必须尽早吃到真帧、
RX 路径必须在 M1 就被闭环验证（不能只验 TX）、心跳必须基于时基节拍、
**UI 验收必须真开页面、.cmd 交付必须真双击（或真 cmd 跑）**——四条是后继芯片接入的强制检查项。

---

## 后继演进

- **双槽回滚（A/B Bank）**：本方案封死"传输坏"四类故障；"CRC 合法但功能坏"
  的唯一解是双槽试运行 + 自动回滚，执行稿见同目录
  `OTA_双槽回滚技术方案.md`（评审稿，触发条件：无人值守远程升级）。
- **分区表单源化**：`chips/*.yaml ota_layout:` 节 → `ota_layout_gen.h` →
  doctor 三方对账，已落地（技术方案_闭环驾驶舱 §22）；双槽在其 `slots:` 扩展上施工。
