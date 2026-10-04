import type { ReactNode } from "react";
import s from "./Tooltip.module.css";

export interface TooltipProps {
  tip: ReactNode;
  side?: "top" | "bottom";
  children: ReactNode;
}

/**
 * 纯 CSS 提示（§15.3）—— 零 JS、零定位库。
 *
 * 取舍：不跟随鼠标、不做视口翻转。对"工具栏按钮的短说明"足够；
 * 需要富内容时用 `title` 或直接写进面板，而不是把 Tooltip 做重。
 */
export function Tooltip({ tip, side = "top", children }: TooltipProps) {
  return (
    <span className={[s.wrap, side === "bottom" ? s.bottom : s.top].join(" ")}>
      {children}
      <span className={s.bubble} role="tooltip">
        {tip}
      </span>
    </span>
  );
}
