# 技术方案 · 右侧栏调试面板（Cortex-Debug 功能/UI 复刻 + Agent 可驾驶）

> 状态：技术分析（可执行） · 版本：v1（2026-11-03）
> 读者：内核维护者、`dsh-elab-cockpit` 插件维护者、芯片适配包作者
> 结论：**可行（Go）**。按 P0→P3 四期落地；P0 即可交付「Agent 打开调试 → 面板自动亮起 → 用户看到调用栈/寄存器 → 单步/断点可用」。
> 边界：本方案只新增**调试会话**，不改 `build` / `flash` / `debug_verify` / `monitor` 的既有语义。

---

## 0. TL;DR

| 问题 | 结论 |
|---|---|
| 能否复刻 Cortex-Debug 的功能？ | 能。其能力本质是 **GDB/MI 之上的一层会话编排 + 若干只读/读写可视化视图**，不需要 DAP，也不需要 VS Code。 |
| UI 能否 1:1 复刻？ | 功能面对齐，布局**不能** 1:1（Cortex-Debug 依赖编辑器 gutter 与三栏面板）。改为「单栏分组子页签」，宽屏双列。 |
| 代码放哪一层？ | 会话/协议/解析全部在**内核** `services/elab/**`；面板/进程托管/agent 工具全部在**插件** `packages/dsh-elab-cockpit/**`；中间只走 loopback HTTP + SSE。 |
| Agent 怎么「打开调试画面」？ | `elab_debug_open` 建立会话（`actor=agent`）→ SSE `debug/opened{open_seq, focus:true}` → 面板仅在**新 `open_seq`** 时自动切到调试视图，用户手动切走不会被反复抢焦点。 |
| 最大的坑 | ① 3333 端口被残留 openocd 占用（C34）；② GDB 非异步模式导致 `continue` 阻塞；③ 关闭会话后板子留在 halt，心跳/串口闭环假失败（C36 延伸）；④ 面板关闭/重挂载丢会话。 |
| 新增依赖？ | 内核：**零**（标准库）；插件：**零**（不引入 react-window / dap / gdb 库）。 |

---

## 1. 需求拆解与「复刻」的定义

### 1.1 三件事（验收目标）

1. **功能**：在 elab 右侧栏内完成 Cortex-Debug 的主要调试动作——继续/暂停/单步（源码级与指令级）、断点（函数/地址/条件/硬件）、调用栈、变量、监视、内核寄存器、外设寄存器（SVD）、内存、反汇编、实时监视。
2. **UI**：用户不用装 VS Code、不用写 `launch.json`；打开即见调试工具条与状态（停在哪个函数/哪一行、谁在持有会话）。
3. **Agent 权限**：Agent 可通过标准工具发起/驱动会话；发起后用户的右侧栏**自动显示调试画面**，寄存器和栈状态是同一份会话数据（人机同源），不是两套。

### 1.2 复刻边界（明确不做）

| 复刻 | 不复刻（用替代方案） | 理由 |
|---|---|---|
| 调试动作、数据视图、断点语义、SVD 外设树 | 源码编辑器 gutter 断点 | elab 面板无编辑器；改用「函数断点 / 地址断点 / 反汇编行点选」 |
| GDB/MI 会话编排 | DAP（Debug Adapter Protocol） | DAP 面向 IDE 客户端，仍需桥接；MI 已是事实标准且内核可直接驱动 |
| `launch.json` 语义 | `launch.json` 文件 | 从既有 `project.yaml` + `chip.yaml` + `host.yaml` + `plan` **派生**，例外只进工程级 `*.debug.json` |
| 单核调试 | 多核 chained 会话 | 先声明 `max_sessions:1`，多核留接口不做实现 |
| SWO/RTT 数据面（P3） | ITM/ETM 解码全量复刻 | 先做 RTT 文本 + 通道波形；ETM 不做 |

> **关键判断**：Cortex-Debug 的“功能”几乎全部可以映射到 20 余条 MI 命令（见附录 A）；它的“UI”价值在于**信息组织**，不在于 VS Code 的容器。

---

## 2. 调研 A：Cortex-Debug 的能力与 UI

> 依据：`Marus/cortex-debug` master 的 `README.md`、`package.json`（抓取时 `version=1.13.0-pre11`）、`debug_attributes.md`、wiki（Multi-core / Disassembly）。

### 2.1 功能清单（按前端视图归类）

| Cortex-Debug 视图/能力 | 支撑技术 | 我们的对应视图 | 优先级 |
|---|---|---|---|
| VARIABLES（Locals / Globals / Statics） | `-stack-list-variables`、`-symbol-info-variables`、varobj | 变量 | P0 |
| Cortex Core Register Viewer（V1.2 起并入 Variables） | `-data-list-register-names/values` | 寄存器 | P0 |
| CALL STACK（含 RTOS 线程） | `-thread-info`、`-stack-list-frames` | 调用栈 / 线程 | P0 / P2 |
| BREAKPOINTS（条件、命中数、硬件） | `-break-insert/-condition/-list` | 断点 | P0 / P1 |
| DISASSEMBLY（VS Code 托管，指令级单步） | `-data-disassemble`、`-exec-step-instruction` | 反汇编 | P1 |
| MEMORY（mcu-debug.memory-view） | `-data-read/write-memory-bytes` | 内存 | P1 |
| WATCH | `-var-create` / `-data-evaluate-expression` | 监视 | P1 |
| LIVE WATCH（V1.6+，GDB Server 采样） | 运行态采样 | 实时监视 | P3（默认关） |
| XPERIPHERALS（mcu-debug.peripheral-viewer，SVD） | SVD XML + 内存读 | 外设 | P2 |
| SWO / RTT console + graph | OpenOCD `rtt`、ITM 解码 | 跟踪 | P3 |
| TERMINAL `gdb-server`（半主机） | semihosting | 输出（半主机） | P2 可选 |
| 多会话 / chainedConfigurations | 多 GDB server | —（不做） | — |

### 2.2 架构启示

- Cortex-Debug = **前端 UI + Debug Adapter**；Adapter 只与 `gdb` 通信，`gdb` 再连 `gdb-server`（OpenOCD/J-Link/pyOCD/ST-LINK/BMP）。**GDB 是唯一的数据面入口**。
- 前端视图被拆成 `mcu-debug.*` 系列扩展（memory-view / peripheral-viewer / rtos-views），说明**视图与调试内核解耦**是成熟做法 —— 与本仓「内核 + 插件」的分层天然同构。
- 版本演进把 `"type": "<server>-gdb"` 收敛为 `"type": "cortex-debug" + "servertype"`，说明**探针差异应该收敛到一个适配层**，而不是散在 UI。

### 2.3 常用 launch 属性 → elab 派生映射

| Cortex-Debug 属性 | elab 来源（无需用户填写） | 是否需要覆盖 |
|---|---|---|
`type` / `servertype` | 探针后端（P0 仅 `openocd`，经 `plan.host` 判定） | 否 |
`executable` | `plan.elf` | 否（缺失报 `debug-elf-missing`） |
`device` | `chip.debug.device`（pack 声明） | 否 |
`svdFile` | `chip.debug.svd` → `Host.resolve_svd()`（已有解析链） | 否 |
`interface` / `serialNumber` | `plan.host.probe` / 探针序列号 | 否 |
`gdbPath` / `objdumpPath` | `plan.host.gdb`（`tools.gdb`） | 可 |
`runToEntryPoint` | 会话参数 `stop_at`（默认 `main`，可选 `reset`/`none`） | 可 |
`breakAfterReset` | 固定 `true`（先 halt 再决定） | 否 |
`loadFiles` / `symbolFiles` | `plan.flash_images` / `plan.elf`（沿用 C33e 的 load 判据） | 否 |
`preLaunchCommands` / `postLaunchCommands` | 不支持任意 GDB CLI（安全边界，见 §9.2） | 否 |
`rttConfig` / `swoConfig` / `liveWatch` | `.debug.json` 的 `trace` / `live_watch` 节（P3） | 可 |

> 结论：**用户不需要 `launch.json`**。所有默认从既有 plan 派生，这是相对 Cortex-Debug 的核心体验优势。

### 2.4 不能照搬的三处（必须在文档里承认）

1. **无编辑器**：没有 gutter，就没有“在源码行上点断点”的体验。替代：函数断点、地址断点、反汇编行点选、条件断点。文档与 UI 文案必须说明，避免用户找“行断点”。
2. **窄栏**：DSH 右侧栏通常 320–420px。Cortex-Debug 的「调用栈 + 变量 + 监视」是并列视图。我们改为**分组子页签**（§10.1），宽屏（≥520px）自动双列。
3. **无 `launch.json` 生命周期**：会话由面板/Agent 按需创建，必须自己定义**租约、接管、空闲回收、关闭恢复运行**（§7.7）。

---

## 3. 调研 B：elab 现有代码基线

### 3.1 已有能力（可直接复用）

| 能力 | 位置 | 复用方式 |
|---|---|---|
| 内核 HTTP 服务（`ThreadingHTTPServer`） | `cockpit/server.py` | 新增 `/api/debug/*` 路由 |
| SSE 事件面（`id: <seq>` + `event: <topic>`） | `cockpit/server.py` 的 `_sse()` / `SSE_TOPICS` | 新增独立 `/api/debug/events`（不复用 run 信封，见 §6.4） |
| 内核自描述 | `cockpit/server.py` 的 `STEP_META` / `KERNEL_PLANS` / `capabilities()` | 增 `meta.debug`，插件按能力渲染 |
| OpenOCD 启动与端口等待 | `services/elab/flash.py` 的 `_openocd_argv()`、`_wait_port()`、`debug()` | 扩展动态端口 + 监听端口确认；`debug_verify` 保持不动 |
| 交互式调试链路 | `flash.debug(mode="run")`（openocd + 终端里的 gdb） | 证明「openocd + gdb + reset halt + 断点」链路已跑通；本方案只把「终端输入」换成 MI 驱动 |
| 项目级探针/脚本声明 | `projects/*.yaml` 的 `debug.probe` / `debug.gdb_script`（`Plan.probe` / `Plan.gdb_script`） | 直接复用 `probe`；`gdb_script` **不默认注入 MI 会话**（见 §7.5） |
| 工程/工具链/探针解析 | `services/elab/plan.py`、`config.py` | 派生调试参数（gdb、serverpath、interface） |
| SVD 解析链 | `chip.debug.svd` → `Host.svd_roots` → `Host.resolve_svd()` → `doctor` 检查 | 外设视图的数据源；**不新增芯片知识** |
| 进程清理 | `services/elab/_winproc.py`（`CREATE_NO_WINDOW`） | gdb/openocd 子进程统一走 `proc_kwargs()` |
| 单飞 + 归属 + 人优先 | `RunManager`（`spawn/cancel/actor`） + 串口租约语义 | 同构复制为 `DebugManager`（单会话 + agent 租约） |
| 工程级共享存储 + rev 乐观锁 | `services/elab/serialwidgets.py`（`projects/<name>.widgets.json`） | 新增 `projects/<name>.debug.json` |
| 插件路由白名单 / SSE 字节级透传 | `packages/dsh-elab-cockpit/src/adapters/kernel-http/routes.ts` | 增 debug GET/POST 白名单 + 一条 debug SSE 路由 |
| 面板视图切换 | `CockpitPane.tsx` 的 `view: 'work' / 'settings'` | 增 `'debug'` |
| Agent 工具注册 | `packages/dsh-elab-cockpit/src/adapters/dsh-tools/tools.ts` | 增 `elab_debug_*` 工具 |
| 样式硬规则 | `test/style-rules.test.mjs`（禁止字面色值/直读宿主令牌） | 新组件只用 `--elab-*`，缺的变量补进 `theme/dsw-map.ts` |

### 3.2 缺口（本方案要补的）

| 缺口 | 影响 | 补法 |
|---|---|---|
| 没有 GDB/MI 客户端 | 无法交互式调试 | `services/elab/gdbmi.py` |
| 没有长驻调试会话 | 只有一次性 `debug_verify` | `services/elab/debugsession.py` |
| 没有 stopped 态数据整形 | UI 拿不到栈/变量/寄存器 | `services/elab/debugdata.py` |
| 没有 SVD 解析器 | 外设视图无数据 | `services/elab/svd.py`（通用解析，非芯片知识） |
| 3333 固定端口 | 残留 openocd 会把 GDB 接到“别人的服务”（C34 已踩） | 动态端口 + openocd 监听端口确认（RSP 探测可选） |
| 面板无调试视图 | 用户看不到 | `adapters/dsh-web/DebugView.tsx` + 子组件 |
| 插件无 debug 代理 | Agent/面板调不到 | 白名单 + `icd-client` 方法 |

### 3.3 必须遵守的硬约束

| 约束 | 对设计的约束 |
|---|---|
| AGENTS §1/§3 | 会话逻辑只能写内核；插件**不得** import 内核源码，只走 loopback HTTP |
| AGENTS §4 | 旧内核无 `meta.debug` → 面板必须隐藏/降级，**不得**在工具层写兼容分支 |
| AGENTS §5 | SVD 文件属于 pack/host，内核只解析 `chip.debug.svd` 指向的文件，不内置任何厂商 SVD |
| AGENTS §7 | `packs/installed/**` 不入库，调试配置也不写进 pack |
| C14/C15/C28 | 长驻进程必须可回收；**禁止**把调试状态写进 `state.json`；审计留档独立 |
| C34 | 不得假设 3333 可用；必须动态端口 + 端口归属校验 |
| C36（延伸） | 调试关闭后必须恢复运行；不得让板子停在 halt 导致心跳/串口闭环假失败 |

---

## 4. 总体架构

### 4.1 分层与数据流

```
┌──────────────────────────── DSH 右侧栏（工具层） ────────────────────────────┐
│ CockpitPane  ──(view='debug')──►  DebugView                                  │
│                                   ├─ DebugToolbar（继续/暂停/单步/复位）       │
│                                   ├─ Stack/Vars/Regs/Periph/Memory/Disasm     │
│                                   └─ DebugConsole（MI 流 + 审计）              │
│ Agent 工具 elab_debug_* ──► app/debug-service.ts ──► /elab/api/debug/*         │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ loopback HTTP + SSE（唯一合法缝隙）
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ cockpit/server.py                                                             │
│  DebugManager（单会话/租约/互斥/审计）                                         │
│      ├─ DebugSession ──► MiSession ──► gdb --interpreter=mi2                  │
│      │                                    └─ target remote 127.0.0.1:<动态端口>│
│      └─ openocd（-c "gdb_port <动态端口>", telnet/tcl disabled）              │
│  DebugData（栈/变量/寄存器/断点/内存/反汇编 → JSON）                          │
│  svd.py（SVD XML → 外设树，读值走 GDB 内存读）                                 │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ SWD
                         ┌──────▼──────┐
                         │  目标 MCU    │
                         └─────────────┘
```

### 4.2 会话时序（Agent 发起，用户看到画面）

```
Agent                插件(host)           内核 DebugManager          gdb            openocd      面板(用户)
 │ elab_debug_open      │                        │                    │               │             │
 ├─────────────────────►│ POST /api/debug/session│                    │               │             │
 │                      ├───────────────────────►│ 分配空闲端口        │               │             │
 │                      │                        ├─ spawn ───────────────────────────►│             │
 │                      │                        ├─ 等端口就绪 ─────►│               │             │
 │                      │                        ├─ target remote ───►│               │             │
 │                      │                        ├─ reset halt / load │               │             │
 │                      │                        ├─ bp main + continue│               │             │
 │                      │                        │◄─ *stopped ────────┤               │             │
 │                      │                        ├─ SSE debug/opened{open_seq,focus} ───────────────►│
 │                      │                        │                    │               │        切到调试视图
 │ elab_debug_inspect   │                        │                    │               │             │
 ├─────────────────────►│ GET …/registers        ├─ MI 读寄存器 ─────►│               │             │
 │                      │◄───────────────────────┤                    │               │             │
 │                      │                        ├─ SSE debug/ui{focus:"registers"} ────────────────►│
 │                      │                        │                    │               │       高亮寄存器页
```

### 4.3 为什么不是「插件内直接起 GDB」

| 方案 | 判定 | 原因 |
|---|---|---|
| A. 浏览器直连 GDB | ✗ | 浏览器不能 spawn 进程；且要暴露裸 GDB 端口 |
| B. 插件 host 内 spawn gdb | ✗ | 越过唯一缝隙（AGENTS §3）；面板关闭丢会话；双写者 |
| C. **内核内 DebugManager + HTTP/SSE** | ✓ | 单一事实源；Agent/CLI/其他 UI 都能复用；进程可被内核统一回收 |

---

## 5. 关键设计决策（ADR）

| # | 决策 | 否决项与理由 |
|---|---|---|
| D1 | 调试会话是**内核**长驻对象（`DebugManager` 单例，`max_sessions=1`） | 插件持有会话会在面板卸载时丢状态；且业务逻辑进工具层违规 |
| D2 | 用 **GDB/MI**，不实现 DAP | DAP 需要再写一层 server，且浏览器仍要桥；MI 是 GDB 稳定接口 |
| D3 | **单飞 + 归属 + 租约**：`owner=human / agent`，agent 默认 300s（上限 600s），human 无租约但有 30min 空闲回收 | 防止 Agent 永久占用探针；与串口租约语义一致 |
| D4 | **动态空闲端口 + 监听端口确认**（openocd 日志/RSP 探测）；关闭 telnet/tcl | 3333 固定端口已造成 C34 事故；确认可识别“端口被别的服务占用” |
| D5 | **停止态=拉取快照；运行态=事件**；不逐指令推 SSE | 逐指令会 100+ 事件/s，拖垮面板与 SSE |
| D6 | SVD 仍由 **pack/host** 提供，内核只解析 | 芯片知识唯一宿主（AGENTS §5） |
| D7 | 断点/监视/UI 偏好存 `projects/<name>.debug.json`（`rev` 乐观锁） | 与 `serialwidgets.py` 同构；可提交 Git 团队共享 |
| D8 | 关闭/租约到期默认 **`monitor reset run`** | 否则板子停在 halt，心跳/串口闭环假失败（C36 延伸） |
| D9 | Agent 打开 → **仅新 `open_seq` 自动聚焦**；用户手动切走不抢 | 与既有「仅新 agent run 切换工程」规则同构 |
| D10 | 能力自描述 `capabilities.meta.debug`，插件按 `features` 渲染 | 旧内核自动隐藏，遵守 AGENTS §4 |
| D11 | 只暴露**白名单 MI 动作**；写操作（内存/寄存器/表达式）受 `allow_write` 闸门 + 审计 | 禁止任意 `console`/`shell` 透传（GDB `call` 可改目标状态） |
| D12 | 不做源码行断点 | 无编辑器；用函数/地址/条件断点替代，UI 文案明示 |
| D13 | P0 调试会话与**常驻串口监视双向互斥**（409） | 沿用既有 N5 判据与 C31 互斥语义；P3 再按实测开 `serial_coexist` 能力位 |

---

## 6. ICD 设计（HTTP + SSE）

### 6.1 能力自描述

`GET /api/capabilities` → `meta.debug`：

```jsonc
{
  "debug": {
    "available": true,
    "reason": null,                  // 不可用时给可复制原因
    "features": ["session","control","stack","variables","registers",
                 "breakpoints","memory","disasm","watch"],  // P2 追加 "svd"；P3 追加 "livewatch","rtt"
    "limits": {
      "max_sessions": 1,
      "agent_lease_s": [300, 600],
      "memory_read_max": 4096,
      "disasm_max": 128,
      "audit_keep": 20
    },
    "requires": ["openocd", "gdb", "elf"],
    "transport": "gdb-mi2",
    "port_policy": "dynamic"
  }
}
```

规则：`features` 是**渲染白名单**。P3 才出现的 `livewatch` / `rtt` 不进 `features` 前，面板不得显示对应页签。

### 6.2 端点表

| 方法 | 路径 | 语义 | 关键参数 |
|---|---|---|---|
| GET | `/api/debug/session` | 当前会话快照（含 `open_seq`、`state`、`actor`、租约） | — |
| POST | `/api/debug/session` | `action=open / close / takeover` | `project`、`actor`、`lease_s`、`options{stop_at,load,resume_on_close}` |
| POST | `/api/debug/control` | 执行控制 | `action=continue / pause / step_over / step_in / step_out / stepi / reset / restart / run_to`、`addr`、`confirm` |
| GET | `/api/debug/stack` | 线程 + 帧 | `thread` |
| GET | `/api/debug/variables` | 作用域/子节点 | `frame`、`scope=locals / args / globals / statics`、`var=`（子节点） |
| GET | `/api/debug/registers` | 寄存器组 | `group=core / fpu`、`format=natural / hex` |
| GET/POST | `/api/debug/breakpoints` | 列表 / `add / update / remove / toggle` | 见 §6.5 |
| GET/POST | `/api/debug/watch` | 列表 / `add / update / remove` | `expr`、`format` |
| GET | `/api/debug/memory` | 读内存（分页） | `addr`、`count` |
| POST | `/api/debug/write` | 写内存/寄存器（写闸门） | `target=memory / register`、`addr`/`name`、`value`、`confirm` |
| GET | `/api/debug/disasm` | 反汇编窗口 | `addr`、`count`、`mode=asm / mixed` |
| GET | `/api/debug/peripherals` | SVD 树/读值 | `path`（外设/寄存器）、`read=1` |
| POST | `/api/debug/evaluate` | 表达式求值（按写闸门处理：可能含函数调用） | `expr`、`frame`、`confirm` |
| GET | `/api/debug/events` | 调试 SSE（独立信封） | `session`、`from` |
| GET | `/api/debug/audit` | 审计尾（谁改了什么） | `limit` |

统一返回：`{"ok":true,...}` / `{"ok":false,"error":{"code","message","hint?"}}`，与既有 `_err` 形状一致。

### 6.3 错误码

| code | HTTP | 何时 | hint（给用户/Agent 可执行） |
|---|---|---|---|
`debug-unavailable` | 503 | 无 openocd/gdb 或内核开关关闭 | 跑 `elab.cmd doctor`；看 `meta.debug.reason` |
`debug-elf-missing` | 409 | `plan.elf` 缺失或文件不存在 | 先 `build` |
`debug-busy` | 409 | 正在启动/关闭中 | 稍后重试 |
`run-active` | 409 | 有 run（含 `debug_verify`）在跑 | 先取消/等待 run 结束 |
`serial-monitor-active` | 409 | 常驻串口监视占用同一探针/串口 | 先关闭串口监视 |
`debug-session-active` | 409 | 已有调试会话 | 先 `close` 或 `takeover` |
`debug-port-hijacked` | 500 | openocd 未按期望端口监听，或端口被非 GDB 服务应答 | 清理残留 `openocd`（任务管理器 / `taskkill`）；检查 `gdb_port` 下发顺序 |
`debug-openocd-dead` | 500 | openocd 退出 | 返回 stderr 尾部 300 字 |
`debug-gdb-missing` | 503 | `plan.host.gdb` 为空/不存在 | 配置 `tools.gdb` 或装 arm-none-eabi-gdb |
`debug-timeout` | 504 | MI 命令超时 | 命令名 + 已等待 ms |
`debug-no-session` | 409 | 无会话 | 先 `open` |
`debug-session-leased` | 403 | 会话已被人类接管（`owner=human`） | 请用户关闭或重新授权 Agent |
`debug-write-denied` | 403 | Agent 写操作但 `allow_write=false` | 用户在设置里允许 Agent 写入 |
`debug-svd-missing` | 404 | 芯片/包未声明 SVD | 在 `chip.yaml` 的 `debug.svd` 声明 |
`debug-target-running` | 409 | 运行态请求停止态数据（栈/变量/部分寄存器） | 先 `pause` |
`debug-bad-request` | 400 | 参数非法 | 字段名 |
`debug-limit` | 400 | 超过 `memory_read_max` / `disasm_max` | 分页请求 |

### 6.4 SSE：独立信封

**不复用** run 的 `ElabEvent`（其 `run` 字段是必填，调试不是 run）。新信封：

```jsonc
{
  "v": 1,
  "session": "dbg-<8hex>",
  "seq": 17,                // 会话内单调递增，断线续传用 Last-Event-ID
  "ts": 1793690000.123,
  "topic": "debug/state",
  "actor": "agent",
  "data": { ... }
}
```

| topic | data | 触发 |
|---|---|---|
`debug/opened` | `{open_seq,project,actor,focus:true}` | 会话首次进入 `stopped` |
`debug/state` | `{state,prev,reason?}` | `starting→stopped/running/error/closed` |
`debug/stop` | `{reason,thread,frame:{func,file,line,addr},pc,bkptno?}` | 每次 `*stopped`（断点/单步/暂停/复位） |
`debug/output` | `{stream:"console\|target\|log",text}` | GDB MI `~ / @ / &` |
`debug/breakpoint` | `{id,gdb_id,verified,hit_count,enabled}` | `=breakpoint-*` |
`debug/ui` | `{tab:"stack\|variables\|registers\|peripherals\|memory\|disasm\|breakpoints"}` | Agent `inspect` 指定聚焦 |
`debug/closed` | `{reason,resumed:bool}` | 正常关闭/租约到期/进程死亡 |
`debug/error` | `{code,message}` | 不可恢复错误 |
`debug/overlay` | `{dropped:int,topics:[...]}` | 客户端追不上时（只丢 `debug/output`） |

同步要求（CI 门禁）：三处 `KNOWN_TOPICS` / `SSE_TOPICS` / 插件镜像必须同时加，否则 `_sse_warn_unknown` 与 `test/sse-hub.test.mjs` 会失败。

### 6.5 关键 JSON 形状

**会话快照**

```jsonc
{
  "ok": true,
  "session": {
    "id": "dbg-1a2b3c4d",
    "open_seq": 41,
    "project": "stm32_test",
    "chip": "STM32F103C8T6",
    "elf": "build/stm32_test.elf",
    "state": "stopped",                 // starting|running|stopped|error|closed
    "actor": "agent",
    "owner": "agent",
    "started_at": 1793690000.0,
    "lease_s": 300,
    "lease_remaining_s": 243,
    "port": 54321,
    "gdb": "arm-none-eabi-gdb",
    "stop": {
      "reason": "breakpoint", "bkptno": "3", "thread": 1,
      "frame": {"func":"main","file":"Src/main.c","line":57,"addr":"0x08000abc"},
      "pc": "0x08000abc"
    },
    "threads": [{"id":1,"name":"main","core":0,"current":true}],
    "svd": {"available": true, "file": "STM32F103.svd"},
    "features": ["stack","variables","registers","breakpoints","memory","disasm","svd"]
  }
}
```

**寄存器**（`stop_seq` 用于面板丢弃过期响应；人机同源）

```jsonc
{
  "ok": true, "stop_seq": 12,
  "groups": [{
    "name": "core", "label": "内核寄存器",
    "regs": [
      {"name":"r0","hex":"0x20000000","natural":"536870912","editable":true},
      {"name":"sp","hex":"0x20005000","natural":"536870912","editable":true},
      {"name":"pc","hex":"0x08000abc","natural":"134219452","symbol":"main+4","editable":true},
      {"name":"xpsr","hex":"0x01000000","natural":"16777216","flags":{"T":1,"N":0,"Z":1,"C":0,"V":0}}
    ]
  }]
}
```

**变量节点**（懒加载，`has_more` 控制“展开更多”）

```jsonc
{
  "ok": true, "frame": 0, "scope": "locals", "stop_seq": 12,
  "nodes": [{"name":"i","type":"uint32_t","value":"5","hex":"0x5",
             "has_children":false,"addr":"0x20001ffc"}],
  "truncated": false
}
```

**断点**（工程级持久，`id` 是 UI 稳定 id，`gdb_id` 会话内有效）

```jsonc
{"id":"bp-7","gdb_id":"3","kind":"func","location":"HAL_Delay",
 "enabled":true,"condition":"i > 3","hit_count":9,
 "verified":true,"temporary":false,"hardware":false}
```

**内存**（分页，单次 ≤4096B）

```jsonc
{"ok":true,"addr":"0x20000000","count":256,
 "bytes":"00 01 02 …","width":4,"ascii":"....","next":"0x20000100"}
```

**反汇编**（PC 高亮 + 地址断点提示）

```jsonc
{"ok":true,"addr":"0x08000a90",
 "instructions":[
   {"addr":"0x08000a90","mnemonic":"ldr","operands":"r3, [pc, #8]","symbol":"main+8"},
   {"addr":"0x08000a94","mnemonic":"cmp","operands":"r3, #0","pc":true,"bp":"bp-7"}
 ]}
```

**外设（SVD）**：树 + 可选读值；字段解码在服务端完成，面板不解析 SVD。

```jsonc
{"ok":true,"svd":{"name":"STM32F103xx","file":"STM32F103.svd","peripherals":68},
 "tree":[{"name":"GPIOA","base":"0x40010800","group":"GPIO",
          "registers":[{"name":"ODR","offset":"0x0c","value":"0x00000000",
                        "fields":[{"name":"ODR0","bits":"0-0","value":0}]}]}]}
```

---

## 7. 内核实现设计

### 7.1 模块与规模

| 文件 | 职责 | 预估 |
|---|---|---|
| `services/elab/gdbmi.py` | MI 记录解析 + `MiSession`（读写线程、token、超时、中断） | ~350 行 |
| `services/elab/debugsession.py` | 打开/关闭编排：空闲端口、openocd、gdb、reset/load、stop_at、状态机 | ~420 行 |
| `services/elab/debugdata.py` | 纯整形：栈/变量/寄存器/断点/内存/反汇编 → §6.5 JSON | ~260 行 |
| `services/elab/svd.py` | SVD XML 解析（外设/寄存器/字段/enumeratedValues）+ 缓存 | ~320 行 |
| `cockpit/server.py` | `DebugManager`、路由、SSE、`capabilities.meta.debug`、审计 | +~320 行 |
| `tests/test_gdbmi.py` / `test_debugdata.py` / `test_svd.py` | 黄金样本 | ~520 行 |
| `tests/fake_gdb.py` + `tests/test_debugsession.py` | 无硬件 MI 桩 + 会话状态机 | ~260 行 |

> 侵入原则：`flash.py` 只做**参数化**（`_openocd_argv` 的 `commands` 运行时支持 `str`/`list`，但统一追加在 `-f target` **之后**；端口命令必须走新增的 `pre_commands`，插在 `-f` **之前**），**不复用** `debug()` 的批处理控制流；`debug_verify` 行为保持不变。
> `debug(mode="run")` 已证明链路可用，但它把 gdb 交给终端；MI 会话需要独占 gdb 的 stdin/stdout，因此两者**不能同时存在**（调试会话打开时，`debug_verify` 返回 `debug-session-active`）。

### 7.2 GDB/MI 解析器

MI 每条记录一行，语法：

```
record   := token? ( '^' result-class | '*' async-class | '+' async-class
                   | '=' notify-class ) (',' result)*
          | '~' c-string | '@' c-string | '&' c-string | '(' prompt-text ')'
result   := variable '=' value
value    := c-string | tuple | list
tuple    := '{' (result (',' result)*)? '}'
list     := '[' (value|result) (',' (value|result))* ']'
c-string := '"' ( char | '\\' escape )* '"'
```

骨架（可直接落盘后补全）：

```python
# services/elab/gdbmi.py
from __future__ import annotations
import concurrent.futures as cf
import re, subprocess, threading, time
from ._winproc import proc_kwargs

_ESC = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "e": "\x1b"}


class MiError(RuntimeError):
    def __init__(self, msg: str, record: dict | None = None):
        super().__init__(msg)
        self.record = record or {}


def _cstr(s: str, i: int) -> tuple[str, int]:
    i += 1
    out: list[str] = []
    while i < len(s):
        c = s[i]
        if c == '"':
            return "".join(out), i + 1
        if c == '\\':
            n = s[i + 1]
            if n in '01234567':                     # 八进制转义
                j, dig = i + 1, ''
                while j < len(s) and len(dig) < 3 and s[j] in '01234567':
                    dig += s[j]; j += 1
                out.append(chr(int(dig, 8))); i = j; continue
            out.append(_ESC.get(n, n)); i += 2; continue
        out.append(c); i += 1
    raise MiError(f"unterminated c-string: {s[:60]}")


def _value(s: str, i: int):
    while i < len(s) and s[i] == ' ':
        i += 1
    c = s[i]
    if c == '"':
        return _cstr(s, i)
    if c == '{':
        i += 1; out = {}
        while True:
            while i < len(s) and s[i] in ' ,':
                i += 1
            if s[i] == '}':
                return out, i + 1
            k, i = _cstr(s, i)
            while s[i] == ' ':
                i += 1
            if s[i] != '=':
                raise MiError(f"expect '=' at {i}")
            out[k], i = _value(s, i + 1)
    if c == '[':
        i += 1; out = []
        while True:
            while i < len(s) and s[i] in ' ,':
                i += 1
            if s[i] == ']':
                return out, i + 1
            if s[i] == '"':
                k, i = _cstr(s, i)
                while i < len(s) and s[i] == ' ':
                    i += 1
                if i < len(s) and s[i] == '=':        # result（无花括号）
                    v, i = _value(s, i + 1); out.append({k: v})
                else:                                # 纯字符串元素
                    out.append(k)
                continue
            v, i = _value(s, i); out.append(v)
    raise MiError(f"bad value at {i}: {s[i:i + 20]}")


def parse_record(line: str) -> dict:
    """解析一条 MI 记录；不合法抛 MiError（调用方可降级为日志）。"""
    line = line.rstrip("\r\n")
    if line.startswith("("):                       # prompt 不是 c-string：`(gdb)`
        return {"token": None, "kind": "prompt", "cls": None,
                "text": line, "results": {}}
    m = re.match(r"^(\d+)?([\^+*=~@&])(.*)$", line, re.S)
    if not m:
        raise MiError(f"not an MI record: {line[:60]}")
    token, lead, rest = m.group(1), m.group(2), m.group(3)
    kind = {"^": "result", "+": "status", "*": "exec",
            "=": "notify", "~": "console", "@": "target", "&": "log"}[lead]
    if lead in "~@&":
        text, _ = _cstr(rest, 0)
        return {"token": token, "kind": kind, "cls": None, "text": text, "results": {}}
    head, _, tail = rest.partition(",")
    results, i = {}, 0
    while i < len(tail):
        while i < len(tail) and tail[i] in " ,":
            i += 1
        if i >= len(tail):
            break
        k, i = _cstr(tail, i)
        while i < len(tail) and tail[i] == ' ':
            i += 1
        if i >= len(tail) or tail[i] != '=':
            raise MiError(f"expect '=' at {i}")
        results[k], i = _value(tail, i + 1)
    return {"token": token, "kind": kind, "cls": head.strip(),
            "text": None, "results": results}
```

`MiSession` 关键点（骨架）：

```python
class MiSession:
    def __init__(self, argv, cwd=None, env=None):
        self._argv, self._cwd, self._env = argv, cwd, env
        self._proc = None
        self._pending: dict[str, tuple[cf.Future, float]] = {}
        self._lock = threading.Lock()
        self._seq = 0
        self.on_async = lambda rec: None      # *stopped / *running / =notify
        self.on_stream = lambda rec: None     # ~ / @ / &

    def start(self, timeout=10.0):
        self._proc = subprocess.Popen(
            self._argv, cwd=self._cwd, env=self._env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, encoding="utf-8",
            errors="replace", bufsize=1, **proc_kwargs())
        threading.Thread(target=self._read_loop, daemon=True).start()
        # 首个 prompt 视为就绪；超时 → MiError("gdb-not-ready")
        self.command("-gdb-version", timeout=timeout)

    def command(self, cmd: str, timeout=5.0) -> dict:
        with self._lock:
            self._seq += 1
            token = str(self._seq)
            fut: cf.Future = cf.Future()
            self._pending[token] = (fut, time.monotonic() + timeout)
        self._proc.stdin.write(f"{token}{cmd}\n"); self._proc.stdin.flush()
        try:
            return fut.result(timeout=timeout)
        except cf.TimeoutError:
            with self._lock:
                self._pending.pop(token, None)
            raise MiError(f"timeout: {cmd}")

    def _read_loop(self):
        assert self._proc and self._proc.stdout
        for line in self._proc.stdout:
            try:
                rec = parse_record(line)
            except MiError:
                self.on_stream({"kind": "log", "text": line}); continue
            if rec["kind"] in ("console", "target", "log"):
                self.on_stream(rec); continue
            if rec["kind"] == "prompt":
                continue
            tok = rec["token"]
            if tok and tok in self._pending:
                fut, _ = self._pending.pop(tok)
                if rec["cls"] == "error":
                    fut.set_exception(MiError(rec["results"].get("msg", ""), rec))
                else:
                    fut.set_result(rec)
            else:
                self.on_async(rec)       # 无 token 的 =notify / *stopped
```

必须设置的初始化（缺一不可）：

```text
-gdb-set mi-async on          # 否则 -exec-continue 同步阻塞、-exec-interrupt 无效
-gdb-set confirm off
-gdb-set pagination off
-gdb-set print elements 200
-enable-pretty-printing
```

> 工程细节（写实现时必须补）：
> - **迟到记录**：`command()` 超时后 token 已出队；reader 若再见到同 token 必须丢弃（维护 `_expired` 集合，上限 1000），否则会被误当成无 token 的异步事件。
> - **stderr 合流**：`stderr=STDOUT` 时 GDB 的启动警告会混进 MI 流，`parse_record` 失败要降级为 `log` 流而不是崩会话。
> - **编码**：Windows 上强制 `text=True, encoding="utf-8", errors="replace"`（与 C32 同思路），否则 GBK 区域下中文路径/符号会炸。
> - **缓冲区**：`bufsize=1` + `readline()`；不要 `read()`，MI 是行协议。

> 兜底：老 GDB 不认 `mi-async` 时，`continue` 改为「不发命令等结果」的看门狗模式（记录 `capabilities.debug.gdb_mi_async=false`，面板仍可用但暂停可能降级为 `monitor halt`）。

### 7.3 会话状态机

```
                 ┌──────────── error ◄── spawn/握手/连接失败
                 │                 │
idle ──open──► starting ──reset/load/bp──► stopped ◄──*stopped── running
                 │                          │  ▲                  │
                 │                          └──┴── step/continue ─┘
                 │                                     │
                 └──────── close / lease / idle ────────┴──► closing ──► closed
```

约束：

- `starting` 总预算 **45s**（openocd 20s + gdb 10s + reset/load 15s），超时 → `error` 并清理子进程。
- `resume_on_close` 默认 `true`：`-exec-continue`（或 `monitor reset run`，由 `options` 决定）；执行失败也要 `close`，并在 `debug/closed{resumed:false}` 里说明。
- 任何路径（异常、租约、面板关闭、内核退出）都走 `finally: terminate gdb → terminate openocd → 端口释放`。

### 7.4 线程与超时

| 线程 | 职责 | 注意 |
|---|---|---|
| HTTP 线程 | 只做命令编排与 JSON 整形，**不**读 GDB stdout | 避免与 reader 抢 |
| `MiSession._read_loop` | 单读者，按 token 路由 | MI 输出是单流，必须唯一读者 |
| SSE 写线程（既有） | 从 ring 取事件 | `debug/output` 合并 100ms 一批（同 `proc/stdout-batch`） |
| 看门狗（可选） | `continue` 超时保护 | `continue` 本身不等结果，看门狗只兜底“发出了却无 `*running`” |

超时建议：`-data-read-memory-bytes` 5s/块（≤256B）；`-stack-list-variables` 5s；`-data-disassemble` 5s；`-target-select` 10s；`-interpreter-exec console "monitor reset halt"` 10s。

### 7.5 端口分配与就绪校验（C34 延伸）

```python
GDB_LISTEN_RE = re.compile(r"Listening on port (\d+) for gdb connections")

def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

def wait_gdb_port(port: int, srv: subprocess.Popen, timeout=20.0, log=print) -> None:
    """端口是 GDB **remote target**（RSP），不是 MI。判据 = openocd 自己打印的监听端口。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if srv.poll() is not None:
            raise DebugError("debug-openocd-dead", srv_stderr_tail(srv))
        line = srv.stdout.readline()        # spawn 时需 stdout=PIPE（或读日志文件尾部）
        if not line:
            time.sleep(0.05); continue
        log(line.rstrip())
        m = GDB_LISTEN_RE.search(line)
        if m:
            got = int(m.group(1))
            if got != port:
                raise DebugError("debug-port-hijacked",
                                 f"openocd 监听 {got}，期望 {port}（gdb_port 下发过晚？）")
            return
    raise DebugError("debug-timeout", f"openocd 未在 {timeout}s 内监听 gdb 端口")
```

> 不能对 `gdb_port` 发送 MI 命令做握手：该端口说 **RSP**（`$qSupported#37`），MI 是 GDB 进程的 stdin/stdout 方言。
> 需要额外确认时，可用轻量 RSP 探测：连接后发 `$qSupported#37\n`，收到 `$…#hh` 即判定为 GDB server；但仍以「openocd 日志 + GDB `-target-select` 结果」为准。
> 集成注意：openocd 的 stdout 通常由后台线程写日志；`DebugManager` 必须**自己持有** reader（或在该线程的日志回调里匹配 `GDB_LISTEN_RE`），不能两处同时 `readline()`。

- 端口分配后仍要**启动前探测一次占用**（`port-in-use` 立刻报，而不是等 20s）。
- **openocd 参数顺序（易踩）**：`gdb_port` / `telnet_port` / `tcl_port` 必须在 `-f target/*.cfg` **之前**下发。target cfg 末尾通常已 `init`，此时服务器已按默认 3333 监听，追加的 `-c "gdb_port X"` 不会改绑。<br>正确形态：`openocd -s <scripts> -c "gdb_port <p>" -c "telnet_port disabled" -c "tcl_port disabled" -f <interface>.cfg -f <target>.cfg …`，即把端口命令插到 argv 前部（`_openocd_argv` 需加一个 `pre_commands` 参数，而不是复用末尾的 `commands`）。
- `plan.gdb_script` **不默认注入**：它可能包含 `continue`/`quit`，会把 MI 会话直接终结。确需沿用脚本时，走 `options.gdb_script=true` 显式开启，并在 `debug/output` 里提示“已加载用户脚本”。
- 若 3 次端口分配都失败 → `debug-port-hijacked`，提示清理残留进程。

### 7.6 SVD 解析与读值策略

- 数据源：`chip.debug.svd` → `Host.resolve_svd()`（已有）；**不新增任何芯片文件**。
- 解析：`xml.etree.ElementTree`，按 `peripherals → registers → fields → enumeratedValues` 建树；缓存键 = `(abspath, mtime, size)`，进程内 LRU 4 份。
- 读值：按**寄存器粒度**用 `-data-read-memory-bytes` 读（合并同一外设连续寄存器，单次 ≤256B），服务端按 `bitOffset/bitWidth` 解字段；写入 `-data-write-memory-bytes`，默认**只读**，写需 `confirm` + 人类/允许写。
- 大 SVD（STM32F103 约 1000+ 节点）：首屏只返回**外设级**（不含 fields），展开某外设时才返回寄存器，展开寄存器才返回字段值 → 面板懒加载。
- 无 SVD：`features` 不含 `svd`，外设页签不渲染；`GET /api/debug/peripherals` 返回 `debug-svd-missing`。

### 7.7 生命周期、租约与审计

| 事件 | 行为 |
|---|---|
| Agent `open` | `lease_s` 默认 300（钳制到 600），每次 agent 工具调用刷新 |
| 租约到期 | 自动 `close`（`reason=lease-expired`），默认恢复运行，SSE 广播 |
| 人类 `takeover` | `owner=human`，租约清零；Agent 后续写操作 403 `debug-session-leased` |
| 人类关闭 | `reason=user-closed`；Agent 的后续调用 409 `debug-no-session` |
| 面板卸载 | **不关闭**会话（内核持有）；面板重挂载用 `GET /api/debug/session` 重水化 |
| 内核退出 | `atexit` / `finally` 杀 gdb/openocd，端口释放 |
| 审计 | 每次 open/close/takeover/写内存/写寄存器/改断点 → `debug-audit.jsonl`，保留最近 20 个会话或 7 天 |

审计记录：

```jsonc
{"ts":1793690123.4,"session":"dbg-1a2b3c4d","actor":"agent","op":"memory.write",
 "addr":"0x20000000","bytes":4,"value":"0x00000001","project":"stm32_test"}
```

### 7.8 互斥矩阵（P0）

| 正在运行 → | `run(build)` | `run(flash\|debug_verify\|monitor)` | 常驻串口监视 | 调试会话 |
|---|---|---|---|---|
| 发起 `run(build)` | — | 串行 | 允许 | 允许 |
| 发起 `run(flash\|debug_verify\|monitor)` | 串行 | — | 409（既有） | **409 `debug-session-active`** |
| 打开调试会话 | 允许 | **409 `run-active`** | **409 `serial-monitor-active`** | **409 `debug-session-active`** |
| 常驻串口监视 | 允许 | 409（既有） | — | **409** |

> P0 采取保守双向互斥（沿用 N5 判据）；P3 若某探针实测可共存，以 `capabilities.debug.serial_coexist=true` 放开，不改默认。

---

## 8. 工具层（`dsh-elab-cockpit`）实现设计

### 8.1 路由代理白名单

在 `src/adapters/kernel-http/routes.ts`：

- `GET_ALLOW` 增：`debug/session`、`debug/stack`、`debug/variables`、`debug/registers`、`debug/breakpoints`、`debug/watch`、`debug/memory`、`debug/disasm`、`debug/peripherals`、`debug/audit`。
- `POST_ALLOW` 增：`debug/session`、`debug/control`、`debug/breakpoints`、`debug/watch`、`debug/write`、`debug/evaluate`。
- 新增 exact 路由 `/elab/debug/events`：**字节级透传** `/api/debug/events`（参照既有 `/elab/events` 的 `pipe` 语义；不解析帧、转发 `Last-Event-ID`、客户端断开即 abort 上游）。
- POST `debug/*` 注入 `x-elab-actor`（与 run 一致）；`debug/write` 与 `debug/evaluate` 额外带 `x-elab-allow-write`（由工具层设置决定）。

### 8.2 类型与端口

`src/domain/icd.ts`（与 `packages/cockpit-ui-core/src/icd.ts` 镜像同步）：

```ts
export const DEBUG_TOPICS = [
  'debug/opened', 'debug/state', 'debug/stop', 'debug/output',
  'debug/breakpoint', 'debug/ui', 'debug/closed', 'debug/error', 'debug/overlay',
] as const
export type DebugTopic = (typeof DEBUG_TOPICS)[number]

export interface DebugSession { /* 与 §6.5 一一对应 */ }
export interface DebugSnapshot { session: DebugSession | null }
export interface DebugRegisters { stop_seq: number; groups: DebugRegGroup[] }
```

`src/app/ports.ts` 增 `DebugPort`（open/close/control/stack/vars/regs/bp/watch/memory/disasm/periph/events），只做**形状转换**，不做业务判断。

### 8.3 自动聚焦协议（「Agent 打开调试画面」的落地）

```ts
// src/app/debug-view-store.ts
const FOCUS_KEY = 'elab.debug.focusSeq'
let userPinnedAway = false          // 用户在一次会话内手动切走

export function considerAutoFocus(s: DebugSession | null): boolean {
  if (!s || s.actor !== 'agent') return false
  if (userPinnedAway) return false
  const seen = Number(sessionStorage.getItem(FOCUS_KEY) ?? 0)
  if (s.open_seq <= seen) return false        // 只认“新会话”，不反复抢
  sessionStorage.setItem(FOCUS_KEY, String(s.open_seq))
  return true
}
```

接线：

1. 面板挂载时 `GET /api/debug/session` → `considerAutoFocus` → `setView('debug')`。
2. SSE `debug/opened` → 同上（`open_seq` 判定）。
3. `CockpitPane` 用户手动切换视图 → 若有活动会话，`userPinnedAway = true`；会话 `closed` 时复位。
4. `debug/ui{tab}` → 会话内切子页签（Agent 说“看寄存器”→ 用户眼前就是寄存器页）。

> 宿主能力边界：工具层**无法**强制唤起 DSH 右栏。若面板未挂载，`elab_debug_open` 只能在返回文本里提示“点右侧栏调试图标”；面板一旦挂载，按 `open_seq` 规则自动聚焦。这一点必须在工具描述里写清，避免 Agent 误判“已经给用户看了”。

> 与既有「仅新 agent run 才切换工程」的规则完全同构，避免“用户正在看串口，面板被 Agent 反复抢走”。

### 8.4 UI 结构（窄栏 / 宽屏）

```
窄栏（320–519px）                          宽屏（≥520px）
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ ● 已暂停 main+4  [agent 243s] │          │ ● 已暂停 main+4  [agent 243s] │
│ ▶ ⏸ ⤵ ⤴ ↺  ■   …             │          │ ▶ ⏸ ⤵ ⤴ ↺  ■   …             │
├──────────────────────────────┤          ├────────────────┬─────────────┤
│ [位置][数据][代码][输出]       │          │ 调用栈          │ 变量/监视    │
│                              │          │ ─────────────  │ ───────────  │
│  (当前分组子页签内容)          │          │ #0 main  L57   │ ▸ i  5       │
│                              │          │ #1 HAL_Delay   │ ▸ p  &h      │
│                              │          │ #2 …           │              │
├──────────────────────────────┤          ├────────────────┴─────────────┤
│ ▸ 控制台（最新 20 行，可折叠）  │          │ ▸ 控制台（最新 20 行）          │
└──────────────────────────────┘          └──────────────────────────────┘
```

分组（二级 chip）：

| 分组 | 子页签 | 默认 |
|---|---|---|
位置 | 调用栈 / 线程 / 栈内存 | 调用栈 |
数据 | 变量 / 监视 / 寄存器 / 外设 | 变量（Agent 指定时切） |
代码 | 反汇编 / 断点 | 反汇编 |
输出 | 控制台 / 审计 / 跟踪(P3) | 控制台 |

组件树：

```text
DebugView
├─ DebugToolbar            (状态、owner/租约、动作按钮)
├─ DebugGroupTabs          (分组 + 子页签，容纳溢出菜单)
├─ DebugStackPanel         (线程/帧，点帧切 frame → 刷新变量/反汇编)
├─ DebugVariablesPanel     (作用域树，懒加载，hex/natural 切换)
├─ DebugRegistersPanel     (分组表，PC 行高亮，编辑失败内联报错)
├─ DebugPeripheralsPanel   (SVD 树，字段位图，只读默认)
├─ DebugMemoryPanel        (hex dump 分页，地址跳转，写需 confirm)
├─ DebugDisasmPanel        (PC 窗口 ±64，行内“断点”点选)
├─ DebugBreakpointsPanel   (列表，条件/命中数/硬件，启用开关)
├─ DebugWatchPanel         (表达式，格式，刷新策略)
└─ DebugConsole            (MI 流 + 审计，限长、自动滚底可暂停)
```

### 8.5 渲染与性能硬约束

- 所有颜色/字号用 `--elab-*`；新增变量先补 `theme/dsw-map.ts`（`style-rules.test.mjs` 会拦）。
- **不引入新依赖**：树/表用“懒加载 + 展开更多（50 条/页）”，不做全量虚拟滚动。
- 任何 `stop_seq` 响应落地前校验：`resp.stop_seq === store.stop_seq`，否则丢弃（防止“单步后旧寄存器覆盖新寄存器”）。
- 面板 `visible=false` → 停止 300ms 轮询与实时监视；SSE 保留但只收状态（项目既有约定）。
- 断点命中 → 自动切「位置/调用栈」并高亮 PC 帧；`debug/ui` 优先于自动规则（Agent 指定视图）。

---

## 9. Agent 工具设计

### 9.1 工具表（`src/adapters/dsh-tools/tools.ts`）

| 工具 | 参数 | 返回 | 写权限 |
|---|---|---|---|
| `elab_debug_open` | `project?`, `stop_at?("main"\|"reset"\|"none")`, `load?`, `lease_s?` | `{session, view:"debug", hint}` | 否 |
| `elab_debug_control` | `action`, `addr?`, `confirm?` | `{state, stop?}` | 否（reset 需 confirm） |
| `elab_debug_inspect` | `what:"stack"\|"variables"\|"registers"\|"breakpoints"\|"memory"\|"disasm"\|"peripherals"`, 其余透传 | 对应 §6.5 数据 + `ui{tab}` | 否 |
| `elab_debug_breakpoint` | `action:"add"\|"update"\|"remove"\|"toggle"`, `kind`, `location`, `condition?`, `hardware?` | `{breakpoints}` | 否（仅审计） |
| `elab_debug_watch` | `action`, `expr`, `format?` | `{watches}` | 否（仅表达式） |
| `elab_debug_write` | `target:"memory"\|"register"\|"expression"`, `addr?`, `name?`, `value`, `confirm` | `{ok, before, after}` | **是**（`allow_write`） |
| `elab_debug_wait` | `event:"stopped"\|"closed"`, `timeout_ms` | `{hit, stop?, waited_ms}` | 否 |
| `elab_debug_close` | `resume?` | `{closed, resumed}` | 否 |

约束：

- 所有工具**必须**带 `actor=agent`；`allow_write` 来自用户在插件设置里的“允许 Agent 写入调试目标”（默认 **false**），只拦**目标状态写入**（内存/寄存器/表达式），不拦断点与监视。
- `elab_debug_open` 成功后返回固定提示：`调试面板已打开（右侧栏）；若未显示请点右侧栏的调试图标。`
- `elab_debug_wait` 用 SSE/条件变量等待，禁止轮询 GDB（避免每 100ms 一条 MI 命令）。
- 工具返回的 `hint` 必须是**可执行**的（如 `serial-monitor-active` → “先调 elab_serial_monitor(action=close)”）。

### 9.2 安全边界（必须写进代码，不是文档口号）

1. **命令白名单**：内核只接受固定 op → 固定 MI 命令模板；**绝不**把用户/Agent 字符串拼进 `-interpreter-exec console`。
2. **禁止任意 console 透传**：不接受 `-interpreter-exec console` 的任意字符串（尤其 `shell`、`call f()`、`set $pc=…`）；寄存器写只允许内核拼装的 `-data-evaluate-expression "$<reg> = <word>"` 模板（寄存器名白名单 + 数值校验 + 转义）。
3. **写操作三闸**：`actor=agent` + `allow_write=true` + `confirm`（内存/寄存器必须带地址与长度上限）。
4. **审计**：写前写后值都落 `debug-audit.jsonl`；`debug/output` 不落审计，避免日志爆炸。
5. **loopback 信任模型**：与既有 run/serial 一致（只监听 127.0.0.1；这不是抵御本机恶意进程的安全边界，文档不得宣称）。

### 9.3 典型 Agent 闭环（可脚本化验收）

```text
1) elab_debug_open(project="stm32_test", stop_at="main")
2) elab_debug_inspect(what="stack")        → 断言 frame.func == "main"
3) elab_debug_breakpoint(add func="HAL_Delay")
4) elab_debug_control(action="continue")
5) elab_debug_wait(event="stopped", timeout_ms=3000) → 断言 reason=="breakpoint"
6) elab_debug_inspect(what="registers")    → 断言 pc 在 HAL_Delay 内
7) elab_debug_write(target="memory", addr="0x20000000", value="0x12345678", confirm=true)  // 仅 allow_write
8) elab_debug_close(resume=true)
9) 串口心跳在 ≤1s 内恢复（用户确认 LED 仍 1Hz 闪）
```

---

## 10. UI 复刻对照表（逐视图）

| Cortex-Debug | 我们的页签 | P0/P1 交互 | 差异（必须在 UI 文案说明） |
|---|---|---|---|
| VARIABLES | 数据/变量 | 作用域切 Locals/Args/Globals/Statics；树展开；hex/natural；双击改值（走 `allow_write`） | 无“编辑器内联值” |
| Cortex Core Registers | 数据/寄存器 | r0–r15、xPSR（N/Z/C/V/T 徽标）、MSP/PSP、CONTROL、FPU 组；PC 行高亮；可编辑 | xPSR 位徽标是增强项 |
| XPERIPHERALS | 数据/外设 | SVD 树（外设→寄存器→字段）；值/位图；只读默认 | 依赖包声明 SVD；无 SVD 时整页隐藏 |
| CALL STACK | 位置/调用栈 | 线程列表 + 帧；点帧切 frame 并刷新变量/反汇编；<br>RTOS 线程 P2 | 无“源码跳转” |
| BREAKPOINTS | 代码/断点 | 函数/地址/条件/硬件/临时；命中数；启用开关 | 无“行断点” |
| WATCH | 数据/监视 | 表达式列表；格式化；会话内刷新 | 不做跨会话自动求值 |
| LIVE WATCH | 数据/监视（P3） | 运行态采样 0.5–5Hz，默认关 | **采样式=短暂 halt**，会扰动心跳（§11 P3 验收） |
| MEMORY | 数据/内存 | hex dump、宽度 1/2/4、ASCII、跳转、写确认 | 无“多窗口并排” |
| DISASSEMBLY | 代码/反汇编 | PC ±64 指令；单步指令；地址点选断点 | 无源码交错（P1 有行号信息时可选） |
| TERMINAL gdb-server | 输出/控制台 | MI `~ @ &` 流、限长、可暂停滚底 | 半主机需 OpenOCD 显式开启（P2） |
| SWO/RTT graph | 输出/跟踪（P3） | 文本 + 通道波形（复用串口波形组件） | 不做 ETM |
| 多会话 chained | — | 不实现 | `max_sessions=1` |

---

## 11. 分阶段实施计划（文件级 DoD）

### P0 · 最小可用闭环（Agent 可开、用户可见）

**内核**
- 新增 `services/elab/gdbmi.py`（§7.2）
- 新增 `services/elab/debugsession.py`（§7.3–7.5）
- 新增 `services/elab/debugdata.py`（stack/variables/registers/breakpoints）
- `cockpit/server.py`：`DebugManager`、`/api/debug/{session,control,stack,variables,registers,breakpoints,events}`、`meta.debug`
- `services/elab/plan.py`：暴露 `debug_profile()`（gdb/openocd/elf/device/interface 派生），不改既有字段

**插件**
- `domain/icd.ts` + `cockpit-ui-core/src/icd.ts`：`DEBUG_TOPICS`、`DebugSession`
- `app/ports.ts`、`app/debug-service.ts`
- `adapters/kernel-http/routes.ts`：白名单 + `/elab/debug/events`
- `adapters/dsh-web/DebugView.tsx`、`DebugToolbar.tsx`、`DebugStackPanel.tsx`、`DebugVariablesPanel.tsx`、`DebugRegistersPanel.tsx`、`DebugConsole.tsx`
- `CockpitPane.tsx`：`view` 联合类型加 `'debug'`，加入口按钮
- `dsh-tools/tools.ts`：`open/control/inspect/close/wait`
- `app/debug-view-store.ts`：自动聚焦

**DoD**
1. `open → stop_at main` 成功（≤6s 典型）；
2. 单步 over/in/out 各 3 次，UI 的 PC 与 `registers.pc` 一致；
3. `continue` 命中函数断点，`debug/stop` 的 `frame.func` 正确；
4. 寄存器页显示 r0–r15 + xPSR + SP/PC，停止态刷新 p95 ≤ 300ms；
5. 关闭后固件恢复运行，串口心跳 ≤1s 恢复（用户目视 LED）；
6. 关闭后无残留 `openocd`/`gdb`，动态端口可被再次分配；
7. 面板卸载再挂载，会话仍在（`GET /api/debug/session` 重水化）；
8. Agent 打开时，面板自动切到调试视图一次；用户切走后不反复抢。

### P1 · 日常可用

- 断点持久化（`projects/<name>.debug.json`，`rev` 乐观锁）、条件/硬件/命中数
- 内存读写、反汇编、监视、栈内存
- 审计、租约/接管、错误码与 hint 全量
- DoD：断点跨会话保留；内存写生效且审计可查；反汇编 PC 高亮；Agent 写被默认拒绝（403）并能给出开启路径。

### P2 · 外设与生态

- `services/elab/svd.py` + `/api/debug/peripherals` + `DebugPeripheralsPanel`
- SVD 懒加载与缓存；无 SVD 降级
- WebUI 工作区 `debugWs`（`cockpit/web/src/workspaces.ts`，一条记录即可）
- 半主机（OpenOCD `arm semihosting enable`，可选）
- DoD：STM32F103 的 SVD 首屏 <2s；展开 GPIOA→ODR→字段 <300ms；改 ODR 需 confirm 且读回一致。

### P3 · 高级（默认关）

- Live Watch（halt sampling，0.5–5Hz）+ 心跳畸变度量（见 §12.3）
- RTT 文本 + 通道波形（复用串口波形组件）
- RTOS 线程（OpenOCD `-rtos` 配置由 pack 声明）
- DoD：采样开启时给出“目标被短暂 halt”的显式警告；关闭后心跳 p95 间隔偏差 ≤50ms（1Hz 基准）。

---

## 12. 测试与验收

### 12.1 无硬件 CI（可在任意机器跑）

| 测试 | 内容 |
|---|---|
`tests/test_gdbmi.py` | 黄金 MI 转录（`^done,stack=[...]`、`*stopped`、`~"..."`、转义、列表/元组混排、错误记录） |
`tests/test_debugdata.py` | 栈/变量/寄存器/内存整形；`stop_seq` 语义；超限分页 |
`tests/test_svd.py` | 合成 SVD（`TESTCHIP`，**不是**任何厂商真实芯片）→ 树/位域/枚举；畸形 XML 降级 |
`tests/test_debugsession.py` | `tests/fake_gdb.py` 桩：启动→握手→reset→bp→continue→step→close；超时/中断/杀进程 |
`tests/test_debug_http.py` | 路由形状、409 矩阵、actor/租约、403 写闸门 |
`packages/.../test/routes.test.mjs` | debug GET/POST 白名单、未知路径 404 |
`packages/.../test/debug-view.test.mjs` | `open_seq` 只聚焦一次；`userPinnedAway`；`stop_seq` 丢弃 |
`packages/.../test/sse-hub.test.mjs` | 三处 topic 一致性 |
`packages/.../test/boundary.test.mjs` | 新增文件不得 import 内核源码 |

命令：

```powershell
$env:PYTHONPATH = "services"
python -m pytest tests -q
elab.cmd doctor

Set-Location packages/dsh-elab-cockpit
npm test
npx tsc -p tsconfig.host.json --noEmit
npx tsc -p tsconfig.client.json --noEmit
npm run build
```

### 12.2 有硬件 HIL 清单（每期跑一遍，记录在 `docs/tutorials/`）

1. 板子先通过第一关（串口心跳 + LED 1Hz，用户目视确认）。
2. `open`（stop_at main）→ 面板显示 `main`，寄存器 `pc` 落在 main 地址区间。
3. 单步 3 次，`sp` 合理（栈内），`lr` 指向调用点。
4. 函数断点命中；命中后用户看到调用栈深度 ≥2。
5. 变量树展开结构体，值与前一次 stop 一致（无 `stop_seq` 串扰）。
6. 内存读 `0x20000000` 与 map 文件一致；写 4B 后读回一致（审计有记录）。
7. `close(resume=true)` 后 1s 内串口继续输出心跳；LED 仍 1Hz（**用户确认**）。
8. 立刻重新 `open` 成功（端口已释放）；任务管理器无残留。
9. 拔掉探针 → `debug/error` 可读、会话自动 `closing`，面板不崩。
10. Agent 打开会话时，用户面板自动出现调试视图；用户手动切到串口后不再被抢。

### 12.3 性能预算

| 指标 | 预算 | 测量 |
|---|---|---|
open→stopped | 典型 ≤6s，p95 ≤10s | 时间戳差值 |
停止态刷新（栈+变量+寄存器） | p95 ≤300ms | 服务端 + 面板端各打点 |
控制命令往返（step） | p95 ≤500ms | `debug/stop` 到 UI 更新 |
寄存器页首屏 | ≤16ms 渲染 | `performance.measure` |
SVD 首次解析（1000+ 节点） | ≤2s，之后缓存 ≤50ms | 服务端计时 |
SSE 事件量 | 空闲 ≤2 条/分钟；仅在状态变化 | 统计 `debug/*` |
Live Watch（P3） | 对 1Hz 心跳间隔 p95 偏差 ≤50ms | 串口日志 + `toggles` 比对 |

### 12.4 回归门禁

- 任何 `cockpit/server.py` 改动：两个检出同步（AGENTS 验证节）。
- 新增 topic：三处同步 + CI。
- 新增 UI 文件：`style-rules` / `boundary` 必须绿。
- `debug_verify` 的既有用例必须全绿（证明未改旧语义）。

---

## 13. 风险与对策

| # | 风险 | 触发信号 | 对策 |
|---|---|---|---|
1 | 残留 openocd 占端口，GDB 连错服务（C34） | openocd 未打印监听端口 / 端口号不符 | 动态端口 + 预占用探测 + 日志端口确认；错误提示清理进程 |
2 | GDB 非异步导致 `continue` 阻塞 HTTP | 请求 30s 不返回 | `mi-async on` + `continue` 不等结果 + 看门狗 |
3 | 关闭后板子停在 halt | 串口无心跳、用户报“板子死了” | `resume_on_close` 默认 true；租约到期也恢复 |
4 | 面板重挂载丢会话 | 一键刷新后状态清空 | 会话在内核；面板以 `GET session` 重水化 |
5 | Windows 进程树孤儿 | 关会话后仍有 openocd | 内核 `finally` 逐级 terminate；插件 job object 兜底 |
6 | 探针争用（run/串口/调试） | 烧录失败、`CMD_INFO failed` | 单飞 + 409 矩阵 + 可执行 hint |
7 | SVD 过大拖垮首屏 | 面板卡死 | 分层懒加载 + 缓存 + 单页 50 条 |
8 | Agent 任意 GDB 命令 / `call` 改目标 | 不可预期副作用 | 命令白名单 + 写闸门 + 审计；禁 console 透传 |
9 | 逐指令 SSE 洪泛 | 面板掉帧、SSE 丢事件 | 只在状态变化推；`debug/output` 100ms 合批；ring 丢旧 |
10 | 旧内核无 `meta.debug` | 面板报错 | 能力自描述 + 隐藏入口（AGENTS §4） |
11 | 单步后旧数据覆盖新数据 | 寄存器显示错乱 | `stop_seq` 校验丢弃过期响应 |
12 | 无 GDB / 无 ELF | 一开就崩 | 预检 + 错误码 + hint（先 build / 配 gdb） |
13 | `gdb_port` 下发顺序错误，仍绑 3333 | 端口冲突复发、连到驾驶舱 HTTP | 端口命令前置于 `-f target`；启动后校验实际监听端口 |

---

## 14. 可移植性

| 维度 | 本方案做法 | 换目标要改什么 |
|---|---|---|
| 芯片/厂商 | 只认 `chip.debug.device/svd`；无厂商分支 | 新芯片包声明 SVD/device，**不改内核** |
| 探针 | P0 只 openocd；`GdbServerAdapter`（argv + 端口 + 复位命令）可插拔 | 加 J-Link/pyOCD/BMP 适配器（同一 MI 面） |
| 工具链 | `plan.host.gdb` 已支持自定义前缀/路径 | 换 `gdb-multiarch` 只改 host 配置 |
| 宿主 UI | HTTP + SSE 是唯一契约；DSH 面板只是渲染器之一 | WebUI / 其他 IDE / 脚本复用同一 ICD |
| 操作系统 | 端口分配、`proc_kwargs`（Windows `CREATE_NO_WINDOW`） | POSIX 注意进程组回收（`start_new_session` + killpg） |
| GDB 版本 | MI2 基线；`mi-async` 失败降级并在 `meta.debug` 暴露 | 老 GDB 面板仍可用，暂停降级 |
| 回滚 | 环境变量 `ELAB_DEBUG=0` → `meta.debug.available=false`，面板隐藏入口 | 一行开关，零数据迁移 |
| 无硬件演示 | `tests/fake_gdb.py`（MI 桩）可让整条链路跑起来 | 前后端联调 / CI / 教学 |

> 可移植性的关键不是“支持更多芯片”，而是**没有一处 `if vendor == ...`**：芯片差异只存在于 `pack.yaml` 的 `debug` 节与 SVD 文件。

---

## 15. 附录

### A. UI 动作 → MI 命令

| 动作 | MI 命令 | 备注 |
|---|---|---|
连接 | `-target-select extended-remote 127.0.0.1:<port>` | 先 `-gdb-set mi-async on` |
复位暂停 | `-interpreter-exec console "monitor reset halt"` | 失败则 `-interpreter-exec console "reset halt"` |
下载 | `-target-download` 或 `console "load"` | 仅当 `plan.flash_images` 为空（C33e） |
运行到 main | `-break-insert -t main` + `-exec-continue` | 临时断点，命中后删 |
继续 | `-exec-continue` | 不等结果；等 `*stopped` |
暂停 | `-exec-interrupt` | 需 async |
单步 | `-exec-next` / `-exec-step` / `-exec-finish` | 源码级 |
指令级 | `-exec-next-instruction` / `-exec-step-instruction` | 反汇编页 |
线程 | `-thread-info` / `-thread-select N` | RTOS 需 server 支持 |
帧 | `-stack-list-frames` / `-stack-select-frame N` | |
变量 | `-stack-list-variables --all-values` / `-var-create` / `-var-list-children --all-values` | 懒加载 |
寄存器 | `-data-list-register-names` / `-data-list-register-values x\|N` | 组过滤在服务端 |
断点 | `-break-insert [-h] [-t] [cond] loc` / `-break-condition` / `-break-list` / `-break-delete` | |
内存 | `-data-read-memory-bytes addr n` / `-data-write-memory-bytes addr "hex"` | 分块 ≤256B |
反汇编 | `-data-disassemble -s a -e b -- 0\|2` | mode 0 含源码行 |
求值 | `-data-evaluate-expression expr` | Agent 只读；写需闸门 |

### B. 参考

- Cortex-Debug README：<https://github.com/Marus/cortex-debug>
- launch 属性表：<https://github.com/Marus/cortex-debug/blob/master/debug_attributes.md>
- 多核调试：<https://github.com/Marus/cortex-debug/wiki/Multi-core-debugging>
- 反汇编调试：<https://github.com/Marus/cortex-debug/wiki/Disassembly-Debugging>
- mcu-debug 前端套件：<https://marketplace.visualstudio.com/search?term=mcu-debug&target=VSCode&category=All%20categories&sortBy=Relevance>
- GDB/MI 规范：<https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI.html>

### C. 本仓相关文档

- [技术方案_闭环驾驶舱](技术方案_闭环驾驶舱.md)
- [技术迁移方案_串口监视与调试可视化](技术迁移方案_串口监视与调试可视化.md)
- [ICD_cockpit_events](ICD_cockpit_events.md)
- [设计约束](设计约束.md)（C14/C15/C28/C34/C36）
- [01-芯片开发上手_独立WebUI](../tutorials/01-芯片开发上手_独立WebUI.md)（第一关：心跳 + LED）
</content>
