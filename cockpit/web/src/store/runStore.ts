/**
 * runStore —— 域归约的**单例桥**。
 *
 * ★ 纯归约住在 `@elab/cockpit-ui-core/src/run-events.ts`（与 DSH 插件面板同一份）。
 *   本文件只保留**宿主特有**的三件事：
 *   - 模块级单例快照 + 订阅者集合（`useSyncExternalStore` 的可观察源）；
 *   - `applyEvent` / `applyEvents` 入口（SSE 与回放共用）；
 *   - `markStreamClosed` 兜底（把纯函数结果写回单例并通知）。
 *
 * 性质不变（方案 §15.5）：
 *  ① `reduce(snapshot, event)` 是**纯函数** → 可回放出任意时刻的界面；
 *  ② **事件是唯一写入口** → 前端不可能与后端状态漂移；
 *  ③ 快照**不可变**，无变化时 `reduce` 返回**同一个引用** → uSES 不会白重渲染。
 *
 * ★ 日志**不进**本 store（性能关键）：`proc/*` 动辄上万行，
 *   走 `store/logs.ts` 的环形缓冲 + 命令式 DOM 追加。React 只管骨架与状态。
 */

import { useSyncExternalStore } from "react";
import { IDLE, markStreamClosed as markStreamClosedPure, reduce } from "@elab/cockpit-ui-core";
import type { ElabEvent, RunSnapshot, StepView } from "../api/types";

// StageRail 等视图只依赖这里的类型出口；定义在共享层，这里只转发。
export type { RunSnapshot, StepView };

let snapshot: RunSnapshot = IDLE;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
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
  const next = markStreamClosedPure(snapshot, reason);
  if (next === snapshot) return;
  snapshot = next;
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
