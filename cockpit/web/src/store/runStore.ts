/**
 * runStore —— 事件流的**纯函数归约** + `useSyncExternalStore` 桥（§15.5）。
 *
 * 三条不可动摇的性质：
 *  ① `reduce(snapshot, event)` 是**纯函数** → 可以对同一事件流回放出任意时刻的界面；
 *  ② **事件是唯一写入口** → 前端不可能与后端状态漂移（"Model-visible means logged"）；
 *  ③ 快照**不可变**，无变化时 `reduce` 返回**同一个引用** → uSES 的引用相等判断天然正确，
 *    不会因为"其实没变"而白重渲染。
 *
 * ★ 日志**不进**本 store（性能关键，§15.5）：`proc/*` 动辄上万行，
 *   走 `store/logs.ts` 的环形缓冲 + 命令式 DOM 追加。React 只管骨架与状态。
 */

import { useSyncExternalStore } from "react";
import type { Actor, ElabEvent, StepResult, StepState } from "../api/types";

export interface StepView {
  id: string;
  index: number;
  state: StepState;
  detail: string;
  duration_s: number;
  result?: StepResult;
}

export interface RunSnapshot {
  run: string | null;
  project: string;
  /** `run/start.steps` 声明的步骤序列（权威） */
  steps: StepView[];
  actor: Actor | null;
  status: "idle" | "running" | "ok" | "failed" | "cancelled";
  startedAt: number | null;
  endedAt: number | null;
  lastSeq: number;
  currentStep: string | null;
  /** 串口闭环判定（§16；M3-a 起由 `run.py` 的 monitor 分支发射） */
  closedLoop: null | { verdict: string; rule: string; evidence: string };
  /**
   * 服务端背压丢弃计数（`stream/overrun`，契约 §3.2 / §17.3）。
   *
   * ★ 与 `logs.ts` 的 `stats.dropped` **不是一回事**，别混：
   *   - `logs.ts.dropped` = **浏览器自己**的环形缓冲挤出条数（容量 4000，丢了能重来）；
   *   - 这里的 `overrun` = **服务端**因为这条 SSE 连接太慢而**没发出来**的条数。
   *     它是**这一条连接**的损失，真值仍在服务端的 `.proc.jsonl` 里 ——
   *     所以 UI 的正确动作是"提示 + 建议重载"，而不是"当作没发生"。
   */
  overrun: number;
  /** 溢出的通道范围（服务端给的 `topic_scope`，如 `proc/*` / `run/*`） */
  overrunScope: string;
  /** 最近一次 build 的内存/产物（供阶段轨复用，不必翻事件） */
  lastBuild: StepResult | null;
}

const IDLE: RunSnapshot = {
  run: null,
  project: "",
  steps: [],
  actor: null,
  status: "idle",
  startedAt: null,
  endedAt: null,
  lastSeq: 0,
  currentStep: null,
  closedLoop: null,
  overrun: 0,
  overrunScope: "",
  lastBuild: null,
};

let snapshot: RunSnapshot = IDLE;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function patch(s: RunSnapshot, p: Partial<RunSnapshot>): RunSnapshot {
  return { ...s, ...p };
}

function setStep(s: RunSnapshot, id: string, p: Partial<StepView>): RunSnapshot {
  let hit = false;
  const steps = s.steps.map((v) => {
    if (v.id !== id) return v;
    hit = true;
    return { ...v, ...p };
  });
  if (!hit) return s;
  return patch(s, { steps });
}

/**
 * 纯归约。**未识别的 topic 一律原样返回 `s`** —— 这既是前向兼容（ICD §7：
 * 新增 topic 是兼容变更），也让 uSES 不会因为无关事件白白重渲染。
 */
export function reduce(s: RunSnapshot, e: ElabEvent): RunSnapshot {
  const topic = String(e.topic || "");
  const seq = Number(e.seq || 0);

  // 活动事件不进状态（日志另走 logs.ts）；stream/closed 只更新游标
  if (topic.startsWith("proc/") || topic.startsWith("serial/")) {
    if (topic === "serial/closed-loop") {
      const d = e as Record<string, unknown>;
      return patch(s, {
        lastSeq: seq,
        closedLoop: {
          verdict: String(d.verdict || ""),
          rule: String(d.rule || ""),
          evidence: String(d.evidence || ""),
        },
      });
    }
    return seq > s.lastSeq ? patch(s, { lastSeq: seq }) : s;
  }

  switch (topic) {
    case "run/start": {
      const declared = (e.steps as string[] | undefined) || [];
      return {
        ...IDLE,
        run: String(e.run),
        project: String(e.project || ""),
        actor: (e.actor as Actor) || "agent",
        status: "running",
        startedAt: Number(e.ts) || null,
        lastSeq: seq,
        steps: declared.map((id, index) => ({
          id,
          index,
          state: "pending" as StepState,
          detail: "",
          duration_s: 0,
        })),
      };
    }

    case "run/step-enter": {
      const id = String(e.step || "");
      const next = setStep(s, id, { state: "running" });
      return patch(next, { currentStep: id, lastSeq: seq });
    }

    case "run/step-exit": {
      const id = String(e.step || "");
      const ok = Boolean(e.ok);
      const result = e as unknown as StepResult;
      const next = setStep(s, id, {
        state: ok ? "ok" : "failed",
        detail: String(e.detail || ""),
        duration_s: Number(e.duration_s || 0),
        result,
      });
      return patch(next, {
        currentStep: next.currentStep === id ? null : next.currentStep,
        lastSeq: seq,
        lastBuild: id === "build" ? result : next.lastBuild,
      });
    }

    case "run/end": {
      return patch(s, {
        status: e.ok ? "ok" : "failed",
        endedAt: Number(e.ts) || null,
        lastSeq: seq,
        currentStep: null,
        // 没跑到的步骤标 skipped（§5.2 的第六态），避免界面把它们一直显示成 pending
        steps: s.steps.map((v) =>
          v.state === "pending" ? { ...v, state: "skipped" as StepState } : v,
        ),
      });
    }

    case "run/cancel": {
      return patch(s, {
        status: "cancelled",
        endedAt: Number(e.ts) || null,
        lastSeq: seq,
        currentStep: null,
        steps: s.steps.map((v) =>
          v.state === "running" || v.state === "pending"
            ? { ...v, state: "cancelled" as StepState }
            : v,
        ),
      });
    }

    // 服务端因背压丢弃了活动事件（§3.2 / §17.3）。**必须归约**，否则这条
    // 契约事件在界面上不存在 —— 那正是"静默丢事件"本身：
    // 服务端已经如实报告了损失，界面却一个像素都没变。
    // `Math.max` 而非赋值：服务端在同一 episode 内会就地刷新计数，
    // 乱序/重复到达时也不能让计数回退。
    case "stream/overrun": {
      const d = e as Record<string, unknown>;
      const dropped = Number(d.dropped || 0);
      const scope = String(d.topic_scope || "");
      return patch(s, {
        lastSeq: seq > s.lastSeq ? seq : s.lastSeq,
        overrun: Math.max(s.overrun, dropped),
        overrunScope: scope || s.overrunScope,
      });
    }

    default:
      return s;
  }
}

/** 单条事件入口（SSE 与回放共用）。无变化则不通知订阅者。 */
export function applyEvent(e: ElabEvent): void {
  const next = reduce(snapshot, e);
  if (next !== snapshot) {
    snapshot = next;
    emit();
  }
}

/** 批量入口：一次通知，避免 N 条事件触发 N 次渲染。 */
export function applyEvents(list: ElabEvent[]): void {
  let next = snapshot;
  for (const e of list) next = reduce(next, e);
  if (next !== snapshot) {
    snapshot = next;
    emit();
  }
}

export function reset(): void {
  if (snapshot !== IDLE) {
    snapshot = IDLE;
    emit();
  }
}

/** 只读游标 —— SSE 重连时要用它做 `from=`，避免重复推送 */
export function lastSeq(): number {
  return snapshot.lastSeq;
}

/**
 * 服务端宣告"流结束了"，但状态还停在 `running` → 说明**收尾事件缺失**
 * （子进程被硬杀、写盘失败、或事件文件被清理）。
 *
 * ★ 为什么必须兜底：正常路径下 `run/end` 一定先于 `stream/closed` 到达
 *   （事件先落盘，管理器再发 closed），所以这个分支只会在异常时命中。
 *   但如果没有它，界面会**永远**显示"运行中"、取消按钮永远亮着 ——
 *   而实际上进程早就没了。宁可显式判失败，也不留一个假装在跑的界面。
 */
export function markStreamClosed(reason: string): void {
  if (snapshot.status !== "running") return;
  snapshot = patch(snapshot, {
    status: "failed",
    endedAt: Date.now() / 1000,
    currentStep: null,
    steps: snapshot.steps.map((v) =>
      v.state === "running" || v.state === "pending"
        ? { ...v, state: "failed" as StepState, detail: v.detail || `流已关闭（${reason}），未见收尾事件` }
        : v,
    ),
  });
  emit();
}

export function subscribeRun(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getRunSnapshot(): RunSnapshot {
  return snapshot;
}

/** 组件侧读整份快照。快照不可变且引用稳定，故直接返回即可满足 uSES。 */
export function useRun(): RunSnapshot {
  return useSyncExternalStore(subscribeRun, getRunSnapshot, getRunSnapshot);
}
