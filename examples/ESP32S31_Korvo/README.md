# ESP32S31_Korvo —— ESP-IDF 工程接入 / 工具链解耦样例

本工程用一个「最小的心跳」证明一件更重要的事：**elab 内核不绑定任何编译链**。
ESP-IDF 的编译、烧录、校验全部由**声明式 provider**（`providers/official/espressif/idf/provider.yaml`）
提供，项目 YAML 只做显式绑定；内核只继续负责事件流、串口三态与 verdict。
板载 WS2812 RGB 用 ESP-IDF 的 RMT 驱动，心跳与灯共用同一个 500ms 时基。

## 展示什么能力

| 能力 | 本工程怎么体现 |
|---|---|
| **芯片闭环第一关**（C36） | 串口 1Hz `[alive] tick=N toggles=M stage=boot`；`toggles` 每次严格 +2，相邻间隔 ≈1.000s |
| **心跳与 RGB 灯同一时基** | `esp_timer` 500ms 周期：翻转 WS2812（亮灭周期 1s）并计数，每 2 次打一条心跳 |
| **WS2812 / RMT 自定义编码** | `ws2812_encode` 按 T0H/T0L/T1H/T1L 生成 RMT symbol，10MHz 分辨率；发送失败不致命，下一拍重试 |
| **非阻塞主循环** | `app_main` 只做初始化并启动定时器；无 `HAL_Delay`/忙等 |
| **Provider 工具链（数据与执行分离）** | 项目只写 `provider: espressif/idf@>=1 <2`；命令模板归 `provider.yaml`，芯片参数归 pack，主机路径归 host |
| **缺步骤不回退** | provider 未提供某步骤 → 该步骤直接不可用并报错，不会静默回落到原生链（D3） |
| **显式混用** | 需要时可 `steps.flash: tool:my_flash` 单步覆盖；`monitor` 永远由内核提供 |
| **主机路径单点收敛** | 所有 IDF 路径写成 `${host:tools.idf.*}`；换机器只改 `elab.host.yaml`，内核与项目 YAML 都不动 |
| **环境变量链式解析** | `env_from_cmd` 调 `idf_tools.py export` 取 `PATH`，用 `env_prepend_path` 前置，再解析 `${env:IDF_PY}` |
| **烧录校验而非 GDB** | `debug_verify` 由 provider 声明为 `esptool verify-flash`，参数由 `${json_args:build/flasher_args.json#flash_files}` 从构建产物展开 |
| **构建产物回填内存占位** | 委托 build 成功后，内核从 `build/esp32s31_korvo.map` 解析 `irom_seg` / `sram_seg` / `lp_reserved_seg`，面板照常显示 FLASH/RAM 百分比 |
| **项目固定包** | `pack: espressif/esp32`，不受 `packs/installed/active.json` 影响 |
| **项目级步骤文案** | `step_labels.debug_verify: 烧录校验`，只改显示不改语义 |

## 硬件

- ESP32-S31-Korvo-1 V1.1 开发板
- 板载 WS2812 RGB：**GPIO37**
- 串口：板载 USB-UART，115200（`serial.port: auto`）
- 注意：Korvo-1 **没有板载 USB-JTAG**，真正的 RISC-V GDB 调试需要外接探针；
  本样例的 `debug_verify` 是「烧录校验」，不是断点调试。

## 前置

1. **安装芯片包**（不内置）：

   ```bash
   elab pkg install espressif/esp32
   elab pkg list
   ```

2. **安装工具链 provider**（声明式数据包，独立于芯片包）：

   ```bash
   elab provider install espressif/idf     # 官方源兜底；也可 --from 本地目录
   elab provider list
   ```

3. **配置主机 IDF 路径**（`elab.host.yaml` 的 `tools.idf`）：

   ```yaml
   tools:
     idf:
       python: C:\Espressif\tools\python\v6.1\venv\Scripts\python.exe
       idf_path: C:\esp\v6.1\esp-idf
       tools_path: C:\Espressif
       venv: C:\Espressif\tools\python\v6.1\venv
       version: "6.1"
   ```

   项目 YAML 只引用 `${host:tools.idf.*}`，不再重复写绝对路径。

## 怎么跑

```bash
elab doctor -p esp32s31_korvo
elab loop   -p esp32s31_korvo
elab run -p esp32s31_korvo --steps build          # 只跑 provider 编译
elab run -p esp32s31_korvo --dry-run --steps build,flash,debug_verify  # 看 materialize 后的真实 argv
elab monitor -p esp32s31_korvo                     # 串口判据（内核原生，不委托）
```

> 外壳（PowerShell）会把 `${...}` 当变量插值；在命令行里手写模板时请用单引号或
> 交给 YAML 解析，避免被 shell 先吃掉。

## 预期证据

串口：

```text
[boot] esp32s31_korvo heartbeat stage=boot
[alive] tick=1 toggles=2 stage=boot
[alive] tick=2 toggles=4 stage=boot
...
```

- `tick` 每秒 +1；`toggles` 每秒 +2（500ms 一次翻转）。
- 板载 RGB 每 1s 亮灭一次——**必须由人肉眼确认**。
- 构建日志里会出现内存占位（来自 `.map`）：

  ```text
  irom_seg   0.27%   ...
  sram_seg  16.35%   ...
  ```

## 源码索引

- `main/heartbeat_main.c` —— 心跳、WS2812 编码、`esp_timer` 节拍
- `CMakeLists.txt` / `main/CMakeLists.txt` —— 标准 ESP-IDF 工程入口
- `sdkconfig.defaults` —— **入库的构建意图**；`sdkconfig` 是本地构建状态，不应入库
- `projects/esp32s31_korvo.yaml` —— provider 绑定、`${host:...}` 与项目级 `artifacts`
- `providers/official/espressif/idf/provider.yaml` —— 规范步骤命令模板（编译/烧录/校验）
- `elab.host.yaml` —— `tools.idf` 主机路径单点收敛

## 注意

- `monitor` **不允许**委托：串口三态与 `serial/*` 事件必须留在内核。
- `sdkconfig` 不要提交；运行参数（分区、flash 大小等）从 `build/flasher_args.json`、
  `.map`、`build/config/sdkconfig.json` 读取，不要反写工程配置。
- 换 IDF 版本只改 `elab.host.yaml`；若 `capabilities.meta` 缺失，先同步内核版本，
  不要在工具层为新字段写兼容分支。
