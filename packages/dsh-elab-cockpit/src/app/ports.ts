/**
 * 端口声明（批 2）—— 应用层与适配器之间的**全部**依赖形状。
 *
 * 依赖方向（§4.4）：
 *   - adapters → 这里（实现/消费端口，type-only）；
 *   - app（cockpit-service）→ 这里（消费端口）；
 *   - 这里 → domain（契约类型）；
 *   - **这里不得 import 任何 adapters** —— 实现由 main.ts 组装注入。
 *
 * ★ 命名即架构：只声明类型，不造工厂、不引 DI 框架（§6 风险对策）。
 *   每个端口当前只有一个实现 —— 这是有意的（第二个实现出现前不抽象）。
 */

import type {
  AdaptResponse,
  AutoProvisionStatus,
  BootstrapRequest,
  BootstrapResponse,
  DiscoverResponse,
  ElabConfig,
  ElabEvent,
  EnvResponse,
  HostInfo,
  PlanPreview,
  SerialAction,
  SerialBytesTail,
  SerialDecodeResult,
  SerialDecodedTail,
  SerialMonitorSnapshot,
  SerialMonitorTail,
  SerialWidget,
  SerialWidgetRunResult,
  SerialWidgetsDoc,
  SerialWriteResult,
} from '../domain/icd.ts'
import type { RunArbiter } from '../domain/arbiter.ts'

// ── 内核会话端口（host 半）────────────────────────────────────────

/** 内核 HTTP 面的取用端口：按需启动 / 取 baseUrl（实现：kernel-process + main 组装）。 */
export interface KernelPort {
  ensureHost(sessionId?: string): Promise<{ baseUrl: string }>
}

/** 留存配置（runs 清理策略）—— fs-store 适配器的参数形态，非 I/O。 */
export interface RetentionConfig {
  /** 保留最近多少个 run。 */
  keepCount: number
  /** 保留多少天内的 run。 */
  keepDays: number
  /** 目录总容量上限（字节）。 */
  maxTotalBytes: number
  /** 干跑：只算不删（排查用）。 */
  dryRun: boolean
}

/** 串口监视互斥记账端口（§6.2 规则 2；实现：kernel-http/routes 的 createSerialMutexTracker）。 */
export interface SerialMutexPort {
  setOpen(active: boolean): void
  isActive(): boolean
}

/**
 * 代理路由的依赖端口（原 ProxyDeps；实现由 main 注入）。
 * config() 返回的是宿主半配置的结构子集（kernel-http 的 HostRouteConfig 满足它）。
 */
export interface KernelProxyDeps extends KernelPort {
  config(): {
    elabRoot: string
    pythonPath: string
    idleKillSec: number
    retention: RetentionConfig
  }
  /** run 仲裁（P5）：POST /elab/api/run 路径上的单飞互斥；缺省不拦。 */
  arbiter?: RunArbiter
  /** 串口监视互斥记账（P5 §6.2 规则 2）；缺省不拦。 */
  serialMutex?: SerialMutexPort
}

/** agent 工具的依赖端口（原 ToolsDeps；实现由 main 注入）。 */
export interface ToolDeps extends KernelPort {
  arbiter: RunArbiter
  allowAgentWrite(): boolean
  warn(msg: string): void
}

// ── 面板编排端口（client 半；cockpit-service 消费）────────────────

/**
 * ICD HTTP 客户端端口（编排服务要用的子集；实现：kernel-http/icd-client 的 elabApi）。
 * 契约类型全部来自 domain/icd.ts —— 端口不复制契约。
 */
export interface IcdPort {
  host(sessionId?: string): Promise<HostInfo>
  capabilities(sessionId?: string): Promise<Record<string, unknown>>
  /** 引导向导：只读环境探测（不 spawn 内核）。 */
  env(sessionId?: string): Promise<EnvResponse>
  /** 引导向导：set-root / clone / install-toolchain / download-kernel（写动作需确认）。 */
  bootstrap(req: BootstrapRequest, sessionId?: string): Promise<BootstrapResponse>
  /**
   * 零前置自动准备的状态快照（宿主半单飞；面板轮询渲染）。
   * 旧宿主可能没有这个端点 → 调用方必须容忍缺省。
   */
  bootstrapStatus?(sessionId?: string): Promise<{ ok: boolean; auto: AutoProvisionStatus }>
  /** 插件配置（autoProvision 开关在这里读；旧宿主缺省按 true）。 */
  getConfig?(): Promise<{ ok: boolean; config: ElabConfig }>
  projects(sessionId?: string): Promise<{ projects?: unknown[]; cards?: unknown[] }>
  /** run 列表 + 活动 run（agent 在别处起跑时，面板靠它自动跟随工程）。 */
  runs(sessionId?: string): Promise<{ runs: unknown[]; active: unknown[] }>
  discover(sessionId?: string, refresh?: boolean): Promise<DiscoverResponse>
  adapt(opts: {
    action: 'probe' | 'write' | 'check'
    path: string
    name?: string
    force?: boolean
    sessionId?: string
  }): Promise<AdaptResponse>
  startRun(opts: {
    project: string
    steps: string[]
    clean?: boolean
    jobs?: number
    sessionId?: string
  }): Promise<{ run: string; project: string; steps: string[]; actor: string }>
  cancel(run: string, reason?: string, sessionId?: string): Promise<{ ok: boolean }>
  plan(opts: {
    project: string
    steps?: string[]
    clean?: boolean
    jobs?: number
    sessionId?: string
  }): Promise<PlanPreview>
}

/**
 * 串口数据面端口（client 半；实现：kernel-http/icd-client 的 elabApi 串口子集）。
 * 四视图（行/字节/终端/波形）+ 发送/录制都只经这一处取数，dsh-web 不 import 兄弟适配器。
 */
export interface SerialPort {
  serial(opts: {
    project: string
    data: string
    port?: string
    baud?: number
    format?: string
    eol?: string
    encoding?: string
    sessionId?: string
  }): Promise<SerialWriteResult>
  serialMonitor(after?: number, sessionId?: string): Promise<SerialMonitorTail>
  serialMonitorBytes(
    after?: number,
    opts?: { dir?: 'all' | 'rx' | 'tx'; limit?: number; sessionId?: string },
  ): Promise<SerialBytesTail>
  /** 会话级共享解码帧（agent 与面板读同一份；P3.5） */
  serialMonitorDecoded(after?: number, sessionId?: string): Promise<SerialDecodedTail>
  serialMonitorToggle(
    action: SerialAction,
    opts?: {
      project?: string
      port?: string
      baud?: number
      actor?: 'human' | 'agent'
      lease_s?: number
      allow_agent_write?: boolean
      /** action=decoder 时：justfloat / firewater（'' = 关闭共享解码） */
      decoder?: string
      sessionId?: string
    },
  ): Promise<Record<string, unknown>>
  serialDecode(opts: {
    decoder: string
    dataB64?: string
    hex?: string
    channels?: number
    sessionId?: string
  }): Promise<SerialDecodeResult>
  serialCapture(opts: {
    action: 'start' | 'stop' | 'status'
    project?: string
    maxBytes?: number
    sessionId?: string
  }): Promise<Record<string, unknown>>
  // ── 串口发送组件（M1/M2）──────────────────────────────────────
  serialWidgets(project: string, sessionId?: string): Promise<SerialWidgetsDoc>
  serialWidgetSave(opts: {
    project: string
    rev: number
    widget: SerialWidget | Record<string, unknown>
    sessionId?: string
  }): Promise<SerialWidgetsDoc>
  serialWidgetDelete(opts: { project: string; rev: number; id: string; sessionId?: string }): Promise<SerialWidgetsDoc>
  serialWidgetRun(opts: {
    project: string
    id: string
    params?: Record<string, unknown>
    dryRun?: boolean
    repeat?: boolean
    confirm?: boolean
    agent?: boolean
    sessionId?: string
  }): Promise<SerialWidgetRunResult>
  serialWidgetJob(jobId?: string, sessionId?: string): Promise<SerialWidgetRunResult>
  serialWidgetCancel(jobId: string, sessionId?: string): Promise<{ ok: boolean; id: string; state: string }>
  serialWidgetPause(
    jobId: string,
    paused: boolean,
    sessionId?: string,
  ): Promise<{ ok: boolean; id: string; state: string; paused?: boolean }>
}

/** run 事件流的消费者（dsh-web 的环形缓冲从这里拿原始事件）。 */
export interface RunEventSink {
  onEvent(e: ElabEvent): void
  /** 服务端宣告流结束（run-finished / unknown-run / …）。 */
  onClosed(reason: string): void
}

/** 一条 run 事件流连接（可见性由调用方驱动 —— MAX_SSE_CONNS 纪律）。 */
export interface RunEventConnection {
  setVisible(visible: boolean): void
  dispose(): void
}

/**
 * run 事件流端口（实现：dsh-web/events/sse.ts 的 EventStream 封装）。
 * 续传游标（lastSeq）由实现自管 —— 编排层不碰 SSE 帧。
 */
export interface RunEventsPort {
  connect(run: string | null, sessionId: string | undefined, sink: RunEventSink): RunEventConnection
}
