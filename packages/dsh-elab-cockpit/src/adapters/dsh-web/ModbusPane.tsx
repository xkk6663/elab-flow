/**
 * Modbus 工作区（DSH 窄栏）—— 连接 / 点表 / 单次读写 / 事务流水。
 *
 * 纪律（与 `cockpit/web/src/modbus/ModbusWorkspace.tsx` 逐条对齐）：
 *  - **不自己开串口**：主站挂在已开的串口会话上（`modbusOpen` 复用/代开会话），
 *    面板看到的字节与 agent、与串口工作区是同一份；
 *  - **写先确认**：`window.confirm` 在本组件内弹，确认后才调 `modbusWrite`
 *    （实现侧还会固定加 `confirm:true`；内核两处都会拒）；
 *  - **诊断区不硬编码**：地址落在 `0x0100..0x010F` 的读保持寄存器点自动聚成
 *    「DMA 诊断」小卡（这是例程约定，不是 Modbus 概念；没有这些点就没有这一块）；
 *  - 地址说明按点表反查，不写死"0x10 = LED"这类例程语义。
 *
 * 与 WebUI 的差异只有布局密度与样式：窄栏砍掉独立列（点位表只留 名称/地址/值），
 * 用内联样式 + `--elab-*` 令牌（宿主无 CSS 构建管线）。
 */

import React from 'react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ModbusPort } from '../../app/ports.ts'
import type {
  ModbusMap,
  ModbusPointLive,
  ModbusRunResult,
  ModbusStateResponse,
  ModbusTxn,
} from '../../domain/icd.ts'

export interface ModbusPaneProps {
  api: ModbusPort
  project: string
  /** 宿主 run 在跑：与烧录/调试互斥，写按钮置灰（读不受限）。 */
  running?: boolean
  sessionId?: string
}

const POLL_MS = 400
const MAX_TXNS = 40

const FC_READ: Array<{ v: number; label: string }> = [
  { v: 1, label: '01 线圈' },
  { v: 2, label: '02 离散' },
  { v: 3, label: '03 保持' },
  { v: 4, label: '04 输入' },
]

const FC_WRITE: Array<{ v: number; label: string }> = [
  { v: 5, label: '05 单线圈' },
  { v: 6, label: '06 单寄存器' },
  { v: 15, label: '15 多线圈' },
  { v: 16, label: '16 多寄存器' },
]

const MUTED = 'var(--elab-fg-muted)'
const MONO = 'var(--elab-font-mono)'

/** 小输入框（宽度按内容固定，窄栏里三四个并排也不挤）。 */
const numStyle: React.CSSProperties = {
  width: '54px',
  padding: '1px 4px',
  fontFamily: MONO,
  fontSize: '11px',
  color: 'var(--elab-fg-primary)',
  background: 'var(--elab-bg-code)',
  border: '1px solid var(--elab-border)',
  borderRadius: '3px',
}

const selStyle: React.CSSProperties = { ...numStyle, width: 'auto' }

const btnStyle = (active = false, disabled = false): React.CSSProperties => ({
  padding: '1px 7px',
  fontSize: '11px',
  borderRadius: '3px',
  border: `1px solid ${active ? 'var(--elab-accent)' : 'var(--elab-border)'}`,
  background: active ? 'var(--elab-bg-raised)' : 'transparent',
  color: disabled ? 'var(--elab-fg-dimmed)' : active ? 'var(--elab-fg-primary)' : 'var(--elab-fg-secondary)',
  cursor: disabled ? 'default' : 'pointer',
  whiteSpace: 'nowrap',
})

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  padding: '4px 8px',
  borderBottom: '1px solid var(--elab-border)',
  flexWrap: 'wrap',
}

const labelStyle: React.CSSProperties = { fontSize: '11px', color: MUTED, whiteSpace: 'nowrap' }

function fmtValue(p: ModbusPointLive): string {
  const v = p.value
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v)
    return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  }
  return String(v)
}

function ageText(ts: number): string {
  if (!ts) return '—'
  const d = Date.now() / 1000 - ts
  if (d < 1) return '刚刚'
  if (d < 60) return `${d.toFixed(1)}s`
  return `${Math.round(d / 60)}m`
}

export function ModbusPane(props: ModbusPaneProps): ReactNode {
  const { api, project, sessionId, running = false } = props

  const [st, setSt] = useState<ModbusStateResponse | null>(null)
  /** 轮询/快照的错误：下一轮成功就清（瞬时问题不该常驻）。 */
  const [err, setErr] = useState('')
  /** 用户动作（打开/读写）的错误：**不被轮询清掉**，否则 open 失败会一闪而过。 */
  const [actErr, setActErr] = useState('')
  const [busy, setBusy] = useState('')
  const [last, setLast] = useState<ModbusRunResult | null>(null)
  const [lastKind, setLastKind] = useState<'probe' | 'read' | 'write'>('probe')

  // 连接参数（打开时生效；改完要重开 —— 与串口"打开时属性"同一个道理）
  const [unit, setUnit] = useState('1')
  const [timeoutMs, setTimeoutMs] = useState('120')
  const [retries, setRetries] = useState('2')

  const [rFc, setRFc] = useState(3)
  const [rAddr, setRAddr] = useState('0')
  const [rCount, setRCount] = useState('6')

  const [wFc, setWFc] = useState(6)
  const [wAddr, setWAddr] = useState('16')
  const [wValue, setWValue] = useState('1')
  /** FC15/16 的批量值（逗号/空格分隔 → number[]）。 */
  const [wValues, setWValues] = useState('1,0,1,0')

  const seqRef = useRef(0)
  const txnsRef = useRef<ModbusTxn[]>([])
  const [txns, setTxns] = useState<ModbusTxn[]>([])

  const engine = st?.engine?.active === true ? st.engine : null
  const map: ModbusMap | undefined = st?.map
  const stats = engine?.stats

  const points: ModbusPointLive[] = useMemo(() => {
    if (engine?.points !== undefined && engine.points.length > 0) return engine.points
    return (map?.points ?? []).map((def) => ({
      name: def.name,
      def,
      raw: null,
      value: null,
      unit: def.unit ?? '',
      ts: 0,
      error: '',
    }))
  }, [engine, map])

  /** DMA 诊断点：`0x0100..0x010F` 的读保持寄存器（例程约定，没这些点就整块不出现）。 */
  const diagPoints = useMemo(
    () => points.filter((p) => p.def.fc === 3 && p.def.address >= 0x0100 && p.def.address <= 0x010f),
    [points],
  )

  /** 写表单的地址说明：按点表反查，不硬编码例程语义。 */
  const wTarget = useMemo(() => {
    const addr = Number(wAddr)
    if (!Number.isFinite(addr)) return undefined
    return points.find((p) => p.def.address === addr)
  }, [points, wAddr])

  const poll = useCallback(async (): Promise<void> => {
    try {
      const res = await api.modbusState(project, seqRef.current, sessionId)
      setSt(res)
      setErr('')
      if (Array.isArray(res.transactions) && res.transactions.length > 0) {
        const merged = [...txnsRef.current, ...res.transactions].slice(-MAX_TXNS)
        txnsRef.current = merged
        setTxns(merged)
        seqRef.current = merged[merged.length - 1]?.seq ?? seqRef.current
      }
    } catch (e) {
      // 轮询失败不刷红：只在顶部留一行理由，继续下一轮
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api, project, sessionId])

  useEffect(() => {
    seqRef.current = 0
    txnsRef.current = []
    setTxns([])
    setSt(null)
    setLast(null)
  }, [project])

  useEffect(() => {
    void poll()
    const t = window.setInterval(() => void poll(), POLL_MS)
    return () => window.clearInterval(t)
  }, [poll])

  const guard = async (tag: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(tag)
    setActErr('')
    try {
      await fn()
    } catch (e) {
      setActErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const doOpen = (): void => {
    void guard('open', async () => {
      const res = await api.modbusOpen({
        project,
        unit_id: Number(unit) || 1,
        timeout_ms: Number(timeoutMs) || 120,
        retries: Number(retries) || 0,
        probe: true,
        sessionId,
      })
      if (res.probe !== undefined) {
        setLast(res.probe)
        setLastKind('probe')
      }
      await poll()
    })
  }

  const doClose = (): void => {
    void guard('close', async () => {
      await api.modbusClose(sessionId)
      await poll()
    })
  }

  const doStart = (): void => {
    void guard('start', async () => {
      await api.modbusStart(undefined, sessionId)
      await poll()
    })
  }

  const doStop = (): void => {
    void guard('stop', async () => {
      await api.modbusStop(sessionId)
      await poll()
    })
  }

  const doRead = (): void => {
    void guard('read', async () => {
      const r = await api.modbusRead({
        project,
        fc: rFc,
        address: Number(rAddr) || 0,
        count: Number(rCount) || 1,
        sessionId,
      })
      setLast(r)
      setLastKind('read')
      await poll()
    })
  }

  const doWrite = (): void => {
    const addr = Number(wAddr) || 0
    const val = Number(wValue) || 0
    const multi = wFc === 15 || wFc === 16
    const vals = wValues
      .split(/[\s,;]+/)
      .filter((x) => x !== '')
      .map(Number)
    if (multi) {
      if (vals.length === 0 || vals.some((n) => !Number.isFinite(n))) {
        setActErr('批量写的值列表必须是逗号分隔的数字，例如 1,0,1,0')
        return
      }
      if (wFc === 15 && vals.some((n) => n !== 0 && n !== 1)) {
        setActErr('FC15 写线圈只认 0/1（内核会再转成 0xFF00/0x0000）')
        return
      }
    }
    const fcLabel = FC_WRITE.find((f) => f.v === wFc)?.label ?? `FC${wFc}`
    const shown = multi ? `${vals.length} 个（${vals.join(', ')}）` : String(val)
    // 摩擦点：写会真的动物理世界（LED / 继电器 / 变频器频率）
    const ok = window.confirm(
      `确认在总线上写？\n\n${fcLabel}\n从站 ${unit} · 地址 ${addr}（0x${addr.toString(16).toUpperCase()}）\n值 ${shown}`,
    )
    if (!ok) return
    void guard('write', async () => {
      const r = await api.modbusWrite(
        multi
          ? { project, fc: wFc, address: addr, values: vals, sessionId }
          : { project, fc: wFc, address: addr, value: val, sessionId },
      )
      setLast(r)
      setLastKind('write')
      await poll()
    })
  }

  const dot = busy !== ''
    ? 'var(--elab-status-run)'
    : engine?.polling === true
      ? (stats !== undefined && stats.last_error ? 'var(--elab-status-fail)' : 'var(--elab-status-ok)')
      : engine !== null ? 'var(--elab-status-ok)' : 'var(--elab-fg-dimmed)'

  const linkLabel = engine !== null
    ? `${engine.session?.port ?? 'auto'}@${engine.session?.baud ?? '?'} · 从站 ${engine.unit_id ?? '?'} · ${
      engine.polling === true ? `轮询中（${(engine.groups ?? []).join('/')}）` : '空闲'
    }`
    : '未连接（点「打开主站」）'

  const lastText = ((): string => {
    if (last === null) return ''
    const kind = lastKind === 'probe' ? '打开时探测' : lastKind === 'write' ? '上次写入' : '上次读取'
    if (last.ok !== true) {
      const d = last.error?.detail ?? last.error?.kind ?? '失败'
      return `${kind} ✗ ${d}${last.elapsed_ms === undefined ? '' : ` · ${last.elapsed_ms}ms`}`
    }
    const vals = last.values
    const shown = Array.isArray(vals) && vals.length > 0
      ? `values=[${vals.slice(0, 8).join(', ')}${vals.length > 8 ? ', …' : ''}]`
      : 'ok'
    return `${kind} OK · ${shown}${last.elapsed_ms === undefined ? '' : ` · ${last.elapsed_ms}ms`}`
  })()

  const panelStyle: React.CSSProperties = {
    flex: '0 0 auto',
    borderBottom: '1px solid var(--elab-border)',
  }
  const headStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 8px',
    background: 'var(--elab-bg-surface)',
    borderBottom: '1px solid var(--elab-border)',
  }

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      {/* ── 连接条 ─────────────────────────────────────── */}
      <div style={headStyle}>
        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: dot, flex: '0 0 auto' }} />
        <span
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: '11px',
            fontFamily: MONO,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={linkLabel}
        >
          {linkLabel}
        </span>
        {engine === null ? (
          <button type="button" style={btnStyle(true, busy === 'open')} onClick={doOpen} disabled={busy === 'open'}>
            打开主站
          </button>
        ) : (
          <button type="button" style={btnStyle(false, busy === 'close')} onClick={doClose} disabled={busy === 'close'}>
            关闭主站
          </button>
        )}
        <button
          type="button"
          style={btnStyle(engine?.polling === true, engine === null || busy !== '')}
          onClick={engine?.polling === true ? doStop : doStart}
          disabled={engine === null || busy !== ''}
          title={engine === null ? '先打开主站' : '按点表分组轮询（同功能码相邻地址自动合并）'}
        >
          {engine?.polling === true ? '停止轮询' : '开始轮询'}
        </button>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>从站</span>
        <input style={numStyle} value={unit} onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setUnit(e.currentTarget.value)} aria-label="从站地址" disabled={engine !== null} />
        <span style={labelStyle}>超时ms</span>
        <input style={numStyle} value={timeoutMs} onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setTimeoutMs(e.currentTarget.value)} aria-label="超时毫秒" disabled={engine !== null} />
        <span style={labelStyle}>重试</span>
        <input style={numStyle} value={retries} onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setRetries(e.currentTarget.value)} aria-label="重试次数" disabled={engine !== null} />
      </div>

      {/* ── 统计胶囊 ─────────────────────────────────── */}
      {stats !== undefined ? (
        <div style={{ ...rowStyle, gap: '6px' }}>
          <span style={{ fontSize: '11px', color: 'var(--elab-status-ok)' }}>成功 {stats.ok}</span>
          <span style={{ fontSize: '11px', color: stats.timeout > 0 ? 'var(--elab-status-run)' : MUTED }}>超时 {stats.timeout}</span>
          <span style={{ fontSize: '11px', color: stats.crc > 0 ? 'var(--elab-status-fail)' : MUTED }}>CRC {stats.crc}</span>
          <span style={{ fontSize: '11px', color: stats.exception > 0 ? 'var(--elab-status-run)' : MUTED }}>异常 {stats.exception}</span>
          <span style={{ fontSize: '11px', color: MUTED }}>重试 {stats.retry}</span>
          <span style={{ fontSize: '11px', color: MUTED }}>
            最近成功 {stats.last_ok_ms_ago === null ? '—' : `${stats.last_ok_ms_ago}ms 前`}
          </span>
          {stats.last_error ? (
            <span style={{ fontSize: '11px', color: 'var(--elab-status-fail)' }}>最近错误 {stats.last_error}</span>
          ) : null}
        </div>
      ) : null}

      {actErr !== '' || err !== '' ? (
        <div style={{ ...rowStyle, color: 'var(--elab-status-fail)', fontSize: '11px' }}>
          {actErr !== '' ? actErr : err}
        </div>
      ) : null}

      {/* ── 点表 ─────────────────────────────────────── */}
      <div style={panelStyle}>
        <div style={headStyle}>
          <span style={{ fontSize: '11px', color: 'var(--elab-fg-primary)' }}>点位</span>
          <span style={{ fontSize: '11px', color: MUTED }}>
            {points.length} 个 · rev {map?.rev ?? '—'}
            {map?.groups !== undefined && map.groups.length > 0 ? ` · ${map.groups.length} 组` : ''}
          </span>
          <span style={{ flex: '1 1 auto' }} />
          <span style={{ fontSize: '10px', color: MUTED }}>地址为协议偏移</span>
        </div>
        <div style={{ maxHeight: '168px', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: '11px' }}>
            <tbody>
              {points.map((p) => (
                <tr key={p.name} style={{ borderBottom: '1px solid var(--elab-border)' }}>
                  <td style={{ padding: '1px 6px', color: 'var(--elab-fg-secondary)', maxWidth: '118px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.def.note ?? p.name}>
                    {p.name}
                    {p.def.writable === true ? <span style={{ color: 'var(--elab-accent)' }}> W</span> : null}
                  </td>
                  <td style={{ padding: '1px 6px', color: MUTED, whiteSpace: 'nowrap' }}>
                    0x{p.def.address.toString(16).toUpperCase().padStart(4, '0')}
                  </td>
                  <td style={{ padding: '1px 6px', color: p.value === null ? 'var(--elab-fg-dimmed)' : 'var(--elab-fg-primary)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {fmtValue(p)}
                    {p.unit !== '' ? <span style={{ color: MUTED }}>{` ${p.unit}`}</span> : null}
                  </td>
                  <td style={{ padding: '1px 6px', color: MUTED, textAlign: 'right', whiteSpace: 'nowrap', width: '46px' }}>
                    {p.error !== '' ? <span style={{ color: 'var(--elab-status-fail)' }}>{p.error}</span> : p.ts > 0 ? ageText(p.ts) : '未读'}
                  </td>
                </tr>
              ))}
              {points.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: '6px 8px', color: MUTED, fontSize: '11px' }}>
                    该工程没有点表（projects/&lt;工程&gt;.modbus.json）
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 单次读 ───────────────────────────────────── */}
      <div style={{ ...panelStyle, borderBottom: 'none' }}>
        <div style={rowStyle}>
          <span style={{ fontSize: '11px', color: 'var(--elab-fg-primary)' }}>单次读</span>
          <select style={selStyle} value={rFc} onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setRFc(Number(e.currentTarget.value))} aria-label="读功能码">
            {FC_READ.map((f) => (
              <option key={f.v} value={f.v}>{f.label}</option>
            ))}
          </select>
          <input style={numStyle} value={rAddr} onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setRAddr(e.currentTarget.value)} aria-label="读地址" />
          <input style={numStyle} value={rCount} onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setRCount(e.currentTarget.value)} aria-label="读数量" />
          <button type="button" style={btnStyle(false, busy === 'read')} onClick={doRead} disabled={busy === 'read'}>
            读一次
          </button>
        </div>

        {/* ── 单次写 ─────────────────────────────────── */}
        <div style={rowStyle}>
          <span style={{ fontSize: '11px', color: 'var(--elab-fg-primary)' }}>单次写</span>
          <select style={selStyle} value={wFc} onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setWFc(Number(e.currentTarget.value))} aria-label="写功能码">
            {FC_WRITE.map((f) => (
              <option key={f.v} value={f.v}>{f.label}</option>
            ))}
          </select>
          <input style={numStyle} value={wAddr} onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setWAddr(e.currentTarget.value)} aria-label="写地址" />
          {wFc === 15 || wFc === 16 ? (
            <input
              style={{ ...numStyle, width: '86px' }}
              value={wValues}
              onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setWValues(e.currentTarget.value)}
              aria-label="批量写的值列表"
              placeholder="1,0,1,0"
            />
          ) : (
            <input
              style={numStyle}
              value={wValue}
              onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setWValue(e.currentTarget.value)}
              aria-label="写值"
            />
          )}
          <button
            type="button"
            style={btnStyle(false, engine === null || running || busy === 'write')}
            onClick={doWrite}
            disabled={engine === null || running || busy === 'write'}
            title={running ? '有 run 在跑：写与烧录/调试互斥' : '写会动物理世界，点后还要再确认一次'}
          >
            写入
          </button>
        </div>
        <div style={{ padding: '0 8px 4px', fontSize: '10px', color: MUTED, lineHeight: 1.45 }}>
          {wTarget !== undefined
            ? `0x${(Number(wAddr) || 0).toString(16).toUpperCase().padStart(4, '0')} = ${wTarget.name}${wTarget.def.note === undefined ? '' : ` · ${wTarget.def.note}`}`
            : '该地址不在点表里；写下去前请确认从站文档（地址为协议偏移，40001 → 0）'}
        </div>
      </div>

      {/* ── 结果条 ───────────────────────────────────── */}
      {lastText !== '' ? (
        <div
          style={{
            ...rowStyle,
            fontFamily: MONO,
            fontSize: '11px',
            color: last?.ok === true ? 'var(--elab-fg-secondary)' : 'var(--elab-status-fail)',
          }}
        >
          {lastText}
        </div>
      ) : null}

      {/* ── DMA 诊断（例程约定：0x0100 段的读保持寄存器）────────── */}
      {diagPoints.length > 0 ? (
        <div style={panelStyle}>
          <div style={headStyle}>
            <span style={{ fontSize: '11px', color: 'var(--elab-fg-primary)' }}>DMA 诊断</span>
            <span style={{ fontSize: '10px', color: MUTED }}>0x0100 段 · 双缓冲计数</span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
              gap: '4px',
              padding: '4px 8px',
            }}
          >
            {diagPoints.map((p) => (
              <div
                key={p.name}
                style={{
                  minWidth: 0,
                  padding: '3px 5px',
                  border: '1px solid var(--elab-border)',
                  borderRadius: '3px',
                  background: 'var(--elab-bg-surface)',
                }}
                title={p.def.note ?? p.name}
              >
                <div
                  style={{
                    fontSize: '9px',
                    color: MUTED,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: MONO,
                  }}
                >
                  {p.name}
                </div>
                <div style={{ fontSize: '12px', fontFamily: MONO, color: 'var(--elab-fg-primary)' }}>
                  {fmtValue(p)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── 事务流水 ─────────────────────────────────── */}
      <div>
        <div style={headStyle}>
          <span style={{ fontSize: '11px', color: 'var(--elab-fg-primary)' }}>事务流水</span>
          <span style={{ fontSize: '11px', color: MUTED }}>
            最近 {txns.length} 条 · seq {engine?.seq ?? 0}
          </span>
        </div>
        <div style={{ maxHeight: '132px', overflow: 'auto' }}>
          {txns.length === 0 ? (
            <div style={{ padding: '6px 8px', fontSize: '11px', color: MUTED }}>
              还没有事务。点「打开主站」或「开始轮询」。
            </div>
          ) : (
            [...txns].reverse().map((t) => (
              <div
                key={t.seq}
                title={`${t.tx_hex}\n${t.rx_hex}${t.error === null ? '' : `\n${t.error.kind}: ${t.error.detail}`}`}
                style={{
                  display: 'flex',
                  gap: '6px',
                  padding: '1px 8px',
                  fontFamily: MONO,
                  fontSize: '11px',
                  color: t.ok ? 'var(--elab-fg-secondary)' : 'var(--elab-status-fail)',
                }}
              >
                <span style={{ color: MUTED, width: '18px' }}>{String(t.fc).padStart(2, '0')}</span>
                <span style={{ color: MUTED, width: '52px' }}>0x{t.address.toString(16).toUpperCase()}</span>
                <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.point !== '' ? t.point : t.label}
                  {t.error === null ? '' : ` · ${t.error.kind}`}
                </span>
                <span style={{ color: MUTED }}>{`${t.elapsed_ms}ms`}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
