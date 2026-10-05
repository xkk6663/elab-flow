# ICD · elab cockpit 事件契约（L6）

> **本文件是"事实源"，与 `elab.host.yaml` 同级。**
> 实现见 `services/elab/kernel/events.py`；设计背景见 `技术方案_闭环驾驶舱.md` §4.3、§5.1、§17。
>
> 一句话：**事件是驾驶舱的唯一真相。** 界面上的每一个像素（哪一步在跑、编译到第几行、烧录成没成）
> 都必须是某条事件投影出来的，前端**不许自己猜状态**。CLI 的人读输出与界面是**同一份事件的两种渲染**，
> 因此"终端里看到的"和"界面上看到的"在结构上不可能漂移（对应风险 K8）。

---

## 1. 为什么要有这份契约

驾驶舱不是一个"好看的终端"，而是一个**只追加事件流的投影器**。这条设计带来三个红利，
它们都依赖"事件形状永不随意改动"：

| 红利 | 依赖的契约性质 |
|---|---|
| 断线重连能追上（`Last-Event-ID` 重放） | `seq` 在**一个 run 内全局单调**，且大小即顺序 |
| 能回放出任意时刻的界面 | 事件自包含（不依赖"当时的内存状态"） |
| 能回答 R1"这一步是谁干的" | 每条事件都带 `actor` |

**因此：本文件里已经定下的字段名、topic 名、语义，属于兼容性承诺。**
新增字段是兼容的（消费者必须忽略未知字段）；改名/改语义/改类型**不兼容**，
必须同时改本文件、`kernel/events.py`、`cockpit/web/src/api/types.ts` 三处，并升 `EVENT_SCHEMA_VERSION`。

---

## 2. 信封（Envelope）

**每一条事件都是**一个 JSON 对象、**占一行**（JSONL），形状固定：

```json
{"ts":1759570000.123,"run":"r-7f3a1c02","topic":"run/step-enter","seq":12,
 "step":"build","project":"at32_test","actor":"agent"}
```

| 字段 | 类型 | 必在 | 语义 |
|---|---|---|---|
| `ts` | number | ✅ | Unix epoch **秒**（含小数，ms 精度）。`time.time()` |
| `run` | string | ✅ | run id，形如 `r-<8位小写 hex>`。**一个 run 内所有事件相同** |
| `topic` | string | ✅ | 事件类型，见 §3。**大小写敏感**，形如 `域/动作` |
| `seq` | int | ✅ | **一个 run 内从 1 开始、严格 +1、全局唯一**（跨所有 topic 共用一支计数器）。回放与续传的唯一游标 |
| `actor` | string | ✅ | `agent` \| `human`。回答"这步是 AI 干的还是我点的" |
| `step` | string | 条件 | 归属步骤（`proc/*`、`run/step-*` 必有） |
| `project` | string | 条件 | 项目名（`run/start`、`run/end`、`run/step-*` 必有） |
| … | any | — | **topic 专有字段**，见 §3。消费者必须**忽略**自己不认识的字段 |

### 2.1 硬规则

1. **`seq` 全局单调**：同一 run 内跨 topic 共用一支计数器，**不是**每 topic 各一支。
   理由：SSE 的 `id:` 只能是单个游标，若要按 topic 分游标，重放逻辑会立刻复杂化。
2. **`ts` 不保证单调**：系统时钟可能回拨。**排序一律用 `seq`，永远不用 `ts`**（`ts` 只用于显示"过了多久"）。
3. **只追加**：事件文件**只 append，永不 rewrite、永不改名**。新 run = 新文件。
4. **`actor` 不可省**：即使是系统自动触发的步骤也要标 `agent`，不允许空字符串。

### 2.2 `EVENT_SCHEMA_VERSION`

`kernel/events.py` 里导出 `EVENT_SCHEMA_VERSION: int`。本文件描述的即 **version 1**。
前端启动时从 `/api/capabilities` 读到它，与自己的常量比对；不一致则**显式报错**而不是渲染出错位的界面。

---

## 3. Topic 清单

分三个域。**域的差别在于"是否持久"与"丢了会怎样"**，这是刻意的分级。

### 3.1 Run 事件 · `run/*` —— 持久，state 的唯一真相

> 落 `<run-id>.jsonl`。**丢了就无法重建界面状态**，因此：体积小、必经、不可丢弃。

| topic | 含义 | 专有字段 |
|---|---|---|
| `run/start` | run 开始 | `project`, `steps: string[]`（本次要跑的步骤序列） |
| `run/step-enter` | 进入某步（**R1 的权威来源**） | `step`, `index: int`, `total: int` |
| `run/step-exit` | 退出某步 | `step`, `ok: bool`, `detail: string`, `duration_s: number`, `<产物域>?` |
| `run/end` | run 结束 | `ok: bool`, `steps_ok: list`, `steps_failed: list` |
| `run/cancel` | 被人工/超时取消 | `by: "human"\|"watchdog"`, `reason: string` |

`run/step-exit` 的 `detail` 是**单行摘要**（供时间线与阶段账本显示），
例：`"FLASH 7.39% RAM 9.62%"`、`"configure-failed: <尾 25 行>"`。
步骤的完整输出**不在**这里（在 §3.2）。

**`run/step-exit` 允许携带产物域**（M1 起可选实现）：

```json
{"ts":...,"topic":"run/step-exit","step":"build","ok":true,
 "detail":"FLASH 7.39% RAM 9.62%","duration_s":4.8,
 "artifacts":{"elf":{"path":".work/at32_test/TEST.elf","bytes":160596}},
 "memory":{"FLASH":{"used":4840,"region":65536,"pct":7.39},
           "RAM":{"used":1576,"region":16384,"pct":9.62}}}
```

### 3.2 Activity 事件 · `proc/*` —— 不持久（相对 state），日志的唯一真相

> 落 `<run-id>.proc.jsonl`（**独立文件**，见 §5.2）+ 合并进 `<run-id>.log`。
> 编译输出动辄几 MB，若混进 `run/*` 会把 state 日志污染成不可读的大文件。
>
> ★ **落盘通道只有两个**（实现见 `kernel/events.py: channel_of`）：
> `run/*` → `<id>.jsonl`（state），**其余全部** → `<id>.proc.jsonl`（activity）。
> 也就是说 `serial/*` 的结构化事件也在 `.proc.jsonl` 里 —— 这样前端能用
> **一条 SSE 流**拿到串口事件并带上 `step`/`seq` 元数据；
> 而 `.serial.log` 另存**原始文本行**（见 §3.3），因为它的用途是"闭环证据 + grep"。

| topic | 含义 | 专有字段 |
|---|---|---|
| `proc/stdout` | 子进程一行 stdout | `line: string`（**已 strip，不含换行**） |
| `proc/stderr` | 子进程一行 stderr | `line: string` |
| `proc/exit` | 子进程退出 | `rc: int` |
| `stream/overrun` | **服务端背压丢弃**（§17.3） | `dropped: int`, `topic_scope: string`, `reason: string` |

**允许丢弃**：`proc/*` 在慢客户端/队列溢出时可被服务端丢弃（并补一条 `stream/overrun`），
**`run/*` 永不丢弃**。这是"编译日志可以截断、但'现在在第几步'绝不能错"的取舍。

`stream/closed` 由服务端**合成**（不在事件文件里，因为它是"父进程对这条流的观察"），
但它与 `run/*` 同级**不可丢弃** —— 它是浏览器**唯一**的"run 结束了、可以收尾了"信号；
丢了它，界面会永远停在"运行中"，唯一兜底是心跳断开重连（≈2 分钟，症状是"卡住"而非"报错"）。

**`stream/overrun` 的三个约定**（实现见 `cockpit/server.py::_signal_overrun`）：

1. **它是"传输"的事实，不是 run 的事实**，故**不落盘**、也**不消耗 run 的 `seq` 计数器**
   （`seq` 字段里放的是"当前已推进到的游标"，仅作定位锚点）。
   真相一条没少地躺在 `.proc.jsonl` 里，浏览器断线重连即可按 `seq` 补齐；
   这条事件的作用是把"你此刻看到的不是全部"**当场说出来**。
2. **同一个溢出 episode 只报一次**（队列恢复后再次溢出则重新报）。
   否则队列里会全是标记、把真实内容彻底挤出去，界面反而更瞎。
   标记里的 `dropped` 是**同一个 dict 对象**，后续每次丢弃都**就地刷新**，
   故读到的是最新数字 —— 且与 `/api/runs.active[].dropped` **是同一个数**。
3. SSE 层必须**在去重之前**处理它：它带的 `seq <= Last-Event-ID`，
   若走普通去重分支会被当成"与重放重叠"**丢掉自己发出来的告警**。
   发帧时**不带 `id:`**（不写进 `Last-Event-ID`）。

### 3.3 Capability 事件 · `serial/*` · `fs/*` —— 半持久

> 结构化事件落 `<run-id>.proc.jsonl`（activity 通道）；
> **另有** `<run-id>.serial.log` 存**串口原始行纯文本**——这是闭环证据，默认开。

| topic | 含义 | 专有字段 |
|---|---|---|
| `serial/open` | 串口打开成功 | `port`, `baud`, `backend`, `layer` |
| `serial/line` | 收到一行 | `line: string`, `t: float`（相对开流的秒数） |
| `serial/close` | 关闭 | `port`, `bytes: int`, `lines: int`, `backend` |
| `serial/error` | 打开/读取失败 | `errno: int?`, `message: string`, `hint: string?` |
| `serial/closed-loop` | **闭环判据命中/未命中**（§16） | `verdict: "ok"\|"failed"\|"inconclusive"`, `rule: string`, `evidence: string`, `detail: string` |

对这几个字段形状，有两条是**被实测纠正过**的（初稿写错过，记下来免得改回去）：

- **`serial/close` 没有 `reason`**。"为什么关闭"不是传输层能回答的问题：它要么是撞上
  `failed` 早退、要么是跑满窗口、要么是异常。**判定的结论在 `serial/closed-loop` 里**，
  这里只报"关了什么、读了多少"这类**传输事实**（`bytes`/`lines` 就是"这个窗口到底有没有内容"
  的第一手数字）。`serial/close` 与 `serial/open` **成对出现**：开失败时两个都不发
  （孤儿事件比缺失事件更坏 —— 它看起来"一切正常"）。
- **`serial/closed-loop` 的 `verdict` 是字符串三态，不是 `ok: true/false`**。
  布尔量装不下三态，会把"没读到约定关键字"塌成"失败" —— 正好触犯判据引擎最核心的
  那条铁律（缺证据 ≠ 有失败证据）。`rule`/`evidence` **在未命中时允许为空**：
  没有任何规则被命中时，引用一条"命中判据"本身就是假话。逐行原始证据始终在
  `.serial.log`（给人 grep）与 `serial/line`（给界面）里，`elapsed_s` 在
  `run/step-exit.extra.serial` 的完整 `Verdict` 里。

`serial/error` 的 `hint` 用来直接回答"为什么打不开"。当前唯一的高频原因是**约束 N5**：
DAP-Link 是复合 USB 设备，openocd 占着 SWD 时其虚拟串口不可读 → hint 必须直说是这个，
而不是丢一个 `ERROR_ACCESS_DENIED(5)` 让用户猜。

`fs/*` 保留给后续（产物扫描、文件监听），M1 不实现。

### 3.4 哪些 topic 会被**合并**成一帧（`is_batched`）

> ★ 这是一条**传输层**规则，与上面的**落盘通道**分类（§3.1/§3.2）是**两回事**，
> 混用的后果已经实测过一次（C24）。

SSE 层为压掉"一秒上万行"的编译输出，会把**只有进程输出**（`proc/stdout`、`proc/stderr`）
在 100ms 窗口内合并成一帧 `proc/stdout-batch`。判据是 `events.is_batched(topic)`，
等价于 `topic in {proc/stdout, proc/stderr}`。

**绝不能用 `is_activity()` 当这个判据**：那是**落盘通道**的分类，范围大得多 ——
`serial/*`、`stream/*` 都在里面。实测事故：`serial/open`/`serial/close`/`serial/closed-loop`
**都没有 `line` 字段**，被合并时拼出的是**空字符串**，于是整条串口事件链在
**实时**路径上静默消失（`serial/closed-loop` 不见了 → 驾驶舱「串口闭环」那段永远是死的）。
它极具迷惑性：这些事件**确实写进了文件**、REST 回放（`/api/run-events`）也逐条成帧，
所以"刷新页面反而正常" —— 与 §6.1 那次"漏登记 `proc/stdout-batch`"**完全同形**：
**历史有、实时没有**。

守卫：`tests/it_cockpit_server.py::test_live_sse_keeps_domain_events_as_named_frames`
（已做变异检验：把判据改回 `is_activity` 必红）。

### 3.5 写通道**不产生事件**（M3-b，刻意为之）

`POST /api/serial`（与 CLI `elab serial` 同源）是**写**方向的通道：写一条出去、收一小段
回显。它**不发射任何事件**，因此**不在**上面的 topic 表里 —— 这是刻意的，两个理由：

1. **没有可挂的 run 上下文**。写通道与 `monitor` **天然互斥**（串口是独占资源，约束 N5）：
   monitor 在跑时写不进去；写的时候也不该有 monitor 在跑。既然不属于任何 run，它就满足不了
   本契约的前提 ——「每条事件都带 `run`，且落在某个 run 的 `seq` 序列内」（§2.1）。
2. **单写者模型不破**。事件的唯一写者是 `elab run --emit-events`（约束 C17）。让驾驶舱的
   HTTP 线程去写事件文件，会在结构上破坏这个前提（`seq` 分配与落盘必须在同一把锁内）。

**后果必须在界面上体现**（诚实优先于好看）：那些 TX/RX 行只存在于浏览器**本机缓冲**，
且**不能**从 `.jsonl` 重放（§6.3）。故界面用 `TX →` / `←` 前缀把它们与
**可重放**的事件行显式区分开。

**落盘（M3-b2 已落地）**：TX/RX 现落在**独立的** console 留档
`.work/.cockpit/serial-console.jsonl`（`POST /api/serial` 与 `elab serial` 写**同一份**）。
它**不是**本契约的一部分，三条理由：

1. **不是事件**：没有 `run`、没有 `seq`、不在 `SSE_TOPICS` 里 —— 不受 §3 的 topic 表
   与 §7 的兼容性承诺约束；
2. **会滚动**：超过 512 KB 就重写文件只留尾部 2000 条（`os.replace` 原子替换）——
   本契约的事件流**只追加、永不改写**（§2.2），两者语义相反，放同一个文件必然打架；
3. **可丢**：留档读不出来不该让任何功能失败，它是"最近发生过什么"的便利视图，
   **不是** state（约束 C28）。

读取走 `GET /api/serial/console?limit=N`（**GET**：纯读、无副作用，与 `POST /api/serial`
的动词选择相对），返回 `{records, count, requested, path}`；每条记录
`{ts, t, dir: "tx"|"rx", text, project, port, baud, …}` —— 其中 `project` 是
`journal_for()` 闭包盖的章，界面按工程过滤历史全靠它（端口会复用，工程不会）。
**失败的写也落一条 `tx`（`ok:false` + `error`）**："我敲过这一行"不能因为失败就消失。
界面在切换工程/启动闭环时用最近 60 条回填（按 `project` 过滤），行首带
`✎ hh:mm:ss` 时间戳与留档分隔线，与实时行可区分。

### 3.6 一键适配也**不产生事件**（M5.6）

`POST /api/adapt`（probe 只读 / write 落盘两段式）同样不在上面的 topic 表里 —— 它是
一次**同步的文件操作**，不属于任何 run。与 §3.5 的差别在于它的"验证"如何补：

- 适配**写入本身**不发射事件（没有 run 上下文，理由同 §3.5）；
- 但接口返回 `next.steps = ["doctor_deep", "build"]`，引导界面走**现有** run 通道
  跑三绿灯 —— 那段验证**完全在本契约内**（`run/*` + `proc/*` + guard 证据随
  `run/step-exit` 落档），可重放、可观测。

★ 适配真写出了新的 `projects/<name>.yaml` 时，服务端必须**热重载 Config**
（替换 handler 配置与 RunManager 的 cfg），否则新工程对 `/api/projects` 与
`/api/run` 双双不可见 —— "写入成功、工程消失"比报错更迷惑。
真浏览器实测抓出，集成守卫：`test_adapt_write_creates_new_project_file`。

---

## 4. 步骤序列（stage pipeline）

`run/start.steps` 里的字符串，与 `ci/matrix.yaml` 的 `steps` 取值**同源**（K9：不复制流程）。

| step | 语义 | 归属门禁 |
|---|---|---|
| `doctor` | 环境体检（浅） | host-gate |
| `doctor_deep` | 环境体检 + 真跑 configure 取实际编译命令作证据 | host-gate |
| `build` | configure + build + 统一产物（hex/bin/map） | host-gate |
| `flash` | openocd 烧录 + verify | onhw-gate |
| `debug_verify` | 断到 `main` 自检 | onhw-gate |
| `monitor` | 串口闭环判据（§16） | 驾驶舱扩展 |

### 4.1 顺序约束（**不是**随便排的）

```
doctor ──► build ──► flash ──► debug_verify ──► monitor ──► [闭环 ✓]
```

`monitor` **必须**排在 `flash`/`debug_verify` **之后**。原因见约束 **N5**：
DAP-Link 是复合 USB 设备（`MI_00`=CMSIS-DAP 调试口、`MI_01`=虚拟串口），
openocd 独占 SWD 时虚拟串口 `CreateFileW` 直接 `ERROR_ACCESS_DENIED(5)`。
**串口与调试不可并行**，这是硬件性质，不是实现选择。

`debug_verify` 结束时必须 `monitor reset run` 把 MCU 放开，否则 `monitor` 收到 0 字节。

---

## 5. 文件布局与语义

### 5.1 目录

```
.work/.cockpit/runs/            ← 运行产物（git 忽略；**只增不改**）
├── r-7f3a1c02.jsonl            ← run/* 事件（state 真相，小、必经、不可丢）
├── r-7f3a1c02.proc.jsonl       ← 其余事件（proc/*、stream/*、serial/*；大、可丢、可修剪）
├── r-7f3a1c02.log              ← 上两者的纯文本合并（给人 / grep）
└── r-7f3a1c02.serial.log       ← 串口**原始行**纯文本（闭环证据）
```

> **刻意没有 `index.json`。** run 索引 100% 可由文件名 + 首/尾事件重建
> （`kernel/events.py: list_runs()` 就是这么做的）。索引一旦独立落盘就会与实际
> 文件漂移，而它带来的收益只是省一次 glob —— **少一个需要保持同步的东西更好**。

### 5.2 为什么 `proc/*` 单独一个文件

`技术方案 §4.3` 写的是"`proc/*` 不落盘"。**契约层把这句话精确化为"不落进 state 日志"**：

- 编译输出几 MB，混进 `run/*` 会让"重建界面状态"这个动作被迫读一个巨大文件 → 违背它作为 state 真相的职责；
- 但服务端要**实时**把编译日志推给浏览器，就必须有**文件**可跟读（父进程看不见子进程的内存）；
- 方案 §4.3 自己已经承诺了"每 run 一份 `.log`（合并 stdout/stderr 供 grep）"——本契约把这个承诺**结构化**成 `.proc.jsonl`，并额外导出人读的 `.log`。

**判据**：删掉 `*.proc.jsonl` **必须**只损失"日志"，不得影响任何状态重建。这是本契约的验收条件之一。

### 5.3 run id

`r-` + 8 位小写 hex（`secrets.token_hex(4)`）。生成时**必须**检查文件不存在，
冲突则重取 —— 因为"新 run = 新文件，绝不复写"是硬规则，**不允许靠覆盖解决冲突**。

### 5.4 写入纪律

- 写入方**只有** `elab run --emit-events` 一个进程（单写者模型），故**不加文件锁**；
- 每写一行 **`flush()`**：父进程按行跟读，缓冲会让界面"卡住不动"；
- 多线程（proc 读线程 vs 主线程）**必须**共用同一把锁 + 同一支 `seq` 计数器。

---

## 6. 消费侧（cockpit 服务端）

### 6.1 SSE 协议

见 `技术方案 §17`。要点：

- `GET /api/events?run=<id>&from=<seq>`，`Accept: text/event-stream`
- 每个事件 → `id: <seq>` / `event: <topic>` / `data: <信封 JSON，单行>`
- 15s 一行 `: ping` 注释作心跳
- 浏览器重连自动带 `Last-Event-ID`，服务端据此从**最近一个已结束/进行中 run 的文件按 `seq` 重放**
- `proc/*` **100ms 合并**为 `proc/stdout-batch`（`lines: string[]`），事件数降 1~2 个数量级

> ⚠️ **SSE 用「命名事件」而非默认 message 通道**，这带来一条跨端硬约束：
> `EventSource` 的 `onmessage` **只接收没有 `event:` 字段的帧**，所以前端必须
> 为每个 topic 显式 `addEventListener(topic, …)`。后果是：
> **新增一个 topic，前端必须同步把它加进 `src/api/types.ts` 的 `KNOWN_TOPICS` 白名单，
> 否则该 topic 的所有事件在界面上"静默消失"——不报错、不抛异常，只是那块 UI 永远不更新。**
>
> 这是本项目最容易误判为"前端 bug"的一类问题（实际是契约同步遗漏）。
> 故 §7 把"新增 topic"从单端兼容变更**下调**为跨端协同变更。
> 唯一的例外通道是 `GET /api/run-events`（返回 JSON 数组），它不受此限制。
>
> **真实事故（P0）**：白名单曾漏掉 `proc/stdout-batch`。而 run **跑起来之后**
> 所有编译日志都以合并帧下发 → **实时日志 100% 不可见**。它骗过一轮验收的原因是
> **不对称**：已结束的 run 走"按 `seq` 重放"分支、发的是 `.proc.jsonl` 里的
> **逐条** `proc/stdout`（收得到），只有**实时**路径才走合并帧 —— 于是表现为
> "刷新页面有日志、真跑起来没日志"。
>
> **这条约束有两个执行点（缺一不可）**：
> 1. **服务端**：`cockpit/server.py` 的 `SSE_TOPICS` 是契约镜像；
>    真发出未登记 topic 时 `_sse_warn_unknown()` 打一条 WARN（把静默变有声）。
> 2. **CI**：`tests/it_cockpit_server.py::test_known_topics_covers_server_emitted`
>    解析 `types.ts` 的 `KNOWN_TOPICS` 与 `SSE_TOPICS` 做集合比对，缺一即红。

### 6.2 背压

每连接一个有界队列（默认 2000）。溢出时：**先丢 `proc/*`，`run/*` 绝不丢**，
并补发 `stream/overrun` 让界面显示"日志已截断"——
**绝不允许**因为日志刷屏而让"当前在第几步"变得不可信。

### 6.3 重放

```python
def replay(path, after_seq):
    for line in open(path, encoding="utf-8"):
        ev = json.loads(line)
        if ev["seq"] > after_seq:
            yield ev
```

只追加日志的**直接红利**：重放不需要额外机制，也不需要内存里保留历史。

---

## 7. 兼容性承诺汇总

| 变更 | 兼容? | 需要做什么 |
|---|---|---|
| 新增 topic | ⚠️ **跨端** | 消费者忽略未知 topic（`reduce()` 的 default 分支），**但 SSE 是命名事件**：必须同时改 `cockpit/server.py` 的 `SSE_TOPICS` 与 `cockpit/web/src/api/types.ts` 的 `KNOWN_TOPICS`，否则事件静默丢失（见 §6.1 的真实事故与两个执行点）；CI 守卫 `test_known_topics_covers_server_emitted` |
| 新增字段 | ✅ | 消费者必须忽略未知字段 |
| 删除/改名现有字段 | ❌ | 升 `EVENT_SCHEMA_VERSION`，三处同步改 |
| 改字段类型/单位（如 `ts` 秒→毫秒） | ❌ | 同上。**单位混淆是本项目的高发事故类型**，改前先查文档 |
| 改 `seq` 递增规则 | ❌ | 同上；会破坏断线续传 |
| `proc/*` 被丢弃 | ✅ | 这是**设计内**行为，消费者不得据此判定失败 |

> 「三处同步改」指：本 ICD、`services/elab/kernel/events.py`、`cockpit/web/src/api/types.ts`。
> 前两处由后端在启动时自检（`schema_version` 随 `/api/capabilities` 下发），
> 前端在启动时用 `assertSchema()` 比对 —— 版本不一致会**直接报错而不是画出错位的界面**。

---

## 8. 附：最小可读样例

一次成功的 `doctor → build` run，`r-7f3a1c02.jsonl` 全文（`proc/*` 已省略）：

```jsonl
{"ts":1759570000.100,"run":"r-7f3a1c02","topic":"run/start","seq":1,"actor":"agent","project":"at32_test","steps":["doctor","build"]}
{"ts":1759570000.105,"run":"r-7f3a1c02","topic":"run/step-enter","seq":2,"actor":"agent","project":"at32_test","step":"doctor","index":0,"total":2}
{"ts":1759570000.480,"run":"r-7f3a1c02","topic":"run/step-exit","seq":3,"actor":"agent","project":"at32_test","step":"doctor","ok":true,"detail":"全绿","duration_s":0.375}
{"ts":1759570000.485,"run":"r-7f3a1c02","topic":"run/step-enter","seq":4,"actor":"agent","project":"at32_test","step":"build","index":1,"total":2}
{"ts":1759570005.290,"run":"r-7f3a1c02","topic":"run/step-exit","seq":37,"actor":"agent","project":"at32_test","step":"build","ok":true,"detail":"FLASH 7.39% RAM 9.62%","duration_s":4.805,"memory":{"FLASH":{"used":4840,"region":65536,"pct":7.39},"RAM":{"used":1576,"region":16384,"pct":9.62}}}
{"ts":1759570005.295,"run":"r-7f3a1c02","topic":"run/end","seq":38,"actor":"agent","ok":true,"steps_ok":["doctor","build"],"steps_failed":[]}
```

> 注意 `seq` 从 4 直接跳到 37：中间的 5…36 是 `proc/*`，它们**不在本文件里**（在 `.proc.jsonl`）。
> **`seq` 的连续性因此是"跨文件"的**——这不是缺陷，而是"单一游标"设计的必然结果：
> 消费者按 `seq` 过滤，遇到空洞**必须**理解为"那一段是活动日志"，不得当成丢事件。
