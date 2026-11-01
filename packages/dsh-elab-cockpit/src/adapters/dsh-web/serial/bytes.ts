/**
 * 字节的**投影**（HEX / ASCII / UTF-8 / GBK）—— 移植自 `cockpit/web/src/serial/bytes.ts`。
 *
 * 原文永远在 `SerialChunk.data_b64`；这里只做显示与导出，不改变任何采集语义。
 * 逐批独立解码在**多字节字符跨批次**时可能产生 `�` —— 终端视图因此走
 * `StreamTextDecoder`（保持状态），这里只服务"字节/行"这类无状态视图。
 */

export type SerialRepr = 'hex' | 'ascii' | 'utf8' | 'gbk'

/** base64 → 字节（浏览器自带 atob，不引依赖）。 */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/** 字节 → base64（解码请求/导出用）。 */
export function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function printable(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'
}

/** 一段字节的 HEX（大写、空格分隔）。 */
export function hexOf(bytes: Uint8Array): string {
  const out: string[] = []
  for (let i = 0; i < bytes.length; i += 1) out.push(bytes[i].toString(16).padStart(2, '0').toUpperCase())
  return out.join(' ')
}

/** 纯 ASCII 视图：不可打印字符用 `.` 占位。 */
export function asciiOf(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) out += printable(bytes[i])
  return out
}

export function textOf(bytes: Uint8Array, repr: SerialRepr): string {
  if (repr === 'hex') return hexOf(bytes)
  if (repr === 'ascii') return asciiOf(bytes)
  const label = repr === 'gbk' ? 'gbk' : 'utf-8'
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

/**
 * 字节网格：每 16 字节一行，左侧批内偏移，中间 HEX，右侧 ASCII。
 * 返回纯文本行数组（视图直接渲染，避免每个字节建 DOM 节点）。
 */
export function hexDump(bytes: Uint8Array, perRow = 16): string[] {
  const rows: string[] = []
  for (let i = 0; i < bytes.length; i += perRow) {
    const slice = bytes.subarray(i, Math.min(i + perRow, bytes.length))
    const hex: string[] = []
    for (let j = 0; j < perRow; j += 1) {
      hex.push(j < slice.length ? slice[j].toString(16).padStart(2, '0').toUpperCase() : '..')
    }
    rows.push(
      `${i.toString(16).padStart(4, '0')}  ${hex.slice(0, 8).join(' ')}  ` +
        `${hex.slice(8).join(' ')}  |${asciiOf(slice)}|`,
    )
  }
  return rows
}

/** 字节分类（HEX 视图按类着色；不是协议语义，只是"看得懂"的辅助）。 */
export type ByteClass = 'ctl' | 'del' | 'print' | 'high'

export function byteClass(b: number): ByteClass {
  if (b < 0x20) return 'ctl'
  if (b === 0x7f) return 'del'
  if (b <= 0x7e) return 'print'
  return 'high'
}

export interface HexCell {
  text: string
  /** 'pad' = 补齐用的 `..`（不是真实字节，按 faint 显示） */
  cls: ByteClass | 'pad'
}

export interface HexRow {
  offset: string
  cells: HexCell[]
  ascii: HexCell[]
}

/**
 * 结构化字节网格（与 `hexDump` 同一排版，但每个字节带分类）。
 * 视图按类给出颜色，偏移量/ASCII 列与 `hexDump` 完全一致。
 */
export function hexDumpRows(bytes: Uint8Array, perRow = 16): HexRow[] {
  const rows: HexRow[] = []
  for (let i = 0; i < bytes.length; i += perRow) {
    const slice = bytes.subarray(i, Math.min(i + perRow, bytes.length))
    const cells: HexCell[] = []
    const ascii: HexCell[] = []
    for (let j = 0; j < perRow; j += 1) {
      if (j < slice.length) {
        const b = slice[j]
        cells.push({ text: b.toString(16).padStart(2, '0').toUpperCase(), cls: byteClass(b) })
        ascii.push({ text: printable(b), cls: byteClass(b) })
      } else {
        cells.push({ text: '..', cls: 'pad' })
        ascii.push({ text: '.', cls: 'pad' })
      }
    }
    rows.push({ offset: i.toString(16).padStart(4, '0'), cells, ascii })
  }
  return rows
}

/** 导出用：一段可读头部 + 逐批 HEX。 */
export function captureText(chunks: Array<{ seq: number; dir: string; t: string; bytes: Uint8Array }>): string {
  const head = [
    '# elab serial capture',
    `# chunks: ${chunks.length}`,
    `# exported: ${new Date().toISOString()}`,
    '',
  ]
  const body = chunks.map(
    (c) =>
      `#${String(c.seq).padStart(5, '0')} ${c.dir.toUpperCase()} ${c.t} (${c.bytes.length} B)\n` +
      hexDump(c.bytes).join('\n'),
  )
  return `${head.join('\n') + body.join('\n\n')}\n`
}
