# STM32F103C8T6 —— 心跳 bring-up + 串口命令台

本工程是 elab 闭环的**最小可判定样例**：一块 STM32F103C8T6（Blue Pill）就能把
「编译 → 烧录 → 调试校验 → 串口判活」四步全部走通，且每一步都有机器可读的证据。

## 展示什么能力

| 能力 | 本工程怎么体现 |
|---|---|
| **芯片闭环第一关**（C36） | 1Hz `[alive]` 心跳，行内带 `tick` / `toggles` / `stage`，相邻心跳间隔 ≈1.000s、`toggles` 每次严格 +2 |
| **心跳与 LED 同一时基** | 同一个 500ms 节拍翻转 PC13（低电平点亮，亮灭周期 1s）；每 2 次翻转打一条心跳 |
| **非阻塞主循环** | 不用 `HAL_Delay`；用 `HAL_GetTick()` 差值比较驱动节拍，长阻塞后重新对齐而不补闪 |
| **分阶段初始化日志** | 串口就绪前用 `g_stage` 记账；就绪后逐条回放 `HAL/clock/GPIO/DMA/UART` 结果，失败时 `[log] FATAL: init failed at <stage>` |
| **中断接收 + 主循环解析** | USART1 逐字节 `HAL_UART_Receive_IT`，`HAL_UART_RxCpltCallback` 组行后交给主循环，不在中断里 `printf`；错误回调自动重挂接收 |
| **串口命令台** | `PING` → `PONG`、`STAT` → 运行态汇总、`ECHO xxx` → 原样回显、未知命令回 `unknown` |
| **newlib printf 重定向** | 强定义 `__io_putchar`（`syscalls.c` 里只有 weak 声明），走 USART1 |
| **DMA** | USART1 RX/TX 走 DMA1_Channel5/4（CubeMX 生成） |
| **elab 工程接入** | `projects/STM32F103C8T6.yaml`：Archetype A、CMake + Ninja、链接脚本归工程、产物由 elab 统一产出 |

## 硬件

- STM32F103C8T6（Blue Pill）或同类板
- DAP-Link / AT-Link 探针（SWD：PA13/PA14）
- USB 串口（USART1：TX=PA9、RX=PA10，115200 8N1）
- 板载 LED：PC13（**低电平点亮**）；按键：PA0..PA3（本工程未使用）

## 怎么跑

```bash
# 在仓库根目录（Windows 用 elab.cmd）
elab doctor -p STM32F103C8T6
elab loop -p STM32F103C8T6          # doctor → build → flash → debug_verify → monitor
```

只预览命令、不执行：`elab loop -p STM32F103C8T6 --dry-run`。

## 预期证据

串口（`elab monitor -p STM32F103C8T6`）：

```text
[log] ---- init log begin ----
[log] HAL init  : ok
[log] clock     : ok (SYSCLK=72000000 Hz, ...)
[log] GPIO      : ok (LED=PC13 active-low, KEY1..4=PA0..3)
[log] DMA       : ok (USART1 RX=DMA1_Ch5, TX=DMA1_Ch4)
[log] UART1     : ok (115200 8N1, TX=PA9, RX=PA10, IRQ=on)
[log] main loop : enter (PING/STAT/ECHO + 1s heartbeat + LED 1Hz)
[alive] test tick=0 cmds=0 led=1Hz toggles=2 stage=main_loop
```

判据：`projects/STM32F103C8T6.yaml` 的 `monitor.close_on` 命中 `^\[(log|alive|cmd)\]` 即 `ok`；
出现 `HardFault|Hard Fault|assert|PANIC` 即 `failed`。

**LED 是否均匀闪烁必须由人肉眼确认**——agent 只能核对 `toggles` 递增。

## 源码索引

- `Core/Src/main.c` —— 心跳/命令台/阶段日志/`__io_putchar`
- `Core/Src/usart.c`、`Core/Src/dma.c` —— 串口与 DMA 初始化（CubeMX 生成）
- `STM32F103XX_FLASH.ld` —— 链接布局（RAM 20K / FLASH 64K）
- `projects/STM32F103C8T6.yaml` —— 工程接入与串口判据
