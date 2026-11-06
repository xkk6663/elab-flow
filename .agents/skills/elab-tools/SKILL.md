---
name: elab-tools
description: elab-Flow 的 agent 工具索引：按「我要做什么」快速定位 CLI 子命令、驾驶舱 HTTP 端点、DSH elab_* 工具，以及工程字段/模板速查。触发：不知道该用哪个命令或工具、查 API/参数、串口/调试/OTA/适配/芯片包/provider 怎么调用、工具返回字段什么意思。
---

# elab-Flow 工具索引（agent 速查）

> 用法：先看 §1「任务 → 工具」，再按 §2–§4 查具体入口，最后用 §5–§7 核对字段和约束。
> 入口总览与架构见 `elab-agent` skill；闭环操作见 `elab-loop` skill。

## 1. 任务 → 工具（先查这里）

| 我要做什么 | DSH 内优先 | 仓库外 / 脚本 | 驾驶舱 HTTP |
|---|---|---|---|
| 查工程名、每步可用性、当前 run | `elab_status` | `elab list --json` | `GET /api/projects` |
| 查工具用法 / 能力自描述 | `elab_guide` | `elab --help` | `GET /api/capabilities` |
| 只编译 | `elab_run action="build"` | `elab build -p P` | `POST /api/run {"steps":"build"}` |
| 编译+烧录+调试校验 | `elab_run action="triple"` | `elab run -p P --steps build,flash,debug_verify` | 同上 `steps` |
| 完整闭环 | `elab_run action="loop"` | `elab loop -p P` | 同上 `steps=doctor,build,flash,debug_verify,monitor` |
| 指定任意步骤组合 | `elab_run action="step"` | `elab run -p P --steps S` | `POST /api/run` |
| 只看会执行什么 | `elab_run action="preview"` | `elab run -p P --dry-run` | `GET /api/plan?project=P&steps=S` |
| 取消 run | `elab_run action="cancel"` | Ctrl+C / 进程 | `POST /api/cancel {"run":R}` |
| 读构建/烧录日志 | `elab_log` | `elab run ... -v` | `GET /api/run-events?run=R&from=N` / `GET /api/events`(SSE) |
| 串口判心跳/等日志 | `elab_serial_wait` | `elab monitor -p P` | 监视 + `GET /api/serial/monitor/bytes` |
| 开/关串口监视 | `elab_serial action="monitor" op="open\|close"` | — | `GET/POST /api/serial/monitor` |
| 读串口增量 | `elab_serial_read` | — | `GET /api/serial/monitor/bytes|decoded|issues` |
| 往串口写 | `elab_serial action="write"`（需 allowAgentWrite） | `elab serial -p P --data "..."` | `POST /api/serial` |
| 定时/周期发送 | — | — | `POST /api/serial/loop` |
| 自定义发送组件 | `elab_serial_widget` | — | `GET/POST /api/serial/widgets` + `/widget/{run,cancel,pause}` |
| 帧协议配置/预览/组帧 | `elab_frame action="list\|get\|preview\|save\|delete\|encode\|templates\|import"` | — | `GET/POST /api/serial/frames`、`POST .../preview`、`.../encode`、`.../templates` |
| 解码一帧 / 读共享解码 | `elab_serial action="decode"` / `action="decoded"` | — | `POST /api/serial/decode`、`GET .../decoded` |
| 协议自学习（抓包→草稿→验证→C 代码） | `elab_frame_learn action="learn\|verify\|auto\|codegen"` | — | `POST /api/serial/frames/{learn,verify,auto,codegen}` |
| 录制串口 / 导出 | `elab_serial_capture` | — | `POST /api/serial/capture` |
| DTR/RTS、复位下载 | — | — | `GET/POST /api/serial/control` |
| 日志 panic 剖析 / 地址符号化 | — | — | `GET /api/serial/log-profiles`、`POST /api/serial/symbolize` |
| GDB 调试会话 | `elab_debug action="open\|control\|inspect\|breakpoint\|wait\|close"` | `elab debug -p P --run|--verify` | `/api/debug/*` |
| 接新工程 | `elab_pkg action="adapt"` | `elab adapt <path> --probe` → `--write` → `--verify` | `POST /api/adapt` |
| 芯片包 | `elab_pkg` | `elab pkg ...` | `GET /api/packs`、`POST /api/pkg/{...}` |
| 工具链 provider | 无 | `elab provider ...` | 无（CLI 专用） |
| 双槽 OTA / 注入 | — | `elab run -p P --steps tool:ota` | `POST /api/run`（`steps=tool:...`） |
| 版本锁定 | 无 | `elab lock` / `elab lock --check --strict` | 无 |
| 生成平台 skill | 无 | `elab skill -p P|--chip C|--all` | 无 |
| 发布 | 无 | 见 `elab-release` | 无 |

`P` = `projects/*.yaml` 的 `name`，别用目录名猜。`S` = 逗号分隔步骤或 `tool:<name>`。

## 2. CLI 索引

### 2.1 核心命令

| 命令 | 关键参数 | 说明 |
|---|---|---|
| `elab list` | `--json` | 主机/芯片/工程/包 |
| `elab doctor` | `-p P`、`--deep`、`--strict-lock`、`--json` | 三层体检 + 两源漂移 |
| `elab setup` | `--pack NAME`、`-p P`、`--json` | 装包后的环境自检：芯片包 / provider / 工具链主机键 / 协议探针，缺什么给下一步（0=就绪 / 1=缺失） |
| `elab build` | `-p P`/`--all`、`--clean`、`-j`、`-v`、`--dry-run`、`--no-guard` | 产物统一、内存占位；F411 自动级联 boot |
| `elab flash` | `-p P`（必填）、`--dry-run`、`-v`、`--reflash-boot` | 同会话按 `flash.images` 顺序烧录；boot 有冻结台账 |
| `elab debug` | `-p P`、`--run`、`--verify` | agent 用 `--verify` 取证；`--run` 是交互式 |
| `elab loop` | `-p P`、`--clean`、`--no-flash/--no-debug/--no-monitor`、`--dry-run` | 闭环；`--dry-run` 只预览，不执行 |
| `elab monitor` | `-p P`、`--port`、`--line`、`--seconds`、`-q`、`--reset-port`、`--caps` | 判据；退出码 **0=ok / 1=failed / 2=inconclusive** |
| `elab serial` | `-p P`、`--data`（必填）、`--baud`、`--line`、`--read-ms`、`--no-newline`、`--hex` | 写一条 + 收回显；共用 console 留档 |
| `elab run` | `-p P`、`--steps`、`--emit-events`、`--events-dir`、`--run-id`、`--actor`、`-j`、`-q`、`--keep-going`、`--dry-run` | 驾驶舱同路径；`--steps tool:<name>` 调项目工具 |
| `elab ci` | `--job`、`--onhw`、`-p`、`--clean`、`-v` | 按 `ci/matrix.yaml` |
| `elab adapt` | `path`、`-n`、`--probe/--write/--check/--verify/--force/--clean/--no-provider` | `--verify` = doctor --deep + build + guard.untouched |
| `elab skill` | `-p`/`--chip`/`--all`/`--adapt` | 由芯片包渲染平台 skill |

### 2.2 数据与版本命令

| 命令 | 子命令 / 参数 | 说明 |
|---|---|---|
| `elab pkg` | `search [q]`、`install`、`bootstrap`、`list`、`activate`、`remove`、`update`、`verify`、`index` | `install` 支持 `--from/--git/--ref/--subdir/--archive/--sha256/--force`；`index --check` 防漂移 |
| `elab provider` | `list`、`search`、`install`、`remove` | `install` 支持 `--from/--git/--ref/--sha256/--force` |
| `elab lock` | 无 / `--check` / `--strict` | 回填或校验 `elab.lock.yaml` |

通用：所有命令支持 `--json`；`--root` 可覆盖仓库根。Windows 用 `.\elab.cmd`，或 `$env:PYTHONPATH="services"; python -m elab`。

## 3. 驾驶舱 HTTP 索引

启动：`.\cockpit.cmd` 或 `python -m cockpit.server`；默认 `127.0.0.1:8333`（刻意避开 openocd 3333）。
异步约定：`POST /api/run` 与 `/api/pkg/*` 返回 **202 + job/run id**；随后用 `/api/run-events` 或 `/api/pkg/job` 跟。

| 组 | 方法 路径 | 用途 / 关键参数 |
|---|---|---|
| meta | `GET /api/capabilities` | 自描述；先读 `meta` 再调工具 |
| projects | `GET /api/projects` | 工程卡片（`steps` 的 `ok/kind/reason`） |
| | `POST /api/adapt` | `{path,write,name}`；write=false 只探测 |
| | `POST /api/project` | rename / remove / set_probe |
| runs | `POST /api/run` | `{project,steps,clean,jobs,actor}` |
| | `POST /api/cancel` | `{run,reason}` |
| | `GET /api/runs` | 历史 + 活动 |
| | `GET /api/plan` | `?project=&steps=` 只读预览 |
| | `GET /api/run-events` | `?run=&from=` 按 seq 重放 |
| | `GET /api/events` | SSE 实时流（契约 `docs/design/ICD_cockpit_events.md`） |
| serial | `GET/POST /api/serial/monitor` | `action=open/close/decoder/clear/pause/resume/restore/log_profile` |
| | `GET /api/serial/monitor/{bytes,decoded,issues}` | 增量游标：`after`、`limit`、`direction` |
| | `GET /api/serial/console` | TX/RX 留档 |
| | `POST /api/serial` | 写一条；`dry_run` 可先预览 |
| | `POST /api/serial/loop` | 定时/周期发送任务 |
| | `GET/POST /api/serial/control` | DTR/RTS、复位预设 |
| | `GET/POST /api/serial/widgets` | 发送组件读写 |
| | `GET /api/serial/widget/job`、`POST /api/serial/widget/{run,cancel,pause}` | 组件执行 |
| | `GET/POST /api/serial/frames`、`POST /api/serial/frames/preview` | 帧协议配置 / 无硬件预览（预览支持未保存 `profile` 草稿） |
| | `GET /api/serial/frames/templates`、`POST /api/serial/frames/templates/import` | 只读模板库 / 导入为工程 profile（`rev` 乐观锁） |
| | `POST /api/serial/frames/encode` | 反向组帧：字段值 → 字节（`variant` / `length_value` 可选） |
| | `POST /api/serial/capture` | start/stop/status 录制 |
| | `POST /api/serial/decode` | 无状态解码 |
| | `GET /api/serial/log-profiles`、`POST /api/serial/symbolize` | 日志剖析 / addr2line |
| debug | `GET/POST/DELETE /api/debug/session` | 开/快照/关；close 默认恢复运行 |
| | `POST /api/debug/control` | continue/pause/step/reset/run_to |
| | `GET /api/debug/{stack,variables,registers,breakpoints,watch,audit,peripherals,rtos,memory,disasm}` | 只读视图 |
| | `POST /api/debug/{breakpoints,watch,evaluate,write}` | 写操作；write 需 `confirm` + `rev` |
| | `GET /api/debug/events` | SSE 调试事件 |
| pkg | `GET /api/packs` | `?market=&q=` 市场/已装；已装记录含 `latest` / `updatable`（市场有新版本时为 true） |
| | `POST /api/pkg/{install,remove,verify,update,activate,market}` | 202 + job（verify/activate 同步）；update 按市场索引，同版本或本地更高默认跳过，`--force` 才覆盖 |
| | `GET /api/pkg/job` | 任务快照 |
| runtime | `GET /api/serial/monitor` | 端口、后端、监视会话、console |

## 4. DSH `elab_*` 工具索引（混合门面）

> 在 DSH 内优先用这些工具（结构化返回、自动带 run id）。
> **契约（name/description/parameters）**在 `packages/dsh-elab-cockpit/src/domain/tools.ts`
> （Tool 概念属 domain）；**实现**在 `src/adapters/dsh-tools/*-ops.ts`。
> 意图树（每个动作的同义词与前置条件）用 `elab_guide` 按 `topic` 取。
>
> 门面化说明：工具按**意图**分门面，不再按「一个动作一个工具」平铺；
> 高频动作另有细粒度快捷入口（elab_log / elab_serial_read / elab_serial_wait /
> elab_debug_inspect）。旧名（elab_triple / elab_frame_profile / elab_debug_open …）
> 已收进对应门面，需要过渡期时插件配置 `toolMode: both`。

| 组 | 工具 | 关键参数 / 用途 |
|---|---|---|
| 状态 | `elab_status` | 无参；工程列表 + 每步可用性 + 当前 run + 串口现状 |
| | `elab_guide` | `topic`（overview/run/serial/debug/frame/pkg）；意图树 + 旧名迁移表 |
| 运行 | `elab_run` | `action`=build/triple/loop/step/preview/cancel；`project,steps,clean,jobs,run,reason` |
| | `elab_log` | `run,step,tail` |
| 串口 | `elab_serial` | `action`=monitor/write/decode/decoded/stats/read/wait；`op`=monitor 子动作（open/close/decoder/clear/pause/resume） |
| | `elab_serial_read` | `after,direction,limit` |
| | `elab_serial_wait` | `pattern`（正则），等心跳/日志；`timeout_ms,poll_ms` |
| | `elab_serial_capture` | `action` start/stop/status；写盘需 allowAgentWrite |
| | `elab_serial_widget` | `action,project,id,rev`；组件/序列 |
| 调试 | `elab_debug` | `action`=open/control/inspect/breakpoint/wait/close；`op`=control/breakpoint 子动作；`what`=inspect 视图 |
| | `elab_debug_inspect` | `what`（stack/variables/registers/…） |
| 帧协议 | `elab_frame` | `action`=list/get/preview/save/delete/encode/templates/import；`project,id,rev,profile,values,variant,length_value,hex,b64,template,new_id` |
| | `elab_frame_learn` | `action`=learn/verify/auto/codegen；`capture,frames,hints,field_count,name,apply,write,overwrite` |
| 工程/包 | `elab_pkg` | `action`=status/search/install/activate/remove/update/verify/adapt；`name,query,official,force,wait_s,path,write` |

写操作（串口写 / 适配写盘 / 录制 / profile 落盘）受 `allowAgentWrite` 门控；
profile 的 save/delete/import 还要 `rev` 乐观锁（先 `elab_frame action=list` 取 rev）。

## 5. 工程字段速查（`projects/*.yaml`）

| 字段 | 作用 |
|---|---|
| `pack` / `chip` | 绑定芯片包与芯片条目（芯片参数来自 pack） |
| `provider` | 工具链绑定，如 `espressif/idf@>=1 <2` |
| `serial` | `port/baud/line`；`monitor.close_on/fail_on` 决定串口判据 |
| `steps` | 步骤可用性 / 显式覆盖：`<step>: tool:<name>` 或 `skip` |
| `tools` | 项目级工具（OTA/注入），用 `elab run --steps tool:<name>` 调用 |
| `flash.images` | 多镜像烧录：`{path,address,format,ld}` |
| `artifacts` | `elf/bin/map/flash_args`，覆盖 provider 同名键 |
| `version` / `step_labels` | 固件版本 / 步骤显示文案 |

模板命名空间（provider 与内联 `tools` 共用）：

```text
${root} ${work_dir} ${name} ${runs_dir} ${serial_port}
${host:tools.xxx}          elab.host.yaml 点路径
${env:NAME}                环境变量
${chip.target} ${chip.flash_chip} ${project.serial.baud}
${json_args:FILE#KEY}      从 JSON 产物展开 argv 元素
```

未知命名空间会 fail-fast，不要自创。

## 6. 自描述字段（`GET /api/capabilities`）

| 路径 | 内容 |
|---|---|
| `meta.steps` / `meta.plans` | 步骤标签+通道；三档定义（内核唯一事实源） |
| `meta.channels` | `build/flash/debug/serial/tools` 日志通道 |
| `meta.serial` | `views/formats/encodings/eols/decoders/frames{schema,templates,features}/features/transports/widget/line/reconnect/loop` |
| `meta.debug` | `actions/stop_at/breakpoint_kinds/registers_group/formats/lease/limits/error_codes` |
| `steps` / `active_runs` / `packs` / `serial` | 运行时快照 |

串口/调试的可选值**只从 meta 取**，不要在 agent 侧写死枚举。
帧协议 profile 的权威 schema 在 `SERIAL_META.frames.schema`；
新特性开关是 `SERIAL_META.frames.features`（`frame_bitfields` / `frame_length_field` /
`frame_variants` / `frame_encode` / `frame_templates` / `agent_frame_edit`）。
解码器写 `profile:<id>`；多 ID 时通道按 variant 字段并集对齐，缺失值为 `null`。

## 7. 调用规则与坑

- **先预览再上板**：任何 flash/debug 前先 `elab_run action="preview"` 或 `run --dry-run`。
- **单飞**：同一会话最多 1 个 run；并发会 `human-busy`。
- **串口独占**：监视占用时 flash/debug 会 `serial-busy`；先 `elab_serial(action="monitor", op="close")`。
- **写权限**：`elab_serial(action="write")` / `elab_serial_capture` / `elab_pkg(action="adapt", write=true)` 需 `allowAgentWrite`，被拒就转告用户，不要绕。
- **监视租约**：默认 120s，用完及时 close，避免挡住后续闭环。
- **步骤可用性**：看卡片 `steps[].kind`；`unavailable` 带着 `reason`，不要回退拼命令。
- **provider 缺步骤**：直接报错；`elab provider list` 查 installed/steps。
- **不要绕过 elab**：不要直接跑 `cmake`/`idf.py`/`openocd` 拼闭环；CLI 预览里的 argv 就是实跑命令。
- **硬件结论**：串口心跳可由 agent 判定；LED 均匀闪烁必须人工确认（AGENTS C36）。
