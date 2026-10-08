import {
  useCallback,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { maxFor, setWidth, toggleRail, useLayout, type RailId } from "./store/layoutStore";
import { IconExpandRight } from "./icons";
import s from "./AppFrame.module.css";

export interface AppFrameProps {
  header: ReactNode;
  projects: ReactNode;
  stage: ReactNode;
  evidence: ReactNode;
  /** <820px 时顶栏里的工程下拉（工程轨整列隐藏） */
  compactSelector?: ReactNode;
  /** 右侧抽屉的开关（窄屏用） */
  drawerToggle?: ReactNode;
  /** 工程轨折叠后，竖条上显示的当前工程名（让收起状态也不丢上下文） */
  projectsStripLabel?: string;
}

/**
 * 三列 AppFrame + 拖拽条（§15.2，对应 DSH `ui-layout`）。
 *
 * 实现要点：
 *  ① 宽度走 CSS 变量（`--w-projects` / `--w-evidence`）而不是行内 `width`。
 *     行内样式优先级最高，会**压过**窄屏媒体查询 —— 那样响应式降级就失效了。
 *  ② 拖拽用 window 级 pointer 事件 + setPointerCapture：只在拖拽期间挂监听，
 *     松手立刻摘掉。若把监听挂在元素上，快速甩动时鼠标冲出元素会"粘住"。
 *  ③ 拖拽期间给 <body> 打 `data-dragging`，用 CSS 全局禁用文本选择 ——
 *     否则横向拖会顺手选中整页文字（这是三列布局最常见的体验投诉）。
 */
export function AppFrame({
  header,
  projects,
  stage,
  evidence,
  compactSelector,
  drawerToggle,
  projectsStripLabel,
}: AppFrameProps) {
  const layout = useLayout();
  const rootRef = useRef<HTMLDivElement>(null);

  const onDragStart = useCallback(
    (rail: RailId) => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = layout[rail];
      const limit = maxFor(rail, layout);

      const move = (ev: PointerEvent) => {
        // projects：往右拖变宽；evidence：往左拖变宽（它贴右边）
        const raw = rail === "projects" ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX);
        setWidth(rail, Math.min(raw, limit));
      };
      const stop = () => {
        document.body.removeAttribute("data-dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      document.body.setAttribute("data-dragging", "1");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [layout],
  );

  const vars = {
    "--w-projects": `${layout.projects}px`,
    "--w-evidence": `${layout.evidence}px`,
  } as CSSProperties;

  const projCollapsed = layout.collapsed.projects;
  const eviCollapsed = layout.collapsed.evidence;

  return (
    <div className={s.root} ref={rootRef} style={vars}>
      <header className={s.header}>
        {header}
        {compactSelector ? <div className={s.compactSel}>{compactSelector}</div> : null}
      </header>

      <div className={s.frame}>
        {projCollapsed ? (
          <button
            type="button"
            className={[s.col, s.strip, s.stripLeft].join(" ")}
            onClick={() => toggleRail("projects")}
            title="展开工程列（连同芯片信息板）"
            aria-label="展开工程列"
          >
            <IconExpandRight className={s.stripIcon} />
            <span className={s.stripText}>{projectsStripLabel || "工程"}</span>
          </button>
        ) : (
          <>
            <aside className={[s.col, s.left].join(" ")}>{projects}</aside>
            <div
              className={s.handle}
              role="separator"
              aria-orientation="vertical"
              aria-label="调整工程轨宽度"
              onPointerDown={onDragStart("projects")}
              onDoubleClick={() => toggleRail("projects")}
              title="拖动调整宽度；双击折叠"
            />
          </>
        )}

        <main className={s.center}>{stage}</main>

        {eviCollapsed ? (
          <button
            type="button"
            className={[s.col, s.strip, s.stripRight].join(" ")}
            onClick={() => toggleRail("evidence")}
            title="展开证据轨"
          >
            <span className={s.stripText}>证据 · 工具</span>
          </button>
        ) : (
          <>
            <div
              className={s.handle}
              role="separator"
              aria-orientation="vertical"
              aria-label="调整证据轨宽度"
              onPointerDown={onDragStart("evidence")}
              onDoubleClick={() => toggleRail("evidence")}
              title="拖动调整宽度；双击折叠"
            />
            <aside className={[s.col, s.right].join(" ")}>
              {drawerToggle ? <div className={s.drawerBar}>{drawerToggle}</div> : null}
              {evidence}
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
