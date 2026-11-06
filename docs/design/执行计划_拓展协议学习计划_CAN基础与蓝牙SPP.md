# 执行计划：拓展协议学习计划（CAN 2.0A/B 基础 + 蓝牙 Classic SPP）

> 定位：在 Modbus 之后补齐两条「调试通道」——一条是有线现场总线 CAN，
> 一条是无线串口 Classic SPP。
> 本文只做计划，不写实现。
>
> **范围锁定（2026-11-06）**
>
> - CAN 只做到 **C1：CAN 2.0A/B 基础 + SLCAN 硬件闭环**；
>   原 C0（虚拟总线）不再是独立阶段，折入 C1 作为前置与测试夹具；
> - 蓝牙只做 **Classic SPP**，叠加在现有 `examples/ESP32S31_Wave`，不新建示例；
> - **不做**：CANopen（C2）、CAN FD、DBC 导入、节点仿真、BLE NUS、
>   多通道适配器、Modbus TCP、内核从站模式；
> - 分层边界不变：业务逻辑只进 `services/elab/**` 与 `cockpit/server.py`；
>   插件只改 `packages/dsh-elab-cockpit/**`；芯片知识只住 `packs/**`；
>   固件只进 `examples/**`；内核仅标准库，不引入 `python-can` / `bleak`。
>
> **状态**：决策已对齐，待实施；CAN 硬件到位是 C1 的启动门槛。

---

## 1. 结论

1. **CAN 的用户价值在 C1，不在 C0。** 虚拟总线只能证明编解码与会话模型自洽，
   不能证明“能调真实总线”；它只作为前置与单测夹具，不作为独立成果汇报。
2. **CAN 基础对嵌入式调试是高频需求**（电机、车载、工业板卡），值得做；
   但必须先有适配器 + 收发器，否则容易写成“没人用、也没证据”的代码。
3. **SLCAN 是唯一符合当前内核约束的适配器类型**：虚拟 COM + 纯标准库；
   PCAN/Kvaser 等厂商原生 USB 需要额外后端，本轮不接。
4. **SPP 是传输增量，不是协议增量**：它只是把蓝牙虚拟 COM 纳入串口选口，
   协议能力零新增；价值在少一根线、隔离高压或封闭设备。
5. **SLCAN 参数锁定**：500 kbit/s、标准帧为主（29 位扩展帧保留接口）、
   终端电阻只在物理两端、共地、双绞线。
6. **SPP 优先、BLE 不做**：Windows 配对后是虚拟 COM，复用现有串口传输与四视图；
   BLE NUS 没有标准串口 profile，且会引入第三方依赖。
7. **不做协议栈扩张**：CANopen 的 NMT/SDO/PDO/EMCY/EDS 属于产品级协议栈，
   没有真实节点需求前不进入本计划。

---

## 2. 现状盘点（源码事实）

### 2.1 串口与传输

| 位置 | 事实 |
|---|---|
| [serialtransport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialtransport.py#L26-L27) | `KINDS = ("serial", *NET_KINDS)`；传输白名单在此收敛 |
| [serialtransport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialtransport.py#L56-L100) | `resolve()`：显式 → 工程 `serial.*` → 宿主 → 默认 |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L123) | `_Session` 是唯一的串口会话实现（单写者） |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L459-L486) | `_push_chunk`：字节环、速率事件、录制、RX 解码的唯一入口 |
| [serialport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialport.py#L32-L39) | 蓝牙标记 `BthModem` / `BTHMODEM` / `Bluetooth`；`kind` 排序 `usb > other > bluetooth` |
| [serialport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialport.py#L235-L251) | `auto` 默认排除蓝牙口；只有蓝牙时视为“没有可用串口” |

**结论**：SPP 不需要新传输栈，只需要放开选口规则并在元数据里标注 `kind=bluetooth`。

### 2.2 解码、HTTP、插件、前端

| 位置 | 事实 |
|---|---|
| [serialcodec.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialcodec.py#L231-L439) | 帧 profile 解码与编码；CAN 不复用它，避免语义混淆 |
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L95-L255) | `SERIAL_META`：视图、格式、解码器、features、transports |
| [routes.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/kernel-http/routes.ts#L76-L125) | 插件 HTTP 白名单；新增端点必须登记 |
| [SerialWorkspace.tsx](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/web/src/serial/SerialWorkspace.tsx#L67-L74) | 四视图：lines / bytes / terminal / wave |

### 2.3 CAN / BLE 现状

- 内核**无任何 CAN / CANopen / BLE 实现**。
- `tests/test_netio.py` 里只有 `socketcan` 作为“未知传输必须报错”的负例。
- 仓库没有 `pyproject.toml` / `requirements*.txt`；`pyserial` 是惰性可选后端。
- `examples/ESP32S31_Wave` 已有 USB / TCP / UDP 三条链路；SPP 是第四条。

---

## 3. 目标与非目标

### 3.1 目标

1. CAN 基础：能打开 SLCAN 适配器，收帧、发帧、过滤、统计、录制。
2. CAN 教学工程：F103 能周期发送、接收过滤、错误计数可见，可完成 C1 闭环。
3. 前端有最小 CAN 工作区：帧表、过滤、发送、统计，不追求 CANopen 节点面板。
4. SPP：Windows 配对后虚拟 COM 能被显式与 auto 选中，四视图与 Agent 工具照常工作。
5. 固件：`ESP32S31_Wave` 叠加 SPP，与 Wi-Fi TCP/UDP 共存，不新建示例。
6. 所有能力可自描述，插件与 Agent 自动跟随。

### 3.2 非目标

- 不做 CANopen（NMT/Heartbeat/SDO/PDO/EMCY/EDS）。
- 不做 CAN FD、DBC 导入、CAN 节点仿真、总线负载仿真。
- 不做 BLE NUS / GATT 串口。
- 不做 SocketCAN 后端（Linux 用户可先用 `slcand`，本轮不写）。
- 不做多通道适配器、双总线网关。
- 不引入 `python-can` / `bleak` / 蓝牙 SDK；不自动 `pip install`。
- 不改串口四视图契约；CAN 是新会话类型，SPP 只是串口的一种端口。

---

## 4. CAN 2.0A/B 基础（C1）

### 4.1 学习目标（C1 要能回答的问题）

- 标准帧与扩展帧的 ID 范围与仲裁差异；
- 数据帧/远程帧/错误帧/过载帧的区别；
- ACK 机制：为什么单节点发送会失败；
- 位时序与采样点：500 kbit/s、87.5% 怎么配；
- 终端电阻与总线拓扑：为什么两端各 120Ω；
- 错误状态：error-active / error-passive / bus-off 与恢复；
- 过滤器：如何只收关心的 ID 段。

### 4.2 架构与模块（全部在业务层）

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `services/elab/canio.py` | `CanFrame` 模型、`virtual` / `slcan` 后端、SLCAN 纯编解码 | 不做轮询策略、不做 CANopen |
| `services/elab/canmon.py` | CAN 会话：帧环、过滤、TX、录制、统计、错误状态 | 不做协议语义 |
| `cockpit/server.py` | `CAN_META`、`/api/can/*` | 不写编解码细节 |
| `packages/dsh-elab-cockpit/**` | `elab_can_*` 工具、路由白名单、类型 | 不 import 内核源码 |
| `cockpit/web/src/can/**` | 最小 CAN 工作区 | 不做节点仿真 |
| `examples/STM32F103C8T6_CAN/**` | CAN 教学固件 | 不含 CANopen |
| `projects/STM32F103C8T6_CAN.yaml` | 工程绑定与 CAN 参数 | 不写芯片知识 |

### 4.3 原 C0 的处理（前置，不是成果）

C0 只保留三件事，且全部服务于 C1：

1. `virtual` 后端：无硬件时跑会话/过滤/统计的单测；
2. SLCAN 编解码金向量：`t/r/T/R` 帧、扩展帧、错误帧、时间戳；
3. 会话模型验证：帧环上限、过滤、TX 队列、关闭语义。

不建独立 UI、不对外宣称“CAN 已支持”；C1 硬件通过后才算交付。

### 4.4 数据模型与接口

`CanFrame`：

```text
id          29 位以内
extended    bool
rtr         bool
dlc         0..8（CAN 2.0）
data        bytes
timestamp_ns
direction   rx | tx
channel     预留
```

`CAN_META` 声明：后端（`slcan` / `virtual`）、位率、采样点、过滤器 schema、
帧上限、错误计数、录制格式。

端点（登记到 `routes.ts` 白名单）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/can/meta` | 能力与参数 |
| POST | `/api/can/open` | 打开 SLCAN / virtual |
| POST | `/api/can/close` | 关闭会话 |
| GET | `/api/can/frames` | 帧环（增量拉取） |
| POST | `/api/can/send` | 发送单帧/周期帧 |
| POST | `/api/can/filter` | 设置过滤器 |
| GET | `/api/can/stats` | 收/发/丢弃/错误计数 |
| POST | `/api/can/capture` | 开始/停止录制 |

Agent 工具：`elab_can_status / open / close / frames / send / filter / stats / capture`。
写操作沿用 `allowAgentWrite`；发送周期帧必须显式停止。

### 4.5 F103 CAN 教学固件

- 目录：`examples/STM32F103C8T6_CAN/`；工程：`projects/STM32F103C8T6_CAN.yaml`。
- 引脚：`PA11=CAN_RX / PA12=CAN_TX`，或重映射 `PB8=CAN_RX / PB9=CAN_TX`。
  **Blue Pill 的 PA11/PA12 与 USB 复用**，若 USB 串口在用必须改重映射或换板。
- 收发器：`SN65HVD230`（3.3 V，首选）；`TJA1050` 是 5 V 逻辑，
  3.3 V MCU 驱动 TXD 可能不足，必须电平转换或换 3.3 V 收发器。
- 位时序：APB1 = 36 MHz 时，`prescaler=9`、`BS1=6`、`BS2=1`、`SJW=1`
  → 8 tq、500 kbit/s、采样点 87.5%。
- 行为：
  - 上电先 **loopback 自检**（不发总线），再切 normal；
  - 周期发送标准帧（ID `0x123`，计数器 + 心跳位）；
  - 接收过滤（例如只收 `0x100–0x1FF`），收到后回发一帧；
  - 统计 `tx/rx/error_warning/error_passive/bus_off`；
  - `bus-off` 后自动恢复并记录次数；
  - 主循环禁止 `HAL_Delay` 忙等。
- 第一关适配：CAN 节点仍用 **USART2** 输出 `[alive]` 心跳，LED（PC13，低电平点亮）
  500 ms 翻转；Agent 看心跳，用户看灯。

### 4.6 硬件选型与接线（C1 前置检查）

| 部件 | 建议 | 注意 |
|---|---|---|
| USB-CAN 适配器 | SLCAN 单通道（CANable 2.0 / candleLight，slcan 固件） | 必须枚举为虚拟 COM；带 120Ω 开关；隔离版优先用于高压场景 |
| 板侧收发器 | SN65HVD230 3.3 V 模块 | TJA1050 是 5 V 逻辑，勿直连 3.3 V MCU |
| 总线 | 双绞线，CANH–CANH、CANL–CANL | 不要星形；500 kbit/s 下支线尽量短 |
| 终端电阻 | 物理两端各 120Ω | 中间节点不装；模块自带 120Ω 要确认 |
| 共地 | 适配器 GND ↔ 板 GND | 先共地再上电 |
| DB9 引脚 | `2=CAN_L`、`7=CAN_H`、`3=CAN_GND` | 不要按 RS-232 习惯接 |

### 4.7 学习路径与证据（C1）

| 阶段 | 做什么 | 判据 |
|---|---|---|
| L0 虚拟 | 单测：帧环、过滤、SLCAN 金向量 | 全绿，无硬件 |
| L1 适配器自检 | 适配器自环/只听，确认 COM 与驱动 | 能打开、能收自发帧 |
| L2 单板闭环 | F103 + 收发器 + 适配器，单节点发送 | 适配器收到、ACK 正常 |
| L3 双节点 | 再加一个节点或第二适配器 | 过滤、周期发送、双向收发 |
| L4 异常 | 拔线、错位率、少终端电阻 | error 计数上升、bus-off 可恢复 |
| L5 记录 | 抓包、统计、截图 | 证据可复现，写入验收记录 |

### 4.8 测试与验收

- `tests/test_canio.py`：`CanFrame`、SLCAN 编解码、扩展帧/RTR、错误输入。
- `tests/test_canmon.py`：虚拟后端的帧环、过滤、TX、录制、关闭语义。
- 插件：`elab_can_*` 参数校验、写权限、错误透传。
- 实机验收：500 kbit/s 连续收发 10 分钟无丢帧异常；过滤生效；bus-off 恢复；
  原始帧与统计同屏；端口关闭后可重新打开。

### 4.9 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 无适配器/收发器 | 只能验证代码，无法证明总线 | 硬件到位才启动 C1；L0 只做单测 |
| 5 V 收发器直连 3.3 V MCU | 时好时坏 | 选 SN65HVD230 或加电平转换 |
| 终端电阻数量错 | 通信不稳/反射 | 只装两端；模块电阻可断开 |
| PA11/PA12 与 USB 冲突 | CAN 或 USB 其一失效 | 改 PB8/PB9 重映射或换板 |
| 位率/采样点不一致 | 随机错误帧 | 固定 500k/87.5%，双端一致 |
| SLCAN 适配器固件差异 | 帧格式/时间戳不一致 | 金向量覆盖；只支持标准 SLCAN |
| CAN 会话复用串口模型 | 语义混乱 | CAN 独立 `CanSession`，不复用 `SerialIO` |

---

## 5. 蓝牙 Classic SPP

### 5.1 目标

- ESP32-S31 作为 SPP 服务端；Windows 配对后生成**传出虚拟 COM**；
- 该 COM 能被显式选择，也能在配置允许时被 `auto` 选中；
- 复用现有串口会话、四视图、录制、帧 profile 与 Agent 工具；
- `ESP32S31_Wave` 同时保留 USB / TCP / UDP，新增 SPP 为第四条链路。

### 5.2 内核改动

- 工程 YAML 新增 `serial.allow_bluetooth: true|false`，默认 `false`（保持现状）。
- `serialport.resolve()` 规则：
  1. 显式 `COMx`：允许，无论是否蓝牙；
  2. `auto` + `allow_bluetooth=false`：维持现状，排除蓝牙；
  3. `auto` + `allow_bluetooth=true`：蓝牙参与候选，但仍优先 USB；
  4. 多个同优先级候选：报歧义，让人选，不猜。
- 端口元数据保留 `kind=bluetooth`，前端显示 `COMx [bluetooth]`。
- `SERIAL_META` 增加 `allow_bluetooth` 字段与提示文案；不新增传输 kind。
- 打开失败时区分：配对未完成、COM 被占用、驱动缺失。

### 5.3 固件改动（叠加，不新建示例）

- 在 `examples/ESP32S31_Wave` 增加 SPP 服务端与一条 RX/TX 队列；
- 与 Wi-Fi TCP/UDP 共存，需要 ESP-IDF coex：
  `CONFIG_ESP_COEX_SW_COEXIST_ENABLE`（新版）/ `CONFIG_SW_COEXIST_ENABLE`（旧版），
  以本机 menuconfig 为准；
- SPP 只接受一个客户端；断连后重新可发现；
- 设备名固定、可配置；波特率参数仅用于兼容，SPP 本身不锁波特率；
- 四条链路共用同一套波形/帧协议数据源，不允许某条链路独占解析状态。

### 5.4 测试

- `serialport` 单测：蓝牙标记识别、`allow_bluetooth` 矩阵、显式蓝牙、
  多候选歧义、只有蓝牙时的提示。
- HTTP/插件：`SERIAL_META` 新字段、端口列表 `kind`、前端提示。
- 回归：默认 `false` 时行为与现状逐字一致。

### 5.5 验收

- Windows 配对成功，出现传出 COM；
- 显式选择该 COM 能打开并收到心跳；
- `allow_bluetooth=true` 时 `auto` 能选中（无 USB 竞争时）；
- 四链路同时在线：USB、TCP、UDP、SPP；
- 断开 SPP 后不影响其他三条链路；
- 关闭监视后端口释放，可重新配对连接。

### 5.6 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| Windows 配对/驱动差异 | COM 不出现或打不开 | 教程写清“传出端口”；失败分类提示 |
| Wi-Fi/BT coex 不稳 | 吞吐下降、断连 | 开启 coex；限制 SPP  MTU/队列；实测记录 |
| auto 选中蓝牙口 | 误连、无数据 | 默认排除；显式允许才参与 |
| SPP 延迟高 | 波形/轮询抖动 | 固定小帧、关闭 Nagle 类聚合；文档标注 |
| 蓝牙口被系统占用 | 打开失败 | 明确错误文案，不重试风暴 |
| BLE 需求混入 | 引入依赖、范围膨胀 | 本轮只做 SPP；BLE 单独立项 |

---

## 6. 教程与证据归档

本计划不新增独立教程文档；验收证据按以下方式归档，避免孤儿文件：

- CAN：抓包文本、统计截图、接线照片放入
  `docs/tutorials/assets/protocol/can/`，由本文件的验收章节引用；
- SPP：配对界面、端口列表、四链路灯图放入
  `docs/tutorials/assets/protocol/spp/`，同样由本文件引用；
- 若后续需要对外教程，再单独立项，不在本轮扩写。

---

## 7. 决策记录

- **E1**：CAN 只做到 C1；C0 折入前置与单测，不作为独立交付。
- **E2**：只支持 SLCAN + `virtual`；不做 SocketCAN、PCAN/Kvaser 厂商后端。
- **E3**：500 kbit/s、标准帧为主、扩展帧保留接口、两端 120Ω、共地。
- **E4**：CAN 使用独立 `CanSession`，不复用 `SerialIO` 或字节解码器。
- **E5**：SPP 是串口端口的一种，不新增 transport kind；默认不参与 auto。
- **E6**：SPP 叠加在 `ESP32S31_Wave`，不新建示例；四链路共存。
- **E7**：不做 CANopen、CAN FD、DBC、BLE NUS、多通道、Modbus TCP、内核从站。

---

## 8. 执行清单

### E0 前置与契约

- [ ] `CanFrame` / `CAN_META` / SLCAN 金向量定稿。
- [ ] `serial.allow_bluetooth` 语义与错误分类定稿。
- [ ] 确认硬件清单：SLCAN 适配器、SN65HVD230、F103 板、双绞线、120Ω。

### E1 CAN 代码层（无硬件）

- [ ] `canio.py`：`virtual` + `slcan` 后端、SLCAN 编解码。
- [ ] `canmon.py`：帧环、过滤、TX、录制、统计、关闭语义。
- [ ] `tests/test_canio.py` / `tests/test_canmon.py` 全绿。

### E2 CAN 接口与面板

- [ ] `cockpit/server.py`：`CAN_META` 与 `/api/can/*`。
- [ ] 插件：`elab_can_*`、`routes.ts` 白名单、类型。
- [ ] 前端：最小 CAN 工作区（帧表、过滤、发送、统计）。
- [ ] 端口/会话互斥与错误透传验证。

### E3 CAN 实机（C1）

- [ ] `examples/STM32F103C8T6_CAN` + `projects` 工程。
- [ ] loopback 自检、normal 收发、过滤、错误计数、bus-off 恢复。
- [ ] L1–L4 学习路径全部通过，证据归档。
- [ ] 500 kbit/s 连续收发 10 分钟验收。

### E4 蓝牙 SPP

- [ ] `serial.allow_bluetooth` 与选口矩阵、`kind=bluetooth` 元数据。
- [ ] `SERIAL_META` 新字段、前端 `COMx [bluetooth]` 提示。
- [ ] `ESP32S31_Wave` 叠加 SPP + coex 配置。
- [ ] Windows 配对、显式打开、auto 选中、四链路共存验收。

### E5 收尾

- [ ] `docs/README.md` 登记本文件与 Modbus 计划。
- [ ] CHANGELOG 记录版本落点。
- [ ] 确认未引入任何第三方依赖、未绕过分层门禁。
