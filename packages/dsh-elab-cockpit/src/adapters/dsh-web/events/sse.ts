/**
 * SSE 客户端 —— 把 `/elab/events` 的帧路由进 runStore / logs。
 *
 * 移植自 `cockpit/web/src/events/sse.ts`（161 行），三条关键事实原样保留
 * （那些注释是实测事故的产物，搬迁时一条都不能丢）：
 *
 *  ① 服务端用 `id: <seq>` + `event: <topic>` 发帧 → 客户端带上 Last-Event-ID
 *     时服务端做 `after = max(from, leid)`。**我们不需要自己实现重连逻辑**，
 *     只需要把 `from=` 作为首帧起点；浏览器原生 EventSource 会自动带 leid，
 *     但**我们的面板可能不可见要主动断连**，所以这里改为自管游标 + 手动重连。
 *
 *  ② run 结束时服务端显式发 `event: stream/closed`（reason: run-finished /
 *     unknown-run）**并**写 chunked 终止块。★ 因此关闭的时机是**收到
 *     stream/closed**，而不是 onerror —— 在 onerror 里关会把"网络抖动"
 *     误判成"跑完了"，日志从此再也接不上。
 *
 *  ③ 高频行被服务端合并成 `proc/stdout-batch`（100ms），本层无需再节流。
 *
 * 新增（本插件特有）：
 *  - **可见性驱动**：面板不可见 → 断开连接（不浪费宿主/上游的 SSE 槽位）；
 *    变可见 → 从 `lastSeq` 续传。上游 `MAX_SSE_CONNS` 有上限，这条不是优化而是纪律。
 *  - 事件计数钩子 `ingestHistogram()` 保留：它救过一次"徽标显示 3 行、
 *    实际 36 行"的白屏事故。
 */

import type { ElabEvent } from '../../../domain/icd.ts'

/** 事件消费者：先状态后日志，顺序固定（回放时时序才一致）。 */
export interface SseSink {
  /** 单条事件。 */
  onEvent(event: ElabEvent): void
  /** 服务端宣告流结束。 */
  onClosed(reason: string): void
}

export type StreamState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export interface SseOptions {
  /** `/elab/events` 的基地址（Host 半路由）。 */
  url: string
  /** 起始 run（null = 不连）。 */
  run: string | null
  /** 会话 id（Host 半据此解析 cwd → elab 仓库根；批 2 端口化时上提为参数）。 */
  sessionId?: string
  /** 断线重连的退避上限（ms）。 */
  maxBackoffMs?: number
  /** 网络错误时的重试次数上限；超过则转 error 状态。 */
  maxRetries?: number
}

const ingestHist: Record<string, number> = {}

export function ingestHistogram(): Record<string, number> {
  return { ...ingestHist }
}

/**
 * 一个可复用的 SSE 连接。
 *
 * 用法：
 * ```ts
 * const stream = createEventStream({ url: '/elab/events', run: 'r-xxx' }, sink)
 * stream.setVisible(false)  // 面板隐藏 → 断开
 * stream.setVisible(true)   // 面板可见 → 从 lastSeq 续传
 * stream.dispose()
 * ```
 */
export class EventStream {
  private es: EventSource | undefined
  private state: StreamState = 'idle'
  private lastSeq = 0
  private retries = 0
  private visible = true
  private disposed = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private readonly opts: Required<Omit<SseOptions, 'run' | 'sessionId'>> & { run: string | null; sessionId?: string }
  private readonly sink: SseSink

  constructor(opts: SseOptions, sink: SseSink) {
    this.opts = {
      url: opts.url,
      run: opts.run,
      sessionId: opts.sessionId,
      maxBackoffMs: opts.maxBackoffMs ?? 15_000,
      maxRetries: opts.maxRetries ?? 6,
    }
    this.sink = sink
    if (opts.run !== null) this.connect()
  }

  getState(): { state: StreamState; lastSeq: number } {
    return { state: this.state, lastSeq: this.lastSeq }
  }

  /** 切 run：断开旧的，从 0 开始（新 run 的 seq 从 1 起）。 */
  switchRun(run: string | null): void {
    if (this.opts.run === run) return
    this.opts.run = run
    this.lastSeq = 0
    this.retries = 0
    this.disconnect()
    if (run !== null && this.visible) this.connect()
  }

  /**
   * 可见性：**面板不可见必须断开**。
   * 上游 `MAX_SSE_CONNS` 是有限的（`server.py` 用 Semaphore 限制），
   * 隐藏的面板占着一条连接会挤掉别的消费者。
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    if (!visible) {
      this.disconnect()
      this.state = 'idle'
      return
    }
    if (this.opts.run !== null && this.es === undefined) {
      this.connect()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.disconnect()
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private connect(): void {
    if (this.disposed || this.opts.run === null) return
    this.disconnect()
    this.state = 'connecting'
    const q = new URLSearchParams({ run: this.opts.run, from: String(this.lastSeq) })
    if (this.opts.sessionId !== undefined && this.opts.sessionId !== '') q.set('sessionId', this.opts.sessionId)
    // ★ from=lastSeq 是首帧起点；浏览器若带 Last-Event-ID，服务端会取 max()
    const es = new EventSource(`${this.opts.url}?${q.toString()}`)
    this.es = es

    es.onopen = () => {
      this.state = 'open'
      this.retries = 0
    }

    es.onmessage = (ev: MessageEvent<string>) => {
      this.ingestRaw(ev.data)
    }

    // 服务端按 topic 发具名事件；EventSource 的 onmessage 只收 event: message。
    // 所以这里监听一批已知 topic（ICD §3），未知 topic 走 onmessage 的兜底。
    for (const topic of KNOWN_TOPICS) {
      es.addEventListener(topic, (ev) => {
        this.ingestRaw((ev as MessageEvent<string>).data)
      })
    }
    // stream/closed 是终止信号（见文件头 ②）
    es.addEventListener('stream/closed', (ev) => {
      const data = safeJson((ev as MessageEvent<string>).data)
      this.state = 'closed'
      this.disconnect()
      this.sink.onClosed(String(data?.reason ?? 'unknown'))
    })

    es.onerror = () => {
      // ★ 不在这里判定"跑完了"：只有 stream/closed 才是结束。
      //   这里只处理重连退避。
      if (this.state === 'closed' || this.disposed) return
      this.state = 'error'
      this.scheduleReconnect()
    }
  }

  private ingestRaw(raw: string): void {
    const e = safeJson(raw) as ElabEvent | null
    if (e === null) return
    const topic = String(e.topic ?? '?')
    ingestHist[topic] = (ingestHist[topic] ?? 0) + 1
    const seq = Number(e.seq ?? 0)
    // 去重 + 单调推进：重连时可能重叠一小段
    if (Number.isFinite(seq) && seq > 0) {
      if (seq <= this.lastSeq) return
      this.lastSeq = seq
    }
    this.sink.onEvent(e)
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.visible) return
    if (this.retries >= this.opts.maxRetries) {
      this.state = 'error'
      return
    }
    this.retries += 1
    const delay = Math.min(500 * 2 ** (this.retries - 1), this.opts.maxBackoffMs)
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      // 从 lastSeq 续传（服务端 max(from, leid) 会再兜一次）
      this.connect()
    }, delay)
  }

  private disconnect(): void {
    if (this.es !== undefined) {
      this.es.close()
      this.es = undefined
    }
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * ICD §3 的 topic 清单（服务端以 `event: <topic>` 发帧）。
 * 新增 topic 属兼容变更，但 EventSource 不认未监听的名字 ——
 * 所以 `proc/stdout-batch` 这类高频 topic 必须在这里。
 */
export const KNOWN_TOPICS = [
  'run/start',
  'run/step-enter',
  'run/step-exit',
  'run/end',
  'run/cancel',
  'proc/stdout',
  'proc/stderr',
  'proc/stdout-batch',
  'stream/overrun',
  'stream/closed',
  'serial/open',
  'serial/line',
  'serial/close',
  'serial/closed-loop',
] as const
