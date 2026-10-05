/**
 * 日志环形缓冲 —— **刻意不进 React store**（§15.5）。
 *
 * 为什么：一次编译能刷上万行 `proc/*`。若把这些行塞进 React 状态，
 * 每条事件都会触发一次归约 + 一次渲染协调，界面会直接卡死（风险 K7）。
 * 故：环形缓冲 + 命令式 DOM 追加（见 `render/LogView.tsx`）。
 */

import type { ElabEvent } from "../api/types";
import { lineTone, stripAnsi } from "../theme/ansi";

export type LogTab = "build" | "flash" | "serial";

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
 * 事件 → 证据轨的哪个 Tab。这是"三合一 Tab"的**唯一**归属规则。
 *
 * ★ 证据轨刻意只有三个 Tab（构建/烧录/串口，见方案 §5.4），而流水线有五步
 *   （doctor/build/flash/debug_verify/monitor）。所以这里有一条**显式兜底**：
 *     - `flash` / `debug_verify`  → 「烧录」（都是上板相关的）
 *     - `monitor`                 → 「串口」（板子的串口输出）
 *     - **其余一切**（含 `doctor`）→ 「构建」
 *   `doctor` 归到「构建」是**有意的**，不是漏写：体检与编译都是宿主侧、
 *   纯文本、不碰硬件的步骤，共用一个"宿主侧输出"面板比为它单开第四个 Tab
 *   更贴方案。代价是构建 Tab 的行数会包含体检输出 —— 徽标因此读作
 *   "构建 + 体检行数"。若将来要拆开，就在这里加分支，**不必改渲染层**。
 */
export function tabOfEvent(e: ElabEvent): LogTab | null {
  const topic = String(e.topic || "");
  const step = String(e.step || "");
  if (topic.startsWith("serial/")) return "serial";
  if (topic === "proc/stdout" || topic === "proc/stderr" ||
      topic === "proc/stdout-batch") {
    if (step === "flash" || step === "debug_verify") return "flash";
    if (step === "monitor") return "serial";
    return "build";
  }
  if (topic === "run/step-enter" || topic === "run/step-exit") {
    if (step === "flash" || step === "debug_verify") return "flash";
    if (step === "monitor") return "serial";
    return "build";
  }
  return null;
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
  build = new LogRing();
  flash = new LogRing();
  serial = new LogRing();

  for(tab: LogTab): LogRing {
    return this[tab];
  }

  push(ev: ElabEvent): void {
    const r = linesOfEvent(ev);
    if (r) this.for(r.tab).push(r.lines);
  }

  clearAll(): void {
    this.build.clear();
    this.flash.clear();
    this.serial.clear();
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
  local(tab: LogTab, text: string, tone?: LogLine["tone"]): void {
    const ln: LogLine = {
      raw: text,
      plain: stripAnsi(text),
      tone: tone ?? lineTone(text),
      step: "manual",
      kind: "line",
    };
    this.for(tab).push([ln]);
  }

  counts(): Record<LogTab, { lines: number; alerts: number; dropped: number }> {
    return { build: this.build.stats, flash: this.flash.stats, serial: this.serial.stats };
  }
}

export const logs = new LogBook();
