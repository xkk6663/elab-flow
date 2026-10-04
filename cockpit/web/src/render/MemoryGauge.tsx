import type { MemoryRegion } from "../api/types";
import s from "./MemoryGauge.module.css";

/** 占位紧张度阈值 —— 和链接器自己的告警口径尽量一致 */
function tone(pct: number): "ok" | "warn" | "full" {
  if (pct >= 90) return "full";
  if (pct >= 75) return "warn";
  return "ok";
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(2) + " KB";
  return n + " B";
}

export interface MemoryGaugeProps {
  memory: Record<string, MemoryRegion>;
  /**
   * 数据来源。`"linker"` = 链接器 `--print-memory-usage` 自报；
   * `"map"` = 本次未 relink，由 elab 从 `.map` 反推（N6 的副产品）。
   * ★ 必须显式展示：两种来源可信度不同，用户有权知道数字是怎么来的。
   */
  source?: string;
  compact?: boolean;
}

/** 内存占位表盘（§15.7 / R2）。数据完全来自 build 步骤的 `run/step-exit.memory`。 */
export function MemoryGauge({ memory, source, compact }: MemoryGaugeProps) {
  const regions = Object.keys(memory || {});
  if (regions.length === 0) {
    return <div className={s.none}>无内存数据（尚未编译，或链接器未输出占用表）</div>;
  }
  return (
    <div className={[s.wrap, compact ? s.compact : ""].filter(Boolean).join(" ")}>
      {regions.map((name) => {
        const r = memory[name];
        const pct = Number.isFinite(r.pct) ? r.pct : 0;
        const t = tone(pct);
        return (
          <div className={s.row} key={name}>
            <span className={s.name} title={`${name}  ${fmtBytes(r.used)} / ${fmtBytes(r.region)}`}>
              {name}
            </span>
            <span className={s.bar} role="img" aria-label={`${name} 占用 ${pct.toFixed(2)}%`}>
              <span className={`${s.fill} ${s[t]}`} style={{ width: `${Math.min(100, pct)}%` }} />
            </span>
            <span className={s.num}>
              {pct.toFixed(2)}%
              <i className={s.dim}>
                {" "}
                / {fmtBytes(r.used)}
              </i>
            </span>
          </div>
        );
      })}
      {source === "map" ? (
        <div className={s.prov}>
          数据取自 .map（本次未重新链接）
        </div>
      ) : null}
    </div>
  );
}
