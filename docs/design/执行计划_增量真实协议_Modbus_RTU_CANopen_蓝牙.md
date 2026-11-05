# 执行计划：增量真实协议改造（Modbus RTU / CANopen / 蓝牙 SPP）

> 定位：**新增真实协议与真实传输** —— Modbus RTU 主站、蓝牙 Classic SPP、
> CAN 2.0A/B → CANopen，配套教学固件与含实机截图的协议上手教程。
>
> 本文是源码调研后的可执行方案，只做计划，不写实现。
> 存量帧协议补强、Agent 生产率与观测性能在姊妹文档
> [执行计划_串口存量优化_帧协议补强与Agent能力](执行计划_串口存量优化_帧协议补强与Agent能力.md)；
> 两份文档可独立实施（Modbus 不依赖帧协议补强）。
>
> 编号沿用原“串口 P2/CAN”阶段计划：本文件保留 **P2.1 / P2.3 / C0–C2**。
>
> **已确认（2026-11-05）**
>
> - “opencan” = **CANopen（CiA 301 / CiA 402）**；
> - Modbus **只做主机（Master）+ RTU**，不做内核从机模式、不做 Modbus TCP；
> - CAN 适配器用 **SLCAN USB-CAN**，**500 kbit/s**，**标准帧为主**（29 位扩展帧保留接口）；
> - 蓝牙目标设备是 **ESP32-S31**（Wi-Fi + 双模蓝牙：Classic BR/EDR + BLE 5.4）；
>   **优先 Classic SPP**（Windows 配对后虚拟 COM，复用现有串口传输），BLE NUS 作为备选；
> - SPP **叠加在现有 `examples/ESP32S31_Wave`**（Wi-Fi TCP/UDP 已在跑），不新建示例；
> - 增加 `examples/STM32F103C8T6_Modbus` 教学从站固件；
> - 增加 CAN 教学工程（需要 CAN 收发器/接线）；
> - 协议上手教程要求包含**实机截图**。
>
> **状态（2026-11-05）**：源码调研完成，决策已对齐，待实施；CAN 实机截图依赖收发器/适配器到位。

---

## 1. 结论

1. **P2.1 Modbus RTU 主站是增量协议的第一优先**：现有 `crc16modbus` 已足够调制解帧，
   缺的只是事务层；不需要等待通用帧协议补强。
2. **P2.3 蓝牙优先 Classic SPP**：Windows 配对后是虚拟 COM，直接复用现有串口传输与四视图；
   固件叠加在 `examples/ESP32S31_Wave`（Wi-Fi TCP/UDP 与 SPP 共存）；BLE NUS 只作为备选。
3. **CAN 从虚拟总线开始**：CAN 硬件未连，不阻塞学习与内核开发；`virtual` 后端 + SLCAN 编解码先行，
   适配器到位后走 C1 上机，再进 C2 CANopen。
4. **教学交付物**：`examples/STM32F103C8T6_Modbus`（Modbus RTU 从站）、
   `examples/STM32F103C8T6_CAN`（CAN 2.0A/B 教学工程）、协议上手教程与实机截图；
   固件只进 `examples/**`，协议逻辑仍在内核通用层，不把 Modbus/CANopen 写进芯片包。
5. **分层边界不变**：业务逻辑只进 `services/elab/**` 与 `cockpit/server.py`；插件只改
   `packages/dsh-elab-cockpit/**`；芯片事实仍只住 `packs/**`；协议模板仍只住 `templates/**`。
6. **依赖边界不变**：不引入 `python-can` / `bleak` 硬依赖；SPP 零新增依赖，
   BLE 备选缺失时能力自描述为 false。

---

## 2. 现状盘点（源码事实）

### 2.1 传输与会话

| 位置 | 事实 |
|---|---|
| [serialtransport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialtransport.py#L26-L27) | `KINDS = ("serial", *NET_KINDS)`；传输白名单在这里收敛 |
| [serialtransport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialtransport.py#L56-L100) | `resolve()`：显式 → 工程 `serial.*` → 宿主 → 默认；未知传输报错 |
| [serialtransport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialtransport.py#L103-L115) | `open()`：serial 走 `SerialIO`，TCP/UDP 走 `netio.open_net` |
| [netio.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/netio.py#L120-L246) | TCP/UDP 的 `open/read/write/close` 与 `SerialIO` 同形 |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L123) | `_Session` 是唯一的串口会话实现 |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L459-L486) | `_push_chunk`：字节环、速率事件、录制、RX 解码的唯一入口 |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L693-L703) | 会话写入入口 `write`；对外 `write_through` |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L842-L970) | `open_session`：解码器校验、传输解析、幂等复用 |

**结论**：Classic SPP 对内核是“普通 COM 口”，不需要新传输；只有 BLE 备选才需要
实现 `open/read/write/close` 四件套 + 解析白名单，且不改 `_Session` 结构。

### 2.2 依赖与 CAN/BLE 现状

- 内核**仅标准库**：`services/elab/_yaml.py` 明示零第三方；仓库没有 `pyproject.toml` / `requirements*.txt`。
- `pyserial` 是**惰性可选后端**（[serialport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialport.py#L58-L75)）；
  没有 `python-can`、`bleak` 痕迹。
- **无任何 CAN / CANopen / BLE 实现**；`tests/test_netio.py` 里只有 `socketcan` 作为“未知传输必须报错”的负例。
- 串口侧已能识别蓝牙虚拟 COM，但 **auto 选口默认排除**（[serialport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialport.py#L32-L39)、
  [serialport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialport.py#L235-L251)）。
  Classic SPP 只需要放开这个口，不需要新传输栈。

### 2.3 HTTP / 插件 / 前端（新增端点必须登记）

| 位置 | 事实 |
|---|---|
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L95-L255) | `SERIAL_META`：视图、格式、解码器、frames schema、features、transports |
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L2010-L2451) | POST：widgets/serial/control/monitor/frames/preview/encode/capture/decode |
| [tools.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/dsh-tools/tools.ts#L839-L1536) | `elab_serial*` 与 `elab_frame_profile` 全部工具 |
| [routes.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/kernel-http/routes.ts#L76-L125) | 插件 HTTP 白名单；新增端点必须登记 |
| [SerialWorkspace.tsx](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/web/src/serial/SerialWorkspace.tsx#L67-L74) | 四视图：lines / bytes / terminal / wave |
| [icd.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/cockpit-ui-core/src/icd.ts#L242-L270) | `SerialMeta`、`SerialChunk`、`SerialDecodeResult` 等共享类型 |
| `tests/test_serial*.py` | 串口相关 8 个测试文件；`test_serialmon.py` 46 例、`test_serialframes.py` 36 例 |
| `packages/dsh-elab-cockpit/test/` | 17 个测试文件、135 例；边界门禁 `boundary.test.mjs` 7 例 |

---

## 3. 目标与非目标

### 3.1 目标

1. **P2.1**：Modbus RTU 主站可用（读写、轮询、异常/超时/重试可视）。
2. **P2.3**：蓝牙传输可用（Classic SPP 优先，虚拟 COM 复用四视图）。
3. **CAN 轨道**：无硬件也能用虚拟总线学习与开发；硬件到位后完成 CAN 2.0A/B 收发，
   再做 CANopen NMT/Heartbeat/SDO/PDO/EMCY。
4. **交付物**：两个教学固件 + 一篇含实机截图的协议上手教程 + 工程 YAML。
5. **人机同源**：Agent 与人在同一份会话、同一份数据上工作；Agent 写操作仍受
   `allowAgentWrite` + `rev` 双重约束。

### 3.2 非目标

- Modbus **不做从机内核模式**（从机只以教学固件存在）、**不做 Modbus TCP（MBAP）**、不做多主站并发。
- **不做多协议并行解码**；一个会话仍只有一个活动解码器。
- 不在本计划内做 CAN FD、DBC 导入、CAN 节点图/仿真工程；CAN 先把 2.0A/B 与 CANopen 打通。
- 不把厂商协议逻辑写进内核；Modbus/CANopen 是通用协议层，EDS/寄存器表是工程数据。
- 不引入 `python-can` / `bleak` 硬依赖；不自动 `pip install`、不自动改 `elab.host.yaml`。
- 不新建蓝牙示例工程（SPP 叠加在 `examples/ESP32S31_Wave`）。

---

## 4. 总体架构

```text
字节流（现有）                 真实协议（新增）              帧总线（新增）
serial / TCP / UDP            Modbus RTU master             CAN 2.0A/B
        │                            │                            │
        └──────── serialmon._Session ┘                            │
                （单写者、字节环、共享解码）                        │
                                                                  ▼
                                                        canmon._CanSession
                                                         （帧环、过滤、TX）
                                                                  │
                                                         canopen（NMT/SDO/PDO）
```

### 4.1 新增模块（全部在业务层）

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `services/elab/modbus.py` | Modbus PDU 编解码、异常码、CRC、寄存器类型转换 | 不做 IO、不认识会话 |
| `services/elab/modbusmaster.py` | 挂在 `serialmon._Session` 上的主动轮询引擎：事务匹配、超时重试、寄存器缓存 | 不持有端口、不重复实现读线程 |
| `serialport.py` + 工程 YAML + `examples/ESP32S31_Wave` | **Classic SPP 主路径**：放开蓝牙虚拟 COM 的 auto 选口（`allow_bluetooth`）；固件叠加 SPP（与 Wi-Fi coex） | 不新造传输栈 |
| `bleio.py`（备选） | BLE GATT 后端，实现 `open/read/write/close` 与 `SerialIO` 同形契约 | 不感知视图、不自动装依赖 |
| `services/elab/canio.py` | `CanFrame` 模型、`virtual`/`slcan`/`socketcan` 后端、SLCAN 纯编解码 | 不写业务轮询策略 |
| `services/elab/canmon.py` | CAN 会话：帧环、过滤、TX、录制、统计 | 不做 CANopen 语义 |
| `services/elab/canopen.py` | NMT、Heartbeat、SDO、PDO、EMCY、SYNC、EDS 解析 | 不做厂商对象字典硬编码 |
| `templates/canopen/**` | EDS 片段/对象字典模板（数据层，可选） | 不是芯片包 |

### 4.2 关键接线点

- **Modbus 挂在会话上**，而不是另开一个串口：复用 `_Session.write`、`_push_chunk` 的 RX 流，
  保持 C17 单写者；字节视图/终端仍可同时看。
  - 挂钩点：`_push_chunk`（RX 字节入事务匹配器）与 `write`（统一写锁）。
  - 引擎异常不得拖死读线程；错误只落 `modbus.error`。
- **Classic SPP 复用 `serialtransport` 的 `serial` 分支**：只是允许蓝牙虚拟 COM 被显式/auto 选中；
  固件侧在 `examples/ESP32S31_Wave` 内与 Wi-Fi TCP/UDP 并存，内核侧无感知、无新传输。
- **BLE 备选**：`KINDS` 增加 `ble`，`resolve()` 增加 BLE 配置，`open()` 返回 `bleio.BleIO`；
  `_Session` 不改。
- **CAN 独立会话**：CAN 是帧不是字节流，不复用 `SerialIO`；新增 `/api/can/*` 与 `CAN_META`。

---

## 5. P2.1 Modbus RTU 主站（第一优先）

**为什么先做**：现有 `crc16modbus` 已经能解 Modbus RTU 帧，缺的只是事务层；
不需要等通用帧协议补强（见姊妹文档 P2.2）。

**范围锁定**：只做**主机（Master）+ RTU**；从机只以教学固件形式存在（§7.1），
不新增内核从机模式；不做 Modbus TCP（MBAP）。

**能力范围**

- 功能码：`0x01/0x02`（线圈/离散输入）、`0x03/0x04`（保持/输入寄存器）、
  `0x05/0x06`（单写）、`0x0F/0x10`（多写）；异常码原样上报。
- 事务：unit id、timeout、retries、事务序号、广播写（无响应）。
- 轮询：一个或多个 poll group，独立 `interval_ms`；失败退避；不堆积。
- 寄存器表：`u16/i16/u32/i32/f32/bit/bitfield` + `scale/bias/enum/unit/plot`；
  连续寄存器可按类型跨寄存器组合（如 `u32` 占 2 个寄存器）。
- 数据面：事务环 + 寄存器快照 + 波形通道；错误计数与最后一次异常码。
- 存储：`projects/<name>.modbus.json`，`rev` 乐观锁；Agent 可读写（`allowAgentWrite`）。

**数据模型（草案）**

```json
{
  "version": 1,
  "rev": 0,
  "mode": "rtu",
  "unit": 1,
  "polls": [
    {"name": "pcs", "function": 3, "address": 0, "count": 8,
     "interval_ms": 500, "timeout_ms": 200, "retries": 1}
  ],
  "registers": [
    {"name": "voltage", "address": 0, "type": "u16",
     "scale": 0.01, "unit": "V", "plot": true},
    {"name": "status", "address": 1, "type": "u16",
     "bits": {"0": "RUN", "1": "FAULT", "2": "OVR"}},
    {"name": "energy", "address": 2, "type": "u32", "unit": "kWh", "plot": true}
  ]
}
```

**改动点**

| 层 | 改动 |
|---|---|
| 内核 | 新增 `modbus.py`（PDU/CRC/异常/类型转换）、`modbusmaster.py`（会话内引擎） |
| 内核 | `serialmon._Session` 增加 RX 监听器与 Modbus 引擎生命周期（start/stop/poll） |
| HTTP | 新增 `MODBUS_META` 与 `/api/modbus/*`：`meta`、`open/start`、`stop`、`read`、`write`、`poll`、`map`、`stats`、`transactions` |
| Self-description | `SERIAL_META.features` 增加 `modbus_rtu`、`modbus_poll`、`modbus_map`、`modbus_write` |
| Agent | 新增 `elab_modbus`：`status/map_get/map_save/read/write/poll_start/poll_stop/transactions` |
| 前端 | `SerialWorkspace` 增加 `Modbus` 视图：连接栏复用、寄存器表、轮询配置、事务日志、波形 |
| 共享类型 | `cockpit-ui-core` 增加 Modbus 事务/寄存器/meta 类型 |
| 测试 | PDU 金向量、异常码、超时重试、轮询退避、广播写、寄存器组合类型；假传输不碰真串口 |

**验收**

1. 对 Modbus 从站（F103 教学从站或第三方设备）完成 FC03/FC06/FC10 读写；
2. CRC 错误、异常响应、超时、重试都有明确计数与最后原因；
3. 寄存器波形与事务日志同屏，原始字节视图仍可切；
4. 与串口监视/闭环的端口互斥语义不变（同一时间一个写者）。

**不做**：Modbus TCP、内核从机模式、多主站并发。教学从站固件见 §7.1。

---

## 6. P2.3 蓝牙传输（Classic SPP 优先，BLE 备选）

### 6.1 先说结论

- ESP32-S31 是**双模蓝牙**：Classic BR/EDR + BLE 5.4；ESP-IDF 提供 `esp_spp`，
  并且 SPP 同时支持 Server/Client 角色。
- 本项目在 Windows 驾驶舱上**优先 Classic SPP**：
  1. Windows 配对后生成**虚拟 COM 口**，现有 `serial` 传输直接可用，不需要新传输栈；
  2. 吞吐与延迟优于 BLE 的 MTU 分片，适合波形/流式数据；
  3. 不需要 `bleak` 依赖，也不需要 GATT UUID 配置；
  4. “经典蓝牙串口”就是 SPP，和“就要经典的”一致。
- **BLE NUS 作为备选**：需要 iOS/macOS 客户端、低功耗，或希望应用内扫描/配对时再用。
  BLE 没有标准串口 profile，NUS 只是事实标准。

### 6.2 SPP 落地

- 芯片事实：ESP32-S31 是 **Wi-Fi + 蓝牙双模**（Classic BR/EDR + BLE 5.4），
  Wi-Fi 与蓝牙共享射频，需要软件共存（ESP-IDF coex）；现有 `examples/ESP32S31_Wave`
  已经在跑 Wi-Fi（TCP/UDP），SPP **叠加到该工程**即可验证四链路并存。
- 固件：**不新建示例**，把 SPP 叠加到 `examples/ESP32S31_Wave`（Bluedroid + `esp_spp` acceptor，
  设备名如 `ESP32-S31-SPP`），保留 USB 串口 / TCP / UDP 三条现有链路，新增 SPP 为第四条；
  帧数据与 1 Hz 心跳同源，SPP 发送走独立 task，不在主循环忙等。
- 共存与配置：`sdkconfig.defaults` 打开 Wi-Fi/蓝牙软件共存（`CONFIG_SW_COEXIST_ENABLE`，
  新版符号为 `CONFIG_ESP_COEX_SW_COEXIST_ENABLE`，以本机 IDF 的 `menuconfig` 为准）；
  Bluedroid + SPP 会额外占 flash/RAM，N16R16 余量足够但要实测启动与吞吐；
  共存开启后 Wi-Fi 吞吐会下降，波形链路以**串口/SPP 为主、Wi-Fi 为对照**。
- Windows：先在系统蓝牙设置里配对，系统创建出站 COM；工程里用 `serial.port: COMx` 显式指定。
- 选口：`serialport.py` 目前 **auto 默认排除**蓝牙虚拟口（见 §2.2），
  新增 `serial.allow_bluetooth: true` 后允许 SPP COM 参与 auto，并在证据里标注 `bluetooth`。
- 前端：连接方式仍是“串口”，端口列表显示 `COMx [bluetooth]`；
  增加“SPP 需先在 Windows 配对”的提示，不新增 `BLE` 连接模式。
- `SERIAL_META`：串口子 schema 增加 `allow_bluetooth`，说明配对步骤。
- 测试：auto 默认排除 / `allow_bluetooth` 允许 / 显式 COM 三种行为。

### 6.3 BLE 备选（不阻塞 P2）

- 仅当确需 iOS/低功耗/应用内配对时实现：
  `services/elab/bleio.py`（惰性 `bleak`）+ `KINDS += ble` + NUS UUID + 前端扫描；
- 验收按“假后端 + 实机”两档，缺失 `bleak` 时能力自描述为不可用。

### 6.4 验收

1. ESP32-S31 SPP 固件配对后生成 COM，行/字节/终端/波形四视图都有数据；
2. auto 默认仍排除蓝牙虚拟口；`allow_bluetooth`/显式 COM 可选中；
3. SPP 实机截图：Windows 配对、端口列表 `[bluetooth]`、四视图；
4. BLE 备选若实现，假后端全链路通过。

---

## 7. 教学固件与协议教程（交付物）

### 7.1 `examples/STM32F103C8T6_Modbus`（Modbus RTU 从站）

- 基于现有 `examples/STM32F103C8T6` 的 HAL/构建骨架，新增独立示例目录；
- 串口 `115200 8N1`，从站地址 `1`；
- 功能码：`0x03` 读保持寄存器、`0x06` 写单寄存器、`0x10` 写多寄存器；
- 异常码：非法功能 `01`、非法地址 `02`、非法数据值 `03`；
- 寄存器表（示例）：电压 `u16 scale=0.01`、状态位、能量 `u32`、递增计数器；
- 保留 C36 心跳：1 Hz `[alive] tick=… toggles=…`，板载 LED 与心跳同一时基；
- 3.5 字符静默/帧间隔判定，CRC16 Modbus 校验；
- 工程接入：`projects/STM32F103C8T6_Modbus.yaml`；
- 验收：用 `elab build/flash` 烧录；P2.1 主站完成前，用串口面板十六进制发请求，
  核对响应字节与 CRC；主站完成后补寄存器表/波形截图。

### 7.2 `examples/STM32F103C8T6_CAN`（CAN 2.0A/B 教学工程）

- F103 bxCAN：`PA11 CAN_RX` / `PA12 CAN_TX`（或按板子实际引脚）；
- 外部 CAN 收发器（TJA1050 / SN65HVD230），CANH/CANL 双绞，双端 120Ω，共地；
- `500 kbit/s`，标准帧为主；扩展帧保留接口；
- 教学行为：周期发送 `0x123` 计数帧；接收并过滤 `0x321`；支持 loopback 自测；
- 保留 1 Hz 心跳与 LED；
- 工程接入：`projects/STM32F103C8T6_CAN.yaml`；
- **硬件门槛**：没有收发器/适配器时只验证编译与 loopback；实机收发与截图在 C1 完成。

### 7.3 协议上手教程（含实机截图）

- 文档：`docs/tutorials/09-协议上手_Modbus_CANopen_BLE.md`（一篇三章，或按需拆 09/10/11）；
- 章节：
  1. Modbus RTU：帧结构、CRC、请求/响应、异常码、寄存器表、实机截图；
  2. CAN 2.0A/B：帧结构、仲裁、位时序、过滤、错误状态、CANopen NMT/SDO/PDO、实机截图；
  3. 蓝牙：**Classic SPP 为主**（Windows 配对 → 虚拟 COM → 四视图），BLE NUS 作为备选附录；
- 截图来源：
  - Modbus：STM32F103C8T6 + 驾驶舱串口/Modbus 视图（硬件已连）；
  - 蓝牙：ESP32-S31 + `examples/ESP32S31_Wave`（叠加 SPP）固件，Windows 配对后选中 COM；
    截图同时保留 TCP/UDP 链路，展示 Wi-Fi 与 SPP 共存；
  - CAN：SLCAN 适配器 + F103 CAN 教学工程（**需收发器/接线，截图在 C1 后补**）。
- 截图落点：`docs/tutorials/assets/protocol/`；
- 写作纪律：每一张截图对应一次真实操作与可复核数据；硬件未到位的章节明确标注“待实机”，
  不用示意图冒充实机图。

---

## 8. P2 退出门槛（协议部分）

- Modbus 主站对真实从站/教学从站跑通读写与轮询；
- Classic SPP 实机跑通（配对 → 虚拟 COM → 四视图）；SPP 与 Wi-Fi TCP/UDP 同时在线；
  `allow_bluetooth` 行为符合预期；
- BLE NUS 备选若实现，假后端全链路通过；不实现不阻塞 P2 退出；
- 内核单测、插件 135+ 例、`tsc`、`npm run build` 全绿。

> 通用帧协议补强与 Agent/观测门槛见姊妹文档 §9。

---

## 9. CAN 轨道（C0 → C1 → C2）

### 9.1 C0：无硬件阶段（可与 P2 并行）

**目标**：先把协议模型、虚拟总线、学习材料做出来，不等硬件。

- `canio.py`：
  - `CanFrame`：`id`、`ext`、`rtr`、`dlc`、`data`、`t`；
  - `virtual` 后端：模块级虚拟总线，支持多会话收发与回环；
  - `slcan` 纯编解码：ASCII 帧（`t/r/T/R` + ID + DLC + DATA），可单测；
  - `socketcan` 后端：Linux 标准库 `socket`，Windows 不启用。
- `canmon.py`：帧环（建议 4096 帧/5 MiB）、ID/MASK 过滤、TX、JSONL 录制、帧率/错误统计。
- `CAN_META` + `/api/can/*`：`meta`、`open/close`、`frames`、`write`、`stats`、`capture`。
- DSH 工具：`elab_can_open/read/write/stats/capture`；白名单登记。
- UI：新增 `CAN` 工作区（帧表 + 过滤 + 周期发送 + 错误计数），与串口工作区分开。
- 教学工程：`examples/STM32F103C8T6_CAN` 先保证可编译，并在 loopback 模式下自测。
- 学习文档：`docs/tutorials/09-协议上手_Modbus_CANopen_BLE.md` 先写“虚拟总线”章节。

**C0 验收**：虚拟总线上两个会话互发标准/扩展帧；SLCAN 编解码金向量通过；
过滤、录制、统计可用；无需任何 CAN 硬件。

### 9.2 C1：硬件接入与 CAN 基础

**硬件前提（已确认 SLCAN；收发器待采购）**

- USB-CAN 适配器：**SLCAN USB-CAN**（如 CANable / candleLight 刷 slcan 固件）；
  Linux 也可用 SocketCAN 设备，Windows 走 SLCAN；
- 双端 120Ω 终端电阻、CANH/CANL 双绞、共地；
- 位速率固定 **500 kbit/s**，采样点 87.5%；
- MCU 节点：**F103 需要 CAN 收发器**（TJA1050 / SN65HVD230），
  教学工程见 `examples/STM32F103C8T6_CAN`；
- 标准帧为主，29 位扩展帧保留接口与测试。

**上机顺序（CAN 第一关）**

1. 适配器自环/只听模式，确认驱动与端口；
2. 单节点发送 + 适配器接收，确认 ID/DLC/数据；
3. 两个节点互发（CAN 需要对方 ACK），确认仲裁、过滤；
4. 拔线/错线制造错误，观察错误计数与 bus-off 恢复；
5. 记录证据：帧序列、位速率、错误计数、恢复时间。

**C1 验收**：500 kbit/s 下标准帧收发、过滤、回环、错误状态可见；扩展帧做保留测试；
`elab can doctor` 能给出适配器/端口/位速率结论；协议教程补 CAN 实机截图。

### 9.3 C2：CANopen（CiA 301）

**最小可用集**

- NMT：Start / Stop / Reset Node / Reset Communication；
- Heartbeat / Node Guarding：节点状态与超时监控；
- SDO：expedited 读写（先做），segmented 读写（后做）；
- PDO：TPDO 接收与通道绘图；RPDO 发送（按需）；
- EMCY：错误码/错误寄存器解析；
- EDS：INI 子集解析，导入对象字典；对象浏览器；
- 节点面板：状态、心跳、对象字典、SDO 历史、PDO 波形。

**端点/工具**

- `/api/canopen/*`：`nodes`、`nmt`、`sdo_read`、`sdo_write`、`pdo`、`emcy`、`eds_load`；
- Agent：`elab_canopen`（`status/nmt/sdo/read/write/pdo/emcy/eds`）。

**验收**

1. 虚拟 CANopen 节点（测试夹具）完成 NMT + SDO 读写 + Heartbeat；
2. 有真实节点时完成同样动作；PDO 波形可绘；
3. EDS 导入后对象浏览器可浏览/读写；错误码有解释。

> 若 “opencan” 不是 CANopen，而是某个具体开源 CAN 协议/栈，C2 的对象字典与报文范围需要重定；
> C0/C1 的 CAN 基础层不受影响。

---

## 10. 关键契约（草案）

### 10.1 Modbus 工程文件

见 §5 数据模型：`projects/<name>.modbus.json`，`version`/`rev`、`mode: rtu`、`unit`、
`polls[]`、`registers[]`；保存走 `rev` 乐观锁，Agent 写需 `allowAgentWrite`。

### 10.2 CAN 帧

```json
{"seq": 1, "t_us": 1690000000000000, "id": 291, "ext": false,
 "rtr": false, "dlc": 8, "dir": "rx", "data_hex": "0102030405060708"}
```

---

## 11. 测试与门禁

| 层 | 新增测试 | 门禁 |
|---|---|---|
| Modbus | PDU 金向量、异常码、超时/重试、轮询退避、广播写、寄存器组合类型、假传输 | `tests.test_modbus*` |
| 蓝牙 | SPP：auto 默认排除蓝牙口、`allow_bluetooth` 允许、显式 COM、端口标注；BLE 备选假后端（打开/通知分片/写/断开重连/缺依赖） | `tests.test_serialport` + `test_serialmon` |
| CAN | 帧模型、SLCAN 纯编解码、虚拟总线双会话、过滤、录制、CANopen SDO/PDO 金向量 | `tests.test_can*` |
| 插件 | 新工具描述、参数校验、白名单、边界 | `npm test` + `boundary.test.mjs` |
| 前端 | 类型检查、构建 | `tsc --noEmit`（host/client）+ `npm run build` |

**硬纪律**：所有新增端点必须进 `routes.ts` 白名单；所有写操作必须有 `allowAgentWrite` 与 `rev`；
业务逻辑不得进插件；芯片/工具链知识不得进内核。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| CAN 硬件未到位 | C1/C2 阻塞 | C0 虚拟总线先行；硬件清单与第一关流程先固化；CAN 截图延后 |
| 蓝牙选型误解（误以为 ESP32-S31 不支持 Classic） | 方案返工 | 已核实 ESP32-S31 双模、ESP-IDF `esp_spp` 支持 SPP；默认 SPP，NUS 仅备选 |
| Wi-Fi 与蓝牙共存抢占射频/内存 | 波形丢帧、Wi-Fi 吞吐下降 | 开 ESP-IDF coex；SPP/串口为波形主链路、Wi-Fi 作对照；实测四链路并发与内存水位 |
| BLE 备选依赖 `bleak` 破坏“仅标准库” | 安装失败/环境膨胀 | 惰性可选后端；能力自描述；不自动安装；SPP 路径零新增依赖 |
| Modbus 引擎拖慢读线程 | 丢字节 | 引擎轻量、异常隔离、超时不持锁；性能测试 |
| Modbus 从站时序/3.5 字符判定不严 | 教学固件丢帧 | 固件按 3.5 字符静默切帧；主站超时/重试兜底；实机回归 |
| CANopen 范围膨胀 | 长期不收敛 | 先 NMT/Heartbeat/SDO expedited；PDO/EDS 分步；不做厂商逻辑 |

---

## 13. 决策记录与剩余确认

**已确认（2026-11-05）**

1. “opencan” = **CANopen（CiA 301 / CiA 402）**。
2. Modbus **只做主机（Master）+ RTU**；从机只做教学固件；不做 Modbus TCP。
3. CAN 适配器用 **SLCAN USB-CAN**；位速率 **500 kbit/s**；**标准帧为主**。
4. 蓝牙目标设备是 **ESP32-S31**（Wi-Fi + 双模蓝牙 Classic/BLE）；**默认走 Classic SPP**，
   Windows 配对后虚拟 COM 复用现有串口传输；BLE NUS 仅作备选。
5. P2 内部顺序：**Modbus 主站 → 蓝牙 SPP**（通用帧补强属于姊妹文档 P2.2）。
6. SPP **叠加在现有 `examples/ESP32S31_Wave`**，不新建示例；Wi-Fi（TCP/UDP）与蓝牙共存，
   需开启 ESP-IDF coex，波形以串口/SPP 为主、Wi-Fi 为对照。
7. 新增 `examples/STM32F103C8T6_Modbus` 教学从站。
8. 新增 CAN 教学工程（`examples/STM32F103C8T6_CAN`），需要收发器/接线。

**仍需确认**

1. **CANopen 目标设备**：有没有现成节点（伺服/IO/传感器）？是否需要 CiA 402 驱动器子协议？
2. **蓝牙备选**：是否还需要 BLE NUS（iOS/应用内配对）？若需要，固件是否自定义 GATT UUID？
3. **CAN 帧格式**：标准帧为主已确认；是否还需要 29 位扩展帧/远程帧的实机验收？
4. **CAN 收发器/接线**：具体型号（TJA1050 / SN65HVD230）与板子引脚，决定教学工程接线图。
5. **实机截图节奏**：CAN 章节在收发器/适配器到位后补拍，是否接受“先文档、后截图”？

---

## 14. 执行清单（按依赖排序）

- [ ] 评审本文，确认 §13 剩余项
- [ ] P2.1：`modbus.py` + `modbusmaster.py` + 端点/工具/UI + 单测
- [ ] P2.1：`examples/STM32F103C8T6_Modbus` 从站固件 + `projects/...yaml`
- [ ] P2.1：Modbus 教学从站实机验收（读/写/多写/异常码）
- [ ] P2.3：`serial.allow_bluetooth` + 选口/证据标注 + 元数据 + UI 提示 + 测试
- [ ] P2.3：`examples/ESP32S31_Wave` 叠加 SPP（`esp_spp` acceptor + coex）+ 实机四链路验收
- [ ] P2.3（备选）：`bleio.py` + `KINDS += ble` + NUS + 假后端测试（不阻塞 P2 退出）
- [ ] C0：`canio.py`（virtual/slcan）+ `canmon.py` + `/api/can/*` + 工具 + UI
- [ ] C0：`examples/STM32F103C8T6_CAN` 可编译 + loopback 自测 + `projects/...yaml`
- [ ] C1：适配器/接线/120Ω/500k 第一关 + `elab can doctor`
- [ ] C2：`canopen.py` NMT/Heartbeat/SDO expedited + 虚拟节点测试
- [ ] C2：PDO/EMCY/EDS + 真实节点验收
- [ ] 教程：`docs/tutorials/09-协议上手_Modbus_CANopen_BLE.md` + `assets/protocol/` 实机截图
- [ ] 文档同步：`docs/README.md`、串口教程、`elab-tools` 索引、CHANGELOG
- [ ] 若启用 `templates/canopen/**`，同步 `AGENTS.md` 的数据层表（协议模板，不是芯片包）
