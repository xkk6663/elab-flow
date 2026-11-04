# AT32F421G8U7 —— 跨厂商最小心脏跳动样例

本工程验证 elab 的一个重要事实：**同一套闭环工作流可以驱动非 ST 的芯片**。
它是 Artery 官方的 AT32 Workbench 模板加一段最小业务代码，用来做新芯片/新板子的
bring-up 与「第三家厂商接入」演练。

## 展示什么能力

| 能力 | 本工程怎么体现 |
|---|---|
| **芯片闭环第一关**（C36） | 主循环 1Hz `[alive] tick=N`，上电先打 `[boot] at32f421g8u7 ok, sysclk=...Hz` |
| **复位 → 时钟 → USART1 → printf → 线** 全链路 | 启动横幅本身就是链路已通的证据；`printf` 重定向到 USART1（裸机轮询发送，带 guard 防死等） |
| **newlib printf 重定向** | 强定义 `__io_putchar`（`syscalls.c` 仅有 weak 声明，不定义会跳到地址 0） |
| **DMA 外设初始化** | DMA1 Channel2/3 参与 USART1 收发（Workbench 生成的配置） |
| **非 ST 芯片的工程接入** | `projects/at32f421g8u7.yaml`：Archetype B（Workbench 工具链写在工程内）、项目固定包 `artery/at32` |
| **项目固定包（`pack:`）** | 即使 `active.json` 启用的是 `st/stm32`，本项目仍能解析到 `artery/at32` 包里的芯片参数 |

## 硬件

- AT32F421G8U7 开发板
- AT-Link / DAP-Link 探针（SWD）
- USB 串口：USART1，115200 8N1（TX=PB6，MUX_0）
- 可选：空闲 GPIO 接示波器/逻辑分析仪作为「LED 替代」

## 前置：安装外置芯片包

`artery/at32` **不在骨架仓内置**，必须从社区市场安装：

```bash
elab pkg install artery/at32        # 或 elab pkg search at32 后按名安装
elab pkg list                        # 确认已装
```

## 怎么跑

```bash
elab doctor -p at32f421g8u7
elab loop -p at32f421g8u7
```

只看计划不执行：`elab loop -p at32f421g8u7 --dry-run`。

## 预期证据

```text
[boot] at32f421g8u7 ok, sysclk=<实机值> Hz
[alive] tick=1
[alive] tick=2
...
```

判据：`monitor.close_on` 命中 `^\[(boot|alive)\]` → `ok`；
`HardFault|assert|PANIC` → `failed`。

## 源码索引

- `project/src/main.c` —— 启动横幅、心跳、`__io_putchar`
- `project/src/wk_*.c` / `project/inc/wk_*.h` —— Workbench 生成的外设初始化
- `AT32F421x8_FLASH.ld` —— 链接布局
- `projects/at32f421g8u7.yaml` —— Archetype B 工程接入、`pack: artery/at32`

## 注意

- `projects/at32f421g8u7.yaml` 是 `elab adapt` 确定性生成的文件；要改工程请改工程本身，
  要改芯片参数请改适配包，不要手改 YAML 中的芯片事实。
- 心跳用 `wk_delay_ms(1000)` 是「最小 bring-up 可接受」的取舍；接业务外设后应按 C36
  改成非阻塞节拍（与 STM32F103C8T6 样例一致）。
