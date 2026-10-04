import type { StepState } from "../api/types";
import s from "./StateDot.module.css";

export interface StateDotProps {
  state: StepState;
  /** running 时是否呼吸（§15.3 的 TextShimmer 是文字版，这里是圆点版） */
  breathe?: boolean;
  size?: number;
  title?: string;
}

/**
 * 阶段状态圆点（§15.3）—— 「此刻在哪一步」的第一眼答案。
 *
 * 六态映射（§5.2），每一个都有**形状**差异而不只是颜色差异：
 * running 会呼吸、skipped 是空心、cancelled 带斜杠。色盲用户与灰度截图
 * 也能分辨 —— 这是刻意设计，不是装饰。
 */
export function StateDot({ state, breathe = true, size = 10, title }: StateDotProps) {
  const style = { width: size, height: size, flex: `0 0 ${size}px` };
  const cls = [s.dot, s[state], state === "running" && breathe ? s.breathe : ""]
    .filter(Boolean)
    .join(" ");
  return <span className={cls} style={style} title={title} aria-label={title || state} role="img" />;
}
