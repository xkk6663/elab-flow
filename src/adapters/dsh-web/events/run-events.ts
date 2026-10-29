/**
 * RunEventsPort 的浏览器实现 —— EventStream（自管游标 + 退避重连）薄封装。
 *
 * 编排层（app/cockpit-service）只拿到 port 形状：连接、可见性、释放。
 * SSE 帧细节（id 游标、续传、backoff、MAX_SSE_CONNS 纪律）全部留在本适配器。
 */

import type { RunEventConnection, RunEventsPort } from '../../../app/ports.ts'
import { EventStream } from './sse.ts'

export function createRunEventsPort(): RunEventsPort {
  return {
    connect(run, sessionId, sink) {
      const stream = new EventStream(
        { url: '/elab/events', run, sessionId: sessionId ?? undefined },
        {
          onEvent: (e) => sink.onEvent(e),
          onClosed: (reason) => sink.onClosed(reason),
        },
      )
      return {
        setVisible: (visible) => stream.setVisible(visible),
        dispose: () => stream.dispose(),
      }
    },
  }
}
