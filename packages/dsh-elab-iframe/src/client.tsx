/**
 * dsh-elab-iframe —— Client 半（P0 探针），**已是 DSH 动态 Client 格式**。
 *
 * 格式依据（`references/ui-plugin.md` + `templates/decoration/client.js`）：
 *   - 浏览器侧由 `window.__ModuleLoader__.load({ id, factory })` 注册惰性工厂；
 *   - **React 从模块表 `require('react')` 取**，不用 `globalThis.React`；
 *   - 槽位注册形如 `ctx.slots.inject(slot, () => ctx.slots.register({name, id}, Component))`；
 *   - 工厂保持无副作用，资源在 `apply` 里用 `ctx.effect` 登记清理。
 *
 * 这一步只是"探针"：把一个 iframe 放进右栏 + 一条诊断条。
 * 诊断条的 `w/h` 读数就是 §8.0 的 T1/T2 答案。
 */

const PACKAGE_ID = 'dsh-elab-iframe'
const SLOT = 'sidebar.right.pane.tab'

;(function register() {
  const loader = window.__ModuleLoader__
  if (loader === undefined) {
    // 不在 DSH Web 里（例如被误当普通脚本加载）：静默退出，不刷错误
    return
  }
  loader.load({
    id: PACKAGE_ID,
    factory(require) {
      const React = require('react')
      const h = React.createElement

      /** 拉取 iframe 地址；Host 可能正在拉起 Python，故带重试。 */
      async function fetchProbeUrl() {
        const res = await fetch('/elab-iframe/url', { headers: { Accept: 'application/json' } })
        const text = await res.text()
        try {
          return JSON.parse(text)
        } catch {
          return { ok: false, error: { code: 'bad-json', message: text.slice(0, 200) } }
        }
      }

      function CockpitProbe() {
        const [state, setState] = React.useState({ status: 'loading' })
        const [size, setSize] = React.useState({ w: 0, h: 0 })
        const [ticks, setTicks] = React.useState(0)
        const boxRef = React.useRef(null)

        // ① 取地址（最多 3 次，间隔 800ms）
        React.useEffect(() => {
          let cancelled = false
          let attempt = 0
          const run = async () => {
            attempt += 1
            try {
              const r = await fetchProbeUrl()
              if (cancelled) return
              if (r.ok && typeof r.url === 'string') {
                setState({ status: 'ready', url: r.url, port: r.port })
                return
              }
              if (attempt < 3) {
                setTimeout(run, 800)
                return
              }
              setState({ status: 'error', msg: (r.error && r.error.message) || '未知错误' })
            } catch (e) {
              if (cancelled) return
              if (attempt < 3) {
                setTimeout(run, 800)
                return
              }
              setState({ status: 'error', msg: String((e && e.message) || e) })
            }
          }
          run()
          return () => {
            cancelled = true
          }
        }, [])

        // ② 实测尺寸 —— T1/T2 的全部数据来源
        React.useEffect(() => {
          const el = boxRef.current
          if (el === null) return undefined
          const ro = new ResizeObserver((entries) => {
            const r = entries[0] && entries[0].contentRect
            if (r !== undefined && r !== null) setSize({ w: Math.round(r.width), h: Math.round(r.height) })
          })
          ro.observe(el)
          return () => ro.disconnect()
        }, [])

        // ③ 秒表：验证右栏里的重渲染开销（探针也要能报自己的成本）
        React.useEffect(() => {
          const t = setInterval(() => setTicks((v) => v + 1), 1000)
          return () => clearInterval(t)
        }, [])

        const mono = 'ui-monospace, Consolas, "Cascadia Mono", monospace'
        const diag = h(
          'div',
          {
            style: {
              display: 'flex',
              gap: '10px',
              padding: '2px 8px',
              fontSize: '11px',
              lineHeight: '16px',
              fontFamily: mono,
              opacity: 0.85,
              flex: '0 0 auto',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              color: 'var(--dsw-alias-label-secondary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            },
            title: 'P0 探针诊断：w 就是右栏可用宽度（§5.4 三档阈值的依据）',
          },
          h('span', null, 'port ' + (state.port == null ? '—' : state.port)),
          h('span', null, 'w ' + size.w),
          h('span', null, 'h ' + size.h),
          h('span', null, state.status === 'ready' ? '● live' : '○ ' + state.status),
          h('span', { style: { marginLeft: 'auto' } }, 't ' + ticks + 's'),
        )

        if (state.status === 'error') {
          return h(
            'div',
            { style: { padding: '12px', fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' } },
            h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '驾驶舱探针：内核未就绪'),
            h('div', { style: { opacity: 0.8, wordBreak: 'break-word' } }, state.msg || ''),
            h(
              'div',
              { style: { marginTop: '10px', opacity: 0.7 } },
              '处理：确认 python 在 PATH，且当前会话位于 elab 仓库内（含 elab.host.yaml、cockpit/、services/elab/）。',
            ),
          )
        }

        return h(
          'div',
          { ref: boxRef, style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
          diag,
          h(
            'div',
            { style: { flex: '1 1 auto', minHeight: 0 } },
            state.status === 'ready' && state.url !== undefined
              ? h('iframe', {
                  src: state.url,
                  title: 'elab cockpit',
                  style: { width: '100%', height: '100%', border: 0, display: 'block' },
                })
              : h(
                  'div',
                  { style: { padding: '12px', fontSize: '12px', opacity: 0.7 } },
                  '正在拉起驾驶舱内核…（首次约 300–1500ms）',
                ),
          ),
        )
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          // ★ 用 inject + register 的延迟形式：槽位出现后再登记
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: PACKAGE_ID,
              },
              CockpitProbe,
            ),
          )
        },
      }
    },
  })
})()
