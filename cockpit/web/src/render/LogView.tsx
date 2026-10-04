import { useLayoutEffect, useRef } from "react";
import type { LogLine, LogRing } from "../store/logs";
import { parseAnsi } from "../theme/ansi";
import s from "./LogView.module.css";

/**
 * 日志视图 —— **不进 React 树**（§15.5，风险 K7）。
 *
 * 为什么必须这样：
 *   一次 `ninja` / `idf.py build` 能刷上万行 `proc/*`。若把每行塞进 React 状态，
 *   每次写入都要走一遍 reconciler，即使 `memo` 也顶不住 —— 界面直接卡死。
 *
 * 采取的手段：
 *  ① 数据源是 `LogRing`（普通数组，不是 React 状态）；
 *  ② 行**命令式** append/remove 到 DOM，React 只挂一个空容器；
 *  ③ 一批事件合并进**一次** `requestAnimationFrame`，避免一帧刷 N 次；
 *  ④ DOM 行数**封顶**（MAX_DOM_LINES）。环形缓冲只管内存，不管 DOM 节点数 ——
 *     连续跑十分钟后，4000 个节点 × 每行多个 span 仍会把浏览器拖垮。
 *     触顶后从**头部逐行摘除**（O(掉队行数)），而不是整体重建（O(1500)）。
 */

/** DOM 里最多保留的行数 */
const MAX_DOM_LINES = 1500;

export interface LogViewProps {
  ring: LogRing;
  /** 是否钉在底部（用户往上滚 → 由父级置 false） */
  autoScroll?: boolean;
  onAutoScrollChange?: (next: boolean) => void;
  empty?: string;
  className?: string;
}

function lineEl(l: LogLine): HTMLDivElement {
  const row = document.createElement("div");
  row.className = [
    s.line,
    l.tone === "alert" ? s.alert : "",
    l.tone === "warn" ? s.warn : "",
    l.kind === "marker" ? s.marker : "",
  ]
    .filter(Boolean)
    .join(" ");

  // ★ parseAnsi 只产出「文本 + 语义 class」，且一律赋给 textContent —— 不走 innerHTML。
  //   编译器日志里出现 `<` `>` 是常态，这条是 XSS 红线，不能为了省事改 innerHTML。
  const spans = parseAnsi(l.raw);
  if (spans.length === 0) {
    row.textContent = l.raw;
    return row;
  }
  for (const sp of spans) {
    const el = document.createElement("span");
    el.textContent = sp.text;
    if (sp.cls) {
      el.className = sp.cls
        .split(" ")
        .map((c) => s[c] ?? c)
        .join(" ");
    }
    row.appendChild(el);
  }
  return row;
}

export function LogView({
  ring,
  autoScroll = true,
  onAutoScrollChange,
  empty = "（暂无输出）",
  className,
}: LogViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  /** 快照中，DOM 首行对应的下标 */
  const baseRef = useRef(0);
  /** DOM 中的日志行数（不含"已省略"提示行） */
  const countRef = useRef(0);
  const droppedRef = useRef(ring.dropped);

  useLayoutEffect(() => {
    const host = linesRef.current;
    const scroll = scrollRef.current;
    if (!host || !scroll) return;

    let raf = 0;
    let disposed = false;

    const setEmptyVisible = (visible: boolean) => {
      const cur = host.querySelector<HTMLElement>(`.${s.empty}`);
      if (visible && !cur) {
        const d = document.createElement("div");
        d.className = s.empty;
        d.textContent = empty;
        host.appendChild(d);
      } else if (!visible && cur) {
        cur.remove();
      }
    };

    const rebuild = (snap: LogLine[], from: number) => {
      host.textContent = "";
      baseRef.current = from;
      countRef.current = snap.length - from;
      const frag = document.createDocumentFragment();
      if (from > 0) {
        const omit = document.createElement("div");
        omit.className = s.omit;
        omit.dataset.omit = "1";
        omit.textContent = `··· 已省略前 ${from} 行（DOM 仅保留最近 ${MAX_DOM_LINES} 行）`;
        frag.appendChild(omit);
      }
      for (let i = from; i < snap.length; i++) frag.appendChild(lineEl(snap[i]));
      host.appendChild(frag);
      setEmptyVisible(snap.length === 0);
    };

    const flush = () => {
      raf = 0;
      if (disposed) return;
      const snap = ring.snapshot();
      const total = snap.length;
      const trimmed = ring.dropped;
      /** DOM 当前"以为"自己覆盖到快照的哪个下标（首行下标 + 行数） */
      const domNext = baseRef.current + countRef.current;

      // 三种情况都必须整体重建：
      //  ① 环形缓冲被裁（trimmed 变了）—— 快照头部已经和 DOM 对不上；
      //  ② baseRef 越过快照长度 —— 同上，指针失效；
      //  ③ **快照比 DOM 记录的还短** —— 即 `ring.clear()` 被调过。
      //     ★ ③ 是实测发现的缺陷：切工程 / 再跑一次都会 `logs.clearAll()`，
      //       而"清空"并不改变 `trimmed`（仍是 0），也不满足 `base > total`
      //       （0 > 0 为假）→ 既不重建、也不追加 → **旧 run 的日志行原地不动**，
      //       新 run 的行还要等 `total` 超过旧的行数才肯出现（`total > next`），
      //       于是"跑新 run 看到的全是上一次的输出"。症状极具迷惑性。
      if (trimmed !== droppedRef.current || baseRef.current > total || total < domNext) {
        droppedRef.current = trimmed;
        rebuild(snap, Math.max(0, total - MAX_DOM_LINES));
      } else {
        const wantBase = Math.max(0, total - MAX_DOM_LINES);
        if (wantBase > baseRef.current) {
          // 先把上一次留下的"已省略"提示摘掉，避免每帧叠一条
          host.querySelector<HTMLElement>(`.${s.omit}`)?.remove();
          // 触顶：从头部逐行摘除（快，且与环形缓冲同向，不会来回抖）
          const drop = wantBase - baseRef.current;
          let removed = 0;
          while (removed < drop && host.firstChild) {
            host.removeChild(host.firstChild);
            removed++;
          }
          baseRef.current = wantBase;
          countRef.current = Math.max(0, countRef.current - removed);
          // 顶部省略提示的计数要跟着涨
          const omit = document.createElement("div");
          omit.className = s.omit;
          omit.dataset.omit = "1";
          omit.textContent = `··· 已省略前 ${wantBase} 行（DOM 仅保留最近 ${MAX_DOM_LINES} 行）`;
          host.insertBefore(omit, host.firstChild);
        }

        const next = baseRef.current + countRef.current;
        if (total > next) {
          const frag = document.createDocumentFragment();
          for (let i = next; i < total; i++) frag.appendChild(lineEl(snap[i]));
          host.appendChild(frag);
          countRef.current = total - baseRef.current;
        }
      }

      // ★ 每条路径末尾都要重新裁定"空态占位"。
      //   为什么不能只在 `rebuild()` 里裁：`.empty` 是 `position:absolute; inset:0`
      //   的**覆盖层**，而"首屏空 → 随后增量追加"走的是本函数的 else 分支，
      //   从不经过 rebuild。漏掉这一句的真实症状：首次运行后，
      //   "尚无构建输出。"这行字会一直**浮在 36 行真实日志正中央**，
      //   只有切走再切回（触发整体 rebuild）才会消失。实测就是这么发现的。
      setEmptyVisible(total === 0);

      if (autoScroll) scroll.scrollTop = scroll.scrollHeight;
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(flush);
    };

    // 首屏：浏览器绘制前就把已有行灌进去（切换 Tab 回来时不会闪一帧空白）
    rebuild(ring.snapshot(), Math.max(0, ring.snapshot().length - MAX_DOM_LINES));
    if (autoScroll) scroll.scrollTop = scroll.scrollHeight;

    const unsub = ring.subscribe(schedule);

    // 用户往上滚 → 关掉跟随；滚回底部 → 自动重新跟随。
    // ★ 阈值 24px 是刻意的：subpixel 高度下 `scrollTop + clientHeight` 与
    //   `scrollHeight` 常差 0.x，用 `===` 判断"到底"会永远为 false。
    const onScroll = () => {
      if (!onAutoScrollChange) return;
      const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 24;
      onAutoScrollChange(atBottom);
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      unsub();
      scroll.removeEventListener("scroll", onScroll);
    };
  }, [ring, autoScroll, onAutoScrollChange, empty]);

  return (
    <div className={[s.scroll, className].filter(Boolean).join(" ")} ref={scrollRef}>
      <div className={s.lines} ref={linesRef} />
    </div>
  );
}

/** 把整份日志导成纯文本（R4 的"导出"） */
export function ringToText(ring: LogRing): string {
  return ring
    .snapshot()
    .map((l) => l.plain)
    .join("\n");
}
