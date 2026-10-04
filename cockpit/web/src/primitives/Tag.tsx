import type { ReactNode } from "react";
import s from "./Tag.module.css";

export type TagTone = "neutral" | "blue" | "green" | "amber" | "red" | "violet";

export interface TagProps {
  tone?: TagTone;
  /** 等宽（芯片型号、STEP 名、路径片段） */
  mono?: boolean;
  /** 小一号（卡片里的密集标签） */
  dense?: boolean;
  title?: string;
  children: ReactNode;
}

/**
 * 芯片标签 / 形态标签 / `actor` 标注（§15.3）。
 * ★ 只接受语义 tone，不接 CSS 值 —— 换主题时调用方零改动。
 */
export function Tag({ tone = "neutral", mono, dense, title, children }: TagProps) {
  return (
    <span
      title={title}
      className={[s.tag, s[tone], mono ? s.mono : "", dense ? s.dense : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}

/** 圆形计数/短标记，视觉比 Tag 更"贴" */
export function Pill({ tone = "neutral", title, children }: Omit<TagProps, "mono" | "dense">) {
  return (
    <span title={title} className={[s.tag, s[tone], s.pill].join(" ")}>
      {children}
    </span>
  );
}
