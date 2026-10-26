/**
 * 事件与 API 的类型契约。
 *
 * ★ 本文件是 `docs/ICD_cockpit_events.md` 的**前端侧镜像**。
 *   改字段名/语义必须三处同步：ICD、`services/elab/kernel/events.py`、本文件。
 *   （ICD §7「兼容性承诺汇总」）
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

/** 四态 + skipped/cancelled（§5.2）。`inferred` 用于"超时推断"，UI 画虚线。 */
export type StepState =
  | "pending"
  | "running"
  | "ok"
  | "failed"
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
  serial: { baud?: number; port?: string };
  monitor: { close_on: number; fail_on: number; idle_timeout_s?: number };
  provenance: Record<string, { value: string; level: string; evidence: string }>;
  /** 派生状态位（不是新元数据，只是"文件在不在"） */
  derived: { built: boolean; work_dir_exists: boolean };
  steps: Record<StepId, { ok: boolean; reason: string }>;
  /** 项目声明工具（projects/*.yaml 的 tools: 节）；通用机制，见 run.py TOOL_PREFIX */
  tools: Array<{ name: string; label: string }>;
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
  status: "running" | "ok" | "failed" | "cancelled";
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
export interface SerialMonitorSnapshot {
  active: boolean;
  project?: string;
  port?: string;
  baud?: number;
  backend?: string;
  /** 会话内已累计的行数（= 最后一条的 seq） */
  seq?: number;
  /** 环形缓冲挤掉的总行数（>0 说明有行没活过缓冲期） */
  covered?: number;
  /** 读线程异常自愈时留下的原因（拔线/口被抢）；null = 一切正常 */
  error?: string | null;
}

export interface SerialMonitorLine {
  seq: number;
  text: string;
  /** 服务端已格式化的 HH:MM:SS */
  t: string;
}

export interface SerialMonitorTail extends SerialMonitorSnapshot {
  lines: SerialMonitorLine[];
  /** 浏览器错过（被环形缓冲挤掉）的行数下限 —— 只报告、不抹平 */
  gap: number;
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
