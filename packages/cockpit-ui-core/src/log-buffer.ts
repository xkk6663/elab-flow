/**
 * 有界日志环形缓冲 —— **刻意不进 React store**（一次编译能刷上万行）。
 *
 * 共享层纪律：纯逻辑，零 React、零 I/O。两处**属于宿主**的差异由调用方注入：
 *   - 事件 → 通道的归类规则（web 把 debug_verify 并进 flash；插件拆出 debug）；
 *   - 颜色/语气词表在 `ansi.ts`（语义 class，色值由宿主主题决定）。
 */

import { lineTone, stripAnsi } from "./ansi.ts";

/**
 * 事件的最小结构 —— core 不依赖任一宿主的事件类型。
 * 两侧的 `ElabEvent`（带 `[k: string]: unknown`）都结构化满足它。
 */
export interface LogEvent {
  topic?: unknown;
  step?: unknown;
  line?: unknown;
  lines?: unknown;
  ok?: unknown;
  detail?: unknown;
  duration_s?: unknown;
}

/** 事件 → 通道名。null = 不属于任何日志通道（如 run/start、心跳类）。 */
export type ChannelResolver<E extends LogEvent = LogEvent> = (e: E) => string | null;

export type LogChannel = string;

/** ★ 兼容别名：旧的持久化布局里叫 LogTab，语义已升级为通道 */
export type LogTab = LogChannel;

export interface LogLine {
  /** 原始文本（可能含 ANSI） */
  raw: string;
  /** 纯文本（用于搜索/计数/工具提示） */
  plain: string;
  tone: "alert" | "warn" | "normal";
  /** 步骤归属，便于将来按步过滤 */
  step: string;
  kind: "line" | "marker";
}

function lineOf(text: string, step: string, kind: LogLine["kind"] = "line"): LogLine {
  return { raw: text, plain: stripAnsi(text), tone: lineTone(text), step, kind };
}

/** 把一条事件展开成若干日志行 */
export function linesOfEvent<E extends LogEvent>(
  e: E,
  channelOf: ChannelResolver<E>,
): { tab: LogTab; lines: LogLine[] } | null {
  const tab = channelOf(e);
  if (!tab) return null;
  const topic = String(e.topic || "");
  const step = String(e.step || "");

  if (topic === "proc/stdout-batch") {
    const arr = (e.lines as string[] | undefined) || [];
    return { tab, lines: arr.map((t) => lineOf(t, step)) };
  }
  if (topic === "proc/stdout" || topic === "proc/stderr") {
    return { tab, lines: [lineOf(String(e.line ?? ""), step)] };
  }
  if (topic === "serial/line") {
    return { tab, lines: [lineOf(String(e.line ?? ""), "monitor")] };
  }
  if (topic === "run/step-enter") {
    return { tab, lines: [lineOf(`▶ 进入步骤 ${step}`, step, "marker")] };
  }
  if (topic === "run/step-exit") {
    const mark = e.ok ? "✓" : "✗";
    const d = String(e.detail || "");
    const dur = Number(e.duration_s || 0);
    return {
      tab,
      lines: [
        lineOf(`  ${mark} 退出步骤 ${step}  用时 ${dur.toFixed(2)}s${d ? "  " + d : ""}`,
               step, "marker"),
      ],
    };
  }
  return null;
}

export class LogRing {
  readonly capacity: number;
  private buf: LogLine[] = [];
  private trimmed = 0;
  /** ★ 增量计数，而不是每次遍历整个缓冲。
   *  证据轨的 Tab 徽标要显示"行数 / 告警数"，若每帧都 `snapshot()` 全扫一遍，
   *  4000 行 × 3 个 Tab × 60fps ≈ 72 万次/秒 —— 白白烧 CPU。改为在 push/裁剪
   *  时顺带累加，取值变 O(1)。 */
  private alertCount = 0;
  private subs = new Set<() => void>();

  constructor(capacity = 4000) {
    this.capacity = capacity;
  }

  push(lines: LogLine[]): void {
    if (!lines.length) return;
    for (const l of lines) if (l.tone === "alert") this.alertCount++;
    this.buf.push(...lines);
    if (this.buf.length > this.capacity) {
      const over = this.buf.length - this.capacity;
      for (let i = 0; i < over; i++) {
        if (this.buf[i].tone === "alert") this.alertCount--;
      }
      this.buf.splice(0, over);
      this.trimmed += over;
    }
    for (const l of this.subs) l();
  }

  /** 已因超容量被丢弃的行数（UI 要如实告诉用户"日志已截断"，不能假装完整） */
  get dropped(): number {
    return this.trimmed;
  }

  /** O(1) 统计。UI 徽标只读这里，不扫 buf。 */
  get stats(): { lines: number; alerts: number; dropped: number } {
    return { lines: this.buf.length, alerts: this.alertCount, dropped: this.trimmed };
  }

  snapshot(): LogLine[] {
    return this.buf;
  }

  clear(): void {
    this.buf = [];
    this.trimmed = 0;
    this.alertCount = 0;
    for (const l of this.subs) l();
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

export class LogBook<E extends LogEvent = LogEvent> {
  /**
   * 通道 → 环形缓冲。★ **工厂自建**（ring()），不再逐个声明属性 ——
   * 旧版固定 build/flash/serial/ota 四个属性，加通道漏注册 ring 就
   * undefined.push 崩掉整棵 React 树（白屏）。工具通道是动态的
   * （projects/*.yaml tools: 节），Map + 工厂从结构上消灭这类事故。
   */
  private rings = new Map<string, LogRing>();
  /** book 级订阅：任何通道有变化（新行/清空/新通道诞生）都通知 —— 导航徽标用 */
  private anySubs = new Set<() => void>();
  private readonly channelOf: ChannelResolver<E>;

  /** 构造时注入宿主自己的"事件 → 通道"规则（core 不自带业务归类）。 */
  constructor(channelOf: ChannelResolver<E>) {
    this.channelOf = channelOf;
  }

  /** 取（或惰性创建）一个通道的环形缓冲。永不返回 undefined。 */
  ring(channel: LogChannel): LogRing {
    let r = this.rings.get(channel);
    if (!r) {
      r = new LogRing();
      this.rings.set(channel, r);
      // 新通道诞生也要惊动 book 级订阅者（导航徽标从 0 变有）
      for (const fn of this.anySubs) fn();
    }
    return r;
  }

  /** ★ 兼容别名（旧调用点 logs.for(tab)） */
  for(tab: LogChannel): LogRing {
    return this.ring(tab);
  }

  /** 当前所有通道名（导航徽标/全量清空用） */
  channels(): LogChannel[] {
    return [...this.rings.keys()];
  }

  /** book 级订阅：任何通道有任何变化都触发一次 */
  subscribeAll(fn: () => void): () => void {
    this.anySubs.add(fn);
    return () => this.anySubs.delete(fn);
  }

  push(ev: E): void {
    const r = linesOfEvent(ev, this.channelOf);
    if (r) this.ring(r.tab).push(r.lines);
  }

  clearAll(): void {
    for (const r of this.rings.values()) r.clear();
    for (const fn of this.anySubs) fn();
  }

  /**
   * 本地合成一行 —— **不是**来自事件流，服务端没有它的留档。
   *
   * 代价必须在界面上诚实体现：这些行**不能**靠重载页面恢复（而事件行可以）。
   * 故 step 标为 `"manual"`，与事件行可区分。
   */
  local(tab: LogChannel, text: string, tone?: LogLine["tone"]): void {
    const ln: LogLine = {
      raw: text,
      plain: stripAnsi(text),
      tone: tone ?? lineTone(text),
      step: "manual",
      kind: "line",
    };
    this.ring(tab).push([ln]);
  }

  /**
   * 回填**服务端留档** —— 与 `local()` 的唯一区别是**来源**，而这区别必须
   * 让人看得见，故 step 标为 `"history"`：
   *
   *   `manual`   本机刚敲的，**服务端那份里也有一条**（同一件事的两种视图）
   *   `history`  从服务端 console 日志读回来的，**重载不丢**（但会被滚动淘汰）
   *
   * ★ 一次性整批 push（而不是逐行）：回填几十行时只触发**一次**订阅通知。
   */
  history(tab: LogChannel, items: Array<{ text: string; tone?: LogLine["tone"] }>): void {
    if (!items.length) return;
    this.ring(tab).push(
      items.map((it) => ({
        raw: it.text,
        plain: stripAnsi(it.text),
        tone: it.tone ?? lineTone(it.text),
        step: "history",
        kind: "line" as const,
      })),
    );
  }

  /** 全通道计数（O(通道数)，通道内 O(1)）。导航徽标只读这里。 */
  counts(): Record<string, { lines: number; alerts: number; dropped: number }> {
    const out: Record<string, { lines: number; alerts: number; dropped: number }> = {};
    for (const [k, r] of this.rings) out[k] = r.stats;
    return out;
  }
}

/** 工厂（旧宿主习惯 `new LogBook(...)` 也保留）。 */
export function createLogBook<E extends LogEvent>(channelOf: ChannelResolver<E>): LogBook<E> {
  return new LogBook(channelOf);
}
