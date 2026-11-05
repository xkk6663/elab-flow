# STM32F411CEU6/boot —— OTA Bootloader（APP 的配套薄工程）

本工程是同一完整例程中 [`../`](../)（APP 侧）的**配套 Bootloader**，
与 APP 共用 `examples/STM32F411CEU6/` 目录，但保持独立的 CMake 工程与
`projects/f411_boot.yaml` 声明。
它刻意做成「薄入口」：`main.c` 只负责初始化 + 交接，全部升级流程在
`components/ota`（`VARIANT=boot`）里，避免 boot 与 APP 的协议实现各写一份。

## 展示什么能力

| 能力 | 本工程怎么体现 |
|---|---|
| **Bootloader 独立存活** | 只占 32K（`0x08000000`~`0x08007FFF`），APP 坏成什么样都能靠 `'!'` 重新进入升级 |
| **薄入口 + 组件复用** | `main.c` 只做时钟/串口/能力应答，状态机与协议全在 `components/ota`（与 APP 同一份代码，不同 `VARIANT`） |
| **组件发现（能力位图）** | `OtaCap_AutoInit()` 应答 `CMD_QUERY_COMPONENTS(0x15)`，位图来自 CMake 下传的 `OTA_CAP_BITMAP = 0x3`（ota + serial） |
| **状态分支与跳转** | `OtaBootFlow_CheckState()`：读升级状态页 → 需要升级则留在 boot，否则跳到 APP |
| **非阻塞心跳** | 主循环 `ProcessRX()` + 空闲时才打 1Hz `[alive] boot tick=N`；**不能**用 `HAL_Delay(1000)`——停等协议下会把吞吐钉死在 1 帧/秒 |
| **双槽试运行** | trial 记账先落盘再跳转；APP 连续 3 次心跳后 `OTA_Confirm()` 晋级，否则周期复位递减 trial → `=== ROLLBACK ===` |
| **分阶段错误定位** | `g_stage` 记账 + `[boot] FATAL: init failed at <stage>`；串口就绪后逐条回放初始化结果 |
| **裸机最小运行时** | 自带 `SysTick_Handler`（HAL 时基）与最小 `_sbrk`（newlib `printf` 需要） |

## 硬件与地址

- STM32F411CEU6 开发板（与 APP 同一块板）
- DAP-Link / AT-Link 探针（SWD）
- 串口：USART1，115200 8N1（TX=PA9、RX=PA10），与 APP 一致
- 烧录地址：`0x08000000`，大小 32K（链接脚本 `BOOT.ld`）

## 怎么跑

通常**不需要单独操作**：`projects/stm32f411ceu6.yaml` 的芯片包声明了
`boot_project: f411_boot`，`elab build -p stm32f411ceu6` 会自动级联构建 boot，
`elab flash` 按台账决定是否把 boot 镜像一起烧进去。

需要单独构建 / 单独下载时：

```bash
elab build -p f411_boot
elab flash -p f411_boot --reflash-boot     # 强制重烧 boot
```

## 预期证据

```text
[boot] ---- init log begin ----
[boot] HAL init  : ok
[boot] clock     : ok (SYSCLK=100000000 Hz, HCLK=100000000 Hz)
[boot] UART1     : ok (115200 baud, 8N1, TX=PA9, RX=PA10)
[boot] ota cap   : ok (bitmap=0x03, rc=0)
[boot] ota flow  : init ok
[boot] ---- handing over to boot state machine ----
[boot] main loop : enter (RX polling + 1s heartbeat)
[alive] boot tick=0 stage=main_loop
```

- 若无升级需求：`CheckState` 直接跳 APP，此时串口会切到 APP 的 `[alive]` 输出。
- 若进入升级：停在 `main loop`，等待上位机发 `AA ...` 帧；升级事件由上位机转发到驾驶舱。

## 源码索引

- `main.c` —— 薄入口：时钟、串口挂载、能力应答、状态交接、非阻塞心跳
- `BOOT.ld` —— 32K 链接布局（`0x08000000`）
- `CMakeLists.txt` —— 复用 APP 的 HAL 单一真源，接入 `components/ota`（`VARIANT boot`）
- `projects/f411_boot.yaml` —— 单镜像烧录声明（bin 带显式地址）

## 注意

- boot 版本**独立冻结**（`projects/f411_boot.yaml` 的 `version: 1.0.0`）：只有协议/跳转变更才 bump，
  避免每次 APP 升级都连带重烧 boot。
- 改 boot 的时钟配置必须与 APP 逐段一致，否则跳转后波特率会偏。
- 这是「方案 §4 薄入口」的参考实现：新增升级步骤时优先改 `components/ota`，不要在 `main.c` 里分叉。
