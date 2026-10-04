import { useEffect, useRef, useState, type ReactNode } from "react";
import s from "./Menu.module.css";

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** 已选项（单选菜单用来画勾） */
  checked?: boolean;
  /** 分组分隔线（该 item 之前画一条） */
  sepBefore?: boolean;
}

export interface MenuProps {
  /** 触发器内容（通常是 <Button/>） */
  trigger: ReactNode;
  items: MenuItem[];
  onSelect: (id: string) => void;
  align?: "left" | "right";
  /** 菜单标题（可选，画在顶部） */
  title?: string;
}

/**
 * 下拉菜单（§15.3）—— 用于"单步▾"与"波特率预设"。
 *
 * 三条易漏的可达性要求都实现了：Esc 关闭、点外部关闭、打开后焦点进菜单。
 */
export function Menu({ trigger, items, onSelect, align = "left", title }: MenuProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // mousedown 而非 click：否则"点菜单项 → 关闭"会与 click 事件顺序打架
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={s.wrap} ref={boxRef}>
      <div
        className={s.trigger}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        role="presentation"
      >
        {trigger}
      </div>
      {open ? (
        <div className={[s.menu, align === "right" ? s.right : s.left].join(" ")} role="menu">
          {title ? <div className={s.title}>{title}</div> : null}
          {items.map((it) => (
            <div key={it.id}>
              {it.sepBefore ? <div className={s.sep} role="separator" /> : null}
              <button
                type="button"
                role="menuitem"
                className={[s.item, it.disabled ? s.disabled : ""].filter(Boolean).join(" ")}
                disabled={it.disabled}
                title={it.hint}
                onClick={() => {
                  setOpen(false);
                  onSelect(it.id);
                }}
              >
                <span className={s.check}>{it.checked ? "✓" : ""}</span>
                <span className={s.itemLabel}>{it.label}</span>
                {it.hint ? <span className={s.itemHint}>{it.hint}</span> : null}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
