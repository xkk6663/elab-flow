/**
 * §5.5 主题令牌映射 —— 全仓唯一允许出现 `--dsw-*` / `--dsh-*` 字面量的文件（§5.5.4 规则 2）。
 *
 * 与原方案的差异（§15.6 记录）：client 半没有 CSS 构建管线，`dsw-map.css` 落为
 * 本文件的模板字符串，由 Client 半在 apply 时注入为
 * `<style data-plugin="dsh-elab-cockpit">`（dsh-m 的 ensureCss 同款机制）。
 * 单一文件意图不变：组件只准引用 `--elab-*`。
 *
 * ANSI 16 色（§5.5.3）：唯一不来自 DSW 的一族，浅/深各一套，从原
 * `cockpit/web/src/theme/tokens.css` 原样迁移。DSH 主题可独立于系统，
 * 所以不用 `prefers-color-scheme`，改由 Client 半把
 * `ctx.theme.getTheme()` 的 colorScheme 写到 `html[data-elab-scheme]`
 * —— 这是全方案唯一的主题订阅点。
 */

/** 深色 ANSI（默认基座；DSH 默认深色，缺失属性时兜底可读） */
const ANSI_DARK = [
  ['black', '#4a4842'],
  ['red', '#ef8b8a'],
  ['green', '#a5d16b'],
  ['yellow', '#f6c667'],
  ['blue', '#7fb4e8'],
  ['magenta', '#d9a0e8'],
  ['cyan', '#6fd3e8'],
  ['white', '#c8c5bc'],
  ['bright-black', '#8e8b83'],
  ['bright-red', '#ff9f9e'],
  ['bright-green', '#c2e58f'],
  ['bright-yellow', '#ffd98a'],
  ['bright-blue', '#a5ccf4'],
  ['bright-magenta', '#eabcf5'],
  ['bright-cyan', '#9ee4f2'],
  ['bright-white', '#f2f0ea'],
] as const;

/** 浅色 ANSI */
const ANSI_LIGHT = [
  ['black', '#3b3b38'],
  ['red', '#c0392b'],
  ['green', '#2e7d32'],
  ['yellow', '#9a6700'],
  ['blue', '#185fa5'],
  ['magenta', '#8e3fa8'],
  ['cyan', '#0e7490'],
  ['white', '#6b6b6b'],
  ['bright-black', '#6b6b6b'],
  ['bright-red', '#e24b4a'],
  ['bright-green', '#4c9a2a'],
  ['bright-yellow', '#b3701a'],
  ['bright-blue', '#378add'],
  ['bright-magenta', '#b060cc'],
  ['bright-cyan', '#0891b2'],
  ['bright-white', '#1a1a1a'],
] as const;

const ansiBlock = (pairs: readonly (readonly [string, string])[]): string =>
  pairs.map(([name, value]) => `  --elab-ansi-${name}: ${value};`).join('\n');

const ansiClasses = (): string =>
  ANSI_DARK.map(([name]) => `.elab-root .a-${name} { color: var(--elab-ansi-${name}); }`).join('\n');

export const DSW_MAP_CSS: string = `\
.elab-root {
  /* 面（§5.5.1） */
  --elab-bg-canvas: var(--dsw-alias-bg-base);
  --elab-bg-surface: var(--dsw-alias-bg-layer-1);
  --elab-bg-raised: var(--dsw-alias-bg-layer-2);
  --elab-bg-overlay: var(--dsw-alias-bg-overlay);
  /* 线 */
  --elab-border: var(--dsw-alias-border-l1);
  --elab-border-strong: var(--dsw-alias-border-l2);
  /* 字 */
  --elab-fg-primary: var(--dsw-alias-label-primary);
  --elab-fg-secondary: var(--dsw-alias-label-secondary);
  --elab-fg-muted: var(--dsw-alias-label-tertiary);
  --elab-fg-faint: var(--dsw-alias-label-caption);
  --elab-fg-dimmed: var(--dsw-alias-label-dimmed);
  /* 态 */
  --elab-status-ok: var(--dsw-alias-state-success-primary);
  --elab-status-fail: var(--dsw-alias-state-error-primary);
  --elab-status-run: var(--dsw-alias-state-warn-primary);
  --elab-status-idle: var(--dsw-alias-state-idle-primary);
  --elab-accent: var(--dsw-alias-brand-primary);
  /* 主按钮专用对（§15.6b 二次修正）：壁纸透明主题下 brand-primary 与反色都近黑，
     任何「品牌填充」方案都会黑块。改为描边强调：文字恒用 label-primary（任意主题可读），
     填充用交互悬停色，描边用 accent —— 视觉强调不再依赖填充与文字的对比。 */
  --elab-btn-primary-bg: var(--dsw-alias-interactive-bg-hover-accent);
  --elab-btn-primary-fg: var(--elab-fg-primary);
  --elab-btn-primary-border: var(--elab-accent);
  /* 字体（宿主无字号令牌，实测其自身 CSS 也用 px —— 字号保留 px，见 §15.6） */
  --elab-font-mono: var(--dsh-font-family-code-default, ui-monospace, Consolas, monospace);
  /* 几何（与主题无关，本地常量，§5.5.3） */
  --elab-space-1: 4px;
  --elab-space-2: 8px;
  --elab-space-3: 12px;
  --elab-radius: 8px;
  /* ANSI 深色（默认基座） */
${ansiBlock(ANSI_DARK)}
}

html[data-elab-scheme="light"] .elab-root {
${ansiBlock(ANSI_LIGHT)}
}

/* ANSI 语义 class（原 LogView.module.css 迁移；色值来自上面的双主题变量） */
.elab-root .a-bold { font-weight: 700; }
${ansiClasses()}
`;

/** 幂等注入令牌映射样式（apply 时调用一次；HMR 重建后由 loader 清旧再注入）。 */
export function ensureThemeStyle(): void {
  if (typeof document === 'undefined') return;
  const existing = document.querySelector('style[data-elab-dsw-map]');
  if (existing !== null) return;
  const el = document.createElement('style');
  el.setAttribute('data-plugin', 'dsh-elab-cockpit');
  el.setAttribute('data-elab-dsw-map', '');
  el.textContent = DSW_MAP_CSS;
  document.head.append(el);
}

/**
 * 把 DSH 当前 colorScheme 写到 `html[data-elab-scheme]`（唯一的主题订阅点）。
 * @param scheme - `theme.getTheme()` 里的 colorScheme；未知值按深色兜底。
 */
export function applyThemeScheme(scheme: unknown): void {
  if (typeof document === 'undefined') return;
  const value = scheme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-elab-scheme', value);
}
