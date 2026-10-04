import type { ReactNode } from "react";
import s from "./TextShimmer.module.css";

export interface TextShimmerProps {
  /** true = 流光扫过（正在跑）；false = 静态文本 */
  active: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * running 态流光文字（§15.3）—— 直接回答"此刻在哪一步"。
 *
 * 实现：文字本身不动，只在上面盖一条半透明渐变带做位移。
 * 用 `background-clip: text` 会让文字在动画中丢清晰度，故改走覆盖层。
 */
export function TextShimmer({ active, children, className }: TextShimmerProps) {
  return (
    <span className={[s.wrap, active ? s.on : "", className].filter(Boolean).join(" ")}>
      {children}
      {active ? <span className={s.sheen} aria-hidden="true" /> : null}
    </span>
  );
}
