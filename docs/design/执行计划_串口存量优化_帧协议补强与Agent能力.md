# 执行计划：串口存量优化（帧协议补强 + Agent 能力 + 观测与性能）

> 定位：**存量能力的打磨与补强** —— 不新增协议栈、不改会话契约，把现有
> 「串口字节流 + 声明式帧 profile」做到“私有协议只改 JSON 不改内核”、
> Agent 能学/能验/能自动选、帧级健康度可见、解码性能有基准。
>
> 本文是源码调研后的可执行方案，只做计划，不写实现。
> 姊妹文档：
> [执行计划_Modbus学习计划_RTU主站_F103从站_实机教程](执行计划_Modbus学习计划_RTU主站_F103从站_实机教程.md)
> 负责 Modbus RTU 主站、F103 教学从站与实机教程；
> [执行计划_拓展协议学习计划_CAN基础与蓝牙SPP](执行计划_拓展协议学习计划_CAN基础与蓝牙SPP.md)
> 负责 CAN 2.0A/B 基础（C1）与 Classic SPP。三份文档可独立实施。
>
> 编号沿用原“串口 P2/P4/P3”阶段计划：本文件保留 **P2.2 / P4 / P3**；
> P2.1（Modbus 主站）与 P2.3（蓝牙传输）已移入上述两份文档。
>
> **状态（2026-11-05）**：源码调研完成，决策已对齐，待实施。

---

## 1. 结论

1. **本文件只做存量优化**：通用帧协议补强、Agent 生产力、观测与性能；不新增 Modbus / CAN / 蓝牙传输栈。
2. **P2.2 是“私有二进制协议只改 JSON，不改内核”的关键**：校验声明化、转义、
   空闲分包、数组/字符串/位标志、重叠校验；这一块决定非 Modbus 的私有协议能不能低成本接进来。
3. **P4 做 Agent 生产力**：抓包学习 profile、round-trip 校验、单解码器自动匹配、C 结构体生成。
4. **P3 做观测与性能**：帧级统计、触发式录制、解码基准与热点优化。
5. **多协议并行不做**；自动识别只做“单解码器自动选择/推荐”，不改会话契约。
6. **兼容承诺**：所有扩展字段可选，旧 profile 的解码结果与保存形状逐字不变。
7. **分层边界不变**：业务逻辑只进 `services/elab/**` 与 `cockpit/server.py`；插件只改
   `packages/dsh-elab-cockpit/**`；协议模板仍只住 `templates/**`；本文件不新增第三方依赖。

---

## 2. 现状盘点（源码事实）

### 2.1 会话与解码

| 位置 | 事实 |
|---|---|
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L123) | `_Session` 是唯一的串口会话实现（单写者） |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L189-L199) | decoder 是**会话属性**（单值） |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L225-L231) | 读线程 `_start_reader` |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L459-L486) | `_push_chunk`：字节环、速率事件、录制、RX 解码的唯一入口 |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L489-L528) | `_decode_locked`：单解码器、半帧 pending、帧环 |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L70-L90) | 环上限：行 2000 / 字节 1 MiB / 块 4096 / 解码帧 1024 / pending 64 KiB |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L585-L618) | 现有 `rate_stats` 是字节/批次级，不是帧级 |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L693-L703) | 会话写入入口 `write`；对外 `write_through` |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L842-L970) | `open_session`：解码器校验、传输解析、幂等复用 |

**结论**：单解码器、单写者、`_push_chunk` 统一入口是既有契约；本文件的改动只能
**在这三个契约内加深**（错误分类、帧级统计、触发录制、空闲分包），不新增并行解码分支。

### 2.2 帧协议 schema 与编解码

| 位置 | 事实 |
|---|---|
| [serialframes.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialframes.py#L22-L38) | `MAX_PROFILES=32`、`MAX_FIELDS=64`、`MAX_FRAME=256`、`MAX_VARIANTS=16`；`CHECKS` 只有 3 种 |
| [serialframes.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialframes.py#L335-L437) | `normalize_profile`：保存时一次说清配置错误 |
| [serialcodec.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialcodec.py#L231-L439) | `_decode_profile`：head/length/tail 切帧、variant 分派、校验 |
| [serialcodec.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialcodec.py#L370-L402) | 校验范围固定：帧首到校验字节前，排除尾标记 |
| [serialcodec.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialcodec.py#L636-L785) | `encode()` / `_encode`：反向组帧、变长反算、校验写入 |

**结论**：位域/变长/多 ID 已落地；下一层的真实短板是**校验算法与覆盖范围、转义、
空闲分包、字段模型（数组/字符串/位标志）、重叠校验**。

### 2.3 HTTP / 插件 / 前端 / 测试

| 位置 | 事实 |
|---|---|
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L95-L255) | `SERIAL_META`：视图、格式、解码器、frames schema、features、transports |
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L1727-L1819) | GET：console/widgets/monitor bytes/decoded/control/log-profiles/frames/templates/issues |
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L2010-L2451) | POST：widgets/serial/control/monitor/frames/preview/encode/capture/decode |
| [tools.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/domain/tools.ts) | `elab_serial*` 与 `elab_frame_profile` 全部工具的**契约**（v4.0.0 起已上移到 domain 层）；实现见 `src/adapters/dsh-tools/serial-ops.ts` / `frame-ops.ts` |
| [routes.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/kernel-http/routes.ts#L76-L125) | 插件 HTTP 白名单；新增端点必须登记 |
| [SerialWorkspace.tsx](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/web/src/serial/SerialWorkspace.tsx#L67-L74) | 四视图：lines / bytes / terminal / wave |
| [icd.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/cockpit-ui-core/src/icd.ts#L242-L270) | `SerialMeta`、`SerialChunk`、`SerialDecodeResult` 等共享类型 |
| `tests/test_serial*.py` | 串口相关 8 个测试文件；`test_serialmon.py` 46 例、`test_serialframes.py` 36 例 |
| `packages/dsh-elab-cockpit/test/` | 17 个测试文件、135 例；边界门禁 `boundary.test.mjs` 7 例 |

### 2.4 依赖边界

- 内核**仅标准库**：`services/elab/_yaml.py` 明示零第三方；仓库没有 `pyproject.toml` / `requirements*.txt`。
- 本文件的 learn / verify / auto / codegen / 基准全部可在标准库内实现，**不新增依赖**。

---

## 3. 目标与非目标

### 3.1 目标

1. **P2.2**：通用帧协议能覆盖主流私有二进制协议；旧 profile 行为完全不变。
2. **P4**：Agent 能从抓包学习 profile、做 round-trip 校验、自动匹配单解码器、生成 C 结构体。
3. **P3**：帧级健康度可见；能按条件触发录制；解码性能有基准、有门槛。
4. **人机同源**：Agent 与人在同一份会话、同一份数据上工作；Agent 写操作仍受
   `allowAgentWrite` + `rev` 双重约束。

### 3.2 非目标

- **不做多协议并行解码**：一个会话仍只有一个活动解码器；自动识别只负责“选一个”。
- 不做任意 JS/Python 解码器插件执行；profile 仍是声明式 JSON。
- 不做 Modbus / CAN / 蓝牙传输（见姊妹文档）。
- 不新增第三方依赖；不自动 `pip install`、不自动改工程配置。
- 不改变 `_Session` 的单写者模型与 `_push_chunk` 的唯一 RX 入口语义。

---

## 4. 总体架构

```text
字节流（现有）           帧协议（现有 + 本文件补强）
serial / TCP / UDP      profile: head/length/variant + checksum/escape/idle_gap + fields
        │                        │
        └────────── serialmon._Session ──────────┐
                 （单写者、字节环、单解码器）      │
                                                  ▼
                                    帧环 / 帧级统计 / 触发录制
                                                  │
                                     HTTP /api/serial/* + elab_* 工具
                                                  │
                        Agent：learn（学 profile）/ verify（round-trip）
                                auto（选一个解码器）/ codegen（C 头文件）
```

### 4.1 改动落点

| 文件 | 职责 |
|---|---|
| `services/elab/serialframes.py` | schema 扩展、规整、重叠校验、`verify` 的输入校验 |
| `services/elab/serialcodec.py` | 校验声明化、转义、空闲分包配合、字段模型、encode 复用 |
| `services/elab/serialmon.py` | 空闲分包预处理、错误分类计数、帧级统计、触发录制 |
| `cockpit/server.py` | `SERIAL_META` schema/features、preview/encode/verify/stats/capture 端点 |
| `packages/dsh-elab-cockpit/**` | `elab_frame_profile` 扩展（verify/learn/auto/codegen）、`elab_serial_stats`、routes 白名单 |
| `cockpit/web/**` + `packages/cockpit-ui-core/**` | 帧抽屉新字段编辑、错误分类展示、健康度条、触发录制、共享类型 |
| `examples/STM32F103C8T6`（复用现有示例） | 作为三套真实协议回归的实机数据源之一（只发帧，不改协议逻辑） |

---

## 5. P2.2 通用帧协议补强

**目标**：私有二进制协议“只改 JSON，不改内核”。

### 5.1 A. 校验声明化

现有问题：`CHECKS` 只有 `sum8/xor8/crc16modbus`，范围固定为“帧首到校验字节前、排除尾标记”。

新增可选字段（旧 profile 缺省行为完全不变）：

```json
"checksum": {
  "kind": "crc16",
  "preset": "crc16_ccitt_false",
  "poly": 4129, "init": 65535, "xorout": 0,
  "refin": false, "refout": false,
  "size": 2, "endian": "le",
  "at": "tail",
  "offset": null,
  "cover": {"from": "after_head", "to": "before_checksum"}
}
```

- 预设：`crc8`、`crc8_maxim`、`crc16_ccitt_false`、`crc16_xmodem`、`crc32`；
  保留 `sum8/xor8/crc16modbus` 快捷写法。
- `cover` 支持 `payload` / `frame` / `{from,to}`；`from/to` 可用 `after_head`、
  `before_checksum`、`before_tail` 或绝对偏移。
- `offset` 解决“有帧头但校验不在帧首/尾”的协议；`at=head` 与 `head_hex` 的旧冲突
  由 `offset` 表达，不再报错。
- 解码/编码共用同一份校验实现，避免两套算法。

### 5.2 B. 转义 / 字节填充

```json
"escape": {
  "escape_byte": "0x7D",
  "xor": "0x20",
  "targets": ["0x7D", "0x7E"],
  "applies": "payload"
}
```

- `applies`: `payload`（默认，帧头/帧尾不转义）或 `frame`。
- 解码先反转义再切帧；编码先组帧再转义；校验在转义**之前**计算（与主流协议一致）。
- 支持常见 `0x7D/0x7E` 与自定义 `escape_byte/xor`。

### 5.3 C. 空闲分包与多帧头

```json
"frame": {
  "heads": ["AA55", "AA56"],
  "idle_gap_ms": 20,
  "max_bytes": 256
}
```

- `heads` 与 `head_hex` 互斥；多帧头按最长匹配优先。
- `idle_gap_ms`：由 `serialmon` 在喂给解码器前按时间戳切段；离线预览忽略该字段。
- 同步失败按原因计数：`no_head`、`bad_length`、`checksum`、`unknown_id`、`tail_mismatch`，
  不再只有一个 `skipped`。

### 5.4 D. 字段模型

- **数组/重复块**：`{"array": {"count": 4, "stride": 2}}`，展开为 `name[0..n-1]` 通道；
- **字符串**：`type: "str"` + `length` + `encoding: "utf-8"|"gbk"|"ascii"`；
- **f16**：`type: "f16"`；
- **位标志标签**：`bits: {"0":"READY","1":"FAULT"}`，记录里保留原始值并附带 flags 映射；
- **重叠校验**：保存时拒绝字段字节区间重叠（位域按 bit 区间算）；
  确需别名/联合体时在 profile 上显式 `"allow_overlap": true`。

### 5.5 E. 编码与自检

- `encode` 使用新的校验/转义实现；
- 新增 `verify(profile, vectors)`：decode → encode → decode 的 round-trip 对比（P4.2 复用）；
- Agent 工具 `elab_frame_profile` 增加 `verify`。

### 5.6 改动点与验收

**改动点**：`serialframes.py`（schema/规整/重叠校验）、`serialcodec.py`（校验/转义/切帧/字段）、
`serialmon.py`（空闲分包、错误分类计数）、`server.py`（SERIAL_META schema/features/端点）、
前端帧协议抽屉（新增字段编辑与错误展示）。

**验收**

1. 至少三套真实协议通过：Modbus RTU、DL/T 645、一个带转义或空闲分包的私有协议；
2. 旧 profile 的解码结果与保存形状不变（回归测试必须逐字对比）；
3. 随机字节 fuzz：不崩溃、pending 有界、错误分类合理；
4. round-trip 对模板与实机抓包全部通过。

> Modbus RTU 在本文件只作为**帧协议回归样本**（声明式 `crc16modbus` 声明），
> 主站事务层不在这里，见姊妹文档 P2.1。

---

## 6. P4：Agent 生产力

### 6.1 P4.1 抓包学习 profile（`learn`）

**输入**：一段抓包（JSONL 录制或 hex/base64 字节）+ 可选提示（期望字段名、候选帧头）。

**输出**：**草稿 profile（不落盘）** + 置信度 + 证据：

```json
{
  "ok": true,
  "draft": {"id": "learned_1", "frame": {...}, "fields": [...]},
  "confidence": 0.86,
  "evidence": [
    "0xAA55 在 120 帧中重复出现，间隔稳定 14 字节",
    "offset 2 的 u16 与总长满足 total = raw + 2",
    "crc16modbus 在末尾 2 字节通过率 100%"
  ],
  "warnings": ["字段语义无法推断，已按 offset/type 命名"]
}
```

**推断顺序**：帧头候选（重复 n-gram）→ 定长/变长（长度字段相关性）→ 校验（预设逐一试）
→ id 字段（低基数、稳定位置）→ 字段切分（类型/字节对齐）→ 生成草稿。

**约束**：只产出声明式草稿；保存仍走 `save`（`rev` + `allowAgentWrite`）；不执行任意代码。

### 6.2 P4.2 round-trip 校验（`verify`）

- 对 profile 执行“抓包解码 → 字段重编码 → 再解码”，逐帧比较字段值；
- 输出通过率、失败样本、失败原因（校验/长度/转义/类型越界）；
- 同时支持模板自带向量和用户提供的抓包。

### 6.3 P4.3 单解码器自动匹配（`auto`）

- `decoder: "auto"`：在工程 profile 集合上打分（帧头命中、长度合法、校验通过率、
  variant 命中率），选一个最优并**固定**为会话解码器；
- 返回 `auto` 明细：候选、分数、证据；低于阈值时保持 `none`，不猜；
- 不做并行解码；不做跨工程猜测；
- UI 显示“自动匹配：`hw_telemetry` 98%”，允许一键改回手动。

### 6.4 P4.4 C 代码生成（`codegen`）

- 从 profile 生成：字段偏移表、`#pragma pack` 结构体、encode/decode 骨架、校验函数引用；
- 输出到 `generated/<profile>.h`（默认不覆盖，需显式 `overwrite`）；
- 不做完整协议栈、不生成厂商驱动；生成物只作为起点。

**P4 验收**：用一段真实抓包学习出可解码草稿；verify 通过率 ≥ 95%；
auto 在三套实机 profile 上选择正确；生成头文件能在 PC 侧编译通过。

---

## 7. P3：观测与性能

### 7.1 帧级健康度

- 指标：帧率 FPS、到达间隔均值/p95、帧间隙、未知 id、校验失败率、解码错误率、
  每 variant 计数；滑动窗口（默认 10s）。
- 端点：`GET /api/serial/monitor/stats?window_s=10`；
  Agent：`elab_serial_stats`。
- UI：波形页/字节页顶部健康度条；异常阈值高亮。

### 7.2 触发式录制

- `POST /api/serial/capture` 扩展：`trigger`（`pattern` / `field` 条件）、`pre_bytes`、
  `max_bytes`、`frame_index`；
- 触发前环形预录，触发后落盘；JSONL 按字节批次 + 帧索引；
- 面板支持“触发条件”输入与命中标记。

### 7.3 性能基准与优化

- 新增基准脚本（不进 CI 门禁）：14B/64B/1KB 批次、不同字段数、位域/数组；
- 先测基线，再定门槛；初始目标：
  - 115200 满速不丢帧；
  - 单批 64B 解码 p95 < 5ms；
  - 921600 下不出现持续 `gap`。
- 优化方向：字节对齐快路径、位域批量提取、避免解码期间长持锁、必要时把解码移出读线程锁。

**P3 验收**：健康度指标可复核；触发录制能命中指定帧；基准报告与优化前后对比入文档。

---

## 8. 关键契约（草案）

### 8.1 帧 profile 扩展（全部可选，缺省等价 v1）

```json
{
  "frame": {"heads": ["AA55"], "idle_gap_ms": 20},
  "checksum": {
    "kind": "crc16", "preset": "crc16_ccitt_false",
    "cover": {"from": "after_head", "to": "before_checksum"},
    "offset": null
  },
  "escape": {"escape_byte": "0x7D", "xor": "0x20",
             "targets": ["0x7D", "0x7E"], "applies": "payload"},
  "fields": [
    {"name": "ch", "type": "u16", "offset": 4,
     "array": {"count": 4, "stride": 2}},
    {"name": "tag", "type": "str", "offset": 12, "length": 8, "encoding": "gbk"},
    {"name": "flags", "type": "u8", "offset": 20,
     "bits": {"0": "READY", "1": "FAULT"}}
  ],
  "allow_overlap": false
}
```

### 8.2 自动识别返回

```json
{"ok": true, "decoder": "profile:hw_telemetry",
 "auto": {"score": 0.98, "candidates": [
   {"id": "hw_telemetry", "score": 0.98},
   {"id": "hw_mavlink", "score": 0.41}
 ], "evidence": ["head AA55 命中 100%", "CRC16 通过 100%"]}}
```

---

## 9. 测试与门禁

| 层 | 新增测试 | 门禁 |
|---|---|---|
| 帧协议 | 校验预设/覆盖范围、转义、空闲分包、数组/字符串/f16/位标志、重叠校验、fuzz、旧 profile 逐字回归 | `python -m unittest tests.test_serialframes tests.test_serialcodec` |
| 自动识别/学习 | 三套实机抓包、候选排序、低置信度不猜、codegen 产物编译 | 新增 `tests.test_framelearn` |
| 观测/录制 | 帧级统计窗口、错误分类、触发条件命中、预录边界 | `tests.test_serialmon` |
| 插件 | 新工具描述、参数校验、白名单、边界 | `npm test` + `boundary.test.mjs` |
| 前端 | 类型检查、构建 | `tsc --noEmit`（host/client）+ `npm run build` |

**硬纪律**：所有新增端点必须进 `routes.ts` 白名单；所有写操作必须有 `allowAgentWrite` 与 `rev`；
业务逻辑不得进插件；芯片/工具链知识不得进内核。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 校验/转义改动影响旧 profile | 回归 | 所有新字段可选；旧 profile 逐字对比；金向量覆盖 |
| 自动识别误选 | 用户看到错数据 | 只推荐不静默、显示置信度、可一键改回 |
| 学习出的草稿“看起来对但不可用” | 误保存坏 profile | 只产草稿不落盘；`verify` 通过率门槛；证据可复核 |
| 帧环容量不足 | 高频丢帧 | P3 帧级统计先暴露；必要时提升环上限与降采样策略 |
| 解码持锁时间过长 | 读线程丢字节/延迟 | 基准先行；快路径与锁粒度优化；分批解码 |
| 触发录制写盘拖慢读线程 | 丢帧 | 预录环形 + 异步落盘；限制 `max_bytes` |

---

## 11. 前提与决策边界

**本文件不涉及协议选型**（Modbus 主站、蓝牙 SPP/BLE、CAN/CANopen 的决策见姊妹文档）。

**实施前提**

1. 三套真实协议样本：Modbus RTU 抓包、DL/T 645 抓包、一个带转义或空闲分包的私有协议抓包；
2. 旧 profile 回归基线：先把当前解码/保存输出固化为金样本；
3. 实机数据源：现有 `examples/STM32F103C8T6` 可发测试帧即可，不新增教学工程。

**兼容承诺**

- 新字段全部可选，缺省行为等价 v1；
- `SERIAL_META.frames` 只增字段，不删不改既有字段语义；
- 插件对旧内核：`capabilities.meta` 缺失时仍按现有兜底提示同步内核。

---

## 12. 执行清单（按依赖排序）

> 状态（2026-11-05 收尾）：P2.2 / P3 / P4 全部落地并在 **STM32F103C8T6 实机**跑通，
> 见教程 `docs/tutorials/07-串口面板使用.md` §5.7 与附录 D。

- [x] 评审本文，确认 §11 前提
- [x] P2.2：校验声明化 + 转义 + 空闲分包 + 字段模型 + 重叠校验 + verify
      （`serialcodec.CRC_PRESETS` / `escape` / `frame.heads` / `array·str·f16·bits`；`allow_overlap`）
- [x] P2.2：三套协议金向量 + fuzz + 旧 profile 回归
      （`tests/test_serialframes.py` 61 例，含 `Compat` 组逐字比对旧 profile 输出）
- [x] P4.1：`learn` 推断 + 草稿 + 工具（`services/elab/framelearn.py`；真机 0.99 置信度 / 168-168 回放）
- [x] P4.2：`verify` round-trip（真机 177/177 逐字节）
- [x] P4.3：`auto` 单解码器匹配（4 个 profile 中命中，0.709，并列即拒绝）
- [x] P4.4：`codegen` C 头文件（`generated/<id>.h`，`-Wall -Werror` 编译通过）
- [x] P3.1：帧级统计 + `elab_serial_stats`（`GET /api/serial/monitor/stats`）
- [x] P3.2：触发式录制（pattern / field / frame_index + 预录，实机两种触发均命中）
- [x] P3.3：基准 + 热点优化 + 报告
      （`tests/bench_serialcodec.py` + `docs/reports/性能基准_串口帧解码_2026-11-05.md`；
      64B 档 p95 0.6 ms 已达标，**本轮不做热点优化**，优化顺序写入报告）
- [x] 文档同步：`docs/README.md`、串口教程 07（§5.7 + 附录 D）、README 串口章节、CHANGELOG
