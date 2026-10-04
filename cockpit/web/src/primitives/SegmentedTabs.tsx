import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import s from "./SegmentedTabs.module.css";

export interface SegTab<T extends string> {
  id: T;
  label: string;
  /** 右上角计数（日志行数 / 告警数） */
  badge?: number;
  /** 计数为 0 时是否仍显示 */
  badgeAlways?: boolean;
  tone?: "normal" | "alert";
  /** 不可用（例如串口后端缺失）：仍可点，但视觉降级并给出 title */
  dim?: boolean;
  title?: string;
}

export interface SegmentedTabsProps<T extends string> {
  tabs: Array<SegTab<T>>;
  value: T;
  onChange: (id: T) => void;
  size?: "sm" | "md";
}

/**
 * 证据轨三 Tab 用的分段控件（§15.3）。
 * 用 role=tablist 描述语义，键盘左右键可切换 —— 不依赖鼠标。
 */
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  size = "md",
}: SegmentedTabsProps<T>) {
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === value);
    const d = e.key === "ArrowRight" ? 1 : -1;
    onChange(tabs[(i + d + tabs.length) % tabs.length].id);
  };

  return (
    <div className={[s.wrap, s[size]].join(" ")} role="tablist" onKeyDown={onKey}>
      {tabs.map((t) => {
        const active = t.id === value;
        const showBadge = t.badge != null && (t.badge > 0 || t.badgeAlways);
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={t.title}
            className={[s.tab, active ? s.active : "", t.dim ? s.dim : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {showBadge ? (
              <span
                className={[s.badge, t.tone === "alert" ? s.badgeAlert : ""]
                  .filter(Boolean)
                  .join(" ")}
              >
                {t.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
