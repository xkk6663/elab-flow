/**
 * 调试会话的跨端类型（内核 §6 ICD 的前端镜像）。
 *
 * ★ 与 run 事件不同，调试事件有**独立信封**（`debug/events`），
 *   因为它没有 `run` 字段 —— 见 `domain/icd.ts` 的 KNOWN_TOPICS 注释。
 */

export type DebugState = 'starting' | 'running' | 'stopped' | 'error' | 'closed'
export type DebugActor = 'agent' | 'human'

export interface DebugFrame {
  func: string
  file: string
  /** MI 的绝对路径（源码页签据此定位）；老 gdb 可能为空 */
  fullname?: string
  line: number | null
  addr: string
}

export interface DebugStop {
  seq: number
  reason: string
  thread: string
  frame: DebugFrame
  pc: string
  bkptno: string
  warn?: string
}

export interface DebugThread {
  id: number
  name: string
  target_id: string
  current: boolean
}

export interface DebugSessionSnapshot {
  id: string
  open_seq: number
  project: string
  chip: string
  elf: string
  state: DebugState
  actor: DebugActor
  owner: DebugActor
  started_at: number
  lease_s: number
  lease_remaining_s: number
  port: number
  gdb: string
  stop: DebugStop | null
  threads: DebugThread[]
  svd: { available: boolean; file: string }
  features: string[]
  error: { code: string; message: string; hint?: string } | null
}

export interface DebugSessionResponse {
  /** 默认/当前会话（单会话时与 sessions[0] 相同；无会话为 null） */
  session: DebugSessionSnapshot | null
  /** 多会话清单（P3）：每项与 session 同构 */
  sessions?: DebugSessionSnapshot[]
  session_id?: string
  max_sessions?: number
  allow_write?: boolean
}

export interface DebugStackFrame {
  level: number
  addr: string
  func: string
  file: string
  /** 绝对路径（缺省时内核按 basename 唯一匹配兜底；多解不猜） */
  fullname?: string
  line: number | null
  arch: string
  pc: boolean
}

export interface DebugStackResponse {
  ok: boolean
  stop_seq: number
  frames: DebugStackFrame[]
  threads: DebugThread[]
}

export interface DebugReg {
  name: string
  hex: string
  natural: string
  editable: boolean
  /** 位宽：32 / 64 / 128（P3 只开 32 位写，d/q 只读） */
  width?: number
  /** 只读原因：core-fixed = pc/lr/xpsr；wide = 64/128 位待 P3b */
  readonly?: 'core-fixed' | 'wide'
  pc?: boolean
  flags?: Record<string, number>
}

export interface DebugRegGroup {
  name: 'core' | 'fpu' | string
  label: string
  regs: DebugReg[]
}

export interface DebugRegistersResponse {
  ok: boolean
  stop_seq: number
  groups: DebugRegGroup[]
  format: string
}

export interface DebugVarNode {
  name: string
  type: string
  value: string
  hex: string
  has_children: boolean
  addr: string
  obj?: string
}

export interface DebugVariablesResponse {
  ok: boolean
  frame: number
  scope: string
  var?: string
  stop_seq: number
  nodes: DebugVarNode[]
  truncated: boolean
}

export interface DebugBreakpoint {
  id: string
  gdb_id: string
  kind: 'func' | 'addr' | 'loc' | 'source'
  location: string
  enabled: boolean
  condition: string
  hit_count: number
  verified: boolean
  temporary: boolean
  hardware: boolean
}

export interface DebugBreakpointsResponse {
  breakpoints: DebugBreakpoint[]
  /** 工程级配置版本（乐观锁：写回时带上，冲突回 409 debug-rev-conflict） */
  rev?: number
  allow_write?: boolean
}

/** GET /api/debug/source —— 源码页签的一页行（P3-A）。 */
export interface DebugSourceResponse {
  ok: boolean
  /** 绝对路径（POSIX 分隔符） */
  file: string
  /** 相对工程源码根的路径（POSIX），断点定位串用它 */
  rel: string
  start: number
  end: number
  total: number
  lines: Array<{ no: number; text: string }>
  mtime: number
  /** 因 512KB 上限丢掉了文件尾部 */
  truncated: boolean
  /** 本窗口之后还有行（翻页用，≠ truncated） */
  has_more?: boolean
  stop_seq?: number
  /** 当前停止帧的行号（高亮用） */
  stop_line?: number | null
  /** 当前停止帧的文件绝对路径 */
  stop_file?: string
}

/** POST /api/debug/registers —— 按组批量写（P3-C）。无事务回滚，如实返回。 */
export interface DebugRegistersWriteResponse {
  ok: boolean
  applied: Array<{ name: string; before: string; after: string }>
  failed?: { name: string; code: string; message: string }
  stop_seq?: number
}

export interface DebugWatchItem {
  id: string
  expr: string
  format: string
  value: string
  type: string
  hex: string
  natural: string
  error?: string
}

export interface DebugWatchResponse {
  ok: boolean
  stop_seq: number
  rev: number
  watches: DebugWatchItem[]
  state: DebugState
}

export interface DebugAuditRecord {
  ts: number
  action: string
  session?: string
  project?: string
  actor?: string
  target?: string
  addr?: string
  value?: string
  name?: string
  location?: string
  id?: string
  code?: string
  message?: string
  /** 组写审计：一次提交的全部项（name/before/after，§7.2） */
  items?: Array<{ name: string; before: string; after: string }>
}

export interface DebugAuditResponse {
  records: DebugAuditRecord[]
  count: number
  requested: number
  path: string
}

export interface DebugSvdPeripheral {
  name: string
  base: string
  group?: string
  description?: string
  registers_count?: number
}

export interface DebugSvdRegister {
  name: string
  offset: string
  addr: string
  size: number
  access: string
  description?: string
  fields_count?: number
  reset?: string
  value?: string | null
  fields?: DebugSvdField[]
}

export interface DebugSvdField {
  name: string
  bits: string
  offset: number
  width: number
  value: number
  hex: string
  enum: { name: string; value: number; description?: string } | null
  description?: string
}

export interface DebugPeripheralsResponse {
  ok: boolean
  stop_seq: number
  device?: string
  level: 'device' | 'peripheral' | 'register'
  svd: { file: string; name: string }
  peripherals?: DebugSvdPeripheral[]
  peripheral?: { name: string; base: string; group?: string; description?: string
                 registers?: DebugSvdRegister[] }
  register?: DebugSvdRegister
}

export interface DebugRtosTask {
  name: string
  priority: number | null
  state: string
  current: boolean
  tcb: string
  stack_start: string
  stack_end: string | null
  stack_size_bytes: number | null
  free_words: number
  free_bytes: number
  high_water_mark: number
  used_bytes: number | null
  used_pct: number | null
  health: 'ok' | 'warn' | 'critical'
  scanned: boolean
}

export interface DebugRtosResponse {
  ok: boolean
  stop_seq: number
  tasks: DebugRtosTask[]
  count: number
  current_tcb: string
  /** pxCurrentTCB=0（调度器未启动）时的说明，不是错误 */
  note?: string
}

export interface DebugWriteResponse {
  ok: boolean
  before?: string
  after?: string
  register?: string
}

export interface DebugMemoryResponse {
  ok: boolean
  addr: string
  count: number
  bytes: string
  ascii: string
  width: number
  next: string
  stop_seq: number
}

export interface DebugDisasmLine {
  addr: string
  mnemonic: string
  operands: string
  symbol: string
  pc: boolean
  bp?: string
  line?: number | null
  file?: string
}

export interface DebugDisasmResponse {
  ok: boolean
  addr: string
  instructions: DebugDisasmLine[]
  stop_seq: number
}

export interface DebugEvaluateResponse {
  ok: boolean
  expr: string
  value: string
  type: string
  hex: string
  natural: string
  stop_seq: number
}

export interface DebugControlResponse {
  state: DebugState
  stop: DebugStop | null
}

export interface DebugOpenOptions {
  stop_at?: 'main' | 'reset' | 'none'
  load?: boolean
}

/** SSE 信封（`GET /elab/debug/events`）。 */
export interface DebugEventEnvelope {
  topic: string
  seq: number
  ts: number
  session: string
  data: Record<string, unknown>
}

/**
 * 调试面板需要的 API 面（由组装点 `CockpitPane` 注入 `elabApi`）。
 * ★ 放在 domain 里而不是让视图直接 import `kernel-http` —— 适配器隔离门禁。
 */
export interface DebugApi {
  debugSession(sessionId?: string, debugSession?: string): Promise<DebugSessionResponse>
  debugOpen(opts: {
    project: string
    options?: DebugOpenOptions
    lease_s?: number
    allow_write?: boolean
    agent?: boolean
    sessionId?: string
  }): Promise<DebugSessionResponse>
  debugClose(opts?: {
    resume?: boolean
    reason?: string
    agent?: boolean
    sessionId?: string
    /** 目标调试会话（P3-B 多会话） */
    debugSession?: string
  }): Promise<{ closed: boolean; resumed?: boolean; session?: string }>
  debugControl(opts: {
    action: string
    addr?: string
    /** run_to_line 用：源码文件 + 行号 */
    file?: string
    line?: number
    confirm?: boolean
    agent?: boolean
    sessionId?: string
    debugSession?: string
  }): Promise<DebugControlResponse>
  debugStack(opts?: { thread?: number; sessionId?: string; debugSession?: string }):
  Promise<DebugStackResponse>
  debugVariables(opts?: {
    frame?: number
    scope?: 'locals' | 'args' | 'children'
    var?: string
    sessionId?: string
    debugSession?: string
  }): Promise<DebugVariablesResponse>
  debugRegisters(opts?: {
    group?: string
    format?: 'natural' | 'hex'
    sessionId?: string
    debugSession?: string
  }): Promise<DebugRegistersResponse>
  /** 按组批量写（P3-C）：整批校验，返回 applied/failed，不假装原子。 */
  debugRegistersWrite(opts: {
    items: Array<{ name: string; value: string }>
    confirm?: boolean
    agent?: boolean
    sessionId?: string
    debugSession?: string
  }): Promise<DebugRegistersWriteResponse>
  /** 源码页签（P3-A）：路径受工程源码根沙箱约束。 */
  debugSource(opts?: {
    file?: string
    start?: number
    count?: number
    sessionId?: string
    debugSession?: string
  }): Promise<DebugSourceResponse>
  debugBreakpoints(opts?: {
    op?: 'list' | 'add' | 'update' | 'toggle' | 'remove'
    id?: string
    kind?: 'func' | 'addr' | 'source'
    location?: string
    condition?: string
    enabled?: boolean
    hardware?: boolean
    temporary?: boolean
    agent?: boolean
    sessionId?: string
    debugSession?: string
  }): Promise<DebugBreakpointsResponse>
  debugMemory(opts: {
    addr: string
    count?: number
    sessionId?: string
    debugSession?: string
  }): Promise<DebugMemoryResponse>
  debugDisasm(opts?: {
    addr?: string
    count?: number
    mode?: number
    sessionId?: string
    debugSession?: string
  }): Promise<DebugDisasmResponse>
  /** 写内存/寄存器：需 allow_write 会话 + confirm=true（内核二次闸门）。 */
  debugWrite(opts: {
    target: 'memory' | 'register'
    addr?: string
    name?: string
    value: string
    confirm?: boolean
    agent?: boolean
    sessionId?: string
    debugSession?: string
  }): Promise<DebugWriteResponse>
  debugEvaluate(opts: {
    expr: string
    frame?: number
    agent?: boolean
    sessionId?: string
    debugSession?: string
  }): Promise<DebugEvaluateResponse>
  debugWatch(opts?: {
    op?: 'list' | 'add' | 'update' | 'remove'
    id?: string
    expr?: string
    format?: string
    rev?: number
    agent?: boolean
    sessionId?: string
    debugSession?: string
  }): Promise<DebugWatchResponse>
  debugAudit(opts?: { limit?: number; sessionId?: string; debugSession?: string }):
  Promise<DebugAuditResponse>
  debugPeripherals(opts?: {
    path?: string
    read?: boolean
    sessionId?: string
    debugSession?: string
  }): Promise<DebugPeripheralsResponse>
  debugRtos(opts?: { sessionId?: string; debugSession?: string }): Promise<DebugRtosResponse>
}
