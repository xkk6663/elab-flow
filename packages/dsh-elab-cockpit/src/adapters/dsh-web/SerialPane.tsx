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
import type { SerialChunk, SerialWidget, SerialWidgetsDoc, SerialWidgetRunResult } from '../../domain/icd.ts'
import {
  b64ToBytes,
  bytesToB64,
  captureText,
  hexDump,
  hexDumpRows,
  parseAnsi,
  textOf,
} from '@elab/cockpit-ui-core'
import type { HexRow, SerialRepr } from '@elab/cockpit-ui-core'
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
  { id: 'tab', label: 'TAB' },
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

/** 发送历史（↑/↓ 调取）：只留最近 N 条，跨会话记忆。 */
const HISTORY_KEY = 'elab.serial.send.history'
const HISTORY_MAX = 50
/** 文件按行发送的行数上限（按行逐条发，太多行会把发送面板占住很久）。 */
const MAX_FILE_LINES = 2000

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(-HISTORY_MAX) : []
  } catch {
    return []
  }
}

function saveHistory(items: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(-HISTORY_MAX)))
  } catch {
    // 隐私模式/配额满：历史只是便利，不写也不影响发送
  }
}

/** 参数控件里都是字符串；提交前按组件声明的类型转成 JSON 值（服务端还会再校验一次）。 */
function coerceWidgetParams(w: SerialWidget, raw: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of w.params) {
    const v = raw[p.name] ?? ''
    if (p.type === 'int') {
      const n = Number.parseInt(v, 10)
      out[p.name] = Number.isNaN(n) ? v : n
    } else if (p.type === 'float') {
      const n = Number(v)
      out[p.name] = Number.isNaN(n) ? v : n
    } else if (p.type === 'bool') {
      out[p.name] = v === 'true' || v === '1'
    } else {
      out[p.name] = v
    }
  }
  return out
}

/** 预览字节 → HEX（服务端返回的 preview_b64 是唯一的发送字节；与宽栏同一展示口径）。 */
function widgetHex(b64: string | undefined): string {
  if (b64 === undefined || b64 === '') return ''
  try {
    return Array.from(b64ToBytes(b64))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .toUpperCase()
  } catch {
    return ''
  }
}

const BYTE_COLORS: Record<HexRow['cells'][number]['cls'], string> = {
  ctl: 'var(--elab-ansi-bright-yellow)',
  del: 'var(--elab-ansi-bright-red)',
  print: 'var(--elab-fg-primary)',
  high: 'var(--elab-ansi-bright-cyan)',
  pad: 'var(--elab-fg-faint)',
}

/** 回放的行上限（与实时本地上限同量级；更早的只影响行视图，字节/波形仍按窗口取）。 */
const MAX_REPLAY_LINES = 5000

interface ReplayData {
  name: string
  chunks: SerialChunk[]
  lines: Array<{ seq: number; text: string; t: string }>
  bytes: number
  skipped: number
}

function hmsOf(us: number): string {
  const d = new Date(Math.floor(us / 1000))
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/**
 * 解析录制 JSONL（`{"seq","t_us","dir","bytes_b64"}` 每行一条）。
 *
 * 回放是**纯前端只读**：不打开串口、不写内核会话；行视图按服务端同一规则
 * （RX 字节 + `\n` 切行 + 静默残留冲刷不参与）在本地重建。
 */
function parseReplay(name: string, text: string): { data: ReplayData | null; error: string } {
  const chunks: SerialChunk[] = []
  let skipped = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const rec = JSON.parse(line) as { seq?: unknown; t_us?: unknown; dir?: unknown; bytes_b64?: unknown }
      if (typeof rec.bytes_b64 !== 'string' || typeof rec.seq !== 'number' || typeof rec.t_us !== 'number') {
        skipped += 1
        continue
      }
      const bytes = b64ToBytes(rec.bytes_b64)
      chunks.push({
        seq: rec.seq,
        dir: rec.dir === 'tx' ? 'tx' : 'rx',
        t: hmsOf(rec.t_us),
        t_us: rec.t_us,
        len: bytes.length,
        data_b64: rec.bytes_b64,
      })
    } catch {
      skipped += 1
    }
  }
  if (chunks.length === 0) {
    return { data: null, error: `没有可回放的批次（跳过 ${skipped} 行）` }
  }
  chunks.sort((a, b) => a.seq - b.seq)

  const lines: Array<{ seq: number; text: string; t: string }> = []
  const dec = new TextDecoder('utf-8', { fatal: false })
  let pending = ''
  let seq = 0
  for (const c of chunks) {
    if (c.dir !== 'rx') continue
    pending += dec.decode(b64ToBytes(c.data_b64), { stream: true })
    let idx = pending.indexOf('\n')
    while (idx >= 0) {
      const raw = pending.slice(0, idx)
      pending = pending.slice(idx + 1)
      seq += 1
      lines.push({ seq, text: raw.replace(/\r$/, ''), t: c.t.slice(0, 8) })
      idx = pending.indexOf('\n')
    }
  }
  const rest = pending + dec.decode()
  if (rest !== '') {
    seq += 1
    lines.push({ seq, text: rest.replace(/\r$/, ''), t: chunks[chunks.length - 1].t.slice(0, 8) })
  }
  const kept = lines.length > MAX_REPLAY_LINES ? lines.slice(-MAX_REPLAY_LINES) : lines
  const bytes = chunks.reduce((n, c) => n + c.len, 0)
  return { data: { name, chunks, lines: kept, bytes, skipped }, error: '' }
}

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
  /** 上次选定的解码器（跨会话记忆；'' = 显式关闭共享解码）。 */
  decoderPref?: string
  /** 解码器偏好变化（上层负责持久化；'' 表示关闭共享解码）。 */
  onDecoder?: (decoder: string) => void
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

/** 组件参数输入（窄栏里尽量小；宽度按类型由 width 决定） */
const widgetInputStyle: React.CSSProperties = {
  flex: '0 0 auto',
  height: '20px',
  padding: '0 4px',
  fontFamily: 'var(--elab-font-mono)',
  fontSize: 'var(--elab-fs-xs)',
  color: 'var(--elab-fg-primary)',
  background: 'var(--elab-bg-surface)',
  border: '1px solid var(--elab-border)',
  borderRadius: 'var(--elab-radius-sm)',
  width: '6.5em',
}

const widgetBarStyle: React.CSSProperties = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  padding: '4px 12px',
  borderTop: '1px solid var(--elab-border)',
  background: 'var(--elab-bg-surface)',
  flexWrap: 'wrap',
  minWidth: 0,
}

const widgetTitleStyle: React.CSSProperties = {
  flex: '0 0 auto',
  fontSize: 'var(--elab-fs-xs)',
  color: 'var(--elab-fg-faint)',
  letterSpacing: '0.04em',
  marginRight: '2px',
}

const widgetChipStyle: React.CSSProperties = {
  flex: '0 0 auto',
  padding: '2px 8px',
  fontFamily: 'var(--elab-font-mono)',
  fontSize: 'var(--elab-fs-xs)',
  lineHeight: 1.4,
  background: 'var(--elab-bg-code)',
  color: 'var(--elab-fg-secondary)',
  border: '1px solid var(--elab-border)',
  borderRadius: 'var(--elab-radius-sm)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/**
 * 选中态：**描边 + 浅底 + 加粗**，不用「品牌填充 + 反白字」。
 * §15.6b 的教训在本宿主主题上重演：`--elab-accent` 映射的 brand-primary 在这里
 * 是近白，白底白字 = 选中项直接消失；而 accent 本身又和正文色同值，
 * 只靠文字色也分不出来。故强调走「可读的三重信号」：实心 accent 描边 + 浅色
 * 悬停底 + 加粗字形 —— 任意主题下都能看出选中了哪个。
 */
const widgetChipOnStyle: React.CSSProperties = {
  ...widgetChipStyle,
  background: 'var(--elab-btn-primary-bg)',
  color: 'var(--elab-fg-primary)',
  borderColor: 'var(--elab-accent)',
  fontWeight: 600,
}

const widgetErrStyle: React.CSSProperties = {
  flex: '0 0 auto',
  fontSize: 'var(--elab-fs-xs)',
  color: 'var(--elab-status-fail)',
  cursor: 'help',
}

const widgetPanelStyle: React.CSSProperties = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexWrap: 'wrap',
  padding: '5px 12px',
  borderTop: '1px dashed var(--elab-border)',
  background: 'color-mix(in srgb, var(--elab-btn-primary-bg) 35%, transparent)',
  minWidth: 0,
}

const widgetPreviewStyle: React.CSSProperties = {
  flex: '0 1 auto',
  minWidth: 0,
  fontFamily: 'var(--elab-font-mono)',
  fontSize: 'var(--elab-fs-xs)',
  color: 'var(--elab-fg-faint)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const widgetLabelStyle: React.CSSProperties = {
  fontSize: 'var(--elab-fs-xs)',
  color: 'var(--elab-fg-dimmed)',
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
  /** 发送历史（↑/↓ 调取；只留最近 HISTORY_MAX 条，跨会话记忆）。 */
  const [history, setHistory] = useState<string[]>(loadHistory)
  const [histIdx, setHistIdx] = useState(-1)
  const [fileBusy, setFileBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [replay, setReplay] = useState<ReplayData | null>(null)
  const [replayErr, setReplayErr] = useState<string | null>(null)
  const replayRef = useRef<HTMLInputElement | null>(null)
  // 发送组件（M2）：下拉 + 类型化参数 + 服务端预览 + 异步任务（轮询/暂停/停止）
  const [widgetDoc, setWidgetDoc] = useState<SerialWidgetsDoc | null>(null)
  const [widgetId, setWidgetId] = useState('')
  const [widgetParams, setWidgetParams] = useState<Record<string, string>>({})
  const [widgetPreview, setWidgetPreview] = useState('')
  const [widgetErr, setWidgetErr] = useState<string | null>(null)
  const [widgetBusy, setWidgetBusy] = useState(false)
  const [widgetJob, setWidgetJob] = useState<SerialWidgetRunResult | null>(null)
  const [widgetJobId, setWidgetJobId] = useState('')
  // 本地解码兜底：上次偏好优先；'' = 用户显式关闭共享解码（也不本地解码）。
  const [decoder, setDecoder] = useState(props.decoderPref ?? decoders[0]?.id ?? 'justfloat')

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
  /** 回放是纯前端只读数据源：不占串口、不动内核会话。 */
  const replayMode = replay !== null
  const sourceChunks = replayMode ? replay.chunks : stream.chunks

  const filtered = useMemo(
    () => (dir === 'all' ? sourceChunks : sourceChunks.filter((c) => c.dir === dir)),
    [sourceChunks, dir],
  )

  const q = query.trim().toLowerCase()

  // ── 行视图（闭环事件行 + 监视行；监视未开时只有闭环证据）────────
  const monitorLines = useMemo(() => {
    const base = replayMode && replay !== null ? replay.lines : stream.lines
    if (q === '') return base
    return base.filter((l) => l.text.toLowerCase().includes(q))
  }, [stream.lines, replay, replayMode, q])

  const runLines = useMemo(() => {
    if (replayMode) return [] // 回放只重放录制内容，不混入当前 run 的事件行
    const all = props.runLines
    if (q === '') return all
    return all.filter((l) => l.text.toLowerCase().includes(q))
    // runLinesVersion 是命令式缓冲的重绘信号
  }, [props.runLines, props.runLinesVersion, q, replayMode])

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
      return [{ c, header, body, rows: repr === 'hex' ? hexDumpRows(bytes) : null }]
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
  const sharedActive = replayMode ? false : sharedDecoder !== ''
  const sharedFrames = useMemo(() => stream.decoded.map((f) => f.values), [stream.decoded])
  const sharedState = sharedActive ? (stream.decodedSnap ?? stream.snap?.decode ?? null) : null
  const shownFrames = sharedActive ? sharedFrames : frames
  const shownChannels = sharedActive
    ? (stream.decodedSnap?.channels ?? (sharedFrames[0]?.length ?? 0))
    : (decodeMeta?.channels ?? (frames[0]?.length ?? 0))

  useEffect(() => {
    if (view !== 'wave' || sharedActive) return
    if (decoder === '') {
      // 用户显式关闭共享解码，也不做本地解码兜底
      setFrames([])
      setDecodeMeta(null)
      return
    }
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
      .serialDecode({
        decoder,
        dataB64: bytesToB64(bytes),
        ...(replayMode ? {} : { sessionId: props.sessionId }),
      })
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
  }, [view, sharedActive, filtered, decoder, props.sessionId, api, replayMode])

  // ── 波形多面板 + 通道绑定 ──────────────────────────────────────
  interface WaveViewport {
    id: string
    name: string
    channels: number[]
    /** 每个面板独立持有的视图（切 tab 不串味） */
    scaleX: number
    offsetX: number
  }
  const [waveViewports, setWaveViewports] = useState<WaveViewport[]>([])
  const [activeViewport, setActiveViewport] = useState<string>('')
  const [viewportFollow, setViewportFollow] = useState<Record<string, boolean>>({})

  // 当解码出帧时，初始化默认 viewport
  // ★ 只在"解码通道总数变大"时重建（理由同 cockpit/web：通道数在 1↔2 抖动会冲掉用户面板）
  const lastTotalChDsh = useRef(0)
  useEffect(() => {
    const totalCh = shownChannels
    if (totalCh === 0) return
    const needInit = waveViewports.length === 0
    const grew = totalCh > lastTotalChDsh.current
    lastTotalChDsh.current = Math.max(lastTotalChDsh.current, totalCh)
    if (!needInit && !grew) return
    const allVp: WaveViewport = { id: 'all', name: '全部', channels: Array.from({ length: totalCh }, (_, i) => i), scaleX: 1, offsetX: 0 }
    setWaveViewports([allVp])
    setActiveViewport('all')
    setViewportFollow({ all: follow })
  }, [shownChannels])

  // 顶层「跟随」开关：一次性把当前所有面板的 follow 对齐到开关状态。
  // ★ 不做成 effect：新增面板/通道增长时不该把用户**手动暂停**的面板拉回跟随。
  const setFollowAll = (v: boolean) => {
    setFollow(v)
    setViewportFollow((prev) => {
      const next = { ...prev }
      for (const vp of waveViewports) next[vp.id] = v
      return next
    })
  }

  const addWaveViewport = () => {
    const totalCh = shownChannels
    if (totalCh === 0) return
    const id = `vp_${Date.now().toString(36)}`
    setWaveViewports((vps) => [
      ...vps,
      { id, name: `面板 ${vps.length + 1}`, channels: Array.from({ length: totalCh }, (_, i) => i), scaleX: 1, offsetX: 0 },
    ])
    setViewportFollow((f) => ({ ...f, [id]: follow }))
    setActiveViewport(id)
  }
  const removeWaveViewport = (id: string) => {
    setWaveViewports((vps) => {
      const rest = vps.filter((v) => v.id !== id)
      if (rest.length === 0) return vps
      if (activeViewport === id) setActiveViewport(rest[rest.length - 1].id)
      return rest
    })
    setViewportFollow((f) => { const { [id]: _gone, ...rest } = f; return rest })
  }
  const setViewportChannels = (id: string, channels: number[]) => {
    setWaveViewports((vps) => vps.map((v) => (v.id === id ? { ...v, channels } : v)))
  }
  const setViewportView = (id: string, scaleX: number, offsetX: number) => {
    setWaveViewports((vps) => {
      const vp = vps.find((v) => v.id === id)
      if (!vp || (vp.scaleX === scaleX && vp.offsetX === offsetX)) return vps
      return vps.map((v) => (v.id === id ? { ...v, scaleX, offsetX } : v))
    })
  }

  // ── 跟随滚动 ────────────────────────────────────────────────
  // ★ 依赖必须是**数组引用**而不是 `.length`：行缓冲封顶 2000 行后，追加一条就挤掉
  //   一条，长度恒为 2000 —— 用 length 当依赖就等于"有新数据却不再跟随"（实测：
  //   高流量跑久了「行」不再滚到底，点「恢复跟随」也没反应）。
  //   同时 follow 本身进依赖：从「已暂停」切回跟随时要立刻贴底，不能等下一批。
  //   跟随开关与独立 WebUI 同口径：只由「跟随/恢复」按钮控制，不用 scroll 事件反推
  //   —— 环形缓冲挤出时浏览器 scroll anchoring 会改 scrollTop，反推会把跟随误关掉。
  //   ★ 波形视图**不参与**文本跟随：波形有自己面板级的跟随（viewports）；而窄栏在
  //   组件行出现后内容会溢出，贴底滚动会把「全部 / ＋新建面板 / 通道绑定 CH」那一行
  //   滚出可视区（实测：切到波形后通道绑定整行消失）。
  useEffect(() => {
    const el = scrollRef.current
    if (el !== null && view !== 'wave' && followRef.current) el.scrollTop = el.scrollHeight
  }, [follow, view, monitorLines, runLines, byteBlocks, shownTerm, shownFrames, props.runLinesVersion])

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

  const remember = useCallback((text: string): void => {
    setHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === text) return prev
      const next = [...prev, text].slice(-HISTORY_MAX)
      saveHistory(next)
      return next
    })
    setHistIdx(-1)
  }, [])

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
        remember(draft)
        setDraft('')
      } catch (err) {
        setNotice(`✗ ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [draft, running, sendFormat, eol, stream, remember],
  )

  /** ↑/↓ 调取发送历史（多行输入时只在首/末行触发，避免抢掉光标移动）。 */
  const onDraftKey = useCallback(
    (e: any): void => {
      const key: string = e.key
      if (key !== 'ArrowUp' && key !== 'ArrowDown') return
      if (history.length === 0) return
      e.preventDefault()
      if (key === 'ArrowUp') {
        const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1)
        setHistIdx(next)
        setDraft(history[next])
        return
      }
      if (histIdx === -1) return
      const next = histIdx + 1
      if (next >= history.length) {
        setHistIdx(-1)
        setDraft('')
      } else {
        setHistIdx(next)
        setDraft(history[next])
      }
    },
    [history, histIdx],
  )

  /** 文件按行发送：逐行 await（同一口写穿），有界行数，失败即停并报第几行。 */
  const doSendFile = useCallback(
    async (e: any): Promise<void> => {
      const file: File | undefined = e.currentTarget.files?.[0]
      e.currentTarget.value = '' // 允许重复选同一个文件
      if (file === undefined || running || !writable) return
      setNotice(null)
      let text = ''
      try {
        text = await file.text()
      } catch (err) {
        setNotice(`✗ 读取文件失败：${err instanceof Error ? err.message : String(err)}`)
        return
      }
      let lines = text.split(/\r\n|\r|\n/)
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      if (lines.length === 0) {
        setNotice('✗ 文件里没有可发送的行')
        return
      }
      let clipped = false
      if (lines.length > MAX_FILE_LINES) {
        lines = lines.slice(0, MAX_FILE_LINES)
        clipped = true
      }
      setFileBusy(true)
      let sent = 0
      let fail = ''
      for (const line of lines) {
        if (line === '') continue
        try {
          const r = await stream.send(line, {
            format: sendFormat,
            eol: sendFormat === 'hex' ? 'none' : eol,
          })
          if (!r.ok) {
            fail = r.error ?? '未知原因'
            break
          }
          sent += 1
        } catch (err) {
          fail = err instanceof Error ? err.message : String(err)
          break
        }
      }
      setFileBusy(false)
      if (fail !== '') {
        setNotice(`✗ 文件发送中断：第 ${sent + 1}/${lines.length} 行失败（${fail}）`)
        return
      }
      setNotice(`✓ 文件已按行发送 ${sent} 行 → ${file.name}${clipped ? `（只发前 ${MAX_FILE_LINES} 行）` : ''}`)
    },
    [running, writable, sendFormat, eol, stream],
  )

  // ── 发送组件（M1/M2）────────────────────────────────────────────
  const widgets = useMemo<SerialWidget[]>(() => widgetDoc?.widgets ?? [], [widgetDoc])
  const activeWidget = useMemo(
    () => widgets.find((w) => w.id === widgetId) ?? null,
    [widgets, widgetId],
  )
  const jobActive = widgetJob !== null
    && (widgetJob.state === 'running' || widgetJob.state === 'paused' || widgetJob.state === 'cancelling')
  const widgetProgress = (() => {
    if (widgetJob === null) return ''
    const rounds = widgetJob.rounds ?? 0
    const skipped = widgetJob.skipped ?? 0
    const bytes = widgetJob.total_bytes ?? 0
    const st = widgetJob.state ?? ''
    if (jobActive) {
      const skip = skipped > 0 ? ` · 跳过 ${skipped} 拍` : ''
      const label = st === 'paused' ? '已暂停' : st === 'cancelling' ? '停止中…' : '运行中'
      return `${label} · 第 ${rounds} 轮${skip} · ${bytes} B`
    }
    if (st === 'done') return `完成 · ${rounds} 轮 · ${bytes} B${skipped > 0 ? ` · 跳过 ${skipped} 拍` : ''}`
    if (st === 'cancelled') return `已停止 · ${bytes} B`
    if (st === 'failed') return `失败${widgetJob.error ? ` · ${widgetJob.error}` : ''}`
    return ''
  })()

  /** 读取工程组件（坏文件/坏组件不阻塞：error/warnings 原样展示）。 */
  useEffect(() => {
    if (project === '') {
      setWidgetDoc(null)
      setWidgetId('')
      return
    }
    let alive = true
    void api.serialWidgets(project).then((d) => {
      if (!alive) return
      setWidgetDoc(d)
      setWidgetErr(d.error)
      // 与独立 WebUI 同口径：默认**不选中**任何组件（用户点 chip 才展开参数面板），
      // 只在组件消失时清掉已失效的选中项。
      setWidgetId((cur) => (d.widgets.some((w) => w.id === cur) ? cur : ''))
    }).catch((e: unknown) => {
      if (alive) setWidgetErr(e instanceof Error ? e.message : String(e))
    })
    return () => { alive = false }
  }, [api, project])

  /** 切组件时把参数重置为默认值（类型化控件显示的都是字符串，提交前再转换）。 */
  useEffect(() => {
    if (activeWidget === null) {
      setWidgetParams({})
      return
    }
    const next: Record<string, string> = {}
    for (const p of activeWidget.params) {
      next[p.name] = p.type === 'bool'
        ? (p.default === true ? 'true' : 'false')
        : String(p.default ?? '')
    }
    setWidgetParams(next)
  }, [activeWidget?.id])

  /** 预览字节由服务端渲染（与真正发送共用同一条路径；这里只展示）。 */
  useEffect(() => {
    if (activeWidget === null || project === '') {
      setWidgetPreview('')
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      void api.serialWidgetRun({
        project,
        id: activeWidget.id,
        params: coerceWidgetParams(activeWidget, widgetParams),
        dryRun: true,
      }).then((r) => {
        if (!alive) return
        if (!r.ok) {
          setWidgetPreview('')
          setWidgetErr(r.error ?? '预览失败')
          return
        }
        setWidgetErr(null)
        setWidgetPreview(`预览 ${r.bytes ?? 0} B · ${widgetHex(r.preview_b64)}`)
      }).catch((e: unknown) => {
        if (alive) setWidgetErr(e instanceof Error ? e.message : String(e))
      })
    }, 150)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [api, project, activeWidget, widgetParams])

  /** 刷新/换工程后找回仍在跑的任务（run 只等 2s，长任务只能靠轮询）。 */
  useEffect(() => {
    if (project === '') return
    let alive = true
    void api.serialWidgetJob().then((j) => {
      if (!alive) return
      const active = j.state === 'running' || j.state === 'paused' || j.state === 'cancelling'
      if (!active || j.job_id === undefined || j.job_id === '') return
      setWidgetJob(j)
      setWidgetJobId(j.job_id)
      setWidgetBusy(true)
    }).catch(() => {
      // 404 = 没有在跑的任务，是常态；不打扰用户
    })
    return () => { alive = false }
  }, [api, project])

  /** 任务轮询：run 返回 running 后 400ms 一次，直到终态（不新增 SSE）。 */
  useEffect(() => {
    if (widgetJobId === '') return
    let alive = true
    let timer = 0
    const isActive = (s?: string): boolean =>
      s === 'running' || s === 'paused' || s === 'cancelling'
    const tick = async (): Promise<void> => {
      try {
        const j = await api.serialWidgetJob(widgetJobId)
        if (!alive) return
        setWidgetJob(j)
        if (isActive(j.state)) {
          timer = window.setTimeout(() => void tick(), 400)
        } else {
          setWidgetBusy(false)
          if (!j.ok) setWidgetErr(j.error ?? '执行失败')
        }
      } catch (e) {
        if (!alive) return
        setWidgetBusy(false)
        setWidgetErr(e instanceof Error ? e.message : String(e))
      }
    }
    void tick()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [api, widgetJobId])

  const doWidgetRun = useCallback(async (repeat: boolean): Promise<void> => {
    if (activeWidget === null || running || !writable || widgetBusy || jobActive) return
    if (activeWidget.confirm && !window.confirm(`组件「${activeWidget.label}」需要确认后执行，继续？`)) return
    setWidgetErr(null)
    setWidgetBusy(true)
    try {
      const r = await api.serialWidgetRun({
        project,
        id: activeWidget.id,
        params: coerceWidgetParams(activeWidget, widgetParams),
        repeat,
        confirm: activeWidget.confirm,
      })
      setWidgetJob(r)
      if (r.job_id !== undefined && r.job_id !== '') setWidgetJobId(r.job_id)
      const stillActive = r.state === 'running' || r.state === 'paused' || r.state === 'cancelling'
      if (!stillActive) {
        setWidgetBusy(false)
        if (!r.ok) setWidgetErr(r.error ?? '执行失败')
      }
    } catch (e) {
      setWidgetBusy(false)
      setWidgetErr(e instanceof Error ? e.message : String(e))
    }
  }, [activeWidget, running, writable, widgetBusy, jobActive, api, project, widgetParams])

  const doWidgetCancel = useCallback(async (): Promise<void> => {
    const id = widgetJob?.job_id ?? widgetJobId
    if (id === '') return
    try {
      await api.serialWidgetCancel(id)
      setWidgetJob(await api.serialWidgetJob(id))
    } catch (e) {
      setWidgetErr(e instanceof Error ? e.message : String(e))
    }
  }, [api, widgetJob, widgetJobId])

  const doWidgetPause = useCallback(async (): Promise<void> => {
    const id = widgetJob?.job_id ?? widgetJobId
    if (id === '') return
    const paused = widgetJob?.state !== 'paused'
    try {
      await api.serialWidgetPause(id, paused)
      setWidgetJob(await api.serialWidgetJob(id))
    } catch (e) {
      setWidgetErr(e instanceof Error ? e.message : String(e))
    }
  }, [api, widgetJob, widgetJobId])

  /** 选一个录制 JSONL 在本地回放（纯前端只读，不打开串口）。 */
  const doReplay = useCallback(async (e: any): Promise<void> => {
    const file: File | undefined = e.currentTarget.files?.[0]
    e.currentTarget.value = '' // 允许重复选同一个文件
    if (file === undefined) return
    setReplayErr(null)
    try {
      const text = await file.text()
      const r = parseReplay(file.name, text)
      if (r.data === null) {
        setReplay(null)
        setReplayErr(r.error)
        return
      }
      setReplay(r.data)
      setView('wave')
      setNotice(
        `● 回放 ${file.name}：${r.data.chunks.length} 批 / ${r.data.bytes} B` +
          `${r.data.skipped > 0 ? `（跳过 ${r.data.skipped} 行）` : ''}`,
      )
    } catch (err) {
      setReplay(null)
      setReplayErr(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const bytesTotal = stream.snap?.bytes_total ?? 0
  const chunkCount = stream.chunks.length
  const lossy = replayMode ? 0 : stream.gapLines + stream.gapChunks
  const bytesShown = replayMode && replay !== null ? replay.bytes : bytesTotal
  const chunksShown = replayMode && replay !== null ? replay.chunks.length : chunkCount
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
              const next: string = e.currentTarget.value
              setDecoder(next) // 无会话时的本地解码兜底
              props.onDecoder?.(next) // 记住偏好（'' = 关闭共享解码）
              // 有会话：decoder 是**会话属性**，写进去才与 agent 同源同图
              if (!replayMode && stream.active) void stream.setDecoder(next)
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
            {stream.active ? <option value="">本地解码（关闭共享）</option> : null}
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
        <input
          ref={replayRef}
          type="file"
          accept=".jsonl,.json,.txt,text/plain"
          onChange={(e: any) => void doReplay(e)}
          style={{ display: 'none' }}
        />
        <button
          type="button"
          onClick={() => replayRef.current?.click()}
          title="选一个录制 JSONL 在本地回放波形/行视图（纯前端只读，不占串口）"
          style={chip}
        >
          {'回放'}
        </button>
        {replayMode ? (
          <button
            type="button"
            onClick={() => {
              setReplay(null)
              setReplayErr(null)
            }}
            title="退出回放，回到实时数据面"
            style={{ ...chip, borderColor: 'var(--elab-accent)', color: 'var(--elab-accent)' }}
          >
            {'退出回放'}
          </button>
        ) : null}
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
          onClick={() => setFollowAll(!follow)}
          title={follow ? '正在跟随最新输出；点击暂停' : '已暂停跟随；点击恢复'}
          style={{
            ...chip,
            background: 'transparent',
            color: follow ? 'var(--elab-accent)' : 'var(--elab-fg-dimmed)',
          }}
        >
          {follow ? '\u25be 跟随' : '\u21ba 恢复'}
        </button>
        <span style={metaStyle} title={replayMode ? '回放文件：批次数 / 原始字节数' : '当前缓冲：未清空、未被环形挤出的字节 / 批次'}>
          {`${bytesShown} B · ${chunksShown} 批`}
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
      {replayErr !== null ? (
        <div role="alert" style={barWarn}>
          {`回放失败：${replayErr}`}
        </div>
      ) : null}
      {replayMode && replay !== null ? (
        <div style={barInfo}>
          {`回放中：${replay.name} —— ${replay.chunks.length} 批 / ${replay.bytes} B · ${replay.lines.length} 行` +
            `（本地只读，不占串口）` +
            `${replay.skipped > 0 ? ` · 跳过 ${replay.skipped} 行` : ''}`}
        </div>
      ) : null}
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
              {replayMode
                ? `回放文件里没有 RX 行（共 ${replay?.chunks.length ?? 0} 批，可能是纯 TX 录制）—— 可切到「字节」看原始内容。`
                : '尚无行输出。点上方「▶ 串口」启动常驻监视后，设备输出会实时流进来。'}
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
              {byteBlocks.map(({ c, header, body, rows }) => (
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
                  {rows === null ? (
                    <pre style={{ margin: 0, padding: '4px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--elab-fg-primary)' }}>
                      {body}
                    </pre>
                  ) : (
                    <div style={{ padding: '4px 8px', whiteSpace: 'pre', overflowX: 'auto', color: 'var(--elab-fg-primary)' }}>
                      {rows.map((row, ri) => (
                        <div key={ri}>
                          <span style={{ color: 'var(--elab-fg-faint)' }}>{row.offset}</span>
                          {'  '}
                          {row.cells.map((cell, ci) => (
                            <span key={ci} style={{ color: BYTE_COLORS[cell.cls] }}>
                              {cell.text}
                              {ci === 7 ? '  ' : ci === row.cells.length - 1 ? '' : ' '}
                            </span>
                          ))}
                          {'  |'}
                          {row.ascii.map((cell, ci) => (
                            <span key={ci} style={{ color: BYTE_COLORS[cell.cls] }}>{cell.text}</span>
                          ))}
                          {'|'}
                        </div>
                      ))}
                    </div>
                  )}
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
                {replayMode
                  ? `回放文件里没有解出完整帧：按 ${decoders.find((d) => d.id === decoder)?.label ?? decoder} 解码 ${replay?.chunks.length ?? 0} 批 —— 录制里可能混有不属于该协议的字节，可切方向只看 RX 或换解码器。`
                  : sharedActive
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
            {/* ── 多面板 viewport tab 条 ── */}
            {shownFrames.length > 0 && waveViewports.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                  {waveViewports.map((vp) => (
                    <div key={vp.id} style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--elab-border)', borderRadius: 'var(--elab-radius-sm)', overflow: 'hidden' }}>
                      <button type="button"
                        onClick={() => setActiveViewport(vp.id)}
                        style={{
                          padding: '3px 8px', fontSize: 'var(--elab-fs-xs)',
                          /* 选中态用「浅色强调底 + 恒可读文字」：宿主 brand-primary 是近白，
                             拿它当填充会把白字吃掉（实测波形页签变成一块白板）。 */
                          background: activeViewport === vp.id ? 'var(--elab-btn-primary-bg)' : 'var(--elab-bg-surface)',
                          color: activeViewport === vp.id ? 'var(--elab-fg-primary)' : 'var(--elab-fg-secondary)',
                          fontWeight: activeViewport === vp.id ? 600 : 400,
                          border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                        }}
                        title={`切换到 ${vp.name}`}
                      >{vp.name}</button>
                      {waveViewports.length > 1 ? (
                        <button type="button"
                          onClick={() => removeWaveViewport(vp.id)}
                          style={{ padding: '3px 6px', fontSize: 12, background: 'transparent', color: 'var(--elab-fg-dimmed)', border: 'none', borderLeft: '1px solid var(--elab-border)', cursor: 'pointer', lineHeight: 1 }}
                          title="删除此面板（至少保留一个）"
                        >×</button>
                      ) : null}
                    </div>
                  ))}
                  <button type="button" onClick={addWaveViewport}
                    style={{ padding: '3px 8px', fontSize: 'var(--elab-fs-xs)', background: 'transparent', color: 'var(--elab-accent)', border: '1px dashed var(--elab-accent)', borderRadius: 'var(--elab-radius-sm)', cursor: 'pointer', fontFamily: 'inherit' }}
                    title="新建波形面板：独立缩放/平移，可绑定不同通道"
                  >+ 新建面板</button>
                </div>

                {/* 通道绑定 chip */}
                {(() => {
                  const vp = waveViewports.find((v) => v.id === activeViewport)
                  if (!vp) return null
                  const totalCh = shownChannels
                  if (totalCh === 0) return null
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', fontSize: 'var(--elab-fs-xs)' }}>
                      <span style={{ color: 'var(--elab-fg-faint)' }}>通道绑定：</span>
                      {Array.from({ length: totalCh }, (_, i) => {
                        const on = vp.channels.includes(i)
                        return (
                          <button key={i} type="button"
                            onClick={() => {
                              const newCh = on ? vp.channels.filter((x) => x !== i) : [...vp.channels, i].sort((a, b) => a - b)
                              if (newCh.length > 0) setViewportChannels(vp.id, newCh)
                            }}
                            style={{
                              padding: '2px 6px', fontSize: 'var(--elab-fs-xs)',
                              background: on ? 'var(--elab-btn-primary-bg)' : 'var(--elab-bg-surface)',
                              color: on ? 'var(--elab-fg-primary)' : 'var(--elab-fg-dimmed)',
                              fontWeight: on ? 600 : 400,
                              border: `1px solid ${on ? 'var(--elab-accent)' : 'var(--elab-border)'}`,
                              borderRadius: 'var(--elab-radius-sm)', cursor: 'pointer', fontFamily: 'inherit',
                            }}
                            title={`${on ? '取消' : '绑定'} CH${i}`}
                          >CH{i}</button>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
            ) : null}

            {/* ── 当前激活面板的 WaveChart ── */}
            {shownFrames.length > 0 && waveViewports.length > 0 ? (
              (() => {
                const vp = waveViewports.find((v) => v.id === activeViewport)
                if (!vp) return null
                const f = viewportFollow[vp.id] ?? follow
                return (
                  <WaveChart
                    frames={shownFrames}
                    channels={vp.channels}
                    scaleX={vp.scaleX}
                    offsetX={vp.offsetX}
                    onView={(sx, ox) => setViewportView(vp.id, sx, ox)}
                    follow={f}
                    onFollowChange={(v) => setViewportFollow((prev) => ({ ...prev, [vp.id]: v }))}
                  />
                )
              })()
            ) : null}
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

      {/* ── 发送组件（M1/M2）：chips + 类型化参数 + 服务端预览 + 执行/周期/暂停/停止 ── */}
      {widgetDoc !== null && project !== ''
        && (widgets.length > 0 || widgetDoc.warnings.length > 0 || widgetDoc.error !== null) ? (
        <div style={widgetBarStyle}>
          <span style={widgetTitleStyle}>{'组件'}</span>
          {widgets.map((w) => (
            <button
              key={w.id}
              type="button"
              title={`${w.label} · ${w.steps.length} 步${w.group ? ` · ${w.group}` : ''}`}
              onClick={() => setWidgetId(widgetId === w.id ? '' : w.id)}
              style={widgetId === w.id ? widgetChipOnStyle : widgetChipStyle}
            >
              {w.label}
            </button>
          ))}
          {widgetDoc.error !== null ? (
            <span style={widgetErrStyle}>{`✗ ${widgetDoc.error}`}</span>
          ) : null}
          {widgetDoc.warnings.length > 0 ? (
            <span style={widgetErrStyle} title={widgetDoc.warnings.join('\n')}>
              {`⚠ ${widgetDoc.warnings.length} 处配置问题`}
            </span>
          ) : null}
        </div>
      ) : null}

      {activeWidget !== null ? (
        <div style={widgetPanelStyle}>
          {activeWidget.params.length === 0 ? (
            <span style={widgetLabelStyle}>{'无参数'}</span>
          ) : (
            activeWidget.params.map((p) => (
              <label key={p.name} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }} title={p.name}>
                <span style={widgetLabelStyle}>{p.label ?? p.name}</span>
                {p.type === 'bool' ? (
                  <input
                    type="checkbox"
                    checked={widgetParams[p.name] === 'true'}
                    onChange={(e: any) => setWidgetParams((cur) => ({ ...cur, [p.name]: e.currentTarget.checked ? 'true' : 'false' }))}
                    style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                  />
                ) : p.type === 'enum' ? (
                  <select
                    value={widgetParams[p.name] ?? ''}
                    onChange={(e: any) => setWidgetParams((cur) => ({ ...cur, [p.name]: e.currentTarget.value }))}
                    style={selectStyle}
                  >
                    {(p.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input
                    type={p.type === 'int' || p.type === 'float' ? 'number' : 'text'}
                    value={widgetParams[p.name] ?? ''}
                    min={p.min}
                    max={p.max}
                    step={p.step ?? (p.type === 'float' ? 'any' : undefined)}
                    onChange={(e: any) => setWidgetParams((cur) => ({ ...cur, [p.name]: e.currentTarget.value }))}
                    style={{ ...widgetInputStyle, width: p.type === 'string' ? '7em' : '5.5em' }}
                  />
                )}
              </label>
            ))
          )}
          <span style={widgetPreviewStyle} title={widgetErr ?? widgetPreview}>
            {widgetErr !== null ? `✗ ${widgetErr}` : widgetPreview !== '' ? widgetPreview : '预览中…'}
          </span>
          {widgetProgress !== '' ? (
            <span style={widgetPreviewStyle} title={widgetProgress}>{widgetProgress}</span>
          ) : null}
          <span style={{ flex: '1 1 auto' }} />
          {activeWidget.repeat ? (
            <button
              type="button"
              disabled={running || !writable || widgetBusy || jobActive}
              onClick={() => void doWidgetRun(true)}
              title={`周期发送：每 ${activeWidget.repeat.interval_ms} ms 一轮，${
                activeWidget.repeat.count > 0 ? `共 ${activeWidget.repeat.count} 轮` : '直到手动停止'
              }；上一轮超时只记跳过、不补发`}
              style={{
                ...chip,
                opacity: running || !writable || widgetBusy || jobActive ? 0.5 : 1,
                cursor: running || !writable || widgetBusy || jobActive ? 'not-allowed' : 'pointer',
              }}
            >
              {'↻ 周期'}
            </button>
          ) : null}
          {jobActive ? (
            <>
              <button type="button" onClick={() => void doWidgetPause()} style={chip} title="暂停/恢复（节拍照常走，停掉的记跳过）">
                {widgetJob?.state === 'paused' ? '▶ 继续任务' : '❚❚ 暂停任务'}
              </button>
              <button type="button" onClick={() => void doWidgetCancel()} style={chip} title="停止（1s 内退出，不再发后续步骤）">
                {'■ 停止任务'}
              </button>
            </>
          ) : null}
          <button
            type="button"
            disabled={running || !writable || widgetBusy || jobActive}
            onClick={() => void doWidgetRun(false)}
            title={activeWidget.confirm ? '该组件需要确认后执行' : '执行组件（send/delay/wait 序列）'}
            style={{
              ...chip,
              fontWeight: 600,
              opacity: running || !writable || widgetBusy || jobActive ? 0.5 : 1,
              cursor: running || !writable || widgetBusy || jobActive ? 'not-allowed' : 'pointer',
            }}
          >
            {'▶ 发送'}
          </button>
        </div>
      ) : null}

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
          onChange={(e: any) => {
            setDraft(e.currentTarget.value)
            setHistIdx(-1)
          }}
          onKeyDown={onDraftKey}
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
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.csv,.log,.json,.hex,text/plain"
          onChange={(e: any) => void doSendFile(e)}
          style={{ display: 'none' }}
        />
        <button
          type="button"
          disabled={sendDisabled || fileBusy}
          onClick={() => fileRef.current?.click()}
          title={`选文件按行发送（每行按当前格式与行尾，最多 ${MAX_FILE_LINES} 行）`}
          style={{
            ...chip,
            opacity: sendDisabled || fileBusy ? 0.5 : 1,
            cursor: sendDisabled || fileBusy ? 'not-allowed' : 'pointer',
          }}
        >
          {fileBusy ? '发送中…' : '文件'}
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
      {stream.active !== true && running !== true && !replayMode ? (
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

/** WaveChart V2 —— 多通道折线 + 缩放 + 平移 + 时间轴 + 跟随
 *  inline 样式（宿主无 CSS 模块构建）。channels 可以是 number[] 或 number。 */
const WAVE_TOKENS = [
  'bright-blue', 'bright-green', 'bright-red', 'bright-yellow',
  'bright-magenta', 'bright-cyan', 'blue', 'green',
] as const

function resolvedChannelsDsh(ch: number[] | number, frameChannels: number): number[] {
  if (typeof ch === 'number') return Array.from({ length: Math.min(ch, frameChannels) }, (_, i) => i)
  return ch.filter((i) => i >= 0 && i < frameChannels)
}

function WaveChart(props: {
  frames: number[][]
  channels: number[] | number
  /** X 轴缩放（1 = 全部可见；>1 = 放大） */
  scaleX: number
  /** 最左边可见帧 index（0-based） */
  offsetX: number
  /** 缩放/平移变化回写父组件（按 viewport 保存） */
  onView: (scaleX: number, offsetX: number) => void
  follow: boolean
  onFollowChange: (v: boolean) => void
}): ReactNode {
  const { frames, channels, scaleX, offsetX, onView, follow, onFollowChange } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<{ startClientX: number; startOffset: number } | null>(null)
  const dragActive = useRef(false)

  // ── 取消跟随 = 定格画面 ──────────────────────────────────────
  // 波形是"最近 N 字节"的滚动解码窗口：只钉住 offsetX 没用 —— 窗口本身
  // 在滑，同一个 index 已经对应到新数据，曲线看起来就一直在走。
  // 所以 follow=false 时留下**这一刻的帧快照**，恢复跟随才换回实时帧。
  const [frozen, setFrozen] = useState<number[][] | null>(null)
  useEffect(() => {
    if (frames.length === 0) { setFrozen(null); return }
    if (follow) { setFrozen(null); return }
    setFrozen((cur) => cur ?? frames)
  }, [follow, frames])
  const shown = follow ? frames : (frozen ?? frames)

  const frameChannels = shown[0]?.length ?? 0
  const shownCh = resolvedChannelsDsh(channels, frameChannels)

  // follow → 跳尾
  const lastFramesLen = useRef(0)
  useEffect(() => {
    if (shown.length === 0) { onView(scaleX, 0); return }
    const prev = lastFramesLen.current
    lastFramesLen.current = shown.length
    if (follow) {
      const canvas = canvasRef.current
      const w = canvas?.clientWidth ?? 480
      const visible = Math.max(20, Math.ceil(w / scaleX))
      onView(scaleX, Math.max(0, shown.length - visible))
    } else if (prev === 0) {
      const canvas = canvasRef.current
      const w = canvas?.clientWidth ?? 480
      const visible = Math.max(20, Math.ceil(w / scaleX))
      onView(scaleX, Math.min(offsetX, Math.max(0, shown.length - visible)))
    }
    // onView/offsetX 故意不进依赖：只在帧数或缩放/跟随变化时重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.length, follow, scaleX])

  // 绘制
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || shown.length === 0) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth || 480
    const h = canvas.clientHeight || 220
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const css = getComputedStyle(canvas)
    const cvar = (n: string): string => css.getPropertyValue(n).trim()
    const border = cvar('--elab-border') || 'transparent'
    const axisLabel = cvar('--elab-fg-faint') || 'gray'
    const palette: string[] = WAVE_TOKENS.map((tok) => cvar(`--elab-ansi-${tok}`) || axisLabel)

    // 顶部一行标签 / 底部一行帧号，绘图区夹在中间
    const padL = 8, padR = 8, padT = 16, padB = 18
    const plotW = w - padL - padR, plotH = h - padT - padB
    if (plotW <= 4 || plotH <= 4) return
    const plotTop = padT, plotBottom = padT + plotH

    const visibleCount = Math.max(2, Math.round(plotW / scaleX))
    const startIdx = Math.max(0, Math.min(offsetX, shown.length - 1))
    const endIdx = Math.min(shown.length, startIdx + visibleCount)
    const slice = shown.slice(startIdx, endIdx)
    if (slice.length === 0) return
    const xOf = (i: number): number => padL + (slice.length <= 1 ? plotW / 2 : (i / (slice.length - 1)) * plotW)

    ctx.strokeStyle = border; ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const y = plotTop + (plotH * i) / 4
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke()
    }
    const stepSec = Math.max(10, Math.round(slice.length / 6))
    ctx.fillStyle = axisLabel; ctx.font = '10px ui-monospace, Menlo, Consolas, monospace'; ctx.textBaseline = 'top'
    for (let i = 0; i < slice.length; i += stepSec) {
      const x = xOf(i)
      if (x > w - padR) break
      ctx.strokeStyle = border
      ctx.beginPath(); ctx.moveTo(x, plotTop); ctx.lineTo(x, plotBottom); ctx.stroke()
      ctx.textAlign = 'center'
      // 首尾帧号夹在画布内，否则画布边缘会把文字裁掉
      const label = `${startIdx + i}`
      const half = ctx.measureText(label).width / 2
      const lx = Math.min(w - padR - half, Math.max(padL + half, x))
      ctx.fillText(label, lx, plotBottom + 3)
    }

    for (const ch of shownCh) {
      const values = slice.map((f) => (ch < f.length ? f[ch] : NaN))
      let lo = Infinity, hi = -Infinity
      for (const v of values) { if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
      if (hi === lo) { hi = lo + 1; lo -= 1 }
      ctx.strokeStyle = palette[ch % palette.length]; ctx.lineWidth = 1.4
      ctx.beginPath()
      let started = false
      for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) { started = false; continue }
        const x = xOf(i)
        const y = plotBottom - ((values[i] - lo) / (hi - lo)) * plotH
        if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    ctx.fillStyle = axisLabel; ctx.textBaseline = 'top'
    ctx.textAlign = 'left'; ctx.fillText(`帧 ${startIdx} → ${endIdx - 1}`, padL, 2)
    ctx.textAlign = 'right'; ctx.fillText(`共 ${shown.length} 帧 · 窗口 ${endIdx - startIdx} · ×${scaleX.toFixed(1)}`, w - padR, 2)
  }, [shown, scaleX, offsetX, shownCh])

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const xInCanvas = e.clientX - rect.left
    const padL = 8
    const plotW = rect.width - padL - 8
    const frameAtCursor = Math.round(offsetX + Math.max(0, xInCanvas - padL) / scaleX)
    const newScale = Math.min(20, Math.max(1, e.deltaY < 0 ? scaleX * 1.2 : scaleX / 1.2))
    const visibleCount = Math.max(2, Math.round(plotW / newScale))
    let newOffset = frameAtCursor - Math.round((xInCanvas - padL) / newScale)
    newOffset = Math.max(0, Math.min(newOffset, Math.max(0, shown.length - visibleCount)))
    onView(newScale, newOffset)
    if (follow) onFollowChange(false)
  }
  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = { startClientX: e.clientX, startOffset: offsetX }
    dragActive.current = true; e.preventDefault()
  }
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragActive.current || !dragRef.current) return
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const plotW = rect.width - 44 - 8
    const dx = e.clientX - dragRef.current.startClientX
    const offsetDelta = Math.round(-dx / scaleX)
    const visibleCount = Math.max(2, Math.round(plotW / scaleX))
    let newOffset = dragRef.current.startOffset + offsetDelta
    newOffset = Math.max(0, Math.min(newOffset, Math.max(0, shown.length - visibleCount)))
    if (newOffset !== dragRef.current.startOffset) onView(scaleX, newOffset)
    if (follow) onFollowChange(false)
  }
  const endDrag = () => { dragActive.current = false; dragRef.current = null }

  const canvasReady = shown.length > 0
  const chip: React.CSSProperties = { padding: '2px 8px', fontSize: 12, lineHeight: 1, border: '1px solid var(--elab-border)', borderRadius: 'var(--elab-radius-sm)', background: 'var(--elab-bg-surface)', color: 'var(--elab-fg-secondary)', cursor: 'pointer', fontFamily: 'inherit' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-secondary)', flex: '1 1 auto' }}>
          {shownCh.map((ch) => (
            <span key={ch} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: `var(--elab-ansi-${WAVE_TOKENS[ch % 8]})` }} />
              {`CH${ch}`}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button type="button" onClick={() => onView(Math.max(1, scaleX / 1.2), offsetX)} style={chip} disabled={!canvasReady} title="缩小（向后看更多帧）">−</button>
          <button type="button" onClick={() => onView(Math.min(20, scaleX * 1.2), offsetX)} style={chip} disabled={!canvasReady} title="放大（看更精细的局部）">+</button>
          <button type="button" onClick={() => onView(1, 0)} style={chip} disabled={!canvasReady} title="重置（全部可见、回到开头）">⤾</button>
          <button type="button" onClick={() => onFollowChange(!follow)} style={{ ...chip, ...(follow ? { color: 'var(--elab-accent)', borderColor: 'var(--elab-accent)' } : {}) }} disabled={!canvasReady} title={follow ? '正在跟随最新帧，点击暂停（画面定格在当前窗口，数据仍继续接收）' : '画面已定格，点击恢复跟随最新帧'}>
            {follow ? '❚❚ 暂停跟随' : '▶ 恢复跟随'}
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '220px', display: 'block', background: 'var(--elab-bg-surface)', border: '1px solid var(--elab-border)', borderRadius: 'var(--elab-radius-sm)', cursor: canvasReady ? (dragActive.current ? 'grabbing' : 'grab') : 'default' }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      />
    </div>
  )
}
