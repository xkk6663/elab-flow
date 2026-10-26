/**
 * P0 宽度探针 —— 纯 React，挂在真实的 `sidebar.right.pane.tab` 上。
 *
 * 为什么不用 iframe（方案已修正，2026-10-26）：
 *   `practices.md` 明令 "Do not serve an HTML page from the Host and embed it
 *   in an iframe: an iframe document does not receive the host's theme tokens,
 *   light/dark switching, or ctx.locale"。用户要求 UI 必须跟随 DSH 主题，
 *   iframe 原理上做不到，故探针改为在宿主 React 树里直接渲染。
 *
 * 这个文件的生命周期很短：只用来回答 §5.4 的三个问题
 *   Q1 右栏默认宽度是多少？
 *   Q2 可拖拽范围（最窄/最宽）？
 *   Q3 在那个宽度下，阶梯行 + 控制条 + 日志尾还能放下吗？
 * 量完把读数回填文档，然后删除本文件（`P0_PROBE.md` 记结论）。
 */

/** 探针测量的档位边界（px）—— 用于自动判定处在哪一档。 */
const BREAKPOINTS = [
  { min: 0, max: 420, label: '窄单列' },
  { min: 420, max: 700, label: '宽单列' },
  { min: 700, max: 100000, label: '双栏' },
]

function tierOf(width: number): string {
  for (const b of BREAKPOINTS) {
    if (width >= b.min && width < b.max) return b.label
  }
  return '?'
}

/**
 * 探针组件。展示：
 *   - 实时宽高（ResizeObserver）
 *   - 所在档位
 *   - 一条 28px 高的"阶梯行"样本、一条 36px 高的"控制条"样本，用来目测是否拥挤
 *   - 一段 120px 的"日志尾"样本
 */
export function createProbeComponent(React: typeof import('react')) {
  const h = React.createElement

  return function CockpitWidthProbe() {
    const [size, setSize] = React.useState({ w: 0, h: 0 })
    const [ticks, setTicks] = React.useState(0)
    const boxRef = React.useRef(null)

    React.useEffect(() => {
      const el = boxRef.current
      if (el === null) return undefined
      const ro = new ResizeObserver((entries) => {
        const r = entries[0] && entries[0].contentRect
        if (r !== undefined && r !== null) {
          setSize({ w: Math.round(r.width), h: Math.round(r.height) })
        }
      })
      ro.observe(el)
      return () => ro.disconnect()
    }, [])

    React.useEffect(() => {
      const t = setInterval(() => setTicks((v: number) => v + 1), 1000)
      return () => clearInterval(t)
    }, [])

    const mono = 'ui-monospace, Consolas, "Cascadia Mono", monospace'
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      height: '28px',
      padding: '0 8px',
      fontSize: '12px',
      borderBottom: '1px solid var(--elab-border)',
      color: 'var(--elab-fg-primary)',
    }
    const dimStyle = { color: 'var(--elab-fg-muted)', fontSize: '11px' }

    return h(
      'div',
      {
        ref: boxRef,
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          background: 'var(--elab-bg-canvas)',
          color: 'var(--elab-fg-primary)',
        },
      },
      // ── 读数条 ──
      h(
        'div',
        {
          style: {
            display: 'flex',
            gap: '10px',
            padding: '3px 8px',
            fontSize: '11px',
            fontFamily: mono,
            background: 'var(--elab-bg-raised)',
            color: 'var(--elab-fg-secondary)',
            borderBottom: '1px solid var(--elab-border)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          },
        },
        h('strong', { style: { color: 'var(--elab-accent)' } }, 'P0 探针'),
        h('span', null, 'w=' + size.w),
        h('span', null, 'h=' + size.h),
        h('span', null, tierOf(size.w)),
        h('span', { style: { marginLeft: 'auto' } }, ticks + 's'),
      ),
      // ── 阶梯样本（3 行） ──
      h(
        'div',
        { style: { flex: '0 0 auto' } },
        ...[
          ['●', '编译', 'ok', '4.80s'],
          ['◐', '烧录', 'running', '2.10s'],
          ['○', '调试校验', 'pending', ''],
        ].map(([dot, name, state, dur]) =>
          h(
            'div',
            { key: name, style: rowStyle },
            h('span', { style: { color: 'var(--elab-status-ok)' } }, dot),
            h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
            h('span', { style: dimStyle }, state),
            h('span', { style: { ...dimStyle, fontFamily: mono } }, dur),
          ),
        ),
      ),
      // ── 控制条样本 ──
      h(
        'div',
        {
          style: {
            display: 'flex',
            gap: '6px',
            padding: '6px 8px',
            borderBottom: '1px solid var(--elab-border)',
            overflow: 'hidden',
          },
        },
        ...['▶闭环', '▶▶三连', '▶编译', '■取消'].map((label) =>
          h(
            'span',
            {
              key: label,
              style: {
                padding: '3px 8px',
                fontSize: '11px',
                borderRadius: '6px',
                background: 'var(--elab-bg-surface)',
                border: '1px solid var(--elab-border)',
                color: 'var(--elab-fg-secondary)',
                whiteSpace: 'nowrap',
              },
            },
            label,
          ),
        ),
      ),
      // ── 日志尾样本（吃掉剩余高度） ──
      h(
        'div',
        {
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            overflow: 'hidden',
            padding: '6px 8px',
            fontFamily: mono,
            fontSize: '11px',
            lineHeight: '16px',
            background: 'var(--elab-bg-raised)',
            color: 'var(--elab-fg-secondary)',
          },
        },
        h('div', null, '[1/28] Building C object …/sysmem.c.obj'),
        h('div', null, '[2/28] Building C object …/at32f421_int.c.obj'),
        h('div', null, '[28/28] Linking C executable TEST.elf'),
        h('div', { style: dimStyle }, 'FLASH 7.39% · RAM 9.62%'),
      ),
    )
  }
}
