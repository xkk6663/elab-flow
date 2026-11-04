# 技术方案：ESP32 接入与工具链解耦

> 状态：**M0 + M1 + M2 + M5 + M6（代码）已落地（2026-11-04）**；
> 外置包 `elab-pack-espressif-esp32` 已创建并本地安装，M3 已写市场索引
> （`ref` + `sha256`），**远端仓已上架**（`xkk6663/elab-pack-espressif-esp32`，
> 打 `elab-pack` topic，市场索引已收录）。
> M4（`pet_companion`）按用户决定后置；M6 硬件验证受限于 Korvo-1
> **无板载 USB-JTAG**（需外接探针）。
> 范围：先把 `esp32s31` **最小示例工程**放进 `examples/` 跑通闭环；
> `pet_companion` 作为后续业务验证，不阻塞本轮。同时把「芯片/工程自带工具链」机制化，
> 并评估 ESP32 作为芯片适配包上架市场。
> 关联：[技术方案_闭环驾驶舱](技术方案_闭环驾驶舱.md)、[ICD_cockpit_events](ICD_cockpit_events.md)、
> [设计约束](设计约束.md)、[技术方案_dsh-elab-flow插件移植](技术方案_dsh-elab-flow插件移植.md)。
> 本文所有源码行号以 2026-11-04 的本仓检出为准。

> **状态更新（2026-11-04，Provider 迁移）**：ESP32 工程已从本文的 A 方案
> （项目内联 `tools:` + `steps.<step>: tool:<name>`）迁移到 **Provider 架构主路径**：
> 项目只写 `provider: espressif/idf@>=1 <2`，命令模板移入
> `providers/official/espressif/idf/provider.yaml`。本文保留作为首次接入的设计记录；
> 文中内联 `tools:` 写法现在仅由 `elab adapt --no-provider` 兜底生成，**新接入请以
> [技术方案_Provider工具链架构](技术方案_Provider工具链架构.md) 为准**。

---

## 0. 结论摘要（先看这里）

| 问题 | 结论 |
|---|---|
| ESP32 能否接入现有闭环？ | **能**。原有 A 方案用项目级步骤委托 `steps.build: tool:idf_build`；现已迁移为 `provider: espressif/idf@>=1 <2`，内核步骤名与三档定义始终不变。 |
| 内核要不要绑定 ESP-IDF？ | **不要**。内核只保留「通用工具执行器 + 事件流 + 串口 + verdict」，ESP-IDF 命令全部沉到数据层（原 A 方案在项目 YAML，现为 provider）。 |
| 日志怎么回面板？ | **天然复用 `proc/stdout`**。关键是委托后仍以**规范步骤名**（build/flash/...）发事件，通道归类才正确。 |
| 调试本轮做不做？ | **不做**。`debug_verify` 改为 `esptool verify-flash`（烧录校验），真正的 GDB 调试留到 RISC-V 专项。 |
| ESP32 能不能作为芯片包上架？ | **能，但只能是纯数据包**。现有包协议禁止 `.py/.exe/.sh`，provider 代码无法随包分发。 |
| 本轮推荐落地顺序 | A 方案先行完成首次接入；**后续已按 Provider 方案落地 P1/P2**（声明式 provider + 市场/锁版本），ESP32 工程完成迁移并实机闭环通过。 |
| ESP32 包名 | **`espressif/esp32`**（平台聚合，芯片文件 `chips/esp32s31.yaml`）。 |
| `debug_verify` 中文标签 | 委托项目显示 **「烧录校验」**；由项目 YAML 的 `step_labels` 覆盖，内核 `STEP_META` 不改。 |
| `monitor` 是否可委托 | **不允许**。保内核串口三态与 `serial/*` 事件；未来另设「串口 provider」。 |
| 本轮验收工程 | **`examples/ESP32S31_Korvo/` 最小心跳示例**；`pet_companion` 后置，不阻塞本轮。 |
| `pack` 固定 | **本轮必做（P0）**，不是可选项。项目 YAML 写 `pack: espressif/esp32`，`chip_of` 支持固定包解析。 |
| 板载 RGB LED | **WS2812，GPIO37**（ESP32-S31-Korvo-1 V1.1 官方用户指南）。 |

**一句话**：本轮不是「把 ESP-IDF 塞进内核」，而是把内核已有的 `tool:<name>` 缝扩成
**规范步骤委托**，让 ESP32 工程自己声明编译/烧录/校验命令；面板、日志通道、三态判定、
芯片包市场全部原样复用。

---

## 1. 现状事实（源码证据）

### 1.1 闭环执行链

```text
DSH 面板 / WebUI / CLI
        │  POST /api/runs  (project, steps)
        ▼
cockpit/server.py  RunManager.start()
        │  spawn: python -m elab run -p <p> --steps ... --emit-events
        ▼
services/elab/run.py  run() → _execute(step)
        │            ├─ doctor / build / flash / debug_verify / monitor（原生）
        │            └─ tool:<name> → _run_tool()
        ▼
kernel/events.py  EventLog  → <run>.jsonl（状态）+ <run>.proc.jsonl（日志）
        │
        ▼
cockpit SSE → 面板日志通道（build / flash / debug / serial / tools）
```

关键源码：

- [run.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/run.py#L35-L56)：`ALL_STEPS`、`DEFAULT_STEPS`、`TOOL_PREFIX = "tool:"`
- [run.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/run.py#L72-L89)：`parse_steps` 只校验格式，允许 `tool:<name>`
- [run.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/run.py)：`_resolve_tool` 解析 `tools.<name>`，模板变量为
  `${serial_port}` / `${root}` / `${work_dir}` / `${name}` / `${runs_dir}` / `${env:NAME}` /
  `${host:...}` / `${json_args:FILE#KEY}`
- [run.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/run.py#L200-L232)：`_run_tool` 逐行 `sink()`，退出码非 0 即失败
- [run.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/run.py#L235-L328)：`_execute` 原生分支；`tool:` 分支在 325-326 行
- [run.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/run.py#L489-L559)：`run()` 对每个步骤 `io.sink(step)` —— **sink 已绑定当前步骤名**
- [run.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/run.py#L434-L444)：`preview` 已支持 `tool:` 预览

### 1.2 日志与通道归类

- [events.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/kernel/events.py#L307-L326)：`proc()` / `proc_sink()`，事件字段为
  `{topic, step, line, project, actor}`
- [channels.ts](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/packages/dsh-elab-cockpit/src/domain/channels.ts#L1-L28)：归类规则
  1. `serial/*` → serial
  2. `step == "tool:<name>"` → **tools**
  3. 其余按 step：`flash` → flash、`debug_verify` → debug、`monitor` → serial、其余 → build

> ★ **本方案的核心约束由此而来**：`_run_tool` 收到的 `sink` 必须仍然是规范步骤名。
> 如果把项目 YAML 的 `steps.build` 直接写成 `tool:idf_build` 并让 `run()` 跑这个 step，
> 日志会全部落进 `tools` 通道，面板的「编译」页签看不到东西。
> 因此必须做 **步骤委托**，而不是让 UI 直接跑工具步骤。

### 1.3 可用性判断（ESP32 当前会被禁用）

[server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L622-L637)：

```python
probe = (proj.get("debug") or {}).get("probe", "")
...
if not (probe and probe in probes):
    avail["flash"] = {"ok": False, "reason": ...}
    avail["debug_verify"] = {"ok": False, "reason": ...}
```

ESP32 用 USB 串口 + esptool，不需要探针；但当前会被这段逻辑一并禁用。
必须改成：**该步骤已委托给 `tool:` 时，不再强制要求探针**。

### 1.4 芯片知识只来自「当前启用包」

[config.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/config.py#L99-L138)：

```python
active = self.active_pack
records = [active] if active else []
```

[config.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/config.py#L228-L238)：`chip_of()` 只查 `self.chips`。

> ★ 现实后果：`packs/installed/active.json` 一次只启用一套包。若当前启用的是
> `st/stm32`，项目写 `chip: esp32s31` 会直接报「引用了未知芯片」。
> **已拍板**：项目 YAML 写 `pack:` 固定包，`chip_of` 优先该包（P0，见 §4.1.2 / §5.3 / §6.5）。

### 1.5 芯片包协议不允许可执行内容

[pkg.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/pkg.py#L73-L78)：`_DENY_EXTS` 拒绝
`.exe/.dll/.so/.a/.bin/.hex/.elf/.map/.sh/.py/.js/.mjs/.ts/...`；
[validate_manifest](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/services/elab/pkg.py#L284-L329) 只校验数据清单。

> ★ 结论：ESP32 包只能是 `pack.yaml + chips/*.yaml + README` 的**纯数据包**。
> 「provider 插件」不能走现有市场。

### 1.6 取消已经能杀进程树

[server.py](file:///c:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/cockpit/server.py#L544-L592)：Windows 下
`taskkill /PID <elab run> /T /F`，`/T` 连带 cmake → ninja → gcc 子树。

> 修正旧认知：`_run_tool` 注释里「取消会留孤儿」在本仓**已被 /T 覆盖**。
> 仍需补的是**工具超时**（否则一次卡死的 `idf.py` 会长期占串口）与 `elab run` 自身崩溃后的残留。

---

## 2. 目标架构与分层

### 2.1 分层图

```text
┌──────────────────────────────────────────────────────────────────┐
│ 工具层  packages/dsh-elab-cockpit                                │
│   面板（三连/闭环/日志/串口/调试）  elab_* agent 工具             │
│   只读内核自描述（STEP_META / KERNEL_PLANS / SERIAL_META）        │
└───────────────▲──────────────────────────────────────────────────┘
                │ loopback HTTP + SSE（唯一合法缝隙）
┌───────────────┴──────────────────────────────────────────────────┐
│ 业务层  cockpit/server.py + services/elab/**                      │
│   步骤编排 / 事件流 / 串口 / 三态 verdict / 原生 ARM 链路         │
│   ★ 本轮新增：步骤委托分发、工具环境增强、可用性解耦              │
└───────────────▲──────────────────────────────────────────────────┘
                │ projects/*.yaml : steps + tools（项目自有命令）
┌───────────────┴──────────────────────────────────────────────────┐
│ 项目级  ESP-IDF 工程（examples/ESP32S31_Korvo；pet_companion 后置）│
│   idf.py build/flash、esptool verify、工程自己的 venv/tools        │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ 数据层  packs/**, market/index.json                               │
│   芯片参数 / 厂商指纹 / 平台坑位（纯数据，无脚本）                 │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 两种模式的共存

| 模式 | 触发条件 | 执行者 | 典型芯片 |
|---|---|---|---|
| **原生模式**（现状） | 项目 YAML 没有 `steps` 委托 | 内核 `builder/flash/debug` | STM32 / AT32（ARM + OpenOCD） |
| **委托模式**（本轮新增） | `steps.<step>: tool:<name>` | 项目声明的外部命令 | ESP32（ESP-IDF / esptool） |

**内核不绑定任何编译链**：原生模式是「官方推荐默认工具链」，委托模式是
「芯片/工程自带工具链」。两者共享同一条事件流、同一套 verdict、同一个面板。

---

## 3. 方案对比：A（项目级命令编排） vs C（独立 provider 插件）

| 维度 | A：项目级 `steps → tool:*` | C：独立 provider 插件 |
|---|---|---|
| 落地成本 | 小：`run.py` 四处 + `server.py` 一处 + 项目 YAML | 大：插件发现、安装、版本、信任、沙箱、跨平台 |
| 日志回面板 | **天然**（规范步骤名 → 现有通道） | 需要新事件协议 / 适配层 |
| 复用面板三连 | 原样复用 | 需要 provider 声明步骤映射 |
| 复用芯片包市场 | **可以**，工具属于项目，包只放芯片数据 | **不可以**，`_DENY_EXTS` 禁止 `.py/.exe` |
| 工具链隔离 | 靠项目 YAML 的绝对/相对路径 | 靠 provider 自带环境 |
| 调试 | 内核 GDB/MI 原样保留 | 需要 provider 对接 DAP/GDB |
| 安全边界 | 项目 YAML 本来就能声明任意命令（既有事实） | 需要新增签名/信任模型 |
| 演进 | 可逐步把 `tool:` 升级为 provider | 一步到位但周期长 |

**决策**：**A 先行**，并把 A 的契约设计成 C 的子集：

- `steps.<step> = tool:<name>` 是「单项目内的 provider 绑定」；
- `tools.<name>` 的字段（`cmd/cwd/env/env_from_cmd/env_prepend_path/timeout_s/result`）
  未来可原样搬进 `provider.yaml`；
- C 阶段只需要新增「provider 注册表 + 安装器」，不需要重写执行器。

> 这也符合项目定位：**一切芯片皆插件**。本轮先把「插件」的最小形态（项目声明命令）
> 跑通；官方 ARM 链路继续作为内置默认 provider。

---

## 4. 契约设计

### 4.1 项目 YAML 新增 `steps` 与 `pack`

```yaml
# projects/esp32s31_korvo.yaml（本轮验收工程）
name: esp32s31_korvo
root: ${ELAB_ROOT}/examples/ESP32S31_Korvo
pack: espressif/esp32        # ★ 新增：项目固定包（见 4.1.2）
chip: esp32s31
archetype: idf

steps:                          # ★ 新增：规范步骤 → 项目工具
  doctor:        tool:idf_env_check
  build:         tool:idf_build
  flash:         tool:idf_flash
  debug_verify:  tool:idf_verify
  # monitor 不委托：继续走内核串口 + 三态判据

step_labels:                    # ★ 新增：项目级文案覆盖（只改显示，不改语义）
  debug_verify: 烧录校验
```

**语义**：

1. `steps` 只允许出现在项目 YAML；键必须是 `ALL_STEPS` 里的规范名（含 `doctor_deep`）。
2. 值只接受 `tool:<name>`；`<name>` 必须在同一文件的 `tools` 中声明。
3. 未声明的步骤 → 走原生实现（完全向后兼容）。
4. `monitor` **不允许**委托：它是内核的串口判据入口，委托会丢失 `serial/*` 事件与三态。
5. 委托步骤的**事件 `step` 仍是规范名**，不是 `tool:<name>`。
6. `step_labels` 是**可选**的项目级显示覆盖：键为步骤名，值为中文标签。
   内核在 `/api/projects` 原样暴露，工具层渲染时优先用它，否则用 `STEP_META.label`。
   `STEP_META` 仍是全局默认值，**不为 ESP32 改全局文案**。

#### 4.1.2 `pack` 字段（解决 active pack 冲突）

`pack: espressif/esp32` 的含义：该项目的 `chip` 解析**优先**在这个已安装包里查找，
不受 `packs/installed/active.json` 限制。

解析顺序（`Config.chip_of`）：

```text
1) 若 proj.pack 非空：
     a. 在 cfg.packs[proj.pack] 的 chips/ 里找 chip（按 ref 或裸 id）
     b. 找不到 → 明确报错：项目固定包未安装 / 包内无此芯片
2) 否则：维持现状，只查当前 active_pack
```

**本轮决策：`pack` 固定为 P0，必须与步骤委托同批落地**（改动约 20 行 + 单测）。
不采用「跑前手动 `elab pkg use`」的兜底：那会让 STM32 与 ESP32 不能并行，
违背「一切芯片皆插件」的日常体验。

并发安全：`chip_of` 只读包目录，不修改 `active.json`；两个项目各自固定包互不影响。

### 4.2 `tools.<name>` schema v2

现有字段：`label`、`cwd`、`env`、`cmd`。本轮新增**四个通用字段**（全部可选）：

```yaml
tools:
  idf_build:
    label: ESP-IDF 编译
    cwd: ${root}
    cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf.py", "-B", "build", "build"]
    env:
      IDF_TOOLS_PATH: "${host:tools.idf.tools_path}"
      IDF_PYTHON_ENV_PATH: "${host:tools.idf.venv}"
      ESP_IDF_VERSION: "${host:tools.idf.version}"
      IDF_PATH: "${host:tools.idf.idf_path}"
      IDF_PY: "${host:tools.idf.python}"
    env_from_cmd:                          # ★ 新增：从命令输出合并环境
      cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf_tools.py",
            "export", "--format", "key-value"]
      format: key-value
      path_key: PATH
      merge: true
    env_prepend_path:                      # ★ 新增：显式前置目录
      - "${root}/tools/bin"
    timeout_s: 900                         # ★ 新增：超时（秒）
    result:                                # ★ 新增（P1）：结构化结果标记
      marker: "[elab-result] "
```

字段规则：

| 字段 | 类型 | 规则 |
|---|---|---|
| `cmd` | list[str] \| str | 必填；字符串按空白切分（现状兼容） |
| `cwd` | str | 缺省 = 项目 `root` |
| `env` | map | 追加到子进程环境；值支持模板 |
| `env_from_cmd` | map | 先执行该命令，把 `KEY=VALUE` 行合并进环境 |
| `env_prepend_path` | list[str] | 按顺序前置到 PATH |
| `timeout_s` | int | 超时后杀进程树，步骤判失败 |
| `result` | map | 仅识别 `marker` 前缀行，解析 JSON 合并进 `extra` |

#### 模板变量扩展

现有 `${serial_port}` / `${root}` / `${work_dir}` / `${name}` / `${runs_dir}` 之外，新增：

- `${env:NAME}`：从 `tools.<name>.env` → 进程环境依次查找。
  用途：把绝对路径集中写在 `env`，`cmd` 只引用变量，工程可迁移。
- `${host:key}`：引用 **L0 主机事实源**（`elab.host.yaml`），项目 YAML 不写死路径。
  支持点路径（`tools.idf.python` / `tools.idf.idf_path` / `tools.idf.tools_path` /
  `tools.idf.venv` / `tools.idf.version`）与 Host 属性短名（`idf.python`、`idf.venv`…）；
  Host 属性已含 `ELAB_IDF_*` 环境变量覆盖。
- `${json_args:FILE#KEY}`：**整段 argv 元素**时，读取 JSON 的 `KEY`（offset→file 映射），
  展开为 `[offset, file, ...]`（file 相对 JSON 所在目录）。典型用法：
  `"${json_args:${root}/build/flasher_args.json#flash_files}"` —— 烧录偏移与产物名
  由构建产物自己声明，不再写死。
- `${env:}` 与 `${host:}` 可互相嵌套，解析到稳定为止；未定义即 fail-fast
  （错误消息带出具体 key），绝不把 `${...}` 漏给子进程。
- 替换只发生在 `cmd`、`cwd`、`env_prepend_path`、`env_from_cmd.cmd` 上。

> 注意：`to_fwd()` 只用于 `argv/cwd`；**环境变量值保留原样**（Windows PATH 里
> 反斜杠与分号不能被转换）。

### 4.3 `env_from_cmd` 契约

目的：ESP-IDF 的工具链路径必须由 `idf_tools.py export` 动态给出，不能写死。

**执行时机**：每次 `_run_tool` 调用前；同一 `(cmd 元组 + 基础 env)` 在**同一进程内缓存**
（避免 `loop` 五步重复导出，每次约 0.5–1s）。

**输出解析**：

1. 只读 stdout，逐行匹配 `^[A-Za-z_][A-Za-z0-9_]*=`。
2. 忽略 `WARNING:` / `ERROR:` / `Not using ...` 等诊断行（实测 export 会混入）。
3. `KEY=VALUE` 直接写入 env。
4. `path_key`（默认 `PATH`）特殊处理：
   - 值里若含字面量 `%PATH%`（Windows 实测 export 输出如此），用当前 env 的 PATH 替换；
   - 若含 `$PATH`（Linux/macOS），同理；
   - **不要**再额外追加当前 PATH（避免重复倍增）。
5. Windows 下对环境字典做大小写归一：找到已存在的 `Path`/`PATH` 键，统一写同一个键，
   避免 Popen 收到两个同名不同大小写的键。

### 4.4 结果标记协议（P1，可选）

工具可以在 stdout 打印一行：

```text
[elab-result] {"memory":{"flash":{"used":786432,"total":2097152,"pct":37.5},
                          "ram":{"used":123456,"total":524288,"pct":23.5}},
               "artifacts":{"elf":"build/esp32s31_korvo.elf","bin":"build/esp32s31_korvo.bin"}}
```

内核行为：

- 以 `result.marker` 为前缀的行 → `json.loads` → 合并进 `StepOutcome.extra`；
- 该行默认**不**再进日志通道（避免噪声）；解析失败则原样当普通日志。
- 没有该协议时：`extra` 只有 `exit_code`，面板内存域显示「无数据」——**不造假数字**。

> 为什么不做 `result_parser: idf_size`：那会把 ESP-IDF 业务词汇写进内核，违反分层规则。
> 标记协议是通用协议，解析逻辑留在项目自己的包装脚本里。

### 4.5 日志 / 事件契约（不改 ICD）

| 委托步骤 | 事件 `step` | 通道 | 证据 |
|---|---|---|---|
| `doctor` | `doctor` | build | `proc/stdout` + `run/step-exit` |
| `build` | `build` | build | 同上 |
| `flash` | `flash` | flash | 同上 |
| `debug_verify` | `debug_verify` | debug | 同上 |
| `monitor` | `monitor` | serial | 原生 `serial/*` |

**不做的事**：

- 不新增 topic；
- 不让工具自己写事件文件（单写者原则，ICD §5.3）；
- 不改 `STEP_META` / `KERNEL_PLANS`（工具层自动跟随）。

### 4.6 退出码 → verdict

`_run_tool` 是**二元**判定：

| 情况 | `ok` | `verdict` | detail |
|---|---|---|---|
| `exit=0` | true | `ok`（沿用总账） | 最后一行输出 |
| `exit!=0` | false | `failed` | `exit=N` + 最后一行 |
| 超时 | false | `failed` | `timeout after Ns` |
| 命令不存在 / cwd 不存在 | false | `failed` | 解析期错误（`ElabError`） |

`inconclusive` **只属于原生 `monitor`**。委托步骤不要伪造三态。

### 4.7 可用性矩阵

| 步骤 | 原生模式 | 委托模式 |
|---|---|---|
| `doctor` | 恒可用 | 恒可用（工具缺失 → 运行时报错） |
| `build` | 恒可用 | 恒可用 |
| `flash` | 需要 `debug.probe` 在 `host.probes.list` | **不需要探针**；只看委托 |
| `debug_verify` | 需要探针 | **不需要探针**；只看委托 |
| `monitor` | 需要 `monitor.close_on` + 串口后端 | 同左（不委托） |
| `debug`（调试工作区） | 需要探针 + ELF | **本轮不可用**（无探针；UI 隐藏入口） |

---

## 5. 内核改动清单（逐文件可执行）

> 全部改动属于**业务层**，符合 AGENTS.md 硬规则 1；工具层不需要改业务逻辑。

### 5.1 `services/elab/run.py`

#### (1) 新增委托判定

```python
def _delegated_tool(cfg: Config, project: str, step: str) -> str:
    """steps.<step> == 'tool:<name>' → 返回 name；否则返回 ''。"""
    proj = cfg.resolved_project(project)
    spec = (proj.get("steps") or {}).get(step)
    if isinstance(spec, str) and spec.startswith(TOOL_PREFIX):
        name = spec[len(TOOL_PREFIX):].strip()
        if name:
            return name
    return ""
```

#### (2) `_execute` 顶部插入分发

位置：`_execute` 函数体第一行（当前 235 行附近）。

```python
def _execute(cfg, step, project, *, clean, jobs, verbose, sink, elog=None):
    tool_name = _delegated_tool(cfg, project, step)
    if tool_name:
        out = _run_tool(cfg, project, tool_name, sink=sink)
        out.extra["delegated_to"] = f"{TOOL_PREFIX}{tool_name}"
        return out
    # ── 以下为原原生分支，不改 ──
```

★ `sink` 由调用方 `io.sink(step)` 绑定，所以日志天然落规范步骤通道。
**不要把 `step` 改写成 `tool:<name>`**。

规范化额外校验（`run()` 启动前）：

```python
# 对每个 step：若 steps.<step> 声明了 tool:<name>，则 tools.<name> 必须存在
for s in steps:
    name = _delegated_tool(cfg, project, s)
    if name and name not in ((cfg.resolved_project(project).get("tools") or {})):
        raise RunError(f"steps.{s} 委托给未声明的 tools.{name}")
```

这样失败发生在 spawn 之前，面板能立刻显示原因，不会跑到一半才报错。

#### (3) `preview` 支持委托

位置：`preview` 的 for 循环内、原生 `build/flash/...` 分支之前（434 行之前）。

```python
tool_name = _delegated_tool(cfg, project, step)
if tool_name:
    try:
        argv, cwd, label = _resolve_tool(cfg, project, tool_name)
        entry["commands"] = [argv]
        entry["work_dir"] = cwd
        entry["note"] = f"委托给 tools.{tool_name}（{label}，cwd={cwd}）"
    except (RunError, ElabError) as exc:
        entry["blocked"] = True
        entry["note"] = str(exc)
    plan.append(entry)
    continue
```

> ★ 必须放在原生分支之前：否则 ESP32 的 `build` 预览会去构造 ARM cmake 命令，
> 用户看到的是**错的命令**（违反「预览与实跑不分叉」的既有原则）。

#### (4) `_resolve_tool` 增强

```python
proj = cfg.resolved_project(project)
t = (proj.get("tools") or {})[name]
env_spec = t.get("env") or {}

subs = {
    "serial_port": "", "root": root, "work_dir": work_dir,
    "name": project, "runs_dir": runs_dir,
}

def _sub(s: str) -> str:
    for k, v in subs.items():
        s = s.replace("${" + k + "}", v)
    # ${env:NAME}
    def _env_repl(m):
        key = m.group(1)
        if key in env_spec:
            return str(env_spec[key])
        if key in os.environ:
            return os.environ[key]
        raise RunError(f"tools.{name} 引用了未定义环境变量 ${{env:{key}}}")
    return re.sub(r"\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}", _env_repl, s)
```

`argv` / `cwd` / `env_prepend_path` / `env_from_cmd.cmd` 都走 `_sub`。

#### (5) `_run_tool` 增强

```python
def _run_tool(cfg, project, name, *, sink) -> StepOutcome:
    argv, cwd, label = _resolve_tool(cfg, project, name)
    t = (cfg.resolved_project(project).get("tools") or {}).get(name) or {}

    env = dict(os.environ)
    env.update({str(k): str(_sub(str(v))) for k, v in (t.get("env") or {}).items()})
    _apply_env_from_cmd(env, t)          # 见 4.3
    for d in (t.get("env_prepend_path") or []):
        env = _prepend_path(env, str(_sub(d)))

    timeout_s = t.get("timeout_s")
    marker = ((t.get("result") or {}).get("marker") or "").strip()
    ...
    proc = subprocess.Popen(
        argv, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        **proc_kwargs(),
    )
    timer = threading.Timer(float(timeout_s), _kill_tree, args=(proc,)) \
            if timeout_s else None
    if timer: timer.start()
    extra, tail = {}, ""
    try:
        for line in proc.stdout:
            line = line.rstrip("\r\n")
            if marker and line.startswith(marker):
                try:
                    extra.update(json.loads(line[len(marker):]))
                except json.JSONDecodeError:
                    sink(line)                       # 坏的标记不吞
                continue
            if line:
                tail = line
                sink(line)
        rc = proc.wait()
    finally:
        if timer: timer.cancel()
    ...
```

`_kill_tree`（Windows）：

```python
def _kill_tree(proc):
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       capture_output=True, text=True, errors="replace", check=False)
    else:
        try: os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except OSError: pass
```

> 与 `RunManager.cancel` 同一条命令，行为一致；区别只是触发者是超时而不是人。

#### (6) 命令可执行性预检

在 `_run_tool` 拉起前：

```python
if not os.path.isabs(argv[0]):
    exe = shutil.which(argv[0], path=env.get("PATH"))
    if not exe:
        raise RunError(f"tools.{name} 的命令不存在：{argv[0]}（PATH 未命中）")
if not os.path.isdir(cwd):
    raise RunError(f"tools.{name}.cwd 不存在：{cwd}")
```

错误在 `run/step-exit` 的 `detail` 里可见，不必等 0.5s 才由操作系统抛 `FileNotFoundError`。

### 5.2 `cockpit/server.py`

#### (1) 可用性解耦

位置：`project_cards` 的 `if not (probe and probe in probes):`（627 行）。

```python
def _delegated(proj: dict, step: str) -> bool:
    spec = (proj.get("steps") or {}).get(step)
    return isinstance(spec, str) and spec.startswith(run_mod.TOOL_PREFIX)

if not (probe and probe in probes):
    reason = (...)
    if not _delegated(proj, "flash"):
        avail["flash"] = {"ok": False, "reason": reason}
    if not _delegated(proj, "debug_verify"):
        avail["debug_verify"] = {"ok": False, "reason": reason}
```

#### (2) 卡片暴露委托关系（供 UI 解释）

在 `cards.append({...})` 中新增**派生字段**：

```python
"delegated": {s: _delegated(proj, s) for s in run_mod.ALL_STEPS},
"step_labels": dict(proj.get("step_labels") or {}),
```

工具层只渲染，不推断。这样面板可以在「编译」按钮上显示「由项目工具 idf_build 执行」，
避免用户以为是内核原生 cmake；`debug_verify` 在 ESP32 项目上显示「烧录校验」，
在 STM32 项目上仍显示「调试校验」。

#### (3) 不改 `STEP_META` / `KERNEL_PLANS`

步骤标签**默认值**、通道、三档定义保持不变；ESP32 复用「三连」「闭环」同名按钮。
项目级差异只经 `step_labels` 覆盖，不改全局词汇。

前端渲染规则（工具层）：

```text
label(step) = project.step_labels[step] ?? STEP_META[step].label
```

若内核过旧、卡片没有 `step_labels` 字段 → 回落 `STEP_META`（不写 ESP32 特判）。

#### (4) 调试入口

`DEBUG_META` 是**内核能力上限**，不再直接当作项目能力用于渲染。收敛链：

```text
snapshot.features（会话，实际探测）
  ?? project.debug_features（项目卡片，按芯片声明）
  ?? DEBUG_META.features（全局，仅兜底）
```

- `server.py` 的 `_debug_features(chip)`：基础页签 + 芯片 `debug.svd` 存在才加 `svd`；
  `debug.rtos is not False` 才加 `rtos`。ESP32 未声明 SVD → 不出现「外设」页签。
- 面板在会话打开前按 `project.debug_features` 渲染，打开后以 `snapshot.features` 为准；
  工具层不写「ESP32 不调试」的硬编码分支。

### 5.3 `services/elab/config.py`（P0）

`chip_of` 增加项目固定包解析（见 4.1.2）。现有 `chips` 属性（第 99–138 行）
只遍历 `[active_pack]`；把它抽成 `_load_chips(records)` 后两处共用：

```python
def _load_chips(self, records: list[dict]) -> dict:
    """从给定包记录加载 {ref|id: chip}；与 chips 属性同一套重复校验。"""
    out, by_ref, by_id = {}, {}, {}
    for rec in records:
        chips_dir = Path(rec["dir"]) / "chips"
        ...
        chip["_pack"] = rec["name"]
        out[ref] = chip
        out.setdefault(chip["id"], chip)
    return out

def chips(self) -> dict:
    rec = self.active_pack
    return self._load_chips([rec] if rec else [])

def chip_of(self, proj):
    ref = proj.get("chip")
    pinned = (proj.get("pack") or "").strip()
    if pinned:
        rec = self.packs.get(pinned)           # discover() 的 {"name": record}
        if not rec:
            raise ElabError(
                f"项目 {proj.get('name')} 固定包未安装：{pinned}"
                f"（先执行 elab pkg install {pinned}）")
        cache = self._pinned_chips.setdefault(pinned, self._load_chips([rec]))
        chip = cache.get(ref) or cache.get(str(ref).split("/")[-1])
        if chip:
            return chip
        raise ElabError(f"包 {pinned} 内没有芯片 {ref}")
    ...现有 active_pack 逻辑...
```

要点：

- 记录字段用 `rec["dir"]`（`pkg.discover` 返回），不是 `rec["path"]`；
- `self._pinned_chips = {}` 在 `__init__` 初始化，是新增的按包缓存，避免每次 `chip_of` 重扫目录；
- 固定包解析**不修改** `active.json`，只读；
- 若 `chip` 写成 `vendor/id`，也可回落到裸 id（与 `chips` 属性同一口径）。

### 5.4 测试清单

内核（`services/elab/tests` 或现有测试位置）：

1. `test_delegated_step_uses_canonical_step_name`
   - 临时项目 YAML：`steps.build: tool:fake`；工具打印 `hello`
   - 断言事件 `proc/stdout` 的 `step == "build"`，通道归类为 build。
2. `test_delegated_preview_no_native_command`
   - `preview(steps=["build"])` 的 commands 只有工具命令，不含 cmake。
3. `test_delegated_flash_available_without_probe`
   - `project_cards()` 中 `steps.flash.ok == True`。
4. `test_tool_env_from_cmd_key_value`
   - 假命令输出 `A=1\nPATH=/x/%PATH%\nWARNING: x`；断言 A=1、PATH 正确、WARNING 未污染。
5. `test_tool_timeout_kills_tree`
   - 假命令 `sleep 10` + `timeout_s: 1`；断言步骤 failed 且进程退出。
6. `test_tool_missing_cmd_fail_fast`
   - `cmd: ["definitely-not-exist"]` → `run/step-exit` 失败，detail 可读。
7. `test_pack_pinning_resolves_chip`（P0，必须）
   - 两个包同时安装，active=STM32，项目 `pack: espressif/esp32` 仍能解析。
8. `test_pack_pinning_missing_pack_clear_error`
   - 固定包未安装 → 报错文案包含包名，不吞成 `KeyError`。
9. `test_step_labels_exposed_and_merged`
   - `step_labels: {debug_verify: 烧录校验}` → `/api/projects` 原样暴露；
   - 不声明时字段为空 dict，前端回落 `STEP_META`。

回归：现有 STM32 / AT32 项目不声明 `steps`，必须与前一致（零行为变化）。

---

## 6. ESP32 接入实施

### 6.1 本机环境事实（已实测，2026-11-04）

| 项 | 值 |
|---|---|
| ESP-IDF | `C:\esp\v6.1\esp-idf`，**v6.1** |
| 工具根 | `IDF_TOOLS_PATH=C:\Espressif`（EIM 布局） |
| Python venv | `C:\Espressif\tools\python\v6.1\venv` |
| venv python | `C:\Espressif\tools\python\v6.1\venv\Scripts\python.exe` |
| esptool | **v5.3.1**，支持 `--chip esp32s31`、`verify-flash` |
| 默认 `~/.espressif` | **不是**本机工具目录（里面只有 `dist`） |

**实测踩坑（会直接导致「面板点了就失败」）**：

1. 直接 `python <idf>\tools\idf_tools.py export` → 报所有工具「no installed versions」，
   因为它默认去 `~/.espressif`。
   **必须**先设 `IDF_TOOLS_PATH=C:\Espressif`。
2. 用系统 Python 调 `idf.py` → `No module named 'rich_click'`。
   **必须**用 venv python。
3. 只设 `IDF_PYTHON_ENV_PATH` 不够，`idf.py` 仍会去找
   `C:\Espressif\python_env\idf6.1_py3.12_env`（EIM 的实际 venv 在 `tools\python\v6.1\venv`）。
4. 不设 `ESP_IDF_VERSION` → `idf_component_manager` 抛
   `TypeError: expected string ..., got 'NoneType'`。
   **必须**从 export 输出获得 `ESP_IDF_VERSION=6.1`。

已验证可用的最小环境：

```powershell
$env:IDF_TOOLS_PATH='C:\Espressif'
$env:IDF_PYTHON_ENV_PATH='C:\Espressif\tools\python\v6.1\venv'
$env:ESP_IDF_VERSION='6.1'
& 'C:\Espressif\tools\python\v6.1\venv\Scripts\python.exe' `
  'C:\esp\v6.1\esp-idf\tools\idf.py' --version
# → ESP-IDF v6.1
```

### 6.2 目标工程事实

#### 本轮验收：`examples/ESP32S31_Korvo`（新建，替代外部 hello_world）

用户已定：**本轮不动 `pet_companion`，先把 esp32s31 最小工程放进本仓 `examples/` 跑通。**

新建目录（与现有 `examples/STM32F103C8T6` 同级）：

```text
examples/ESP32S31_Korvo/
├── CMakeLists.txt              # project(esp32s31_korvo)
├── sdkconfig.defaults          # CONFIG_IDF_TARGET="esp32s31" + 16MB flash
└── main/
    ├── CMakeLists.txt
    └── heartbeat_main.c        # WS2812(GPIO37) + 1Hz [alive]
```

| 项 | 值 |
|---|---|
| 顶层 CMake | `project(esp32s31_korvo)`；`include($ENV{IDF_PATH}/tools/cmake/project.cmake)` |
| target | `esp32s31`（RISC-V） |
| flash | 16MB（Korvo 板载；`sdkconfig.defaults` 固化） |
| 产物 | `build/esp32s31_korvo.elf`、`build/esp32s31_korvo.bin` |
| 烧录分段 | bootloader `0x2000`、partition `0x8000`、app `0x10000` |
| 串口 | UART0，115200（板载 USB-UART） |
| 固件 | heartbeat：1Hz `[alive]` + 500ms RGB 翻转（见 §6.6） |

> ★ 为什么另建示例：外部 `esp32s31` 是 hello_world，会每 11s `esp_restart()`，
> 不能作为第一关的稳定心跳源；示例工程把「心跳 + RGB」固化，后续所有芯片接入都复用它。

#### 后续（本轮不验收）：`pet_companion`（`C:\Users\xiao1\Desktop\esp32\pet_companion`）

| 项 | 值 |
|---|---|
| 顶层 CMake | `project(display_audio_photo)`；`littlefs_create_partition_image(storage littlefs_content)` |
| target | `esp32s31` |
| flash | 16MB |
| 产物 | `build/display_audio_photo.elf`、`build/display_audio_photo.bin` |
| 烧录分段 | bootloader `0x2000`、partition `0x8000`、otadata `0x11000`、app `0x20000` |
| 自定义分段 | `storage, data, littlefs, 0x7E0000, 0x820000`（**不在** `flasher_args.json` 里） |
| 串口 | UART0，115200；VS Code 配 `COM9` |
| 额外目标 | `idf.py storage-flash`（只烧 8.12MB 素材镜像） |

> 保留其 YAML 草案（见 §6.3 末尾）供后续直接启用；本轮**不编译、不烧录、不验收**。

### 6.3 项目 YAML（本轮验收）

#### `projects/esp32s31_korvo.yaml`

```yaml
name: esp32s31_korvo
root: ${ELAB_ROOT}/examples/ESP32S31_Korvo
pack: espressif/esp32        # P0：固定包，不受 active pack 影响
chip: esp32s31
archetype: idf

build:
  kind: cmake
  work_dir: ${root}/build
  project_name: esp32s31_korvo
  generator: Ninja            # 仅用于卡片展示；实际由 idf.py 决定

artifacts:
  elf: ${root}/build/esp32s31_korvo.elf
  bin: ${root}/build/esp32s31_korvo.bin
  map: ${root}/build/esp32s31_korvo.map   # 委托构建后由内核解析，回填 RAM/FLASH

steps:
  doctor: tool:idf_env_check
  build: tool:idf_build
  flash: tool:idf_flash
  debug_verify: tool:idf_verify

step_labels:
  debug_verify: 烧录校验      # 只改显示；ARM 项目仍显示「调试校验」

serial:
  port: auto
  baud: 115200

monitor:
  close_on:
    - { kind: contains, pattern: "[alive]", within_s: 20 }
  fail_on:
    - { kind: regex, pattern: "Guru Meditation|assert failed|PANIC|abort\\(\\)" }
  idle_timeout_s: 30
  settle_s: 1.5

debug:
  probe: ""                    # ESP32 本轮不接调试器

# ★ elab 的 YAML 解析器不支持锚点/别名（_yaml.py 明确不支持 &x/*x），
#   所以每个工具都要把 env / env_from_cmd 写全；但路径值统一用 ${host:...}
#   引用 elab.host.yaml，不在项目 YAML 里写死任何绝对路径。
tools:
  idf_env_check:
    label: 检查 ESP-IDF 环境
    cwd: ${root}
    cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf.py", "--version"]
    env:
      IDF_TOOLS_PATH: "${host:tools.idf.tools_path}"
      IDF_PYTHON_ENV_PATH: "${host:tools.idf.venv}"
      ESP_IDF_VERSION: "${host:tools.idf.version}"
      IDF_PATH: "${host:tools.idf.idf_path}"
      IDF_PY: "${host:tools.idf.python}"
    env_from_cmd:
      cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf_tools.py",
            "export", "--format", "key-value"]
      format: key-value
      path_key: PATH
    timeout_s: 120

  idf_build:
    label: ESP-IDF 编译
    cwd: ${root}
    cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf.py", "-B", "build", "build"]
    env:
      IDF_TOOLS_PATH: "${host:tools.idf.tools_path}"
      IDF_PYTHON_ENV_PATH: "${host:tools.idf.venv}"
      ESP_IDF_VERSION: "${host:tools.idf.version}"
      IDF_PATH: "${host:tools.idf.idf_path}"
      IDF_PY: "${host:tools.idf.python}"
    env_from_cmd:
      cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf_tools.py",
            "export", "--format", "key-value"]
      format: key-value
      path_key: PATH
    timeout_s: 900

  idf_flash:
    label: esptool 烧录
    cwd: ${root}
    cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf.py",
          "-B", "build", "-p", "${serial_port}", "flash"]
    env:
      IDF_TOOLS_PATH: "${host:tools.idf.tools_path}"
      IDF_PYTHON_ENV_PATH: "${host:tools.idf.venv}"
      ESP_IDF_VERSION: "${host:tools.idf.version}"
      IDF_PATH: "${host:tools.idf.idf_path}"
      IDF_PY: "${host:tools.idf.python}"
    env_from_cmd:
      cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf_tools.py",
            "export", "--format", "key-value"]
      format: key-value
      path_key: PATH
    timeout_s: 600

  idf_verify:
    label: esptool 烧录校验
    cwd: ${root}
    cmd: ["${env:IDF_PY}", "-m", "esptool",
          "--chip", "esp32s31", "-p", "${serial_port}", "verify-flash",
          "${json_args:${root}/build/flasher_args.json#flash_files}"]
    env:
      IDF_TOOLS_PATH: "${host:tools.idf.tools_path}"
      IDF_PYTHON_ENV_PATH: "${host:tools.idf.venv}"
      ESP_IDF_VERSION: "${host:tools.idf.version}"
      IDF_PATH: "${host:tools.idf.idf_path}"
      IDF_PY: "${host:tools.idf.python}"
    env_from_cmd:
      cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf_tools.py",
            "export", "--format", "key-value"]
      format: key-value
      path_key: PATH
    timeout_s: 600
```

#### `projects/pet_companion.yaml`（后置草案，本轮不验收）

> 仅作未来业务验证的参考；本轮不创建、不运行。启用时相对 `esp32s31_korvo.yaml` 只改：

| 字段 | pet_companion 取值 |
|---|---|
| `root` | `C:/Users/xiao1/Desktop/esp32/pet_companion` |
| `build.project_name` | `display_audio_photo` |
| `artifacts.elf/bin` | `build/display_audio_photo.elf` / `.bin` |
| `serial.port` | `COM9`（两块板同时插时必须显式） |
| `monitor.close_on` | `AI_ACT: caps` 或 `[pet_device]`（启用前抓真实启动日志确认） |
| `monitor.idle_timeout_s` | `60` |
| `tools.idf_build.timeout_s` | `1800` |
| `tools.idf_verify` 分段 | 加 `0x11000 ota_data_initial.bin`、app 改 `0x20000` |
| 额外工具 | `idf_storage_flash`（`idf.py storage-flash`，单独点按，不进三连） |

**说明**：

- `idf_storage_flash` 不要塞进 `steps.flash`：否则每次三连都要写 8.12MB，
  闭环从几秒变几分钟。
- `debug_verify` 校验**不包含 storage**：8.5MB 回读在 115200 下极慢。
  素材正确性由 `storage-flash` 自身的成功输出 + 运行日志证明。
- `monitor.close_on` 用业务日志关键字；若启动日志不稳定，优先修固件日志，不要放宽判据。
- 本轮不写该 YAML，避免未验证配置进入仓库。

### 6.4 命令为什么这样写

| 选择 | 理由 |
|---|---|
| 用 `idf.py -B build` | 显式构建目录，避免 IDF 因 `build` 被删而重新 configure 到别处 |
| 不直接调 cmake/ninja | ESP-IDF 的 build 依赖大量环境变量与组件管理器；`idf.py` 是官方稳定入口 |
| 烧录用 `idf.py flash` | 自动读取 `flasher_args.json`，分段偏移永远与工程一致（不手抄 `0x10000`） |
| 校验用 `esptool verify-flash` | 支持一次多组 `addr file`；是「烧录后回读」最直接的证据 |
| 端口用 `${serial_port}` | 复用内核选口规则（显式优先、auto 排除蓝牙口） |
| 不用 `idf.py monitor` | 内核已有更强的串口判据/事件/波形；两套监视器会抢同一个口 |

### 6.5 active pack 冲突（已拍板：P0 固定包）

**本轮直接实现项目级 `pack` 固定**，不再提供「手动 `elab pkg use`」的临时路径：

- `projects/esp32s31_korvo.yaml` 写 `pack: espressif/esp32`；
- `Config.chip_of` 优先在该包内解析 `chip: esp32s31`；
- STM32/AT32 项目继续用当前 `active_pack`；
- 两个项目可同时打开、同时编译，互不切换。

不推荐「把 ESP32 芯片塞进 `st/stm32` 包」——违反 AGENTS 规则 5（芯片知识只写对应适配包）。

前置条件：`espressif/esp32` 包必须先安装（`elab pkg install espressif/esp32`）。
若未安装，运行时报明确错误（§5.4 测试 8），不静默回落到 active pack。

### 6.6 第一关：heartbeat bring-up（硬要求）

ESP32 接入必须先过心跳关，再跑业务工程。外部 `esp32s31` 是 hello_world（会重启），
`pet_companion` 是完整业务固件；两者都**不能**替代 heartbeat。本轮使用
`examples/ESP32S31_Korvo` 的 heartbeat 固件。

**板载 RGB LED 事实**（ESP32-S31-Korvo-1 V1.1 官方用户指南）：

- 板载灯是**可寻址 RGB（WS2812）**，由 **GPIO37** 驱动（信号名 `WS2812_CTRL`）；
- **不是**普通 GPIO，不能用 `gpio_set_level` 点亮；
- 必须走 RMT（推荐）或 SPI bit-bang；
- 官方示例 `examples/peripherals/rmt/led_strip_simple_encoder` 提供无额外组件的
  RMT 简单编码器写法，本方案直接采用。

**固件要求**（依据 AGENTS.md「芯片闭环第一关」）：

1. 1Hz 打印一行：
   ```text
   [alive] tick=123 toggles=246 stage=boot
   ```
2. LED 与心跳**同一时基**：每 500ms 翻转一次（`toggles` 每次心跳 +2）。
   翻转语义是「红亮 ↔ 全灭」，不是换颜色。
3. 不阻塞主循环：两个 `esp_timer` 周期回调（500ms / 1s）；
   RMT 发送是**非阻塞入队**，不在回调里 `rmt_tx_wait_all_done`。
4. GPIO **固定 37**（官方文档），不再猜。
5. 验收：
   - agent 用 `elab monitor` 抓包：相邻 `[alive]` 间隔 ≈1.000s；`toggles` 严格 +2；
   - **用户肉眼确认 RGB 灯均匀闪烁（亮灭周期 1s）**并回报；
   - 两方都拿到信息才算通过。

**参考实现**（`examples/ESP32S31_Korvo/main/heartbeat_main.c`）：

```c
#include <stdbool.h>
#include <stdio.h>
#include "esp_timer.h"
#include "esp_check.h"
#include "driver/rmt_tx.h"

#define LED_GPIO           37          // ESP32-S31-Korvo-1: WS2812_CTRL
#define RMT_RESOLUTION_HZ  10000000    // 10MHz，1 tick = 0.1us
#define LED_BRIGHTNESS     32          // 低调亮度，避免刺眼

static rmt_channel_handle_t s_led_chan;
static rmt_encoder_handle_t s_encoder;
static uint8_t s_pixel[3];             // WS2812 顺序：G R B
static volatile uint32_t s_tick, s_toggles;

static const rmt_symbol_word_t ws_zero = {
    .level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9,   // T0H/T0L
};
static const rmt_symbol_word_t ws_one = {
    .level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3,   // T1H/T1L
};
static const rmt_symbol_word_t ws_reset = {
    .level0 = 0, .duration0 = 250, .level1 = 0, .duration1 = 250, // 50us
};

static size_t encode_cb(const void *data, size_t data_size,
                        size_t symbols_written, size_t symbols_free,
                        rmt_symbol_word_t *symbols, bool *done, void *arg)
{
    if (symbols_free < 8) return 0;
    size_t pos = symbols_written / 8;
    const uint8_t *bytes = (const uint8_t *)data;
    if (pos < data_size) {
        size_t n = 0;
        for (int bit = 0x80; bit; bit >>= 1)
            symbols[n++] = (bytes[pos] & bit) ? ws_one : ws_zero;
        return n;
    }
    symbols[0] = ws_reset;
    *done = 1;
    return 1;
}

static void led_set(bool on)
{
    s_pixel[0] = 0;                              // G
    s_pixel[1] = on ? LED_BRIGHTNESS : 0;        // R
    s_pixel[2] = 0;                              // B
    // 非阻塞入队；队列深度 4，500ms 一次不会溢出
    rmt_transmit(s_led_chan, s_encoder, s_pixel, sizeof(s_pixel),
                 &(rmt_transmit_config_t){ .loop_count = 0 });
}

static void led_cb(void *arg)
{
    s_toggles++;
    led_set(s_toggles & 1);
}

static void alive_cb(void *arg)
{
    s_tick++;
    printf("[alive] tick=%lu toggles=%lu stage=boot\n",
           (unsigned long)s_tick, (unsigned long)s_toggles);
    fflush(stdout);
}

void app_main(void)
{
    rmt_tx_channel_config_t tx_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .gpio_num = LED_GPIO,
        .mem_block_symbols = 64,
        .resolution_hz = RMT_RESOLUTION_HZ,
        .trans_queue_depth = 4,
    };
    ESP_ERROR_CHECK(rmt_new_tx_channel(&tx_cfg, &s_led_chan));

    const rmt_simple_encoder_config_t enc_cfg = { .callback = encode_cb };
    ESP_ERROR_CHECK(rmt_new_simple_encoder(&enc_cfg, &s_encoder));
    ESP_ERROR_CHECK(rmt_enable(s_led_chan));

    led_set(false);                              // 初始灭

    esp_timer_handle_t led_timer, alive_timer;
    const esp_timer_create_args_t led_args = { .callback = led_cb, .name = "led" };
    const esp_timer_create_args_t alive_args = { .callback = alive_cb, .name = "alive" };
    ESP_ERROR_CHECK(esp_timer_create(&led_args, &led_timer));
    ESP_ERROR_CHECK(esp_timer_create(&alive_args, &alive_timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(led_timer, 500000));    // 500ms
    ESP_ERROR_CHECK(esp_timer_start_periodic(alive_timer, 1000000)); // 1s
}
```

`sdkconfig.defaults` 至少包含：

```ini
CONFIG_IDF_TARGET="esp32s31"
CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y
CONFIG_ESP_CONSOLE_UART_DEFAULT=y
CONFIG_ESP_CONSOLE_UART_BAUDRATE=115200
```

> 为什么不用 `led_strip` 组件：它要走组件管理器下载依赖，而最小示例应该
> 「clone 下来只装 IDF 就能编」。上面的 RMT simple encoder 无额外依赖。
> 心跳固件独立于业务固件；**第一关通过后再跑业务工程**。

### 6.7 ESP32 接入坑位清单

| 坑 | 症状 | 处理 |
|---|---|---|
| 系统 Python 调 `idf.py` | `No module named 'rich_click'` | 用 venv python |
| 未设 `IDF_TOOLS_PATH` | 所有工具「no installed versions」 | 固定为 `C:\Espressif` |
| 未设 `ESP_IDF_VERSION` | `TypeError: ... got 'NoneType'` | 从 export 取 `6.1` |
| PATH 未合并 | `cmake/ninja/riscv32-esp-elf` 找不到 | 必须 `env_from_cmd` 合并 export 的 PATH |
| PATH 里 `%PATH%` 字面量 | PATH 变成无意义字符串 | 用当前 PATH 替换 `%PATH%` |
| Windows 环境键大小写 | `Path` 与 `PATH` 同时存在，行为不稳 | 环境字典大小写归一 |
| 工程名 ≠ 目录名 | `artifacts.elf/bin` 指错 | 显式写 `build/<project>.elf` |
| Korvo 板载灯是 WS2812 | `gpio_set_level` 点不亮 | RMT 编码（GPIO37），见 §6.6 |
| `pet_companion` storage 不在 flasher_args | 首烧后素材缺失 | 首次/换片后跑 `storage-flash` |
| 进度输出带 `\r` | 面板一行刷屏/撕裂 | 已由 `rstrip("\r\n")` 处理；必要时按 `\r` 切段 |
| `idf.py` 增量构建长时间无输出 | 用户以为卡死 | `run/step-enter` + 首行命令回显；必要时加进度提示 |
| 串口被 `idf.py monitor` 占用 | `elab monitor` 打开失败 | 不要在外部开 monitor；`idf.py flash` 结束会释放 |
| 端口歧义（两块板同时插） | `auto` 选不到口 | 项目 YAML 显式写 `serial.port` |

---

## 7. 调试范围

### 7.1 最初的裁剪结论（M6 已部分推翻）

> 本节保留原始裁剪理由；M6 已完成「RISC-V GDB 后端」代码（见 §10 M6），
> 硬件验证仍受限于 Korvo-1 无板载 USB-JTAG。

理由：

1. ESP32-S31 是 RISC-V，内核现有调试链路假设 ARM/CMSIS-SVD/`break main`；
2. `debug_verify` 本轮已用 `esptool verify-flash` 承担「烧录后校验」语义；
3. 面板调试工作区依赖探针（`debug.probe`），ESP32 用 USB-JTAG/OpenOCD 是另一套配置；
4. 先保证三连/闭环/串口第一关，调试后置风险更低。

**UI 行为（M6 起）**：芯片声明 `debug.backend`（如 `esp-idf`）时，即使 `probe` 为空，
调试页签也保持可用（面板「探针」胶囊显示「调试后端」）；
`debug_verify` 按钮标签由项目 YAML 的 `step_labels` 覆盖为 **「烧录校验」**，
STM32/AT32 仍显示「调试校验」。内核 `STEP_META` 不改，工具层只做「项目覆盖优先」。

### 7.2 未来：RISC-V GDB（可行性已确认）

ESP-IDF v6.1 **支持单步调试**，入口是：

```text
idf.py openocd        # 启 OpenOCD server（默认 :3333）
idf.py gdb            # 用 RISC-V GDB 连上，加载 gdbinit
```

`tools/idf_py_actions/debug_ext.py` 里存在 `gdb` / `openocd` 动作与
`gdbinit_files`（`symbols` / `prefix_map` / `py_extensions` / `connect`）。

未来接入需要内核新增：

1. **芯片调试描述**：`chips/esp32s31.yaml` 的 `debug` 段从 ARM 字段
   （`openocd_target/svd`）扩展为平台无关字段，例如：

   ```yaml
   debug:
     backend: openocd
     server_cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf.py", "openocd"]
     gdb_cmd: ["${env:IDF_PY}", "-m", "espflash", ...]  # 或直接 riscv32-esp-elf-gdb
     gdb_port: 3333
     gdbinit: "${env:IDF_PATH}/.../gdbinit"
     stop_at: main
   ```

2. **内核 `debugsession` 解耦**：把 `flash.debug(mode=verify)` 与 `debugsession`
   里写死的 `openocd_target/interface/svd` 改为读芯片 YAML 的 `debug.backend`；
3. **DAP/UI**：工具层只消费 `DEBUG_META`，不写死 ARM 名词。

这是一项独立工程，建议单独立项，不与本轮 ESP32 接入混做。

---

## 8. 芯片包上架（ESP32 纯数据包）

### 8.1 仓库结构（外置）

按 AGENTS 规则 8，ESP32 **不得**放进 `packs/official/**`，必须是外置 GitHub 仓库：

```text
xkk6663/elab-pack-espressif-esp32/
├── .gitattributes        # * -text   （必须；内容哈希按字节）
├── README.md
├── pack.yaml
└── chips/
    └── esp32s31.yaml
```

### 8.2 `pack.yaml` 草案

```yaml
schema_version: 1
name: espressif/esp32
vendor: espressif
platform: esp32
version: 0.1.0
license: Apache-2.0
status: community
description: ESP32-S31（RISC-V）芯片参数包；构建/烧录由项目自带 ESP-IDF 工具链完成

requires:
  kernel_api: ">=1 <2"
  schema_version: 1

# ★ 本轮 adapt 探测器只认 CubeMX 指纹；ESP-IDF 自动探测不在本轮。
#   这里先留空数组，用户手写项目 YAML 接入（见 §6）。
vendor_fingerprints: []
```

> 若希望「自动适配」ESP-IDF 工程，需要给 `adapt.py` 增加新的指纹类型
> （例如 `kind: idf_cmake`，匹配 `include($ENV{IDF_PATH}/tools/cmake/project.cmake)`）。
> 这是内核功能，不属于芯片包；建议作为后续 M4。

### 8.3 `chips/esp32s31.yaml` 草案

```yaml
id: esp32s31
vendor: espressif
family: esp32s31
platform: esp32
part: ESP32-S31
core_name: RISC-V 32-bit

core:
  arch: riscv
  cpu: esp32s31            # 占位：由 IDF 工具链决定，内核原生链路不消费
  fpu: none
  std: gnu17

memory:
  # 外部 flash 由板级决定：ESP32-S31-Korvo 示例按 16MB；以 sdkconfig 为准。
  # 芯片包不写死板级容量；写工程级事实时以 sdkconfig/flasher_args 为准。
  flash: { external: true, note: "容量见工程 sdkconfig / flasher_args.json" }
  ram:   { internal: true, note: "以 idf.py size 为准" }

# 本轮无内核调试后端；字段先声明事实，供未来 RISC-V GDB 使用。
debug:
  backend: openocd
  note: "idf.py openocd / idf.py gdb；本轮未接入"

verify:
  expect_target: esp32s31
  flash_chip: esp32s31

pitfalls:
  - "ESP32-S31-Korvo-1 的板载 RGB 是 WS2812，由 GPIO37 驱动；不能用 gpio_set_level。"
  - "工程目录名不等于 project() 名：artifacts 必须显式写 `build/<project>.elf|bin`。"
  - "`flasher_args.json` 只含 bootloader/partition/odata/app；littlefs 的 `storage` 分区不在其中，需单独 `idf.py storage-flash`。"
  - "ESP-IDF 工具链必须通过 `idf_tools.py export --format key-value` 注入；不要手写 PATH。"
  - "系统 Python 缺 `rich_click`，必须用 IDF venv python。"
  - "`esp32s31` 的 bootloader 偏移是 `0x2000`（不是常见的 `0x1000`），校验偏移必须取自 flasher_args.json。"
```

### 8.4 市场索引登记

`market/index.json` 现有字段（`name/vendor/platform/version/description/status/license/
requires/chips/source{type,url,ref|path}/sha256`）。ESP32 条目：

```json
{
  "name": "espressif/esp32",
  "vendor": "espressif",
  "platform": "esp32",
  "version": "0.1.0",
  "description": "ESP32-S31 芯片参数包（项目自带 ESP-IDF 工具链）",
  "status": "community",
  "license": "Apache-2.0",
  "requires": { "kernel_api": ">=1 <2", "schema_version": 1 },
  "chips": ["esp32s31"],
  "source": {
    "type": "git",
    "url": "https://github.com/xkk6663/elab-pack-espressif-esp32",
    "ref": "main"
  },
  "sha256": "<安装器按内容计算后回填>"
}
```

发布流程：

1. 外置仓库加 `.gitattributes`（`* -text`）；
2. `elab pkg index` 重新生成索引（CI `elab pkg index --check` 防漂移）；
3. 校验 `sha256` 与实际内容一致；
4. README 明确「本包不含工具链；需 ESP-IDF v6.1 + 项目自带环境」。

### 8.5 包能做什么 / 不能做什么

| 能 | 不能 |
|---|---|
| 描述芯片参数、内存、平台坑位 | 分发 `idf.py` / provider 脚本 / 预编译二进制 |
| 提供 `vendor_fingerprints`（未来） | 让内核为 ESP32 开业务分支 |
| 被 `elab pkg install` 安装/切换 | 依赖另一个包 |
| 被项目 `pack:` 固定 | 放进 `packs/official/**` |

---

## 9. 测试与验收

### 9.1 内核单测（必须新增）

见 §5.4 九条。全部离线，不依赖 ESP32 硬件。

### 9.2 离线联调（无板）

```powershell
# 0) 先装芯片包（只需一次）
elab pkg install espressif/esp32

# 1) 预览：确认命令是 ESP-IDF 的，不是 ARM cmake
elab run -p esp32s31_korvo --steps build,flash,debug_verify --dry-run

# 2) 只跑环境检查（不碰硬件）
elab run -p esp32s31_korvo --steps doctor

# 3) 编译
elab run -p esp32s31_korvo --steps build
```

验收点：

- `--dry-run` 输出 `idf.py ...` 且 `blocked=false`（除 ELF 未生成）；
- `doctor` 输出 `ESP-IDF v6.1`；
- `build` 结束 `exit=0`，日志出现在面板「编译」通道。

### 9.3 上板验收（需要用户配合）

| 项 | 判据 | 谁确认 |
|---|---|---|
| 心跳 | 相邻 `[alive]` ≈1.000s，`toggles` 每次 +2 | agent（串口抓包） |
| LED | 均匀闪烁（亮灭周期 1s） | **用户肉眼** |
| 烧录 | `idf.py flash` 成功，`esptool verify-flash` 全部 OK | agent |
| 串口闭环 | `monitor` 命中 `close_on`，verdict=ok | agent |
| 三连 | `build → flash → debug_verify` 三步全绿 | 面板/CLI |
| 面板日志 | build 进「编译」、flash 进「烧录」、verify 进「调试」 | 用户看面板 |
| 面板文案 | `debug_verify` 显示「烧录校验」；STM32 项目仍显示「调试校验」 | 用户看面板 |

> ★ 第一关未过（心跳或 LED 任一缺失）**不得**进入业务工程验收。

### 9.4 回归

- STM32F103C8T6 / AT32 项目不声明 `steps` → 行为必须与改动前逐字节一致；
- `elab.cmd doctor` 全绿；
- 插件 `npm test` / `tsc --noEmit` / `npm run build` 全绿（本轮工具层无代码改动，
  但 `delegated` 派生字段若被前端消费需同步类型）。

---

## 10. 阶段计划与退出标准

### M0 —— 契约与内核缝（不改行为）

- 新增 `_delegated_tool` + `_execute` 分发 + `preview` 分发；
- `_resolve_tool` 支持 `${env:NAME}`；
- `_run_tool` 支持 `env_from_cmd` / `env_prepend_path` / `timeout_s`；
- `server.py` 可用性解耦 + `delegated` / `step_labels` 派生字段；
- **`config.py` 项目级 `pack` 固定解析（P0）**；
- 单测 1–9。

**退出**：`npm test`/内核测试全绿；STM32/AT32 回归全绿；
`pack` 固定与 `step_labels` 均有用例覆盖。

### M1 —— `examples/ESP32S31_Korvo` 跑通三连

- 新建示例工程（CMakeLists / sdkconfig.defaults / heartbeat_main.c）；
- 写 `projects/esp32s31_korvo.yaml`（`pack: espressif/esp32`）；
- `doctor` / `build` / `flash` / `debug_verify` 四个工具；
- 上板：烧录 + `verify-flash` + 面板显示「烧录校验」。

**退出**：面板三连全绿，日志落对通道（编译/烧录/调试）。

### M2 —— 第一关（心跳 + RGB）

- heartbeat 固件在 GPIO37 上 WS2812 翻转；
- agent 串口判据：`[alive]` 1Hz、`toggles` +2；
- **用户肉眼确认 RGB 均匀闪烁**；
- `monitor` 闭环命中 `close_on`。

**退出**：agent 与用户双方都确认，第一关通过。

### M3 —— 芯片包上架

- 外置仓库 + `pack.yaml`（`espressif/esp32`）+ `chips/esp32s31.yaml`；
- 市场索引登记 + sha256；
- README/坑位（含 RGB GPIO37、ESP-IDF 环境注入）。

**退出**：另一台机器 `elab pkg install espressif/esp32` 后可解析 `chip: esp32s31`
（工具链仍需本机 ESP-IDF，属预期）；示例工程可直接跑三连。

**当前状态（2026-11-04）**：外置仓已创建并推送
`github.com/xkk6663/elab-pack-espressif-esp32`（commit `6b96b54d`，
topic `elab-pack`）；`market/index.json` 已登记同一个 `source.git.ref` 与
`sha256`，`elab pkg index --check` 通过；远端市场索引
`xkk6663/elab-pack-market` 已收录 `espressif/esp32`（ref/sha 与本仓一致），
`elab pkg search esp32` 可从远端索引命中。

### M5 —— ESP-IDF 自动适配指纹（已完成）

- 内核 `adapt.py` 新增通用 `kind: idf`：根 `CMakeLists.txt` include
  `.../tools/cmake/project.cmake` → vendor=espressif / generator=esp-idf（E4 结构）；
- 芯片读 `sdkconfig`（优先）/`sdkconfig.defaults` 的 `CONFIG_IDF_TARGET`，
  按 `chip.yaml: idf_target` 匹配（归一化大小写/连字符）；
- 生成 `archetype: idf` 项目 YAML：`pack:` 固定、`steps` 四项委托、
  `step_labels.debug_verify=烧录校验`、`tools.idf_*`（env + `env_from_cmd`）、
  `verify` 偏移来自芯片包；
- `Config.all_chips` / `vendor_fingerprints` 改为**全部已安装包**口径：
  接新芯片不必先切 `active`。

**验证**：`elab adapt examples/ESP32S31_Korvo` → 生成 `idf_adapt_probe.yaml` →
`doctor` 全通过、`build` 成功（无 idf.py venv 警告）。

### M6 —— RISC-V GDB 调试后端（代码已完成，硬件验证受阻）

- 芯片包 `debug.backend: esp-idf` +
  `openocd_interface: interface/esp_usb_jtag.cfg` + `openocd_target: target/esp32s31.cfg`；
- `elab.host.yaml` 新增 `tools.gdb_riscv` / `tools.openocd_esp32(.scripts)` /
  `tools.idf`（L0 只声明入口路径）；
- `Plan.debug_profile` 按 backend 切换 GDB/OpenOCD 脚本目录，ESP-IDF 不执行 GDB `load`
  （镜像已由 `idf.py flash` 烧入）；`flash._openocd_argv` 同步；
- 驾驶舱 `ProjectCard.debug_backend`：无 `probe` 时调试页签仍可用
  （芯片自带调试后端）；「探针」胶囊显示「调试后端」（探针仍需板载或外接）。

**硬件阻塞**：ESP32-S31-Korvo-1 V1.1 只有 USB-UART（CP210x）与 USB OTG Host 口，
**没有板载 USB-JTAG**；`openocd -f interface/esp_usb_jtag.cfg` 报
`could not find or open device`。GDB 调试需外接 JTAG 探针到芯片 JTAG 引脚，
并在工程 `debug.probe` 指定 host 探针。

### 后续（不在本轮）

- M4：`pet_companion` 业务验证 + `storage-flash`（用户已定后置，作为外部工程接入模板）；
- M7：C 方案 provider 插件注册表/分发/信任。

---

## 11. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| `idf.py` 输出巨量/长时间静默 | 面板卡顿、用户误判卡死 | `proc` 批量 100ms、有界队列；`timeout_s`；首行回显命令 |
| `env_from_cmd` 每次导出 | 每步多 ~1s | 进程内缓存 |
| PATH 合并错误 | 编译找不到工具链 | 单测 4 + 启动前 `shutil.which` 预检 |
| active pack 冲突 | ESP32/STM32 不能同时用 | `pack:` 固定（P0，本轮必做） |
| 端口被占用/歧义 | 烧录失败 | 显式 `serial.port`；错误信息带候选口 |
| `storage` 首烧遗漏 | 素材缺失、运行异常 | `idf_storage_flash` 工具 + README 提示 |
| WS2812 时序不准 | 灯不亮/颜色错 | 按 §6.6 的 RMT 10MHz 编码；GPIO37 已确认 |
| 工具超时杀树失败 | 残留进程占串口 | 复用 `taskkill /T /F`，与取消同路径 |
| 预览与实际命令分叉 | 用户误判 | 预览强制走委托分支（单测 2） |

**回滚**：所有改动都是「新增分支」。删除项目 YAML 的 `steps` 即回到原生模式；
内核侧保留 `TOOL_PREFIX` 既有行为，不需要数据迁移。

---

## 12. 已拍板决策与仍需确认项

### 12.1 已拍板（本轮执行，不再讨论）

| # | 决策 |
|---|---|
| 1 | **`pack` 固定本轮做（P0）**：项目 YAML `pack: espressif/esp32`，`chip_of` 优先该包。 |
| 2 | **ESP32 包名 `espressif/esp32`**（平台聚合），芯片文件 `chips/esp32s31.yaml`。 |
| 3 | **`debug_verify` 中文标签按项目覆盖**：ESP32 显示「烧录校验」，ARM 仍「调试校验」；`STEP_META` 不改。 |
| 4 | **`monitor` 不允许委托**：保三态与 `serial/*`；未来另设「串口 provider」。 |
| 5 | **本轮只跑 `examples/ESP32S31_Korvo` 最小工程**；`pet_companion` 后置，不验收。 |
| 6 | **板载 RGB 是 WS2812、GPIO37**；心跳用 RMT 编码，不用 `gpio_set_level`。 |

### 12.2 仍需确认（只影响后置项，不阻塞本轮）

1. **`pet_companion` 的 `monitor.close_on`**：`AI_ACT: caps` 还是 `[pet_device]`？
   等真正启用该项目时，先抓一次真实启动日志再定。
2. **WS2812 亮度**：`LED_BRIGHTNESS=32` 是否足够看清又不刺眼？第一关时按用户观感调。
3. **示例工程的 flash 容量**：按 Korvo 板 16MB 固化；若实际板卡不同，改
   `sdkconfig.defaults` 一处即可。

---

## 附录 A：实测命令与输出（2026-11-04）

### A.1 ESP-IDF 环境

```powershell
$env:IDF_TOOLS_PATH='C:\Espressif'
$env:IDF_PYTHON_ENV_PATH='C:\Espressif\tools\python\v6.1\venv'
$env:ESP_IDF_VERSION='6.1'
& 'C:\Espressif\tools\python\v6.1\venv\Scripts\python.exe' `
  'C:\esp\v6.1\esp-idf\tools\idf.py' --version
# 输出：ESP-IDF v6.1
```

### A.2 `idf_tools.py export`

```powershell
$env:IDF_TOOLS_PATH='C:\Espressif'
python 'C:\esp\v6.1\esp-idf\tools\idf_tools.py' export --format key-value
```

关键输出（节选）：

```text
OPENOCD_SCRIPTS=C:\Espressif\tools\openocd-esp32\v0.12.0-esp32-20260703\openocd-esp32\share\openocd\scripts
ESP_IDF_VERSION=6.1
PATH=C:\Espressif\tools\xtensa-esp-elf-gdb\...;C:\Espressif\tools\riscv32-esp-elf\...;...;%PATH%
```

> `PATH` 末尾的 `%PATH%` 是字面量，必须替换，不能直接当 PATH 用。

### A.3 esptool

```powershell
& 'C:\Espressif\tools\python\v6.1\venv\Scripts\python.exe' -m esptool --help
# esptool v5.3.1；--chip 支持 esp32s31；命令含 verify-flash
```

### A.4 工程产物与烧录分段

`esp32s31/build/flasher_args.json`：

```json
{
  "flash_files": {
    "0x2000": "bootloader/bootloader.bin",
    "0x8000": "partition_table/partition-table.bin",
    "0x10000": "esp32s31.bin"
  },
  "extra_esptool_args": { "chip": "esp32s31" }
}
```

`pet_companion/build/flasher_args.json`：

```json
{
  "flash_files": {
    "0x2000": "bootloader/bootloader.bin",
    "0x8000": "partition_table/partition-table.bin",
    "0x11000": "ota_data_initial.bin",
    "0x20000": "display_audio_photo.bin"
  },
  "extra_esptool_args": { "chip": "esp32s31" }
}
```

---

## 附录 B：C 方案 provider manifest 草案（未来预留）

> **已被 [技术方案_Provider工具链架构](技术方案_Provider工具链架构.md) 取代并定稿**：
> 该文补齐了 `defaults` 合并、`artifacts` 契约、`requires` 可用性、绑定优先级、
> 缺步骤不回退、市场 `kind: provider` 与 `ctx.provide()` 边界。本附录仅保留历史草案。

> 本轮**不实现**，仅证明 A 的字段可平滑升级。

```yaml
# providers/espressif-idf/provider.yaml
schema_version: 1
name: espressif/idf
version: 0.1.0
license: Apache-2.0
requires:
  kernel_api: ">=1 <2"

# provider 自带环境声明（由内核安装器/启动器解析）
env:
  IDF_TOOLS_PATH: C:/Espressif
  IDF_PYTHON_ENV_PATH: C:/Espressif/tools/python/v6.1/venv
  ESP_IDF_VERSION: "6.1"

env_from_cmd:
  cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf_tools.py",
        "export", "--format", "key-value"]
  format: key-value
  path_key: PATH

# 与 A 完全同构：规范步骤 → 命令模板
steps:
  build:
    cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf.py", "-B", "build", "build"]
    timeout_s: 900
  flash:
    cmd: ["${env:IDF_PY}", "${env:IDF_PATH}/tools/idf.py",
          "-B", "build", "-p", "${serial_port}", "flash"]
  debug_verify:
    cmd: ["${env:IDF_PY}", "-m", "esptool", "--chip", "${chip.flash_chip}",
          "-p", "${serial_port}", "verify-flash", "${flash_args}"]
```

C 阶段新增的只是：provider 安装/注册/版本解析/信任；执行器与事件契约**不变**。

---

## 附录 C：变更文件清单

| 文件 | 改动 | 阶段 |
|---|---|---|
| `services/elab/run.py` | 委托分发、preview、`${env:}`、env_from_cmd、timeout、预检 | M0 |
| `cockpit/server.py` | 可用性解耦、`delegated` 派生字段 | M0 |
| `services/elab/config.py` | `pack` 固定解析（P0） | M0 |
| `services/elab/_winproc.py` | 如需进程组标志（可选） | M0 |
| `projects/esp32s31_korvo.yaml` | 新示例工程 | M1 |
| `examples/ESP32S31_Korvo/**` | 最小心跳工程（WS2812 GPIO37） | M1/M2 |
| `projects/pet_companion.yaml` | 后置草案，不验收 | M4 |
| `packs` 外置仓 `elab-pack-espressif-esp32` | pack/chip YAML | M3 |
| `market/index.json` | 登记 ESP32 包 | M3 |
| `docs/design/技术方案_ESP32接入与工具链解耦.md` | 本文 | — |

> 工具层 `packages/dsh-elab-cockpit/**` 本轮**不需要改业务代码**；
> 若前端要显示「委托来源」，只消费内核新增的 `delegated` 派生字段。
