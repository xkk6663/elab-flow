/**
 * runStore —— 域归约的**单例桥**（§16 批 1：纯归约已拆到 domain/run.ts）。
 *
 * 本文件只保留：
 *  - 模块级单例快照 + 订阅者集合（useSyncExternalStore 的可观察源）；
 *  - `applyEvent` / `applyEvents` 入口（SSE 与回放共用）；
 *  - `markStreamClosed` 兜底（收尾事件缺失时显式判失败）。
 * 全部归约逻辑在 `domain/run.ts` —— 那里是纯函数，可对任意事件流回放。
 */

import { useSyncExternalStore } from 'react';

import { IDLE, patch, reduce, type RunSnapshot } from '../../../domain/run.ts';
import type { ElabEvent } from '../../../domain/icd.ts';

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
  if (snapshot.status !== 'running') return;
  snapshot = patch(snapshot, {
    status: 'failed',
    endedAt: Date.now() / 1000,
    currentStep: null,
    steps: snapshot.steps.map((v) =>
      v.state === 'running' || v.state === 'pending'
        ? { ...v, state: 'failed' as const, detail: v.detail || `流已关闭（${reason}），未见收尾事件` }
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
