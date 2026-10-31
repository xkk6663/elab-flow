/**
 * ANSI **流式**终端解析器 —— 移植自 `cockpit/web/src/serial/ansiTerminal.ts`。
 *
 * 与 `theme/ansi.ts` 的区别：那边是"一行日志 → span"，无状态、逐行；
 * 这里要按**字节流**维护屏幕状态 —— `\r` 覆写同一行、`\b` 退格、
 * CSI SGR/K/J 改色清屏，多字节字符跨批次也不能被截断成乱码。
 */

const ESC = '\u001b'

type Cell = { ch: string; cls: string }
export type TermSpan = { text: string; cls: string }

/** 一行的连续同色片段（渲染只需 span，不必逐个字符建节点） */
export type TermLine = TermSpan[]

const FG: Record<number, string> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  90: 'bright-black',
  91: 'bright-red',
  92: 'bright-green',
  93: 'bright-yellow',
  94: 'bright-blue',
  95: 'bright-magenta',
  96: 'bright-cyan',
  97: 'bright-white',
}

const MAX_LINES = 4000

export class AnsiTerminal {
  private lines: Cell[][] = [[]]
  private row = 0
  private col = 0
  private bold = false
  private fg = ''
  /** CSI 中间态：ESC 已收到，正在攒参数 */
  private csi: string | null = null

  /** 喂一段**已解码**文本。 */
  feed(text: string): void {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]

      if (this.csi !== null) {
        // 引导符 `[` 本身不是参数，也**不是**终止字节（它的码位 0x5B 恰好
        // 落在终止区间 @–~ 内 —— 算进缓冲区会让 `ESC[33m` 的参数当正文吐出来）。
        if (this.csi === '') {
          if (ch === '[') this.csi = '['
          else this.csi = null
          continue
        }
        if (ch >= '0' && ch <= '?') {
          this.csi += ch
          continue
        }
        if (ch >= '@' && ch <= '~') {
          const body = this.csi.slice(1) + ch
          this.csi = null
          this.applyCsi(body)
          continue
        }
        this.csi = null
        continue
      }

      if (ch === ESC) {
        this.csi = ''
        continue
      }
      if (ch === '\r') {
        this.col = 0
        continue
      }
      if (ch === '\n') {
        this.newline()
        continue
      }
      if (ch === '\b') {
        this.col = Math.max(0, this.col - 1)
        continue
      }
      // 其它 C0 控制字符（响铃/制表等）忽略
      if (ch < ' ') continue

      this.writeCell(ch)
    }
  }

  /** 当前屏幕快照（深拷贝很便宜：行数有上限，视图只读）。 */
  snapshot(): TermLine[] {
    return this.lines.map((cells) => groupSpans(cells))
  }

  get lineCount(): number {
    return this.lines.length
  }

  private style(): string {
    const parts: string[] = []
    if (this.bold) parts.push('a-bold')
    if (this.fg) parts.push(`a-${this.fg}`)
    return parts.join(' ')
  }

  private writeCell(ch: string): void {
    const line = this.lines[this.row]
    const cell: Cell = { ch, cls: this.style() }
    if (this.col < line.length) line[this.col] = cell
    else line.push(cell)
    this.col += 1
  }

  private newline(): void {
    this.row += 1
    this.col = 0
    if (this.row >= this.lines.length) this.lines.push([])
    if (this.lines.length > MAX_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LINES)
      this.row = this.lines.length - 1
    }
  }

  private applyCsi(body: string): void {
    if (body === '') return
    const final = body[body.length - 1]
    const params = body.slice(0, -1)

    if (final === 'm') {
      this.applySgr(params)
      return
    }
    if (final === 'K') {
      const mode = parseInt(params || '0', 10)
      const line = this.lines[this.row]
      if (mode === 2) line.length = 0
      else if (mode === 1) line.splice(0, Math.min(this.col, line.length))
      else line.length = Math.min(line.length, this.col)
      return
    }
    if (final === 'J') {
      const mode = parseInt(params || '0', 10)
      if (mode === 2) {
        this.lines = [[]]
        this.row = 0
        this.col = 0
      }
      return
    }
    // 光标移动/滚屏等：终端视图不做交互，忽略（序列已被吃掉，不会漏成乱码）
  }

  private applySgr(params: string): void {
    const codes = (params || '0').split(';').map((s) => parseInt(s || '0', 10))
    for (const code of codes) {
      if (code === 0) {
        this.bold = false
        this.fg = ''
      } else if (code === 1) {
        this.bold = true
      } else if (code === 22) {
        this.bold = false
      } else if (FG[code] !== undefined) {
        this.fg = FG[code]
      } else if (code === 39) {
        this.fg = ''
      }
    }
  }
}

function groupSpans(cells: Cell[]): TermSpan[] {
  const out: TermSpan[] = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last !== undefined && last.cls === c.cls) last.text += c.ch
    else out.push({ text: c.ch, cls: c.cls })
  }
  return out
}

/**
 * 字节 → 文本的**流式**解码器。
 *
 * 每批独立 `decode()` 会在多字节字符跨批次时产生 `�` —— 终端视图必须
 * 保持 TextDecoder 状态（`{stream:true}`）。切换编码时新建一个（视图重置）。
 */
export class StreamTextDecoder {
  private dec: TextDecoder

  constructor(encoding: string) {
    const label = encoding === 'gbk' || encoding === 'ascii' ? encoding : 'utf-8'
    try {
      this.dec = new TextDecoder(label, { fatal: false })
    } catch {
      this.dec = new TextDecoder('utf-8', { fatal: false })
    }
  }

  decode(bytes: Uint8Array): string {
    return this.dec.decode(bytes, { stream: true })
  }
}
