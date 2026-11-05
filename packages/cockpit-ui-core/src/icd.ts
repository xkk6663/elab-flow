/**
 * 事件与 API 的类型契约 —— **前端侧镜像的唯一事实源**。
 *
 * ★ 本文件是 `docs/ICD_cockpit_events.md` 的**前端侧镜像**。
 *   改字段名/语义必须三处同步：ICD、`services/elab/kernel/events.py`、本文件。
 *   （ICD §7「兼容性承诺汇总」）
 *
 * ★ 收藏位置（§16 共享层）：定义住在这里，`cockpit/web/src/api/types.ts` 只做
 *   薄转发。合并口径 = 两侧字段取**并集**：web 侧多 `Capabilities.meta`（内核
 *   自描述），插件侧多宿主半契约（`/elab/host`、`/elab/env`、`/elab/bootstrap`、
 *   `/elab/config`）与会话级共享解码（`SerialDecodeState`）。不认识的字段一律
 *   忽略（ICD §7）。
 *
 * ★ 为什么插件 `domain/icd.ts` 仍是自包含镜像、不是薄转发：host 半构建
 *   （`tsc -p tsconfig.host.json`，rootDir=src）不能把本文件纳入同一 program
 *   （TS6059）；改字段时这一份与插件那份必须一起改。纯 client 侧的
 *   `channels.ts` / `run-events.ts` 则两处共用（esbuild / vite 构建期内联）。
 */

export const EVENT_SCHEMA_VERSION = 1;

/** 契约里的 actor：直接回答 R1"这一步是 agent 干的还是我点的" */
export type Actor = "agent" | "human";

/**
 * 已知 topic 全集（ICD §3）。
 *
 * ★ 为什么必须**显式枚举**：服务端把 topic 放在 SSE 的 `event:` 字段里
 *   （`event: run/step-exit`），而 `EventSource` **只按名订阅**，`onmessage`
 *   仅接收无 `event:` 的帧。因此"新 topic 自动可见"在 SSE 协议层面做不到。
 *
 *   这条限制的后果必须说清楚（ICD §7 已同步记录）：
 *     - 新增 topic 属于**跨端协同变更**，不是单端兼容变更；
 *     - 漏掉一个 topic 的症状是"界面某块静默不更新"，而非报错 —— 很难查；
 *     - 防御手段就是本文件与 ICD §3 的 topic 表逐条对齐（`npm run build` 前 review）。
 *
 *   `reduce()` 的 default 分支仍保留"未知 topic 原样返回"，用于兜住
 *   `run-events` 回放（走 JSON，不经 SSE）时可能出现的更新协议。
 */
/**
 * SSE **命名事件**白名单 —— 必须覆盖服务端会发出的**每一个** topic。
 *
 * ★ 为什么这张表是"活命的"（ICD §6.1 的硬约束，实测踩过 P0）：
 *   `EventSource.onmessage` **只接收没有 `event:` 字段的帧**；带 `event: <topic>`
 *   的帧只有 `addEventListener(<topic>, …)` 才收得到。而服务端**每帧都写
 *   `event: <topic>`**。所以：漏一个 topic = 该 topic 的事件在浏览器里
 *   **静默消失**——不报错、不抛异常、`onerror` 也不触发，只是那块 UI 永远不更新。
 *
 *   实测事故：本表原缺 `proc/stdout-batch`。而 run **跑起来之后**所有编译日志
 *   都以合并帧 `proc/stdout-batch` 下发 → **实时编译日志 100% 不可见**；
 *   而 `GET /api/events` 对**已结束**的 run 走"按 seq 重放"分支，重放的是
 *   `.proc.jsonl` 里的**逐条** `proc/stdout`（能收到）→ 于是"刷新页面/看历史
 *   run 有日志、真跑起来没日志"。这个不对称是它最迷惑人的地方。
 *
 *   守卫：`tests/it_cockpit_server.py::test_known_topics_covers_server_emitted`
 *   会把这张表与服务端 `SSE_TOPICS` 做集合比对 —— 新增 topic 时必须两端一起改。
 */
export const KNOWN_TOPICS = [
  // run/* —— 状态通道（.jsonl）
  "run/start",
  "run/step-enter",
  "run/step-exit",
  "run/end",
  "run/cancel",
  // proc/* —— 进程输出通道（.proc.jsonl）；batch 是服务端 100ms 合并帧
  "proc/stdout",
  "proc/stderr",
  "proc/stdout-batch",
  "proc/exit",
  // serial/* —— 串口闭环（M3）
  "serial/open",
  "serial/line",
  "serial/close",
  "serial/error",
  "serial/closed-loop",
  // 调试会话（独立信封 §6.4：没有 run 字段）
  "debug/opened",
  "debug/state",
  "debug/stop",
  "debug/breakpoint",
  "debug/output",
  "debug/error",
  "debug/closed",
  // 流控制
  "stream/overrun",
  "stream/closed",
] as const;

/** 事件信封（ICD §2）。`ts` 单位是**秒**，排序一律用 `seq`。 */
export interface ElabEvent {
  ts: number;
  run: string;
  topic: string;
  seq: number;
  actor: Actor;
  step?: string;
  project?: string;
  /** topic 专有字段 —— 消费者必须忽略不认识的那些 */
  [k: string]: unknown;
}

export type StepId =
  | "doctor"
  | "doctor_deep"
  | "build"
  | "flash"
  | "debug_verify"
  | "monitor";

/**
 * 四态 + skipped/cancelled（§5.2）。`inferred` 用于"超时推断"，UI 画虚线。
 *
 * ★ `inconclusive`（2026-11-03）：步骤跑完了但没有约定证据（monitor 没收到
 *   `close_on` 关键字）。**它不是 failed**，也不能画成 ok —— 否则"没接串口"
 *   在界面上会显示成绿色通过。
 */
export type StepState =
  | "pending"
  | "running"
  | "ok"
  | "failed"
  | "inconclusive"
  | "skipped"
  | "cancelled";

export interface MemoryRegion {
  used: number;
  region: number;
  pct: number;
}

export interface Artifact {
  path: string;
  bytes: number;
}

export interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
  duration_s: number;
  memory?: Record<string, MemoryRegion>;
  artifacts?: Record<string, Artifact>;
  /** "linker" = 链接器自报；"map" = 增量构建未 relink，从 .map 反推 */
  memory_source?: string;
  size?: { text: number; data: number; bss: number };
  guard?: {
    root: string;
    files_before: number;
    added: string[];
    removed: string[];
    changed: string[];
    untouched: boolean;
  };
  verdict?: "ok" | "failed" | "inconclusive";
  evidence?: string[];
}

// ── /api/projects ────────────────────────────────────────────────
export interface ChipInfo {
  id: string;
  vendor: string;
  family: string;
  part: string;
  package: string;
  frequency: string;
  core: { arch?: string; cpu?: string; fpu?: string; std?: string };
  memory: Record<string, { origin: number; length: number }>;
  debug: Record<string, string>;
}

export interface ProjectCard {
  name: string;
  chip: string;
  archetype: string;
  root: string;
  work_dir: string;
  project_name: string;
  generator: string;
  build_type: string;
  linker_script: string;
  artifacts: Record<string, string>;
  probe: string;
  /** 芯片声明的调试后端（`esp-idf` = 探针可板载或外接）；空 = 无后端 */
  debug_backend?: string;
  /** 项目级调试页签白名单（按芯片收敛；会话打开后再按 snapshot.features 收敛） */
  debug_features?: string[];
  serial: {
    baud?: number; port?: string; line?: string | SerialLineConfig;
    /** 连接方式（M4）：serial / tcp-client / tcp-server / udp（工程 yaml 声明） */
    transport?: string;
    /** 网络传输配置（M4）：host/port 或 bind/port + allow_remote */
    net?: Record<string, unknown>;
  };
  monitor: { close_on: number; fail_on: number; idle_timeout_s?: number };
  provenance: Record<string, { value: string; level: string; evidence: string }>;
  /** 派生状态位（不是新元数据，只是"文件在不在"） */
  derived: { built: boolean; work_dir_exists: boolean };
  steps: Record<StepId, { ok: boolean; reason: string }>;
  /** 项目声明工具（projects/*.yaml 的 tools: 节）；通用机制，见 run.py TOOL_PREFIX */
  tools: Array<{ name: string; label: string }>;
  /** 步骤委托（派生）：steps.<step> == tool:<name> 时为 true */
  delegated?: Record<string, boolean>;
  /** 项目级步骤文案覆盖（只改显示，不改语义） */
  step_labels?: Record<string, string>;
  /** OTA 投影（C1/C3）：芯片声明了 ota_layout 才有；boot_stamp=冻结台账（未烧录为 null） */
  ota?: {
    boot_project: string;
    slots: number;
    boot_stamp: { md5: string; version: string; bin: string; flashed_at: string } | null;
  } | null;
  /** boot 子工程归属（交叉引用派生）：被谁的 ota_layout.boot_project 指到 */
  boot_owner?: string;
  chip_info: ChipInfo;
}

export interface ProjectsResponse {
  projects: ProjectCard[];
  steps: { all: StepId[]; default: StepId[]; onhw: StepId[] };
}

// ── /api/capabilities ────────────────────────────────────────────
export interface SerialPort {
  name: string;
  kind: "usb" | "bluetooth" | "other";
  device: string;
  desc: string;
}

/**
 * 内核自描述（§16）：工具层与前端只渲染这里的词汇，**不写死业务名词**。
 *
 * `meta` 缺失 = 内核过旧（插件会提示同步），前端则回退到内置默认。
 */
export interface SerialDecoderMeta {
  id: string;
  label: string;
  channels: "auto" | number;
  desc?: string;
}

export interface SerialMeta {
  views?: string[];
  formats?: string[];
  encodings?: string[];
  eols?: string[];
  directions?: string[];
  decoders?: SerialDecoderMeta[];
  features?: string[];
  /** 传输种类（M4）：面板按此渲染「连接方式」，不写死业务名词 */
  transports?: {
    kinds: string[];
    default?: string;
    net?: {
      defaults?: Record<string, Record<string, string | number>>;
      loopback_only?: boolean;
      note?: string;
    };
  };
  /** 线参数词汇（M1）：面板据此渲染选择器，不写死业务名词 */
  line?: {
    data_bits: number[];
    parity: string[];
    stop_bits: number[];
    flow: string[];
    default: SerialLineConfig;
    text_forms: string[];
    note?: string;
  };
}

/**
 * 调试能力自描述（`capabilities.meta.debug`，镜像内核 `DEBUG_META`）。
 *
 * ★ 缺失 = 内核过旧：前端**不**为调试面写兼容分支，而是提示同步内核。
 *   字段是内核 `DEBUG_META` 的**最小可用子集**，其余字段消费者忽略。
 */
export interface DebugMeta {
  available: boolean;
  features: string[];
  stop_at: string[];
  max_sessions?: number;
  actions?: string[];
  breakpoint_kinds?: string[];
  registers_group?: string[];
  formats?: string[];
  watch_formats?: string[];
  svd?: { tree_path?: string; read?: boolean };
  rtos?: { available_via?: string; granularity?: string };
  lease?: { default_s: number; min_s: number; max_s: number };
  limits?: {
    memory_read_max: number;
    disasm_max: number;
    variables_depth: number;
    audit_records: number;
    watch_max?: number;
  };
  error_codes?: string[];
  exclusive_with?: string[];
  on_close?: { resume?: boolean; method?: string };
}

export interface Capabilities {
  cockpit: {
    version: string;
    dist: string;
    dist_ready: boolean;
    sse_heartbeat_s: number;
    proc_batch_s: number;
  };
  schema_version: number;
  python: { version: string; executable: string };
  root: string;
  runs_dir: string;
  /** 内核自描述（步骤/通道/串口词汇）；内核过旧时为 undefined */
  meta?: {
    steps?: Record<string, { label?: string; channel?: string }>;
    plans?: Array<{ id: string; title: string; steps: string[]; requires_hardware?: boolean }>;
    channels?: string[];
    serial?: SerialMeta;
    /** 调试会话能力（内核 `DEBUG_META`）；缺失 = 内核过旧，面板提示同步 */
    debug?: DebugMeta;
    /**
     * 探针清单（L0 `elab.host.yaml: probes.list`）：面板下拉的选项与可用性
     * 都由内核给（`available` = interface cfg 是否落地），前端不自行探测。
     */
    probes?: {
      default?: string;
      list?: Array<{
        name: string;
        backend?: string;
        interface_cfg?: string;
        speed?: number;
        available?: boolean;
      }>;
    };
    /**
     * 驾驶舱装配清单（`cockpit/profiles/*.yaml`，R7 / P1-4）：
     * 决定右列 Tab 的顺序/集合与项目工具的启停；缺失 = 内置集合。
     */
    profile?: {
      name: string;
      path?: string;
      available?: string[];
      workspaces?: string[];
      tools?: { include?: string[]; exclude?: string[] };
    };
  };
  serial: {
    pyserial: boolean;
    pyserial_version: string | null;
    win32_ctypes: boolean;
    layer: string;
    available: boolean;
    hint: string | null;
    backend: string;
    ports: SerialPort[];
    host_default: string;
    host_baud: number;
    /** 宿主/工程未声明 line 时的默认线参数（M1）。 */
    host_line?: SerialLineConfig;
    /** 能否往串口**写**（M3-b）。与 `available` 同源，但单列以免前端去猜。 */
    write_available: boolean;
    /**
     * 手写通道的服务端留档（M3-b2）。
     *
     * ★ 为什么这件事必须由服务端告诉界面：本地环形缓冲**重载即失**，
     *   而服务端那份 console 日志是持久的。界面要能诚实地说出
     *   "服务端还存着 N 条"，就不能自己去猜 —— 猜的代价是两边数字对不上。
     */
    console: SerialConsoleInfo;
    /**
     * 常驻串口监视会话（serialmon）的快照。
     *
     * ★ 由服务端告诉界面而不是界面自己记：会话是**服务进程的单例**，
     *   别的标签页/别处点开时，这边必须能看到"已经在监视了"。
     */
    monitor: SerialMonitorSnapshot;
  };
  active_runs: ActiveRunInfo[];
  steps: { all: StepId[]; default: StepId[]; onhw: StepId[] };
}

export interface ActiveRunInfo {
  run: string;
  project: string;
  steps: string[];
  actor: Actor;
  pid: number;
  started_at: number;
  alive: boolean;
  dropped: number;
  last_seq: number;
  /**
   * 元数据从哪来（契约 §5.3："元数据以事件日志为准"）。
   * - `event-log` ：已回读到 `run/start`，字段与日志逐字一致（稳态）；
   * - `provisional`：子进程刚 spawn、首行还没落盘，用的是内存占位值。
   *   UI 若要显示"即将运行 doctor, build"，此时**允许**显示；但不要说成"已确认"。
   */
  meta_source?: "event-log" | "provisional";
}

// ── /api/runs ────────────────────────────────────────────────────
export interface RunMeta {
  run: string;
  project: string;
  steps: string[];
  started_at: number;
  /** 留档状态：三态（inconclusive = 跑完但没拿到约定证据） */
  status: "running" | "ok" | "failed" | "inconclusive" | "cancelled";
  last_seq: number;
  proc_bytes: number;
  state_bytes: number;
}

export interface RunsResponse {
  runs: RunMeta[];
  active: ActiveRunInfo[];
}

// ── /api/plan（只读命令预览，M2）─────────────────────────────────
export interface PlanStepPreview {
  step: StepId | string;
  /** 是否会派生子进程（`monitor` 同进程内读串口，故为 false） */
  spawns: boolean;
  /** 待执行的命令行（argv 数组；空数组 = 该步没有命令行，看 note） */
  commands: string[][];
  /** **副作用**（尤其是 `--clean` 会真删工作目录）。这是预览最该突出的东西 */
  effects: string[];
  /** 需要前置产物（如 ELF 还没 build）→ 真跑会失败 */
  blocked: boolean;
  note: string;
  work_dir?: string;
  /** 仅 `monitor`：没有命令行，但有等效的确定性参数 */
  serial?: {
    port: string;
    baud: number;
    close_on: unknown[];
    fail_on: unknown[];
    idle_timeout_s?: number | null;
  };
}

export interface PlanPreview {
  project: string;
  steps: string[];
  clean: boolean;
  jobs: number | null;
  plan: PlanStepPreview[];
  warnings: string[];
}

// ── /api/serial（手写通道，M3-b）────────────────────────────────
/**
 * 一次「写一条 → 收一小段回显」的结果。
 *
 * ★ `ok:false` **也是 200**（除非请求本身不合法=400 / 串口被闭环占着=409）。
 *   理由：失败与成功要渲染的字段**完全一样**（port/baud/error）——
 *   用 5xx 只会让前端走异常分支、把这些结构化信息丢掉。
 */
export interface SerialWriteResult {
  ok: boolean;
  /** 实际写到的端口（已解析 `auto`）；失败时为空串 */
  port: string;
  baud: number;
  backend: string;
  layer: string;
  /** 实际写出的字节数。≠ `payload_bytes` 即"写了一半"，按失败算 */
  written: number;
  payload_bytes: number;
  /** 回显窗口内收到的**完整行** */
  echoed: string[];
  bytes_read: number;
  read_ms: number;
  elapsed_s: number;
  /** 实际附加的行结束符（`\r\n`；hex 模式为空串） */
  eol: string;
  /** 实际使用的发送表示（ascii/utf8/gbk/hex） */
  format?: string;
  error: string | null;
  /** "monitor" = 写通道被路由进了常驻监视会话（不重开口；回显走实时流） */
  via?: "monitor";
}

// ── 串口 console 留档（M3-b2）────────────────────────────────────
/**
 * console 日志里的一条记录。
 *
 * ★ 它**不是事件**（ICD §2 的信封）：没有 `run`、没有 `seq`，因为写通道不属于
 *   任何 run。所以它**不能**被当作可重放的真值 —— 文件有上限、会滚动，
 *   界面渲染的只是"最近发生过什么"。
 */
export interface SerialConsoleRecord {
  /** unix 秒（与事件信封同一单位，便于并排显示） */
  ts: number;
  /** 人类可读时间（服务端已格式化，前端不必自己算时区） */
  t: string;
  /** `tx` = 人敲出去的；`rx` = 设备回显的整行 */
  dir: "tx" | "rx";
  text: string;
  /** 这条命令是发给哪个工程的（端口会复用，工程不会） */
  project?: string;
  port?: string;
  baud?: number;
  /** 仅 tx：这一次往返成不成功 */
  ok?: boolean;
  written?: number;
  payload_bytes?: number;
  hex?: boolean;
  newline?: boolean;
  error?: string | null;
}

export interface SerialConsoleInfo {
  path: string;
  count: number;
  max_records: number;
  /** 读文件失败时的原因（不致命：留档读不出来不该让 caps 整个失败） */
  error: string | null;
}

export interface SerialConsoleResponse {
  records: SerialConsoleRecord[];
  /** 服务端**总共**有多少条（可能远多于 `records.length` —— 说明被 limit 截了） */
  count: number;
  requested: number;
  path: string;
}

// ── /api/serial/monitor（常驻串口监视会话）────────────────────────
/** 线参数（M1）：数据位 / 校验 / 停止位 / 流控。文本形态如 `7E1`、`5N1.5`。 */
export interface SerialLineConfig {
  data_bits: number;
  /** none | even | odd | mark | space */
  parity: string;
  stop_bits: number;
  /** none | rtscts | xonxoff | dsrdtr */
  flow: string;
  /** 组合文本，会话快照与 UI 显示都应以它为准 */
  text: string;
}

/** DTR/RTS 的已知状态。`null` = 没动过/未知（不等于"线是低电平"）。 */
export interface SerialControlState {
  dtr: boolean | null;
  rts: boolean | null;
  /** pyserial 回读过实际值；false = 只是请求值（ctypes 无回读） */
  verified: boolean;
  preset: string;
  by: string;
  at: number;
}

/** 重连策略（M2）：默认开、200ms→5s 无限退避（0 = 不限次数）。 */
export interface SerialReconnectConfig {
  enabled: boolean;
  min_ms: number;
  max_ms: number;
  max_attempts: number;
}

/** 速率/帧率/缓冲占用（M2 §4.6）：服务端算，面板只渲染。 */
export interface SerialStats {
  rx_bps: number;
  tx_bps: number;
  rx_bytes_total: number;
  tx_bytes_total: number;
  frames_per_s: number | null;
  frames_total: number;
  /** 窗口不足 1s（刚开会话）—— 速率是折算值，不是满窗值 */
  warmup: boolean;
  buffer: { lines: number; chunks: number; bytes: number; frames: number };
  covered: { lines: number; chunks: number; frames: number };
}

/** 结构化异常（M6）：panic / assert / hardfault / reset。 */
export interface SerialIssue {
  seq: number;
  kind: "panic" | "assert" | "hardfault" | "reset";
  core: string | null;
  reason: string | null;
  line: string;
  t: string;
  t_us: number;
  backtrace: string[];
  /** 复位后的第一条 panic（区分"上电就炸"与"跑着炸"） */
  after_reset: boolean;
}

export interface SerialSymbol {
  addr: string;
  func: string | null;
  file: string | null;
  line: number | null;
  /** ROM 地址等无法符号化时的说明（不编造函数名） */
  note?: string;
}

export interface SerialIssueSummary {
  profile: string;
  total: number;
  covered: number;
  last_seq: number;
}

/** 日志 profile（M6）：面板只读 id/label，规则在包/工程数据里。 */
export interface SerialLogProfile {
  id: string;
  label: string;
  panic_lines?: string[];
  hardfault_lines?: string[];
  reset_lines?: string[];
  core_pattern?: string;
  reason_pattern?: string;
  backtrace_line?: string;
  addr_pattern?: string;
  rom_prefixes?: string[];
  symbolize?: { tool_key?: string; args?: string[] };
}

export interface SerialMonitorSnapshot {
  active: boolean;
  /** 连接态（M2）：live / reconnecting / suspended（闭环让位）/ closed */
  state?: "live" | "reconnecting" | "suspended" | "closed";
  conn?: number;
  reconnects?: number;
  /** 最近一次掉线持续时间（秒；重连成功或放弃后才定格） */
  down_s?: number;
  /** auto 选口在重连时换了口（仅记录，不静默改口） */
  port_changed?: { from: string; to: string } | null;
  last_error?: string | null;
  suspended_by_run?: boolean;
  suspend_reason?: string;
  resume_error?: string | null;
  reconnect?: SerialReconnectConfig;
  stats?: SerialStats;
  /** 结构化异常计数（M6）：profile 非空才统计 */
  issues?: SerialIssueSummary;
  project?: string;
  port?: string;
  baud?: number;
  backend?: string;
  /** 本次会话的线参数（打开时属性；改后需重开才生效） */
  line?: SerialLineConfig;
  line_text?: string;
  kind?: string;
  port_spec?: string;
  /** 网络传输（M4）的绑定/目标：tcp-client {host,port}；tcp-server/udp {bind,port} */
  net?: Record<string, unknown>;
  control?: SerialControlState;
  /** 会话内已累计的行数（= 最后一条的 seq） */
  seq?: number;
  /** 环形缓冲挤掉的总行数（>0 说明有行没活过缓冲期） */
  covered?: number;
  /**
   * 连接纪元：每次 open 自增。
   *
   * ★ 前端发现它变化**必须重置游标**：旧实现重开后 `seq` 归零，旧游标
   *   （例如 800）会让新会话静默"永远没有新行"—— 这类缺陷最难查。
   */
  epoch?: number;
  /** 字节面：累计批次序号 / 被挤掉的批次数 / 当前占用字节 */
  chunk_seq?: number;
  covered_chunks?: number;
  bytes_total?: number;
  /** 暂停入环（仍继续读口，避免设备侧缓冲被撑爆） */
  paused?: boolean;
  /**
   * 会话由谁打开。
   *
   * ★ 不锁死成 `Actor`：契约值是 `human` / `agent`，但内核可能先行扩展来源；
   *   界面只做等值比较（"是不是 agent 开的"），不认识的值按"人"呈现即可。
   */
  opened_by?: Actor | string;
  allow_agent_write?: boolean;
  lease_s?: number;
  lease_remaining_s?: number;
  /** 显式录制（K5）：null = 本会话从未录过；active=false 表示已停/已到顶 */
  capture?: {
    active: boolean;
    path: string;
    bytes: number;
    chunks: number;
    truncated: boolean;
    error: string | null;
    max_bytes: number;
  } | null;
  /**
   * 会话级共享解码（P3.5）。`decoder` 为空 = 未启用，面板可回退本地无状态解码。
   * ★ 解码器是**会话属性**：agent 选定后，人在波页看到的是同一份帧。
   */
  decode?: SerialDecodeState;
  /** 读线程异常自愈时留下的原因（拔线/口被抢）；null = 一切正常 */
  error?: string | null;
}

/** 会话级解码状态（快照里的 `decode`，以及 /api/serial/monitor/decoded 的公共字段）。 */
export interface SerialDecodeState {
  /** justfloat / firewater；'' = 未启用 */
  decoder: string;
  /** 谁最后选定：human / agent */
  decoder_by: string;
  /** 已推断的通道数（0 = 还没解出帧） */
  channels: number;
  /** 当前解码器已解出的总帧数（累计；clear 后归零） */
  total_frames: number;
  /** 被跳过的候选帧/坏行数（累计） */
  skipped: number;
  /** 待续解的半帧字节数 */
  pending_bytes: number;
  /** 帧环挤掉的总帧数 */
  covered: number;
  /** 最近一次解码的时刻（unix 秒） */
  updated_at: number;
  /** 解码异常（未知解码器/内部错误）；null = 正常 */
  error: string | null;
  /** 帧协议（M5）：字段元数据（波形通道名/单位；非 profile 解码为空） */
  fields?: Array<{ name: string; unit: string; type: string; plot: boolean }>;
}

export interface SerialMonitorLine {
  seq: number;
  text: string;
  /** 服务端已格式化的 HH:MM:SS */
  t: string;
  t_us?: number;
}

/** [Omitted] 会话级共享解码的一帧（GET /api/serial/monitor/decoded）。 */
export interface SerialDecodedFrame {
  /** 会话内单调的帧序号（换解码器/clear 也不回退） */
  seq: number;
  /** 服务端已格式化的 HH:MM:SS.mmm */
  t: string;
  /** 所属 RX 批次的采集时刻（微秒）—— 同批多帧时间相同（Δ 精度受批大小限制） */
  t_us: number;
  /** 每通道的浮点值（长度 = channels） */
  values: number[];
}

/** GET /api/serial/monitor/decoded 的响应（增量帧 + 解码状态）。 */
export interface SerialDecodedTail extends SerialDecodeState {
  active: boolean;
  epoch?: number;
  /** 下一游标：把 next_after 当 after 再拉即可 */
  next_after: number;
  frames: SerialDecodedFrame[];
  /** 客户端错过的帧数下限（帧环挤掉；只报告不抹平） */
  gap: number;
}

/** pack.yaml 里的一个复位/下载预设（M1）：内核只按 steps 逐条动线。 */
export interface SerialControlPreset {
  name: string;
  label: string;
  description?: string;
  steps: { dtr?: boolean; rts?: boolean; hold_ms: number }[];
}

/** GET /api/serial/control（预设清单 + 已知线状态 + 序列进度）。 */
export interface SerialControlStateResponse {
  presets: SerialControlPreset[];
  pack: string;
  errors: string[];
  hint: string | null;
  session: { active: boolean; port: string; line_text: string };
  control: SerialControlState;
  sequence: {
    state: "idle" | "running" | "done" | "cancelled" | "error" | string;
    preset: string;
    error: string;
    steps: number;
    started: number;
    finished: number;
  };
}

/** POST /api/serial/control 的结果（apply 与 preset/cancel 的公共面）。 */
export interface SerialControlResult {
  ok: boolean;
  error?: string;
  port?: string;
  line_text?: string;
  /** true = 没开监视，临时开户（open 本身可能拉 DTR） */
  transient?: boolean;
  note?: string;
  /** apply：本次实际生效的线态 */
  applied?: { dtr?: boolean; rts?: boolean };
  verified?: boolean;
  backend?: string;
  preset?: string;
  async?: boolean;
  cancelled?: boolean;
  sequence?: SerialControlStateResponse["sequence"];
}

export interface SerialMonitorTail extends SerialMonitorSnapshot {
  lines: SerialMonitorLine[];
  /** 浏览器错过（被环形缓冲挤掉）的行数下限 —— 只报告、不抹平 */
  gap: number;
}

/**
 * 一**批**原始字节（数据面的真值单位）。
 *
 * ★ 行文本只是投影：同一批字节可渲染成 HEX / ASCII / UTF-8 / GBK / 终端 /
 *   波形，且**永远可以还原**（`data_b64`）。方向与采集时刻是行数组没有的信息。
 */
export interface SerialChunk {
  seq: number;
  dir: "rx" | "tx";
  /** 采集时刻（微秒，做时间轴/波形横轴） */
  t_us: number;
  /** 服务端已格式化的 HH:MM:SS.mmm */
  t: string;
  len: number;
  /** 原始字节（base64）—— 一切投影的唯一来源 */
  data_b64: string;
}

export interface SerialBytesTail extends SerialMonitorSnapshot {
  chunks: SerialChunk[];
  /** 被环形缓冲挤掉的批次数下限；`dir` 过滤时为 0（序号不连续，gap 无意义） */
  gap: number;
  /** 本轮是否按方向过滤（过滤时 `gap` 不可信） */
  filtered?: boolean;
  /** 字节环挤掉的总批次数（快照里的 `covered_chunks` 同义；旧内核可能缺） */
  covered?: number;
}

// ── /api/serial/decode（P3，协议解码）────────────────────────────
export interface SerialDecodeResult {
  ok: boolean;
  decoder: string;
  channels: number;
  /** 每帧的通道值（顺序 = 通道号）；多 ID 时按字段并集对齐，当前 variant 缺的通道为 null */
  frames: Array<Array<number | null>>;
  total_frames: number;
  skipped: number;
  /** 半帧字节数（尾标记缺失/最后一行没换行），由调用方拼进下一批 */
  pending_bytes: number;
  pending_b64: string;
  input_bytes: number;
  error?: string;
  /** 帧协议（M5）：每帧的字段值（name → 数值/文本/hex） */
  records?: Array<{
    fields: Record<string, number | string | null>;
    values: Array<number | null>;
    /** 多 ID：命中的消息 id / variant 标签（单 profile 旧内核可能缺） */
    id?: number | null;
    variant?: string | null;
  }>;
  /** 帧协议（M5）：字段元数据（波形通道名/单位来自这里） */
  fields?: SerialFrameFieldMeta[];
  /** 帧协议（M5）：校验失败帧数（失败帧计入 skipped，不静默丢） */
  checksum_fail?: number;
  /** 多 ID：id_field 未命中任何 variant 且无兜底字段的帧数 */
  unknown_id?: number;
  /** 最近若干条解码错误（字段越界/校验失败原因） */
  errors?: string[];
}

/** 波形通道元数据（frame.fields 的投影）。 */
export interface SerialFrameFieldMeta {
  name: string;
  unit: string;
  type: string;
  plot: boolean;
  bit_offset?: number;
  bit_length?: number;
  bit_order?: "lsb0" | "msb0";
}

// ── 帧协议 profile（M5）──────────────────────────────────────────
/** 一个字段：offset 从帧起始字节算（含 head）；scale/bias 只对数值字段生效。 */
export interface SerialFrameField {
  name: string;
  unit: string;
  offset: number;
  type: string;
  endian: "le" | "be";
  length: number;
  scale: number;
  bias: number;
  enum?: Record<string, string> | null;
  /** 是否作为波形通道（enum/ascii/bytes 恒为 false） */
  plot: boolean;
  /** 位域（P0）：从 offset 字节的 bit_offset 位起取 bit_length 位 */
  bit_offset?: number;
  bit_length?: number;
  bit_order?: "lsb0" | "msb0";
}

/** 变长切帧（P0）：总长 = raw * mul + add，raw 从帧首 offset 读取。 */
export interface SerialFrameLengthField {
  offset: number;
  type: "u8" | "u16";
  endian: "le" | "be";
  mul: number;
  add: number;
}

/** 多 ID（P0）：从帧内读消息 id，再按 variants 分发字段。 */
export interface SerialFrameIdField {
  offset: number;
  type: string;
  endian: "le" | "be";
  bit_offset?: number;
  bit_length?: number;
  bit_order?: "lsb0" | "msb0";
}

/** 多 ID 的一个分支：id 命中时用它的字段（checksum 可覆盖 profile 级）。 */
export interface SerialFrameVariant {
  id: number;
  label: string;
  fields: SerialFrameField[];
  checksum?: { kind: "none" | "sum8" | "xor8" | "crc16modbus"; at: "tail" | "head" };
}

/** 工程帧协议（`projects/<name>.frames.json` 的一份 profile）。 */
export interface SerialFrameProfile {
  id: string;
  label: string;
  kind: "binary";
  frame: {
    head_hex: string;
    tail_hex: string;
    length: number | null;
    max_bytes: number;
    /** 变长切帧（P0） */
    length_field?: SerialFrameLengthField | null;
    /** 多 ID（P0） */
    id_field?: SerialFrameIdField | null;
  };
  checksum: { kind: "none" | "sum8" | "xor8" | "crc16modbus"; at: "tail" | "head" };
  fields: SerialFrameField[];
  /** 多 ID 分支（P0） */
  variants?: SerialFrameVariant[];
}

/** 只读模板库的一项（P1）：`templates/frames/*.json` 的已校验投影。 */
export interface SerialFrameTemplate {
  id: string;
  label: string;
  desc: string;
  file: string;
  profile: SerialFrameProfile;
}

/** GET `/api/serial/frames/templates` 的结果。 */
export interface SerialFrameTemplatesResponse {
  ok: boolean;
  templates: SerialFrameTemplate[];
  errors?: string[];
  path?: string;
}

/** POST `/api/serial/frames/encode` 的结果（字段值 → 字节）。 */
export interface SerialFrameEncodeResult {
  ok: boolean;
  id?: string;
  variant?: string | null;
  variant_id?: number;
  hex?: string;
  bytes?: number;
  length_field?: number | null;
  checksum?: string | null;
  error?: string;
}

/** GET/POST `/api/serial/frames` 的结果（rev 乐观锁）。 */
export interface SerialFramesResponse {
  ok: boolean;
  rev: number;
  profiles: SerialFrameProfile[];
  warnings?: string[];
  path?: string;
  conflict?: boolean;
  error?: string;
}

/**
 * 发送面板的表示/行尾（与服务端 `serialterm` 的词汇一致）。
 *
 * `"auto"` 不是一种编码，而是「让服务端替你选」：唯一事实源在
 * `serialterm.detect_format`（HEX 需要明确线索，裸数字按文本）。
 */
export type SerialFormat = "auto" | "ascii" | "utf8" | "gbk" | "hex";
export type SerialEol = "none" | "lf" | "cr" | "crlf" | "tab";

/** `POST /api/serial` 的 `dry_run` 结果：只算字节，不碰串口。 */
export interface SerialPreviewResult {
  ok: boolean;
  dry_run: true;
  bytes: number;
  /** 待发字节的 HEX（大写、空格分隔）—— 前端直接展示，不自己编码 */
  preview_hex: string;
  /** 服务端解析后的实际格式（auto 会落成 utf8/hex） */
  format?: SerialFormat;
  eol_key?: SerialEol;
  eol?: string;
  error?: string | null;
}

/** 监视中写一行（路由进会话，不重开口）。与 SerialWriteResult 同形但有 via 标记 */
export interface SerialMonitorWriteResult {
  ok: boolean;
  via: "monitor";
  written: number;
  payload_bytes: number;
  echoed: string[];
  port: string;
  baud: number;
  error: string | null;
}

// ── /api/serial/widgets（自定义发送组件，M1）────────────────────
/**
 * 参数类型词汇来自内核 `capabilities.meta.serial.widget.param_types`；
 * 这里保留联合类型只是为了让前端分支可穷尽。
 */
export type SerialWidgetParamType = "int" | "float" | "bool" | "enum" | "string" | "hex";

export interface SerialWidgetParamOption {
  label: string;
  value: string;
}

export interface SerialWidgetParam {
  name: string;
  label?: string;
  type: SerialWidgetParamType;
  /** 默认值已由服务端归一化（数值/布尔/字符串） */
  default?: string | number | boolean | null;
  min?: number;
  max?: number;
  step?: number;
  /** float 固定小数位 */
  decimals?: number;
  /** int：按 hex 渲染（width = 十六进制位数） */
  render?: "hex";
  /** int：hex 位数；hex：字节数 */
  width?: number;
  endian?: "be" | "le";
  options?: Array<SerialWidgetParamOption | string>;
  max_len?: number;
  pattern?: string;
  true_value?: string;
  false_value?: string;
}

export interface SerialWidgetStep {
  /** 1-based 步号（预览时服务端给出） */
  i?: number;
  kind: "send" | "delay" | "wait";
  text?: string;
  ms?: number;
  within_s?: number;
  /** wait 的匹配规则（M2）：kind ∈ regex/contains/exact/hex */
  match?: { kind: string; value: string };
  format?: SerialFormat;
  eol?: SerialEol;
}

export interface SerialWidget {
  id: string;
  label: string;
  group?: string;
  confirm?: boolean;
  format?: SerialFormat;
  eol?: SerialEol;
  params?: SerialWidgetParam[];
  steps: SerialWidgetStep[];
  /** 周期发送（M2）：固定节拍、重复整个组件，上一轮超时只记 skipped */
  repeat?: { interval_ms: number; count: number } | null;
}

/** GET/POST /api/serial/widgets 的返回：服务端校验后的**唯一**投影 */
export interface SerialWidgetsResponse {
  ok?: boolean;
  project: string;
  /** 乐观锁版本；所有写请求必须带它 */
  rev: number;
  widgets: SerialWidget[];
  /** 单组件/文件内容级问题（不阻塞串口面板） */
  warnings: string[];
  /** 文件级错误（坏 JSON / 超限）；null = 正常 */
  error: string | null;
  path?: string;
  /** 写请求 rev 不匹配时 true（HTTP 409，带最新 widgets/rev） */
  conflict?: boolean;
}

export type SerialWidgetJobState =
  | "running"
  | "paused"
  | "cancelling"
  | "done"
  | "failed"
  | "cancelled";

/** 任务里的一条步骤结果（周期任务按轮次重复出现，超出上限会丢最旧的）。 */
export interface SerialWidgetStepResult {
  i: number;
  kind: "send" | "delay" | "wait";
  ok: boolean;
  t_ms: number;
  round: number;
  text?: string | null;
  via?: string;
  bytes?: number;
  ms?: number;
  matched?: boolean;
  match?: { kind: string; value: string };
  error?: string | null;
}

/**
 * POST /api/serial/widget/run 的结果，也是 GET /api/serial/widget/job 的快照。
 *
 * ★ `dry_run` 只渲染不写口：`preview_b64` 是面板显示与最终发送的**同一份字节**。
 * ★ `stage="validate"` = 400（参数/模板不合法）；`stage="busy"` = 409（已有任务）。
 *   写口失败是 **200 + ok:false**（与 POST /api/serial 同一条纪律）。
 * ★ 异步：周期任务与含 delay/wait 的序列在后台线程跑，HTTP 最多等 2s；
 *   还在跑时返回 `state="running"` + `accepted`，面板按 300–500ms 轮询
 *   `serialWidgetJob` 直到终态。
 */
export interface SerialWidgetRunResult {
  ok: boolean;
  /** true = 已受理，任务仍在后台跑（看 job_id 轮询） */
  accepted?: boolean;
  /** 组件 id；raw 定时任务为 `raw.<ts>` */
  id?: string;
  /** 任务来源：组件 / 发送框定时（不落盘） */
  source?: "widget" | "raw";
  /** 展示名（raw 为「发送框」） */
  label?: string;
  job_id?: string;
  state?: SerialWidgetJobState;
  actor?: string;
  params?: Record<string, unknown>;
  rounds?: number;
  /** 固定节拍不重叠：上一轮超时错过的节拍数（只报告、不补发） */
  skipped?: number;
  repeat?: SerialWidget["repeat"];
  steps?: SerialWidgetStepResult[];
  steps_dropped?: number;
  total_bytes?: number;
  /** 渲染后的总字节数（dry_run 与 run 同源） */
  bytes?: number;
  preview_b64?: string;
  preview_steps?: SerialWidgetStep[];
  port?: string;
  baud?: number;
  via?: "monitor" | "roundtrip" | string;
  stop_reason?: string | null;
  error?: string | null;
  started_at?: number;
  finished_at?: number | null;
  /** dry_run 预览响应 */
  dry_run?: boolean;
  /** 预览里未执行的步骤（dry_run 时给出） */
  deferred?: Array<{ i: number; kind: string }>;
  stage?: "validate" | "busy";
}

/** 任务快照与 `serialWidgetRun` 的返回同形（内核按同一份 `_job_result` 产出）。 */
export type SerialWidgetJob = SerialWidgetRunResult;

// ── /api/adapt（一键适配，M5.6）─────────────────────────────────
export interface AdaptFact {
  key: string;
  value: string;
  /** 证据等级（与 ProjectCard.provenance 的 level 同一套语言） */
  level: string;
  evidence: string;
}

/**
 * `adapt.probe_project()` 的前端镜像。
 *
 * ★ 只声明界面**真正要渲染**的字段，其余走索引签名 —— 后端探测是纯数据透传，
 *   为每个字段造 TS 类型会让"探测多了一个事实"变成跨端同步负担，
 *   而界面从来只展示那几样。消费者必须忽略不认识的字段（与事件信封同一纪律）。
 */
export interface AdaptProbe {
  root: string;
  vendor: string;
  generator: string;
  archetype: string;
  project_name: string;
  chip_ref: string;
  chip_evidence: string;
  linker_script: string;
  toolchain_cmake: string;
  cpu: string;
  fpu: string;
  baud: number;
  usart: string;
  /** 固件是否真有串口输出能力（有 `__io_putchar` 定义 + printf 调用） */
  can_print: boolean;
  /** T1 = 可直接适配；T3 = 没有 CMakeLists.txt，需在图形配置器里切 CMake 后重导出 */
  tier: string;
  facts: AdaptFact[];
  conflicts: string[];
  /** 阻断项：探测**不猜**，须人工/agent 裁决（有它时 write 会被拒） */
  ambiguities: string[];
  /** 提示项：已解决/仅供参考，不阻断 */
  notes: string[];
  confidence: "high" | "medium" | "low";
  [k: string]: unknown;
}

export interface AdaptWriteResult {
  name: string;
  path: string;
  written: boolean;
  /** ★ 与 CLI `elab adapt --write` 的退出码语义同源 */
  status: "written" | "identical" | "differs" | "hand-edited" | "missing" | "drift";
  existed?: boolean;
  backup?: string;
  bytes?: number;
}

export interface AdaptResponse {
  action: "probe" | "write";
  probe: AdaptProbe;
  tier: string;
  confidence: AdaptProbe["confidence"];
  /** 将要/已经写入的工程名（用户没给就用目录名推导） */
  name: string;
  result?: AdaptWriteResult;
  /**
   * 下一步引导：三绿灯 verify 是 build 级长任务，**刻意不**在 /api/adapt 里同步做
   * （会钉死服务线程，§5.1 K1）—— 引导前端走现有 run 通道跑 doctor_deep + build。
   */
  next: { steps: string[]; hint: string };
}

// ── 适配包 / 社区市场（GET /api/packs、POST /api/pkg/*、GET /api/pkg/job）──
// 事实源是内核 `elab.pkg.status()`（`services/elab/pkg.py`）；本文件只做镜像。
// ★ 消费纪律与事件信封一致：不认识的字段一律忽略（内核可先行加字段）。

/** pack.yaml 的 requires 握手（内核版本 / schema 版本）。 */
export interface PkgRequires {
  kernel_api?: string;
  schema_version?: number;
}

/** 兼容性判定结果（不兼容时 reasons 是逐条原因，界面直接展示）。 */
export interface PkgCompatibility {
  ok: boolean;
  reasons: string[];
}

/** 一条已装（或已发现）的适配包记录。 */
export interface InstalledPack {
  name: string;
  version: string | null;
  vendor: string | null;
  platform: string | null;
  status: "official" | "community";
  license: string | null;
  description: string;
  dir: string;
  installed: boolean;
  /** 是否为**当前启用**的那一套（一次只启用一套） */
  active: boolean;
  sha256: string;
  chips: string[];
  requires: PkgRequires;
  compatible: PkgCompatibility;
  /** 市场索引里的最新版本；无市场信息 / 不在索引时 null */
  latest: string | null;
  /** 已安装且市场版本比本地新（界面画「更新到 vX」入口） */
  updatable: boolean;
}

/** 市场索引里的一个条目（内容在作者仓库，索引只记元数据）。 */
export interface MarketPack {
  name: string;
  vendor?: string;
  platform?: string;
  version: string;
  description?: string;
  status?: "official" | "community";
  license?: string;
  requires?: PkgRequires;
  chips?: string[];
  source?: {
    type?: "git" | "archive" | "local";
    url?: string;
    ref?: string;
    subdir?: string;
    path?: string;
  };
  sha256?: string;
  installed: boolean;
  compatible: PkgCompatibility;
}

/** GET /api/packs 的响应（内核 `pkg.status()` 的投影）。 */
export interface PacksStatus {
  roots: string[];
  install_root: string;
  official_root: string;
  /** 当前启用的包名；空串 = 没有启用任何包 */
  active: string;
  installed: InstalledPack[];
  /** 芯片只来自当前启用包（与 Config.chips 同一事实源） */
  chips: string[];
  schema_version: number;
  kernel_api: number;
  /** market=0 时缺省 */
  market?: {
    path: string;
    error: string | null;
    warning: string | null;
    packs: MarketPack[];
  };
}

/** 包写动作（POST /api/pkg/<action>）。 */
export type PkgAction = "install" | "remove" | "update" | "verify" | "activate" | "market";

/** 包操作任务状态（异步 job：install/remove/update 走 202 + 轮询）。 */
export type PkgJobState = "queued" | "running" | "ok" | "failed";

/** GET /api/pkg/job 的响应（内核 PkgJobManager 快照）。 */
export interface PkgJob {
  id: string;
  action: PkgAction;
  name: string;
  state: PkgJobState;
  /** 人类可读的当前阶段（"安装：校验清单与来源" / "完成" / "失败"） */
  stage: string;
  /** 最近 200 行日志（服务端有界） */
  log: string[];
  started_at: string;
  finished_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

/** 单包校验结果（POST /api/pkg/verify）。 */
export interface PkgVerifyResult {
  name: string;
  ok: boolean;
  sha256: string;
  problems: string[];
  dir: string;
}

// ── 调试会话（`/api/debug/*`，镜像内核 DEBUG_META / ICD §6）──────────
// ★ 调试事件有**独立信封**（`GET /api/debug/events`）：没有 `run` 字段，
//   `EventSource` 必须按 topic 逐个 `addEventListener`（见 KNOWN_TOPICS）。

export type DebugState = "starting" | "running" | "stopped" | "error" | "closed";
export type DebugActor = "agent" | "human";

export interface DebugFrame {
  func: string;
  file: string;
  line: number | null;
  addr: string;
}

export interface DebugStop {
  seq: number;
  reason: string;
  thread: string;
  frame: DebugFrame;
  pc: string;
  bkptno: string;
  warn?: string;
}

export interface DebugThread {
  id: number;
  name: string;
  target_id: string;
  current: boolean;
}

export interface DebugSessionSnapshot {
  id: string;
  open_seq: number;
  project: string;
  chip: string;
  elf: string;
  state: DebugState;
  actor: DebugActor;
  owner: DebugActor;
  started_at: number;
  lease_s: number;
  lease_remaining_s: number;
  port: number;
  gdb: string;
  stop: DebugStop | null;
  threads: DebugThread[];
  svd: { available: boolean; file: string };
  features: string[];
  error: { code: string; message: string; hint?: string } | null;
}

export interface DebugSessionResponse {
  session: DebugSessionSnapshot | null;
}

export interface DebugStackFrame {
  level: number;
  addr: string;
  func: string;
  file: string;
  line: number | null;
  arch: string;
  pc: boolean;
}

export interface DebugStackResponse {
  ok: boolean;
  stop_seq: number;
  frames: DebugStackFrame[];
  threads: DebugThread[];
}

export interface DebugReg {
  name: string;
  hex: string;
  natural: string;
  editable: boolean;
  pc?: boolean;
  flags?: Record<string, number>;
}

export interface DebugRegGroup {
  name: "core" | "fpu" | string;
  label: string;
  regs: DebugReg[];
}

export interface DebugRegistersResponse {
  ok: boolean;
  stop_seq: number;
  groups: DebugRegGroup[];
  format: string;
}

export interface DebugVarNode {
  name: string;
  type: string;
  value: string;
  hex: string;
  has_children: boolean;
  addr: string;
  obj?: string;
}

export interface DebugVariablesResponse {
  ok: boolean;
  frame: number;
  scope: string;
  var?: string;
  stop_seq: number;
  nodes: DebugVarNode[];
  truncated: boolean;
}

export interface DebugBreakpoint {
  id: string;
  gdb_id: string;
  kind: "func" | "addr" | "loc";
  location: string;
  enabled: boolean;
  condition: string;
  hit_count: number;
  verified: boolean;
  temporary: boolean;
  hardware: boolean;
}

export interface DebugBreakpointsResponse {
  breakpoints: DebugBreakpoint[];
  /** 工程级配置版本（乐观锁：写回时带上，冲突回 409 debug-rev-conflict） */
  rev?: number;
  allow_write?: boolean;
}

export interface DebugWatchItem {
  id: string;
  expr: string;
  format: string;
  value: string;
  type: string;
  hex: string;
  natural: string;
  error?: string;
}

export interface DebugWatchResponse {
  ok: boolean;
  stop_seq: number;
  rev: number;
  watches: DebugWatchItem[];
  state: DebugState;
}

export interface DebugAuditRecord {
  ts: number;
  action: string;
  session?: string;
  project?: string;
  actor?: string;
  target?: string;
  addr?: string;
  value?: string;
  name?: string;
  location?: string;
  id?: string;
  code?: string;
  message?: string;
}

export interface DebugAuditResponse {
  records: DebugAuditRecord[];
  count: number;
  requested: number;
  path: string;
}

export interface DebugSvdPeripheral {
  name: string;
  base: string;
  group?: string;
  description?: string;
  registers_count?: number;
}

export interface DebugSvdRegister {
  name: string;
  offset: string;
  addr: string;
  size: number;
  access: string;
  description?: string;
  fields_count?: number;
  reset?: string;
  value?: string | null;
  fields?: DebugSvdField[];
}

export interface DebugSvdField {
  name: string;
  bits: string;
  offset: number;
  width: number;
  value: number;
  hex: string;
  enum: { name: string; value: number; description?: string } | null;
  description?: string;
}

export interface DebugPeripheralsResponse {
  ok: boolean;
  stop_seq: number;
  device?: string;
  level: "device" | "peripheral" | "register";
  svd: { file: string; name: string };
  peripherals?: DebugSvdPeripheral[];
  peripheral?: { name: string; base: string; group?: string; description?: string;
                 registers?: DebugSvdRegister[] };
  register?: DebugSvdRegister;
}

export interface DebugRtosTask {
  name: string;
  priority: number | null;
  state: string;
  current: boolean;
  tcb: string;
  stack_start: string;
  stack_end: string | null;
  stack_size_bytes: number | null;
  free_words: number;
  free_bytes: number;
  high_water_mark: number;
  used_bytes: number | null;
  used_pct: number | null;
  health: "ok" | "warn" | "critical";
  scanned: boolean;
}

export interface DebugRtosResponse {
  ok: boolean;
  stop_seq: number;
  tasks: DebugRtosTask[];
  count: number;
  current_tcb: string;
  /** pxCurrentTCB=0（调度器未启动）时的说明，不是错误 */
  note?: string;
}

export interface DebugMemoryResponse {
  ok: boolean;
  addr: string;
  count: number;
  /** 空格分隔的 HEX 字节（如 `00 11 22 ...`） */
  bytes: string;
  ascii: string;
  width: number;
  next: string;
  stop_seq: number;
}

export interface DebugDisasmLine {
  addr: string;
  mnemonic: string;
  operands: string;
  symbol: string;
  pc: boolean;
  bp?: string;
  line?: number | null;
  file?: string;
}

export interface DebugDisasmResponse {
  ok: boolean;
  addr: string;
  instructions: DebugDisasmLine[];
  stop_seq: number;
}

export interface DebugEvaluateResponse {
  ok: boolean;
  expr: string;
  value: string;
  type: string;
  hex: string;
  natural: string;
  stop_seq: number;
}

export interface DebugControlResponse {
  state: DebugState;
  stop: DebugStop | null;
}

export interface DebugOpenOptions {
  stop_at?: "main" | "reset" | "none";
  load?: boolean;
}

/** SSE 信封（`GET /api/debug/events`）。 */
export interface DebugEventEnvelope {
  topic: string;
  seq: number;
  ts: number;
  session: string;
  data: Record<string, unknown>;
}

// ── 串口监视会话动作（插件侧 / 内核侧同名契约）─────────────────────
/** POST /api/serial/monitor 的 body.action。 */
export type SerialAction = 'open' | 'close' | 'decoder' | 'clear' | 'pause' | 'resume'

// ── 插件宿主半自身的跨半契约（/elab/host、/elab/api/discover、/elab/config）──
// ★ 这些不是内核 ICD，是插件 host 半 ↔ client 半的契约；放这里是因为
//   两侧（kernel-http 路由与 dsh-web 面板）都要引用同一份形状（批 2 端口化）。
//   WebUI 若未来挂同形 /elab BFF（方案 §11.7），直接复用这一组形状。

/** GET /elab/host 的响应（宿主半健康面）。 */
export interface HostInfo {
  ok: boolean;
  elabRoot: string | null;
  /** 根的来源：`user` = 设置页/向导指定；`auto` = 会话 cwd 向上找。 */
  rootSource?: 'user' | 'auto' | 'bundled' | null;
  /** 内核自描述版本（`/api/capabilities` 的 cockpit.version；旧内核可能缺）。 */
  kernelVersion?: string | null;
  running: boolean;
  port: number | null;
  pid: number | null;
  job: string | null;
  bootMs: number | null;
  distReady?: boolean | null;
}

// ── 安装向导（GET /elab/env、POST /elab/bootstrap）─────────────────
// 只读探测：只回答"有没有、什么版本"，不下"能不能编译"的结论。

export interface ProbeItem {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface EnvProbe {
  ok: boolean;
  checkedAt: number;
  python: ProbeItem & { path?: string };
  git: ProbeItem;
  cmake: ProbeItem;
  ninja: ProbeItem;
  armGcc: ProbeItem;
  openocd: ProbeItem;
  pyserial: ProbeItem;
}

export interface EnvResponse {
  ok: boolean;
  env: EnvProbe;
  elabRoot: string | null;
  rootSource?: 'user' | 'auto' | 'bundled' | null;
}

export type BootstrapRequest =
  | { action: 'set-root'; dir: string }
  | { action: 'clone'; url: string; dir: string; confirm: true }
  | { action: 'install-toolchain'; pack?: string; confirm: true }
  | { action: 'download-kernel'; version: string; confirm: true }
  /** 零前置自动准备（宿主半按 autoProvision 配置决定跑不跑；不需要 confirm）。 */
  | { action: 'auto-provision' };

export interface BootstrapResponse {
  ok: boolean;
  action?: 'set-root' | 'clone' | 'install-toolchain' | 'download-kernel' | 'auto-provision';
  elabRoot?: string;
  /** install-toolchain：安装结果摘要（工具数 / 告警）。 */
  envPack?: { packId: string; tools: number; warnings: string[] };
  /** auto-provision：自动流程快照（GET /elab/bootstrap 同形）。 */
  auto?: AutoProvisionStatus;
  error?: { code: string; message: string };
}

// ── 零前置自动准备（GET/POST /elab/bootstrap）────────────────────────
// ★ 状态由宿主半维护（单飞、幂等），面板只轮询渲染，不在前端另造一套状态机。

export type AutoProvisionPhase = 'idle' | 'running' | 'done' | 'blocked' | 'failed' | 'disabled'

export type AutoProvisionStep = 'probe' | 'kernel' | 'toolchain' | 'done'

/** 面向用户的失败信息：`message` 是人话（不回显原始异常串）。 */
export interface AutoProvisionError {
  code: string;
  message: string;
  /** false = 重试也没用（当前没有这种情形，保留给后续）。 */
  retryable: boolean;
}

/** 自动流程卡住的原因（只能由用户处理；当前唯一来源 = 主机缺 Python）。 */
export interface AutoProvisionBlocked {
  code: 'python-missing';
  message: string;
  /** 具体指引（装哪个版本、在哪填路径）。 */
  hint: string;
}

export interface AutoProvisionStatus {
  phase: AutoProvisionPhase;
  /** 当前步骤（null = idle/disabled）。 */
  step: AutoProvisionStep | null;
  /** 当前阶段文案（"下载内核 v2.1.0…" / "校验 CMake…"）。 */
  stage: string;
  error: AutoProvisionError | null;
  blocked: AutoProvisionBlocked | null;
  /** 自动流程使用的固定内核版本。 */
  kernelVersion: string;
  updatedAt: number;
}

/** /elab/api/discover 的单个候选工程。 */
export interface DiscoverCandidate {
  path: string;
  dirname: string;
  depth: number;
  hints: { ioc?: string; atwp?: string; generatorDir?: string; linkerScripts: string[] };
  /** 已接入时的工程名（缺省 = 未接入 —— 适配状态机的关键判据）。 */
  adaptedAs?: string;
}

/** GET /elab/api/discover 的响应。 */
export interface DiscoverResponse {
  ok: boolean;
  scanRoot: { path: string; source: string };
  elabRoot?: string;
  adaptedCount: number;
  cached: boolean;
  candidates: DiscoverCandidate[];
  maxDepth: number;
  truncated: boolean;
  dirsVisited: number;
  elapsedMs: number;
}

/** 插件配置（GET/POST /elab/config 的 config 字段，P4 设置页）。 */
export interface ElabConfig {
  elabRoot: string;
  pythonPath: string;
  idleKillSec: number;
  discoverMaxDepth: number;
  discoverLimit: number;
  /** 首次打开面板时自动准备内核与工具链（默认 true；唯一不自动的是主机 Python）。 */
  autoProvision: boolean;
}
