/**
 * 适配状态机（批 3）—— 「一键适配 / 自动识别」的显式状态。
 *
 * 定位（docs/架构调研 §5 批 3）：
 *   unbound（会话不在 elab 仓库）→ discovered（发现未接入工程）→
 *   adapting（一键适配进行中）→ bound（工程绑定）。
 *
 * ★ 纯函数：状态只由事件驱动（可回放、可单测）。HTTP 落成事件的职责在
 *   app/cockpit-service.ts —— 那边负责编排，这里负责"现在该给用户看什么"。
 *   UI（dsh-web）只渲染 phase 与候选，不含任何判定逻辑。
 */

export type AdaptPhase = 'unbound' | 'discovered' | 'adapting' | 'bound'

/** /elab/api/discover 的候选（本文件只要这三个字段）。 */
export interface AdaptCandidate {
  path: string
  dirname: string
  /** 已接入时的工程名；缺省 = 未接入。 */
  adaptedAs?: string
}

/**
 * 最近一次适配复探测（`action=check` 的结果）。
 *
 * 语义与内核 `elab adapt --check` 同源：重新探测 → 与已写入的
 * `projects/<name>.yaml` 逐字节比对。`drift` = 工程已被手工改动，
 * 需要人重新适配（不自动覆盖 —— 人工接管保护 A7）。
 */
export interface AdaptCheck {
  name: string
  status: 'missing' | 'identical' | 'drift'
  /** 复探测时刻（unix ms；由调用方传入，保持归约纯函数）。 */
  at: number
}

/**
 * 候选工程的**只读探测**结果（`action=probe`，不写盘）。
 *
 * 只保留面板要呈现的那几样；语义与内核 `adapt.probe_project()` 同源。
 * `ambiguities` 非空 = 写入会被拒（阻断项，需人工裁决）。
 */
export interface AdaptProbeInfo {
  path: string
  /** 内核推导出的建议工程名（写入时落成 projects/<name>.yaml）。 */
  name: string
  /** T1 = 可直接适配；T3 = 需先在配置器里切 CMake 后重导出。 */
  tier: string
  confidence: string
  chip: string
  generator: string
  projectName: string
  /** 固件是否有串口输出能力（__io_putchar + printf）。 */
  canPrint: boolean
  ambiguities: string[]
}

export interface AdaptState {
  phase: AdaptPhase
  /** 会话解析出的 elab 仓库根（null = unbound）。 */
  elabRoot: string | null
  /** 最近一次 discover 的候选（含已接入）。 */
  candidates: AdaptCandidate[]
  /** discover 是否已对当前 root 出过结果（区分"还没扫"与"扫过没得接"）。 */
  scanned: boolean
  /** adapting 时的目标工程目录。 */
  target: string | null
  /** 最近一次适配失败的原因（成功后清空）。 */
  error: string | null
  /** 最近一次成功接入的工程名（UI 呈现"已接入 <name>"）。 */
  lastAdapted: string | null
  /** 最近一次复探测结果（null = 还没探测过）。 */
  check: AdaptCheck | null
  /** 最近一次只读探测的结果（null = 还没探测过，或候选已变化）。 */
  probe: AdaptProbeInfo | null
  /** 只读探测在途的目标工程目录（null = 空闲）。 */
  probing: string | null
}

export type AdaptEvent =
  | { type: 'host/resolved'; elabRoot: string | null }
  | { type: 'discover/result'; candidates: AdaptCandidate[] }
  | { type: 'adapt/probe-start'; path: string }
  | { type: 'adapt/probe-result'; probe: AdaptProbeInfo }
  | { type: 'adapt/probe-failed'; error: string }
  | { type: 'adapt/start'; path: string }
  | { type: 'adapt/done'; ok: boolean; name?: string; error?: string }
  | { type: 'adapt/checked'; name: string; status: AdaptCheck['status']; at: number }
  | { type: 'reset' }

export function initialAdaptState(): AdaptState {
  return {
    phase: 'unbound',
    elabRoot: null,
    candidates: [],
    scanned: false,
    target: null,
    error: null,
    lastAdapted: null,
    check: null,
    probe: null,
    probing: null,
  }
}

/** 未接入的候选（adaptedAs 缺失 = 尚无 projects/<name>.yaml）。 */
export function unadaptedCandidates(s: AdaptState): AdaptCandidate[] {
  return s.candidates.filter((c) => c.adaptedAs === undefined)
}

/**
 * 纯归约。未识别的事件原样返回同一引用（与 run.reduce 同一纪律）。
 */
export function reduceAdapt(s: AdaptState, e: AdaptEvent): AdaptState {
  switch (e.type) {
    case 'host/resolved': {
      if (e.elabRoot === null) {
        // 不是 elab 仓库（或解析失败）→ 显式降级到 unbound；候选一并作废
        // （扫描根没了，旧候选指向的是上一个 root 的路径）。
        if (s.phase === 'unbound' && s.elabRoot === null && !s.scanned) return s
        return initialAdaptState()
      }
      if (s.elabRoot === e.elabRoot) return s
      // root 变了（设置页改 elabRoot / 会话切换）：保留 candidates 会指向旧 root，
      // 但新 root 的 discover 马上会来刷新 —— 先按 discovered 呈现，扫完再校准。
      return {
        ...initialAdaptState(),
        elabRoot: e.elabRoot,
        phase: 'discovered',
        lastAdapted: s.lastAdapted,
      }
    }
    case 'discover/result': {
      const hasUnadapted = e.candidates.some((c) => c.adaptedAs === undefined)
      const phase: AdaptPhase =
        s.phase === 'adapting' ? 'adapting' : hasUnadapted ? 'discovered' : 'bound'
      // 候选变了 → 旧探测结果作废（它描述的是上一次扫描里的那个目录）
      const keepProbe =
        s.probe !== null &&
        e.candidates.some((c) => c.adaptedAs === undefined && c.path === s.probe!.path)
      return {
        ...s,
        candidates: e.candidates,
        scanned: true,
        phase,
        probe: keepProbe ? s.probe : null,
      }
    }
    case 'adapt/probe-start': {
      return { ...s, probing: e.path, probe: null, error: null }
    }
    case 'adapt/probe-result': {
      return { ...s, probing: null, probe: e.probe, error: null }
    }
    case 'adapt/probe-failed': {
      return { ...s, probing: null, probe: null, error: e.error }
    }
    case 'adapt/start': {
      return { ...s, phase: 'adapting', target: e.path, error: null, check: null, probing: null }
    }
    case 'adapt/checked': {
      return { ...s, check: { name: e.name, status: e.status, at: e.at } }
    }
    case 'adapt/done': {
      if (e.ok) {
        // 成功 → bound。projects/reload 与 discover(refresh) 随后到达，
        // discover/result 会用真实候选再校准一次（幂等）。
        return {
          ...s,
          phase: 'bound',
          target: null,
          lastAdapted: e.name ?? s.lastAdapted,
          error: null,
          check: null,
          probe: null,
          probing: null,
        }
      }
      // 失败 → 回到 discovered（banner 继续可点），原因显式呈现。
      return {
        ...s,
        phase: s.elabRoot === null ? 'unbound' : 'discovered',
        target: null,
        error: e.error ?? '适配失败',
        probing: null,
      }
    }
    case 'reset':
      return initialAdaptState()
    default:
      return s
  }
}
