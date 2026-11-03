/**
 * run 域模型 —— 事件流的**纯函数归约**（两侧共用同一份）。
 *
 * 三条不可动摇的性质：
 *  ① `reduce(snapshot, event)` 是**纯函数** → 可以对同一事件流回放出任意时刻的界面；
 *  ② **事件是唯一写入口** → 前端不可能与后端状态漂移（"Model-visible means logged"）；
 *  ③ 快照**不可变**，无变化时 `reduce` 返回**同一个引用** → uSES 的引用相等判断天然正确。
 *
 * ★ 日志**不进**本域（性能关键，方案 §15.5）：`proc/*` 动辄上万行，
 *   走宿主的环形缓冲 + 命令式 DOM 追加。React 只管骨架与状态。
 */

import type { Actor, ElabEvent, StepResult, StepState } from './icd.ts'

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
  status: "idle" | "running" | "ok" | "failed" | "inconclusive" | "cancelled";
  startedAt: number | null;
  endedAt: number | null;
  lastSeq: number;
  currentStep: string | null;
  /** 串口闭环判定（契约 §16；M3-a 起由 `run.py` 的 monitor 分支发射） */
  closedLoop: null | { verdict: string; rule: string; evidence: string };
  /**
   * 服务端背压丢弃计数（`stream/overrun`，契约 §3.2 / §17.3）。
   *
   * ★ 与浏览器侧环形缓冲的 `stats.dropped` **不是一回事**，别混：
   *   - 环形缓冲的 dropped = **浏览器自己**的环形缓冲挤出条数（容量 4000，丢了能重来）；
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

export const IDLE: RunSnapshot = {
  run: null,
  project: '',
  steps: [],
  actor: null,
  status: 'idle',
  startedAt: null,
  endedAt: null,
  lastSeq: 0,
  currentStep: null,
  closedLoop: null,
  overrun: 0,
  overrunScope: '',
  lastBuild: null,
};

/**
 * 服务端宣告"流结束了"，但状态还停在 `running` → 收尾事件缺失
 * （子进程被硬杀、写盘失败、事件文件被清理）。显式判失败，不留假装在跑的界面。
 * （纯函数版；两侧的 run-store 单例外壳与此共用同一语义。）
 */
export function markStreamClosed(s: RunSnapshot, reason: string): RunSnapshot {
  if (s.status !== "running") return s;
  return patch(s, {
    status: "failed",
    endedAt: Date.now() / 1000,
    currentStep: null,
    steps: s.steps.map((v) =>
      v.state === "running" || v.state === "pending"
        ? { ...v, state: "failed" as StepState, detail: v.detail || `流已关闭（${reason}），未见收尾事件` }
        : v,
    ),
  });
}

export function patch(s: RunSnapshot, p: Partial<RunSnapshot>): RunSnapshot {
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
  const topic = String(e.topic || '');
  const seq = Number(e.seq || 0);

  // 活动事件不进状态（日志另走环形缓冲）；stream/closed 只更新游标
  if (topic.startsWith('proc/') || topic.startsWith('serial/')) {
    if (topic === 'serial/closed-loop') {
      const d = e as Record<string, unknown>;
      return patch(s, {
        lastSeq: seq,
        closedLoop: {
          verdict: String(d.verdict || ''),
          rule: String(d.rule || ''),
          evidence: String(d.evidence || ''),
        },
      });
    }
    return seq > s.lastSeq ? patch(s, { lastSeq: seq }) : s;
  }

  switch (topic) {
    case 'run/start': {
      const declared = (e.steps as string[] | undefined) || [];
      return {
        ...IDLE,
        run: String(e.run),
        project: String(e.project || ''),
        actor: (e.actor as Actor) || 'agent',
        status: 'running',
        startedAt: Number(e.ts) || null,
        lastSeq: seq,
        steps: declared.map((id, index) => ({
          id,
          index,
          state: 'pending' as StepState,
          detail: '',
          duration_s: 0,
        })),
      };
    }

    case 'run/step-enter': {
      const id = String(e.step || '');
      const next = setStep(s, id, { state: 'running' });
      return patch(next, { currentStep: id, lastSeq: seq });
    }

    case 'run/step-exit': {
      const id = String(e.step || '');
      const ok = Boolean(e.ok);
      const result = e as unknown as StepResult;
      // ★ 三态：ok=false 才是 failed；ok=true 但 verdict=inconclusive 是"未验证"。
      //   把后者画成绿色 ok，正是"没接串口却显示闭环通过"的界面成因。
      const state: StepState = ok
        ? (String((e as Record<string, unknown>).verdict || '') === 'inconclusive'
            ? 'inconclusive'
            : 'ok')
        : 'failed';
      const next = setStep(s, id, {
        state,
        detail: String(e.detail || ''),
        duration_s: Number(e.duration_s || 0),
        result,
      });
      return patch(next, {
        currentStep: next.currentStep === id ? null : next.currentStep,
        lastSeq: seq,
        lastBuild: id === 'build' ? result : next.lastBuild,
      });
    }

    case 'run/end': {
      // 总账三态（verdict）：failed > inconclusive > ok。旧后端没有 verdict 时
      // 回退到 ok 布尔，行为不变（前向兼容，ICD §7）。
      const verdict = String((e as Record<string, unknown>).verdict || '');
      return patch(s, {
        status: verdict === 'inconclusive' ? 'inconclusive'
          : verdict === 'failed' ? 'failed'
          : e.ok ? 'ok' : 'failed',
        endedAt: Number(e.ts) || null,
        lastSeq: seq,
        currentStep: null,
        // 没跑到的步骤标 skipped（§5.2 的第六态），避免界面把它们一直显示成 pending
        steps: s.steps.map((v) =>
          v.state === 'pending' ? { ...v, state: 'skipped' as StepState } : v,
        ),
      });
    }

    case 'run/cancel': {
      return patch(s, {
        status: 'cancelled',
        endedAt: Number(e.ts) || null,
        lastSeq: seq,
        currentStep: null,
        steps: s.steps.map((v) =>
          v.state === 'running' || v.state === 'pending'
            ? { ...v, state: 'cancelled' as StepState }
            : v,
        ),
      });
    }

    // 服务端因背压丢弃了活动事件（§3.2 / §17.3）。**必须归约**，否则这条
    // 契约事件在界面上不存在 —— 那正是"静默丢事件"本身：
    // 服务端已经如实报告了损失，界面却一个像素都没变。
    // `Math.max` 而非赋值：服务端在同一 episode 内会就地刷新计数，
    // 乱序/重复到达时也不能让计数回退。
    case 'stream/overrun': {
      const d = e as Record<string, unknown>;
      const dropped = Number(d.dropped || 0);
      const scope = String(d.topic_scope || '');
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
