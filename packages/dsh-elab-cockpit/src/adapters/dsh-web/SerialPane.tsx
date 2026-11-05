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
import type {
  SerialChunk,
  SerialFrameProfile,
  SerialIssue,
  SerialLogProfile,
  SerialPreviewResult,
  SerialSymbol,
  SerialWidgetRunResult,
} from '../../domain/icd.ts'
import {
  autoRange,
  b64ToBytes,
  bytesToB64,
  captureText,
  fmtDuration,
  fmtValue,
  hexDump,
  hexDumpRows,
  measure,
  nearestFrameIndex,
  parseAnsi,
  parseSendHistory,
  pushSendHistory,
  serializeSendHistory,
  snapshotJson,
  textOf,
  valueToY,
} from '@elab/cockpit-ui-core'
import type { HexRow, SendHistoryEntry, SerialRepr } from '@elab/cockpit-ui-core'
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
  { id: 'auto', label: '自动' },
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

/** 连接方式的人话标签（M4）：未登记的 kind 直接显示原值（不猜）。 */
const TRANSPORT_LABELS: Record<string, string> = {
  serial: '串口',
  'tcp-client': 'TCP 客户端',
  'tcp-server': 'TCP 服务端',
  udp: 'UDP',
}

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

function loadHistory(): SendHistoryEntry[] {
  try {
    return parseSendHistory(localStorage.getItem(HISTORY_KEY))
  } catch {
    return []
  }
}

function saveHistory(items: SendHistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, serializeSendHistory(items))
  } catch {
    // 隐私模式/配额满：历史只是便利，不写也不影响发送
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
  /** 连接方式（M4）：serial / tcp-client / tcp-server / udp */
  transport: string
  /** 可用的连接方式（来自 caps.meta.serial.transports.kinds） */
  transportKinds: string[]
  /** 网络目标/绑定地址（M4） */
  netHost: string
  netPort: number
  netAllowRemote: boolean
  onTransport?: (transport: string) => void
  onNet?: (net: { host: string; port: number; allow_remote: boolean }) => void
  /** 日志诊断 profile 偏好（M6）：打开会话时带上 */
  logProfilePref?: string
  onLogProfile?: (profile: string) => void
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
  const { api, stream, decoders, project, running, port, baud, ports, writable, transport } = props
  const [view, setView] = useState<ViewId>('lines')
  const [dir, setDir] = useState<Dir>('all')
  const [repr, setRepr] = useState<SerialRepr>('hex')
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const [draft, setDraft] = useState('')
  const [sendFormat, setSendFormat] = useState('auto')
  const [eol, setEol] = useState('crlf')
  const [notice, setNotice] = useState<string | null>(null)
  /** 服务端预览（dry_run）：自动识别结果 + 待发字节 */
  const [sendPreview, setSendPreview] = useState<SerialPreviewResult | null>(null)
  /** 定时发送间隔（毫秒）；丢给内核校验，面板不写死下限 */
  const [loopInterval, setLoopInterval] = useState('100')
  /** 发送历史（↑/↓ 调取；含当时的格式与行尾，跨会话记忆）。 */
  const [history, setHistory] = useState<SendHistoryEntry[]>(loadHistory)
  const [histIdx, setHistIdx] = useState(-1)
  const [fileBusy, setFileBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [replay, setReplay] = useState<ReplayData | null>(null)
  const [replayErr, setReplayErr] = useState<string | null>(null)
  const replayRef = useRef<HTMLInputElement | null>(null)
  // 发送任务（定时发送 / 组件任务）：异步任务快照 + 轮询 id
  const [job, setJob] = useState<SerialWidgetRunResult | null>(null)
  const [jobId, setJobId] = useState('')
  // 本地解码兜底：上次偏好优先；'' = 用户显式关闭共享解码（也不本地解码）。
  const [decoder, setDecoder] = useState(props.decoderPref ?? decoders[0]?.id ?? 'justfloat')

  // ── 日志诊断（M6）：profile 清单 + 结构化异常展开 ──
  const ISSUE_KIND_LABEL: Record<string, string> = {
    panic: 'panic', assert: 'assert', hardfault: 'hardfault', reset: '复位',
  }
  const [logProfiles, setLogProfiles] = useState<SerialLogProfile[]>([])
  const [profileId, setProfileId] = useState(props.logProfilePref ?? '')
  const [issuesOpen, setIssuesOpen] = useState(false)
  const [symbols, setSymbols] = useState<Record<number, SerialSymbol[]>>({})
  useEffect(() => {
    let dead = false
    if (!project) {
      setLogProfiles([])
      return undefined
    }
    void api
      .serialLogProfiles(project, props.sessionId)
      .then((r) => { if (!dead) setLogProfiles(r.profiles ?? []) })
      .catch(() => { if (!dead) setLogProfiles([]) })
    return () => { dead = true }
  }, [api, project, props.sessionId])
  useEffect(() => {
    // 会话实际启用的 profile 是事实源（打开时可能默认选了第一份）
    const active = stream.snap?.issues?.profile
    if (active) setProfileId(active)
  }, [stream.snap?.issues?.profile])
  const symbolizeIssue = useCallback(async (issue: SerialIssue): Promise<void> => {
    try {
      const r = await api.serialSymbolize(
        project, issue.backtrace, stream.snap?.issues?.profile ?? '', props.sessionId,
      )
      setSymbols((prev) => ({ ...prev, [issue.seq]: r.symbols ?? [] }))
      if (!r.ok) setNotice(`符号化未完全成功：${r.error ?? '未知原因'}`)
    } catch (e) {
      setNotice(`符号化失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [api, project, props.sessionId, stream.snap?.issues?.profile])

  // ── 帧协议（M5）：只读镜像（编辑器只在驾驶舱，避免两套前端漂移）──
  const [frameProfiles, setFrameProfiles] = useState<SerialFrameProfile[]>([])
  useEffect(() => {
    let dead = false
    if (!project) {
      setFrameProfiles([])
      return undefined
    }
    void api
      .serialFrames(project, props.sessionId)
      .then((r) => { if (!dead) setFrameProfiles(r.profiles ?? []) })
      .catch(() => { if (!dead) setFrameProfiles([]) })
    return () => { dead = true }
  }, [api, project, props.sessionId])

  const decoderOptions = useMemo(() => {
    const base = decoders.filter((d) => d.id !== 'profile')
    return [
      ...base,
      ...frameProfiles.map((p) => ({
        id: `profile:${p.id}`,
        label: `帧 · ${p.label || p.id}`,
        desc: '按工程帧协议（frames.json）解码；配置在驾驶舱「帧协议」抽屉里编辑',
      })),
    ]
  }, [decoders, frameProfiles])

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
  const [decodeMeta, setDecodeMeta] = useState<{
    channels: number
    skipped: number
    pending: number
    fields: { name: string; unit: string; type: string; plot: boolean }[]
  } | null>(null)
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
  /** M7：共享帧带 t_us（游标 Δt 的真实时间源）；离线解码没有时间 */
  const shownTimes = sharedActive
    ? stream.decoded.map((f) => f.t_us)
    : null
  const shownFields = sharedActive
    ? (stream.decodedSnap?.fields ?? [])
    : (decodeMeta?.fields ?? [])

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
        ...(decoder.startsWith('profile:')
          ? { project, profile: decoder.slice('profile:'.length) }
          : {}),
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
        setDecodeMeta({
          channels: r.channels,
          skipped: r.skipped,
          pending: r.pending_bytes,
          fields: r.fields ?? [],
        })
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
  //   发送栏出现后内容会溢出，贴底滚动会把「全部 / ＋新建面板 / 通道绑定 CH」那一行
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

  /** 服务端预览：150ms 防抖（自动识别/字节都来自服务端，前端不编码）。 */
  const previewSend = api.serialPreview
  useEffect(() => {
    if (draft.trim() === '') {
      setSendPreview(null)
      return
    }
    const timer = window.setTimeout(() => {
      previewSend({
        project: project ?? '',
        data: draft,
        port,
        baud,
        format: sendFormat,
        eol,
      })
        .then(setSendPreview)
        .catch(() => setSendPreview(null))
    }, 150)
    return () => window.clearTimeout(timer)
  }, [draft, sendFormat, eol, project, port, baud, previewSend])

  const remember = useCallback((entry: SendHistoryEntry): void => {
    setHistory((prev) => {
      const next = pushSendHistory(prev, entry)
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
          `✓ 已发送 ${r.written} B → ${r.port}@${r.baud}` +
            (r.format ? `（识别为 ${String(r.format).toUpperCase()}）` : '') +
            (r.via === 'monitor' ? '（经监视会话，回显见实时流）' : ''),
        )
        remember({ text: draft, format: sendFormat as SendHistoryEntry['format'], eol: eol as SendHistoryEntry['eol'], at: Date.now() })
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
        setDraft(history[next].text)
        setSendFormat(history[next].format)
        setEol(history[next].eol)
        return
      }
      if (histIdx === -1) return
      const next = histIdx + 1
      if (next >= history.length) {
        setHistIdx(-1)
        setDraft('')
      } else {
        setHistIdx(next)
        setDraft(history[next].text)
        setSendFormat(history[next].format)
        setEol(history[next].eol)
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

  // ── 发送任务（定时发送 / 组件任务共用内核任务引擎）──────────────
  const jobActive = job !== null
    && (job.state === 'running' || job.state === 'paused' || job.state === 'cancelling')
  /** 当前跑的是「发送框定时发送」（source=raw），而不是组件任务 */
  const rawLoopActive = jobActive && job?.source === 'raw'

  /** 刷新/换工程后找回仍在跑的任务（run 只等 2s，长任务只能靠轮询）。 */
  useEffect(() => {
    if (project === '') return
    let alive = true
    void api.serialWidgetJob().then((j) => {
      if (!alive) return
      const active = j.state === 'running' || j.state === 'paused' || j.state === 'cancelling'
      if (!active || j.job_id === undefined || j.job_id === '') return
      setJob(j)
      setJobId(j.job_id)
    }).catch(() => {
      // 404 = 没有在跑的任务，是常态；不打扰用户
    })
    return () => { alive = false }
  }, [api, project])

  /** 任务轮询：run 返回 running 后 400ms 一次，直到终态（不新增 SSE）。 */
  useEffect(() => {
    if (jobId === '') return
    let alive = true
    let timer = 0
    const isActive = (s?: string): boolean =>
      s === 'running' || s === 'paused' || s === 'cancelling'
    const tick = async (): Promise<void> => {
      try {
        const j = await api.serialWidgetJob(jobId)
        if (!alive) return
        setJob(j)
        if (isActive(j.state)) {
          timer = window.setTimeout(() => void tick(), 400)
        } else if (!j.ok) {
          setNotice(`✗ 任务失败：${j.error ?? '未知原因'}`)
        }
      } catch (e) {
        if (!alive) return
        setNotice(`✗ ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    void tick()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [api, jobId])

  const cancelJob = useCallback(async (): Promise<void> => {
    const id = job?.job_id ?? jobId
    if (id === '') return
    try {
      await api.serialWidgetCancel(id)
      setJob(await api.serialWidgetJob(id))
    } catch (e) {
      setNotice(`✗ ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [api, job, jobId])

  /** 定时发送：发到 `/api/serial/loop`（内核瞬态任务，不落盘）。 */
  const startLoop = useCallback(async (): Promise<void> => {
    if (draft.trim() === '' || running || !writable) return
    const ms = Number(loopInterval)
    if (!Number.isFinite(ms) || ms <= 0) {
      setNotice('✗ 定时发送间隔必须是正数（毫秒）')
      return
    }
    setNotice(null)
    try {
      const r = await api.serialLoop({
        project: project ?? '',
        data: draft,
        port,
        baud,
        format: sendFormat,
        eol,
        interval_ms: Math.round(ms),
        count: 0,
      })
      if (r.job_id !== undefined) setJobId(r.job_id)
      setJob(r)
      if (!r.ok) {
        setNotice(`✗ ${r.error ?? '定时发送被拒绝'}`)
        return
      }
      setNotice(`⏵ 定时发送中：每 ${Math.round(ms)}ms（停止后才可手发）`)
      remember({
        text: draft,
        format: sendFormat as SendHistoryEntry['format'],
        eol: eol as SendHistoryEntry['eol'],
        at: Date.now(),
      })
    } catch (e) {
      setNotice(`✗ ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [api, project, draft, port, baud, sendFormat, eol, loopInterval, running, writable, remember])

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
  // 周期/组件任务在跑时不交错手发（一个口只允许一个发送源）
  const sendDisabled = running || !writable || jobActive

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
        {/* ── 连接方式（M4）：串口 / TCP 客户端 / TCP 服务端 / UDP ── */}
        <select
          value={transport}
          onChange={(e: any) => props.onTransport?.(e.currentTarget.value)}
          aria-label="连接方式"
          title={portLocked
            ? '监视进行中：先关闭监视再换连接方式（换链路会重开会话）'
            : '连接方式：串口 = 本地 COM；TCP 客户端 = 连板子/服务器；TCP 服务端 = 本机监听等板子连入；UDP = 本机监听等设备发包'}
          style={{ ...selectStyle, opacity: portLocked ? 0.5 : 1, cursor: portLocked ? 'not-allowed' : 'pointer' }}
          disabled={portLocked || props.onTransport === undefined}
        >
          {props.transportKinds.map((k) => (
            <option key={k} value={k}>{TRANSPORT_LABELS[k] ?? k}</option>
          ))}
        </select>
        {transport === 'serial' ? (
          <>
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
          </>
        ) : (
          <>
            <input
              value={props.netHost}
              onChange={(e: any) => props.onNet?.({ host: e.currentTarget.value, port: props.netPort, allow_remote: props.netAllowRemote })}
              aria-label={transport === 'tcp-client' ? '目标地址' : '绑定地址'}
              title={transport === 'tcp-client'
                ? '板子/服务器的地址（跨机需勾选「允许非回环」）'
                : '本机绑定地址：127.0.0.1 只给本机；0.0.0.0 监听局域网（需勾选「允许非回环」）'}
              style={{ ...selectStyle, width: '120px', opacity: portLocked ? 0.5 : 1 }}
              disabled={portLocked}
            />
            <input
              value={String(props.netPort)}
              onChange={(e: any) => {
                const n = Number(e.currentTarget.value)
                props.onNet?.({ host: props.netHost, port: Number.isFinite(n) ? n : 0, allow_remote: props.netAllowRemote })
              }}
              aria-label="网络端口"
              title="网络端口（1~65535）；板子固件里的端口要和这里一致"
              style={{ ...selectStyle, width: '62px', opacity: portLocked ? 0.5 : 1 }}
              disabled={portLocked}
            />
            <label
              title="默认只允许 127.0.0.1/localhost；跨机或板子直连时必须显式允许"
              style={{ ...chip, cursor: portLocked ? 'not-allowed' : 'pointer', opacity: portLocked ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={props.netAllowRemote}
                onChange={(e: any) => props.onNet?.({ host: props.netHost, port: props.netPort, allow_remote: Boolean(e.currentTarget.checked) })}
                disabled={portLocked}
                style={{ marginRight: '4px', verticalAlign: 'middle' }}
              />
              允许非回环
            </label>
          </>
        )}
        {/* 线参数：只读 —— 编辑面只在 cockpit（避免两套前端漂移）；这里展示会话实际值 */}
        <span
          aria-label="串口线参数（只读）"
          title="线参数（只读）：在 cockpit「串口」工作区编辑；改后需重开监视才生效"
          style={{ ...chip, cursor: 'default', fontFamily: 'var(--elab-font-mono)', display: transport === 'serial' ? undefined : 'none' }}
        >
          {stream.snap?.line_text ?? '8N1'}
        </span>
        {/* ── 日志诊断 profile（M6）：规则来自包/工程数据，面板只读清单 ── */}
        {logProfiles.length > 0 ? (
          <select
            value={profileId}
            disabled={!stream.active}
            onChange={(e: any) => {
              const next: string = e.currentTarget.value
              setProfileId(next)
              props.onLogProfile?.(next)
              if (stream.active) void stream.setLogProfile(next)
            }}
            aria-label="日志诊断 profile"
            title="日志诊断规则来自包/工程数据（panic / hardfault / 复位）；关闭 = 不解析"
            style={{ ...selectStyle, opacity: stream.active ? 1 : 0.5 }}
          >
            <option value="">日志诊断：关</option>
            {logProfiles.map((p) => (
              <option key={p.id} value={p.id}>{p.label || p.id}</option>
            ))}
          </select>
        ) : null}
        {stream.issueTotal > 0 ? (
          <button
            type="button"
            onClick={() => setIssuesOpen((v) => !v)}
            style={{
              ...chip,
              ...(stream.issues.some((i) => i.kind !== 'reset')
                ? { color: 'var(--elab-status-fail)', borderColor: 'var(--elab-status-fail)' }
                : {}),
            }}
            title="结构化异常（panic / assert / hardfault / 复位）；可展开符号化回溯地址"
          >
            {`异常 ${stream.issueTotal}${issuesOpen ? ' ▾' : ' ▸'}`}
          </button>
        ) : null}
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
                : (decoderOptions.find((d) => d.id === decoder)?.desc ?? '协议解码器')
            }
            style={selectStyle}
          >
            {decoderOptions.map((d) => (
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
        {stream.snap?.stats ? (
          <span
            style={metaStyle}
            title={`最近 1s：RX ${stream.snap.stats.rx_bps.toFixed(0)} B/s、TX ${stream.snap.stats.tx_bps.toFixed(0)} B/s（服务端统计${stream.snap.stats.warmup ? '，窗口不足 1s' : ''}）`}
          >
            {`\u2193${(stream.snap.stats.rx_bps / 1024).toFixed(1)}K \u2191${(stream.snap.stats.tx_bps / 1024).toFixed(1)}K B/s`}
          </span>
        ) : null}
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
      {stream.snap?.state === 'reconnecting' ? (
        <div role="status" style={barWarn}>
          {`串口已掉线，正在自动重连${stream.snap.down_s ? `（已断开 ${stream.snap.down_s}s）` : ''}` +
            `${stream.snap.last_error ? `：${stream.snap.last_error}` : ''} —— 恢复后日志自动续上。`}
        </div>
      ) : null}
      {stream.snap?.state === 'suspended' ? (
        <div role="status" style={barInfo}>
          {`监视已为闭环让出串口${stream.snap.suspend_reason ? `（${stream.snap.suspend_reason}）` : ''} —— run 结束自动恢复。`}
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
      {issuesOpen && stream.issues.length > 0 ? (
        <div role="region" aria-label="结构化异常" style={{ ...barInfo, maxHeight: '220px', overflowY: 'auto' }}>
          {stream.issues.slice().reverse().map((it) => (
            <div key={it.seq} style={{ marginBottom: '6px' }}>
              <div>
                <b>{ISSUE_KIND_LABEL[it.kind] ?? it.kind}</b>
                {` ${it.t}`}
                {it.core ? ` · core ${it.core}` : ''}
                {it.reason ? ` · ${it.reason}` : ''}
                {it.after_reset ? ' · 复位后' : ''}
                {it.kind !== 'reset' && it.backtrace.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void symbolizeIssue(it)}
                    style={{ ...chip, marginLeft: '6px' }}
                    title="把回溯地址解析成函数 / 文件:行（需要工程 ELF）"
                  >
                    符号化
                  </button>
                ) : null}
              </div>
              <div style={metaStyle}>{it.line}</div>
              {it.backtrace.length > 0 ? <div style={metaStyle}>{it.backtrace.join(' ')}</div> : null}
              {(symbols[it.seq] ?? []).map((sym) => (
                <div style={metaStyle} key={sym.addr}>
                  {`${sym.addr} → ${sym.func ?? sym.note ?? '无法解析'}`}
                  {sym.file ? `（${sym.file}:${sym.line ?? '?'}）` : ''}
                </div>
              ))}
            </div>
          ))}
        </div>
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
                : '尚无行输出。点上方「▶ 打开监视」启动会话后，设备输出会实时流进来。'}
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
                  {`${decoderOptions.find((d) => d.id === sharedDecoder)?.label ?? sharedDecoder} · 内核只解 RX（设备输出）`}
                </span>
              </div>
            ) : null}
            {waveErr !== null ? <div style={barWarn}>{`解码失败：${waveErr}`}</div> : null}
            {waveErr === null && shownFrames.length === 0 ? (
              <div style={emptyStyle}>
                {replayMode
                  ? `回放文件里没有解出完整帧：按 ${decoderOptions.find((d) => d.id === decoder)?.label ?? decoder} 解码 ${replay?.chunks.length ?? 0} 批 —— 录制里可能混有不属于该协议的字节，可切方向只看 RX 或换解码器。`
                  : sharedActive
                  ? `尚未解出帧：${decoderOptions.find((d) => d.id === sharedDecoder)?.label ?? sharedDecoder} 解码器已在会话启用，设备开始输出符合该协议的字节后会在这里出现折线（agent 读到的也是这份帧）。`
                  : `尚无波形。设备按 ${decoderOptions.find((d) => d.id === decoder)?.label ?? decoder} 输出（JustFloat：N×4 小端 float + 尾 00 00 80 7F）时，这里按通道画折线。`}
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
                    times={shownTimes}
                    fields={shownFields}
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

      {/* ── 发送面板：与监视会话同一个口（写穿，不重开）── */}
      <form
        onSubmit={(e: any) => void doSend(e)}
        style={{
          flex: '0 0 auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: '6px',
          padding: '8px 12px',
          borderTop: '1px solid var(--elab-border)',
          background: 'var(--elab-bg-surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
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
                  : sendFormat === 'auto'
                    ? '输入任意内容：自动识别 HEX/文本（↑/↓ 调取历史）'
                    : '输入一行并按回车发送到设备'
            }
            aria-label="串口发送内容"
            style={{
              flex: '1 1 auto',
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
              flex: '0 0 auto',
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
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <select
            value={sendFormat}
            onChange={(e: any) => setSendFormat(e.currentTarget.value)}
            aria-label="发送格式"
            title="发送表示：「自动」由服务端判定 HEX/文本；HEX 不追加行尾"
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
            disabled={sendFormat === 'hex' || (sendFormat === 'auto' && sendPreview?.format === 'hex')}
            title={
              sendFormat === 'hex' || (sendFormat === 'auto' && sendPreview?.format === 'hex')
                ? 'HEX 模式不追加行尾（二进制帧多一个字节就是错）'
                : '追加的行结束符'
            }
            style={{
              ...selectStyle,
              opacity: sendFormat === 'hex' || (sendFormat === 'auto' && sendPreview?.format === 'hex') ? 0.5 : 1,
            }}
          >
            {EOLS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={loopInterval}
            onChange={(e: any) => setLoopInterval(e.currentTarget.value)}
            aria-label="定时发送间隔"
            title="定时发送间隔（毫秒，≥20；由内核校验）"
            min={20}
            step={10}
            disabled={rawLoopActive}
            style={{
              width: 58,
              minWidth: 0,
              padding: '2px 6px',
              fontSize: 'var(--elab-fs-xs)',
              fontFamily: 'var(--elab-font-mono)',
              borderRadius: 'var(--elab-radius-sm)',
              border: '1px solid var(--elab-border)',
              background: 'var(--elab-bg-surface)',
              color: 'var(--elab-fg-primary)',
              opacity: rawLoopActive ? 0.5 : 1,
            }}
          />
          <span style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-dimmed)' }}>ms</span>
          <button
            type="button"
            onClick={() => void (rawLoopActive ? cancelJob() : startLoop())}
            disabled={running || !writable || (!rawLoopActive && draft.trim() === '')}
            title="按固定间隔重复发送输入框内容（复用内核任务引擎）"
            style={{
              ...chip,
              padding: '2px 10px',
              opacity: running || !writable || (!rawLoopActive && draft.trim() === '') ? 0.5 : 1,
              cursor: running || !writable || (!rawLoopActive && draft.trim() === '') ? 'not-allowed' : 'pointer',
              borderColor: rawLoopActive ? 'var(--elab-btn-danger-border, var(--elab-border))' : undefined,
              color: rawLoopActive ? 'var(--elab-btn-danger-fg, var(--elab-fg-primary))' : undefined,
            }}
          >
            {rawLoopActive ? '■ 停止定时' : '⏵ 定时'}
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
        </div>
      </form>

      {sendPreview !== null ? (
        sendPreview.ok ? (
          <div style={barInfo}>
            {`将发送 ${sendPreview.bytes} B · ${sendPreview.preview_hex || '（空）'}` +
              (sendPreview.format
                ? ` · 识别为 ${FORMATS.find((f) => f.id === sendPreview.format)?.label ?? sendPreview.format}`
                : '') +
              (sendPreview.format !== 'hex' && sendPreview.eol_key ? ` · 行尾 ${sendPreview.eol_key}` : '')}
          </div>
        ) : (
          <div role="status" style={noticeStyle(true)}>
            {sendPreview.error ?? '预览失败'}
          </div>
        )
      ) : null}
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
          {`监视未启动（${port || 'auto'}@${baud}）—— 点上方「▶ 打开监视」启动。`}
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
  /** M7：每帧批次时间戳（微秒）；null = 无时间源（Δt 显示 —） */
  times?: number[] | null
  /** M7：通道名/单位（工程帧协议的字段表；缺省 CHn） */
  fields?: { name: string; unit: string; type: string; plot: boolean }[]
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
  const { frames, times, fields, channels, scaleX, offsetX, onView, follow, onFollowChange } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<{ startClientX: number; startOffset: number } | null>(null)
  const downRef = useRef<{ x: number; y: number; shift: boolean } | null>(null)
  const dragActive = useRef(false)

  // ── 取消跟随 = 定格画面 ──────────────────────────────────────
  // 波形是"最近 N 字节"的滚动解码窗口：只钉住 offsetX 没用 —— 窗口本身
  // 在滑，同一个 index 已经对应到新数据，曲线看起来就一直在走。
  // 所以 follow=false 时留下**这一刻的帧 + 时间戳快照**，恢复跟随才换回实时帧。
  const [frozen, setFrozen] = useState<{ frames: number[][]; times: number[] | null } | null>(null)
  useEffect(() => {
    if (frames.length === 0) { setFrozen(null); return }
    if (follow) { setFrozen(null); return }
    setFrozen((cur) => cur ?? { frames, times: times ?? null })
  }, [follow, frames, times])
  const shown = follow ? frames : (frozen?.frames ?? frames)
  const shownTimes = follow ? (times ?? null) : (frozen?.times ?? null)

  // ── 每通道坐标（增益/偏移）与游标（M7，与 cockpit 同一套纯函数）──
  const [axis, setAxis] = useState<Record<number, { gain: number; offset: number }>>({})
  const axisOf = (ch: number): { gain: number; offset: number } => axis[ch] ?? { gain: 1, offset: 0 }
  const [axesOpen, setAxesOpen] = useState(false)
  const [cursor, setCursor] = useState<{ a: number | null; b: number | null }>({ a: null, b: null })
  const [snapNotice, setSnapNotice] = useState<string | null>(null)

  const frameChannels = shown[0]?.length ?? 0
  const shownCh = resolvedChannelsDsh(channels, frameChannels)
  const labelOf = (ch: number): string => fields?.[ch]?.name || `CH${ch}`
  const unitOf = (ch: number): string => fields?.[ch]?.unit || ''

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

    const chRange: Record<number, { lo: number; hi: number }> = {}
    for (const ch of shownCh) {
      const values = slice.map((f) => (ch < f.length ? f[ch] : NaN))
      const range = autoRange(values)
      if (!range) continue
      chRange[ch] = range
      const { gain, offset } = axisOf(ch)
      ctx.strokeStyle = palette[ch % palette.length]; ctx.lineWidth = 1.4
      ctx.beginPath()
      let started = false
      for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) { started = false; continue }
        const x = xOf(i)
        const y = valueToY(values[i], range.lo, range.hi, plotH, gain, offset) + plotTop
        if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    // 游标 A/B：竖线 + 通道交点（测量值在画布下方卡片里）
    const drawCursor = (idx: number | null, tag: string): void => {
      if (idx === null || idx < startIdx || idx >= endIdx) return
      const x = xOf(idx - startIdx)
      ctx.save()
      ctx.strokeStyle = tag === 'A' ? palette[0] : palette[2]
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, plotTop); ctx.lineTo(x, plotBottom); ctx.stroke()
      ctx.setLineDash([])
      const f = shown[idx]
      for (const ch of shownCh) {
        const v = f[ch]
        const r = chRange[ch]
        if (!r || !Number.isFinite(v)) continue
        const { gain, offset } = axisOf(ch)
        const y = valueToY(v, r.lo, r.hi, plotH, gain, offset) + plotTop
        ctx.fillStyle = palette[ch % palette.length]
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill()
      }
      ctx.fillStyle = tag === 'A' ? palette[0] : palette[2]
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'
      ctx.fillText(tag, Math.max(padL, Math.min(w - padR - 8, x + 4)), plotTop + 2)
      ctx.restore()
    }
    drawCursor(cursor.a, 'A')
    drawCursor(cursor.b, 'B')

    ctx.fillStyle = axisLabel; ctx.textBaseline = 'top'
    ctx.textAlign = 'left'; ctx.fillText(`帧 ${startIdx} → ${endIdx - 1}`, padL, 2)
    ctx.textAlign = 'right'; ctx.fillText(`共 ${shown.length} 帧 · 窗口 ${endIdx - startIdx} · ×${scaleX.toFixed(1)}`, w - padR, 2)
  }, [shown, scaleX, offsetX, shownCh, axis, cursor])

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
    downRef.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey }
    dragActive.current = true; e.preventDefault()
  }
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragActive.current || !dragRef.current) return
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const plotW = rect.width - 44 - 8
    const dx = e.clientX - dragRef.current.startClientX
    // 与绘制同源：帧数少于视口槽位时，一屏实际帧跨度是 min(槽位, 剩余帧)。
    const visibleCount = Math.max(2, Math.round(plotW / scaleX))
    const startOffset = dragRef.current.startOffset
    const span = Math.max(1, Math.min(visibleCount, shown.length - Math.min(startOffset, shown.length - 1)))
    const offsetDelta = Math.round(-dx * span / plotW)
    let newOffset = dragRef.current.startOffset + offsetDelta
    newOffset = Math.max(0, Math.min(newOffset, Math.max(0, shown.length - visibleCount)))
    if (newOffset !== dragRef.current.startOffset) onView(scaleX, newOffset)
    if (follow) onFollowChange(false)
  }
  /**
   * 松开鼠标：位移 ≤4px 视为「点选游标」（拖拽是平移，不落游标）。
   * 普通点击 = A（清空 B）；Shift+点击 = B。
   */
  const endDrag = (e?: React.MouseEvent<HTMLCanvasElement>): void => {
    const down = downRef.current
    dragActive.current = false
    dragRef.current = null
    downRef.current = null
    const canvas = canvasRef.current
    if (!e || !down || !canvas || !shown.length) return
    if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4) return
    const rect = canvas.getBoundingClientRect()
    const padL = 8
    const plotW = rect.width - padL - 8
    if (plotW <= 4) return
    const visibleCount = Math.max(2, Math.round(plotW / scaleX))
    // 与绘制同源：slice 铺满整宽时，一屏的真实帧数是 min(槽位, 剩余帧)。
    const span = Math.max(1, Math.min(visibleCount, shown.length - Math.min(offsetX, shown.length - 1)))
    const within = nearestFrameIndex((e.clientX - rect.left - padL) / plotW, span)
    const idx = Math.max(0, Math.min(shown.length - 1, offsetX + within))
    setCursor((prev) => (down.shift ? { a: prev.a ?? idx, b: idx } : { a: idx, b: null }))
  }

  // ── 测量（M7）：A/B 的 Δ帧、Δt、每通道 ΔY ──────────────────
  const probe = (i: number | null): { index: number; t_us?: number; values: number[] } | null =>
    (i === null || !shown[i]) ? null : { index: i, t_us: shownTimes?.[i], values: shown[i] }
  const pa = probe(cursor.a)
  const pb = probe(cursor.b)
  const delta = pa && pb
    ? measure(pa, pb, shownCh.map((ch) => axisOf(ch).gain), shownCh.map((ch) => axisOf(ch).offset))
    : null
  const frozenAt = !follow && frozen ? frozen.frames.length - 1 : null
  const frozenTime = frozenAt !== null && shownTimes?.[frozenAt] !== undefined
    ? new Date(shownTimes[frozenAt] / 1000).toISOString().slice(11, 23)
    : null
  const copySnapshot = (): void => {
    const text = snapshotJson({
      frozen: !follow,
      scaleX,
      offsetX,
      frameCount: shown.length,
      cursors: { a: pa, b: pb },
      channels: shownCh.map((ch) => ({
        index: ch, label: labelOf(ch), unit: unitOf(ch),
        gain: axisOf(ch).gain, offset: axisOf(ch).offset,
      })),
    })
    void navigator.clipboard?.writeText(text).then(
      () => setSnapNotice('快照已复制到剪贴板'),
      () => setSnapNotice('剪贴板不可用（快照未复制）'),
    )
  }

  const canvasReady = shown.length > 0
  const chip: React.CSSProperties = { padding: '2px 8px', fontSize: 12, lineHeight: 1, border: '1px solid var(--elab-border)', borderRadius: 'var(--elab-radius-sm)', background: 'var(--elab-bg-surface)', color: 'var(--elab-fg-secondary)', cursor: 'pointer', fontFamily: 'inherit' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-secondary)', flex: '1 1 auto' }}>
          {shownCh.map((ch) => (
            <span key={ch} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              title={`${labelOf(ch)}${unitOf(ch) ? ` (${unitOf(ch)})` : ''} · gain ${axisOf(ch).gain} · offset ${axisOf(ch).offset}`}>
              <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: `var(--elab-ansi-${WAVE_TOKENS[ch % 8]})` }} />
              {labelOf(ch)}{unitOf(ch) ? ` (${unitOf(ch)})` : ''}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button type="button" onClick={() => onView(Math.max(1, scaleX / 1.2), offsetX)} style={chip} disabled={!canvasReady} title="缩小（向后看更多帧）">−</button>
          <button type="button" onClick={() => onView(Math.min(20, scaleX * 1.2), offsetX)} style={chip} disabled={!canvasReady} title="放大（看更精细的局部）">+</button>
          <button type="button" onClick={() => onView(1, 0)} style={chip} disabled={!canvasReady} title="重置（全部可见、回到开头）">⤾</button>
          <button type="button" onClick={() => setAxesOpen((v) => !v)} style={{ ...chip, ...(axesOpen ? { color: 'var(--elab-accent)', borderColor: 'var(--elab-accent)' } : {}) }} disabled={!canvasReady} title="每通道坐标：增益（压扁/放大曲线）与偏移（整条上移/下移）">通道</button>
          <button type="button" onClick={() => setCursor({ a: null, b: null })} style={chip} disabled={cursor.a === null} title="清空游标 A/B（点击画布放 A，Shift+点击放 B）">清游标</button>
          <button type="button" onClick={copySnapshot} style={chip} disabled={!canvasReady} title="把视口 + 游标 + 通道坐标复制成 JSON">快照</button>
          <button type="button" onClick={() => onFollowChange(!follow)} style={{ ...chip, ...(follow ? { color: 'var(--elab-accent)', borderColor: 'var(--elab-accent)' } : {}) }} disabled={!canvasReady} title={follow ? '正在跟随最新帧，点击暂停（画面定格在当前窗口，数据仍继续接收）' : '画面已定格，点击恢复跟随最新帧'}>
            {follow ? '❚❚ 暂停跟随' : '▶ 恢复跟随'}
          </button>
        </div>
      </div>
      {frozenAt !== null ? (
        <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-faint)' }}>
          ❚❚ 已冻结 @ #{frozenAt}{frozenTime ? ` · ${frozenTime}` : ''}　（数据仍在接收；点「恢复跟随」回到实时）
        </div>
      ) : null}
      {snapNotice ? (
        <div style={{ fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-faint)' }}>{snapNotice}</div>
      ) : null}
      {axesOpen ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', fontSize: 'var(--elab-fs-xs)' }}>
          {shownCh.map((ch) => {
            const a = axisOf(ch)
            const inputStyle: React.CSSProperties = { width: '58px', padding: '1px 4px', fontFamily: 'var(--elab-font-mono)', fontSize: 'var(--elab-fs-xs)', color: 'var(--elab-fg-primary)', background: 'var(--elab-bg-code)', border: '1px solid var(--elab-border)', borderRadius: 'var(--elab-radius-sm)' }
            return (
              <span key={ch} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: `var(--elab-ansi-${WAVE_TOKENS[ch % 8]})` }} />
                <span style={{ fontFamily: 'var(--elab-font-mono)', color: 'var(--elab-fg-secondary)' }}>
                  {labelOf(ch)}{unitOf(ch) ? ` (${unitOf(ch)})` : ''}
                </span>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: 'var(--elab-fg-faint)' }}>
                  增益
                  <input type="number" step="0.1" value={a.gain} style={inputStyle}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      const v = Number(e.currentTarget.value)
                      setAxis((prev) => ({ ...prev, [ch]: { gain: Number.isFinite(v) ? v : 1, offset: a.offset } }))
                    }} />
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: 'var(--elab-fg-faint)' }}>
                  偏移
                  <input type="number" step="1" value={a.offset} style={inputStyle}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      const v = Number(e.currentTarget.value)
                      setAxis((prev) => ({ ...prev, [ch]: { gain: a.gain, offset: Number.isFinite(v) ? v : 0 } }))
                    }} />
                </label>
                <button type="button" style={{ ...chip, padding: '1px 6px' }} title="该通道恢复默认坐标（gain=1, offset=0）"
                  onClick={() => setAxis((prev) => ({ ...prev, [ch]: { gain: 1, offset: 0 } }))}>↺</button>
              </span>
            )
          })}
          <span style={{ flexBasis: '100%', color: 'var(--elab-fg-faint)' }}>
            量程按原始值自动计算：改增益会压扁/放大曲线，改偏移会整体上下移动（不改原始数据）。
          </span>
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '220px', display: 'block', background: 'var(--elab-bg-surface)', border: '1px solid var(--elab-border)', borderRadius: 'var(--elab-radius-sm)', cursor: canvasReady ? (dragActive.current ? 'grabbing' : 'crosshair') : 'default' }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={() => endDrag()}
      />
      {pa ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '4px', borderTop: '1px dashed var(--elab-border)', fontSize: 'var(--elab-fs-xs)', fontFamily: 'var(--elab-font-mono)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', color: 'var(--elab-fg-secondary)' }}>
            <span>A #{pa.index}{pa.t_us !== undefined ? ` · ${new Date(pa.t_us / 1000).toISOString().slice(11, 23)}` : ''}</span>
            {pb ? (
              <>
                <span>B #{pb.index}{pb.t_us !== undefined ? ` · ${new Date(pb.t_us / 1000).toISOString().slice(11, 23)}` : ''}</span>
                <span style={{ color: 'var(--elab-fg-primary)', fontWeight: 600 }}>
                  Δ帧 {delta?.d_frames ?? '—'}　Δt {fmtDuration(delta?.dt_us ?? null)}
                </span>
              </>
            ) : (
              <span style={{ color: 'var(--elab-fg-faint)' }}>Shift+点击设置 B（当前只有 A）</span>
            )}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--elab-fs-xs)', fontFamily: 'var(--elab-font-mono)' }}>
            <thead>
              <tr style={{ color: 'var(--elab-fg-secondary)' }}>
                <th style={{ textAlign: 'left', padding: '2px 6px', borderBottom: '1px solid var(--elab-border)' }}>通道</th>
                <th style={{ textAlign: 'left', padding: '2px 6px', borderBottom: '1px solid var(--elab-border)' }}>A</th>
                {pb ? <th style={{ textAlign: 'left', padding: '2px 6px', borderBottom: '1px solid var(--elab-border)' }}>B</th> : null}
                {pb ? <th style={{ textAlign: 'left', padding: '2px 6px', borderBottom: '1px solid var(--elab-border)' }}>Δ原始</th> : null}
                <th style={{ textAlign: 'left', padding: '2px 6px', borderBottom: '1px solid var(--elab-border)' }}>{pb ? 'Δ缩放' : '单位'}</th>
              </tr>
            </thead>
            <tbody>
              {shownCh.map((ch, i) => (
                <tr key={ch}>
                  <td style={{ padding: '2px 6px' }}>{labelOf(ch)}</td>
                  <td style={{ padding: '2px 6px' }}>{fmtValue(pa.values[ch])}</td>
                  {pb ? <td style={{ padding: '2px 6px' }}>{fmtValue(pb.values[ch])}</td> : null}
                  {pb ? <td style={{ padding: '2px 6px' }}>{fmtValue(delta?.dy[i] ?? NaN)}</td> : null}
                  <td style={{ padding: '2px 6px' }}>{pb ? fmtValue(delta?.dy_scaled[i] ?? NaN) : (unitOf(ch) || '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ color: 'var(--elab-fg-faint)' }}>
            {shownTimes === null
              ? '当前窗口没有时间源（会话未开或未启用共享解码）→ Δt 显示 —。'
              : 'Δt 用 RX 批次时间戳（同批多帧时间相同），精度受批大小限制。'}
          </div>
        </div>
      ) : null}
    </div>
  )
}
