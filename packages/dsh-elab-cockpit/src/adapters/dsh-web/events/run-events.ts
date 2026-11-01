/**
 * RunEventsPort 的浏览器实现 —— EventStream（自管游标 + 退避重连）薄封装。
 *
 * 编排层（app/cockpit-service）只拿到 port 形状：连接、可见性、释放。
 * SSE 帧细节（id 游标、续传、backoff、MAX_SSE_CONNS 纪律）全部留在本适配器。
 *
 * ★ **面板可以同时出现在两个入口**：原生右栏 `sidebar.right.pane.tab`，以及
 *   betterSidebar 的底部工作台（`bottomOnly` Tab）。两个 `CockpitPane` 各自
 *   组装一个 service，若各自 `new EventStream`，同一个 run 会有**两条** SSE ——
 *   上游 `MAX_SSE_CONNS` 是有限信号量，这会挤掉别的消费者。
 *   因此本适配器按 `(url, run, sessionId)` **复用同一条流**：
 *     - 引用计数：最后一个订阅者释放才 `dispose`；
 *     - 可见性取并集：只要还有一个入口可见，流就保持（关一个入口不断另一个）；
 *     - 事件/结束信号广播给所有订阅者（每个入口各自归约自己的快照）。
 */

import type { RunEventConnection, RunEventSink, RunEventsPort } from '../../../app/ports.ts'
import { EventStream } from './sse.ts'

const EVENTS_URL = '/elab/events'

interface Entry {
  sink: RunEventSink
  visible: boolean
  disposed: boolean
}

/** 同一 `(run, sessionId)` 的多入口共享连接。 */
class Hub {
  private readonly stream: EventStream
  private readonly entries = new Set<Entry>()
  readonly key: string

  constructor(key: string, run: string, sessionId: string | undefined) {
    this.key = key
    this.stream = new EventStream(
      { url: EVENTS_URL, run, sessionId },
      {
        onEvent: (e) => {
          for (const en of [...this.entries]) if (!en.disposed) en.sink.onEvent(e)
        },
        onClosed: (reason) => {
          for (const en of [...this.entries]) if (!en.disposed) en.sink.onClosed(reason)
        },
      },
    )
  }

  attach(sink: RunEventSink): RunEventConnection {
    const self = this
    const entry: Entry = { sink, visible: true, disposed: false }
    this.entries.add(entry)
    return {
      setVisible(visible: boolean) {
        if (entry.disposed) return
        entry.visible = visible
        self.sync()
      },
      dispose() {
        if (entry.disposed) return
        entry.disposed = true
        self.entries.delete(entry)
        if (self.entries.size === 0) {
          self.stream.dispose()
          hubs.delete(self.key)
        }
      },
    }
  }

  /** 可见性 = 任一订阅者可见（关一个入口不断另一个）。 */
  private sync(): void {
    this.stream.setVisible([...this.entries].some((e) => e.visible && !e.disposed))
  }
}

const hubs = new Map<string, Hub>()

/**
 * 取（或建）该 run 的共享连接。`run === null` 时不建流（与 EventStream 一致）。
 */
export function createRunEventsPort(): RunEventsPort {
  return {
    connect(run, sessionId, sink) {
      if (run === null) {
        return { setVisible: () => {}, dispose: () => {} }
      }
      const key = `${run}|${sessionId ?? ''}`
      let hub = hubs.get(key)
      if (hub === undefined) {
        hub = new Hub(key, run, sessionId)
        hubs.set(key, hub)
      }
      return hub.attach(sink)
    },
  }
}
