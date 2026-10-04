/**
 * SSE 客户端 —— 把 `/api/events` 的帧路由进 runStore 与 logs（§17）。
 *
 * 关键事实（读 server.py 的 `_sse()` 得到，不是猜的）：
 *  ① 服务端用 `id: <seq>` + `event: <topic>` 发帧 → 浏览器**原生重连**时会
 *     自动回传 `Last-Event-ID`，服务端 `after = max(from, Last-Event-ID)`。
 *     所以我们**不需要自己实现重连**，只需要把 `from=` 作为首帧起点。
 *  ② `run` 结束时服务端会显式发 `event: stream/closed`
 *     （`reason: run-finished` / `unknown-run`）**并**写 chunked 终止块。
 *     ★ 因此关闭 EventSource 的时机是**收到 stream/closed**，而不是 `onerror`。
 *       若在 onerror 里关，会把"网络抖动"误判成"跑完了"，日志就再也接不上。
 *  ③ 高频行被服务端合并成 `proc/stdout-batch`（100ms），本层无需再节流。
 */

import type { ElabEvent } from "../api/types";
import { KNOWN_TOPICS } from "../api/types";
import { applyEvent } from "../store/runStore";
import { logs } from "../store/logs";

/**
 * 按 topic 的到达计数。
 *
 * ★ 为什么值得常驻：驾驶舱的前端**没有 Node 侧测试运行器**（产物入库、运行时零
 *   Node），所以"事件到底有没有到达浏览器"这个最基本的问题，只能靠浏览器里
 *   的可观测钩子来回答。测量方式：`window.__elab.ingest()`。
 *   它是一次实测事故的产物 —— 界面徽标显示 3 行、run 实际有 36 行，
 *   而"服务端发了没有 / 前端收了没有"在没有计数器时完全是黑盒。
 */
const ingestHist: Record<string, number> = {};

export function ingestHistogram(): Record<string, number> {
  return { ...ingestHist };
}

/** 一条事件 → 两个消费者。顺序固定：先状态后日志，回放时时序一致。 */
function ingest(e: ElabEvent): void {
  const t = String(e.topic || "?");
  ingestHist[t] = (ingestHist[t] || 0) + 1;
  applyEvent(e);
  logs.push(e);
}

export interface StreamHandle {
  run: string;
  /** 主动断开（切工程 / 关页面）。收到 stream/closed 后**无需**调用。 */
  close(): void;
  closed(): boolean;
}

export interface StreamOpts {
  /** 首帧起点。断线后由浏览器自带 Last-Event-ID 接管，不走这里。 */
  from?: number;
  /** 服务端宣告流结束（而非网络错误）时回调 */
  onClosed?: (reason: string, rc: number | null) => void;
  /** EventSource 建立/断开时回调，供 UI 显示"连接中…" */
  onState?: (s: "connecting" | "open" | "reconnecting") => void;
}

export function openRunStream(run: string, opts: StreamOpts = {}): StreamHandle {
  const url =
    `/api/events?run=${encodeURIComponent(run)}` + `&from=${Math.max(0, opts.from ?? 0)}`;
  const es = new EventSource(url);
  let done = false;

  const onFrame = (ev: Event): void => {
    const me = ev as MessageEvent;
    let e: ElabEvent;
    try {
      e = JSON.parse(me.data) as ElabEvent;
    } catch {
      // 单条坏帧不该拖垮整个流：跳过并继续
      return;
    }
    ingest(e);
  };

  // ★ 必须按名订阅：服务端发的是 `event: <topic>`，`onmessage` 收不到。
  //   见 types.ts 中 KNOWN_TOPICS 的说明（SSE 协议层面的硬限制）。
  //   `stream/closed` 由下方**专用**处理器接管（要读 reason/rc 并主动 close），
  //   故不在这里重复注册 —— 双重注册虽无害（reduce 的 default 分支会忽略它），
  //   但会让人误以为它走的是普通事件通道。
  for (const topic of KNOWN_TOPICS) {
    if (topic === "stream/closed") continue;
    es.addEventListener(topic, onFrame);
  }

  es.addEventListener("stream/closed", (ev) => {
    if (done) return;
    done = true;
    const me = ev as MessageEvent;
    let reason = "";
    let rc: number | null = null;
    try {
      const d = JSON.parse(me.data) as { reason?: string; rc?: number | null };
      reason = d.reason || "";
      rc = typeof d.rc === "number" ? d.rc : null;
    } catch {
      /* 缺 reason 也能收尾 */
    }
    // 服务端已写终止块，主动关掉避免 EventSource 按默认 3s 无脑重连
    es.close();
    opts.onClosed?.(reason, rc);
  });

  // 无 `event:` 的帧（协议兜底）
  es.onmessage = onFrame;

  es.onopen = () => opts.onState?.("open");

  es.onerror = () => {
    // 已收 stream/closed → 这是 close() 引发的，忽略。
    // 否则交给浏览器原生重连（它会带上 Last-Event-ID，§17.2）。
    if (done) return;
    opts.onState?.(es.readyState === EventSource.CLOSED ? "reconnecting" : "connecting");
  };

  opts.onState?.("connecting");

  return {
    run,
    close() {
      done = true;
      es.close();
    },
    closed() {
      return done;
    },
  };
}

/**
 * 回放历史 run（点开工程时用 `GET /api/run-events`，而非 SSE）。
 *
 * ★ 回放走 JSON 而非 SSE，是刻意的：历史 run 不需要重连语义，
 *   而且 `read_run` 已经做了 `after_seq` 过滤，一次拿完最简单。
 *   代价：这条路**不受 KNOWN_TOPICS 限制**（它是 JSON 数组），
 *   故 `reduce()` 的 default 分支能兜住未来新增的 topic。
 */
export async function replayRun(run: string, from = 0): Promise<number> {
  const res = await fetch(
    `/api/run-events?run=${encodeURIComponent(run)}&from=${Math.max(0, from)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`回放失败：HTTP ${res.status}`);
  const body = (await res.json()) as { events?: ElabEvent[] };
  const list = body.events || [];
  for (const e of list) ingest(e);
  return list.length;
}

/**
 * 浏览器侧自测钩子：`window.__elab.ingest()` → 按 topic 的到达计数；
 * `window.__elab.logs` → 环形缓冲真值（`stats` / `snapshot()`）。
 * 只读、无副作用，用于在**没有测试运行器**的前提下做端到端断言。
 */
if (typeof window !== "undefined") {
  (window as unknown as { __elab?: unknown }).__elab = {
    ingest: ingestHistogram,
    logs,
  };
}
