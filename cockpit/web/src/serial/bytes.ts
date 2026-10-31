/**
 * 字节的**投影**（HEX / ASCII / UTF-8 / GBK）。
 *
 * 原文永远在 `SerialChunk.data_b64`；这里只做显示与导出，不改变任何采集语义。
 * 注意：逐批独立解码在**多字节字符跨批次**时可能产生 `�` —— 终端视图因此
 * 走 `StreamTextDecoder`（保持状态），这里只服务"字节/行"这类无状态视图。
 */

export type SerialRepr = "hex" | "ascii" | "utf8" | "gbk";

export function printable(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
}

/** 一段字节的 HEX（大写、空格分隔） */
export function hexOf(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i].toString(16).padStart(2, "0").toUpperCase());
  }
  return out.join(" ");
}

/** 纯 ASCII 视图：不可打印字符用 `.` 占位（字节网格的右列） */
export function asciiOf(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += printable(bytes[i]);
  return out;
}

export function textOf(bytes: Uint8Array, repr: SerialRepr): string {
  if (repr === "hex") return hexOf(bytes);
  if (repr === "ascii") return asciiOf(bytes);
  const label = repr === "gbk" ? "gbk" : "utf-8";
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/**
 * 字节网格：每 16 字节一行，左侧**批内偏移**，中间 HEX，右侧 ASCII。
 * 返回纯文本行数组（由视图直接渲染，避免每个字节建 DOM 节点）。
 */
export function hexDump(bytes: Uint8Array, perRow = 16): string[] {
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += perRow) {
    const slice = bytes.subarray(i, Math.min(i + perRow, bytes.length));
    const hex: string[] = [];
    for (let j = 0; j < perRow; j++) {
      hex.push(j < slice.length ? slice[j].toString(16).padStart(2, "0").toUpperCase() : "..");
    }
    rows.push(
      `${i.toString(16).padStart(4, "0")}  ${hex.slice(0, 8).join(" ")}  ` +
        `${hex.slice(8).join(" ")}  |${asciiOf(slice)}|`,
    );
  }
  return rows;
}

/** 导出用：一段可读的头部 + 逐批 HEX。 */
export function captureText(chunks: Array<{ seq: number; dir: string; t: string; bytes: Uint8Array }>): string {
  const head = [
    "# elab serial capture",
    `# chunks: ${chunks.length}`,
    `# exported: ${new Date().toISOString()}`,
    "",
  ];
  const body = chunks.map(
    (c) =>
      `#000${c.seq} ${c.dir.toUpperCase()} ${c.t} (${c.bytes.length} B)\n` +
      hexDump(c.bytes).join("\n"),
  );
  return head.join("\n") + body.join("\n\n") + "\n";
}
