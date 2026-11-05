# STM32F411CEU6 —— OTA 升级全链路实弹样例（APP 侧）

本目录是 elab 的**旗舰示例**：它不只是一个心跳 demo，而是一套完整的
「Bootloader + APP + 上位机 + 异常注入 + 双槽回滚」参考实现。
APP 工程是外层根目录，配套 Bootloader 在 [`boot/`](boot/)，两者合起来是一个完整例程。

## 目录结构

```text
examples/STM32F411CEU6/
├── CMakeLists.txt / 411.ioc / Core/ / APP/ ...   # APP 工程根（CubeMX + FreeRTOS）
└── boot/                                         # 配套 Bootloader（独立 CMake 工程）
    ├── main.c / BOOT.ld / startup_stm32f411xe.s
    └── CMakeLists.txt
```

两个工程各有独立的 `projects/*.yaml`（`stm32f411ceu6` / `f411_boot`），
但属于同一套 OTA 完整例程；日常只操作 APP 工程，boot 由 `boot_project` 级联构建。

## 展示什么能力

| 能力 | 本工程怎么体现 |
|---|---|
| **OTA 单槽升级** | 停等协议 `AA [01|02] SEQ LEN DATA CRC32 EOF 55`；CRC 错 NAK 重传；每 1KB 记页，支持断点续传 |
| **OTA 双槽回滚（A/B Bank）** | 新固件写 INACTIVE 槽 B → 试运行（trial 先记账后跳转）→ 耗尽打印 `=== ROLLBACK ===` 回老固件；心跳第 3 次成立即 `OTA_Confirm()` 晋级 |
| **分区表唯一事实源** | 芯片包 `chips/st/stm32f411ceux.yaml` 的 `ota_layout:` → 构建期生成 `ota_layout_gen.h` → `doctor --deep` 三方对账（包 ↔ 烧录地址 ↔ 链接脚本） |
| **组合工程级联构建** | `boot_project: f411_boot`：`elab build -p stm32f411ceu6` 自动先构建 bootloader；`elab flash` 按台账决定 boot 镜像是否进本次会话 |
| **双镜像烧录** | boot @ `0x08000000`（32K）+ app @ `0x08010000`；bin 带显式地址（防止擦到 boot 尾部） |
| **FreeRTOS 多任务** | `defaultTask`（心跳/LED/OTA 触发）、`myUSART`（按键扫描 + 波形）、`echoTask`（串口双向压测） |
| **闭环存活判据** | 1Hz `[alive] tick=N`，命中 `monitor.close_on` 即 `ok` |
| **波形演示（FireWater）** | 100 Hz 采样输出 `a,b\r\n` 两路反相正弦（0.5 Hz）；面板「串口 → 波形」选 FireWater 即可看到 |
| **串口压力测试固件端** | `PING:<payload>` → `PONG:<payload>`、`STATS?`、`ECHO_ENABLE 0|1`，每 50 次自报 `[echo] total=/bytes=` |
| **按键** | 单击 → `KEY:1`、长按 1s → `KEY:2`（经消息队列投递，不在扫描里打印） |
| **异常注入工具链** | 项目 YAML 声明 6 个 `elab run --steps tool:<name>` 工具：升级 / 版本检查 / 坏固件回滚 / 坏帧重传 / 限速拔电 / CRC_FAIL 恢复 |
| **HAL 层调试** | 项目 YAML 接了 SVD（`STM32F411.svd`）与 openocd target，调试工作区可读外设寄存器、RTOS 栈水位 |

## Flash 布局（F411 扇区几何）

| 区域 | 地址 | 大小 |
|---|---|---|
| Bootloader（S0+S1） | `0x08000000` | 32K |
| Upgrade State（S2） | `0x08008000` | 16K |
| Offset Record（S3） | `0x0800C000` | 16K |
| 槽 A（S4+S5，出厂 ACTIVE） | `0x08010000` | 192K |
| 槽 B（S6+S7，INACTIVE） | `0x08040000` | 256K |

## 怎么跑

```bash
# boot 会按 boot_project 自动级联构建
elab build -p stm32f411ceu6
elab loop  -p stm32f411ceu6        # doctor → build → flash → debug_verify → monitor
```

驾驶舱面板里还能单独触发 OTA 系列工具（编译产物在 `.work/stm32f411ceu6/`）：

| 工具 | 展示的异常路径 |
|---|---|
| `ota` | 正常升级：写槽 B → 试运行 → 确认晋级 |
| `ota-check` | 版本检查：设备版本 ≥ 固件版本则跳过升级 |
| `ota-badfw` | 坏固件：Reset 向量改 `0xFFFFFFFF` → 试运行挂死 → 周期复位 trial 递减 → `=== ROLLBACK ===` |
| `ota-corrupt` | 坏帧：第 3 帧 CRC 首发破坏 → boot NAK → 主机重传 → SUCCESS |
| `ota-throttle` | 限速传输约 20s，留出「中途拔电」窗口 → 重插后断点续传 |
| `ota-crcfail` | 截断注入 → boot 判 CRC_FAIL → `'!'` 重新升级 → 全量重传 → SUCCESS |

> 这些工具调用的是上位机工程 `C:/Users/xiao1/Desktop/STM32-OTA-QT/iap_host_tool`
> （见 `projects/stm32f411ceu6.yaml` 的 `tools.*.cwd`）。没有该工程时，编译/烧录/调试/串口
> 仍然可用，只是 OTA 工具按钮不可用。

## 预期证据

```text
[boot] ---- init log begin ----
[boot] HAL init  : ok
[boot] clock     : ok (SYSCLK=100000000 Hz, HCLK=100000000 Hz)
[boot] UART1     : ok (115200 baud, 8N1, TX=PA9, RX=PA10)
[boot] ota cap   : ok (bitmap=0x03, rc=0)
...
[alive] tick=<ms>
```

升级过程中串口还会出现协议级事件（`READY` / `SUCCESS` / `ROLLBACK` 等），
由上位机转发成驾驶舱事件，可在面板「工具」页看到。

## 源码索引

- `Core/Src/freertos.c` —— 三个任务、心跳、波形、echo 命令解析、`fputc` / `__io_putchar`
- `Core/Src/main.c` —— HAL/时钟/外设初始化与 RTOS 启动
- `APP/KEY.c` —— 单击/长按识别，经消息队列上报
- `STM32F411_APP.ld` —— APP 链接布局（`0x08010000`）
- `CMakeLists.txt` —— 接入 `components/ota`（`VARIANT app`，能力位图 `0x3`）
- `boot/main.c` —— 配套 Bootloader 的薄入口（与 APP 共用 `components/ota`，`VARIANT boot`）
- `boot/BOOT.ld` —— Bootloader 链接布局（`0x08000000`，32K）
- `projects/stm32f411ceu6.yaml` —— 双镜像烧录、串口判据、6 个 OTA 工具

技术细节：[OTA_F411_移植技术方案](doc/OTA_F411_移植技术方案.md)、
[OTA_双槽回滚技术方案](doc/OTA_双槽回滚技术方案.md)。

## 注意

- `examples/STM32F411CEU6/411/` 是同一工程的**嵌套副本**（含自己的 `build/`）；
  elab 只认外层 `CMakeLists.txt`。guard 快照会连副本一起扫，不要在副本里改文件。
- 工程根 `build/` 是 IDE 旧构建产物；elab 一律在 `.work/stm32f411ceu6/` 独立构建，
  不复用也不清理它。
- `printf` 依赖 `__io_putchar` 的**强定义**（CubeMX 的 `syscalls.c` 只有 weak 声明）。
- LED 是否闪烁仍需人肉眼确认；agent 只核对 `[alive]` 计数与间隔。
