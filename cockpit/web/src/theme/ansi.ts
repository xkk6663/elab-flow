/**
 * ANSI SGR 渲染 —— 把编译器/openocd/gdb 的彩色输出变成带 class 的片段。
 *
 * 为什么不用现成库：整个前端刻意零运行时依赖（§15.1），且这里只需要
 * 16 色 + 粗体 + 复位，几十行足够。
 *
 * ★ 关键点：**颜色不在这里定值**，只产出语义 class（`a-red` / `a-bright-green` …），
 *   真正的色值在 tokens.css 里按主题各给一套。否则暗色下编译器输出会看不清
 *   —— §15.4 点名说这是"最容易踩的坑"。
 */

export type Span = { text: string; cls: string };

/** SGR 码 → 语义 class 后缀（0-7 前景，8-15 亮色） */
const FG: Record<number, string> = {
  30: "black",
  31: "red",
  32: "green",
  33: "yellow",
  34: "blue",
  35: "magenta",
  36: "cyan",
  37: "white",
  90: "bright-black",
  91: "bright-red",
  92: "bright-green",
  93: "bright-yellow",
  94: "bright-blue",
  95: "bright-magenta",
  96: "bright-cyan",
  97: "bright-white",
};

const ESC = "\u001b";
// 匹配 CSI SGR 序列：ESC [ 参数 m
const SGR_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

/**
 * 把一行含 ANSI 的文本切成带语义 class 的片段。
 * 不认识的 SGR 参数（光标移动、清屏等）被忽略但**会被吃掉**，避免出现乱码 `[0m`。
 */
export function parseAnsi(input: string): Span[] {
  if (!input) return [];
  if (!input.includes(ESC)) return [{ text: input, cls: "" }];

  const out: Span[] = [];
  let bold = false;
  let cursor = 0;
  SGR_RE.lastIndex = 0;

  const push = (text: string) => {
    if (!text) return;
    const parts = ["a"];
    if (bold) parts.push("a-bold");
    out.push({ text, cls: parts.length > 1 ? parts.join(" ") : "" });
  };

  let m: RegExpExecArray | null;
  while ((m = SGR_RE.exec(input)) !== null) {
    push(input.slice(cursor, m.index));
    cursor = SGR_RE.lastIndex;

    const codes = (m[1] || "0").split(";").map((s) => parseInt(s || "0", 10));
    for (const code of codes) {
      if (code === 0) bold = false;
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (FG[code]) out.push({ text: "", cls: `a-${FG[code]}` });
      else if (code === 39) out.push({ text: "", cls: "a" });
      // 其它（背景色 40-47、下划线 4 等）忽略：本地日志里极少见，不值得加复杂度
    }
  }
  push(input.slice(cursor));
  return out;
}

/** 常见错误关键字 —— 串口/编译日志里要额外高亮的词 */
const ALERT = /\b(error|fail(?:ed|ure)?|fatal|HardFault|Hard Fault|assert|PANIC|abort)\b/i;
const WARN = /\b(warn(?:ing)?|deprecated)\b/i;

/** 一行日志的"语气"，供左侧色条与计数使用 */
export function lineTone(text: string): "alert" | "warn" | "normal" {
  const plain = stripAnsi(text);
  if (ALERT.test(plain)) return "alert";
  if (WARN.test(plain)) return "warn";
  return "normal";
}

export function stripAnsi(text: string): string {
  return text.replace(SGR_RE, "");
}
