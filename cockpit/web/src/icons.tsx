import type { SVGProps } from "react";

/**
 * 内联 SVG 图标（§15.1：不用图标字体、不用 emoji）。
 * 统一 16×16 视框、`currentColor` 描边 —— 颜色由容器决定，图标本身无色值。
 */

type P = SVGProps<SVGSVGElement>;

const base = (p: P): P => ({
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
  ...p,
});

export const IconPlay = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconStop = (p: P) => (
  <svg {...base(p)}>
    <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const IconRun = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2.2a5.8 5.8 0 1 0 5.8 5.8" />
    <path d="M8 5.2V8l2.2 1.4" />
  </svg>
);

export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8" />
    <path d="M13.6 2.6v2.6h-2.6" />
  </svg>
);

export const IconChip = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.4" />
    <path d="M6.4 1.6v1.8M9.6 1.6v1.8M6.4 12.6v1.8M9.6 12.6v1.8M1.6 6.4h1.8M1.6 9.6h1.8M12.6 6.4h1.8M12.6 9.6h1.8" />
  </svg>
);

export const IconFolder = (p: P) => (
  <svg {...base(p)}>
    <path d="M1.8 4.4c0-.7.6-1.2 1.2-1.2h2.6l1.4 1.6h5.8c.7 0 1.2.6 1.2 1.2v5.6c0 .7-.6 1.2-1.2 1.2H3c-.7 0-1.2-.6-1.2-1.2z" />
  </svg>
);

export const IconTerminal = (p: P) => (
  <svg {...base(p)}>
    <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.4" />
    <path d="M4.2 6.4l2 1.8-2 1.8M8.2 10.4h3.4" />
  </svg>
);

export const IconSun = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.3v1.6M8 13.1v1.6M1.3 8h1.6M13.1 8h1.6M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1" />
  </svg>
);

export const IconMoon = (p: P) => (
  <svg {...base(p)}>
    <path d="M13 9.6A5.4 5.4 0 0 1 6.4 3a5.4 5.4 0 1 0 6.6 6.6z" />
  </svg>
);

export const IconMonitor = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.6 6.4h10.8a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" />
    <path d="M4.4 2.6L8 5.6l3.6-3" />
  </svg>
);

export const IconPlug = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 1.8v3M10 1.8v3" />
    <path d="M4.2 4.8h7.6v2.6a3.8 3.8 0 0 1-3.8 3.8A3.8 3.8 0 0 1 4.2 7.4z" />
    <path d="M8 11.2v3" />
  </svg>
);

export const IconWrench = (p: P) => (
  <svg {...base(p)}>
    <path d="M10.6 2.2a3.4 3.4 0 0 0-3 5.4L2.6 12.6l.9.9 5-5a3.4 3.4 0 0 0 4.4-4.2l-1.9 1.9-1.6-.4-.4-1.6z" />
  </svg>
);

export const IconDownload = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2.4v7.2M5 6.8L8 9.8l3-3" />
    <path d="M2.8 12.4h10.4" />
  </svg>
);

export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.8 4.4h10.4M6 4.4V3c0-.5.4-.8.8-.8h2.4c.4 0 .8.3.8.8v1.4" />
    <path d="M4.2 4.4l.6 8.2c0 .6.5 1 1 1h4.4c.6 0 1-.4 1-1l.6-8.2" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="M3.2 8.4l3.2 3.2 6.4-7.2" />
  </svg>
);

export const IconAlert = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2.4l5.8 10.4H2.2z" />
    <path d="M8 6.4v3M8 11.2h.01" />
  </svg>
);

export const IconShield = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 1.8l4.8 1.8v4c0 3-2 5.2-4.8 6.4C5.2 12.8 3.2 10.6 3.2 7.6v-4z" />
    <path d="M5.8 7.8l1.6 1.6 3-3.2" />
  </svg>
);

export const IconChevronDown = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6.2L8 10.2l4-4" />
  </svg>
);

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2l3.2 3.2" />
  </svg>
);
