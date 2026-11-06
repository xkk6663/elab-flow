# 更新日志（Changelog）

所有显著变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

---

## [V4.0.0] — 2026-11-06（Provider 工具链 · 帧协议补强 · Agent 自学习协议 · 工具门面化 · 流程清单归位）

主仓大版本：内核 `COCKPIT_VERSION` 与 `services.elab.__version__` 升到 `4.0.0`，
插件默认下载内核版本同步为 `v4.0.0`；插件同步发 **1.0.0**（见下一条）。

本条目合并了 2026-11-04 ~ 11-06 的全部未发布批次（Provider 工具链架构、帧协议 P0/P1、
串口存量优化与 Agent 自学习协议、收尾健壮性批次、仓库清理与文档）。

### 内核：流程清单归位（`services/elab/flow.py`）


- `STEP_META` / `KERNEL_PLANS` 从 `cockpit/server.py` 挪到 **`services/elab/flow.py`**
  （流程清单 = 芯片无关的步骤词汇与三档定义，唯一事实源）；驾驶舱只引用不复制。
  新增 `step_label` / `step_channel` / `plan_steps` / `plan_requires_hardware` helper
  与回归测试 `tests/test_flow_manifest.py`（展示侧清单与 `run.ALL_STEPS` 双向一致）。
  `AGENTS.md` 的层归属表与规则 1 同步改。

### 文档：Agent 自学按钮实机教程

- **教程 07 新增 §5.7.9「按钮实操：不写一行命令，从陌生字节到直播解码」**：
  STM32F103C8T6 实机（COM10），纯面板按钮走完 learn 闭环——发 `LEARN`（须带 CRLF）
  → 粘样本 HEX → 点「学习」（置信度 99% / 回放 100% / 43/46 等长证据链）→
  人复核字段名 → 保存（同名覆盖确认）→ 解码器下拉选 profile → 直播解码
  （396 帧 · 9 通道 · 2 种消息）。4 张实拍截图入 `assets/serial-learn/`，
  附按钮 ↔ API 对照表。与 §5.7.8（API/Agent 视角）互补。
- `docs/README.md` 教程 07 条目同步登记。

### 仓库清理：死代码与过期产物清扫

收尾前的仓库整理，全部为删除性清理（git 历史可恢复），零功能变更。

#### 删除


- **一次性截图生成工具**（`docs/tutorials/assets/cli-terminal/`）：
  3 个 `.mjs` 截图脚本 + 7 个 mock `.html` 终端页面（含 82 KB 的 `build.html`）。
  教程 06 只引用 7 张成品 PNG（保留）；生成工具无任何文档引用，git 历史可找回。
- **前端死代码**：`workspaces.ts` 的 `workspaceById`、`layoutStore.ts` 的 `resetLayout`、
  `icons.tsx` 6 个未使用图标（IconRun/Folder/Wrench/Check/ChevronDown/Search）；
  插件侧 `pendingAdaptations`、`kernelMeta`、`kernelPlanSteps`、`ALL_CHANNELS`。
  （`unadaptedCandidates`/`isKernelOld`/`registeredRoutes` 虽无 src 引用但被测试/设计文档
  消费，保留。）
- **Python 未使用 import ×8**：`builder.py`（sys/ElabError）、`doctor.py`（shlex）、
  `monitor.py`（ElabError）、`plan.py`（Path）、`__main__.py`（to_fwd）、
  `cockpit/server.py`（shutil）、`tests/test_setup.py`（shutil）。
- **本地缓存**：`.pytest_cache/`、`__pycache__/`、空 `.screenshots/`（均已在 gitignore）。

#### 整理


- `docs/README.md` 补登记 `健壮性盘点_2026-11-05`（此前是唯一未入索引的文档）。

#### 扫描结论（无问题项，记录避免重复劳动）

- 177 个 docs 文件、全部教程 PNG 均被引用（交叉核对 0 孤儿）；
- `services/elab` / `cockpit` 全部 Python 模块均被引用（0 死模块）；
- `TODO` 标记仅 4 处，全部是 `adapt.py` 生成模板的占位文案（有意保留）；
- 协议计划（Modbus / CAN / 蓝牙）为**待实施**的未来计划，非过期文档；当前已按价值拆分为 Modbus 与拓展协议两份（2026-11-06）。

#### 门禁


Python 628 passed / 3 skipped；插件 143 pass + build 契约 PASS；
WebUI tsc + vite build（332.44 kB，与清理前一致）；14 个改动文件行尾 0 翻转。

### 收尾健壮性批次：轮询 / 超时 / SSE / --root

盘点报告：`docs/reports/健壮性盘点_2026-11-05.md`（11 条已**全部处置**：
8 条修复 + 3 条以更轻手段收敛，见各条说明）。

#### 内核


- **`list_runs` 只读首尾行**（P0）：`run/start` 恒为第一行、`run/end`/`run/cancel` 恒为
  最后一行，元数据不再 `replay` 整个文件；新增 `run_meta`（一次 open 读首行+尾窗，
  按 `mtime_ns+size` 缓存，追加自动失效）；目录枚举从 `glob`+逐个 `stat()` 换成
  `os.scandir`（Windows 上 DirEntry 自带 stat，免 syscall）。实测 800 条历史：
  轮询路径不再扫盘（新端点，见下），`/api/runs` 二次调用 2086 ms → **31 ms**。
- **新端点 `GET /api/runs/active`**：只读进程内活动登记簿（不扫历史目录），
  给 2 s 轮询用；开销与历史条数**解耦**。插件代理白名单已同步（`routes.ts` GET_ALLOW）。
- **SSE 上限 8 → 16**：3 标签页（run 流 + 串口 + 调试壳层/pane）即可撞满 8，
  而 503 对 EventSource 是"直接关闭、不自动重连"——满员的代价是静默停更。
- **run 清理入口**（P3 #11）：`events.prune_runs(keep, days, dry_run)` 双闸清理
  （mtime 倒序第 N 条之后 + N 天前；**running 的 run 永不删**，孤儿 proc / 无关文件
  不碰）。三处入口同一份规则：CLI `elab runs prune [--keep 50] [--days 30]
  [--dry-run]`、`POST /api/runs/prune`（面板后续可接）。
- **串口四路合并轮询**（P2 #4）：`GET /api/serial/monitor/poll?line&byte&issue&dec`
  一次带回行 tail + 字节批次 + 结构化 issue + 共享解码帧（后两路按 profile/decoder
  开关决定是否在响应里，与旧前端"开着才拉"同规则）。轮询连接占用 4 → 1，
  且四路是同一时刻的快照。

#### WebUI


- **全部 fetch 加超时**（P1）：`client.ts` 的 `req()` 统一 `AbortSignal.timeout`，
  默认 15 s，长任务（debug open 20 s / learn / 串口手写读窗口 / prune）60 s；
  超时抛 `ApiError("client-timeout")`，文案带 hint。内核挂住时不再永远"加载中"、
  不再占死浏览器 6 连接池。老浏览器无 `AbortSignal.timeout` 时退回
  `AbortController+setTimeout`。
- **跟随轮询改轻量端点 + 防重入**（P0）：App.tsx 的 2 s 轮询从 `/api/runs` 改打
  `/api/runs/active`，并加 `followBusyRef`（与串口轮询的 `busyRef` 对齐）——
  上一拍没回就跳过，不再堆请求。
- **串口轮询切到合并端点**（#4）：`useSerialStream` 每拍 1 个请求带回四路增量；
  解码器切换时丢弃当拍 `decoded`（按旧游标拉的新协议帧），下一拍从 0 正常追。
- **SSE 断流可感知**（P1）：`sse.ts` 区分 `CONNECTING`（浏览器自动重连）与
  `CLOSED`（浏览器已放弃，典型是 503 满员）——后者自建重连（3 s × 5 次，
  `from=` 用**已收到的最大 seq** 而非初始值，避免整段重放），重试耗尽上报
  `dead` 状态，头部 Pill 显示"事件流已断开"。
- **调试壳层 SSE 按需建**（P2）：无会话不再白占 1 个 SSE 名额（每标签页 1 条 ×
  多标签页会加速撞上限）；pane 流 503 关闭时在输出区明说原因。
- **LogRing.push 改逐个 push**（P3 #10）：消除 `push(...lines)` 在超大批次下
  触发 V8 参数上限的理论爆栈点。

#### CLI


- **`--root` 提到全局**（P2）：`elab --root X list` 不再报误导性的
  `invalid choice: 'X'`；子命令级参数保留（SUPPRESS 默认，显式给时优先），
  两种位置都合法。
- **兜底异常**（P3 #8）：`main()` 补 `except Exception` —— 漏网的
  KeyError/OSError 不再吐整屏 traceback，改成人话 + `ELAB_TRACE=1` 看栈；
  Ctrl-C 干净退出（130）。

#### 可维护性


- **topic 镜像一致性守卫**（P3 #9）：新增 `packages/dsh-elab-cockpit/test/
  icd-topics.test.mjs` 三例——① 前端 KNOWN_TOPICS ⊇ 内核 KNOWN_TOPICS ∪
  服务端合成帧（`proc/stdout-batch`/`stream/closed`）；② 插件自包含镜像
  `domain/icd.ts` 与共享层逐项一致；③ topic 命名空间白名单（新前缀 = 契约级
  变更，测试会拦）。新增 topic 不再可能静默丢事件。

#### 明确不做 / 收敛方式


- **#7 长请求无取消**：完整取消需把 debug open / learn 改成作业化轮询，
  收尾阶段改动风险大于收益。以 ② 的超时（15/60 s 可预期失败）+ 错误 hint
  （"确认内核仍在运行；若刚强杀过它…"）+ 空态 RECOVERY 表收敛；
  真要中断用 Ctrl-C 内核后界面会按 `client-timeout` 明确报错，不再挂死。

#### 门禁


Python 628 passed / 3 skipped；插件 143 pass（新增 topic 守卫 3 例）+ build 契约
PASS；WebUI `tsc --noEmit` + vite build（332.44 kB）；本轮改动文件行尾与 HEAD
比对 0 翻转。端到端：临时内核验证 `/api/serial/monitor/poll`（四路形状 + 参数
校验人话报错）、`POST /api/runs/prune`（dry_run）、`elab runs prune --dry-run`。

### 串口存量优化：帧协议补强 / 帧级观测 / Agent 自学习协议

执行计划：`docs/design/执行计划_串口存量优化_帧协议补强与Agent能力.md`（P2.2 + P3 + P4，全实机验收）。

#### 内核：帧协议补强 P2.2


- **校验声明化**：`CRC_PRESETS`（crc8 / crc8_maxim / crc8_j1850 / ccitt_false / xmodem /
  x25 / modbus / ibm / crc32）+ 参数化引擎（Rocksoft 模型），标准检查值 `123456789` 全部对上；
  `checksum.cover` 支持 `frame / after_head / before_checksum / before_tail / payload` 锚点，
  `at` 支持 head/tail。老写法 `{"kind":"crc16modbus"}` 行为与输出不变。
- **转义**：`escape`（`escape_byte` / `xor` / `targets` / `applies`）。**先切帧再反转义**、
  校验在转义前算；与 `frame.length` / `length_field` 互斥（保存时直接拒绝）。
- **多帧头**：`frame.heads`（最长匹配优先）；**空闲分包**：`frame.idle_gap_ms`
  （会话侧按到达间隔切段，静默即一帧结束）。
- **字段模型**：`array{count,stride}`（展开 `name[i]` 通道）、`str` + `encoding`
  （utf-8/gbk/ascii/latin-1）、`f16`、`bits{bit:label}`（保留原值 + `flags` 人话列表）、
  `allow_overlap`；重叠校验改按**位区间**判（同字节内不同位是合法的）。
- **错误分类**：解码结果新增 `reasons`（`no_head / bad_length / short / tail_mismatch /
  checksum / unknown_id / bad_id / field`），`skipped` 为其和。

#### 内核：观测 P3


- `serialmon.frame_stats(window_s)` + `GET /api/serial/monitor/stats`：帧率、到达间隔
  mean/p95/max/min、每 variant 计数、错误分类累计、`error_rate`、`pending_bytes`、`rate_bps`；
  `window_s=0` 表示"最短窗口"（下限 1 s），不是"没给"。
- **触发式录制**：`capture start` 支持 `trigger`（`pattern` 原始字节 / `field` 解码字段比较 /
  `frame_index` 第 N 帧）与 `pre_bytes` 预录环形缓冲；命中连"命中之前"一起落盘并写标记行，
  命中后继续录；`stop` 回报 `armed / triggered / triggered_by / note`。
  按字段/帧序号触发**至少保留命中前的一批字节**（否则命中的现场会被自己丢掉）。
- 面板波形页新增一行健康度（fps / Δ均值·p95 / 错误占比 / 消息种类 / 半帧字节），
  读数来自会话共享解码，离线波形不轮询。

#### 内核：Agent 生产力 P4（★ 自学习）


- 新增 `services/elab/framelearn.py`：
  - `learn`：抓包 → 草稿 profile（帧头/帧长/长度字段/校验/帧尾/id/字段），
    返回 `draft + confidence + evidence + warnings + decode_rate + preview`，**不写任何文件**；
  - `verify`：解 → 用无损副本重编 → 与线上字节逐字节比对；
  - `auto`：在一组 profile 里按字节覆盖率打分挑选，`AUTO_MIN_SCORE=0.55`、
    `AUTO_MARGIN=1.15`，不达标或前两名接近直接拒绝（不硬猜）；
  - `codegen`：profile → C 头文件（偏移宏 + 打包结构体 + 小端/大端读函数）。
- 真实抓包逼出的两个修正：帧头候选**按长度分组**取（否则 ASCII 日志的 4 字节片段挤掉
  2 字节真帧头）、定长判定允许**多数派等长**（≥80%，日志行穿插不再把定长帧误判成变长）。

#### HTTP / 插件 / 前端


- `cockpit/server.py`：新增 `GET /api/serial/monitor/stats`、
  `POST /api/serial/frames/{learn,verify,auto,codegen}`；`capture start` 支持 `trigger`/`pre_bytes`；
  `SERIAL_META.frames` 补 `crc_presets / cover_anchors / encodings / escape_applies /
  max_array / endpoints / learn`，schema 补 `escape / heads / idle_gap_ms / bits / array`，
  `features` 增 14 项。`capture` 参数可传 JSONL 文本或录制**路径**（限本工程 `.work/.cockpit/*.jsonl`）。
- `packages/dsh-elab-cockpit`：`elab_frame_profile` 扩展 `learn / verify / auto / codegen`，
  新增 `elab_serial_stats`，`elab_serial_capture` 支持 `trigger / pre_bytes`；
  HTTP 白名单同步 5 个端点。
- WebUI：帧抽屉预览行加「学习」按钮；解码摘要把 `reasons` 翻成人话；波形健康度条。


#### 修复：调试面板把内核错误"吞成 HTTP 503"

实机踩到：探针被别的会话占着时点「开始调试」，内核回 503 `debug-gdb-missing`，
界面上看不到任何原因，用户只会觉得"点了没反应"。

- **根因在 HTTP 客户端的错误解析**（`kernel-http/icd-client.ts`、`cockpit/web/src/api/client.ts`）：
  内核把 `code` / `hint` 放在 body **顶层**、`error` 是**字符串**
  （`{"error":"…","code":"debug-gdb-missing","message":"…","hint":"CMSIS-DAP command mismatch…"}`），
  旧代码按 `body.error.code` 取，两种形状都取不到 → `code` 退化成 `http-503`、
  `message` 退化成 `HTTP 503`、`hint` 永久丢失。现改为同时认
  「`error` 为字符串」和「`error` 为对象」两种形状，`ElabApiError` /
  `ApiError` 新增 `hint` 与 `status`。
- 面板（`DebugView.tsx`）不再把内核 `code` 覆盖成 `debug-xxx-failed`；
  统一走 `toPanelError()`，保留 `code` + `message` + `hint`。
- **空态不再吞错**：无会话时错误直接渲染在正文（红色块：`打不开调试会话 · <code>` +
  hint + 针对 `debug-gdb-missing / debug-openocd-dead / debug-target-busy /
  debug-port-hijacked / debug-elf-missing` 的「怎么办」指引），有会话时仍是顶部细条并带 × 收起。
- WebUI `DebugWorkspace` 的错误文案追加 `（hint）`。
- 测试：新增 `test/api-error.test.mjs` 5 例（真内核 409 `debug-elf-missing` /
  hint `先跑 build` 端到端验证过）。

#### 修复：强杀内核后会留下孤儿 openocd（作业对象兜底）


- **现象**：调试探针被占着时点「开始调试」，内核回 `debug-gdb-missing`
  （`CMSIS-DAP command mismatch`）；清场时强杀内核会留下**父进程已消失**的
  `openocd.exe` 继续握着 DAP，下次 open 还是同样的错，只能手动 `taskkill`。
- **根因**：这是**没法用 finally 收**的泄漏——`TerminateProcess` / 关掉驾驶舱窗口时
  用户态收尾代码一行都不执行，`atexit` 也不跑。
- **修法**：`services/elab/_winproc.py` 新增 Windows 作业对象能力——内核启动时建
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 作业，子进程派生后立刻
  `AssignProcessToJobObject`。句柄只由内核持有，内核**无论怎么死**，系统关闭句柄
  → 作业内所有进程（含子孙）被终止。这条链路由内核对象引用计数驱动，不依赖用户态代码。
- **接入点**（会占硬件资源的那几个）：`debugsession` 的 openocd、`gdbmi` 的 gdb、
  `flash` 的一过性 gdb server、驾驶舱「运行」的 `elab` 进程树（固件程序会占串口）。
- **降级**：非 Windows / 作业建不出来 / 受限环境 assign 失败，一律返回 False 走原行为，
  **绝不因为兜底能力让调试打不开**。从 Popen 返回到 assign 之间有微秒级窗口（如实说明）。
- **边界**：本方案只管「以后不再产生孤儿」；升级前**已经跑着**的孤儿仍需手动清一次。
- 实测：`POST /api/debug/session` 起会话（openocd + gdb 在跑）→ `taskkill /F` 打内核
  → 2.5 s 后两者都不在进程表里；对照组（裸 `Popen`）子进程存活。正常 `DELETE` 关闭
  会话的收尾路径不受影响（关闭后进程消失，可立刻重新 open）。

#### 健壮性复查：串口学习的规模闸门与"静默失效"


读源码复查时发现并修掉的几处（都有实测/单测支撑）：

- **`learn` 没有规模上限（性能/内存）**：`find_heads` 的 n-gram 扫描 + 校验探测
  是「预设数 × 帧数」的乘法 —— 实测 58 KB / 6.5k 帧要 **30 s**，1 MB 量级的录制
  按线性外推是分钟级（内核线程被占住，前端与 agent 都会超时）。现在三道上限：
  `MAX_ANALYZE_BYTES`（128 KB，超出只分析前段并如实告警）、`MAX_DETECT_FRAMES`
  （探测取样 400 帧）、`MAX_LEARN_FRAMES`（显式帧列表 4000 帧）。另给校验探测加了
  **12 帧小样本预筛**：先在小子集上筛掉明显不对的预设，疑似命中的才在完整样本上复核。
  实测 **58 KB 30 s → 1.0 s**，176 KB（HTTP 全链路）**1.9 s**，1 MB 从"分钟级"→ **1.8 s**，
  且识别结论不变（真机抓包仍是 `5AA5` / 定长 10 / `crc8_maxim` / 回放 169/169）。
- **录制文件与请求体没有大小闸**：`capture` 路径读入上限 16 MB（学习只用开头几万字节）；
  请求体上限 8 MB。拒收大 body 时**先把 body 读掉再回错**（否则客户端还在上传就被 RST，
  收到的是 `ConnectionAbortedError` 而不是"请求体太大"），实测 20 MB → HTTP 400 耗时 0.47 s。
- **触发录制参数静默失效**：`pattern` 拼错、`op` 写错、`frame_index=0`、字段名不存在 ——
  以前一律在匹配阶段静默 `return`，录制永远不命中，用户只会以为"问题没复现"。现在
  布防时就校验并报错；字段名不在当前解码器里则回 `warnings`（不拦，因为解码器可能后设）。
- **`codegen` 生成非法 C**：`guard` 原样拼进 `#ifndef`（换行可注入任意行）；
  字段名允许中文/连字符（schema 只要求非空不重复）→ `char 温度[]` 编不过。
  现在 `guard` 非合法标识符就退回默认名并告警；字段名统一净化为 C 标识符（含重名去重）。
- **保存同名 profile 会静默覆盖**：`learn` 默认 id 就是 `learned`，连学两次再保存会把
  前一个冲掉。内核响应新增 `overwritten`，面板保存前弹出确认。
- **学习按钮没有忙碌态**：慢的时候可以连点，叠出多个并发学习请求。现在按钮禁用并
  显示已跑秒数。
- 清理 `learn()` 里 `if not fixed or True:` 的死条件。

#### 实机（STM32F103C8T6 / COM10）


- 固件新增 `LEARN` 命令：发 200 帧 / 20 Hz 私有协议（`5A A5 | id | v1 | v2 | seq | flags |
  crc8_maxim`，10 字节）供 Agent 自学，期间三帧演示暂停。
- 端到端结果：`learn` 置信度 0.99 / 回放 168/168、`verify` 177/177、`auto` 命中
  `profile:f103-private`(0.709)、`codegen` 头文件 `-Wall -Werror` 编译通过、
  直播解码 59 帧 / 6 通道（ENV temp·hum / VSYS mV·mA + 位标志）。
- 新增 `projects/STM32F103C8T6.frames.json` 的 `f103-private`；教程新增 5.7 节与附录 D。

#### 测试


- 新增 `tests/test_framelearn.py`（22 例：learn / verify / auto / codegen / 真机噪声回归）；
  `tests/test_serialframes.py` 追加 6 组（`Compat` / `ChecksumDecl` / `Escape` / `MultiHead` /
  `FieldModel` / `ErrorReasons` / `IdleGap`）；`tests/test_serialmon.py` 追加
  `FrameStats` / `CaptureTrigger` / `IdleGapSession`（帧级统计、三种触发、预录、空闲分包）；
  新增 `tests/test_winproc.py`（10 例：作业关句柄杀成员且不误伤、`spawn` 语义、
  `adopt` 各种降级不抛、以及「`taskkill /F` 父进程 → 子进程被带走」的端到端）

### 帧协议 P0/P1：位域 / 变长 / 多 ID / 组帧

#### 内核：帧协议 P0（位域 / 变长 / 多 ID）


- `services/elab/serialframes.py`：字段支持 `bit_offset` / `bit_length` / `bit_order`
  （`lsb0` 默认、`msb0` 线性大端位流），有符号位域做符号扩展；位域只允许整型。
- 新增 `frame.length_field`（`type: u8|u16`、`offset/endian/mul/add`），
  `total = raw*mul + add`；与 `frame.length` 互斥，非法长度进 `skipped` 并重新同步。
- 新增 `frame.id_field` + `variants`：按 id 分发字段，变体 id 唯一；未命中且有顶层字段则兜底，
  否则 `unknown_id++` 并跳过。
- `services/elab/serialcodec.py`：解码支持位域 / 变长 / variant 分发；通道取 variant 字段并集，
  缺失值输出 `null`；返回新增 `unknown_id`。

#### 内核：帧协议 P1（模板 / 组帧）


- 新增 `serialcodec.encode`：字段值 → 字节（枚举 label、逆 `scale/bias`、位写入、
  固定长/变长反算、head/tail/id/length/checksum 自动写）。
- 新增只读模板库 `templates/frames/*.json`：`telemetry_u16`、`mavlink_v1`、
  `modbus_rtu`、`dlt645_read`；`serialframes.list_templates/get_template/import_template`。
- `cockpit/server.py`：`SERIAL_META.frames` 扩充 `schema` / `templates` / `features`；
  新增 `GET /api/serial/frames/templates`、`POST /api/serial/frames/templates/import`、
  `POST /api/serial/frames/encode`；preview 与 `/api/serial/decode` 支持未保存 `profile` 草稿；
  保存/删除 profile 后活动 `profile:<id>` 会话热更新。
- 旧 profile 输出形状不变：未启用新特性时不出现 `length_field` / `id_field` / `variants` 键。
- `tests/test_serialframes.py` 新增 `ValidateEnhanced` / `DecodeEnhanced` / `Encode` / `Templates`。

#### 驾驶舱前端


- 帧协议抽屉：模板下拉 + `导入`、草稿预览（无需先保存）、组帧（字段值 → HEX 并填入发送框）、
  预览记录表新增 `ID` 列。
- 波形通道名只取 `plot` 字段，修复「枚举字段错位标到曲线」；`frames` / `values` 容忍 `null`。

#### DSH 插件


- 新增 `elab_frame_profile`（list/get/preview/save/delete/encode/templates/import）；
  Agent 只写声明式 JSON；写操作受 `allowAgentWrite` + `rev` 乐观锁。
- `elab_serial_decode` 支持 `project` + `profile` 草稿（草稿 apply 需先落盘）；
  `elab_serial_monitor` 描述补充 `profile:<id>`。
- HTTP 白名单新增 `serial/frames/templates`、`serial/frames/encode`、`serial/frames/templates/import`；
  `elab_guide` 索引补充三个工具。

#### 实机（STM32F103C8T6 / COM10）


- `examples/STM32F103C8T6/Core/Src/main.c` 每 100ms 发三类帧：位域遥测、
  变长 MAVLink、多 ID 分发；心跳/LED 仍为 1Hz。
- 新增 `projects/STM32F103C8T6.frames.json` 三份实机 profile；串口教程新增 5.6 节与附录 C。

### 内核：工具链 provider（数据与执行分离）

- 新增 `services/elab/provider.py`：manifest 校验（未知键/semver/`kernel_api`/超时）、
  版本约束、注册表、`ResolvedToolchain` 解析、安装/卸载与内容哈希复核。
- `services/elab/run.py` 改为统一执行器：`StepDecl` 的 `native` / `external` /
  `unavailable` 三分支；`--dry-run` 与实跑共享同一个 toolchain，外部 build 成功按
  `artifacts.map` 回填 RAM/FLASH。
- 解析优先级：项目 `steps.<step>: tool:<name>` → provider `steps` → 无 provider 时的原生链；
  `monitor` / `doctor_deep` 内核保留，provider 缺步骤直接报错不回退。
- 新增 `elab provider list|search|install|remove`、`elab.lock.yaml` 与
  `elab doctor --strict-lock`；`market/index.json` 新增 `providers` 数组。
- `elab.adapt` 命中 `provider_hint` 时生成 provider 绑定；`--no-provider` 保留内联兜底。
- 驾驶舱 `/api/projects` 卡片新增 `provider` / `steps`（kind+source）/ `delegated` /
  `debug_backend` / `debug_features`。
- ESP32-S31-Korvo 工程迁移为 `provider: espressif/idf@>=1 <2`；ESP-IDF v6.1 实机跑通
  编译 → 烧录 → 烧录校验 → 串口心跳闭环。
- 新增 `tests/test_provider.py`（manifest、优先级、等价 argv、安装哈希、卡片投影等 32 项）。

#### 仓库整理（Provider 批次）

- 删除误生成的根 `package.json`、遗留 `projects/idf_adapt_probe.yaml.bak` 与未被引用的截图。
- README、架构文档、ESP32 方案文档同步到 Provider 架构（内联 `tools:` 仅作兜底）。

---

## [DSH 插件 1.0.0] — 2026-11-06（Agent 工具门面化 27→14 · 契约归位 · 兼容层）

`packages/dsh-elab-cockpit` 的大版本（npm 包版本，与内核版本独立）。
默认下载内核版本同步为 `v4.0.0`。

**破坏性变更**：工具面从 27 个平铺工具收敛为 **14 个混合门面**（6 门面 + 8 细粒度）。
旧名（`elab_triple` / `elab_frame_profile` / `elab_debug_open` …）默认不再注册；
需要过渡期时把插件配置 `toolMode: both` 打开，17 个旧名会作为带废弃提示的别名一并注册。

### Agent 工具：27 → 14（混合门面）


- **注册面重构**：原来是 27 个 `elab_*` 工具一次性全注册，且**两头失衡**——
  过度平铺（`serial_read`/`serial_decoded`/`serial_decode`/`serial_wait` 语义重叠，
  agent 得自己猜该调哪个）与过度聚合（`elab_frame_profile` 一个工具背 12 个动作）。
  现在按**意图**分门面：**6 门面 + 8 细粒度 = 14 个注册工具**
  - 门面：`elab_run`（build/triple/loop/step/preview/cancel）· `elab_serial`
    （monitor/write/decode/decoded/stats/read/wait）· `elab_debug`
    （open/control/inspect/breakpoint/wait/close）· `elab_frame`
    （list/get/preview/save/delete/encode/templates/import）· `elab_frame_learn`
    （learn/verify/auto/codegen）· `elab_pkg`（status…verify/**adapt**）；
  - 细粒度高频入口：`elab_status` · `elab_guide` · `elab_log` · `elab_serial_read` ·
    `elab_serial_wait` · `elab_serial_capture` · `elab_serial_widget` · `elab_debug_inspect`。
- **意图树**：`elab_guide` 正文从扁平清单升级为**两层树**（group → action），
  每个入口带**同义词**（"烧进去"→ flash）、**前置条件**（写门控 / 串口互斥 / 调试能力探测）
  与**调用示例**；支持 `topic=overview|run|serial|debug|frame|pkg` 只取一组。
  常驻系统提示段同步加 5 行分组路由表（仍保持 < 1200 字）。
- **契约归位 domain**：工具的 name/description/parameters 移到
  `packages/dsh-elab-cockpit/src/domain/tools.ts`（Tool 概念属 domain，实现属 adapters），
  `boundary.test.mjs` 新增守卫（适配器不得内联 `name: 'elab_…'`）。
- **兼容层**：旧名（`elab_triple`/`elab_frame_profile`/`elab_debug_open` …）收进对应门面，
  迁移表进 `elab_guide`；需要过渡期时把插件配置 `toolMode: both` 打开，
  17 个旧名会作为带废弃提示的别名一并注册（默认 `facade` 不注册，上下文最省）。
  旧 `elab_serial(project, data)` 直写形态由新门面的参数推断兼容（action 可省）。
- **兼容红线不变**：旧 profile 解码结果与保存形状逐字不变；不引第三方依赖；
  写操作仍受 `allowAgentWrite` + `rev` 乐观锁约束。

### 其它插件侧增量（11-04 ~ 11-06 各批次）

- **帧协议 P0/P1**：新增 `elab_frame_profile`（list/get/preview/save/delete/encode/templates/import）
  —— 本版已收进 `elab_frame` 门面 + `elab_frame_learn` 门面；`elab_serial_decode` 支持
  `project` + `profile` 草稿（草稿 apply 需先落盘）；HTTP 白名单新增 `serial/frames/templates`、
  `serial/frames/encode`、`serial/frames/templates/import`。
- **串口存量优化**：`elab_frame_profile` 扩展 `learn / verify / auto / codegen`，
  新增 `elab_serial_stats`，`elab_serial_capture` 支持 `trigger / pre_bytes`；HTTP 白名单同步 5 个端点。
- **健壮性批次**：新增 `icd-topics.test.mjs` 三例守卫（前端 KNOWN_TOPICS ⊇ 内核集合、
  插件自包含镜像 `domain/icd.ts` 与共享层逐项一致、topic 命名空间白名单）。
- **调试错误不再被吞**：HTTP 客户端同时认「`error` 为字符串」与「`error` 为对象」两种形状，
  `ElabApiError` / `ApiError` 新增 `hint` 与 `status`；面板统一走 `toPanelError()` 保留 `code`+`message`+`hint`。
- **死代码清扫**：移除 `pendingAdaptations` / `kernelMeta` / `kernelPlanSteps` / `ALL_CHANNELS` 等未引用导出。
- **市场展示面更新**：卡片图从 2 张 v3.0.0 时期的旧 UI 换成 4 张 v4.0.0 真机窄栏图
  （闭环三连 / 串口监视 / 源码级调试 / 波形解码），`screenshots.json` 同步；
  市场条目中英简介按新能力面重写（多芯、源码级调试、帧协议、自学习）。
  图经 LANCZOS 缩放 + P256 量化（244 KB → 83 KB），npm 包体积反而从 612.1 kB 降到 562.8 kB。
- **市场封面**：新增 `assets/dsh-full-window.png`（DSH 全窗口：宿主导航 + 对话区 +
  右侧 ELAB 面板整栏）并置 `screenshots.json` 首位 —— 访客先看到插件在宿主里的
  完整形态，再看窄栏细节。压缩宽度用 1200（信息密度高于窄栏特写），77 KB。

---

## [DSH 插件 0.5.1] — 2026-11-04（agent 上下文跨工程生效 · 面板放大/跟随）

### DSH 插件：agent 侧上下文跨工程生效

- 插件挂载时向宿主 `dsh-system-prompt` 注册常驻段 `plugin:elab-cockpit`：
  工具有哪些、推荐顺序（status → triple/loop → log）、单飞 / 串口互斥 / `allowAgentWrite` 门控 / 判活纪律。
  新建工程不再需要手工放 `AGENTS.md` 或 `.agents/skills`。
- 新增只读工具 `elab_guide`：返回完整工具清单、规则与面板说明；常驻提示只留短段，细节按需取。
- 宿主未挂 `dsh-system-prompt` 时静默跳过提示段，工具与 `elab_guide` 照常可用。
- 文档分两种调用场景：插件 README 补「DSH 界面：agent 调用教程」（开面板四步 · 话术表 · 硬纪律）；
  根 README 补「独立 WebUI：通用 agent 怎么调用」（三步接入、CLI vs HTTP ICD、给通用 agent 的启动提示词）；
  工具数 24 → 25。

### DSH 插件：面板操作

- 右栏面板标题栏新增「放大 / 恢复」按钮：复用宿主 `sidebarRight` 整窗全屏（可选注入，宿主缺服务时按钮不出现）。
- 证据区把「导出 / 跟随」收进同一工具组，并新增全屏按钮，窄栏下不再挤压标题。

---

## [V3.1.0] — 2026-11-03（调试工作区 P0–P3 · 探针切换 · 闭环三态 · README 重写）

内核 `COCKPIT_VERSION` 与 `services.elab.__version__` 升到 `3.1.0`，
插件默认下载内核版本同步为 `v3.1.0`。

### 调试工作区（P0–P3）

- **会话式调试器**：开始 / 继续 / 暂停 / 单步 / 步入 / 步出 / 复位 / 关闭；
  调用栈、变量、寄存器、断点、监视、内存、反汇编、外设、RTOS 栈、审计、输出十一个页签；
  独立 WebUI 与 DSH 面板共用同一份内核会话（`services/elab/debugsession.py` / `gdbmi.py`）。
- **P1 持久化**：断点与监视落盘 `projects/<name>.debug.json`（`rev` 乐观锁），
  暂停态求值，写操作进审计；关闭固定 `monitor reset run`，不把板子留在 halt。
- **P2 外设**：CMSIS-SVD 三级懒加载、寄存器读值与字段枚举解码（`svd.py`）。
- **P3 RTOS**：ELF 里有 `pxCurrentTCB` 时枚举任务、扫描 FreeRTOS `0xA5` 栈填充，
  给出栈高水位（`rtos.py`）。
- **Agent**：新增 `elab_debug_open / control / inspect / breakpoint / wait / close`
  六个工具，与面板同源；调试 / 烧录 / 闭环 / 串口监视继续双向 409 互斥。
- **能力自描述**：`capabilities.meta.debug.features`（`watch / svd / rtos`），
  面板按它显示页签，内核过旧时自动降级。

### 探针切换

- 内核新增 `project_admin.set_probe`：只改 `debug.probe` 行、保留注释与其它字段；
  探针必须在 `elab.host.yaml` 的 `probes.list` 声明且接口文件存在。
- `capabilities.meta.probes` 下发可选探针；独立 WebUI 与 DSH 面板工程行增加探针胶囊，
  可原地切换（`POST /api/project set_probe`）。
- `atlink` 与 `dap` 同为 CMSIS-DAP，只是接口配置不同；面板「可上板」仅表示
  interface cfg 存在，不代表探针已插。

### 闭环三态

- `run/end` 新增 `verdict`：`ok / failed / inconclusive`。串口「能开但没收到约定关键字」
  记 `inconclusive`（琥珀「未验证」）；选不到口 / 打不开 / 后端不可用记 `failed`。
- CLI 退出码固定为 `0 / 1 / 2`；`elab loop` 无结论时不再打印「闭环完成」。
- 修复「没接串口却显示闭环通过」：判据缺失与环境缺失不再冒充成功。

### 文档与仓库整理

- README 重写为「定位 → 是什么 → 功能 → 怎么用」，每个功能保留 1–2 张实机截图。
- 新增教程 04（调试面板）与 05（DSH 插件）；CLI / 波形 / 压测报告重编号为 06 / 07 / 08。
- 删除未引用截图 `assets/cockpit-main.png`、`assets/cockpit-serial.png`。

## [DSH 插件 0.5.0] — 2026-11-03（调试工作区 · 探针胶囊 · 三态徽标）

`packages/dsh-elab-cockpit` 的次版本（npm 包版本，与内核版本独立）。

- **调试页签**：`▶|` 进入调试工作区，调用栈 / 变量 / 寄存器 / 断点 / 监视 / 内存 /
  外设 / RTOS 栈 / 审计 / 输出，按 `capabilities.meta.debug.features` 显示。
- **探针胶囊**：工程行可直接切换 atlink / dap / stlink / jlink，
  走 `POST /api/project set_probe`。
- **三态徽标**：「通过 / 失败 / 未验证」与独立 WebUI、CLI 同源。
- **版本**：默认下载内核 `3.0.0` → `3.1.0`。

## [V3.0.0] — 2026-11-02（串口自定义发送组件 · 窄栏一致性收尾 · 仓库整理）

主仓大版本：内核 `COCKPIT_VERSION` 与 `services.elab.__version__` 升到 `3.0.0`，
插件默认下载内核版本同步为 `v3.0.0`。

### 串口自定义发送组件（M1–M3）

- **内核**：新增 `services/elab/serialwidgets.py` —— 加载 / 校验 / 渲染
  `projects/<name>.widgets.json`，支持参数模板、`send` / `delay` / `wait` 步骤、
  `repeat` 固定节拍与 `rev` 乐观锁；`cockpit/server.py` 增加 5 个组件端点
  （清单 / 预览 / 执行 / 任务状态 / 停止），与串口监视共用同一条发送路径。
- **工具层**：DSH 窄栏与独立 WebUI 右侧栏使用同一组组件 —— chip 行 → 参数 →
  服务端预览 → `▶ 发送` / `↻ 周期` / `❚❚ 暂停任务` / `▶ 继续任务` / `■ 停止任务`；
  全部走 loopback ICD，工具层不 import 内核源码。
- **实机**（STM32F411CEU6 / COM10）：周期任务实测 `运行中 · 第 35 轮 · 280 B`，
  板子回 `PONG:7`；暂停 / 停止即时生效，人点停止即 `cancelled`。
- **测试**：`tests/test_serialwidgets.py` 覆盖加载、校验、渲染、预览、单条执行与任务状态。

### 面板修复

- **「行」视图跟随**：跟随 effect 依赖改为数组引用 + 跟随开关，移除 `onScroll` 反推；
  行缓冲封顶 2000 行后仍持续贴最新行，暂停 / 恢复即时生效。
- **波形视图**：不再参与文本跟随，避免窄栏内容溢出时把「全部 / ＋新建面板 / 通道绑定」
  整行滚出可视区。
- **选中态白块**：页签、通道芯片与组件 chip 改用 `--elab-btn-primary-bg` + 场内文字色
  + accent 描边 + 加粗，任意主题下都分得出选中项。
- **紧凑布局**：移除「发现未接入工程 / 一键适配」横幅与空态说明，重点回到档位与通道。

### 仓库整理

- 删除临时产物、Python 缓存与未引用截图；文档按四类归档，插件 README 用真实 DSH
  宿主截图重写（行 / 波形 / 参数预览 / 运行 / 暂停 / 停止）。
- **退役插件镜像仓分发链路**：删除 `.github/workflows/publish-plugin.yml` 与
  `scripts/mirror-plugin.ps1`；插件市场与 npm 直接取本仓 `packages/dsh-elab-cockpit`
  子目录，`plugin-v*` tag 仅记录版本、不再触发任何分发工作流。相关文档与发版 skill
  同步改写，历史设计文档标注「已退役」。
- **维护链路简化（单仓单标签）**：确认没有用户/渠道依赖「仓库根即插件」后，标签
  只保留内核 `vX.Y.Z`（插件自动下载内核归档依赖它），停用 `plugin-v*`；插件版本
  以 `package.json` / npm / `CHANGELOG.md` 为准，插件单独发版不再打 tag。
  架构文档不再固定插件版本号，减少逐版同步。

## [DSH 插件 0.4.0] — 2026-11-02（串口发送组件 · 波形与跟随修复 · README 重写）

`packages/dsh-elab-cockpit` 的次版本（npm 包版本，与内核版本独立）。

- **组件行**：工程 `projects/<name>.widgets.json` 的 chip、参数表单、服务端预览、
  单条发送与周期任务（暂停 / 继续 / 停止）进入窄栏，与独立 WebUI 同源同语义。
- **修复**：行视图跟随（封顶后仍贴底）、波形视图贴底滚动遮挡通道绑定、页签 / CH
  芯片白块。
- **README**：6 张真实 DSH 宿主截图；`screenshots.json` 同步；安装、自动准备、
  组件协议、实机数据与排障全部重写。
- **版本**：默认下载内核 `2.1.0` → `3.0.0`；`package.json` 补 `repository`。

## [DSH 插件 0.3.1] — 2026-11-01（上架插件市场 · 实机波形教程 · 面板两处修复）

`packages/dsh-elab-cockpit` 的补丁版本（npm 包版本，与内核版本独立）。

- **实机波形教程**：插件 README 新增「上手流程：从芯片的正弦波看到波形可视化」——
  编译 / 烧录 / 调试校验 / 串口行视图 / FireWater 波形五步，每步一张同一次真机运行的
  原始截图；截图统一入库到 `packages/dsh-elab-cockpit/assets/`（README 与市场展示同源）。
- **示例固件** `examples/STM32F411CEU6`：`StartTask02` 新增 100 Hz 采样、0.5 Hz 正弦
  输出（FireWater 协议 `0.707\r\n`）。不用 `printf`：myUSART 任务栈只有 512 B，100 Hz
  输出实测数秒后 HardFault；改用 16 B 缓冲 + `fputc` 逐字节发（自带互斥），且
  newlib-nano 未开 `-u _printf_float`，小数按毫值拼装。
- **面板修复**：`run/start` / `run/step-enter` 时进度条归零 —— 上一轮编译的
  「53/53 Linking C executable」不再残留在本轮调试/串口通道；`run/end` 主动断流后同样
  复位 `busy`，「跑完一次按钮永久变灰」彻底修掉（`cockpit-service.test.mjs` 已加密断言）。
- **市场展示**：新增 `screenshots.json` + `assets/`（5 张真机截图），`files` 清单补
  `README.md` / `screenshots.json` / `assets`，补 `keywords` 与 `icon`；
  上架投稿文件备份在 `packages/dsh-elab-cockpit/docs/dsh-market-submission/`。

## [V2.1.0] — 2026-11-01（DSH 窄栏驾驶舱 · 串口工作区 · 芯片插件市场）

V2.1.0 把 V2.0 的闭环能力**装进 DSH 右栏**，并把串口从"看输出"升级为
"人机同源的可视化工作区"。同一个 elab 内核，三种入口（CLI `elab` / 独立驾驶舱
`:8333` / DSH 面板）共用同一套 ICD 与事件流，工具层与内核之间只有 loopback HTTP。

### DSH 插件（`packages/dsh-elab-cockpit`）

- **窄栏驾驶舱**：`main / domain / app / adapters` 分层迁移（批 1–3），只注册
  `sidebar.right.pane.tab` 一个槽位；按容器宽窄/中/宽三档自适应，可见性驱动
  SSE 断开/续传，失败即中断（不自动重试）；`boundary.test.mjs` +
  `verify-client-contract.mjs` 守分层与槽位契约。
- **内核自描述消费**：`capabilities.meta` 缺失即提示内核过旧；步骤标签、三档
  计划、串口 views/formats/eols/decoders 全部由内核下发，插件内置默认只是兜底。
- **17 个 `elab_*` agent 工具**：看（status/log/cancel）、闭环（build/triple/loop/
  step/preview）、工程与包（adapt/pkg）、串口（起停/读写/等待/解码/录制）。
- **适配状态机 + skill 桥**：unbound/discovered/adapting/bound 的 banner；
  一键适配只生成 `projects/<name>.yaml`，业务工程零改动。
- **设置视图（整幅覆盖）**：芯片插件市场 + 芯片包管理（搜索/安装/启用/卸载），
  刻意不做成新槽位（槽位契约不变）。
- **双入口单实例**：面板可同时出现在原生右栏与底部工作台 —— 事件端口按
  `(run, sessionId)` 复用同一条 `/elab/events`（引用计数 + 可见性取并集），
  关一个入口不断另一个，不再各占一条上游 SSE 槽位。

### 串口工作区（P1–P3.5）

- **常驻监视会话**（`serialmon`）：进程内单例 + 按钮显式关闭 + 读线程自愈
  （异常即收摊，绝不带着死口挂着）；agent 租约 `lease_s` 到期自行释放，
  "agent 忘关"不会把串口占死（N5）。
- **字节为真值**：RX/TX 同构入字节环（`epoch` 连接纪元、`gap` 覆盖计数、`paused`
  暂停入环仍继续读口）；行文本只是字节流的投影。行 / 字节 / 终端 / 波形四视图，
  字节页可切 HEX / ASCII / UTF-8 / GBK。
- **显式录制（K5）**：**有界** 5 MiB，到顶停录并标 `truncated`，落 `.jsonl`。
- **会话级共享解码（P3.5）**：`decoder` 是**会话属性**，RX 入环时增量解码——
  帧环 1024 帧、`dec_seq` 单调、半帧 `dec_pending` 续解（超 64 KiB 丢弃并计
  `skipped`）；agent 的 `elab_serial_decoded` 与面板波形**同源同图**，TX 不解码，
  `gap` 只报告不抹平。
- **偏好与记忆**：端口/波特率落 `localStorage`；decoder 跨会话记忆（`open`
  透传 decoder，打开后第一批 RX 即解码）。
- **可关闭共享解码**：波形下拉新增「本地解码（关闭共享）」，人可一键回退到
  本地兜底路径（agent 侧仍可用 `decoder=''` 关闭）。

### 芯片插件市场（一切皆插件）

- **分层**：芯片知识（芯片 YAML / 厂商指纹 / 平台坑位）只住 `packs/**`；内核只认
  `pack.yaml` 协议（`elab.pkg`），不 import 包内文件、不为某厂商开分支。
- **内置 vs 外置**：`st/stm32` 为内置包（`elab pkg bootstrap` 安装）；`artery/at32`
  为外置示例仓库，只经市场索引登记。包与包相互独立，一次仅启用一套适配包，
  本地可存放多套按需切换。
- **零服务器市场**：`market/index.json` 只记 name/version/source/sha256/requires/
  license；`elab pkg` 全命令集（search / install / bootstrap / list / activate /
  remove / update / verify / index），`pkg index --check` 在 CI 拦索引漂移。

### P1 收口（回放 / 数据面 / 装配 / 漂移复探测）

- **波形回放器**：录制 JSONL 可在面板中纯前端回放（按 `seq/t_us` 重建时间轴、
  可拖动进度与倍速），只读且**不走 sessionId**，回放与实时互不干扰。
- **RawData 数据面补齐**：字节页 TAB 行尾、发送历史（`localStorage`
  `elab.serial.send.history` ≤50 条）、文件发送（上限 2000 行）、HEX 逐字节
  着色（`ctl/del/print/high/pad` 分类，全部用主题令牌）。
- **DSH 面板日志导出**：`EvidenceTail` 一键导出当前日志尾为纯文本（与独立
  驾驶舱同一导出语义）。
- **`cockpit/profiles/*.yaml` 槽位装配**：内核 `_profile_summary()` 解析后经
  `capabilities.meta.profile` 下发，前端 `workspaces.ts` 据此重排/裁剪右列
  Tab 与项目工具启停 —— 换一套装配 = 加/改一份 yaml，业务代码零改动。
- **`elab skill --adapt`**：生成适配 skill（`skills/elab-adapt/SKILL.md` 并镜像到
  DSH 发现路径 `.agents/skills/elab-adapt/SKILL.md`），E1–E6 证据分级与
  status 语义随包内真相一起下发。
- **适配 drift 复探测**：`POST /elab/api/adapt` 新增只读 `action=check`，
  面板适配 banner 显示「配置一致 / 工程已漂移 / 配置缺失」徽标与「复探测」按钮。
- **`tests/test_adapt.py`**：10 例覆盖探测（A/B 两类工程合同）、T3 拒写、
  written→identical→check、hand-edited 人工接管保护（`--force` 留 `.bak`）、
  未匹配芯片拒写、atwp 波特率漂移 → `drift`。

### 文档

- README 重写**项目定位（一个内核三种入口）/ 使用流程 / DSH 面板五步 / 17 工具总表 /
  共享解码**，并更新已知限制与限制边界。
- 新增 [docs/requirements/需求对照与改进.md](docs/requirements/需求对照与改进.md)：逐项对照驾驶舱 R1–R10、
  插件目标与非目标、串口 P1–P3.5、市场 R1–R4，并给出 P0/P1/P2 backlog
  （P0/P1 已全部收口，P1 证据见 §5）。

### 质量门

- 插件门禁 **99 用例全绿**（含 `boundary.test.mjs` 分层守卫、主题硬规则、
  双入口 SSE 复用、客户端契约）；内核 `unittest` 全绿（`tests/test_serialmon.py`
  **44 例**、`tests/test_adapt.py` **10 例**）。

## [V2.0.0] — 2026-10-08（OTA 平台化 · 双槽 A/B Bank · 组合工程）

V1.0.0 交付的是"闭环工作链"（build / flash / debug / monitor / CI / 事件流 / 驾驶舱）；
**V2.0.0 在其上把 OTA 从"单点能力"升级为"平台能力"**，并以 STM32F411CEU6 完成
全链路实板验收：

- **OTA 组件化**（`components/ota`）：`core/` 场景层芯片无关、`port/<platform>/`
  平台层（flash HAL / Jump / 按键 / 复位）—— boot 侧 `OtaBootFlow`、APP 侧
  `OtaAppHook`（串口扫 `!` 复位进 boot）。参考实现 `examples/STM32F411CEU6`（APP）
  与 `examples/F411CEU6_BOOT`（boot），含上位机 CLI 与驾驶舱工具页可视化。
- **双槽 A/B Bank + 坏固件自动回滚**：bank 记录 append-only（20B/条 + CRC32，
  存状态扇区上半段）；升级完成后 trial 试运行（**先减并落盘再跳**，3 次上电耗尽
  → `=== ROLLBACK ===` 回老槽）；APP 心跳第 3 次 `OTA_Confirm()` 晋级（幂等）；
  metadata `0x02` 防回滚（设备版本 ≥ 固件版本拒收）；`0x17/0x25` 版本查询
  （自迭代判据）。**实弹四件套真机全绿**：正常升级 / 坏固件回滚（CRC 合法但
  Reset 向量劫持 → 3 周期挂死 → 自动回滚 → 老固件心跳恢复）/ 版本决策同版 skip /
  槽位交替（openocd 直读 bank 记录：active 0→1→0）。实弹还抓出并修复
  **EraseRange 双语义潜伏 bug**（向上对齐误用于整片擦除 → S4 含 Reset 向量永不擦
  → 0xFFFFFFFF 劫持=按位与空操作 → 坏固件"复活"；新增 `EraseRangeFull` 向下对齐）。
- **组合工程（约束 C35）**：chips yaml 一字段 `ota_layout.boot_project` ——
  `elab build -p f411` 自动**级联构建** boot（C1）；boot 烧录走 **md5 指纹台账**
  （`--reflash-boot` 强制），日常 app 迭代 boot **字节级零触碰**（C2/C3 冻结策略）；
  驾驶舱工程轨把 boot 子工程**嵌在宿主卡正下方**（缩进 + 连接线 + 可收起披露组）
  并显示 OTA 双槽与冻结状态（C4）。
- **分区表单一事实源**：`chips/*.yaml` 的 `ota_layout:` 节 → 构建期生成
  `ota_layout_gen.h` 经 `-include` 强制注入（M1/方案 A）→ `doctor --deep` 三方
  对账（yaml 分区 ↔ 烧录地址 ↔ ld ORIGIN）；`ELAB_MFPU` 下传 `-mfpu`
  （Cortex-M4F 硬浮点，f411 实测）。
- **skill 平台化**：per-chip SKILL.md **淘汰**，改为平台聚合
  （`skills/st/stm32`、`skills/artery/at32`），具体型号作为平台条目——
  新增同族芯片不再新写 skill。
- **驾驶舱 UI 重构**：工作区注册表 `workspaces.ts` 成为右列**单一事实源**
  （加 Tab/加工具零散改动归零）；工具页**可换行启动按钮行**；默认端口
  3333→**8333**（C34，避开 openocd gdb server 3333）。
- 质量门：单测 151→**209**（+boot 组合 16 例、ota_layout、flash.images 20 例），
  集成 37/37；五工程（AT32×2 / STM32F103 / F411 app+boot）全绿，
  **STM32 上板烧录/调试/OTA 全链路实板验证**（V1.0 已知限制清零）。

### OTA 双镜像烧录（约束 C33）

- **`projects/*.yaml` 新增 `flash.images` 节**：声明 `{path, format: elf|bin,
  address?, ld?}` 烧录序列 —— 一次 openocd 会话按序 program 全部镜像，末尾
  `reset run` 收尾。bin 项**强制**显式地址（M2 教训：`program app.elf` 从擦除
  粒度边界向下对齐起擦，会覆盖 Bootloader 尾部）。首个落地工程：
  `at32f421g8u7_workbench`（SguanESC 电调台架，Boot 18K + APP 44K）。
- **`build.link_channel`**（`exe_flags` 默认 / `c_flags`）：B 类 OTA 工程必须走
  `c_flags` —— inject 盖章进 `CMAKE_C_LINK_FLAGS` 并清空 EXE 通道，让业务
  bootloader 的 `string(REPLACE ...)` 防身在 elab 接管下继续生效（M1 双 -T 根除，
  零改动业务工程）。实测：boot `.isr_vector`@0x08000000、APP@0x08004800，链接行
  单份 specs。
- **doctor 镜像级内存对账**：声明 `flash.images` 的项目改按「region ⊆ 芯片物理
  范围 + flash 分区互斥 + bin address == ld FLASH 起点」校验（单镜像工程维持
  逐字节相等口径不变）。
- **debug 镜像模式跳过 gdb `load`**（同样的向下擦除风险；闭环顺序 flash 在前，
  固件已在位）。
- **builder 校验声明镜像存在性**（缺席即 WARN，build 阶段暴露而非烧录时）。

### 修复

- **`elab adapt` 输出能力探测漏报**：只认 `__io_putchar` 与 `{` 同行的定义，
  WorkBench 生成代码的 Allman 风格（`{` 换行）被误判为"无输出能力"→ 错误放弃
  生成 monitor 判据（实测 `at32f421_int.c:279`）。现两种 C 风格均识别。
- **debug 步骤的误导性失败（约束 C34）**：驾驶舱旧默认端口 3333 与 openocd gdb
  server 冲突——端口被占时 openocd 静默退出，`_wait_port` 只测 TCP 可连导致 gdb
  连到 HTTP 服务上满屏 packet error。修复：① 驾驶舱默认端口改 **8333**；
  ② `flash.py` 检查 openocd 进程存活，占用时明确报错并给出排查命令。

### 变更

- **兼容性专项工程移出仓库**：`at32f421g8u7_workbench`（外部 BLDC 电调 OTA
  双镜像工程，用户另有备份）完成 C33 全链路验证后按用户要求移出——删除
  `examples/AT32F421G8U7_WorkBench/` 与接入 yaml，CI matrix 恢复三工程。
  C33 框架能力（flash.images / link_channel / 镜像级对账 / debug 跳 load）全部
  保留并由 20 例单测守卫。验证实录：boot `.isr_vector`@0x08000000 /
  APP@0x08004800、芯片 Flash 与 bin 逐字节一致、guard 592 文件零改动。

### 测试

- 新增 `tests/test_flash_images.py` 20 例（plan 校验 / 双镜像命令构造 / 镜像级
  对账 / putchar 探测）；新增 `tests/test_boot_combo.py` 16 例（boot 组合工程
  resolve / 冻结决策 / 台账与 _samefile）与 `tests/test_ota_layout.py`（分区表
  下传与对账）；全量回归 **209 单测 + 37 集成** 全绿。

---

## [V1.0.0] — 2026-10-05（首个正式发布）

**一套工具链 + 一套流程，驱动不同芯片的编译 / 烧录 / 调试 / 串口闭环 —— 业务工程源码零改动。**

V1.0.0 是 elab-Flow 的第一个正式版本：八层架构（L0 芯片卡 → L3 CLI → L5 CI →
L6 事件流 → L7 驾驶舱）全部贯通，三个真实工程（AT32 两个 + STM32 一个）接入并
完成上板验收。零第三方依赖 —— Python 侧仅标准库，前端产物已入仓（运行时不需要
Node）。

### ✨ 功能总览

**接入与构建（L0–L2）**

- **YAML 驱动接入**：一个 `projects/<name>.yaml` 接入一个工程；芯片参数
  （`chips/*.yaml`）声明一次全局复用。
- **两类图形配置器工程的原样接入**（约束 C1/C2 的技术支点）：
  - A 类（STM32CubeMX）：`-DCMAKE_TOOLCHAIN_FILE` 接管工具链 + inject 在
    `project()` 之后"**补回来**"（`-lm`、`.elf` 后缀等）；
  - B 类（AT32 WorkBench）：工具链行内 `include()` → inject "**抢回来**"
    （重置 `CMAKE_C_FLAGS`、清链接旗标）。
- **确定性适配器（`elab adapt`）**：扫描图形配置器导出的工程 → 生成接入 YAML
  （probe / write / check / verify 四段式）；人工接管的文件**绝不覆盖**（A7 保护）；
  **UI 一键适配**（probe 只读在前 → write 落盘 → 卡片自动出现，写入后服务端
  热重载 Config，约束 C29）。

**闭环与 CLI（L3）**

- **五步闭环**（`elab loop -p <name>`）：`doctor → build → flash → debug --verify
  → monitor`，三个工程实测全绿（含上板烧录 `** Verified OK **`、断点自检、
  串口闭环命中）。
- **串口闭环判据引擎**（`elab monitor`）：`close_on` / `fail_on` / 静默超时 →
  `ok / failed / inconclusive` 三态；`failed` 必须有正面失败证据；`fail_on`
  对整缓冲区绝对优先（防"报活即崩"被掩盖）；`judge()` 为纯函数、38 例离线单测。
- **串口手写通道**（`elab serial`，M3-b）：无状态往返（open→write→read→close），
  与闭环天然串行；CLI 与驾驶舱共用同一份实现。
- **只读命令预览**（`elab run/loop --dry-run`、`GET /api/plan`）：`--clean` 的
  删目录副作用显式标出（约束 C26：预览与实跑只有一份命令构造）。

**CI（L5）**

- **本地与云端同源**（K9）：本地 `elab ci` 与 GitHub Actions 共用同一份
  `ci/matrix.yaml`。三个 job：`host-gate`（三工程编译，云端已验证全绿）、
  `onhw-gate`（上板步骤，self-hosted 门控）、`web-dist-guard`（前端产物一致性）。
- 产物路径由 `elab ci --json` 的 build 步骤**自报**（约束 C22）—— 接入新工程
  **无需改 workflow**；门禁绿却零产物 → `exit 1`（C23）。

**事件流（L6）**

- `elab run --emit-events` 把每步写成**只追加的 JSONL 事件流**（每 run 一个
  文件、`seq` 全局单调、**单写者** C17）；`serial/*` 域事件链
  （open → line → close → closed-loop）把"串口到底说了什么"落档。
- SSE 推送：`proc/*` 100ms 合并、背压丢弃**留痕**（`stream/overrun`，C25）、
  控制帧绝不丢（C26）、SSE 合并判据只用 `is_batched`（C24 —— 实测事故的反向修复）。

**驾驶舱（L7）**

- 三列布局：工程轨（YAML 卡片 + 芯片卡 + 一键适配面板）→ 阶段轨（流水线状态带、
  内存占位取自 `.map`、产物、零改动守卫、阶段账本）→ 证据轨（构建/烧录/串口
  三合一实时日志，环形缓冲 + 命令式 DOM 追加，上万行不卡）。
- **单步执行 = 独立按钮**（C30）：阶段轨一排六颗；证据轨各 Tab 内对应按钮；
  可用性与置灰理由同源 `card.steps[id].ok`。**「跑全闭环」显式传步序**，
  空闲骨架与按钮同源。
- **串口 Tab 常驻监视**（C31，serialmon）：「打开监视 / 关闭监视」—— 读线程
  异常自愈、单例一键关闭、写通道路由进会话；输出只活服务端环形缓冲
  （`seq` 增量 + `gap` 丢行报告）+ 前端 600ms 轮询，**不进事件流也不落留档**。
  监视与闭环双向 409 互斥、指名道姓。
- **TX/RX 独立留档**（C28）：`serial-console.jsonl`（有上限、会滚动、原子替换），
  界面进工程/起闭环时按工程回填最近 60 条。
- **桌面一键启动**：仓库根 `cockpit.cmd` + 桌面快捷方式（图标 `cockpit.ico`）。
  幂等（已在跑只开 UI）；UI 走 **Edge `--app` 独立窗口**（无地址栏、任务栏独立
  图标，观感即原生应用且零依赖），Edge 缺失回落默认浏览器；裸 TCP 探测不受
  系统代理/TUN 影响；**stdio UTF-8 守卫**（C32 —— 修复"双击起服务后 UI 不弹"）。
- 真浏览器验收：日志实时滚动、页面与控制台零报错、契约版本先校验再渲染。

### 📜 设计约束（本仓库的"为什么"）

[docs/design/设计约束.md](docs/design/设计约束.md) 收录 **C1–C32** 共 32 条硬约束，每条都附"为什么"与（多数情况下）
一次真实事故。精选：

| # | 一句话 |
|---|---|
| C17 | 事件流**单写者**：只有 `elab run --emit-events` 写，其余一律不碰 |
| C22/C23 | CI 不写死产物路径；门禁绿却零产物 → 红 |
| C24–C26 | SSE 合并只认进程输出；背压丢弃留痕；控制帧绝不丢 |
| C28/C31 | 手写留档、常驻监视输出都**不进事件流**（两条道互不污染） |
| C29/C30 | 适配写入后热重载 Config；「跑全闭环」必须显式传步序 |
| C32 | stdout 被重定向 + GBK 区域编码会崩 CLI/服务 —— 包入口统一守卫 |

### ✅ 验收证据（仓库内可复核）

- 单元测试 **151/151**：`python -m unittest discover -s tests -p "test_*.py"`（约 35s）
- 后端集成 **37/37**（真起服务、真编译）：`python -m unittest tests.it_cockpit_server`（约 1min）
- 上板验收：`at32f421g8u7` 五步全绿（烧录 Verified OK / 断到 `main.c:103` /
  串口 2.6s 命中 `[alive]`，**无需 `--reset-port`**）
- GitHub Actions：`host-gate` 在 `ubuntu-latest` 全绿（§8.1）
- 前端产物一致性：重建后 `git diff --exit-code cockpit/web/dist/` 零差异

### ⚠️ 已知限制（诚实清单）

- STM32 上板烧录/调试**未验证**（本机只有 AT32 板；命令已生成、只差 target cfg）
- `onhw-gate` 需要 self-hosted 探针（云端编译门禁不受影响）
- SVD 在 IDE 中实际加载未实测
- 驾驶舱 `profiles/*.yaml` 插件化装配（M4）、`elab skill --adapt`（M5.5）未实现
- 常驻监视的实时流只活服务端环形缓冲 + 浏览器本地缓冲（重启即失 —— 它是
  "看"，不是"证据"；要证据走闭环 monitor 步骤）

### 📦 从源码运行

```bash
git clone git@github.com:xkk6663/elab-flow.git
cd elab-flow
python -m cockpit.server        # → http://127.0.0.1:3333/（Windows 亦可双击 cockpit.cmd）
elab doctor_deep --all          # 或 ./elab …（MSYS）/ elab.cmd …（cmd）
```

要求：Python ≥ 3.10（仅标准库；3.12 / 3.13 实测）；可选：CMake + Ninja + ARM GCC 工具链 +
openocd（上板闭环用）。前端运行时不需要 Node（`dist/` 已入仓）。

---

## [0.x] — 2025-09 ~ 2026-10（开发期）

M0–M5.6 里程碑的演进史见 `docs/design/技术方案_闭环驾驶舱.md`（§20 实现记录，含每轮
真实事故与修复）与 [docs/design/设计约束.md](docs/design/设计约束.md) 约束表 —— 本仓库把"踩过的坑"当作一等公民文档化。
