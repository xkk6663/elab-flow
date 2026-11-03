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
  session: DebugSessionSnapshot | null
}

export interface DebugStackFrame {
  level: number
  addr: string
  func: string
  file: string
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
  kind: 'func' | 'addr' | 'loc'
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
  debugSession(sessionId?: string): Promise<DebugSessionResponse>
  debugOpen(opts: {
    project: string
    options?: DebugOpenOptions
    lease_s?: number
    allow_write?: boolean
    agent?: boolean
    sessionId?: string
  }): Promise<DebugSessionResponse>
  debugClose(opts?: { resume?: boolean; reason?: string; agent?: boolean; sessionId?: string }):
  Promise<{ closed: boolean; resumed?: boolean; session?: string }>
  debugControl(opts: {
    action: string
    addr?: string
    confirm?: boolean
    agent?: boolean
    sessionId?: string
  }): Promise<DebugControlResponse>
  debugStack(opts?: { thread?: number; sessionId?: string }): Promise<DebugStackResponse>
  debugVariables(opts?: {
    frame?: number
    scope?: 'locals' | 'args' | 'children'
    var?: string
    sessionId?: string
  }): Promise<DebugVariablesResponse>
  debugRegisters(opts?: { group?: string; format?: 'natural' | 'hex'; sessionId?: string }):
  Promise<DebugRegistersResponse>
  debugBreakpoints(opts?: {
    op?: 'list' | 'add' | 'update' | 'toggle' | 'remove'
    id?: string
    kind?: 'func' | 'addr'
    location?: string
    condition?: string
    enabled?: boolean
    hardware?: boolean
    temporary?: boolean
    agent?: boolean
    sessionId?: string
  }): Promise<DebugBreakpointsResponse>
  debugMemory(opts: { addr: string; count?: number; sessionId?: string }): Promise<DebugMemoryResponse>
  debugDisasm(opts?: { addr?: string; count?: number; mode?: number; sessionId?: string }):
  Promise<DebugDisasmResponse>
  debugEvaluate(opts: { expr: string; frame?: number; agent?: boolean; sessionId?: string }):
  Promise<DebugEvaluateResponse>
  debugWatch(opts?: {
    op?: 'list' | 'add' | 'update' | 'remove'
    id?: string
    expr?: string
    format?: string
    rev?: number
    agent?: boolean
    sessionId?: string
  }): Promise<DebugWatchResponse>
  debugAudit(opts?: { limit?: number; sessionId?: string }): Promise<DebugAuditResponse>
  debugPeripherals(opts?: { path?: string; read?: boolean; sessionId?: string }):
  Promise<DebugPeripheralsResponse>
  debugRtos(opts?: { sessionId?: string }): Promise<DebugRtosResponse>
}
