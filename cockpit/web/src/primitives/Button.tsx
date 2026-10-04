import type { ButtonHTMLAttributes, ReactNode } from "react";
import s from "./Button.module.css";

export type ButtonVariant = "primary" | "ghost" | "outline" | "toolbar" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** 前置图标（内联 SVG —— 本项目不用图标字体、不用 emoji） */
  icon?: ReactNode;
  /** 忙碌态：禁止再次点击，图标位置换成转圈 */
  busy?: boolean;
}

/**
 * 唯一按钮原语（§15.3）。`variant` 决定语义，**不决定颜色** ——
 * 颜色全部来自 tokens.css，换主题时本文件一行都不用改。
 */
export function Button({
  variant = "ghost",
  size = "md",
  icon,
  busy = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = [s.btn, s[variant], s[size], className].filter(Boolean).join(" ");
  return (
    <button {...rest} type={type} className={cls} disabled={disabled || busy} aria-busy={busy}>
      {busy ? <span className={s.spin} aria-hidden="true" /> : icon}
      {children != null && children !== false ? <span className={s.label}>{children}</span> : null}
    </button>
  );
}
