/**
 * 主题 store —— 三态 `light / dark / system`（§15.4 硬规则 4）。
 *
 * ★ 为什么主题不在 layoutStore 里：`index.html` 有一段**首屏前置脚本**必须在
 *   任何绘制之前读出主题（否则会"白闪一下再变黑"）。那段脚本是纯 JS、跑在
 *   bundle 之前，只能读一个固定的 localStorage key，所以这个 key 的读写
 *   必须独立且稳定 —— 这就是本文件存在的唯一理由。
 *
 *   key = `elab.theme`，与 index.html 中的字符串**必须逐字一致**。
 */

import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";

/** ★ 与 cockpit/web/index.html 里的前置脚本共用，改一处必须改两处 */
const KEY = "elab.theme";

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // 隐私模式 / 存储被禁用 —— 静默降级到默认值，不报错
  }
  return "system";
}

let mode: ThemeMode = readStored();
const listeners = new Set<() => void>();

const mq: MediaQueryList | null =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null;

/** 三态 → 实际生效的两态。`data-theme` 只接受 light/dark。 */
export function effectiveTheme(m: ThemeMode = mode): "light" | "dark" {
  if (m !== "system") return m;
  return mq && mq.matches ? "light" : "dark";
}

function apply(): void {
  document.documentElement.setAttribute("data-theme", effectiveTheme());
}

function notify(): void {
  for (const l of listeners) l();
}

export function setTheme(m: ThemeMode): void {
  mode = m;
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* 忽略 */
  }
  apply();
  notify();
}

/** 点一下在 系统 → 亮 → 暗 → 系统 之间循环（顶栏一个按钮即可） */
export function cycleTheme(): void {
  const order: ThemeMode[] = ["system", "light", "dark"];
  setTheme(order[(order.indexOf(mode) + 1) % order.length]);
}

// 跟随系统时，系统主题变了要重挂 data-theme，并通知订阅者换图标
if (mq) {
  const onSys = () => {
    if (mode !== "system") return;
    apply();
    notify();
  };
  // Safari < 14 只有 addListener
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onSys);
  else if (typeof mq.addListener === "function") mq.addListener(onSys);
}

export function subscribeTheme(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 稳定引用（字符串），满足 uSES 的引用相等判断 */
export function getTheme(): ThemeMode {
  return mode;
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getTheme, getTheme);
}
