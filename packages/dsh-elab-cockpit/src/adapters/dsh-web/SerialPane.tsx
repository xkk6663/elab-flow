/**
 * 串口工作区（融合工程 UI 的窄栏移植）—— 行 / 字节 / 终端 / 波形 四视图。
 *
 * 纪律（与 `cockpit/web/src/serial/SerialWorkspace.tsx` 逐条对齐）：
 *  - 四个视图全部从同一份**原始字节**投影（行视图来自服务端切好的 RX 行）；
 *  - 方向过滤在客户端做：服务端只按 all 拉一次，切方向不丢游标；
 *  - 发送面板与监视会话同口（写穿），TX 字节与 RX 同构进入同一份数据面。
 *
 * 与 cockpit/web 的差异只有取数口与样式：这里走 loopback ICD（elabApi），
 * 零 CSS 模块（宿主无 CSS 构建管线），一切用 `--elab-*` 令牌的内联样式。
 */

import React from 'react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SerialPort } from '../../app/ports.ts'
import type { SerialChunk } from '../../domain/icd.ts'
import { parseAnsi } from './theme/ansi.ts'
import { b64ToBytes, bytesToB64, captureText, hexDump, textOf } from './serial/bytes.ts'
import type { SerialRepr } from './serial/bytes.ts'
import { AnsiTerminal, StreamTextDecoder } from './serial/ansiTerminal.ts'
import type { TermLine } from './serial/ansiTerminal.ts'
import type { SerialStream } from './serial/useSerialStream.ts'
import type { TailLine } from './EvidenceTail.tsx'

type ViewId = 'lines' | 'bytes' | 'terminal' | 'wave'
type Dir = 'all' | 'rx' | 'tx'

const VIEW_TABS: Array<{ id: ViewId; label: string }> = [
  { id: 'lines', label: '行' },
  { id: 'bytes', label: '字节' },
  { id: 'terminal', label: '终端' },
  { id: 'wave', label: '波形' },
]

const REPRS: Array<{ id: SerialRepr; label: string }> = [
  { id: 'hex', label: 'HEX' },
  { id: 'ascii', label: 'ASCII' },
  { id: 'utf8', label: 'UTF-8' },
  { id: 'gbk', label: 'GBK' },
]

const DIRS: Array<{ id: Dir; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'rx', label: 'RX' },
  { id: 'tx', label: 'TX' },
]

const FORMATS = [
  { id: 'utf8', label: '文本' },
  { id: 'ascii', label: 'ASCII' },
  { id: 'gbk', label: 'GBK' },
  { id: 'hex', label: 'HEX' },
]

const EOLS = [
  { id: 'none', label: '无' },
  { id: 'lf', label: 'LF' },
  { id: 'cr', label: 'CR' },
  { id: 'crlf', label: 'CRLF' },
]

/** 常用波特率（非标值会插进来，否则 select 显示不出当前值）。 */
const COMMON_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

function baudOptions(current: number): number[] {
  return COMMON_BAUDS.includes(current)
    ? COMMON_BAUDS
    : [...COMMON_BAUDS, current].sort((a, b) => a - b)
}

/** 本地渲染上限：字节视图最多画这么多批（更早的仍在缓冲里，并非丢失）。 */
const MAX_BYTE_BLOCKS = 200
/** 波形最大回看字节（超出只取最近一段）。 */
const MAX_WAVE_BYTES = 64 * 1024

export interface SerialDecoder {
  id: string
  label: string
  desc?: string
}

export interface SerialPortInfo {
  name: string
  kind?: string
  desc?: string
}

export interface SerialPaneProps {
  /** 串口数据面端口（CockpitPane 注入 elabApi 串口子集）。 */
  api: SerialPort
  stream: SerialStream
  decoders: SerialDecoder[]
  project: string
  /** 有 run 在跑：串口与 run 互斥（N5），发送面板置灰。 */
  running: boolean
  port: string
  baud: number
  /** capabilities 枚举到的端口（供界面选择；auto = 让内核按 USB 优先解析）。 */
  ports: SerialPortInfo[]
  /** 端口/波特率偏好的持久化由上层做（面板只负责发意图）。 */
  onPort?: (port: string) => void
  onBaud?: (baud: number) => void
  writable: boolean
  /** 闭环 run 落在 serial 通道的事件行（保持闭环证据可见）。 */
  runLines: TailLine[]
  /** 缓冲版本号：命令式缓冲不进 React 状态，靠它触发重绘。 */
  runLinesVersion: number
  sessionId?: string
}

const chip: React.CSSProperties = {
  flex: '0 0 auto',
  padding: '2px 8px',
  fontSize: 'var(--elab-fs-xs)',
  lineHeight: '16px',
  borderRadius: 'var(--elab-radius-sm)',
  border: '1px solid var(--elab-border)',
  background: 'var(--elab-bg-surface)',
  color: 'var(--elab-fg-secondary)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const selectStyle: React.CSSProperties = {
  flex: '0 0 auto',
  height: '22px',
  padding: '0 4px',
  fontFamily: 'var(--elab-font-mono)',
  fontSize: 'var(--elab-fs-xs)',
  color: 'var(--elab-fg-secondary)',
  background: 'var(--elab-bg-surface)',
  border: '1px solid var(--elab-border)',
  borderRadius: 'var(--elab-radius-sm)',
  cursor: 'pointer',
}

const metaStyle: React.CSSProperties = {
  fontSize: 'var(--elab-fs-xs)',
  color: 'var(--elab-fg-faint)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

/** 波形页的共享解码标记（「共享解码」+「agent 选定」） */
const waveBadge: React.CSSProperties = {
  padding: '1px 6px',
  borderRadius: '999px',
  border: '1px solid var(--elab-border)',
  color: 'var(--elab-fg-secondary)',
  lineHeight: '14px',
  whiteSpace: 'nowrap',
}

/** 提示条（融合工程的 warn / info：同色描边 + 10% 底） */
const barBase: React.CSSProperties = {
  flex: '0 0 auto',
  padding: '5px 12px',
  fontSize: 'var(--elab-fs-xs)',
  lineHeight: 1.5,
  borderBottom: '1px solid var(--elab-border)',
}

const barWarn: React.CSSProperties = {
  ...barBase,
  color: 'var(--elab-status-fail)',
  background: 'color-mix(in srgb, var(--elab-status-fail) 10%, transparent)',
}

const barInfo: React.CSSProperties = {
  ...barBase,
  color: 'var(--elab-status-run)',
  background: 'color-mix(in srgb, var(--elab-status-run) 10%, transparent)',
}

/** 发送结果提示：贴在发送面板下方，所以描边换成 top */
const noticeStyle = (failed: boolean): React.CSSProperties => ({
  flex: '0 0 auto',
  padding: '5px 12px',
  fontSize: 'var(--elab-fs-xs)',
  lineHeight: 1.5,
  borderTop: '1px solid var(--elab-border)',
  color: failed ? 'var(--elab-status-fail)' : 'var(--elab-status-run)',
  background: failed
    ? 'color-mix(in srgb, var(--elab-status-fail) 10%, transparent)'
    : 'color-mix(in srgb, var(--elab-status-run) 10%, transparent)',
})

/** 空态文案（融合工程的 .empty：无衬线、faint、12px、大内边距） */
const emptyStyle: React.CSSProperties = {
  padding: 'var(--elab-space-4) var(--elab-space-3)',
  color: 'var(--elab-fg-faint)',
  fontFamily: 'var(--elab-font-sans)',
  fontSize: 'var(--elab-fs-sm)',
  lineHeight: 1.6,
}

/**
 * ANSI 语义 class 直接用宿主已生成的 `.elab-root .a-*` 规则
 * （dsw-map.ts 是唯一色源；这里不再复制颜色，避免字面色值门禁失败）。
 */
function AnsiLine(props: { text: string; query: string }): ReactNode {
  const spans = parseAnsi(props.text)
  if (spans.length === 0) return <>{highlight(props.text, props.query, 't')}</>
  return (
    <>
      {spans.map((sp, i) => (
        <span key={i} className={sp.cls}>
          {highlight(sp.text, props.query, `s${i}`)}
        </span>
      ))}
    </>
  )
}

/** 在纯文本里高亮搜索词（大小写不敏感；不做正则，避免用户输入被当成语法）。 */
function highlight(text: string, query: string, keyBase: string): ReactNode {
  if (query === '') return text
  const low = text.toLowerCase()
  const q = query.toLowerCase()
  const out: ReactNode[] = []
  let pos = 0
  let hit = low.indexOf(q)
  let n = 0
  while (hit >= 0) {
    if (hit > pos) out.push(text.slice(pos, hit))
    out.push(
      <mark
        key={`${keyBase}-${n}`}
        style={{
          padding: '0 1px',
          color: 'var(--elab-fg-primary)',
          background: 'color-mix(in srgb, var(--elab-status-run) 35%, transparent)',
          borderRadius: '2px',
        }}
      >
        {text.slice(hit, hit + q.length)}
      </mark>,
    )
    pos = hit + q.length
    n += 1
    hit = low.indexOf(q, pos)
  }
  if (pos < text.length) out.push(text.slice(pos))
  return out.length > 0 ? out : text
}

function termText(line: TermLine): string {
  return line.map((sp) => sp.text).join('')
}

export function SerialPane(props: SerialPaneProps): ReactNode {
  const { api, stream, decoders, project, running, port, baud, ports, writable } = props
  const [view, setView] = useState<ViewId>('lines')
  const [dir, setDir] = useState<Dir>('all')
  const [repr, setRepr] = useState<SerialRepr>('hex')
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const [draft, setDraft] = useState('')
  const [sendFormat, setSendFormat] = useState('utf8')
  const [eol, setEol] = useState('crlf')
  const [notice, setNotice] = useState<string | null>(null)
  const [decoder, setDecoder] = useState(decoders[0]?.id ?? 'justfloat')

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)
  followRef.current = follow

  const termRef = useRef<{
    key: string
    lastSeq: number
    term: AnsiTerminal
    dec: StreamTextDecoder
  } | null>(null)

  const epoch = stream.snap?.epoch ?? 0

  /** 端口选项：auto + 枚举结果；当前值不在列表里（手工配置/刚拔插）也插进来。 */
  const portOptions = useMemo(() => {
    const list = ports.map((p) => ({ name: p.name, label: p.kind === 'bluetooth' ? `${p.name}（蓝牙）` : p.name }))
    if (port !== '' && port !== 'auto' && !list.some((p) => p.name === port)) {
      list.unshift({ name: port, label: `${port}（当前）` })
    }
    return list
  }, [ports, port])
  const portLocked = stream.active

  const filtered = useMemo(
    () => (dir === 'all' ? stream.chunks : stream.chunks.filter((c) => c.dir === dir)),
    [stream.chunks, dir],
  )

  const q = query.trim().toLowerCase()

  // ── 行视图（闭环事件行 + 监视行；监视未开时只有闭环证据）────────
  const monitorLines = useMemo(() => {
    if (q === '') return stream.lines
    return stream.lines.filter((l) => l.text.toLowerCase().includes(q))
  }, [stream.lines, q])

  const runLines = useMemo(() => {
    const all = props.runLines
    if (q === '') return all
    return all.filter((l) => l.text.toLowerCase().includes(q))
    // runLinesVersion 是命令式缓冲的重绘信号
  }, [props.runLines, props.runLinesVersion, q])

  // ── 字节视图（逐批投影；只渲染最近 MAX_BYTE_BLOCKS 批）──────────
  const byteBlocks = useMemo(() => {
    const list = filtered.slice(-MAX_BYTE_BLOCKS)
    return list.flatMap((c) => {
      const bytes = b64ToBytes(c.data_b64)
      let body: string
      if (repr === 'hex') body = hexDump(bytes).join('\n')
      else if (repr === 'ascii') body = textOf(bytes, 'ascii')
      else body = textOf(bytes, repr)
      const header = `#${c.seq} ${c.dir.toUpperCase()} ${c.t} · ${c.len} B`
      if (q !== '' && !header.toLowerCase().includes(q) && !body.toLowerCase().includes(q)) return []
      return [{ c, header, body }]
    })
  }, [filtered, repr, q])

  // ── 终端视图（增量喂入；切方向/编码/纪元时重建）────────────────
  const termEnc = repr === 'gbk' ? 'gbk' : 'utf8'
  const termLines = useMemo(() => {
    const key = `${dir}|${termEnc}|${epoch}`
    let st = termRef.current
    if (st === null || st.key !== key || (filtered.length === 0 && st.lastSeq > 0)) {
      st = { key, lastSeq: 0, term: new AnsiTerminal(), dec: new StreamTextDecoder(termEnc) }
      termRef.current = st
    }
    for (const c of filtered) {
      if (c.seq <= st.lastSeq) continue
      const bytes = b64ToBytes(c.data_b64)
      if (c.dir === 'tx') st.term.feed('\u001b[33m» \u001b[0m')
      st.term.feed(st.dec.decode(bytes))
      if (c.dir === 'tx' && bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) st.term.feed('\r\n')
      st.lastSeq = c.seq
    }
    return st.term.snapshot()
  }, [filtered, dir, termEnc, epoch])

  const shownTerm = useMemo(() => {
    if (q === '') return termLines
    return termLines.filter((ln) => termText(ln).toLowerCase().includes(q))
  }, [termLines, q])

  // ── 波形：对最近一段字节调用内核解码，Canvas 画多通道 ──────────
  const [frames, setFrames] = useState<number[][]>([])
  const [decodeMeta, setDecodeMeta] = useState<{ channels: number; skipped: number; pending: number } | null>(null)
  const [waveErr, setWaveErr] = useState<string | null>(null)

  // ── 会话级共享解码（P3.5）：decoder 非空 = 内核在 RX 入环时增量解码 ──
  //    面板直接画这份帧 → agent（elab_serial_decoded）与人看到的是同一张图。
  const sharedDecoder = stream.snap?.decode?.decoder ?? ''
  const sharedActive = sharedDecoder !== ''
  const sharedFrames = useMemo(() => stream.decoded.map((f) => f.values), [stream.decoded])
  const sharedState = sharedActive ? (stream.decodedSnap ?? stream.snap?.decode ?? null) : null
  const shownFrames = sharedActive ? sharedFrames : frames
  const shownChannels = sharedActive
    ? (stream.decodedSnap?.channels ?? (sharedFrames[0]?.length ?? 0))
    : (decodeMeta?.channels ?? (frames[0]?.length ?? 0))

  useEffect(() => {
    if (view !== 'wave' || sharedActive) return
    if (filtered.length === 0) {
      setFrames([])
      setDecodeMeta(null)
      return
    }
    let total = 0
    const picked: SerialChunk[] = []
    for (let i = filtered.length - 1; i >= 0; i -= 1) {
      if (total + filtered[i].len > MAX_WAVE_BYTES) break
      picked.unshift(filtered[i])
      total += filtered[i].len
    }
    const bytes = new Uint8Array(total)
    let off = 0
    for (const c of picked) {
      const b = b64ToBytes(c.data_b64)
      bytes.set(b, off)
      off += b.length
    }
    let cancelled = false
    api
      .serialDecode({ decoder, dataB64: bytesToB64(bytes), sessionId: props.sessionId })
      .then((r) => {
        if (cancelled) return
        if (!r.ok) {
          setWaveErr(r.error ?? '解码失败')
          setFrames([])
          return
        }
        setWaveErr(null)
        setFrames(r.frames)
        setDecodeMeta({ channels: r.channels, skipped: r.skipped, pending: r.pending_bytes })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setWaveErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [view, sharedActive, filtered, decoder, props.sessionId, api])

  // ── 跟随滚动 ────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight
  }, [view, monitorLines.length, runLines.length, byteBlocks.length, shownTerm.length, shownFrames.length, props.runLinesVersion])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== follow) setFollow(atBottom)
  }

  // ── 操作 ────────────────────────────────────────────────────
  const doCapture = useCallback(async (): Promise<void> => {
    setNotice(null)
    const cap = stream.snap?.capture as { active?: boolean } | null | undefined
    const active = cap?.active === true
    try {
      const r = await api.serialCapture({ action: active ? 'stop' : 'start', project, sessionId: props.sessionId })
      if (r.ok !== true) {
        setNotice(`✗ 录制失败：${String(r.error ?? '未知原因')}`)
        return
      }
      setNotice(
        active
          ? `■ 录制已停止：${String(r.path ?? '')}（${String(r.chunks ?? 0)} 批 / ${String(r.bytes ?? 0)} B${
              r.truncated === true ? '，到上限已截断' : ''
            }）`
          : `● 正在录制 → ${String(r.path ?? '')}（只存字节、有界）`,
      )
    } catch (e) {
      setNotice(`✗ 录制失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [stream.snap, project, props.sessionId, api])

  const doExport = useCallback((): void => {
    const raw = filtered.map((c) => ({ seq: c.seq, dir: c.dir, t: c.t, bytes: b64ToBytes(c.data_b64) }))
    const text = captureText(raw)
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `elab-serial-${stream.snap?.port ?? project ?? 'capture'}.txt`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }, [filtered, stream.snap, project])

  const doSend = useCallback(
    async (e: { preventDefault(): void }): Promise<void> => {
      e.preventDefault()
      if (draft.trim() === '' || running) return
      setNotice(null)
      try {
        const r = await stream.send(draft, {
          format: sendFormat,
          eol: sendFormat === 'hex' ? 'none' : eol,
        })
        if (!r.ok) {
          setNotice(`✗ 发送失败：${r.error ?? '未知原因'}`)
          return
        }
        setNotice(
          `✓ 已发送 ${r.written} B → ${r.port}@${r.baud}` + (r.via === 'monitor' ? '（经监视会话，回显见实时流）' : ''),
        )
        setDraft('')
      } catch (err) {
        setNotice(`✗ ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [draft, running, sendFormat, eol, stream],
  )

  const bytesTotal = stream.snap?.bytes_total ?? 0
  const chunkCount = stream.chunks.length
  const lossy = stream.gapLines + stream.gapChunks
  // 会话归属 + agent 租约倒计时：快照每 500ms 刷新，直接显示服务端剩余秒数即可
  const openedBy = stream.snap?.opened_by
  const leaseLeft = Math.max(0, Math.ceil(stream.snap?.lease_remaining_s ?? 0))
  const cap = stream.snap?.capture as { active?: boolean; truncated?: boolean; path?: string; bytes?: number; chunks?: number } | null | undefined
  const capActive = cap?.active === true

  const reachable = stream.active || running
  const sendDisabled = running || !writable

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {/* ── 工具条：视图切换 + 方向/表示/解码器 + 会话动作（窄栏自动换行） ── */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '5px 12px',
          borderBottom: '1px solid var(--elab-border)',
          flexWrap: 'wrap',
          minWidth: 0,
        }}
      >
        {VIEW_TABS.map((t) => {
          const active = t.id === view
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setView(t.id)}
              style={{
                ...chip,
                borderColor: active ? 'var(--elab-accent)' : 'var(--elab-border)',
                background: active ? 'var(--elab-bg-raised)' : 'transparent',
                color: active ? 'var(--elab-fg-primary)' : 'var(--elab-fg-muted)',
              }}
            >
              {t.label}
            </button>
          )
        })}
        <span style={{ flex: '1 1 auto' }} />
        <select
          value={port || 'auto'}
          onChange={(e: any) => props.onPort?.(e.currentTarget.value)}
          aria-label="串口端口"
          title={
            portLocked
              ? '监视进行中：先关闭监视再换端口（换口会重开串口）'
              : '选择串口；auto = 内核按 USB 优先自动解析（有歧义时会报错而不是猜）'
          }
          style={{ ...selectStyle, maxWidth: '150px', opacity: portLocked ? 0.5 : 1, cursor: portLocked ? 'not-allowed' : 'pointer' }}
          disabled={portLocked || props.onPort === undefined}
        >
          <option value="auto">{'auto（自动选口）'}</option>
          {portOptions.map((p) => (
            <option key={p.name} value={p.name} title={p.label}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          value={baud}
          onChange={(e: any) => props.onBaud?.(Number(e.currentTarget.value))}
          aria-label="串口波特率"
          title={portLocked ? '监视进行中：先关闭监视再换波特率' : '波特率：下一次打开监视时生效'}
          style={{ ...selectStyle, opacity: portLocked ? 0.5 : 1, cursor: portLocked ? 'not-allowed' : 'pointer' }}
          disabled={portLocked || props.onBaud === undefined}
        >
          {baudOptions(baud).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select
          value={dir}
          onChange={(e: any) => setDir(e.currentTarget.value === 'rx' ? 'rx' : e.currentTarget.value === 'tx' ? 'tx' : 'all')}
          aria-label="方向过滤"
          title="按方向过滤（TX = 我发出去的，RX = 设备发来的）"
          style={selectStyle}
        >
          {DIRS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <select
          value={repr}
          onChange={(e: any) => setRepr(
            e.currentTarget.value === 'ascii' ? 'ascii' : e.currentTarget.value === 'utf8' ? 'utf8' : e.currentTarget.value === 'gbk' ? 'gbk' : 'hex',
          )}
          aria-label="字节表示"
          title={view === 'terminal' ? '终端编码（HEX/ASCII 在终端里按 UTF-8）' : '字节的显示表示'}
          style={selectStyle}
        >
          {REPRS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        {view === 'wave' ? (
          <select
            value={sharedActive ? sharedDecoder : decoder}
            onChange={(e: any) => {
              const next = e.currentTarget.value
              setDecoder(next) // 无会话时的本地解码兜底
              // 有会话：decoder 是**会话属性**，写进去才与 agent 同源同图
              if (stream.active) void stream.setDecoder(next)
            }}
            aria-label="协议解码器"
            title={
              sharedActive
                ? `共享解码（${stream.snap?.decode?.decoder_by === 'agent' ? 'agent 选定' : '人选定'}）：面板与 agent 读同一份帧`
                : (decoders.find((d) => d.id === decoder)?.desc ?? '协议解码器')
            }
            style={selectStyle}
          >
            {decoders.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          disabled={!reachable}
          onClick={() => void stream.setPaused(!stream.paused)}
          title={stream.paused ? '继续入环（服务端仍在读口）' : '暂停入环（服务端继续读口，不撑爆设备缓冲）'}
          style={{ ...chip, opacity: !reachable ? 0.5 : 1, cursor: !reachable ? 'not-allowed' : 'pointer' }}
        >
          {stream.paused ? '继续' : '暂停'}
        </button>
        <button
          type="button"
          disabled={!reachable}
          onClick={() => void doCapture()}
          title={capActive ? '停止录制（文件保留，可回放）' : '开始录制：把原始字节写成有界 JSONL（证据，不是文本投影）'}
          style={{
            ...chip,
            borderColor: capActive ? 'var(--elab-status-fail)' : 'var(--elab-border)',
            color: capActive ? 'var(--elab-status-fail)' : 'var(--elab-fg-secondary)',
            opacity: !reachable ? 0.5 : 1,
            cursor: !reachable ? 'not-allowed' : 'pointer',
          }}
        >
          {capActive ? '停止录制' : '录制'}
        </button>
        <button
          type="button"
          disabled={!stream.active}
          onClick={() => void stream.clear()}
          title="清空服务端与本地缓冲（序号保持单调）"
          style={{ ...chip, opacity: stream.active ? 1 : 0.5, cursor: stream.active ? 'pointer' : 'not-allowed' }}
        >
          {'清空'}
        </button>
        <button type="button" onClick={doExport} title="导出当前过滤结果的原始字节（HEX + 元数据）" style={chip}>
          {'导出'}
        </button>
      </div>

      {/* ── 搜索 / 跟随 / 计数（与融合工程的 subbar 同构） ── */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '5px 12px',
          borderBottom: '1px solid var(--elab-border)',
          minWidth: 0,
        }}
      >
        <input
          value={query}
          onChange={(e: any) => setQuery(e.currentTarget.value)}
          placeholder="搜索（大小写不敏感；行/字节/终端可用）"
          aria-label="搜索串口流"
          style={{
            flex: '0 1 260px',
            minWidth: '120px',
            padding: '1px 6px',
            fontSize: 'var(--elab-fs-xs)',
            fontFamily: 'var(--elab-font-mono)',
            borderRadius: 'var(--elab-radius-sm)',
            border: '1px solid var(--elab-border)',
            background: 'var(--elab-bg-surface)',
            color: 'var(--elab-fg-primary)',
          }}
        />
        {q !== '' ? (
          <span style={metaStyle} title="搜索命中数 / 当前视图总行数">
            {view === 'lines' ? `${monitorLines.length}/${stream.lines.length} 行` : '已过滤'}
          </span>
        ) : null}
        <span style={{ flex: '1 1 auto' }} />
        <button
          type="button"
          onClick={() => setFollow((v) => !v)}
          title={follow ? '正在跟随最新输出；点击暂停' : '已暂停跟随；点击恢复'}
          style={{
            ...chip,
            background: 'transparent',
            color: follow ? 'var(--elab-accent)' : 'var(--elab-fg-dimmed)',
          }}
        >
          {follow ? '\u25be 跟随' : '\u21ba 恢复'}
        </button>
        <span style={metaStyle} title="当前缓冲：未清空、未被环形挤出的字节 / 批次">
          {`${bytesTotal} B · ${chunkCount} 批`}
        </span>
        {stream.active && openedBy !== undefined ? (
          <span
            style={{
              ...metaStyle,
              color: openedBy === 'agent' ? 'var(--elab-accent)' : 'var(--elab-fg-muted)',
            }}
            title="串口会话归属与租约：agent 开的会话到期自动关闭并释放给人工"
          >
            {`会话 ${openedBy === 'agent' ? 'agent' : '我'}${leaseLeft > 0 ? ` · 租约 ${leaseLeft}s` : ''}`}
          </span>
        ) : null}
      </div>

      {/* ── 提示条 ── */}
      {stream.error !== null ? (
        <div role="alert" style={barWarn}>
          {`监视已中断：${stream.error}（服务端已释放串口）`}
        </div>
      ) : null}
      {stream.paused ? (
        <div style={barInfo}>{'已暂停入环 —— 服务端仍在读口；点「继续」恢复。'}</div>
      ) : null}
      {capActive !== true && cap?.truncated === true ? (
        <div style={barWarn}>
          {`录制已到上限并停止：${String(cap?.path ?? '')}（${String(cap?.chunks ?? 0)} 批 / ${String(cap?.bytes ?? 0)} B）—— 证据文件已保留，可回放`}
        </div>
      ) : null}
      {lossy > 0 ? (
        <div style={barWarn}>
          {`环形缓冲已挤出：行 ≥${stream.gapLines} / 批次 ≥${stream.gapChunks}（只报告不抹平；完整留档请用「导出」或闭环 monitor 事件）`}
        </div>
      ) : null}

      {/* ── 内容区 ── */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'auto',
          background: 'var(--elab-bg-raised)',
          fontFamily: 'var(--elab-font-mono)',
          fontSize: 'var(--elab-fs-xs)',
          lineHeight: 1.55,
        }}
      >
        {view === 'lines' ? (
          runLines.length === 0 && monitorLines.length === 0 ? (
            <div style={emptyStyle}>
              {'尚无行输出。点上方「▶ 串口」启动常驻监视后，设备输出会实时流进来。'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', padding: '2px 0' }}>
              {runLines.map((line, i) => (
                <div
                  key={`run-${i}`}
                  style={{
                    padding: '0 12px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: line.tone === 'alert' ? 'var(--elab-status-fail)' : line.tone === 'warn' ? 'var(--elab-status-run)' : 'var(--elab-fg-primary)',
                    fontWeight: line.tone === 'alert' ? 600 : 400,
                  }}
                >
                  <AnsiLine text={line.text} query={query.trim()} />
                </div>
              ))}
              {runLines.length > 0 && monitorLines.length > 0 ? (
                <div style={{ padding: '2px 12px', fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-faint)' }}>{'—— 常驻监视 ——'}</div>
              ) : null}
              {monitorLines.map((l) => (
                <div key={`mon-${l.seq}`} style={{ display: 'flex', gap: '8px', padding: '0 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  <span style={{ flex: '0 0 auto', color: 'var(--elab-fg-faint)', fontVariantNumeric: 'tabular-nums' }}>{l.t}</span>
                  <span style={{ flex: '0 0 auto', minWidth: '42px', textAlign: 'right', color: 'var(--elab-fg-faint)', fontVariantNumeric: 'tabular-nums' }}>{`#${l.seq}`}</span>
                  <span style={{ flex: '1 1 auto', minWidth: 0, color: 'var(--elab-fg-primary)' }}>
                    <AnsiLine text={l.text} query={query.trim()} />
                  </span>
                </div>
              ))}
            </div>
          )
        ) : null}

        {view === 'bytes' ? (
          byteBlocks.length === 0 ? (
            <div style={emptyStyle}>
              {'尚无字节。启动监视后设备输出以 RX 批次流进来；你发送的内容是 TX 批次。'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 12px' }}>
              {byteBlocks.map(({ c, header, body }) => (
                <div key={c.seq} style={{ border: '1px solid var(--elab-border)', borderRadius: 'var(--elab-radius-sm)', overflow: 'hidden', background: 'var(--elab-bg-surface)' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '2px 8px',
                      fontSize: 'var(--elab-fs-xs)',
                      borderBottom: '1px solid var(--elab-border)',
                      color: c.dir === 'tx' ? 'var(--elab-status-run)' : 'var(--elab-status-ok)',
                      background: c.dir === 'tx' ? 'color-mix(in srgb, var(--elab-status-run) 10%, transparent)' : 'color-mix(in srgb, var(--elab-status-ok) 8%, transparent)',
                    }}
                  >
                    <span style={{ fontWeight: 700, letterSpacing: '0.04em' }}>{c.dir.toUpperCase()}</span>
                    <span style={{ flex: '0 0 auto', color: 'var(--elab-fg-faint)', fontVariantNumeric: 'tabular-nums' }}>{c.t}</span>
                    <span
                      style={{
                        flex: '1 1 auto',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: 'var(--elab-fg-faint)',
                      }}
                    >
                      {`${header} · ${c.t_us}μs`}
                    </span>
                  </div>
                  <pre style={{ margin: 0, padding: '4px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--elab-fg-primary)' }}>
                    {body}
                  </pre>
                </div>
              ))}
            </div>
          )
        ) : null}

        {view === 'terminal' ? (
          shownTerm.length === 0 ? (
            <div style={emptyStyle}>{'尚无终端内容。ANSI 颜色、`\\r` 覆写与退格都已按终端语义处理。'}</div>
          ) : (
            <div style={{ padding: '8px 12px', whiteSpace: 'pre', minHeight: '100%' }}>
              {shownTerm.map((ln, i) => (
                <div key={i} style={{ minHeight: '1.55em' }}>
                  {ln.length === 0
                    ? '\u00a0'
                    : ln.map((sp, j) => (
                        <span key={j} className={sp.cls}>
                          {sp.text}
                        </span>
                      ))}
                </div>
              ))}
            </div>
          )
        ) : null}

        {view === 'wave' ? (
          <div style={{ padding: '8px 12px' }}>
            {sharedActive ? (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '6px',
                  marginBottom: '6px',
                  fontSize: 'var(--elab-fs-xs)',
                }}
              >
                <span style={waveBadge}>{'共享解码'}</span>
                <span
                  style={{
                    ...waveBadge,
                    borderColor: stream.snap?.decode?.decoder_by === 'agent'
                      ? 'var(--elab-accent)'
                      : 'var(--elab-border)',
                    color: stream.snap?.decode?.decoder_by === 'agent'
                      ? 'var(--elab-accent)'
                      : 'var(--elab-fg-muted)',
                  }}
                >
                  {stream.snap?.decode?.decoder_by === 'agent' ? 'agent 选定' : '人选定'}
                </span>
                <span style={{ color: 'var(--elab-fg-faint)' }}>
                  {`${decoders.find((d) => d.id === sharedDecoder)?.label ?? sharedDecoder} · 内核只解 RX（设备输出）`}
                </span>
              </div>
            ) : null}
            {waveErr !== null ? <div style={barWarn}>{`解码失败：${waveErr}`}</div> : null}
            {waveErr === null && shownFrames.length === 0 ? (
              <div style={emptyStyle}>
                {sharedActive
                  ? `尚未解出帧：${decoders.find((d) => d.id === sharedDecoder)?.label ?? sharedDecoder} 解码器已在会话启用，设备开始输出符合该协议的字节后会在这里出现折线（agent 读到的也是这份帧）。`
                  : `尚无波形。设备按 ${decoders.find((d) => d.id === decoder)?.label ?? decoder} 输出（JustFloat：N×4 小端 float + 尾 00 00 80 7F）时，这里按通道画折线。`}
                {sharedActive === false && decodeMeta !== null && decodeMeta.skipped > 0 ? (
                  <>
                    <br />
                    {`当前窗口未解出完整帧（跳过 ${decodeMeta.skipped} 段${decodeMeta.pending > 0 ? `、残留 ${decodeMeta.pending} B` : ''}）—— 这段流里混有不属于该协议的字节，可用方向过滤只看设备帧输出。`}
                  </>
                ) : null}
              </div>
            ) : null}
            {shownFrames.length > 0 ? <WaveChart frames={shownFrames} channels={shownChannels} /> : null}
            {sharedActive && sharedState !== null ? (
              <div style={{ marginTop: '8px', fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-faint)' }}>
                {`${shownFrames.length} 帧（显示）· 共 ${sharedState.total_frames} 帧 · ${sharedState.channels} 通道` +
                  `${sharedState.skipped > 0 ? ` · 跳过 ${sharedState.skipped}` : ''}` +
                  `${sharedState.pending_bytes > 0 ? ` · 半帧 ${sharedState.pending_bytes} B（下一批续解）` : ''}` +
                  `${sharedState.covered > 0 ? ` · 帧环挤出 ${sharedState.covered}` : ''}` +
                  `${stream.gapDecoded > 0 ? ` · 面板漏拉 ${stream.gapDecoded}` : ''}`}
              </div>
            ) : null}
            {sharedActive === false && decodeMeta !== null ? (
              <div style={{ marginTop: '8px', fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-faint)' }}>
                {`${frames.length} 帧 · ${decodeMeta.channels} 通道${decodeMeta.skipped > 0 ? ` · 跳过 ${decodeMeta.skipped}` : ''}${decodeMeta.pending > 0 ? ` · 半帧 ${decodeMeta.pending} B（下一轮续解）` : ''}`}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ── 发送面板：与监视会话同一个口（写穿，不重开）── */}
      <form
        onSubmit={(e: any) => void doSend(e)}
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderTop: '1px solid var(--elab-border)',
          background: 'var(--elab-bg-surface)',
          flexWrap: 'wrap',
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          aria-hidden="true"
          style={{ flex: '0 0 auto', color: 'var(--elab-fg-faint)' }}
        >
          <path
            d="M2 2.5 6.5 8 2 13.5M7.5 13.5H14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <select
          value={sendFormat}
          onChange={(e: any) => setSendFormat(e.currentTarget.value)}
          aria-label="发送格式"
          title="发送表示：HEX 模式按十六进制解析，且不追加行尾"
          style={selectStyle}
        >
          {FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          value={eol}
          onChange={(e: any) => setEol(e.currentTarget.value)}
          aria-label="行结束符"
          disabled={sendFormat === 'hex'}
          title={sendFormat === 'hex' ? 'HEX 模式不追加行尾（二进制帧多一个字节就是错）' : '追加的行结束符'}
          style={{ ...selectStyle, opacity: sendFormat === 'hex' ? 0.5 : 1 }}
        >
          {EOLS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <input
          value={draft}
          onChange={(e: any) => setDraft(e.currentTarget.value)}
          disabled={sendDisabled}
          placeholder={
            running
              ? '有 run 在跑：串口与 run 互斥（N5），等它结束'
              : sendFormat === 'hex'
                ? '输入十六进制，如 01 A0 FF'
                : '输入一行并按回车发送到设备'
          }
          aria-label="串口发送内容"
          style={{
            flex: '1 1 120px',
            minWidth: 0,
            padding: '2px 8px',
            fontSize: 'var(--elab-fs-xs)',
            fontFamily: 'var(--elab-font-mono)',
            borderRadius: 'var(--elab-radius-sm)',
            border: '1px solid var(--elab-border)',
            background: 'var(--elab-bg-surface)',
            color: 'var(--elab-fg-primary)',
          }}
        />
        <button
          type="submit"
          disabled={sendDisabled || draft.trim() === ''}
          title={writable ? '发送到设备' : '串口写通道不可用'}
          style={{
            ...chip,
            padding: '2px 10px',
            fontWeight: 600,
            borderColor: 'var(--elab-btn-primary-border)',
            background: sendDisabled ? 'transparent' : 'var(--elab-btn-primary-bg)',
            color: sendDisabled ? 'var(--elab-fg-dimmed)' : 'var(--elab-btn-primary-fg)',
            cursor: sendDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          {'发送'}
        </button>
      </form>

      {notice !== null ? (
        <div role="status" style={noticeStyle(notice.startsWith('✗'))}>
          {notice}
        </div>
      ) : null}
      {project === '' ? (
        <div style={barInfo}>{'未选择工程：端口/波特率无法解析（先在顶部选一个工程）。'}</div>
      ) : null}
      {stream.active !== true && running !== true ? (
        <div
          style={{
            flex: '0 0 auto',
            padding: '5px 12px',
            fontSize: 'var(--elab-fs-xs)',
            color: 'var(--elab-fg-faint)',
            borderTop: '1px solid var(--elab-border)',
          }}
        >
          {`监视未启动（${port || 'auto'}@${baud}）—— 点上方「▶ 串口」启动。`}
        </div>
      ) : null}
    </div>
  )
}

/** Canvas 多通道折线：每通道独立归一化（同一屏里量纲不同也能看清形状）。 */
function WaveChart(props: { frames: number[][]; channels: number }): ReactNode {
  const { frames, channels } = props
  const hostRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = hostRef.current
    if (canvas === null || frames.length === 0) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth || 480
    const h = canvas.clientHeight || 200
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const css = getComputedStyle(canvas)
    const cvar = (name: string): string => css.getPropertyValue(name).trim()
    const border = cvar('--elab-border') || cvar('--elab-fg-dimmed')
    const palette = [
      '--elab-ansi-bright-blue',
      '--elab-ansi-bright-green',
      '--elab-ansi-bright-red',
      '--elab-ansi-bright-yellow',
      '--elab-ansi-bright-magenta',
      '--elab-ansi-bright-cyan',
      '--elab-ansi-blue',
      '--elab-ansi-green',
    ]
    // 取不到令牌时退回前景色（不写字面色值：色源只有 dsw-map.ts）
    const fallback = cvar('--elab-fg-primary')
    const colors = palette.map((p) => cvar(p) || fallback)

    ctx.strokeStyle = border
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i += 1) {
      const y = (h * i) / 4
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }

    const n = frames.length
    for (let ch = 0; ch < channels; ch += 1) {
      const values = frames.map((f) => (ch < f.length ? f[ch] : 0))
      let lo = Infinity
      let hi = -Infinity
      for (const v of values) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
      if (hi === lo) {
        hi = lo + 1
        lo -= 1
      }
      ctx.strokeStyle = colors[ch % colors.length]
      ctx.lineWidth = 1.4
      ctx.beginPath()
      for (let i = 0; i < n; i += 1) {
        const x = n === 1 ? w / 2 : (i / (n - 1)) * w
        const y = h - ((values[i] - lo) / (hi - lo)) * h
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }, [frames, channels])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <canvas
        ref={hostRef}
        style={{ width: '100%', height: '220px', display: 'block', background: 'var(--elab-bg-surface)', border: '1px solid var(--elab-border)', borderRadius: 'var(--elab-radius-sm)' }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-secondary)' }}>
        {Array.from({ length: Math.max(0, channels) }, (_, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '2px',
                background: `var(--elab-ansi-${
                  ['bright-blue', 'bright-green', 'bright-red', 'bright-yellow', 'bright-magenta', 'bright-cyan', 'blue', 'green'][i % 8]
                })`,
              }}
            />
            {`CH${i}`}
          </span>
        ))}
      </div>
    </div>
  )
}
