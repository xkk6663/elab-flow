# 执行计划：Modbus 学习计划（RTU 主站 + F103 教学从站 + 实机教程）

> 定位：把串口调试从「看 hex」升级为「看寄存器、看事务、看波形」。
> 本文只做计划，不写实现。
>
> **范围锁定（2026-11-06）**
>
> - 只做 **Modbus RTU 主站（Master / client）**；
> - 不做 Modbus TCP（MBAP）、不做内核从站模式、不做多主站；
> - 从站只以 **`examples/STM32F103C8T6_Modbus` 教学固件**存在，同时作为主站验收夹具；
> - 实机教程只写 Modbus 一篇，CAN / 蓝牙在
>   [拓展协议学习计划](执行计划_拓展协议学习计划_CAN基础与蓝牙SPP.md) 中单独记录；
> - 分层边界不变：业务逻辑只进 `services/elab/**` 与 `cockpit/server.py`；
>   插件只改 `packages/dsh-elab-cockpit/**`；芯片知识只住 `packs/**`；固件只进 `examples/**`；
>   内核仅标准库，不引入第三方依赖。
>
> **状态**：决策已对齐，待实施。

---

## 1. 结论

1. **Modbus 是当前唯一“投入产出比确定”的协议增量**：现有 `crc16modbus` 已可解 RTU 帧，
   缺的只是事务层与寄存器语义，不需要等通用帧协议补强。
2. **主站挂在现有串口会话上**，复用 `_Session` 的读线程、字节环与写锁，保持单写者契约；
   不另开端口、不复制读线程。
3. **寄存器映射是这一层的核心数据结构**：地址基准、类型、字序、缩放、单位、可写性、
   是否入波形，全部声明在工程 YAML 中，Agent 与 UI 读同一份。
4. **教学从站不是附属品，是验收夹具**：没有它，主站只能靠假传输自证；有了它，
   FC03/FC06/FC10、异常码、超时重试都能在真实串口上闭环。
5. **实机教程是交付物的一部分**：每一步留下截图与判据，避免“功能写完但没有证据”。
6. **不做协议栈扩张**：Modbus TCP、内核从站、从机模式都不在本计划内；
   它们会改变“开发工具”的定位。

---

## 2. 现状盘点（源码事实）

### 2.1 传输与会话

| 位置 | 事实 |
|---|---|
| [serialtransport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialtransport.py#L26-L27) | `KINDS = ("serial", *NET_KINDS)`；传输白名单在此收敛 |
| [serialtransport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialtransport.py#L56-L100) | `resolve()`：显式 → 工程 `serial.*` → 宿主 → 默认 |
| [serialtransport.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialtransport.py#L103-L115) | `open()`：serial 走 `SerialIO`，TCP/UDP 走 `netio.open_net` |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L123) | `_Session` 是唯一的串口会话实现（单写者） |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L225-L231) | 读线程 `_start_reader` |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L459-L486) | `_push_chunk`：字节环、速率事件、录制、RX 解码的唯一入口 |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L693-L703) | 会话写入入口 `write`；对外 `write_through` |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L842-L970) | `open_session`：解码器校验、传输解析、幂等复用 |

**接线结论**：Modbus 引擎只依赖 `_Session.write` 与 `_push_chunk` 的 RX 流；
不直接持有端口、不启动自己的读线程。

### 2.2 CRC 与帧解码

| 位置 | 事实 |
|---|---|
| [serialcodec.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialcodec.py#L97) | 已有 `crc16modbus(data)`，参数为 `poly=0xA001`、`init=0xFFFF`、无最终异或 |
| [serialframes.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialframes.py#L38-L39) | `CHECKS` 已包含 `crc16modbus` 及通用 `crc16` 预设 |
| [serialcodec.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialcodec.py#L231-L439) | `_decode_profile`：head/length/tail 切帧、variant 分发、校验 |
| [serialcodec.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialcodec.py#L636-L785) | `encode()` / `_encode`：反向组帧、变长反算、校验写入 |

**结论**：Modbus RTU 的 CRC 不需要新实现；主站自己的 PDU 编解码仍应独立在
`modbus.py`，不要复用帧 profile 的通用解码路径（保持协议语义清晰）。

### 2.3 HTTP / 插件 / 前端 / 测试

| 位置 | 事实 |
|---|---|
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L95-L255) | `SERIAL_META`：视图、格式、解码器、frames schema、features、transports |
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L1727-L1819) | 串口 GET 端点集中区 |
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L2010-L2451) | 串口 POST 端点集中区 |
| [tools.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/domain/tools.ts) | `elab_serial*` 与 `elab_frame_profile` 工具的**契约**（v4.0.0 起已上移到 domain 层）；实现见 `src/adapters/dsh-tools/serial-ops.ts` / `frame-ops.ts` |
| [routes.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/kernel-http/routes.ts#L76-L125) | 插件 HTTP 白名单；新增端点必须登记 |
| [SerialWorkspace.tsx](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/web/src/serial/SerialWorkspace.tsx#L67-L74) | 四视图：lines / bytes / terminal / wave |
| [icd.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/cockpit-ui-core/src/icd.ts#L242-L270) | `SerialMeta`、`SerialChunk`、`SerialDecodeResult` 等共享类型 |
| `tests/test_serial*.py` | 串口相关 8 个测试文件，全部走假传输 |
| `packages/dsh-elab-cockpit/test/` | 插件测试与 `boundary.test.mjs` 分层门禁 |

**缺口**：仓库内没有任何 Modbus 事务层、寄存器表、`MODBUS_*` 元数据或教学从站。

---

## 3. 目标与非目标

### 3.1 目标

1. 主站能对真实从站完成 FC03/FC06/FC10，并能正确上报异常码。
2. 支持轮询组、超时重试、失败退避，错误不拖死读线程。
3. 寄存器映射声明化，支持类型、字序、缩放、单位、枚举、可写性与波形。
4. Agent 能通过工具读寄存器、写寄存器、起停轮询、查事务与错误。
5. 前端有 Modbus 视图，与原始字节视图可切换。
6. 教学从站可编译、可烧录、可被主站稳定读写，并通过 C36 第一关。
7. 实机教程完整记录接线、烧录、读写、异常、波形与 Agent 操作。

### 3.2 非目标

- 不做 Modbus TCP（MBAP）、不做网关、不做多主站并发。
- 不做内核从站模式；从站只存在于教学固件。
- 不做从机地址扫描、不做自动拓扑发现。
- 不做 Modbus ASCII。
- 不引入 `pymodbus` 等第三方库，不自动 `pip install`。
- 不把厂商寄存器表写进内核；寄存器表是工程数据。

---

## 4. 总体架构

```text
驾驶舱 / Agent
      │  HTTP: /api/modbus/*        elab_modbus
      ▼
Modbus 主站引擎（modbusmaster）
      │  事务队列 / 轮询组 / 匹配 / 超时重试
      ▼
serialmon._Session（单写者、字节环、读线程）
      │  write()
      ▼
串口 / USB-TTL ──────► STM32F103C8T6 教学从站
      ▲
      │  _push_chunk()（RX 字节）
      └── 事务匹配与寄存器快照
```

### 4.1 新增模块（全部在业务层）

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `services/elab/modbus.py` | PDU 编解码、功能码、异常码、CRC、寄存器类型转换 | 不做 IO、不认识会话 |
| `services/elab/modbusmaster.py` | 事务匹配、超时重试、轮询组、寄存器快照、错误统计 | 不持有端口、不重复读线程 |
| `cockpit/server.py` | `MODBUS_META`、`/api/modbus/*`、`SERIAL_META.features` 标注 | 不写协议细节 |
| `packages/dsh-elab-cockpit/**` | `elab_modbus` 工具、路由白名单、类型 | 不 import 内核源码 |
| `cockpit/web/src/serial/**` | Modbus 视图与寄存器表 | 不改会话契约 |
| `examples/STM32F103C8T6_Modbus/**` | 教学从站固件 | 不含主站逻辑 |
| `projects/STM32F103C8T6_Modbus.yaml` | 工程绑定、串口参数、寄存器映射 | 不写芯片知识 |

---

## 5. Modbus RTU 主站方案

### 5.1 能力范围

- 功能码：`0x01/0x02` 读位、`0x03/0x04` 读寄存器、`0x05/0x06` 写单个、
  `0x0F/0x10` 写多个；异常码原样上报。
- 地址：从站 `1–247`；`0` 仅广播写，不应答。
- 约束：单帧 ≤ 256 字节；`03/04` 单次 ≤ 125 寄存器；`01/02` 单次 ≤ 2000 位；
  `10` 单次 ≤ 123 寄存器；`0F` 单次 ≤ 1968 位。
- 字节序：寄存器内部高字节先；32 位值跨两个寄存器，字序可配 `big/little`。

### 5.2 寄存器映射（工程数据）

```yaml
modbus:
  unit_id: 1
  timeout_ms: 120
  retries: 2
  points:
    - name: temperature
      fc: 3
      address: 0
      type: u16
      scale: 0.1
      unit: "°C"
      writable: false
      plot: true
    - name: runtime_counter
      fc: 3
      address: 0x20
      type: u32
      word_order: big
      writable: false
      plot: false
    - name: led
      fc: 1
      address: 0
      type: bit
      writable: true
```

规则：

- `address` 一律是**协议偏移（0 基）**；厂商手册的 `40001`/`30001` 只在文档里换算，
  不进入内核。
- `type` 支持 `bit/u16/s16/u32/s32/f32`；`f32` 必须显式 `word_order`。
- `scale`/`bias` 只影响展示值与波形，不改变线上原始值。
- `enum` 可选，用于状态码显示。
- 写点必须显式 `writable: true`；轮询默认只读。

### 5.3 事务引擎

- **单飞行事务**：同一会话同一时刻只有一个未完成请求；队列按优先级/轮询顺序出队。
- **匹配规则**：unit id、功能码、响应长度、地址/数量回显；广播写不等待响应。
- **超时与重试**：`timeout_ms` 到期重发，最多 `retries` 次；仍失败则标记该点错误并退避。
- **轮询组**：每组独立 `interval_ms` 与点集合；单点失败不阻塞整组，连续失败指数退避到上限。
- **写优先**：手动写请求插队到轮询之前，写完成后恢复轮询。
- **线程模型**：引擎独立调度线程，只通过 `_Session.write` 发送、通过
  `_push_chunk` 喂入 RX；引擎异常只落状态，不抛出到读线程。
- **关闭语义**：会话关闭/切换端口时停止引擎、清空在途事务、保留最后一次错误原因。

### 5.4 错误分类

| 类别 | 判定 | 上报字段 |
|---|---|---|
| `timeout` | 超过 `timeout_ms` 无完整响应 | `last_error=timeout`，计数 +1 |
| `crc` | CRC 校验失败 | `last_error=crc`，原始帧保留 |
| `exception` | 功能码高位为 1 | `exception_code`（01/02/03/04/06…） |
| `malformed` | 长度/功能码/地址回显不符 | `last_error=malformed` |
| `port` | 会话写入失败或端口断开 | `last_error=port`，停轮询 |

统计至少包含：`tx`、`rx`、`timeout`、`crc`、`exception`、`retry`、`last_ok_ms`。

### 5.5 HTTP 与自描述

`MODBUS_META` 与 `SERIAL_META.features` 增加：

- `modbus_rtu`、`modbus_poll`、`modbus_map`、`modbus_write`。

端点（全部登记到插件 `routes.ts` 白名单）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/modbus/meta` | 能力、功能码、类型、限制、错误码 |
| POST | `/api/modbus/open` | 绑定会话与 `unit_id/timeout/retries` |
| POST | `/api/modbus/start` | 启动轮询组 |
| POST | `/api/modbus/stop` | 停止轮询 |
| POST | `/api/modbus/read` | 一次性读（fc/address/count） |
| POST | `/api/modbus/write` | 一次性写（单值/多值/广播） |
| GET | `/api/modbus/map` | 读取当前映射 |
| POST | `/api/modbus/map` | 保存映射（`rev` 乐观锁） |
| GET | `/api/modbus/transactions` | 事务环 |
| GET | `/api/modbus/stats` | 计数与最后错误 |

`open` 必须复用 `open_session` 的端口互斥；同一端口已作为普通串口打开时，
返回明确的“已被占用”错误，不静默抢占。

### 5.6 Agent 工具

新增 `elab_modbus`，动作：

`status / map_get / map_save / read / write / poll_start / poll_stop / transactions / stats`

- 写操作受 `allowAgentWrite` 与 `rev` 双重约束。
- 返回值包含原始请求帧、原始响应帧、解析值与错误原因，便于 Agent 自证。
- 不提供“猜测寄存器含义”的隐式行为；含义来自映射。

### 5.7 前端 Modbus 视图

- 与四视图并列，新增 `modbus`；原始字节视图仍可切换。
- 寄存器表：名称、地址、类型、原始值、缩放值、单位、更新时间、错误标记。
- 轮询配置：组、间隔、启用、点选择。
- 事务日志：请求/响应帧、耗时、重试、异常码。
- 波形：复用现有 wave 面板，数据源为映射点（`plot: true`）。
- 所有写操作走确认与 `rev`，失败展示内核错误原文。

### 5.8 测试

- `tests/test_modbus.py`：PDU 金向量、CRC、异常码、边界数量、字序、类型转换。
- `tests/test_modbusmaster.py`：假传输下的事务匹配、超时、重试、广播、退避、
  端口关闭、引擎异常隔离。
- 覆盖旧串口测试，确保新增 hooks 不改变现有解码/字节视图行为。
- 插件侧：`elab_modbus` 参数校验、只读/可写权限、错误透传。

---

## 6. F103 Modbus 教学从站

### 6.1 工程与固件

- 目录：`examples/STM32F103C8T6_Modbus/`
- 工程：`projects/STM32F103C8T6_Modbus.yaml`
- 串口：`USART1` = Modbus RTU，`115200 8N1`，从站地址 `1`
- 调试口：`USART2` = `[alive]` 心跳日志（**不要与 Modbus 共用同一 UART**）
- LED：`PC13`，低电平点亮，500 ms 翻转

### 6.2 寄存器表（教学用，固定）

| 区域 | 地址 | 类型 | 权限 | 含义 |
|---|---|---|---|---|
| Holding | `0x0000` | u16 | RO | 设备 ID |
| Holding | `0x0001` | u16 | RO | 固件版本 |
| Holding | `0x0002` | u16 | RO | tick 低 16 位（1 Hz） |
| Holding | `0x0003` | u16 | RO | toggles（每次心跳 +2） |
| Holding | `0x0004` | u16 | RO | stage |
| Holding | `0x0010` | u16 | RW | LED 控制（1=亮） |
| Holding | `0x0020–0x0021` | u32 | RO | 运行计数器（字序测试） |
| Holding | `0x0030–0x0031` | f32 | RO | 模拟温度（缩放测试） |
| Coils | `0x0000–0x0003` | bit | RW | 测试线圈 |
| Discrete Inputs | `0x0000` | bit | RO | 按键状态 |

### 6.3 协议行为

- 必做功能码：`03`、`06`、`10`；建议同时做 `01`、`05`、`0F`。
- 异常码：未知功能码 `01`、地址越界 `02`、数量/值非法 `03`。
- 帧边界：UART IDLE 中断 + 定时器判定 **3.5 字符静默**，不靠阻塞延时。
- CRC 错误：丢弃且不应答；unit id 不匹配：不应答；广播写：执行但不应答。
- 主循环禁止 `HAL_Delay` 忙等；心跳、LED、Modbus 轮询都用 SysTick 计数。

### 6.4 第一关（C36）适配说明

Modbus 从站占用了 USART1，心跳日志必须走 **USART2**，避免日志字节污染 Modbus 帧：

- Agent 从 USART2 抓 `[alive] tick=… toggles=… stage=…`，判定间隔 ≈1.000 s、
  `toggles` 严格 +2；
- 同时通过 FC03 读 `0x0002/0x0003` 交叉验证；
- LED 是否均匀闪烁必须由用户肉眼确认后回报，Agent 不得只凭计数宣布通过。

### 6.5 验收

- `elab build` / `elab flash` 通过；
- 心跳日志与寄存器读数一致；
- 主站 FC03 连续读 100 次无超时；
- FC06/FC10 写入后回读一致；
- 越界地址返回异常码 `02`；
- 拔掉从站后主站进入 `timeout` 并按配置重试；
- 原始字节视图仍能同时看到请求/响应帧。

---

## 7. 实机教程

文件：`docs/tutorials/09-协议上手_Modbus.md`
截图：`docs/tutorials/assets/protocol/modbus/`

大纲：

1. 目标与前置（硬件、接线、工具版本）
2. 接线：USB-TTL 两路（Modbus + 调试口）、共地、避免 USB 与 CAN 引脚冲突说明
3. 编译与烧录教学从站
4. 第一关：USART2 心跳 + LED 人工确认
5. 建立 Modbus 会话与寄存器映射
6. FC03 读、FC06 写、FC10 批量写
7. 异常演示：错 unit、越界地址、拔线超时
8. 波形与事务日志
9. Agent 用 `elab_modbus` 完成一次读写
10. 证据清单与常见排错

截图清单（实拍后补齐）：

`01-wiring`、`02-heartbeat`、`03-flash`、`04-map`、`05-read`、
`06-write`、`07-exception`、`08-wave`、`09-transactions`、`10-agent`

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| CRC 高低字节发反 | 从站全部丢帧 | 金向量固定测试；线上字节与抓包对照 |
| 厂商地址基准混淆 | 读写错位 | 映射只存 0 基偏移；教程给换算表 |
| 32 位字序不一致 | 数值离谱 | `word_order` 显式必填；教学固件提供 u32 测试点 |
| 3.5 字符判定不稳 | 从站切帧错误 | IDLE + 定时器；固定 115200；抓包验证 |
| 半双工/回显 | 事务错配 | 匹配 unit+fc+长度+回显；必要时过滤本地回显 |
| 轮询失败风暴 | 总线拥塞、日志膨胀 | 单飞行 + 指数退避 + 上限 |
| 引擎异常拖死读线程 | 串口假死 | 引擎独立线程；异常只落状态 |
| 端口被普通串口占用 | 无法打开 | 复用 `open_session` 幂等与互斥；明确报错 |
| 心跳日志污染 Modbus | 从站不应答 | 双 UART：USART1 Modbus / USART2 日志 |

---

## 9. 决策记录

- **D1**：只做 Master + RTU；Modbus TCP 与内核从站模式明确不做。
- **D2**：主站挂在 `serialmon._Session` 上，不新开端口、不复制读线程。
- **D3**：寄存器映射是工程数据，不写进内核或芯片包。
- **D4**：`address` 一律 0 基；文档负责厂商编号换算。
- **D5**：教学从站同时是验收夹具，寄存器表固定、可复现。
- **D6**：心跳日志走独立 UART，绝不与 Modbus 共用。
- **D7**：不引入第三方 Modbus 库；PDU 编解码自持。
- **D8**：旧串口行为不变；Modbus 是新增视图与新增端点，不替换四视图。

---

## 10. 执行清单

### M0 契约与金向量

- [ ] 定稿 `MODBUS_META`：功能码、类型、限制、异常码、错误分类。
- [ ] 写 PDU 金向量（请求/响应/异常/广播/边界数量）。
- [ ] 定稿映射 YAML schema 与 `rev` 语义。

### M1 协议层

- [ ] `modbus.py`：PDU 编解码、异常码、CRC、类型与字序转换。
- [ ] `tests/test_modbus.py` 全绿。

### M2 主站引擎

- [ ] `modbusmaster.py`：队列、单飞行、匹配、超时重试、轮询组、退避、统计。
- [ ] 挂接 `_Session.write` 与 `_push_chunk`；关闭语义。
- [ ] `tests/test_modbusmaster.py` 假传输全绿。

### M3 接口与面板

- [ ] `cockpit/server.py`：`MODBUS_META`、10 个端点、`features` 标注。
- [ ] 插件：`elab_modbus`、`routes.ts` 白名单、类型定义。
- [ ] 前端：Modbus 视图、寄存器表、轮询配置、事务日志、波形数据源。
- [ ] 端口互斥与 `rev` 写保护验证。

### M4 教学从站

- [ ] `examples/STM32F103C8T6_Modbus` 固件与 `projects` 工程。
- [ ] FC03/06/10 + 异常码 + 3.5 字符 + 双 UART 心跳 + LED。
- [ ] 编译、烧录、心跳、寄存器读写、异常、拔线超时全部实机通过。

### M5 教程与证据

- [ ] `docs/tutorials/09-协议上手_Modbus.md` 与截图。
- [ ] `docs/README.md` 登记；CHANGELOG 记录。
- [ ] 教程中的每条判据都能在仓库内复现。
