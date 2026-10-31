/**
 * ANSI **流式**终端解析器（P2）。
 *
 * 与 `theme/ansi.ts` 的区别：那边是"一行日志 → spawn"，无状态、逐行；
 * 这里要按**字节流**维护屏幕状态 —— `\r` 覆写同一行、`\b` 退格、
 * CSI SGR/K/J 改色清屏，多字节字符跨批次也不能被截断成乱码。
 *
 * 算法来源：Lissio-Client `src/lib/terminal/ansiParser.ts`
 * （Apache-2.0，commit edf17b5，https://codeberg.org/Horldsence/Lissio），
 * 按 elab 的轮询字节模型**重写**（不是整文件复制）：
 *   - 原实现挂在 xterm 式的完整状态机上，这里只保留终端视图真正用得上的子集；
 *   - 编码由 `TextDecoder({stream:true})` 负责（UTF-8 / GBK 均可），
 *     解析器本身只处理已解码的字符串。
 */

const ESC = "\u001b";

type Cell = { ch: string; cls: string };
export type TermSpan = { text: string; cls: string };

/** 一行的连续同色片段（渲染只需 span，不必逐个字符建节点） */
export type TermLine = TermSpan[];

const FG: Record<number, string> = {
  30: "black", 31: "red", 32: "green", 33: "yellow",
  34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "bright-black", 91: "bright-red", 92: "bright-green",
  93: "bright-yellow", 94: "bright-blue", 95: "bright-magenta",
  96: "bright-cyan", 97: "bright-white",
};

const MAX_LINES = 4000;

export class AnsiTerminal {
  private lines: Cell[][] = [[]];
  private row = 0;
  private col = 0;
  private bold = false;
  private fg = "";
  /** CSI 中间态：ESC 已收到，正在攒参数 */
  private csi: string | null = null;

  /** 喂一段**已解码**文本。 */
  feed(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (this.csi !== null) {
        // ★ 引导符 `[` 本身不是参数，也**不是**终止字节（它的码位 0x5B 恰好
        //   落在终止区间 @–~ 内 —— 以前把它算进缓冲区，一进来就"终止"，
        //   于是 `ESC[33m` 的参数全被当成正文吐出来，表现为终端里出现
        //   "33m" / "0m" 这类乱码，且颜色永远不生效）。
        if (this.csi === "") {
          if (ch === "[") {
            this.csi = "[";
          } else {
            // 非 CSI 转义（如 `ESC(B`）：整段丢掉，别漏成文本
            this.csi = null;
          }
          continue;
        }
        if (ch >= "0" && ch <= "?") {        // 参数字节 0x30–0x3F
          this.csi += ch;
          continue;
        }
        if (ch >= "@" && ch <= "~") {        // 终止字节
          const body = this.csi.slice(1) + ch;
          this.csi = null;
          this.applyCsi(body);
          continue;
        }
        // 序列里出现非法字节：直接放弃这一段
        this.csi = null;
        continue;
      }

      if (ch === ESC) {
        this.csi = "";
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        continue;
      }
      if (ch === "\n") {
        this.newline();
        continue;
      }
      if (ch === "\b") {
        this.col = Math.max(0, this.col - 1);
        continue;
      }
      // 其它 C0 控制字符（响铃/制表等）忽略
      if (ch < " ") continue;

      this.writeCell(ch);
    }
  }

  /** 当前屏幕快照。深拷贝很便宜（行数有上限，视图只读）。 */
  snapshot(): TermLine[] {
    return this.lines.map((cells) => groupSpans(cells));
  }

  get lineCount(): number {
    return this.lines.length;
  }

  private style(): string {
    const parts: string[] = [];
    if (this.bold) parts.push("a-bold");
    if (this.fg) parts.push(`a-${this.fg}`);
    return parts.join(" ");
  }

  private writeCell(ch: string): void {
    const line = this.lines[this.row];
    const cell: Cell = { ch, cls: this.style() };
    if (this.col < line.length) line[this.col] = cell;
    else line.push(cell);
    this.col += 1;
  }

  private newline(): void {
    this.row += 1;
    this.col = 0;
    if (this.row >= this.lines.length) this.lines.push([]);
    if (this.lines.length > MAX_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LINES);
      this.row = this.lines.length - 1;
    }
  }

  private applyCsi(body: string): void {
    if (body === "") return;
    const final = body[body.length - 1];
    const params = body.slice(0, -1);

    if (final === "m") {
      this.applySgr(params);
      return;
    }
    if (final === "K") {
      const mode = parseInt(params || "0", 10);
      const line = this.lines[this.row];
      if (mode === 2) line.length = 0;
      else if (mode === 1) line.splice(0, Math.min(this.col, line.length));
      else line.length = Math.min(line.length, this.col);
      return;
    }
    if (final === "J") {
      const mode = parseInt(params || "0", 10);
      if (mode === 2) {
        this.lines = [[]];
        this.row = 0;
        this.col = 0;
      }
      return;
    }
    // 光标移动/滚屏等：终端视图不做交互，忽略（序列已被吃掉，不会漏成乱码）
  }

  private applySgr(params: string): void {
    const codes = (params || "0").split(";").map((s) => parseInt(s || "0", 10));
    for (const code of codes) {
      if (code === 0) {
        this.bold = false;
        this.fg = "";
      } else if (code === 1) {
        this.bold = true;
      } else if (code === 22) {
        this.bold = false;
      } else if (FG[code]) {
        this.fg = FG[code];
      } else if (code === 39) {
        this.fg = "";
      }
      // 背景色/下划线等：本地串口输出里极少见，刻意不做（与 theme/ansi 同一取舍）
    }
  }
}

function groupSpans(cells: Cell[]): TermSpan[] {
  const out: TermSpan[] = [];
  for (const c of cells) {
    const last = out[out.length - 1];
    if (last && last.cls === c.cls) last.text += c.ch;
    else out.push({ text: c.ch, cls: c.cls });
  }
  return out;
}

/**
 * 字节 → 文本的**流式**解码器。
 *
 * ★ 每批独立 `decode()` 会在多字节字符跨批次时产生 `�` —— 终端视图必须
 *   保持 TextDecoder 状态（`{stream:true}`）。切换编码时新建一个（视图重置）。
 */
export class StreamTextDecoder {
  private dec: TextDecoder;
  private failed = false;

  constructor(encoding: string) {
    const label = encoding === "gbk" || encoding === "ascii" ? encoding : "utf-8";
    try {
      this.dec = new TextDecoder(label, { fatal: false });
    } catch {
      // 浏览器不认该 label（如少数精简构建）→ 退回 UTF-8，不让视图崩掉
      this.dec = new TextDecoder("utf-8", { fatal: false });
      this.failed = true;
    }
  }

  get fallback(): boolean {
    return this.failed;
  }

  decode(bytes: Uint8Array): string {
    return this.dec.decode(bytes, { stream: true });
  }
}

/** 把 base64 还原成字节（浏览器自带 `atob`，不引依赖）。 */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 字节 → base64（导出/解码请求用）。 */
export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
