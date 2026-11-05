/**
 * 串口工作区（P1/P2/P3）—— 驾驶舱里**唯一**的串口可视化面板。
 *
 * 四个视图全部从同一份**原始字节**投影出来（K1 的核心纪律）：
 *   行    服务端已经切好的 RX 行（兼容旧语义）
 *   字节  客户端按 HEX/ASCII/UTF-8/GBK 重新投影（可切表示）
 *   终端  流式 ANSI（`\r` 覆写、`\b`、SGR 颜色；跨批多字节字符保持解码器状态）
 *   波形  协议解码（JustFloat / FireWater）→ Canvas 折线
 *
 * 方向过滤在**客户端**做：服务端只按 `all` 拉一次，切方向不丢游标。
 * 发送面板与监视会话同口（写穿），TX 字节会与 RX 同构进入同一份数据面。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode } from "react";
import { api } from "../api/client";
import type {
  Capabilities,
  SerialChunk,
  SerialControlStateResponse,
  SerialDecodeResult,
  SerialFormat,
  SerialFrameProfile,
  SerialFrameTemplate,
  SerialFrameEncodeResult,
  SerialIssue,
  SerialLogProfile,
  SerialSymbol,
  SerialPreviewResult,
  SerialWidgetRunResult,
} from "../api/types";
import {
  autoRange,
  fmtDuration,
  fmtValue,
  measure,
  nearestFrameIndex,
  snapshotJson,
  valueToY,
} from "../api/types";
import {
  asciiOf,
  captureText,
  hexDump,
  hexDumpRows,
  parseAnsi,
  parseSendHistory,
  pushSendHistory,
  serializeSendHistory,
  textOf,
} from "@elab/cockpit-ui-core";
import type { SendHistoryEntry, SerialRepr } from "@elab/cockpit-ui-core";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { SegmentedTabs } from "../primitives/SegmentedTabs";
import { Switch } from "../primitives/Switch";
import { IconDownload, IconTerminal, IconTrash } from "../icons";
import {
  AnsiTerminal,
  StreamTextDecoder,
  b64ToBytes,
  bytesToB64,
} from "./ansiTerminal";
import type { SerialStream } from "./useSerialStream";
import s from "./SerialWorkspace.module.css";

type ViewId = "lines" | "bytes" | "terminal" | "wave";
type Dir = "all" | "rx" | "tx";

const VIEW_TABS: Array<{ id: ViewId; label: string }> = [
  { id: "lines", label: "行" },
  { id: "bytes", label: "字节" },
  { id: "terminal", label: "终端" },
  { id: "wave", label: "波形" },
];

const REPRS: Array<{ id: SerialRepr; label: string }> = [
  { id: "hex", label: "HEX" },
  { id: "ascii", label: "ASCII" },
  { id: "utf8", label: "UTF-8" },
  { id: "gbk", label: "GBK" },
];

const DIRS: Array<{ id: Dir; label: string }> = [
  { id: "all", label: "全部" },
  { id: "rx", label: "RX" },
  { id: "tx", label: "TX" },
];

const FORMATS: Array<{ id: SerialFormat; label: string }> = [
  { id: "auto", label: "自动" },
  { id: "utf8", label: "文本" },
  { id: "ascii", label: "ASCII" },
  { id: "gbk", label: "GBK" },
  { id: "hex", label: "HEX" },
];

const EOLS = [
  { id: "none", label: "无" },
  { id: "lf", label: "LF" },
  { id: "cr", label: "CR" },
  { id: "crlf", label: "CRLF" },
  { id: "tab", label: "TAB" },
];

/** 本地渲染上限：字节视图最多画这么多批（再往前的仍在缓冲里，并非丢失） */
const MAX_BYTE_BLOCKS = 300;
/** 波形最大回看字节（超出只取最近一段，避免每次轮询都重解 1 MiB） */
const MAX_WAVE_BYTES = 64 * 1024;

/** 解码失败分类 → 人话。没有这一层，"跳过 12" 等于什么也没说。 */
const REASON_LABELS: Record<string, string> = {
  no_head: "找不到帧头",
  bad_length: "长度字段非法",
  short: "帧太短/超长",
  tail_mismatch: "帧尾不符",
  checksum: "校验失败",
  unknown_id: "未知 ID",
  bad_id: "ID 读取失败",
  field: "字段越界",
};

function reasonSummary(reasons?: Record<string, number>): string {
  if (!reasons) return "";
  const parts = Object.entries(reasons)
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([k, n]) => `${REASON_LABELS[k] ?? k} ${n}`);
  return parts.length ? `：${parts.join(" · ")}` : "";
}

/** 窗口内出现过几种消息（variant / id）——"线上一共在说什么"的最小摘要。 */
function speciesCount(variants: Record<string, number>): number {
  return Object.values(variants).filter((n) => Number(n) > 0).length;
}

function variantSummary(variants: Record<string, number>): string {
  return Object.entries(variants)
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([k, n]) => `${k} ×${n}`)
    .join("\n");
}

/** 发送历史（↑/↓ 调取）：只留最近 N 条，跨会话记忆（含格式与行尾） */
const HISTORY_KEY = "elab.serial.send.history";

/** 结构化异常的中文标签（kind 来自内核数据驱动解析，不在这里猜厂商）。 */
const ISSUE_KIND_LABEL: Record<string, string> = {
  panic: "panic", assert: "assert", hardfault: "hardfault", reset: "复位",
};
/** 文件按行发送的行数上限（按行逐条发，太多行会把发送面板占住很久） */
const MAX_FILE_LINES = 2000;

function loadHistory(): SendHistoryEntry[] {
  try {
    return parseSendHistory(localStorage.getItem(HISTORY_KEY));
  } catch {
    return [];
  }
}

function saveHistory(items: SendHistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, serializeSendHistory(items));
  } catch {
    // 隐私模式/配额满：历史只是便利，不写也不影响发送
  }
}

// ── 发送任务（定时发送 / 组件任务共用内核任务引擎）────────────────
/** 任务是否仍在跑（轮询到终态才停）。 */
function jobActive(j: SerialWidgetRunResult | null): boolean {
  return (
    j !== null &&
    (j.state === "running" || j.state === "paused" || j.state === "cancelling")
  );
}

export interface SerialWorkspaceProps {
  stream: SerialStream;
  caps: Capabilities | null;
  project: string;
  /** 有 run 在跑：串口与 run 互斥（N5），发送面板置灰 */
  running: boolean;
}

function cls(name: string): string {
  if (!name) return "";
  return name
    .split(" ")
    .map((c) => s[c] ?? "")
    .filter(Boolean)
    .join(" ");
}

/** HEX 视图中字节分类 → 颜色 class（可打印不额外着色） */
const HEX_CELL_CLS: Record<"ctl" | "del" | "print" | "high" | "pad", string> = {
  ctl: s.bCtl,
  del: s.bDel,
  print: "",
  high: s.bHigh,
  pad: s.bPad,
};

/** 在纯文本里高亮搜索词（大小写不敏感；不做正则，避免用户输入被当成语法） */
function highlight(text: string, query: string, keyBase: string): ReactNode {
  if (!query) return text;
  const low = text.toLowerCase();
  const q = query.toLowerCase();
  const out: ReactNode[] = [];
  let pos = 0;
  let hit = low.indexOf(q);
  let n = 0;
  while (hit >= 0) {
    if (hit > pos) out.push(text.slice(pos, hit));
    out.push(
      <mark key={`${keyBase}-${n}`} className={s.hit}>
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    pos = hit + q.length;
    n += 1;
    hit = low.indexOf(q, pos);
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out.length ? out : text;
}

function spanToText(spans: Array<{ text: string; cls: string }>): string {
  return spans.map((x) => x.text).join("");
}

/** 一行 ANSI 文本 → span 树（颜色只出语义 class，色值在 tokens.css） */
function AnsiLine({ text, query }: { text: string; query: string }) {
  const spans = parseAnsi(text);
  if (!spans.length) return <>{highlight(text, query, "t")}</>;
  return (
    <>
      {spans.map((sp, i) => (
        <span key={i} className={cls(sp.cls)}>
          {highlight(sp.text, query, `s${i}`)}
        </span>
      ))}
    </>
  );
}

export function SerialWorkspace({ stream, caps, project, running }: SerialWorkspaceProps) {
  const [view, setView] = useState<ViewId>("lines");
  const [dir, setDir] = useState<Dir>("all");
  const [repr, setRepr] = useState<SerialRepr>("hex");
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [draft, setDraft] = useState("");
  const [sendFormat, setSendFormat] = useState<SerialFormat>("auto");
  const [eol, setEol] = useState("crlf");
  const [notice, setNotice] = useState<string | null>(null);
  const [decoder, setDecoder] = useState("justfloat");
  /** 发送历史（↑/↓ 调取；跨会话记忆，含当时的格式与行尾） */
  const [history, setHistory] = useState<SendHistoryEntry[]>(loadHistory);
  const [histIdx, setHistIdx] = useState(-1);
  /** 服务端预览（dry_run）：自动识别的结果与待发字节 */
  const [sendPreview, setSendPreview] = useState<SerialPreviewResult | null>(null);
  /** 定时发送间隔（毫秒）；下限由内核校验，面板不写死 */
  const [loopInterval, setLoopInterval] = useState("100");
  const [fileBusy, setFileBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── 日志诊断（M6）：profile 清单（只读数据）+ 结构化异常展开 ──
  const [profiles, setProfiles] = useState<SerialLogProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [symbols, setSymbols] = useState<Record<number, SerialSymbol[]>>({});
  useEffect(() => {
    let dead = false;
    if (!project) {
      setProfiles([]);
      return undefined;
    }
    void api.serialLogProfiles(project)
      .then((r) => { if (!dead) setProfiles(r.profiles ?? []); })
      .catch(() => { if (!dead) setProfiles([]); });
    return () => { dead = true; };
  }, [project]);
  useEffect(() => {
    // 会话实际启用的 profile 是事实源（打开时可能默认选了第一份）
    const active = stream.snap?.issues?.profile;
    if (active) setProfileId(active);
  }, [stream.snap?.issues?.profile]);
  const symbolizeIssue = useCallback(async (issue: SerialIssue) => {
    try {
      const r = await api.serialSymbolize(
        project, issue.backtrace, stream.snap?.issues?.profile ?? "");
      setSymbols((prev) => ({ ...prev, [issue.seq]: r.symbols ?? [] }));
      if (!r.ok) setNotice(`符号化未完全成功：${r.error ?? "未知原因"}`);
    } catch (e) {
      setNotice(`符号化失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [project, stream.snap?.issues?.profile]);

  // ── 帧协议（M5）：工程 profile 清单 + 编辑器抽屉 ─────────────
  // ★ 编辑器只在 cockpit：插件侧只读镜像同一份清单（避免两套前端漂移）。
  const [frameProfiles, setFrameProfiles] = useState<SerialFrameProfile[]>([]);
  const [frameRev, setFrameRev] = useState(0);
  const [framePath, setFramePath] = useState("");
  const [frameWarns, setFrameWarns] = useState<string[]>([]);
  const [frameSel, setFrameSel] = useState("");
  const [frameDoc, setFrameDoc] = useState("");
  const [frameHex, setFrameHex] = useState("");
  const [framePreview, setFramePreview] = useState<SerialDecodeResult | null>(null);
  const [frameNotice, setFrameNotice] = useState<string | null>(null);
  /** 学习在跑：样本大时要几秒，不锁按钮会被连点成并发请求 */
  const [frameLearnBusy, setFrameLearnBusy] = useState(false);
  /** 学习已跑多久（秒）：慢的时候让用户知道没卡死 */
  const [frameLearnSecs, setFrameLearnSecs] = useState(0);
  const [framesOpen, setFramesOpen] = useState(false);
  const [frameTemplates, setFrameTemplates] = useState<SerialFrameTemplate[]>([]);
  const [frameTpl, setFrameTpl] = useState("");
  const [frameValues, setFrameValues] = useState("{}");
  const [frameVariant, setFrameVariant] = useState("");
  const [frameEncoded, setFrameEncoded] = useState<SerialFrameEncodeResult | null>(null);

  const loadFrames = useCallback(async (select = ""): Promise<void> => {
    if (!project) {
      setFrameProfiles([]);
      setFrameRev(0);
      setFramePath("");
      setFrameWarns([]);
      return;
    }
    try {
      const r = await api.serialFrames(project);
      setFrameProfiles(r.profiles ?? []);
      setFrameRev(r.rev ?? 0);
      setFramePath(r.path ?? "");
      setFrameWarns(r.warnings ?? []);
      if (!r.ok) setFrameNotice(`✗ ${r.error ?? "帧配置读取失败"}`);
      const list = r.profiles ?? [];
      const hit = list.find((p) => p.id === select) ?? list[0];
      if (hit) {
        setFrameSel(hit.id);
        setFrameDoc(JSON.stringify(hit, null, 2));
      }
    } catch (e) {
      setFrameNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [project]);

  useEffect(() => {
    void loadFrames();
  }, [loadFrames]);

  const newFrameProfile = useCallback((): void => {
    setFrameSel("");
    setFramePreview(null);
    setFrameNotice(null);
    setFrameDoc(JSON.stringify({
      id: "new",
      label: "新帧协议",
      kind: "binary",
      frame: { head_hex: "A5 5A", tail_hex: "", length: null, max_bytes: 256 },
      checksum: { kind: "none", at: "tail" },
      fields: [{ name: "v", offset: 2, type: "u16", endian: "le", scale: 1, unit: "" }],
    }, null, 2));
  }, []);

  const saveFrameProfile = useCallback(async (): Promise<void> => {
    if (!project) return;
    let raw: unknown;
    try {
      raw = JSON.parse(frameDoc);
    } catch (e) {
      setFrameNotice(`✗ JSON 语法错误：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // 同名会被静默覆盖：learn 的默认 id 就是 "learned"，连学两次再保存就会
    // 把上一个冲掉。保存前先问一句（agent 侧由内核的 overwritten 字段提示）。
    const pid = (raw as { id?: string }).id ?? "";
    if (pid !== "" && frameProfiles.some((p) => p.id === pid)
        && !window.confirm(`已存在同名 profile「${pid}」，保存会覆盖它。\n\n要继续就点"确定"；想保留原来的，先把 JSON 里的 id 改掉。`)) {
      return;
    }
    try {
      const r = await api.serialFramesSave({
        project, action: "save", rev: frameRev, profile: raw,
      });
      if (!r.ok) {
        setFrameNotice(`✗ ${r.error ?? "保存失败"}`);
        if (r.conflict) void loadFrames();
        return;
      }
      setFrameRev(r.rev);
      setFrameProfiles(r.profiles ?? []);
      setFrameWarns(r.warnings ?? []);
      const hit = (r.profiles ?? []).find((p) => p.id === pid);
      if (hit) {
        setFrameSel(hit.id);
        setFrameDoc(JSON.stringify(hit, null, 2));
      }
      setFrameNotice(`✓ 已保存 ${pid}（rev ${r.rev}）`);
    } catch (e) {
      setFrameNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [project, frameDoc, frameRev, frameProfiles, loadFrames]);

  const deleteFrameProfile = useCallback(async (): Promise<void> => {
    if (!project || !frameSel) return;
    if (!window.confirm(`删除帧协议「${frameSel}」？（会写工程 frames.json）`)) return;
    try {
      const r = await api.serialFramesSave({
        project, action: "delete", rev: frameRev, id: frameSel,
      });
      if (!r.ok) {
        setFrameNotice(`✗ ${r.error ?? "删除失败"}`);
        if (r.conflict) void loadFrames();
        return;
      }
      setFrameRev(r.rev);
      setFrameProfiles(r.profiles ?? []);
      setFramePreview(null);
      const first = (r.profiles ?? [])[0];
      setFrameSel(first?.id ?? "");
      setFrameDoc(first ? JSON.stringify(first, null, 2) : "");
      setFrameNotice(`✓ 已删除 ${frameSel}`);
    } catch (e) {
      setFrameNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [project, frameSel, frameRev, loadFrames]);

  const loadFrameTemplates = useCallback(async (): Promise<void> => {
    try {
      const r = await api.serialFrameTemplates();
      setFrameTemplates(r.templates ?? []);
      if (r.errors?.length) setFrameNotice(`模板库：${r.errors.join("；")}`);
    } catch (e) {
      setFrameNotice(`✗ 模板读取失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    if (framesOpen) void loadFrameTemplates();
  }, [framesOpen, loadFrameTemplates]);

  const importFrameTemplate = useCallback(async (): Promise<void> => {
    if (!project || !frameTpl) return;
    try {
      const r = await api.serialFrameTemplateImport({
        project, rev: frameRev, template: frameTpl,
      });
      if (!r.ok) {
        setFrameNotice(`✗ ${r.error ?? "模板导入失败"}`);
        if (r.conflict) void loadFrames();
        return;
      }
      const importedId = (r as { imported?: string }).imported ?? frameTpl;
      setFrameRev(r.rev);
      setFrameProfiles(r.profiles ?? []);
      setFrameWarns(r.warnings ?? []);
      const hit = (r.profiles ?? []).find((p) => p.id === importedId)
        ?? (r.profiles ?? [])[0];
      if (hit) {
        setFrameSel(hit.id);
        setFrameDoc(JSON.stringify(hit, null, 2));
      }
      setFrameNotice(`✓ 已从模板导入 ${hit?.id ?? importedId}（rev ${r.rev}）`);
    } catch (e) {
      setFrameNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [project, frameTpl, frameRev, loadFrames]);

  const previewFrameProfile = useCallback(async (): Promise<void> => {
    if (!frameDoc.trim()) {
      setFrameNotice("✗ 先选择/新建并编辑 profile（预览支持未保存草稿）");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(frameDoc);
    } catch (e) {
      setFrameNotice(`✗ JSON 语法错误：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const hex = frameHex.trim();
    if (!hex) {
      setFrameNotice("✗ 先填一段样本 HEX");
      return;
    }
    try {
      const r = await api.serialFramesPreview({ profile: raw, hex });
      setFramePreview(r);
      setFrameNotice(r.ok
        ? `✓ 解出 ${r.total_frames} 帧（跳过 ${r.skipped}` +
          `${reasonSummary(r.reasons)}${r.unknown_id ? `，未知 ID ${r.unknown_id}` : ""}）`
        : `✗ ${r.error ?? "预览失败"}`);
    } catch (e) {
      setFrameNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [frameDoc, frameHex]);

  const learnTimer = useRef<number | null>(null);
  const stopLearnTimer = useCallback((): void => {
    if (learnTimer.current !== null) {
      window.clearInterval(learnTimer.current);
      learnTimer.current = null;
    }
  }, []);
  // 卸载时别留着秒表在跑
  useEffect(() => stopLearnTimer, [stopLearnTimer]);

  /**
   * 从样本学习（P4.1）：只产草稿，**不写盘**。
   * 学到的东西直接填进编辑器，人再决定要不要保存 —— 学习不该有副作用。
   *
   * 样本几万字节时服务端要跑 1–3 s（大样本更久），所以这里必须锁按钮 +
   * 走秒：不锁的话连点会叠出多个并发学习请求，把内核拖得更死。
   */
  const learnFrameProfile = useCallback(async (): Promise<void> => {
    const hex = frameHex.trim();
    if (!hex) {
      setFrameNotice("✗ 先粘一段抓包 HEX（至少几十字节，最好包含多帧）");
      return;
    }
    if (frameLearnBusy) return;
    setFrameLearnBusy(true);
    setFrameLearnSecs(0);
    stopLearnTimer();
    learnTimer.current = window.setInterval(() => setFrameLearnSecs((s) => s + 1), 1000);
    setFrameNotice("… 正在分析帧头 / 长度 / 校验");
    try {
      const r = await api.serialFramesLearn({ hex });
      if (!r.ok || !r.draft) {
        setFrameNotice(`✗ ${r.error ?? "学不出来"}` +
          (r.warnings?.length ? `（${r.warnings.join("；")}）` : ""));
        return;
      }
      setFrameDoc(JSON.stringify(r.draft, null, 2));
      const ev = (r.evidence ?? []).slice(0, 3).join(" · ");
      setFrameNotice(
        `✓ 学出草稿 ${(r.draft as { id?: string }).id ?? ""}` +
        `（置信度 ${Math.round((r.confidence ?? 0) * 100)}%` +
        `${r.decode_rate !== undefined ? `，回放 ${Math.round(r.decode_rate * 100)}%` : ""}）` +
        `${ev ? ` —— ${ev}` : ""}` +
        `${r.warnings?.length ? ` ⚠ ${r.warnings.join("；")}` : ""}`,
      );
    } catch (e) {
      setFrameNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      stopLearnTimer();
      setFrameLearnBusy(false);
    }
  }, [frameHex, frameLearnBusy, stopLearnTimer]);

  const encodeFrameProfile = useCallback(async (): Promise<void> => {    if (!frameDoc.trim()) {
      setFrameNotice("✗ 先选择/新建 profile");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(frameDoc);
    } catch (e) {
      setFrameNotice(`✗ profile JSON 语法错误：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(frameValues || "{}") as Record<string, unknown>;
    } catch (e) {
      setFrameNotice(`✗ 字段值 JSON 语法错误：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    try {
      const r = await api.serialFramesEncode({
        profile: raw,
        values,
        ...(frameVariant.trim() ? { variant: frameVariant.trim() } : {}),
      });
      setFrameEncoded(r);
      if (!r.ok) {
        setFrameNotice(`✗ ${r.error ?? "组帧失败"}`);
        return;
      }
      setDraft(r.hex ?? "");
      setSendFormat("hex");
      setFrameNotice(
        `✓ 组帧 ${r.bytes ?? 0} B${r.variant ? `（${r.variant}）` : ""}` +
        `${r.checksum ? ` · ${r.checksum}` : ""} —— 已填到发送框，回车即发`);
    } catch (e) {
      setFrameNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [frameDoc, frameValues, frameVariant]);

  // ── DTR/RTS + 复位预设（M1）───────────────────────────────
  // 预设清单来自适配包 `pack.yaml`（内核只执行，不判断厂商）；没有预设时
  // 这里只剩两个原始开关 —— 这是诚实的能力边界，不是缺省值。
  const [ctl, setCtl] = useState<SerialControlStateResponse | null>(null);
  const [preset, setPreset] = useState("");
  const [ctlBusy, setCtlBusy] = useState(false);
  const refreshCtl = useCallback(async (): Promise<void> => {
    if (!project) {
      setCtl(null);
      return;
    }
    try {
      setCtl(await api.serialControlState(project));
    } catch {
      /* 控制面不可用时静默：不遮住串口主视图 */
    }
  }, [project]);
  useEffect(() => {
    void refreshCtl();
  }, [refreshCtl]);
  useEffect(() => {
    if (ctl?.sequence.state !== "running") return undefined;
    const h = window.setInterval(() => void refreshCtl(), 1000);
    return () => window.clearInterval(h);
  }, [ctl?.sequence.state, refreshCtl]);

  const doControl = useCallback(
    async (body: { dtr?: boolean; rts?: boolean; preset?: string; cancel?: boolean }) => {
      if (!project) return;
      setCtlBusy(true);
      try {
        const r = await api.serialControl({ project, ...body });
        if (!r.ok) setNotice(`✗ 串口控制失败：${r.error ?? "未知原因"}`);
        else if (r.note) setNotice(r.note);
      } catch (e) {
        setNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setCtlBusy(false);
        void refreshCtl();
      }
    },
    [project, refreshCtl],
  );

  /** 记一条历史（连格式与行尾一起存，回填时才能"原样重发"）。 */
  const remember = useCallback((entry: SendHistoryEntry): void => {
    setHistory((prev) => {
      const next = pushSendHistory(prev, entry);
      saveHistory(next);
      return next;
    });
    setHistIdx(-1);
  }, []);

  // ── 发送任务：异步任务快照 + 轮询 id（定时发送 / 组件任务同一形状）──
  const [job, setJob] = useState<SerialWidgetRunResult | null>(null);
  const [jobId, setJobId] = useState("");
  const [jobNotice, setJobNotice] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{
    key: string;
    lastSeq: number;
    term: AnsiTerminal;
    dec: StreamTextDecoder;
  } | null>(null);

  const epoch = stream.snap?.epoch ?? 0;

  const jobRunning = jobActive(job);
  /** 当前跑的是「发送框定时发送」（source=raw），而不是组件任务 */
  const rawLoopActive = jobRunning && job?.source === "raw";

  /** 刷新页面/换工程后找回仍在跑的任务（run 只等 2s，长任务只能靠轮询）。 */
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    api
      .serialWidgetJob()
      .then((j) => {
        if (cancelled || !jobActive(j) || !j.job_id) return;
        setJob(j);
        setJobId(j.job_id);
      })
      .catch(() => {
        // 404 = 没有在跑的任务，是常态；不打扰用户
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  /** 任务轮询：400ms 一次，直到终态（不新增 SSE topic）。 */
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer = 0;
    const tick = async (): Promise<void> => {
      try {
        const j = await api.serialWidgetJob(jobId);
        if (cancelled) return;
        setJob(j);
        if (jobActive(j)) {
          timer = window.setTimeout(() => void tick(), 400);
          return;
        }
        setJobNotice(
          j.ok
            ? `✓ 任务结束：${j.rounds ?? 0} 轮 · ${j.total_bytes ?? 0} B` +
              ((j.skipped ?? 0) > 0 ? ` · 跳过 ${j.skipped} 拍` : "")
            : `✗ 任务失败：${j.error ?? "未知原因"}`,
        );
      } catch (e) {
        if (cancelled) return;
        setJobNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [jobId]);

  /** 定时发送：发到 `/api/serial/loop`（内核瞬态任务，不落盘）。 */
  const startLoop = useCallback(async () => {
    if (!project || !draft.trim() || running) return;
    const ms = Number(loopInterval);
    if (!Number.isFinite(ms) || ms <= 0) {
      setNotice("✗ 定时发送间隔必须是正数（毫秒）");
      return;
    }
    setNotice(null);
    try {
      const r = await api.serialLoop({
        project,
        data: draft,
        format: sendFormat,
        eol,
        interval_ms: Math.round(ms),
        count: 0,
      });
      if (r.job_id) setJobId(r.job_id);
      setJob(r);
      if (!r.ok) {
        setNotice(`✗ ${r.error ?? "定时发送被拒绝"}`);
        return;
      }
      setNotice(`⏵ 定时发送中：每 ${Math.round(ms)}ms（停止后才可手发）`);
      remember({
        text: draft,
        format: sendFormat,
        eol: eol as SendHistoryEntry["eol"],
        at: Date.now(),
      });
    } catch (e) {
      setNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [project, draft, running, loopInterval, sendFormat, eol, remember]);

  const cancelJob = useCallback(async () => {
    const id = job?.job_id || jobId;
    if (!id) return;
    try {
      await api.serialWidgetCancel(id);
      setJob(await api.serialWidgetJob(id));
    } catch (e) {
      setJobNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [job, jobId]);

  const decoders = caps?.meta?.serial?.decoders ?? [
    { id: "justfloat", label: "JustFloat", channels: "auto" as const },
    { id: "firewater", label: "FireWater", channels: "auto" as const },
  ];
  // 工程帧协议（M5）：与内置解码器并列，id = `profile:<id>`（服务端按工程装载）
  const decoderOptions = [
    ...decoders,
    ...frameProfiles.map((p) => ({
      id: `profile:${p.id}`,
      label: `帧 · ${p.label || p.id}`,
      channels: "fields" as const,
      desc: "按工程帧协议（frames.json）解码",
    })),
  ];

  const filtered = useMemo(
    () => (dir === "all" ? stream.chunks : stream.chunks.filter((c) => c.dir === dir)),
    [stream.chunks, dir],
  );

  const q = query.trim().toLowerCase();

  // ── 行视图 ──────────────────────────────────────────────────
  const lines = useMemo(() => {
    if (!q) return stream.lines;
    return stream.lines.filter((l) => l.text.toLowerCase().includes(q));
  }, [stream.lines, q]);

  // ── 字节视图（逐批投影；只渲染最近 MAX_BYTE_BLOCKS 批）────────
  const byteBlocks = useMemo(() => {
    const list = filtered.slice(-MAX_BYTE_BLOCKS);
    return list.flatMap((c) => {
      const bytes = b64ToBytes(c.data_b64);
      let body: string;
      if (repr === "hex") body = hexDump(bytes).join("\n");
      else if (repr === "ascii") body = asciiOf(bytes);
      else body = textOf(bytes, repr);
      const header = `#${c.seq} ${c.dir.toUpperCase()} ${c.t} · ${c.len} B`;
      if (q && !header.toLowerCase().includes(q) && !body.toLowerCase().includes(q)) {
        return [];
      }
      return [{ c, header, body, rows: repr === "hex" ? hexDumpRows(bytes) : null }];
    });
  }, [filtered, repr, q]);

  // ── 终端视图（增量喂入；切方向/编码/纪元时重建）─────────────
  const termEnc = repr === "gbk" ? "gbk" : "utf8";
  const termLines = useMemo(() => {
    const key = `${dir}|${termEnc}|${epoch}`;
    let st = termRef.current;
    if (!st || st.key !== key || (filtered.length === 0 && st.lastSeq > 0)) {
      st = { key, lastSeq: 0, term: new AnsiTerminal(), dec: new StreamTextDecoder(termEnc) };
      termRef.current = st;
    }
    for (const c of filtered) {
      if (c.seq <= st.lastSeq) continue;
      const bytes = b64ToBytes(c.data_b64);
      if (c.dir === "tx") st.term.feed("\u001b[33m» \u001b[0m");
      st.term.feed(st.dec.decode(bytes));
      // TX 没带行尾时补一个换行，避免下一条 RX 粘在同一行（终端只做展示）
      if (c.dir === "tx" && bytes.length && bytes[bytes.length - 1] !== 0x0a) {
        st.term.feed("\r\n");
      }
      st.lastSeq = c.seq;
    }
    return st.term.snapshot();
  }, [filtered, dir, termEnc, epoch]);

  const shownTerm = useMemo(() => {
    if (!q) return termLines;
    return termLines.filter((ln) => spanToText(ln).toLowerCase().includes(q));
  }, [termLines, q]);

  // ── 波形：对最近一段字节调用内核解码，Canvas 画多通道 ────────
  // ★ 会话开着且共享解码器 = 当前选择时，改用**会话共享帧**（带 t_us）：
  //   既与 agent/插件同图，也让游标 Δt 有真实时间源（M7）。离线才退回无状态解码。
  const [localFrames, setLocalFrames] = useState<Array<Array<number | null>>>([]);
  const [decodeMeta, setDecodeMeta] = useState<{
    channels: number;
    skipped: number;
    pending: number;
    /** 解码失败分类（P2.2-C）：no_head / checksum / bad_length … */
    reasons?: Record<string, number>;
    fields: { name: string; unit: string; type: string; plot: boolean }[];
  } | null>(null);
  const [waveErr, setWaveErr] = useState<string | null>(null);

  const sharedDecoderId = stream.snap?.decode?.decoder ?? "";
  const sharedLane = stream.active && sharedDecoderId !== "" && sharedDecoderId === decoder;

  // ── 帧级健康度（P3.1）──
  // 会话共享解码时才有真正的"服务端视角"（它在实时读口）：帧率、到达间隔、
  // 错误分类都由内核算好，这里只渲染。离线波形走本地解码，不轮询。
  const [health, setHealth] = useState<{
    fps: number;
    interval: string;
    errorRate: number;
    pending: number;
    variants: Record<string, number>;
  } | null>(null);

  useEffect(() => {
    if (view !== "wave" || !sharedLane) {
      setHealth(null);
      return undefined;
    }
    let dropped = false;
    const tick = async () => {
      try {
        const r = await api.serialFrameStats(10);
        if (dropped) return;
        const iv = r.interval_ms;
        setHealth({
          fps: r.fps ?? 0,
          interval: iv ? `${iv.mean.toFixed(0)}/${iv.p95.toFixed(0)}ms` : "—",
          errorRate: r.error_rate ?? 0,
          pending: r.pending_bytes ?? 0,
          variants: r.variants ?? {},
        });
      } catch {
        if (!dropped) setHealth(null);     // 面板不能因为统计挂了而空白
      }
    };
    void tick();
    const h = window.setInterval(() => void tick(), 1500);
    return () => {
      dropped = true;
      window.clearInterval(h);
    };
  }, [view, sharedLane]);

  // 会话一开就把当前解码器写进会话（P3.5：agent 与面板同图；M7：Δt 才有时间源）。
  // 只在会话尚未选定解码器时写入 —— 不覆盖 agent/别的标签页的选择。
  const pushedDecoder = useRef("");
  useEffect(() => {
    if (!stream.active || !decoder || sharedDecoderId !== "") return;
    const key = `${stream.snap?.epoch ?? 0}:${decoder}`;
    if (pushedDecoder.current === key) return;   // 防止失败后每渲染重试轰炸
    pushedDecoder.current = key;
    void stream.setDecoder(decoder);
  }, [stream.active, decoder, sharedDecoderId, stream]);

  useEffect(() => {
    if (view !== "wave") return;
    if (sharedLane) return;                 // 会话共享帧优先（见上方说明）
    if (!filtered.length) {
      setLocalFrames([]);
      setDecodeMeta(null);
      return;
    }
    // 取最近一段（字节数封顶），每轮替换而不是追加 —— 波形看的是"最近窗口"。
    let total = 0;
    const picked: SerialChunk[] = [];
    for (let i = filtered.length - 1; i >= 0; i--) {
      if (total + filtered[i].len > MAX_WAVE_BYTES) break;
      picked.unshift(filtered[i]);
      total += filtered[i].len;
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of picked) {
      const b = b64ToBytes(c.data_b64);
      bytes.set(b, off);
      off += b.length;
    }
    let cancelled = false;
    api
      .serialDecode({
        decoder,
        dataB64: bytesToB64(bytes),
        // profile 配置由服务端按工程装载（前端不缓存配置，避免与编辑器漂移）
        ...(decoder.startsWith("profile:")
          ? { project, profile: decoder.slice("profile:".length) }
          : {}),
      })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) {
          setWaveErr(r.error ?? "解码失败");
          setLocalFrames([]);
          return;
        }
        setWaveErr(null);
        setLocalFrames(r.frames);
        setDecodeMeta({
          channels: r.channels,
          skipped: r.skipped,
          pending: r.pending_bytes,
          reasons: r.reasons,
          fields: r.fields ?? [],
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setWaveErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [view, filtered, decoder, project, sharedLane]);

  // 共享帧（会话）与本地帧（离线解码）的统一投影
  const frames = sharedLane ? stream.decoded.map((f) => f.values) : localFrames;
  /** 每帧时间戳（微秒）；null = 无时间源（Δt 显示 —，不编造） */
  const frameTimes = sharedLane ? stream.decoded.map((f) => f.t_us) : null;
  /**
   * 通道名/单位：帧协议 profile 才有；其余显示 CHn。
   * ★ 只留 plot 字段 —— 服务端 fields 是**全量字段表**（含 mode/flags 等元数据），
   *   而 frames.values 只包含可绘制的通道；不过滤会把 mode 标到 bat 的曲线上。
   */
  const frameFields = (
    sharedLane ? stream.decodedSnap?.fields ?? [] : decodeMeta?.fields ?? []
  ).filter((f) => f.plot);

  // ── 波形多面板 + 通道绑定 ──────────────────────────────────────
  interface WaveViewport {
    id: string;
    name: string;
    channels: number[];
    /** 每个面板独立持有的视图（切 tab 不串味） */
    scaleX: number;
    offsetX: number;
  }
  const [waveViewports, setWaveViewports] = useState<WaveViewport[]>([]);
  const [activeViewport, setActiveViewport] = useState<string>("");
  // 每个 viewport 独立的 follow（顶层 autoScroll 驱动默认值）
  const [viewportFollow, setViewportFollow] = useState<Record<string, boolean>>({});

  // 当解码器解出帧时，初始化 viewport（默认 "全部" 面板绑定全部通道）
  // ★ 只在"解码通道总数变大"时重建：
  //   1) 不能用 viewport.channels.length 判断 —— 取消绑定某通道后长度会变，会被误清；
  //   2) 也不能用"变化"判断 —— 文本协议（FireWater）某些批次可能只解出 1 个通道，
  //      通道数在 1↔2 之间抖动会反复重建、把用户新建的面板冲掉。
  const lastTotalCh = useRef(0);
  useEffect(() => {
    // ★ 共享解码以会话帧为准；离线才看本地解码结果（两者都不为 0 才没通道）。
    const totalCh = sharedLane
      ? (frames[0]?.length ?? 0)
      : Math.max(decodeMeta?.channels ?? 0, frames[0]?.length ?? 0);
    if (totalCh === 0) return;
    const needInit = waveViewports.length === 0;
    const grew = totalCh > lastTotalCh.current;
    lastTotalCh.current = Math.max(lastTotalCh.current, totalCh);
    if (!needInit && !grew) return;
    const allVp: WaveViewport = {
      id: "all",
      name: "全部",
      channels: Array.from({ length: totalCh }, (_, i) => i),
      scaleX: 1,
      offsetX: 0,
    };
    setWaveViewports([allVp]);
    setActiveViewport("all");
    setViewportFollow({ all: autoScroll });
  }, [decodeMeta?.channels, frames[0]?.length]);

  // 顶层「跟随」开关：一次性把当前所有面板的 follow 对齐到开关状态。
  // ★ 不做成 effect：新增面板/通道增长时不该把用户**手动暂停**的面板拉回跟随。
  const setFollowAll = (v: boolean) => {
    setAutoScroll(v);
    setViewportFollow((prev) => {
      const next = { ...prev };
      for (const vp of waveViewports) next[vp.id] = v;
      return next;
    });
  };

  const addWaveViewport = () => {
    const totalCh = decodeMeta?.channels ?? (frames[0]?.length ?? 0);
    if (totalCh === 0) return;
    const id = `vp_${Date.now().toString(36)}`;
    const next: WaveViewport = { id, name: `面板 ${waveViewports.length + 1}`, channels: Array.from({ length: totalCh }, (_, i) => i), scaleX: 1, offsetX: 0 };
    setWaveViewports((vps) => [...vps, next]);
    setViewportFollow((f) => ({ ...f, [id]: autoScroll }));
    setActiveViewport(id);
  };
  const removeWaveViewport = (id: string) => {
    setWaveViewports((vps) => {
      const rest = vps.filter((v) => v.id !== id);
      if (rest.length === 0) return vps; // 至少留一个
      if (activeViewport === id) setActiveViewport(rest[rest.length - 1].id);
      return rest;
    });
    setViewportFollow((f) => { const { [id]: _gone, ...rest } = f; return rest; });
  };
  const setViewportChannels = (id: string, channels: number[]) => {
    setWaveViewports((vps) => vps.map((v) => (v.id === id ? { ...v, channels } : v)));
  };
  const setViewportView = (id: string, scaleX: number, offsetX: number) => {
    setWaveViewports((vps) => {
      const vp = vps.find((v) => v.id === id);
      if (!vp || (vp.scaleX === scaleX && vp.offsetX === offsetX)) return vps;
      return vps.map((v) => (v.id === id ? { ...v, scaleX, offsetX } : v));
    });
  };

  // ── 跟随滚动 ────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScroll) el.scrollTop = el.scrollHeight;
  }, [autoScroll, view, lines, byteBlocks, shownTerm, frames]);

  // ── 操作 ────────────────────────────────────────────────────
  const doClear = useCallback(() => {
    void stream.clear();
    setNotice(null);
  }, [stream]);

  // ── 录制（K5）：服务端把它写成有界 JSONL（**字节**，不写文本投影）──
  const cap = stream.snap?.capture ?? null;
  const capActive = !!cap?.active;
  const doCapture = useCallback(async () => {
    setNotice(null);
    try {
      const r = await api.serialCapture(capActive ? "stop" : "start", project);
      if (!r.ok) {
        setNotice(`✗ 录制失败：${r.error ?? "未知原因"}`);
        return;
      }
      setNotice(
        capActive
          ? `■ 录制已停止：${r.path}（${r.chunks} 批 / ${r.bytes} B` +
              `${r.truncated ? "，到上限已截断" : ""}）`
          : `● 正在录制 → ${r.path}（只存字节、有界 5 MiB）`,
      );
    } catch (e) {
      setNotice(`✗ 录制失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [capActive, project]);

  const doExport = useCallback(() => {
    const raw = filtered.map((c) => ({
      seq: c.seq,
      dir: c.dir,
      t: c.t,
      bytes: b64ToBytes(c.data_b64),
    }));
    const text = captureText(raw);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `elab-serial-${stream.snap?.port ?? "capture"}.txt`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, [filtered, stream.snap?.port]);

  /** 服务端预览：150ms 防抖。前端不编码 —— 否则"看的字节"与"发的字节"会漂移。 */
  const previewSend = stream.preview;
  useEffect(() => {
    if (!draft.trim()) {
      setSendPreview(null);
      return;
    }
    const timer = window.setTimeout(() => {
      previewSend(draft, { format: sendFormat, eol })
        .then(setSendPreview)
        .catch(() => setSendPreview(null));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [draft, sendFormat, eol, previewSend]);

  const doSend = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!draft.trim() || running) return;
      setNotice(null);
      try {
        const r = await stream.send(draft, { format: sendFormat, eol });
        if (!r.ok) {
          setNotice(`✗ 发送失败：${r.error ?? "未知原因"}`);
          return;
        }
        setNotice(
          `✓ 已发送 ${r.written} B → ${r.port}@${r.baud}` +
            (r.format ? `（识别为 ${r.format.toUpperCase()}）` : "") +
            (r.via === "monitor" ? "（经监视会话，回显见实时流）" : ""),
        );
        remember({
          text: draft,
          format: sendFormat,
          eol: eol as SendHistoryEntry["eol"],
          at: Date.now(),
        });
        setDraft("");
      } catch (err) {
        setNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [draft, running, sendFormat, eol, stream, remember],
  );

  /** ↑/↓ 调取发送历史 */
  const onDraftKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>): void => {
      const key = e.key;
      if (key !== "ArrowUp" && key !== "ArrowDown") return;
      if (history.length === 0) return;
      e.preventDefault();
      if (key === "ArrowUp") {
        const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(next);
        setDraft(history[next].text);
        setSendFormat(history[next].format);
        setEol(history[next].eol);
        return;
      }
      if (histIdx === -1) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setDraft("");
      } else {
        setHistIdx(next);
        setDraft(history[next].text);
        setSendFormat(history[next].format);
        setEol(history[next].eol);
      }
    },
    [history, histIdx],
  );

  /** 文件按行发送：逐行 await（同一口写穿），有界行数，失败即停并报第几行 */
  const doSendFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = e.currentTarget.files?.[0];
      e.currentTarget.value = ""; // 允许重复选同一个文件
      if (!file || running) return;
      setNotice(null);
      let text = "";
      try {
        text = await file.text();
      } catch (err) {
        setNotice(`✗ 读取文件失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      let lines = text.split(/\r\n|\r|\n/);
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      if (lines.length === 0) {
        setNotice("✗ 文件里没有可发送的行");
        return;
      }
      let clipped = false;
      if (lines.length > MAX_FILE_LINES) {
        lines = lines.slice(0, MAX_FILE_LINES);
        clipped = true;
      }
      setFileBusy(true);
      let sent = 0;
      let fail = "";
      for (const line of lines) {
        if (line === "") continue;
        try {
          const r = await stream.send(line, { format: sendFormat, eol: sendFormat === "hex" ? "none" : eol });
          if (!r.ok) {
            fail = r.error ?? "未知原因";
            break;
          }
          sent += 1;
        } catch (err) {
          fail = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      setFileBusy(false);
      if (fail !== "") {
        setNotice(`✗ 文件发送中断：第 ${sent + 1}/${lines.length} 行失败（${fail}）`);
        return;
      }
      setNotice(`✓ 文件已按行发送 ${sent} 行 → ${file.name}${clipped ? `（只发前 ${MAX_FILE_LINES} 行）` : ""}`);
    },
    [running, sendFormat, eol, stream],
  );

  // 展示**当前缓冲**的口径（清空/被环形挤出后归零），而不是会话生命周期的
  // 累计 `chunk_seq` —— 否则点「清空」后会显示 "0 B · 5 批" 这种自相矛盾的计数。
  const bytes = stream.snap?.bytes_total ?? 0;
  const chunks = stream.chunks.length;
  const lossy = stream.gapLines + stream.gapChunks;
  // M2 连接态 / 速率（服务端算，这里只渲染）
  const st = stream.snap?.stats;
  const connState = stream.snap?.state ?? (stream.active ? "live" : "closed");
  const fmtBps = (v: number) => (v >= 1024
    ? `${(v / 1024).toFixed(1)} KiB/s`
    : `${v.toFixed(0)} B/s`);

  return (
    <div className={s.wrap}>
      <div className={s.toolbar}>
        <SegmentedTabs
          tabs={VIEW_TABS.map((t) => ({ id: t.id, label: t.label }))}
          value={view}
          onChange={setView}
          size="sm"
        />
        {ctl && ctl.presets.length > 0 ? (
          <>
            <select
              className={s.select}
              value={preset}
              onChange={(e) => setPreset(e.currentTarget.value)}
              aria-label="复位预设"
              title={ctl.presets.find((p) => p.name === preset)?.description
                ?? "复位/下载序列（数据来自适配包 pack.yaml；内核只按 steps 动线）"}
            >
              <option value="">复位预设…</option>
              {ctl.presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={!preset || ctlBusy}
              onClick={() => void doControl({ preset })}
              title="执行选中序列（异步；再次触发会取消旧序列）"
            >
              执行
            </Button>
          </>
        ) : null}
        {ctl?.sequence.state === "running" ? (
          <Button size="sm" variant="outline" onClick={() => void doControl({ cancel: true })}>
            取消序列
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!project || ctlBusy}
          onClick={() => void doControl({ dtr: !(ctl?.control.dtr ?? false) })}
          title="翻转 DTR（物理线路动作：不进字节环、不算 TX）"
        >
          DTR {ctl?.control.dtr == null ? "?" : ctl.control.dtr ? "1" : "0"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!project || ctlBusy}
          onClick={() => void doControl({ rts: !(ctl?.control.rts ?? false) })}
          title="翻转 RTS（物理线路动作：不进字节环、不算 TX）"
        >
          RTS {ctl?.control.rts == null ? "?" : ctl.control.rts ? "1" : "0"}
        </Button>
        <span className={s.spacer} />
        <select
          className={s.select}
          value={dir}
          onChange={(e) => setDir(e.currentTarget.value as Dir)}
          aria-label="方向过滤"
          title="按方向过滤（TX = 我发出去的，RX = 设备发来的）"
        >
          {DIRS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <select
          className={s.select}
          value={repr}
          onChange={(e) => setRepr(e.currentTarget.value as SerialRepr)}
          aria-label="字节表示"
          title={view === "terminal" ? "终端编码（HEX/ASCII 在终端里按 UTF-8）" : "字节的显示表示"}
        >
          {REPRS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        {view === "wave" ? (
          <select
            className={s.select}
            value={decoder}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setDecoder(next);
              if (stream.active) void stream.setDecoder(next);
            }}
            aria-label="协议解码器"
            title={decoderOptions.find((d) => d.id === decoder)?.desc ?? "协议解码器"}
          >
            {decoderOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        ) : null}
        {view === "wave" && project ? (
          <Button
            size="sm"
            variant={framesOpen ? "outline" : "ghost"}
            onClick={() => {
              setFramesOpen((v) => !v);
              if (!framesOpen) void loadFrames(frameSel);
            }}
            title="编辑工程帧协议（projects/<name>.frames.json）：定义帧头/帧尾/字段表，波形按字段名出通道"
          >
            {framesOpen ? "收起帧协议" : "帧协议"}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void stream.setPaused(!stream.paused)}
          title={stream.paused ? "继续入环（服务端仍在读口）" : "暂停入环（服务端继续读口，不撑爆设备缓冲）"}
        >
          {stream.paused ? "继续" : "暂停"}
        </Button>
        <Button
          size="sm"
          variant={capActive ? "danger" : "outline"}
          onClick={() => void doCapture()}
          title={capActive
            ? "停止录制（文件保留在 .work/.cockpit，可回放）"
            : "开始录制：把原始字节写成有界 JSONL（证据，不是文本投影）"}
        >
          {capActive ? "停止录制" : "录制"}
        </Button>
        <Button size="sm" variant="outline" onClick={doClear} icon={<IconTrash />} title="清空服务端与本地缓冲（序号保持单调）">
          清空
        </Button>
        <Button size="sm" variant="ghost" onClick={doExport} icon={<IconDownload />} title="导出当前过滤结果的原始字节（HEX + 元数据）">
          导出
        </Button>
      </div>

      <div className={s.subbar}>
        <Input
          mono
          size="sm"
          placeholder="搜索（大小写不敏感；行/字节/终端可用）"
          aria-label="搜索串口流"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          className={s.search}
        />
        {query ? (
          <span className={s.meta}>
            {view === "lines" ? `${lines.length}/${stream.lines.length} 行` : "已过滤"}
          </span>
        ) : null}
        <span className={s.spacer} />
        {profiles.length ? (
          <select
            className={s.select}
            aria-label="日志诊断 profile"
            title="日志诊断规则来自包/工程数据（panic / hardfault / 复位）；关闭 = 不解析"
            value={profileId}
            disabled={!stream.active}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setProfileId(next);
              void stream.setLogProfile(next);
            }}
          >
            <option value="">日志诊断：关</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.label || p.id}</option>
            ))}
          </select>
        ) : null}
        <Switch id="serial-follow" checked={autoScroll} onChange={setFollowAll} label="跟随" />
        <span className={s.meta} title="当前缓冲：未清空、未被环形挤出的字节 / 批次">
          {bytes} B · {chunks} 批
        </span>
        {st ? (
          <span
            className={s.meta}
            title={`最近 1s：RX ${st.rx_bps.toFixed(0)} B/s，TX ${st.tx_bps.toFixed(0)} B/s；`
              + `累计 RX ${st.rx_bytes_total} B / TX ${st.tx_bytes_total} B；`
              + `缓冲占用 行 ${(st.buffer.lines * 100).toFixed(0)}% / `
              + `字节 ${(st.buffer.bytes * 100).toFixed(0)}% / 帧 ${(st.buffer.frames * 100).toFixed(0)}%`
              + (st.warmup ? "（窗口不足 1s，速率为折算值）" : "")}
          >
            ↓ {fmtBps(st.rx_bps)} · ↑ {fmtBps(st.tx_bps)}
            {st.frames_per_s != null ? ` · ${st.frames_per_s.toFixed(0)} fps` : ""}
            {st.warmup ? " · 预热" : ""}
          </span>
        ) : null}
        {stream.issueTotal > 0 ? (
          <Button
            size="sm"
            variant={stream.issues.some((i) => i.kind !== "reset") ? "outline" : "ghost"}
            onClick={() => setIssuesOpen((v) => !v)}
            title="结构化异常（panic / assert / hardfault / 复位）；可展开符号化回溯地址"
          >
            异常 {stream.issueTotal}{issuesOpen ? " ▾" : " ▸"}
          </Button>
        ) : null}
        {stream.active && stream.snap?.opened_by ? (
          <span
            className={s.meta}
            style={{ color: stream.snap.opened_by === "agent" ? "var(--elab-accent)" : undefined }}
            title="串口会话归属与租约：agent 开的会话到期自动关闭并释放给人工"
          >
            会话 {stream.snap.opened_by === "agent" ? "agent" : "我"}
            {Math.ceil(stream.snap.lease_remaining_s ?? 0) > 0
              ? ` · 租约 ${Math.ceil(stream.snap.lease_remaining_s ?? 0)}s`
              : ""}
          </span>
        ) : null}
      </div>

      {framesOpen ? (
        <div className={s.framesDrawer} role="region" aria-label="帧协议编辑">
          <div className={s.framesHead}>
            <select
              className={s.select}
              value={frameSel}
              aria-label="选择帧协议"
              onChange={(e) => {
                const pid = e.currentTarget.value;
                setFrameSel(pid);
                const hit = frameProfiles.find((p) => p.id === pid);
                setFrameDoc(hit ? JSON.stringify(hit, null, 2) : "");
                setFramePreview(null);
                setFrameNotice(null);
              }}
            >
              {frameProfiles.length ? null : <option value="">（还没有 profile）</option>}
              {frameProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label || p.id}（{p.id}）
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={newFrameProfile}>新建</Button>
            <Button size="sm" variant="outline" onClick={() => void loadFrames(frameSel)}>刷新</Button>
            <select
              className={s.select}
              value={frameTpl}
              aria-label="帧协议模板"
              title="只读模板库 templates/frames/*.json"
              onChange={(e) => setFrameTpl(e.currentTarget.value)}
            >
              <option value="">（从模板导入…）</option>
              {frameTemplates.map((t) => (
                <option key={t.id} value={t.id} title={t.desc}>
                  {t.label}（{t.id}）
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={!project || !frameTpl}
              onClick={() => void importFrameTemplate()}
            >
              导入
            </Button>
            <span className={s.spacer} />
            <span className={s.meta} title={framePath}>rev {frameRev}</span>
          </div>
          <div className={s.framesBody}>
            <textarea
              className={s.framesEditor}
              spellCheck={false}
              value={frameDoc}
              placeholder="选择或新建一个 profile，然后在这里编辑 JSON"
              aria-label="帧协议 JSON"
              onChange={(e) => setFrameDoc(e.currentTarget.value)}
            />
            <div className={s.framesSide}>
              <div className={s.framesRow}>
                <Input
                  mono
                  size="sm"
                  value={frameHex}
                  placeholder="样本 HEX（如 A5 5A 03 E8 9C FF 01 …）"
                  aria-label="预览样本 HEX"
                  onChange={(e) => setFrameHex(e.currentTarget.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!frameDoc.trim()}
                  onClick={() => void previewFrameProfile()}
                  title="支持未保存草稿：按左侧 JSON 直接解码"
                >
                  预览
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!frameHex.trim() || frameLearnBusy}
                  onClick={() => void learnFrameProfile()}
                  title="按样本自学协议：推断帧头/长度/校验/字段，只产草稿不落盘"
                >
                  {frameLearnBusy ? `分析中 ${frameLearnSecs}s` : "学习"}
                </Button>
              </div>
              <div className={s.framesRow}>
                <Input
                  mono
                  size="sm"
                  value={frameValues}
                  placeholder='字段值 JSON（如 {"rpm":100,"mode":"RUN"}）'
                  aria-label="组帧字段值"
                  onChange={(e) => setFrameValues(e.currentTarget.value)}
                />
                <Input
                  mono
                  size="sm"
                  value={frameVariant}
                  placeholder="variant（可选，如 0x03）"
                  aria-label="组帧 variant"
                  onChange={(e) => setFrameVariant(e.currentTarget.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!frameDoc.trim()}
                  onClick={() => void encodeFrameProfile()}
                  title="字段值 → 帧字节，填入下方发送框（HEX）"
                >
                  组帧
                </Button>
              </div>
              <div className={s.framesRow}>
                <Button size="sm" disabled={!frameDoc.trim()} onClick={() => void saveFrameProfile()}>
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!frameSel}
                  onClick={() => void deleteFrameProfile()}
                >
                  删除
                </Button>
              </div>
              {frameNotice ? (
                <div className={frameNotice.startsWith("✗") ? s.warn : s.info}>{frameNotice}</div>
              ) : null}
              {frameWarns.length ? <div className={s.warn}>{frameWarns.join("；")}</div> : null}
              {framePreview ? (
                <div className={s.framesPreview}>
                  {framePreview.fields?.length ? (
                    <table className={s.framesTable}>
                      <thead>
                        <tr><th>字段</th><th>类型</th><th>单位</th><th>波形</th></tr>
                      </thead>
                      <tbody>
                        {framePreview.fields.map((f) => (
                          <tr key={f.name}>
                            <td>{f.name}</td><td>{f.type}</td>
                            <td>{f.unit || "—"}</td><td>{f.plot ? "是" : "否"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                  {framePreview.records?.length ? (() => {
                    const recs = framePreview.records ?? [];
                    // 多 ID：字段集合取并集；当前 variant 缺的字段显示 —。
                    const keys = Array.from(new Set(recs.flatMap((r) => Object.keys(r.fields))));
                    const hasMeta = recs.some((r) => r.variant !== undefined || r.id !== undefined);
                    return (
                      <table className={s.framesTable}>
                        <thead>
                          <tr>
                            {hasMeta ? <th>ID</th> : null}
                            {keys.map((k) => <th key={k}>{k}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {recs.slice(-10).map((rec, i) => (
                            <tr key={i}>
                              {hasMeta ? <td>{rec.variant ?? rec.id ?? "—"}</td> : null}
                              {keys.map((k) => <td key={k}>{String(rec.fields[k] ?? "—")}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    );
                  })() : <div className={s.meta}>没有解出帧</div>}
                  {framePreview.errors?.length ? (
                    <div className={s.warn}>{framePreview.errors.join("；")}</div>
                  ) : null}
                </div>
              ) : null}
              {frameEncoded?.ok ? (
                <div className={s.meta} title="组帧结果">
                  {`${frameEncoded.bytes ?? 0} B · ${frameEncoded.hex ?? ""}`}
                </div>
              ) : null}
              <div className={s.meta}>
                切帧：head / length / length_field 三选一；offset 从帧首字节算（含 head）；
                位域用 bit_offset + bit_length（bit_order=lsb0/msb0）；多 ID 用 id_field + variants。
                校验和不含帧尾标记。预览支持未保存草稿；保存后波形立即按新配置解码。
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {connState === "reconnecting" ? (
        <div className={s.warn} role="status">
          串口已掉线，正在自动重连
          {stream.snap?.down_s ? `（已断开 ${stream.snap.down_s}s）` : ""}
          {stream.snap?.last_error ? `：${stream.snap.last_error}` : ""}
          {" —— 插回/驱动恢复后日志自动续上，无需手动重开。"}
        </div>
      ) : null}
      {connState === "suspended" ? (
        <div className={s.info} role="status">
          监视已为闭环让出串口
          {stream.snap?.suspend_reason ? `（${stream.snap.suspend_reason}）` : ""}
          {" —— run 结束会自动恢复；也可立即恢复："}
          <Button size="sm" variant="ghost" onClick={() => void stream.restore()}>
            立即恢复
          </Button>
          {stream.snap?.resume_error ? ` 上次恢复失败：${stream.snap.resume_error}` : ""}
        </div>
      ) : null}
      {stream.snap?.reconnects ? (
        <div className={s.info}>
          已自动重连 {stream.snap.reconnects} 次（当前 conn #{stream.snap.conn}）
          {stream.snap?.port_changed
            ? `；端口变化 ${stream.snap.port_changed.from} → ${stream.snap.port_changed.to}`
            : ""}
        </div>
      ) : null}
      {stream.error ? (
        <div className={s.warn} role="alert">
          监视已中断：{stream.error}（服务端已释放串口）
        </div>
      ) : null}
      {stream.paused ? (
        <div className={s.info}>已暂停入环 —— 服务端仍在读口；点「继续」恢复。</div>
      ) : null}
      {issuesOpen && stream.issues.length ? (
        <div className={s.info} role="region" aria-label="结构化异常">
          <div style={{ maxHeight: 220, overflowY: "auto", display: "flex",
                       flexDirection: "column", gap: 8 }}>
            {stream.issues.slice().reverse().map((it) => (
              <div key={it.seq}>
                <div>
                  <b>{ISSUE_KIND_LABEL[it.kind] ?? it.kind}</b>
                  {` ${it.t}`}
                  {it.core ? ` · core ${it.core}` : ""}
                  {it.reason ? ` · ${it.reason}` : ""}
                  {it.after_reset ? " · 复位后" : ""}
                  {it.kind !== "reset" && it.backtrace.length ? (
                    <Button size="sm" variant="ghost"
                      onClick={() => void symbolizeIssue(it)}>
                      符号化
                    </Button>
                  ) : null}
                </div>
                <div className={s.meta}>{it.line}</div>
                {it.backtrace.length ? (
                  <div className={s.meta}>{it.backtrace.join(" ")}</div>
                ) : null}
                {(symbols[it.seq] ?? []).map((sym) => (
                  <div className={s.meta} key={sym.addr}>
                    {`${sym.addr} → ${sym.func ?? sym.note ?? "无法解析"}`}
                    {sym.file ? `（${sym.file}:${sym.line}）` : ""}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {cap && !cap.active && cap.truncated ? (
        <div className={s.warn}>
          录制已到上限并停止：{cap.path}（{cap.chunks} 批 / {cap.bytes} B）——
          证据文件已保留，可回放
        </div>
      ) : null}
      {lossy > 0 ? (
        <div className={s.warn}>
          环形缓冲已挤出：行 ≥{stream.gapLines} / 批次 ≥{stream.gapChunks}
          （只报告不抹平；完整留档请用「导出」或闭环 monitor 事件）
        </div>
      ) : null}

      <div className={s.scroll} ref={scrollRef}>
        {view === "lines" ? (
          lines.length === 0 ? (
            <div className={s.empty}>
              尚无行输出。设备只发提示符（无换行）时，静默 1 秒后也会被冲刷成一行。
            </div>
          ) : (
            <div className={s.lines}>
              {lines.map((l) => (
                <div key={l.seq} className={s.line}>
                  <span className={s.time}>{l.t}</span>
                  <span className={s.seq}>#{l.seq}</span>
                  <span className={s.text}>
                    <AnsiLine text={l.text} query={query.trim()} />
                  </span>
                </div>
              ))}
            </div>
          )
        ) : null}

        {view === "bytes" ? (
          byteBlocks.length === 0 ? (
            <div className={s.empty}>
              尚无字节。点「打开监视」后设备输出会以 RX 批次流进来；你发送的内容是 TX 批次。
            </div>
          ) : (
            <div className={s.bytesWrap}>
              {byteBlocks.map(({ c, header, body, rows }) => (
                <div key={c.seq} className={s.block}>
                  <div className={[s.blockHead, c.dir === "tx" ? s.tx : s.rx].join(" ")}>
                    <span className={s.dirTag}>{c.dir.toUpperCase()}</span>
                    <span className={s.time}>{c.t}</span>
                    <span className={s.blockMeta}>
                      {header} · {c.t_us}μs
                    </span>
                  </div>
                  {rows === null ? (
                    <pre className={s.pre}>{body}</pre>
                  ) : (
                    <div className={s.hexGrid}>
                      {rows.map((row, ri) => (
                        <div key={ri}>
                          <span className={s.bPad}>{row.offset}</span>
                          {"  "}
                          {row.cells.map((cell, ci) => (
                            <span key={ci} className={HEX_CELL_CLS[cell.cls]}>
                              {cell.text}
                              {ci === 7 ? "  " : ci === row.cells.length - 1 ? "" : " "}
                            </span>
                          ))}
                          {"  |"}
                          {row.ascii.map((cell, ci) => (
                            <span key={ci} className={HEX_CELL_CLS[cell.cls]}>
                              {cell.text}
                            </span>
                          ))}
                          {"|"}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        ) : null}

        {view === "terminal" ? (
          shownTerm.length === 0 ? (
            <div className={s.empty}>尚无终端内容。ANSI 颜色、`\r` 覆写与退格都已按终端语义处理。</div>
          ) : (
            <div className={s.term}>
              {shownTerm.map((ln, i) => (
                <div key={i} className={s.termLine}>
                  {ln.length ? (
                    ln.map((sp, j) => (
                      <span key={j} className={cls(sp.cls)}>
                        {sp.text}
                      </span>
                    ))
                  ) : (
                    "\u00a0"
                  )}
                </div>
              ))}
            </div>
          )
        ) : null}

        {view === "wave" ? (
          <div className={s.wavePanel}>
            {waveErr ? <div className={s.warn}>解码失败：{waveErr}</div> : null}
            {!waveErr && frames.length === 0 ? (
              <div className={s.empty}>
                尚无波形。设备按 {decoders.find((d) => d.id === decoder)?.label ?? decoder} 输出
                （例如 JustFloat：N×4 小端 float + 尾 00 00 80 7F）时，这里会按通道画折线。
                {decodeMeta && decodeMeta.skipped > 0 ? (
                  <>
                    <br />
                    当前窗口未解出完整帧（跳过 {decodeMeta.skipped} 段
                    {decodeMeta.pending ? `、残留 ${decodeMeta.pending} B` : ""}）——
                    这段流里混有不属于该协议的字节，可用方向过滤只看设备帧输出。
                  </>
                ) : null}
              </div>
            ) : null}

            {/* ── 多面板 tab 条 ── */}
            {frames.length > 0 && waveViewports.length > 0 ? (
              <div className={s.waveVpBar}>
                <div className={s.waveVpTabs}>
                  {waveViewports.map((vp) => (
                    <div key={vp.id} className={s.waveVpTabRow}>
                      <button
                        type="button"
                        className={`${s.waveVpTab} ${activeViewport === vp.id ? s.waveVpTabActive : ""}`}
                        onClick={() => setActiveViewport(vp.id)}
                        title={`切换到 ${vp.name}`}
                      >
                        {vp.name}
                      </button>
                      {waveViewports.length > 1 ? (
                        <button
                          type="button"
                          className={s.waveVpTabClose}
                          onClick={() => removeWaveViewport(vp.id)}
                          title="删除此面板（至少保留一个）"
                        >×</button>
                      ) : null}
                    </div>
                  ))}
                  <button
                    type="button"
                    className={s.waveVpAdd}
                    onClick={addWaveViewport}
                    title="新建波形面板：独立缩放/平移，可绑定不同通道"
                  >+ 新建面板</button>
                </div>

                {/* 当前面板的通道绑定 + 独立跟随 */}
                {(() => {
                  const vp = waveViewports.find((v) => v.id === activeViewport);
                  if (!vp) return null;
                  const totalCh = decodeMeta?.channels ?? (frames[0]?.length ?? 0);
                  return (
                    <div className={s.waveVpControls}>
                      <span className={s.waveVpLabel}>通道绑定：</span>
                      {Array.from({ length: totalCh }, (_, i) => {
                        const on = vp.channels.includes(i);
                        return (
                          <button
                            key={i}
                            type="button"
                            className={`${s.waveChChip} ${on ? s.waveChChipOn : ""}`}
                            onClick={() => {
                              const newCh = on
                                ? vp.channels.filter((x) => x !== i)
                                : [...vp.channels, i].sort((a, b) => a - b);
                              if (newCh.length > 0) setViewportChannels(vp.id, newCh);
                            }}
                            title={`${on ? "取消" : "绑定"} CH${i}`}
                          >
                            CH{i}
                          </button>
                        );
                      })}
                      <span className={s.waveVpSpacer} />
                    </div>
                  );
                })()}
              </div>
            ) : null}

            {/* ── 波形图（当前激活面板） ── */}
            {frames.length > 0 && waveViewports.length > 0 ? (
              (() => {
                const vp = waveViewports.find((v) => v.id === activeViewport);
                if (!vp) return null;
                const f = viewportFollow[vp.id] ?? autoScroll;
                return (
                  <WaveChart
                    key={vp.id}
                    frames={frames}
                    times={frameTimes}
                    fields={frameFields}
                    channels={vp.channels}
                    scaleX={vp.scaleX}
                    offsetX={vp.offsetX}
                    onView={(sx, ox) => setViewportView(vp.id, sx, ox)}
                    follow={f}
                    onFollowChange={(v) => setViewportFollow((prev) => ({ ...prev, [vp.id]: v }))}
                  />
                );
              })()
            ) : null}

            {decodeMeta || sharedLane ? (
              <div className={s.waveMeta}>
                {frames.length} 帧 · {frameFields.length || decodeMeta?.channels || (frames[0]?.length ?? 0)} 通道
                {sharedLane ? " · 会话共享解码（Δt 可用）" : ""}
                {decodeMeta?.skipped
                  ? ` · 跳过 ${decodeMeta.skipped}${reasonSummary(decodeMeta.reasons)}`
                  : ""}
                {decodeMeta?.pending ? ` · 半帧 ${decodeMeta.pending} B（下一轮续解）` : ""}
                {health ? (
                  <span className={s.waveHealth}>
                    <span title="最近 10 秒帧率">{health.fps.toFixed(1)} fps</span>
                    <span title="帧到达间隔：均值/p95">Δ {health.interval}</span>
                    <span
                      className={health.errorRate > 0 ? s.waveHealthBad : undefined}
                      title="错误帧占比（帧头/长度/校验/未知 id）"
                    >
                      错 {(health.errorRate * 100).toFixed(1)}%
                    </span>
                    {speciesCount(health.variants) > 1 ? (
                      <span title={variantSummary(health.variants)}>
                        {speciesCount(health.variants)} 种消息
                      </span>
                    ) : null}
                    {health.pending > 0 ? <span>半帧 {health.pending} B</span> : null}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {jobNotice ? (
        <div
          className={jobNotice.startsWith("✗") ? s.warn : s.info}
          role="status"
        >
          {jobNotice}
        </div>
      ) : null}

      {/* ── 发送面板：与监视会话同一个口（写穿，不重开）── */}
      <form className={s.write} onSubmit={(e) => void doSend(e)}>
        <div className={s.writeMain}>
          <IconTerminal className={s.writeIcon} />
          <Input
            mono
            className={s.writeInput}
            placeholder={
              running
                ? "有 run 在跑：串口与 run 互斥（约束 N5），等它结束"
                : sendFormat === "hex"
                  ? "输入十六进制，如 01 A0 FF"
                  : sendFormat === "auto"
                    ? "输入任意内容：自动识别 HEX/文本（↑/↓ 调取历史，含格式）"
                    : "输入一行并按回车发送到设备"
            }
            aria-label="串口发送内容"
            value={draft}
            disabled={running}
            onKeyDown={onDraftKey}
            onChange={(e) => {
              setDraft(e.currentTarget.value);
              setHistIdx(-1);
            }}
          />
          <Button
            size="sm"
            variant="primary"
            type="submit"
            disabled={running || jobRunning || !draft.trim()}
          >
            发送
          </Button>
        </div>
        <div className={s.writeOpts}>
          <select
            className={s.select}
            value={sendFormat}
            onChange={(e) => setSendFormat(e.currentTarget.value as SerialFormat)}
            aria-label="发送格式"
            title="发送表示：HEX 模式按十六进制解析，且不追加行尾"
          >
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            className={s.select}
            value={eol}
            onChange={(e) => setEol(e.currentTarget.value)}
            aria-label="行结束符"
            disabled={sendFormat === "hex" || (sendFormat === "auto" && sendPreview?.format === "hex")}
            title={
              sendFormat === "hex" || (sendFormat === "auto" && sendPreview?.format === "hex")
                ? "HEX 模式不追加行尾（二进制帧多一个字节就是错）"
                : "追加的行结束符"
            }
          >
            {EOLS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            className={s.select}
            style={{ width: 72, minWidth: 72 }}
            value={loopInterval}
            onChange={(e) => setLoopInterval(e.currentTarget.value)}
            aria-label="定时发送间隔"
            title="定时发送间隔（毫秒，≥20；由内核校验）"
            min={20}
            step={10}
            disabled={rawLoopActive || running}
          />
          <span style={{ fontSize: 12, color: "var(--elab-fg-dimmed)" }}>ms</span>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={running || (!rawLoopActive && !draft.trim())}
            onClick={() => void (rawLoopActive ? cancelJob() : startLoop())}
            title="按固定间隔重复发送输入框内容（复用内核任务引擎）"
          >
            {rawLoopActive ? "■ 停止定时" : "⏵ 定时"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.log,.json,.hex,text/plain"
            onChange={(e) => void doSendFile(e)}
            style={{ display: "none" }}
          />
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={running || fileBusy}
            onClick={() => fileRef.current?.click()}
            title={`选文件按行发送（每行按当前格式与行尾，最多 ${MAX_FILE_LINES} 行）`}
          >
            {fileBusy ? "发送中…" : "文件"}
          </Button>
        </div>
      </form>

      {sendPreview ? (
        sendPreview.ok ? (
          <div className={s.info} role="status">
            {`将发送 ${sendPreview.bytes} B · ${sendPreview.preview_hex || "（空）"}` +
              (sendPreview.format
                ? ` · 识别为 ${FORMATS.find((f) => f.id === sendPreview.format)?.label ?? sendPreview.format}`
                : "") +
              (sendPreview.format !== "hex" && sendPreview.eol_key
                ? ` · 行尾 ${sendPreview.eol_key}`
                : "")}
          </div>
        ) : (
          <div className={s.warn} role="status">
            {sendPreview.error ?? "预览失败"}
          </div>
        )
      ) : null}
      {notice ? (
        <div className={notice.startsWith("✗") ? s.warn : s.info} role="status">
          {notice}
        </div>
      ) : null}
      {!project ? (
        <div className={s.info}>未选择工程：端口/波特率无法解析（先在左侧选一个工程）。</div>
      ) : null}
    </div>
  );
}

/** WaveChart V2 —— 多通道折线 + 缩放 + 平移 + 时间轴 + 跟随
 *
 * 缩放/平移状态**由父组件按 viewport 持有**（scaleX/offsetX 走 props），
 * 这样切 tab 时每个面板各自保留自己的视图，不会被相邻面板「串味」。
 * 拖拽的临时量仍是内部 ref；跟随状态也由父组件按 viewport 持有。
 */
interface WaveChartProps {
  frames: Array<Array<number | null>>;
  /** 每帧时间戳（微秒）；null/缺省 = 无时间源（Δt 显示 —，不编造） */
  times?: number[] | null;
  /** 通道名/单位（帧协议字段表；缺省显示 CHn） */
  fields?: { name: string; unit: string; type: string; plot: boolean }[];
  /** 要显示的通道索引数组，例如 [0, 2] 只画 CH0/CH2；也可以传数字表示"画前 N 个" */
  channels: number[] | number;
  /** X 轴缩放（1 = 全部可见；>1 = 放大） */
  scaleX: number;
  /** 最左边可见帧 index（0-based） */
  offsetX: number;
  /** 缩放/平移变化回写父组件（按 viewport 保存） */
  onView: (scaleX: number, offsetX: number) => void;
  /** 跟随最新帧；外部驱动——顶层 autoScroll 或面板内独立按钮 */
  follow: boolean;
  onFollowChange: (v: boolean) => void;
}

const WAVE_PALETTE = [
  ["bright-blue", "#4ea1ff"],
  ["bright-green", "#4c9a2a"],
  ["bright-red", "#e24b4a"],
  ["bright-yellow", "#b3701a"],
  ["bright-magenta", "#b060cc"],
  ["bright-cyan", "#0891b2"],
  ["blue", "#3b82f6"],
  ["green", "#22c55e"],
] as const;

function resolvedChannels(ch: number[] | number, frameChannels: number): number[] {
  if (typeof ch === "number") {
    return Array.from({ length: Math.min(ch, frameChannels) }, (_, i) => i);
  }
  return ch.filter((i) => i >= 0 && i < frameChannels);
}

function WaveChart({
  frames, times, fields, channels, scaleX, offsetX, onView, follow, onFollowChange,
}: WaveChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ startClientX: number; startOffset: number } | null>(null);
  const downRef = useRef<{ x: number; y: number; shift: boolean } | null>(null);
  const dragActive = useRef(false);
  // ── 取消跟随 = 定格画面 ──────────────────────────────────────
  // 波形是"最近 N 字节"的滚动解码窗口：只钉住 offsetX 没用 —— 窗口本身
  // 在滑，同一个 index 已经对应到新数据，曲线看起来就一直在走。
  // 所以 follow=false 时留下**这一刻的帧 + 时间戳快照**，恢复跟随才换回实时帧。
  const [frozen, setFrozen] = useState<{ frames: Array<Array<number | null>>; times: number[] | null } | null>(null);
  useEffect(() => {
    if (frames.length === 0) {
      setFrozen(null);
      return;
    }
    if (follow) {
      setFrozen(null);
      return;
    }
    setFrozen((cur) => cur ?? { frames, times: times ?? null });
  }, [follow, frames, times]);
  const shown = follow ? frames : (frozen?.frames ?? frames);
  const shownTimes = follow ? (times ?? null) : (frozen?.times ?? null);

  // ── 每通道坐标（增益/偏移）与游标（M7） ──────────────────────
  // gain/offset 只影响绘制，不改原始数据；量程仍按原始值自动算。
  const [axis, setAxis] = useState<Record<number, { gain: number; offset: number }>>({});
  const axisOf = (ch: number) => axis[ch] ?? { gain: 1, offset: 0 };
  const [axesOpen, setAxesOpen] = useState(false);
  const [cursor, setCursor] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const [snapNotice, setSnapNotice] = useState<string | null>(null);

  const frameChannels = shown[0]?.length ?? 0;
  const shownCh = resolvedChannels(channels, frameChannels);
  const labelOf = (ch: number) => fields?.[ch]?.name || `CH${ch}`;
  const unitOf = (ch: number) => fields?.[ch]?.unit || "";

  // ── 当 frames 更新时自动 follow 到尾 ──────────────────────────
  const lastFramesLen = useRef(0);
  /**
   * 视口帧数：以「当前全部帧」为基准按倍率切分（×1 = 全部可见，×2 = 一半）。
   * ★ 不能再用 canvas 宽度 / scaleX 当槽位数：刚连上只有几十帧时槽位远多于帧数，
   *   slice 永远被拉伸到满宽 —— 点 +/− 或滚轮都看不出变化（缩放看起来失灵）。
   */
  const visibleFrames = (scale: number): number => Math.max(2, Math.round(shown.length / scale));
  useEffect(() => {
    if (shown.length === 0) {
      onView(scaleX, 0);
      return;
    }
    const prev = lastFramesLen.current;
    lastFramesLen.current = shown.length;
    // 只有在 follow=true 且帧增加时才跳；帧清空（clear）也跳回 0
    if (follow) {
      const visible = visibleFrames(scaleX);
      const maxOffset = Math.max(0, shown.length - visible);
      onView(scaleX, maxOffset);
    } else if (shown.length > 0 && prev === 0) {
      // 从空变成有帧，且 follow=false —— 保持 offsetX 合法
      const visible = visibleFrames(scaleX);
      onView(scaleX, Math.min(offsetX, Math.max(0, shown.length - visible)));
    }
    // onView/offsetX 故意不进依赖：只在帧数或缩放/跟随变化时重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.length, follow, scaleX]);

  // ── 绘制（frames / scaleX / offsetX 变化都触发） ──────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || shown.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 480;
    const h = canvas.clientHeight || 220;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(canvas);
    const cvar = (n: string) => css.getPropertyValue(n).trim();
    const border = cvar("--elab-border") || "rgba(128,128,128,0.3)";
    const axisLabel = cvar("--elab-fg-faint") || "rgba(128,128,128,0.6)";
    const palette: string[] = WAVE_PALETTE.map(
      ([tok, fb]) => cvar(`--elab-ansi-${tok}`) || fb,
    );

    // ── 布局：顶部一行标签 / 底部一行帧号，绘图区夹在中间 ──
    const padL = 8;
    const padR = 8;
    const padT = 16;
    const padB = 18;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    if (plotW <= 4 || plotH <= 4) return;
    const plotTop = padT;
    const plotBottom = padT + plotH;

    // ── 可视帧范围 ──
    const visibleCount = visibleFrames(scaleX);
    const startIdx = Math.max(0, Math.min(offsetX, shown.length - 1));
    const endIdx = Math.min(shown.length, startIdx + visibleCount);
    const slice = shown.slice(startIdx, endIdx);
    if (slice.length === 0) return;
    // 帧 → x 像素（与折线用同一映射，网格才不会错位）
    const xOf = (i: number) =>
      padL + (slice.length <= 1 ? plotW / 2 : (i / (slice.length - 1)) * plotW);

    // ── 水平网格（4 等分） ──
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = plotTop + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
    }
    // ── 垂直时间轴网格 + 帧号 label ──
    const stepSec = Math.max(10, Math.round(slice.length / 6));
    ctx.fillStyle = axisLabel;
    ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
    ctx.textBaseline = "top";
    for (let i = 0; i < slice.length; i += stepSec) {
      const x = xOf(i);
      if (x > w - padR) break;
      ctx.strokeStyle = border;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.textAlign = "center";
      // 首尾帧号夹在画布内，否则画布边缘会把文字裁掉
      const label = `${startIdx + i}`;
      const half = ctx.measureText(label).width / 2;
      const lx = Math.min(w - padR - half, Math.max(padL + half, x));
      ctx.fillText(label, lx, plotBottom + 3);
    }

    // ── 通道折线（各通道独立归一化 + 用户增益/偏移） ──
    const chRange: Record<number, { lo: number; hi: number }> = {};
    for (const ch of shownCh) {
      const values = slice.map((f) => (ch < f.length ? f[ch] : NaN));
      const range = autoRange(values);
      if (!range) continue;
      chRange[ch] = range;
      const { gain, offset } = axisOf(ch);
      ctx.strokeStyle = palette[ch % palette.length];
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null || !Number.isFinite(v)) { started = false; continue; }
        const x = xOf(i);
        const y = valueToY(v, range.lo, range.hi, plotH, gain, offset) + plotTop;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // ── 游标 A/B（M7）：竖线 + 各通道交点；Δt/ΔY 在下方卡片里算 ──
    const drawCursor = (idx: number | null, tag: string) => {
      if (idx === null || idx < startIdx || idx >= endIdx) return;
      const x = xOf(idx - startIdx);
      ctx.save();
      ctx.strokeStyle = tag === "A" ? palette[0] : palette[2];
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      const f = shown[idx];
      for (const ch of shownCh) {
        const v = f[ch];
        const r = chRange[ch];
        if (!r || v === null || !Number.isFinite(v)) continue;
        const { gain, offset } = axisOf(ch);
        const y = valueToY(v, r.lo, r.hi, plotH, gain, offset) + plotTop;
        ctx.fillStyle = palette[ch % palette.length];
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = tag === "A" ? palette[0] : palette[2];
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(tag, Math.max(padL, Math.min(w - padR - 8, x + 4)), plotTop + 2);
      ctx.restore();
    };
    drawCursor(cursor.a, "A");
    drawCursor(cursor.b, "B");

    // ── 顶部左右标签：起始帧 / 总帧 + 缩放 ──
    ctx.fillStyle = axisLabel;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(`帧 ${startIdx} → ${endIdx - 1}`, padL, 2);
    ctx.textAlign = "right";
    ctx.fillText(`共 ${shown.length} 帧 · 窗口 ${endIdx - startIdx} · ×${scaleX.toFixed(1)}`, w - padR, 2);
  }, [shown, shownTimes, scaleX, offsetX, shownCh, axis, cursor, fields]);

  // ── 交互事件 ──────────────────────────────────────────────────
  // 滚轮缩放：用原生监听（passive: false）。React 17+ 在根节点把 wheel 注册为 passive，
  // preventDefault 无效，滚轮会先滚外层页面，表现为「缩放没反应」。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent): void => {
      if (shown.length === 0) return;
      e.preventDefault();
      // Shift+滚轮 = 纵向增益（所有已显示通道一起缩放），普通滚轮仍横向缩放
      if (e.shiftKey) {
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        setAxis((prev) => {
          const next = { ...prev };
          for (const ch of shownCh) {
            const cur = next[ch] ?? { gain: 1, offset: 0 };
            next[ch] = {
              gain: Math.min(10, Math.max(0.1, cur.gain * factor)),
              offset: cur.offset,
            };
          }
          return next;
        });
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const padL = 8;
      const plotW = Math.max(1, rect.width - padL - 8);
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - padL) / plotW));
      const span = visibleFrames(scaleX);
      const frameAtCursor = Math.round(offsetX + frac * span);
      const newScale = Math.min(20, Math.max(1, e.deltaY < 0 ? scaleX * 1.2 : scaleX / 1.2));
      if (newScale === scaleX) return;
      const newSpan = visibleFrames(newScale);
      const maxOffset = Math.max(0, shown.length - newSpan);
      const newOffset = Math.max(0, Math.min(maxOffset, frameAtCursor - Math.round(frac * newSpan)));
      onView(newScale, newOffset);
      if (follow) onFollowChange(false);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [shown.length, scaleX, offsetX, follow, onView, onFollowChange, shownCh, setAxis]);

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = { startClientX: e.clientX, startOffset: offsetX };
    dragActive.current = true;
    downRef.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    e.preventDefault();
  };
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragActive.current || !dragRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const padL = 8;
    const plotW = rect.width - padL - 8;
    const dx = e.clientX - dragRef.current.startClientX;
    // 平移手感必须与**实际画出的帧跨度**一致，视口帧数同样按「总帧数 / 倍率」计算。
    const visibleCount = visibleFrames(scaleX);
    const startOffset = dragRef.current.startOffset;
    const span = Math.max(1, Math.min(visibleCount, shown.length - Math.min(startOffset, shown.length - 1)));
    const offsetDelta = Math.round(-dx * span / plotW);
    let newOffset = dragRef.current.startOffset + offsetDelta;
    newOffset = Math.max(0, Math.min(newOffset, Math.max(0, shown.length - visibleCount)));
    if (newOffset !== dragRef.current.startOffset) onView(scaleX, newOffset);
    if (follow) onFollowChange(false);
  };
  /**
   * 松开鼠标：位移 ≤4px 视为「点选游标」（拖拽则是平移，不落游标）。
   * 普通点击 = 游标 A（清空 B）；Shift+点击 = 游标 B。
   */
  const endDrag = (e?: React.MouseEvent<HTMLCanvasElement>) => {
    const down = downRef.current;
    dragActive.current = false;
    dragRef.current = null;
    downRef.current = null;
    const canvas = canvasRef.current;
    if (!e || !down || !canvas || !shown.length) return;
    if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4) return;
    const rect = canvas.getBoundingClientRect();
    const padL = 8;
    const plotW = rect.width - padL - 8;
    if (plotW <= 4) return;
    const visibleCount = visibleFrames(scaleX);
    // 与绘制同源：一屏真实帧数是 min(视口帧数, 剩余帧)。
    const span = Math.max(1, Math.min(visibleCount, shown.length - Math.min(offsetX, shown.length - 1)));
    const within = nearestFrameIndex((e.clientX - rect.left - padL) / plotW, span);
    const idx = Math.max(0, Math.min(shown.length - 1, offsetX + within));
    setCursor((prev) => (down.shift
      ? { a: prev.a ?? idx, b: idx }
      : { a: idx, b: null }));
  };

  // ── 测量卡（M7）：A/B 的 Δ帧、Δt（真实批次时间）、每通道 ΔY ──────
  const probe = (i: number | null) => (i === null || !shown[i])
    ? null
    : { index: i, t_us: shownTimes?.[i], values: shown[i] };
  const pa = probe(cursor.a);
  const pb = probe(cursor.b);
  const gainArr = shownCh.map((ch) => axisOf(ch).gain);
  const offsetArr = shownCh.map((ch) => axisOf(ch).offset);
  const delta = pa && pb ? measure(pa, pb, gainArr, offsetArr) : null;

  const frozenAt = !follow && frozen ? frozen.frames.length - 1 : null;
  const frozenTime = frozenAt !== null && shownTimes?.[frozenAt] !== undefined
    ? new Date(shownTimes[frozenAt] / 1000).toISOString().slice(11, 23)
    : null;

  const copySnapshot = () => {
    const channelsMeta = shownCh.map((ch) => ({
      index: ch,
      label: labelOf(ch),
      unit: unitOf(ch),
      gain: axisOf(ch).gain,
      offset: axisOf(ch).offset,
    }));
    const text = snapshotJson({
      frozen: !follow,
      scaleX,
      offsetX,
      frameCount: shown.length,
      cursors: { a: pa, b: pb },
      channels: channelsMeta,
    });
    void navigator.clipboard?.writeText(text).then(
      () => setSnapNotice("快照已复制到剪贴板"),
      () => setSnapNotice("剪贴板不可用（快照未复制）"),
    );
  };

  const canvasReady = shown.length > 0;

  return (
    <div className={s.waveBox}>
      {/* 顶部工具栏：通道图例 + 缩放按钮 + 跟随 */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <div className={s.legend} style={{ flex: "1 1 auto" }}>
          {shownCh.map((ch) => (
            <span
              key={ch}
              className={s.legendItem}
              title={`${labelOf(ch)}${unitOf(ch) ? ` (${unitOf(ch)})` : ""} · gain ${axisOf(ch).gain} · offset ${axisOf(ch).offset}`}
            >
              <span className={s.swatch} style={{ background: `var(--elab-ansi-${WAVE_PALETTE[ch % 8][0]})` }} />
              {labelOf(ch)}{unitOf(ch) ? ` (${unitOf(ch)})` : ""}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          <button
            type="button"
            onClick={() => onView(Math.max(1, scaleX / 1.2), offsetX)}
            title="缩小（向后看更多帧）"
            className={s.waveToolBtn}
            disabled={!canvasReady}
          >−</button>
          <button
            type="button"
            onClick={() => onView(Math.min(20, scaleX * 1.2), offsetX)}
            title="放大（看更精细的局部）"
            className={s.waveToolBtn}
            disabled={!canvasReady}
          >+</button>
          <button
            type="button"
            onClick={() => onView(1, 0)}
            title="重置（全部可见、回到开头）"
            className={s.waveToolBtn}
            disabled={!canvasReady}
          >⤾</button>
          <button
            type="button"
            onClick={() => setAxesOpen((v) => !v)}
            title="每通道坐标：增益（压扁/放大曲线）与偏移（整条上移/下移）"
            className={s.waveToolBtn}
            style={axesOpen ? { color: "var(--elab-accent)", borderColor: "var(--elab-accent)" } : undefined}
            disabled={!canvasReady}
          >通道</button>
          <button
            type="button"
            onClick={() => setCursor({ a: null, b: null })}
            title="清空游标 A/B（点击画布放 A，Shift+点击放 B）"
            className={s.waveToolBtn}
            disabled={cursor.a === null}
          >清游标</button>
          <button
            type="button"
            onClick={copySnapshot}
            title="把当前视口 + 游标 + 通道坐标复制成 JSON（便于粘贴到 issue/报告）"
            className={s.waveToolBtn}
            disabled={!canvasReady}
          >快照</button>
          <button
            type="button"
            onClick={() => onFollowChange(!follow)}
            title={follow
              ? "正在跟随最新帧，点击暂停（画面定格在当前窗口，数据仍继续接收）"
              : "画面已定格，点击恢复跟随最新帧"}
            className={s.waveToolBtn}
            style={follow ? { color: "var(--elab-accent)", borderColor: "var(--elab-accent)" } : undefined}
            disabled={!canvasReady}
          >
            {follow ? "❚❚ 暂停跟随" : "▶ 恢复跟随"}
          </button>
        </div>
      </div>

      {frozenAt !== null ? (
        <div className={s.meta} style={{ padding: "0 8px" }}>
          ❚❚ 已冻结 @ #{frozenAt}{frozenTime ? ` · ${frozenTime}` : ""}
          　（数据仍在接收；点「恢复跟随」回到实时）
        </div>
      ) : null}
      {snapNotice ? <div className={s.meta} style={{ padding: "0 8px" }}>{snapNotice}</div> : null}

      {axesOpen ? (
        <div className={s.axisPanel} role="region" aria-label="每通道坐标">
          {shownCh.map((ch) => {
            const a = axisOf(ch);
            return (
              <div key={ch} className={s.axisRow}>
                <span className={s.swatch} style={{ background: `var(--elab-ansi-${WAVE_PALETTE[ch % 8][0]})` }} />
                <span className={s.axisName}>{labelOf(ch)}{unitOf(ch) ? ` (${unitOf(ch)})` : ""}</span>
                <label className={s.axisLabel}>
                  增益
                  <input
                    className={s.axisInput}
                    type="number"
                    step="0.1"
                    value={a.gain}
                    onChange={(e) => {
                      const v = Number(e.currentTarget.value);
                      setAxis((prev) => ({
                        ...prev,
                        [ch]: { gain: Number.isFinite(v) ? v : 1, offset: a.offset },
                      }));
                    }}
                  />
                </label>
                <label className={s.axisLabel}>
                  偏移
                  <input
                    className={s.axisInput}
                    type="number"
                    step="1"
                    value={a.offset}
                    onChange={(e) => {
                      const v = Number(e.currentTarget.value);
                      setAxis((prev) => ({
                        ...prev,
                        [ch]: { gain: a.gain, offset: Number.isFinite(v) ? v : 0 },
                      }));
                    }}
                  />
                </label>
                <button
                  type="button"
                  className={s.waveToolBtn}
                  onClick={() => setAxis((prev) => ({ ...prev, [ch]: { gain: 1, offset: 0 } }))}
                  title="该通道恢复默认坐标（gain=1, offset=0）"
                >↺</button>
              </div>
            );
          })}
          <div className={s.meta}>
            量程始终按原始值自动计算：改增益会压扁/放大曲线，改偏移会整体上下移动（不改变原始数据）。
          </div>
        </div>
      ) : null}

      <canvas
        ref={canvasRef}
        className={s.canvas}
        style={{ cursor: canvasReady ? (dragActive.current ? "grabbing" : "crosshair") : "default" }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={() => endDrag()}
      />

      {pa ? (
        <div className={s.measure} role="status" aria-label="游标测量">
          <div className={s.measureHead}>
            <span>A #{pa.index}{pa.t_us !== undefined ? ` · ${new Date(pa.t_us / 1000).toISOString().slice(11, 23)}` : ""}</span>
            {pb ? (
              <>
                <span>B #{pb.index}{pb.t_us !== undefined ? ` · ${new Date(pb.t_us / 1000).toISOString().slice(11, 23)}` : ""}</span>
                <span className={s.measureStrong}>
                  Δ帧 {delta?.d_frames ?? "—"}　Δt {fmtDuration(delta?.dt_us ?? null)}
                </span>
              </>
            ) : (
              <span className={s.meta}>Shift+点击设置 B（当前只有 A；单击画布可重放 A）</span>
            )}
          </div>
          <table className={s.framesTable}>
            <thead>
              <tr>
                <th>通道</th><th>A</th>{pb ? <th>B</th> : null}
                {pb ? <th>Δ原始</th> : null}<th>{pb ? "Δ缩放" : "单位"}</th>
              </tr>
            </thead>
            <tbody>
              {shownCh.map((ch, i) => (
                <tr key={ch}>
                  <td>{labelOf(ch)}</td>
                  <td>{fmtValue(pa.values[ch])}</td>
                  {pb ? <td>{fmtValue(pb.values[ch])}</td> : null}
                  {pb ? <td>{fmtValue(delta?.dy[i] ?? NaN)}</td> : null}
                  <td>{pb ? fmtValue(delta?.dy_scaled[i] ?? NaN) : (unitOf(ch) || "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shownTimes === null ? (
            <div className={s.meta}>当前窗口没有时间源（会话未开或未启用共享解码）→ Δt 显示 —。</div>
          ) : (
            <div className={s.meta}>Δt 用 RX 批次时间戳（同批多帧时间相同），精度受批大小限制。</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
