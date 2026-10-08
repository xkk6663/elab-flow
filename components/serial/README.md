# components/serial — 串口组件（一切皆组件：串口独立成件）

串口是**跨组件通用能力**（boot 收包、APP printf、未来任何通信组件都依赖），
塞在 ota 里会形成"接 ota 才有串口"的伪依赖（方案 §3.1 裁决）。

## 提供物

- `Transport_USART1` 实例：实现 ota core 的 Transport 五函数接口
  （init / deinit / read / write / available）。
- 各平台实现：

| platform | 文件 | 接收机制 | 来源 |
|---|---|---|---|
| `stm32f4` | `port/stm32f4/serial_usart1_dma.c` | DMA2_Stream2 **循环** + 软件尾指针追赶 NDTR（**零中断**，寄存器级） | 新写（与 F103 同构） |
| `at32` | `port/at32/serial_usart1_dma.c` | DMA1_CH3 非循环 + IDLE 中断搬运环形队列 | 提炼自 AT32 工程 `ota_usart_hal.c` |
| `stm32f1` | `port/stm32f1/serial_usart1_dma.c` | DMA1_CH5 循环 + 尾指针（零中断） | 提炼自 `My_Usart.c` |

## 接入（业务工程）

```cmake
elab_use_component(${PROJECT_NAME} serial PLATFORM stm32f4)
```

BOOT 工程接 ota 组件时自动递归接入（`ELAB_COMP_BOARD_ota = serial`）；
**APP 工程不需要接**（APP 的 CubeMX usart.c fputc DMA 链保持不动）。

## 配置项（serial_config.h）

`SERIAL_BAUDRATE`（默认 115200）、`SERIAL_RX_BUF_SIZE`（默认 1024，2 的幂）、
线束宏（平台默认 PA9/PA10 或 PB6/PB7）。

## 契约与注意事项

- Transport 类型来自 `ota/core/ota_transport.h`（抽象留 ota core，实现来自
  serial —— 方案 §3.1 裁决）；`boot` 变体的 ota 通过 `Transport_Attach(&Transport_USART1)` 使用。
- 发送为**轮询阻塞写**（带超时），与协议 ACK 帧共存同一串口。
- at32 实现定义了 `USART1_IRQHandler`（IDLE 搬运），仅 BOOT target 链接；
  APP 工程有自己的 USART1 中断（喂 `ota_app_hook`），勿重复链接。
- F4 实现零中断、零 HAL 依赖 → BOOT 裸机直接可用，也不与 APP 中断冲突。

## 验收契约

- `components/` 单独 configure 通过；编译零警告。
- BOOT 上电 `OtaBootFlow_CheckState` 打印 `=== Bootloader Start ===`（monitor 判据）。
- APP 侧集成不破坏现有 fputc 输出与 `[alive]` 心跳。
