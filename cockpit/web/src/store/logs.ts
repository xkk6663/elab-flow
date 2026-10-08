/**
 * 日志环形缓冲 —— **刻意不进 React store**（§15.5）。
 *
 * 为什么：一次编译能刷上万行 `proc/*`。若把这些行塞进 React 状态，
 * 每条事件都会触发一次归约 + 一次渲染协调，界面会直接卡死（风险 K7）。
 * 故：环形缓冲 + 命令式 DOM 追加（见 `render/LogView.tsx`）。
 */

import type { ElabEvent } from "../api/types";
import { lineTone, stripAnsi } from "../theme/ansi";
import { channelOfEvent } from "../workspaces";

/**
 * 日志通道名 = 工作区 id（"build" | "flash" | "serial" | "tools"）。
 * 通道不再枚举 —— 所有工具共用一个 "tools" 通道（二次收敛，2026-10-08；
 * 第一版每工具一通道已被 7-Tab 溢出证伪），通道由 LogBook.ring() 工厂
 * 按需创建，"加通道改 6 处"的结构病就此消灭。
 */
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

/**
 * 事件 → 日志通道。规则唯一来源在 `workspaces.ts#channelOfEvent`
 * （含 doctor 归"构建"、flash/debug_verify 归"烧录"、monitor 归"串口"、
 * tool:<name> 统一归 "tools" 通道的完整理由）。
 */
export function tabOfEvent(e: ElabEvent): LogTab | null {
  return channelOfEvent(e);
}

function lineOf(text: string, step: string, kind: LogLine["kind"] = "line"): LogLine {
  return { raw: text, plain: stripAnsi(text), tone: lineTone(text), step, kind };
}

/** 把一条事件展开成若干日志行 */
export function linesOfEvent(e: ElabEvent): { tab: LogTab; lines: LogLine[] } | null {
  const tab = tabOfEvent(e);
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

class LogBook {
  /**
   * 通道 → 环形缓冲。★ **工厂自建**（ring()），不再逐个声明属性 ——
   * 旧版固定 build/flash/serial/ota 四个属性，加通道漏注册 ring 就
   * undefined.push 崩掉整棵 React 树（白屏，f411 实测）。工具通道是
   * 动态的（projects/*.yaml tools: 节），Map + 工厂从结构上消灭这类事故。
   */
  private rings = new Map<string, LogRing>();
  /** book 级订阅：任何通道有变化（新行/清空/新通道诞生）都通知 —— 导航徽标用 */
  private anySubs = new Set<() => void>();

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

  push(ev: ElabEvent): void {
    const r = linesOfEvent(ev);
    if (r) this.ring(r.tab).push(r.lines);
  }

  clearAll(): void {
    for (const r of this.rings.values()) r.clear();
    for (const fn of this.anySubs) fn();
  }

  /**
   * 本地合成一行 —— **不是**来自事件流，服务端没有它的留档。
   *
   * ★ 目前唯一使用者是串口手写通道（M3-b）：用户敲的命令与设备回显都
   *   发生在"一次 HTTP 请求"里，**不属于任何 run**（写通道与 monitor 天然
   *   互斥），因此没有可挂的 run 上下文、也就没有对应事件。
   *   代价必须在界面上诚实体现：这些行**不能**靠重载页面恢复（而事件行可以）。
   *   故 step 标为 `"manual"`，与事件行可区分。
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
   * 回填**服务端留档**（M3-b2）—— 与 `local()` 的唯一区别是**来源**，而这区别必须
   * 让人看得见，故 step 标为 `"history"`：
   *
   *   `manual`   本机刚敲的，**服务端那份里也有一条**（同一件事的两种视图）
   *   `history`  从服务端 console 日志读回来的，**重载不丢**（但会被滚动淘汰）
   *
   * ★ 一次性整批 push（而不是逐行）：回填几十行时只触发**一次**订阅通知，
   *   省掉几十次 `LogView` 的追加调度 —— 与 `push()` 里那条"别每帧全扫缓冲"的
   *   理由同源。
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

export const logs = new LogBook();
