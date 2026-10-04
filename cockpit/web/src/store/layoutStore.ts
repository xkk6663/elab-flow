/**
 * 布局 store —— DSH `ctx.layout` 的同名对应物（§15.2）。
 *
 * 管三件事：**三列宽度、折叠态、当前 Tab**（外加字号缩放）。
 * 全部持久化到 `localStorage["elab.layout"]`，刷新后原样回来。
 *
 * 两条纪律：
 *  ① 宽度一律**钳位**（clamp）。用户把窗口拖到 1200px 再把左列拖到 520px，
 *     若不做钳位，中列会被挤成 0 宽 —— 界面看起来"坏了"，其实是算术溢出。
 *  ② 单列极限值按视口动态算（`maxFor`），而不是硬编码死值。
 */

import { useSyncExternalStore } from "react";
import type { LogTab } from "./logs";

export type RailId = "projects" | "evidence";

export interface LayoutState {
  /** 结构版本号 —— 将来改字段形状时用它做迁移，避免读到旧结构直接崩 */
  v: 1;
  /** 左列宽（px）。中列吃剩余空间，故不存。 */
  projects: number;
  /** 右列宽（px） */
  evidence: number;
  collapsed: { projects: boolean; evidence: boolean };
  tab: LogTab;
  /** 全局字号缩放（§15.4 规则 3），一处控制全部 --elab-fs-* */
  fontScale: number;
}

const KEY = "elab.layout";

const DEFAULT: LayoutState = {
  v: 1,
  projects: 268,
  evidence: 470,
  collapsed: { projects: false, evidence: false },
  tab: "build",
  fontScale: 1,
};

export const LIMITS = {
  projects: { min: 176, max: 480 },
  evidence: { min: 300, max: 900 },
  fontScale: { min: 0.85, max: 1.4 },
} as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 单列允许的最大宽度 = 视口宽 - 另一列 - 中列最小宽度(360) - 拖拽条(2×6)。
 * 这样无论窗口多小，"中列至少 360px"始终成立。
 */
export function maxFor(rail: RailId, s: LayoutState): number {
  const vw = typeof window === "undefined" ? 1440 : window.innerWidth;
  const other = rail === "projects" ? s.evidence : s.projects;
  const otherCollapsed = rail === "projects" ? s.collapsed.evidence : s.collapsed.projects;
  const reserve = 360 + 12 + (otherCollapsed ? 0 : other);
  return Math.max(LIMITS[rail].min, Math.min(LIMITS[rail].max, vw - reserve));
}

function sanitize(raw: unknown): LayoutState {
  if (!raw || typeof raw !== "object") return { ...DEFAULT };
  const o = raw as Partial<LayoutState> & { collapsed?: Partial<LayoutState["collapsed"]> };
  if (o.v !== 1) return { ...DEFAULT };
  const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
  const bool = (x: unknown, d: boolean) => (typeof x === "boolean" ? x : d);
  const tab: LogTab =
    o.tab === "build" || o.tab === "flash" || o.tab === "serial" ? o.tab : DEFAULT.tab;
  return {
    v: 1,
    projects: clamp(num(o.projects, DEFAULT.projects), LIMITS.projects.min, LIMITS.projects.max),
    evidence: clamp(num(o.evidence, DEFAULT.evidence), LIMITS.evidence.min, LIMITS.evidence.max),
    collapsed: {
      projects: bool(o.collapsed?.projects, false),
      evidence: bool(o.collapsed?.evidence, false),
    },
    tab,
    fontScale: clamp(num(o.fontScale, 1), LIMITS.fontScale.min, LIMITS.fontScale.max),
  };
}

function load(): LayoutState {
  try {
    const s = localStorage.getItem(KEY);
    return s ? sanitize(JSON.parse(s)) : { ...DEFAULT };
  } catch {
    return { ...DEFAULT };
  }
}

let state: LayoutState = load();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 忽略 */
  }
}

/** 字号缩放走 CSS 变量，不改任何组件代码（§15.4 规则 3） */
function applyFontScale(): void {
  document.documentElement.style.setProperty("--elab-font-scale", String(state.fontScale));
}

function commit(next: LayoutState): void {
  if (next === state) return;
  state = next;
  persist();
  applyFontScale();
  for (const l of listeners) l();
}

// 首屏：把持久化的字号挂上去（index.html 只管主题，不管字号）
applyFontScale();

export function setWidth(rail: RailId, px: number): void {
  const v = clamp(Math.round(px), LIMITS[rail].min, maxFor(rail, state));
  if (state[rail] === v) return;
  commit({ ...state, [rail]: v });
}

export function toggleRail(rail: RailId): void {
  commit({ ...state, collapsed: { ...state.collapsed, [rail]: !state.collapsed[rail] } });
}

export function setTab(tab: LogTab): void {
  if (state.tab === tab) return;
  commit({ ...state, tab });
}

export function setFontScale(n: number): void {
  const v = clamp(Math.round(n * 100) / 100, LIMITS.fontScale.min, LIMITS.fontScale.max);
  if (state.fontScale === v) return;
  commit({ ...state, fontScale: v });
}

export function resetLayout(): void {
  commit({ ...DEFAULT, fontScale: state.fontScale });
}

export function subscribeLayout(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 返回稳定引用（只有 commit 时换新对象），满足 uSES */
export function getLayout(): LayoutState {
  return state;
}

export function useLayout(): LayoutState {
  return useSyncExternalStore(subscribeLayout, getLayout, getLayout);
}
