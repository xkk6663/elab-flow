import { useState } from "react";
import s from "./PathLabel.module.css";

export interface PathLabelProps {
  path: string;
  /** 显示用的短名（默认取 basename）；title 里始终给全路径 */
  display?: string;
  /** 尾部补充（字节数等） */
  suffix?: string;
  copyable?: boolean;
  title?: string;
}

/**
 * 产物路径（§15.3）：等宽 + 可复制。
 *
 * ★ 刻意**不做**自动换行：路径断行后 `elf` 和 `Test.elf` 会分两行，
 *   复制时用户会误选到换行符。统一改用"中段省略"。
 */
export function PathLabel({
  path,
  display,
  suffix,
  copyable = true,
  title,
}: PathLabelProps) {
  const [copied, setCopied] = useState(false);
  const short = display ?? path.split(/[\\/]/).pop() ?? path;

  const copy = async () => {
    if (!copyable) return;
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 非安全上下文（http 且非 localhost）下 clipboard 不可用 —— 静默失败即可，
         title 里已有完整路径可手动选中 */
    }
  };

  return (
    <span className={s.wrap}>
      <button
        type="button"
        className={[s.path, copyable ? s.copyable : ""].join(" ")}
        title={title ?? path}
        onClick={copy}
      >
        <span className={s.dir}>{dirOf(path)}</span>
        <span className={s.name}>{short}</span>
      </button>
      {suffix ? <span className={s.suffix}>{suffix}</span> : null}
      {copied ? <span className={s.copied}>已复制</span> : null}
    </span>
  );
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i + 1) : "";
}
