/**
 * 串口发送历史（纯函数）。
 *
 * ★ 为什么单独放在共享层：驾驶舱 WebUI 与 DSH 窄栏都要"记住前几次发送"，
 *   且必须**连格式与行尾一起记住** —— 只存文本会出现"回填一条 HEX 命令、
 *   当前却是文本模式"，于是按文本把 `0A FF` 发出去。
 *
 * 存储格式兼容旧版本（`string[]`）：旧条目迁移为 `format:"auto"`、`eol:"crlf"`，
 * 读不懂的条目直接丢弃，不影响发送。
 */

import type { SerialEol, SerialFormat } from "./icd.ts";

/** 服务端认的发送格式（含「自动」）。 */
export const SEND_FORMATS: readonly SerialFormat[] = ["auto", "ascii", "utf8", "gbk", "hex"];
/** 服务端认的行尾。 */
export const SEND_EOLS: readonly SerialEol[] = ["none", "lf", "cr", "crlf", "tab"];

/** 历史条数上限（跨会话记忆，浏览器本地）。 */
export const SEND_HISTORY_MAX = 50;

export interface SendHistoryEntry {
  text: string;
  format: SerialFormat;
  eol: SerialEol;
  /** 毫秒时间戳（旧条目为 0）；只用于排序展示，不参与去重 */
  at: number;
}

function isFormat(x: unknown): x is SerialFormat {
  return typeof x === "string" && (SEND_FORMATS as readonly string[]).includes(x);
}

function isEol(x: unknown): x is SerialEol {
  return typeof x === "string" && (SEND_EOLS as readonly string[]).includes(x);
}

/** 解析 localStorage 里的 JSON：兼容旧的 `string[]`，坏数据一律丢弃。 */
export function parseSendHistory(raw: string | null): SendHistoryEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: SendHistoryEntry[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ text: item, format: "auto", eol: "crlf", at: 0 });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const e = item as Partial<SendHistoryEntry>;
    if (typeof e.text !== "string" || !e.text.trim()) continue;
    out.push({
      text: e.text,
      format: isFormat(e.format) ? e.format : "auto",
      eol: isEol(e.eol) ? e.eol : "crlf",
      at: typeof e.at === "number" ? e.at : 0,
    });
  }
  return out.slice(-SEND_HISTORY_MAX);
}

/**
 * 追加一条历史：**同 text+format+eol 只保留最后一次**（移到末尾），
 * 超出上限从最旧的开始丢。
 */
export function pushSendHistory(
  prev: SendHistoryEntry[],
  entry: SendHistoryEntry,
  max: number = SEND_HISTORY_MAX,
): SendHistoryEntry[] {
  const rest = prev.filter(
    (x) => !(x.text === entry.text && x.format === entry.format && x.eol === entry.eol),
  );
  return [...rest, entry].slice(-max);
}

/** 写回 localStorage 的载荷（只保留上限内的条目）。 */
export function serializeSendHistory(items: SendHistoryEntry[]): string {
  return JSON.stringify(items.slice(-SEND_HISTORY_MAX));
}
