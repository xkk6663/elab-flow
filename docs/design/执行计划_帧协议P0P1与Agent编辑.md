# 执行计划：帧协议 P0/P1 与 Agent 自建解码器

> 决策：**把“新建 / 编辑帧协议 profile、预览解码、按字段组帧”变成 Agent 的一等能力。**
> 本文只做执行计划，不写实现；所有改动点、schema 语义、验收判据以本文为准。
>
> 范围：`P0`（位域 / 变长 / 多 ID 分发）+ `P1`（编码 / 模板 / 描述符 / Agent 工具）。
> 不在本计划内：CAN 原生传输、DBC 导入、节点图、任意 JS/Python 解码器。
>
> **状态（2026-11-05）**：P0/P1 已实现并在 STM32F103C8T6 实机验证；
> 使用演示与验收记录见 [串口面板使用教程 §5.6](../tutorials/07-串口面板使用.md)。

---

## 1. 背景与结论

当前“自定义帧格式”已经能解**定长、有固定头/尾、字段按字节对齐**的串口私有帧，入口是
驾驶舱「波形」页签的「帧协议」抽屉，存储为 `projects/<工程名>.frames.json`。

现有实现的硬边界：

- 字段只能按字节偏移读，不能拆 bit；
- 帧长只能写死 `length`，不能由帧内长度字段驱动；
- 一个 profile 只有一套字段表，不能按消息 ID 分发；
- 只能“字节 → 字段”，不能“字段 → 字节”，所以发送面板不能按 profile 组帧；
- Agent 只能选已有 profile，不能新建/编辑。

本计划的目标就是把上面五条补齐，并明确“Agent 写的是**声明式 profile 数据**，不是可执行代码”。

---

## 2. 现状盘点（源码事实）

| 位置 | 现状 |
|---|---|
| [serialframes.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialframes.py#L106-L228) | `normalize_profile` 校验：id / frame / checksum / fields；`kind` 只允许 `binary` |
| [serialframes.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialframes.py#L243-L324) | `load/save/delete`，原子写 + `rev` 乐观锁 |
| [serialcodec.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialcodec.py#L144-L277) | `_decode_profile`：head/length/tail 切帧、三种校验、字段解析、半帧 pending |
| [serialcodec.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialcodec.py#L114-L133) | `_read_num` 只支持字节偏移数值 |
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L95-L114) | `SERIAL_META.frames`：限制 + 端点，前端/Agent 只渲染 |
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L1709-L1714) | `GET /api/serial/frames` |
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L2198-L2242) | `POST /api/serial/frames` 保存/删除、`/preview` 只支持已保存 profile |
| [server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L2274-L2302) | `/api/serial/decode` 支持 `profile:<id>` |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L489-L528) | 会话级共享解码，profile 快照缓存在 `frame_profile` |
| [serialmon.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/serialmon.py#L543-L572) | `set_decoder`：换解码器清帧环，`profile` 必填 |
| [tools.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/dsh-tools/tools.ts#L894-L915) | `elab_serial_monitor` 的 `decoder` 描述只写了 justfloat / firewater |
| [tools.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/dsh-tools/tools.ts#L1071-L1105) | `elab_serial_decode` 未带 `project/profile`，无法真正解 profile |
| [tools.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/dsh-tools/tools.ts#L1126-L1137) | `elab_serial_decoded` 只读共享帧环 |
| [routes.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/kernel-http/routes.ts#L83-L112) | 插件 HTTP 白名单；新增端点必须登记 |
| [client.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/web/src/api/client.ts#L464-L506) | 帧协议前端 API：load / save / preview |
| [SerialWorkspace.tsx](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/web/src/serial/SerialWorkspace.tsx#L266-L400) | cockpit 帧协议抽屉：JSON 编辑 / 保存 / 删除 / 预览 |
| [test_serialframes.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/tests/test_serialframes.py) | 现有校验/存储/解码用例 |

**结论**：内核、HTTP、面板三层已经有一条完整链路；本次是**在 schema 和链路末端扩展**，不是重写。

---

## 3. 目标与非目标

### 3.1 目标

1. **P0**：profile 支持位域、变长帧、多 ID/多消息分发；旧 profile 行为不变。
2. **P1**：profile 支持反向组帧（字段 → 字节）；提供只读模板库；capabilities 暴露完整 schema。
3. **Agent 一等能力**：`elab_frame_profile` 支持 list/get/preview/save/delete/encode/templates/import。
4. **人机同源**：Agent 保存后，人在 cockpit 能看到同一份 profile；Agent 选 `profile:<id>` 后，人看到的波形与 `elab_serial_decoded` 同源。
5. **安全边界**：Agent 只写声明式 profile，不执行任意代码；写操作受 `allowAgentWrite` 与 `rev` 乐观锁双重约束。

### 3.2 非目标

- 不实现 CAN 原生传输、CAN ID/DLC 帧模型、DBC 导入；
- 不实现任意 JS/Python 解码器；
- 不在 P1 做远程模板市场/自动下载；
- 不做节点图、Math/Filter/FFT、DuckDB 录制；
- 不把厂商协议逻辑写进内核；模板只是数据。

---

## 4. Schema v2 设计

所有新字段**可选**；缺省时与 v1 完全一致。

### 4.1 位域

字段新增：

| 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `bit_offset` | int 0..7 | 0 | 在 `offset` 指向字节内的起始 bit |
| `bit_length` | int 1..32 | null | 为 null 时按原字节字段处理 |
| `bit_order` | `lsb0` / `msb0` | `lsb0` | 位序；`lsb0` 从字节最低位向高位，跨字节继续；`msb0` 从字节最高位向低位，跨字节继续 |

约束：

- `bit_length` 只对整型字段有效（`u8/u16/u24/u32/i8/i16/i24/i32`）；
- 有 `bit_length` 时忽略 `endian`，由 `bit_order` 决定位序；
- 符号由类型前缀决定：`i*` 做符号扩展；
- 越界判据：`offset*8 + bit_offset + bit_length <= (length 或 max_bytes)*8`；
- `enum` / `scale` / `bias` / `plot` 对位域仍然有效。

示例：

```json
{
  "name": "mode",
  "type": "u8",
  "offset": 3,
  "bit_offset": 0,
  "bit_length": 3,
  "bit_order": "lsb0",
  "enum": { "0": "IDLE", "1": "RUN", "2": "CAL" }
}
```

跨字节示例：

```json
{
  "name": "rpm",
  "type": "u16",
  "offset": 4,
  "bit_offset": 4,
  "bit_length": 12,
  "bit_order": "lsb0"
}
```

> `msb0` 采用“从帧首字节的 MSB 起按大端位流计数”的线性语义；DBC 的 Motorola `start_bit` 映射放到后续 DBC 导入阶段，不在本期混用。

### 4.2 变长帧

`frame` 新增 `length_field`：

```json
{
  "frame": {
    "head_hex": "FE",
    "tail_hex": "",
    "length": null,
    "length_field": {
      "offset": 1,
      "type": "u8",
      "endian": "le",
      "mul": 1,
      "add": 8
    },
    "max_bytes": 280
  }
}
```

语义：

- `total = raw_value * mul + add`，**从帧首字节算**（含 head）；
- `mul` 默认 1，`add` 默认 0，允许负数但结果必须 ≥ 1；
- `type` 只支持 `u8` / `u16`；
- `length_field` 与 `frame.length` **互斥**；
- 切帧优先级：`length_field` > `length` > `tail` > 下一个 head；
- 计算长度 > `max_bytes` 或明显小于头部 → 记 `skipped` 并重新同步；
- 数据不足 → 返回 `pending`（沿用现有半帧语义）。

校验放宽：`frame` 至少要有 `head_hex`、`length`、`length_field` 三者之一。

示例（MAVLink v1）：

```json
{
  "frame": {
    "head_hex": "FE",
    "length": null,
    "length_field": { "offset": 1, "type": "u8", "mul": 1, "add": 8 },
    "max_bytes": 280
  }
}
```

### 4.3 多 ID / 多消息分发

`frame` 新增可选 `id_field`，profile 新增可选 `variants`：

```json
{
  "frame": {
    "length": null,
    "length_field": { "offset": 2, "type": "u8", "mul": 1, "add": 5 },
    "id_field": { "offset": 1, "type": "u8", "endian": "le" },
    "max_bytes": 260
  },
  "checksum": { "kind": "crc16modbus", "at": "tail" },
  "variants": [
    {
      "id": 3,
      "label": "读保持寄存器应答",
      "fields": [
        { "name": "byte_count", "type": "u8", "offset": 2, "plot": false },
        { "name": "value0", "type": "u16", "offset": 3, "endian": "be", "plot": true }
      ]
    },
    {
      "id": 16,
      "label": "写多个寄存器应答",
      "fields": [
        { "name": "byte_count", "type": "u8", "offset": 2, "plot": false }
      ]
    }
  ]
}
```

语义：

- `id_field` 支持与字段相同的 `bit_offset/bit_length/bit_order`，也支持整型直接读；
- `variants[].id` 可为整数或 `0x` 十六进制字符串，规整为 int，必须唯一；
- 命中 variant → 用该 variant 的 `fields`；variant 可选 `checksum` 覆盖 profile 默认值；
- 未命中 → 若顶层 `fields` 存在则作默认字段；否则记 `unknown_id` 并跳过该帧（仍消费长度）；
- 顶层 `fields` 与 `variants` 可以同时存在；顶层是**兜底字段**；
- 同一字段名跨 variant 允许重复，但 `type/unit/scale/bias/enum/plot` 必须一致，否则保存时报错；
- 限制：`variants` ≤ 16；所有 variant 字段名并集 ≤ `MAX_FIELDS`（64）。

解码返回扩展：

- `records[]` 增加 `id`、`variant`（label），`fields` 只含当前 variant 的字段；
- `fields`（通道元数据）返回**所有 variant 字段名的并集**，按声明顺序；
- `frames[]` 的 `values` 按并集对齐，当前 variant 没有的通道填 `null`；
- 新增计数 `unknown_id`。

> 这条会改变 `frames` 的元素类型（`number[]` → `(number|null)[]`），前端波形需要跳过 `null` 点。

### 4.4 校验和

本期不扩展算法，保持 `sum8 / xor8 / crc16modbus`。

- 支持 variant 级 `checksum` 覆盖；
- 校验字节仍**不包含尾标记**；
- 校验失败计入 `checksum_fail` 与 `skipped`，错误信息带 profile id 与 variant。

### 4.5 反向组帧（P1）

新增 `encode(profile, values, variant_id=None, length_value=None)`：

- `values` 按字段名传值；
- `enum` 可传枚举 key 或 label；
- `scale/bias` 做逆变换；
- 位域按 `bit_order` 写入；
- `head/tail` 自动拼接；
- `length_field` 默认按组装后的总帧长反算并写入；也可用 `length_value` 显式覆盖；
- `checksum` 按现有 `at` 语义计算并插入；
- 多 variant：必须给 `variant_id`，同时写入 `id_field`。

输出：

```json
{
  "ok": true,
  "id": "mavlink_v1",
  "variant": null,
  "hex": "FE...",
  "bytes": 42,
  "length_field": 34,
  "checksum": "0xABCD"
}
```

限制：

- 只支持“字段能完整描述帧”的 profile；
- 不处理未建模的重复负载/TLV；
- `bytes` 字段用十六进制字符串传值。

---

## 5. Agent 能力设计

### 5.1 新工具 `elab_frame_profile`

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `action` | 是 | `list / get / preview / save / delete / encode / templates / import` |
| `project` | 是 | 工程名 |
| `id` | 视 action | profile id |
| `rev` | save/delete/import 必填 | 乐观锁；冲突返回最新 rev + profiles |
| `profile` | save/preview 可用 | 完整 profile；preview 可传**未保存草稿** |
| `hex` / `data_b64` | preview | 样本字节 |
| `values` | encode | 字段值对象 |
| `variant` | encode | 多 variant 时指定 id |
| `template` | import | 模板 id |
| `new_id` | import | 可选，导入时重命名 |

行为：

- `list/get/preview/encode/templates` 只读，不要求 `allowAgentWrite`；
- `save/delete/import` 写工程文件，要求 `allowAgentWrite`；
- `preview` 支持两种输入：已保存 `id`，或内联 `profile` 草稿；后者用于“先验证再保存”；
- `save` 成功后，如果当前会话正在用这个 profile，自动 `set_decoder("profile:<id>")` 重设；
- `delete` 后，如果当前会话正在用这个 profile，自动清空 decoder；
- 所有写失败返回结构化错误路径（`frame.*` / `fields[i].*` / `variants[i].*`），Agent 可自行修正后重试。

### 5.2 扩展已有工具

- `elab_serial_monitor`：
  - `decoder` 参数描述增加 `profile:<id>`；
  - 选 profile 时要求同时传 `project`（当前实现已支持工程上下文，但工具描述未写）。
- `elab_serial_decode`：
  - 增加 `project`、`profile` 参数；
  - `decoder` 支持 `profile:<id>`；
  - 把 `project/profile` 一起发给 `/api/serial/decode`。
- `elab_serial_decoded`：保持不变，继续读会话共享帧环。

### 5.3 Agent 自测闭环

推荐 Agent 按下面顺序工作：

1. `elab_frame_profile list`：拿 `rev` 和现有 profile，避免覆盖；
2. `elab_frame_profile preview`：传草稿 `profile` + 样本 `hex`，确认 `total_frames / skipped / checksum_fail / errors`；
3. 修正字段/切帧/校验，直到预览稳定；
4. `elab_frame_profile save`（带 `rev`）；
5. `elab_serial_monitor action=decoder decoder=profile:<id>`；
6. `elab_serial_decoded` 读结构化帧；
7. 需要回发时 `elab_frame_profile encode` → `elab_serial format=hex`。

### 5.4 权限与边界

- Agent **不能**直接改 `projects/*.frames.json` 文件；只能走工具/HTTP，确保校验、原子写、审计；
- Agent **不能**生成可执行解码器代码；profile 是数据，内核仍是通用解释器；
- 冲突不覆盖：`rev` 不匹配返回 409 + 最新内容；
- 写硬件仍归 `elab_serial`，`allowAgentWrite` 不因本工具放宽。

---

## 6. HTTP / capabilities 改动

### 6.1 端点

| 方法 | 路径 | 改动 |
|---|---|---|
| GET | `/api/serial/frames` | 不变 |
| POST | `/api/serial/frames` | 不变；`save/delete` 后自动处理会话 profile 快照 |
| POST | `/api/serial/frames/preview` | 新增：允许 `profile` 内联草稿（与 `id` 二选一） |
| POST | `/api/serial/frames/encode` | 新增：`{project,id,values,variant?}` → hex |
| GET | `/api/serial/frames/templates` | 新增：模板清单（只读） |
| POST | `/api/serial/frames/templates/import` | 新增：按模板导入并保存（带 rev） |

### 6.2 `SERIAL_META.frames`

新增：

```json
{
  "schema": {
    "field_types": ["u8", "u16", "u24", "u32", "i8", "i16", "i24", "i32", "f32", "f64", "ascii", "bytes"],
    "bit_orders": ["lsb0", "msb0"],
    "length_field_types": ["u8", "u16"],
    "max_variants": 16,
    "supports": ["bitfield", "length_field", "variants", "encode", "templates"]
  },
  "endpoints": {
    "load": "/api/serial/frames",
    "save": "/api/serial/frames",
    "preview": "/api/serial/frames/preview",
    "encode": "/api/serial/frames/encode",
    "templates": "/api/serial/frames/templates",
    "import": "/api/serial/frames/templates/import"
  }
}
```

`features` 追加：

```text
frame_bitfield, frame_length_field, frame_variants, frame_encode,
frame_templates, frame_agent_edit
```

### 6.3 插件 HTTP 白名单

在 [routes.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/adapters/kernel-http/routes.ts#L83-L112) 增加：

- GET：`serial/frames/templates`
- POST：`serial/frames/encode`、`serial/frames/templates/import`

边界测试 `test/boundary.test.mjs` 必须继续通过。

---

## 7. P1 模板库

### 7.1 存放

新增只读数据目录：

```text
templates/frames/
  telemetry_u16.json
  mavlink_v1.json
  modbus_rtu.json
  dlt645_read.json
```

- 只放 JSON，不放可执行代码；
- 由 `serialframes` 加载、校验，校验失败在启动/列表时报错；
- 不放进 `packs/**`（模板是协议知识，不是芯片知识）；后续若要社区分发，再走独立协议包/市场。

### 7.2 UI / Agent 用法

- cockpit 帧协议抽屉增加「从模板新建」：选择模板 → 载入 JSON 编辑器 → 保存到当前工程；
- Agent：`elab_frame_profile action=templates` 列表，`action=import template=<id> new_id=<可选>`；
- 模板导入仍是 `save` 语义：带 `rev`，冲突不覆盖。

---

## 8. 改动清单

### 8.1 内核

| 文件 | 改动 |
|---|---|
| `services/elab/serialframes.py` | 新增 `bit_order/bit_length`、`length_field`、`id_field/variants` 的规整与校验；放宽“head 或 length”判据；新增模板加载/导入 |
| `services/elab/serialcodec.py` | 新增 `_read_bits`；重写切帧逻辑支持 `length_field`；新增 variant 选择；`frames` 支持 `null` 占位；新增 `encode/build_frame` |
| `services/elab/serialmon.py` | 无结构改动；确认 `frame_profile` 快照可被新 schema 正常使用 |
| `cockpit/server.py` | `SERIAL_META.frames` 扩展；preview 支持内联草稿；新增 encode/templates/import；save/delete 后重设会话 decoder |

### 8.2 前端（cockpit）

| 文件 | 改动 |
|---|---|
| `cockpit/web/src/api/client.ts` | 新增 encode/templates/import 请求；`serialFramesPreview` 支持 `profile` 草稿 |
| `cockpit/web/src/serial/SerialWorkspace.tsx` | 帧协议抽屉：模板入口、schema 提示、字段/bit 说明；发送面板增加「按 profile 组帧」模式 |
| `cockpit/web/src/serial/useSerialStream.ts` | `frames` 类型允许 `null`；波形跳过 null 点 |
| `cockpit/web/src/serial/*.module.css` | 新控件样式（如有） |
| `packages/cockpit-ui-core/src/icd.ts` | 帧 profile / preview / encode / template 类型 |

### 8.3 DSH 插件

| 文件 | 改动 |
|---|---|
| `src/adapters/dsh-tools/tools.ts` | 新增 `elab_frame_profile`；扩展 `elab_serial_decode` / `elab_serial_monitor` 描述与参数；更新工具索引 |
| `src/adapters/kernel-http/routes.ts` | 新端点白名单 |
| `src/adapters/kernel-http/icd-client.ts` | 模板/encode 类型（如插件需要展示） |
| `src/adapters/dsh-web/SerialPane.tsx` | profile 列表只读展示 + decoder 选 `profile:<id>`；不新增第二套编辑器 |
| `src/domain/icd.ts`、`packages/cockpit-ui-core/src/icd.ts` | 新类型同步 |

### 8.4 测试与文档

| 文件 | 改动 |
|---|---|
| `tests/test_serialframes.py` | 位域/变长/variants 校验与保存；旧 profile 回归 |
| `tests/test_serialcodec.py` | 位域（lsb0/msb0/跨字节/有符号）、变长、variant、unknown_id、null 通道 |
| `tests/test_serialmon.py` | 会话切 profile、保存后重设、删除后清空 |
| `packages/dsh-elab-cockpit/test/routes.test.mjs` | 新端点白名单 |
| `packages/dsh-elab-cockpit/test/*` | 工具参数/权限/冲突行为 |
| `docs/tutorials/07-串口面板使用.md` | 位域/变长/variants/组帧发送/Agent 用法 |
| `.agents/skills/elab-tools/SKILL.md` | `elab_frame_profile` 与 `profile:<id>` 索引 |
| `CHANGELOG.md` | 版本条目 |

---

## 9. 实施阶段与验收

### 阶段 0：schema 冻结

- 本文 schema 评审通过；
- 先写失败测试（位域/变长/variants），再改实现；
- 旧 `korvo_telemetry`、`wave3` profile 解码结果必须逐字节一致。

### 阶段 1：P0-A 位域

- `normalize_profile` 支持 `bit_offset/bit_length/bit_order`；
- `_read_bits` 支持 lsb0/msb0、跨字节、有符号；
- 测试覆盖：3bit 枚举、12bit 跨字节、i16 符号、越界报错；
- 验收：现有字节字段 profile 不受影响。

### 阶段 2：P0-B 变长

- `length_field` 切帧、resync、pending、max_bytes 保护；
- `length` 与 `length_field` 互斥；
- 测试覆盖：MAVLink 风格、长度异常、半帧、仅 length_field 无 head；
- 验收：预览和会话解码同一结果。

### 阶段 3：P0-C 多 ID

- `id_field` + `variants` 规整/校验；
- variant 选择、unknown_id、checksum 覆盖；
- `fields` 并集 + `frames` null 占位；
- 前端波形跳过 null；
- 测试覆盖：命中/未命中、同名同义字段、不同 checksum、并集通道。

### 阶段 4：Agent 编辑能力

- `elab_frame_profile` 工具；
- preview 内联草稿；
- `elab_serial_decode` 支持 `project/profile`；
- `elab_serial_monitor` 描述支持 `profile:<id>`；
- routes 白名单；
- 测试：list/get/preview/save/delete/encode；`allowAgentWrite` 拒绝；rev 冲突；保存后会话重设。

### 阶段 5：P1 编码

- `encode/build_frame`；
- `/api/serial/frames/encode`；
- cockpit 发送面板「按 profile 组帧」；
- Agent `elab_frame_profile action=encode` → `elab_serial format=hex`；
- 测试：三种校验 round-trip、位域 round-trip、scale/bias 逆变换、枚举传 label、length_field 反算。

### 阶段 6：P1 模板与描述符

- `templates/frames/*.json` + 校验；
- `GET /api/serial/frames/templates`、`POST import`；
- cockpit「从模板新建」；
- `SERIAL_META.frames.schema`；
- 验收：模板列表全部通过校验；导入后可预览、可保存、可解码。

### 阶段 7：门禁与实机

- 内核：`$env:PYTHONPATH="services"; python -m unittest tests.test_serialframes tests.test_serialcodec tests.test_serialmon`
- 插件：`npm test`、两条 `tsc --noEmit`、`npm run build`（cwd = `packages/dsh-elab-cockpit`）
- 边界：`test/boundary.test.mjs`
- 实机：真板发位域/变长/多 ID 帧，cockpit 预览 + 波形 + Agent 共享解码一致。

---

## 10. 测试计划

### 10.1 单元测试

- 位域：LSB0 单字节、LSB0 跨字节、MSB0 单字节、MSB0 跨字节、有符号、越界、enum、plot。
- 变长：长度正确、长度不足 pending、长度超 max_bytes、长度非法 resync、无 head。
- 多 ID：命中、未命中默认字段、未命中跳过、checksum 覆盖、字段并集、同名冲突。
- 编码：固定帧、变长帧、位域、scale/bias、enum label、checksum 三种。
- 存储：旧 profile 读取、rev 冲突、删除、模板导入冲突。
- 会话：保存后重设 decoder、删除后清空、切 profile 清 pending。

### 10.2 契约测试

- `/api/serial/frames/preview`：`id` 与 `profile` 二选一；两者都传报错；草稿不落盘。
- `/api/serial/frames/encode`：不存在的 id、values 缺字段、variant 必填缺失、六角输出。
- `/api/serial/frames/templates`：清单结构、坏模板报错。
- `SERIAL_META.frames.schema.supports` 与 features 对齐。

### 10.3 插件测试

- `elab_frame_profile` 每个 action 的参数校验；
- `allowAgentWrite=false` 时 save/delete/import 拒绝，list/get/preview/encode 可用；
- rev 冲突返回 409 内容；
- `elab_serial_decode` 带 `project/profile` 能解 profile；
- routes 白名单包含新端点；
- 边界测试仍通过（插件不 import 内核）。

### 10.4 手工验收

1. 用 `korvo_telemetry` 旧 profile 验证波形与之前一致；
2. 新建位域 profile（status 的低 3 位）→ 预览 → 波形显示枚举；
3. 新建变长 profile（MAVLink 风格）→ 粘样本 → 解出多帧；
4. 新建双 variant profile（0x101/0x102）→ 预览 → 两套字段；
5. Agent 按第 5.3 节走完整闭环；
6. cockpit 按 profile 组帧发送 → 设备回帧 → 预览解码成功。

---

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| `msb0` 语义与 DBC Motorola 不完全一致 | 文档明确本期线性 msb0；DBC 导入时单独映射 start_bit |
| `null` 通道破坏波形 | 统一类型 `(number|null)[]`；波形过滤 null；测试覆盖 |
| variant 字段同名不同义 | 保存时强校验 type/unit/scale/bias/enum/plot 一致 |
| 变长协议未建模尾部负载 | 编码仅支持字段完整描述；未建模部分明确不支持 |
| 会话缓存旧 profile | save/delete 后自动重设/清空 decoder |
| Agent 覆盖人的修改 | 强制 `rev`；冲突返回最新内容；写操作受 `allowAgentWrite` |
| 模板质量参差 | 模板入库前跑统一校验；只放少量经过实机验证的样例 |
| 内核被厂商逻辑污染 | profile/模板全是数据；内核只认 schema，不写厂商分支 |

---

## 12. 验收清单

- [ ] 旧 profile 解码结果不变（回归用例）
- [ ] 位域：单字节/跨字节/有符号/msb0 全部通过
- [ ] 变长：正常/半帧/超长/非法长度全部通过
- [ ] 多 ID：命中/未命中/默认字段/checksum 覆盖全部通过
- [ ] `frames` null 占位与波形渲染通过
- [ ] Agent 可 list/get/preview/save/delete/encode/import
- [ ] Agent 写操作受 `allowAgentWrite` 与 `rev` 约束
- [ ] Agent 保存后面板同源；选中 `profile:<id>` 后 `elab_serial_decoded` 同源
- [ ] cockpit 可从模板新建、按 profile 组帧发送
- [ ] `SERIAL_META.frames.schema` 与实现一致
- [ ] 插件 `npm test` / `tsc --noEmit` / `npm run build` 通过
- [ ] 内核单测通过；边界测试通过
- [ ] 文档与 `elab-tools` 索引更新

---

## 13. 一句话

**先补 P0 三块 schema（位域、变长、多 ID），再把 Agent 的 profile 编辑/预览/组帧工具接上；P1 用同一份 profile 做反向编码和只读模板库。整个方案只扩展“数据 + 通用解释器”，不引入厂商分支、不执行任意代码、不碰 CAN 原生传输。**
