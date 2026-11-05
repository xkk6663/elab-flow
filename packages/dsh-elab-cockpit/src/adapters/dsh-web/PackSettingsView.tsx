/**
 * 芯片适配包设置视图（覆盖整个侧边栏）。
 *
 * 三个页签：
 *  - 市场：**搜索优先**（首屏只有搜索框 + 本机官方源可装项），输入名称/厂商/平台
 *    即向内核 `GET /api/packs?market=1&q=` 搜索市场索引；
 *  - 已安装：本地已装的包（启用 / 校验 / 更新 / 卸载）；
 *  - 内核设置：复用 `SettingsSection`（宿主配置）。
 *
 * 纪律（与业务分层一致 —— 这里的每一条都是**呈现**，不含业务判断）：
 *  - 兼容性、启用语义、sha256、来源解析全部来自内核投影（`PacksStatus`）；
 *    本组件不认识厂商，也不为任何芯片开分支；
 *  - 写操作只发**包名**：install/remove/update 回 202 + job，再 500ms 轮询
 *    `/api/pkg/job`；verify/activate 同步 200；
 *  - 有 job 在跑 = **闭环冻结**（内核 `/api/run` 会 409）——界面必须显式说出这件事，
 *    否则用户只会看到"点运行没反应"；
 *  - 全部颜色走 `--elab-*` 令牌（§5.5.4 门禁）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { elabApi } from '../kernel-http/icd-client.ts'
import type {
  InstalledPack,
  MarketPack,
  PacksStatus,
  PkgJob,
  PkgVerifyResult,
} from '../../domain/icd.ts'
import { SettingsSection } from './SettingsSection.tsx'

type Tab = 'market' | 'installed' | 'kernel'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'market', label: '市场' },
  { id: 'installed', label: '已安装' },
  { id: 'kernel', label: '内核设置' },
]

/** 包操作 job 的中文动作名（market = 首屏遍历 GitHub）。 */
const ACTION_LABEL: Record<string, string> = {
  install: '安装',
  remove: '卸载',
  update: '更新',
  market: '市场遍历',
}

const btn = (primary = false): React.CSSProperties => ({
  padding: '2px 8px',
  fontSize: 'var(--elab-fs-xs)',
  borderRadius: 'var(--elab-radius-sm)',
  border: `1px solid ${primary ? 'var(--elab-btn-primary-border)' : 'var(--elab-border)'}`,
  background: primary ? 'var(--elab-btn-primary-bg)' : 'transparent',
  color: primary ? 'var(--elab-btn-primary-fg)' : 'var(--elab-fg-secondary)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
})

const disabledBtn: React.CSSProperties = { opacity: 0.45, cursor: 'default' }

function Badge(props: { text: string; tone: 'ok' | 'warn' | 'idle' }): ReactNode {
  const color =
    props.tone === 'ok'
      ? 'var(--elab-status-ok)'
      : props.tone === 'warn'
        ? 'var(--elab-status-run)'
        : 'var(--elab-fg-muted)'
  return (
    <span
      style={{
        fontSize: '10px',
        padding: '0 4px',
        borderRadius: '3px',
        background: 'var(--elab-bg-raised)',
        color,
        whiteSpace: 'nowrap',
      }}
    >
      {props.text}
    </span>
  )
}

function PackMeta(props: { pack: InstalledPack | MarketPack }): ReactNode {
  const p = props.pack
  const chips = p.chips ?? []
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginTop: '2px' }}>
      <span style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-muted)' }}>{`v${p.version ?? '?'}`}</span>
      {p.status === 'official' ? <Badge text="官方" tone="ok" /> : null}
      {p.license !== undefined && p.license !== null && p.license !== '' ? (
        <span style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-faint)' }}>{p.license}</span>
      ) : null}
      {chips.length > 0 ? (
        <span
          style={{
            fontSize: 'var(--elab-fs-xs)',
            color: 'var(--elab-fg-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={chips.join('、')}
        >
          {`芯片：${chips.join('、')}`}
        </span>
      ) : null}
    </div>
  )
}

interface PackSettingsViewProps {
  /** 内核 HTTP 客户端（CockpitPane 注入，装配点不在这里重复创建）。 */
  api: typeof elabApi
  sessionId?: string
  /** 关闭设置视图，回到闭环面板。 */
  onBack(): void
  /** 有闭环在跑（内核也会 409 拦，但界面先禁用更清楚）。 */
  runActive: boolean
}

export function PackSettingsView(props: PackSettingsViewProps): ReactNode {
  const { api, sessionId, onBack, runActive } = props

  const [tab, setTab] = useState<Tab>('market')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<PacksStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 正在跑（或刚跑完）的包操作任务。 */
  const [job, setJob] = useState<PkgJob | null>(null)
  /** verify 结果（按包名）。 */
  const [verifies, setVerifies] = useState<Record<string, PkgVerifyResult>>({})
  /** 正在等待的某个同步动作（activate）。 */
  const [pending, setPending] = useState<string | null>(null)

  const jobActive = job !== null && (job.state === 'queued' || job.state === 'running')
  /** 市场遍历只读 GitHub、不改芯片数据 → 不冻结闭环（内核 `/api/run` 侧同样不拦）。 */
  const marketJobActive = jobActive && job !== null && job.action === 'market'
  const frozen = runActive || (jobActive && !marketJobActive)

  const load = useCallback(
    async (q: string, withMarket: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const r = await api.packs({ market: withMarket, q, sessionId })
        setStatus(r)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [api, sessionId],
  )

  // 页签/搜索变化 → 重新拉投影（市场页签才读市场索引：离线/慢网时不拖累已安装页）
  useEffect(() => {
    if (tab !== 'market') {
      void load('', false)
      return
    }
    const t = setTimeout(() => void load(query.trim(), true), 300)
    return () => clearTimeout(t)
  }, [tab, query, load])

  /** 202 → 轮询 job 直到 ok/failed（同一时刻内核只允许一个包操作）。 */
  const watchJob = useCallback((first: PkgJob) => {
    setJob(first)
    setNotice(null)
  }, [])

  /** 轮询结束时要按**当前**页签刷新（effect 里不直接依赖 query/tab，免得多余重跑）。 */
  const refreshArgs = useRef<{ tab: Tab; query: string }>({ tab, query })
  refreshArgs.current = { tab, query }

  // ★ 首次打开市场页签：现场遍历一遍 GitHub 上现有的 elab-pack 仓库（异步 job）。
  //   没有 GITHUB_TOKEN 时可能被限流 → 失败只提示，不阻断：界面继续显示已有索引。
  const crawled = useRef(false)
  useEffect(() => {
    if (tab !== 'market' || crawled.current) return
    crawled.current = true
    void api
      .marketRefresh({ sessionId })
      .then(watchJob)
      .catch((e: unknown) => setError(
        `未能现场遍历 GitHub（${e instanceof Error ? e.message : String(e)}）—— 仍显示最近一次市场索引`))
  }, [tab, api, sessionId, watchJob])

  useEffect(() => {
    if (job === null) return
    if (job.state !== 'queued' && job.state !== 'running') return
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const snap = await api.pkgJob(job.id, sessionId)
          if (cancelled) return
          setJob(snap)
          if (snap.state === 'ok' || snap.state === 'failed') {
            // 操作落盘后投影已变：刷新列表（也拿到新的 active / chips）
            const cur = refreshArgs.current
            void load(cur.tab === 'market' ? cur.query.trim() : '', cur.tab === 'market')
          }
        } catch (e) {
          if (cancelled) return
          setError(e instanceof Error ? e.message : String(e))
          setJob({ ...job, state: 'failed', stage: '轮询失败', error: String(e) })
        }
      })()
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [job, api, sessionId, load])

  const fail = (e: unknown): void => {
    setError(e instanceof Error ? e.message : String(e))
  }

  const doInstall = (name: string, official: boolean): void => {
    setError(null)
    setNotice(null)
    void api
      .pkgInstall({ name, official, sessionId })
      .then(watchJob)
      .catch(fail)
  }

  const doRemove = (name: string): void => {
    setError(null)
    setNotice(null)
    void api.pkgRemove({ name, sessionId }).then(watchJob).catch(fail)
  }

  const doUpdate = (name: string): void => {
    setError(null)
    setNotice(null)
    void api
      .pkgUpdate({ name, sessionId })
      .then((j) => {
        // 已是最新时内核直接返回 job(ok, 无日志)；照样展示结论
        watchJob(j)
      })
      .catch(fail)
  }

  const doVerify = (name: string): void => {
    setError(null)
    void api
      .pkgVerify({ name, sessionId })
      .then((r) => {
        const one = r.results.find((x) => x.name === name) ?? r.results[0]
        if (one !== undefined) setVerifies((cur) => ({ ...cur, [one.name]: one }))
        setNotice(one?.ok === true ? `${name} 校验通过（内容哈希一致）` : `${name} 校验未通过`)
      })
      .catch(fail)
  }

  const doActivate = (name: string): void => {
    setError(null)
    setNotice(null)
    setPending(name)
    void api
      .pkgActivate({ name, sessionId })
      .then((r) => {
        setNotice(`已启用 ${name}（一次只启用一套，其余包仍保留在本地）`)
        const p = (r as { packs?: PacksStatus }).packs
        if (p !== undefined) setStatus(p)
        else void load('', false)
      })
      .catch(fail)
      .finally(() => setPending(null))
  }

  // ── 派生 ──
  const installed = useMemo(
    () => (status?.installed ?? []).filter((p) => p.installed),
    [status],
  )
  const officialLocal = useMemo(
    () => (status?.installed ?? []).filter((p) => p.status === 'official' && !p.installed),
    [status],
  )
  const marketPacks = status?.market?.packs ?? []

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px',
    marginBottom: '6px',
    borderRadius: 'var(--elab-radius)',
    border: '1px solid var(--elab-border)',
    background: 'var(--elab-bg-surface)',
  }

  const nameRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  }

  const actionRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
    marginTop: '2px',
  }

  const renderInstallRow = (p: MarketPack | InstalledPack, official: boolean): ReactNode => {
    const compat = p.compatible
    const installedRec = status?.installed.find((x) => x.name === p.name)
    const isInstalled = installedRec?.installed === true
    const isActive = installedRec?.active === true
    const updatable = installedRec?.updatable === true
    const latest = installedRec?.latest ?? p.version
    const disabled = frozen || !compat.ok
    return (
      <div key={p.name} style={rowStyle}>
        <div style={nameRowStyle}>
          <span style={{ fontWeight: 600, fontSize: 'var(--elab-fs-sm)' }}>{p.name}</span>
          {isActive ? <Badge text="启用中" tone="ok" /> : null}
          {isInstalled && !isActive ? <Badge text="已安装" tone="idle" /> : null}
          {updatable ? <Badge text={`可更新 v${latest}`} tone="warn" /> : null}
        </div>
        {p.description !== undefined && p.description !== '' ? (
          <span style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-secondary)' }}>{p.description}</span>
        ) : null}
        <PackMeta pack={p} />
        {compat.ok ? null : (
          <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-status-fail)' }}>
            {`不兼容：${compat.reasons.join('；')}`}
          </div>
        )}
        <div style={actionRowStyle}>
          {isInstalled && updatable ? (
            <button
              type="button"
              disabled={disabled || pending === p.name}
              onClick={() => doUpdate(p.name)}
              style={{ ...btn(true), ...(disabled || pending === p.name ? disabledBtn : {}) }}
              title={`按市场索引更新到 v${latest}（内容哈希强校验）`}
            >
              {pending === p.name ? '更新中…' : `更新到 v${latest}`}
            </button>
          ) : null}
          {isInstalled ? (
            isActive ? (
              updatable ? null : (
                <span style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-muted)' }}>当前启用的芯片适配包</span>
              )
            ) : (
              <button
                type="button"
                disabled={disabled || pending === p.name}
                onClick={() => doActivate(p.name)}
                style={{ ...btn(!updatable), ...(disabled || pending === p.name ? disabledBtn : {}) }}
                title="启用这套包（其余包保留在本地，随时切回）"
              >
                {pending === p.name ? '启用中…' : '启用'}
              </button>
            )
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => doInstall(p.name, official)}
              style={{ ...btn(true), ...(disabled ? disabledBtn : {}) }}
              title={disabled ? '有闭环/包操作在跑，或包与内核不兼容' : `安装 ${p.name}`}
            >
              {'安装'}
            </button>
          )}
        </div>
      </div>
    )
  }

  const renderInstalledRow = (p: InstalledPack): ReactNode => {
    const v = verifies[p.name]
    const disabled = frozen
    return (
      <div key={p.name} style={rowStyle}>
        <div style={nameRowStyle}>
          <span style={{ fontWeight: 600, fontSize: 'var(--elab-fs-sm)' }}>{p.name}</span>
          {p.active ? <Badge text="启用中" tone="ok" /> : null}
          {p.updatable && p.latest !== null ? (
            <Badge text={`可更新 v${p.latest}`} tone="warn" />
          ) : null}
        </div>
        <PackMeta pack={p} />
        <span style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-faint)', wordBreak: 'break-all' }}>
          {p.dir}
        </span>
        {v !== undefined ? (
          <div
            style={{
              fontSize: 'var(--elab-fs-xs)',
              color: v.ok ? 'var(--elab-status-ok)' : 'var(--elab-status-fail)',
            }}
          >
            {v.ok ? '校验通过（内容哈希一致）' : `校验未通过：${v.problems.join('；')}`}
          </div>
        ) : null}
        <div style={actionRowStyle}>
          {p.active ? null : (
            <button
              type="button"
              disabled={disabled || pending === p.name}
              onClick={() => doActivate(p.name)}
              style={{ ...btn(true), ...(disabled || pending === p.name ? disabledBtn : {}) }}
            >
              {pending === p.name ? '启用中…' : '启用'}
            </button>
          )}
          <button type="button" onClick={() => doVerify(p.name)} style={btn()}>
            {'校验'}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => doUpdate(p.name)}
            style={{ ...btn(p.updatable === true), ...(disabled ? disabledBtn : {}) }}
            title={p.updatable && p.latest !== null
              ? `按市场索引更新到 v${p.latest}（内容哈希强校验）`
              : '按市场索引更新（内容哈希强校验）'}
          >
            {p.updatable && p.latest !== null ? `更新到 v${p.latest}` : '更新'}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => doRemove(p.name)}
            style={{ ...btn(), ...(disabled ? disabledBtn : {}) }}
            title={p.active ? '卸载后自动启用下一个已装包；没有则清空' : '只删安装目录'}
          >
            {'卸载'}
          </button>
        </div>
      </div>
    )
  }

  // ── 渲染 ──
  return (
    <div
      className="elab-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--elab-bg-canvas)',
        color: 'var(--elab-fg-primary)',
      }}
    >
      {/* 顶栏：标题 + 返回 */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 8px',
          borderBottom: '1px solid var(--elab-border)',
        }}
      >
        <button type="button" onClick={onBack} style={btn()} title="返回闭环面板">
          {'← 返回'}
        </button>
        <span style={{ fontSize: 'var(--elab-fs-sm)', fontWeight: 600 }}>{'芯片适配包'}</span>
        <span style={{ flex: '1 1 auto' }} />
        {status?.active !== undefined && status.active !== '' ? (
          <span
            style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title="当前启用的芯片适配包（一次只启用一套）"
          >
            {`启用：${status.active}`}
          </span>
        ) : null}
      </div>

      {/* 页签 */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          gap: '2px',
          padding: '5px 8px 0',
          borderBottom: '1px solid var(--elab-border)',
        }}
      >
        {TABS.map((t) => {
          const on = t.id === tab
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              style={{
                padding: '3px 10px',
                fontSize: 'var(--elab-fs-xs)',
                border: '1px solid var(--elab-border)',
                borderBottom: on ? '1px solid var(--elab-bg-canvas)' : '1px solid var(--elab-border)',
                borderRadius: 'var(--elab-radius-sm) var(--elab-radius-sm) 0 0',
                background: on ? 'var(--elab-bg-surface)' : 'transparent',
                color: on ? 'var(--elab-fg-primary)' : 'var(--elab-fg-muted)',
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* 闭环冻结提示：有 run 或包操作时 */}
      {frozen ? (
        <div
          style={{
            flex: '0 0 auto',
            padding: '3px 8px',
            fontSize: 'var(--elab-fs-xs)',
            color: 'var(--elab-status-run)',
            borderBottom: '1px solid var(--elab-border)',
          }}
        >
          {jobActive
            ? '安装期间闭环已冻结（无法发起 run）——等包操作完成后自动解除'
            : '有闭环正在跑：包操作已禁用（会改芯片数据）'}
        </div>
      ) : null}

      {/* 包操作任务进度 */}
      {job !== null ? (
        <div
          style={{
            flex: '0 0 auto',
            padding: '5px 8px',
            borderBottom: '1px solid var(--elab-border)',
            background: 'var(--elab-bg-raised)',
            fontSize: 'var(--elab-fs-xs)',
          }}
        >
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span
              style={{
                color:
                  job.state === 'ok'
                    ? 'var(--elab-status-ok)'
                    : job.state === 'failed'
                      ? 'var(--elab-status-fail)'
                      : 'var(--elab-accent)',
              }}
            >
              {`${ACTION_LABEL[job.action] ?? job.action}${job.name ? ` ${job.name}` : ''}：${job.stage}`}
            </span>
            <span style={{ flex: '1 1 auto' }} />
            {job.state === 'ok' || job.state === 'failed' ? (
              <button type="button" onClick={() => setJob(null)} style={btn()}>
                {'关闭'}
              </button>
            ) : null}
          </div>
          {job.error !== null ? (
            <div style={{ color: 'var(--elab-status-fail)', marginTop: '2px' }}>{job.error}</div>
          ) : null}
          {job.log.length > 0 ? (
            <div
              style={{
                marginTop: '3px',
                fontFamily: 'var(--elab-font-mono)',
                color: 'var(--elab-fg-muted)',
                maxHeight: '120px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {job.log.slice(-8).join('\n')}
            </div>
          ) : null}
        </div>
      ) : null}

      {notice !== null ? (
        <div
          style={{
            flex: '0 0 auto',
            padding: '3px 8px',
            fontSize: 'var(--elab-fs-xs)',
            color: 'var(--elab-status-ok)',
            borderBottom: '1px solid var(--elab-border)',
          }}
        >
          {notice}
        </div>
      ) : null}

      {error !== null ? (
        <div
          role="alert"
          style={{
            flex: '0 0 auto',
            padding: '3px 8px',
            fontSize: 'var(--elab-fs-xs)',
            color: 'var(--elab-status-fail)',
            borderBottom: '1px solid var(--elab-border)',
          }}
        >
          {error}
        </div>
      ) : null}

      {/* 内容 */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '8px 10px' }}>
        {tab === 'kernel' ? (
          <SettingsSection />
        ) : tab === 'market' ? (
          <>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
              <input
                value={query}
                onChange={(e: any) => setQuery(e.currentTarget.value)}
                placeholder="搜索芯片包：名称 / 厂商 / 平台（如 stm32、at32）"
                aria-label="搜索芯片适配包"
                style={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  padding: '4px 8px',
                  fontSize: 'var(--elab-fs-sm)',
                  borderRadius: 'var(--elab-radius-sm)',
                  border: '1px solid var(--elab-border)',
                  background: 'var(--elab-bg-surface)',
                  color: 'var(--elab-fg-primary)',
                }}
              />
              {query !== '' ? (
                <button type="button" onClick={() => setQuery('')} style={btn()}>
                  {'清空'}
                </button>
              ) : null}
            </div>

            {loading ? (
              <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-muted)' }}>{'读取中…'}</div>
            ) : null}

            {status?.market?.error !== undefined && status?.market?.error !== null ? (
              <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-status-run)', marginBottom: '6px' }}>
                {`市场索引读取失败：${status.market.error}`}
              </div>
            ) : null}

            {query.trim() === '' ? (
              <>
                {/* 首屏：直接把市场里的**全部**可用包列出来（无需输入） */}
                {marketPacks.length > 0 ? (
                  <>
                    <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-secondary)', margin: '4px 0 6px' }}>
                      {`市场（GitHub 发现 ${marketPacks.length} 个）`}
                    </div>
                    {marketPacks.map((p) => renderInstallRow(p, false))}
                  </>
                ) : marketJobActive ? (
                  <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-muted)', marginBottom: '8px' }}>
                    {'正在遍历 GitHub 上的芯片适配包…'}
                  </div>
                ) : (
                  <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-muted)', marginBottom: '8px', lineHeight: 1.6 }}>
                    {'市场里暂时没有可用包：可在上方输入名称过滤，或装本机官方源里的内置包。'}
                  </div>
                )}
                {officialLocal.length > 0 ? (
                  <>
                    <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-secondary)', margin: '8px 0 6px' }}>
                      {'本机官方源（离线可装）'}
                    </div>
                    {officialLocal.map((p) => renderInstallRow(p, true))}
                  </>
                ) : null}
                {marketPacks.length > 0 ? (
                  <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-faint)', marginTop: '8px', lineHeight: 1.6 }}>
                    {'以上为市场里的全部适配包；输入名称可过滤。内容留在作者仓库，一次只启用一套。'}
                  </div>
                ) : null}
              </>
            ) : marketPacks.length === 0 && !loading ? (
              <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-muted)' }}>
                {`没有匹配「${query.trim()}」的芯片包（可试试厂商名：stm32 / at32 / …）`}
              </div>
            ) : (
              marketPacks.map((p) => renderInstallRow(p, false))
            )}
          </>
        ) : (
          <>
            {loading ? (
              <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-muted)' }}>{'读取中…'}</div>
            ) : null}
            {installed.length === 0 && !loading ? (
              <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-muted)', lineHeight: 1.6 }}>
                {'还没有安装任何芯片适配包：去「市场」搜索（例如 stm32），或装本机官方源里的内置包。'}
              </div>
            ) : (
              installed.map((p) => renderInstalledRow(p))
            )}
          </>
        )}
      </div>
    </div>
  )
}
