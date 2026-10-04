import { useState, type ReactNode } from "react";
import s from "./DisclosureRow.module.css";

export interface DisclosureRowProps {
  /** 折叠时的单行摘要（通常含状态点 + 步骤名 + 用时） */
  header: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** 受控模式；不传即非受控 */
  open?: boolean;
  onToggle?: (next: boolean) => void;
}

/** 阶段账本里的可展开行（§15.3）。键盘可达（原生 button 承载 toggle）。 */
export function DisclosureRow({
  header,
  children,
  defaultOpen = false,
  open,
  onToggle,
}: DisclosureRowProps) {
  const [inner, setInner] = useState(defaultOpen);
  const isOpen = open ?? inner;

  return (
    <div className={[s.row, isOpen ? s.open : ""].filter(Boolean).join(" ")}>
      <button
        type="button"
        className={s.head}
        aria-expanded={isOpen}
        onClick={() => {
          const next = !isOpen;
          if (open === undefined) setInner(next);
          onToggle?.(next);
        }}
      >
        <span className={[s.caret, isOpen ? s.caretOpen : ""].join(" ")} aria-hidden="true" />
        <span className={s.headBody}>{header}</span>
      </button>
      {/* ★ 用 CSS 折叠而非条件渲染：内容里的 <pre> 一旦卸载再挂载会丢滚动位置，
          阶段账本里展开/收起同一个步骤很常见，滚动位置必须留住。 */}
      <div className={s.body} hidden={!isOpen}>
        {children}
      </div>
    </div>
  );
}
