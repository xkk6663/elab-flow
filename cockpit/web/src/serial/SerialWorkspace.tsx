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
  SerialFormat,
  SerialWidget,
  SerialWidgetParam,
  SerialWidgetRunResult,
} from "../api/types";
import { asciiOf, captureText, hexDump, hexDumpRows, parseAnsi, textOf } from "@elab/cockpit-ui-core";
import type { SerialRepr } from "@elab/cockpit-ui-core";
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

/** 发送历史（↑/↓ 调取）：只留最近 N 条，跨会话记忆 */
const HISTORY_KEY = "elab.serial.send.history";
const HISTORY_MAX = 50;
/** 文件按行发送的行数上限（按行逐条发，太多行会把发送面板占住很久） */
const MAX_FILE_LINES = 2000;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string").slice(-HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

function saveHistory(items: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(-HISTORY_MAX)));
  } catch {
    // 隐私模式/配额满：历史只是便利，不写也不影响发送
  }
}

// ── 自定义发送组件（M1）────────────────────────────────────────
/** 参数默认值（服务端已归一化；前端只做展示初值，不承担校验） */
function widgetDefaults(w: SerialWidget): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const p of w.params ?? []) {
    out[p.name] =
      p.type === "bool"
        ? Boolean(p.default)
        : p.default === undefined || p.default === null
          ? ""
          : String(p.default);
  }
  return out;
}

function widgetOption(
  o: string | { label: string; value: string },
): { label: string; value: string } {
  return typeof o === "string" ? { label: o, value: o } : o;
}

/** 参数的输入提示（范围/宽度由服务端 schema 给出，不在前端另立规则） */
function widgetParamHint(p: SerialWidgetParam): string {
  if (p.type === "int" || p.type === "float") {
    const bits: string[] = [];
    if (p.min !== undefined) bits.push(`≥ ${p.min}`);
    if (p.max !== undefined) bits.push(`≤ ${p.max}`);
    if (p.type === "int" && p.render === "hex") bits.push(`HEX ${p.width ?? 2} 位`);
    return bits.join(" · ");
  }
  if (p.type === "hex") {
    return `HEX ${p.width ?? 1} 字节${p.endian === "le" ? "（小端）" : ""}`;
  }
  if (p.type === "string") return `≤ ${p.max_len ?? 256} 字`;
  if (p.type === "enum") return "下拉选择";
  return "";
}

/** 任务是否仍在跑（轮询到终态才停）。 */
function widgetJobActive(j: SerialWidgetRunResult | null): boolean {
  return (
    j !== null &&
    (j.state === "running" || j.state === "paused" || j.state === "cancelling")
  );
}

/** 预览字节 → HEX（服务端返回的 preview_b64 是**唯一**的发送字节） */
function widgetHex(b64: string | undefined): string {
  if (!b64) return "";
  try {
    return Array.from(b64ToBytes(b64))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")
      .toUpperCase();
  } catch {
    return "";
  }
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
  const [sendFormat, setSendFormat] = useState<SerialFormat>("utf8");
  const [eol, setEol] = useState("crlf");
  const [notice, setNotice] = useState<string | null>(null);
  const [decoder, setDecoder] = useState("justfloat");
  /** 发送历史（↑/↓ 调取；跨会话记忆） */
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [histIdx, setHistIdx] = useState(-1);
  const [fileBusy, setFileBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── 自定义发送组件（M1）：chips + 参数 + 服务端预览 ───────────
  const [widgets, setWidgets] = useState<SerialWidget[]>([]);
  const [widgetWarn, setWidgetWarn] = useState<string[]>([]);
  const [widgetFileError, setWidgetFileError] = useState<string | null>(null);
  const [activeWidgetId, setActiveWidgetId] = useState<string | null>(null);
  const [widgetParams, setWidgetParams] = useState<Record<string, string | boolean>>({});
  const [widgetPreview, setWidgetPreview] = useState<SerialWidgetRunResult | null>(null);
  const [widgetErr, setWidgetErr] = useState<string | null>(null);
  const [widgetBusy, setWidgetBusy] = useState(false);
  const [widgetNotice, setWidgetNotice] = useState<string | null>(null);
  /** M2：异步任务快照 + 轮询 id（run / job 返回同一形状） */
  const [widgetJob, setWidgetJob] = useState<SerialWidgetRunResult | null>(null);
  const [widgetJobId, setWidgetJobId] = useState("");
  const activeWidget = useMemo(
    () => widgets.find((w) => w.id === activeWidgetId) ?? null,
    [widgets, activeWidgetId],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{
    key: string;
    lastSeq: number;
    term: AnsiTerminal;
    dec: StreamTextDecoder;
  } | null>(null);

  const epoch = stream.snap?.epoch ?? 0;

  // ── 组件：加载 / 选中 / 参数默认值 / 150ms 防抖预览 ────────────
  useEffect(() => {
    let cancelled = false;
    setWidgetNotice(null);
    if (!project) {
      setWidgets([]);
      setWidgetWarn([]);
      setWidgetFileError(null);
      setActiveWidgetId(null);
      return;
    }
    api
      .serialWidgets(project)
      .then((r) => {
        if (cancelled) return;
        setWidgets(r.widgets ?? []);
        setWidgetWarn(r.warnings ?? []);
        setWidgetFileError(r.error ?? null);
      })
      .catch((e) => {
        if (cancelled) return;
        setWidgets([]);
        setWidgetWarn([]);
        setWidgetFileError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  useEffect(() => {
    if (activeWidgetId && !widgets.some((w) => w.id === activeWidgetId)) {
      setActiveWidgetId(null);
    }
  }, [widgets, activeWidgetId]);

  useEffect(() => {
    if (!activeWidget) return;
    setWidgetParams(widgetDefaults(activeWidget));
    setWidgetPreview(null);
    setWidgetErr(null);
  }, [activeWidget]);

  useEffect(() => {
    if (!project || !activeWidget) {
      setWidgetPreview(null);
      setWidgetErr(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .serialWidgetRun({
          project,
          id: activeWidget.id,
          params: widgetParams,
          dryRun: true,
        })
        .then((r) => {
          if (cancelled) return;
          if (!r.ok) {
            setWidgetErr(r.error ?? "预览失败");
            setWidgetPreview(null);
            return;
          }
          setWidgetErr(null);
          setWidgetPreview(r);
        })
        .catch((e) => {
          if (cancelled) return;
          setWidgetErr(e instanceof Error ? e.message : String(e));
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [project, activeWidget, widgetParams]);

  const widgetJobRunning = widgetJobActive(widgetJob);

  /** 刷新页面/换工程后找回仍在跑的任务（run 只等 2s，长任务只能靠轮询）。 */
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    api
      .serialWidgetJob()
      .then((j) => {
        if (cancelled || !widgetJobActive(j) || !j.job_id) return;
        setWidgetJob(j);
        setWidgetJobId(j.job_id);
        setWidgetBusy(true);
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
    if (!widgetJobId) return;
    let cancelled = false;
    let timer = 0;
    const tick = async (): Promise<void> => {
      try {
        const j = await api.serialWidgetJob(widgetJobId);
        if (cancelled) return;
        setWidgetJob(j);
        if (widgetJobActive(j)) {
          timer = window.setTimeout(() => void tick(), 400);
          return;
        }
        setWidgetBusy(false);
        setWidgetNotice(
          j.ok
            ? `✓ 组件任务结束：${j.rounds ?? 0} 轮 · ${j.total_bytes ?? 0} B` +
              ((j.skipped ?? 0) > 0 ? ` · 跳过 ${j.skipped} 拍` : "")
            : `✗ 组件任务失败：${j.error ?? "未知原因"}`,
        );
      } catch (e) {
        if (cancelled) return;
        setWidgetBusy(false);
        setWidgetNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [widgetJobId]);

  const doWidgetRun = useCallback(
    async (repeat: boolean) => {
      if (!project || !activeWidget || running || widgetBusy || widgetJobRunning) return;
      if (
        activeWidget.confirm &&
        !window.confirm(`发送组件「${activeWidget.label}」？该组件被标记为需要确认。`)
      ) {
        return;
      }
      setWidgetNotice(null);
      setWidgetBusy(true);
      try {
        const r = await api.serialWidgetRun({
          project,
          id: activeWidget.id,
          params: widgetParams,
          repeat,
          confirm: activeWidget.confirm === true,
        });
        setWidgetJob(r);
        if (r.job_id) setWidgetJobId(r.job_id);
        if (widgetJobActive(r)) {
          setWidgetNotice(
            `✓ 已启动${r.repeat ? "周期" : ""}任务 —— 波形区会持续刷新，可暂停/停止`,
          );
          return;
        }
        setWidgetBusy(false);
        if (!r.ok) {
          setWidgetNotice(`✗ 组件发送失败：${r.error ?? "未知原因"}`);
          return;
        }
        setWidgetNotice(
          `✓ 组件「${activeWidget.label}」已发送 ${r.total_bytes ?? 0} B` +
            (r.via === "monitor" ? "（经监视会话，回显见实时流）" : ""),
        );
      } catch (e) {
        setWidgetBusy(false);
        setWidgetNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [project, activeWidget, running, widgetBusy, widgetJobRunning, widgetParams],
  );

  const doWidgetCancel = useCallback(async () => {
    const id = widgetJob?.job_id || widgetJobId;
    if (!id) return;
    try {
      await api.serialWidgetCancel(id);
      setWidgetJob(await api.serialWidgetJob(id));
    } catch (e) {
      setWidgetNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [widgetJob, widgetJobId]);

  const doWidgetPause = useCallback(async () => {
    const id = widgetJob?.job_id || widgetJobId;
    if (!id) return;
    const paused = widgetJob?.state !== "paused";
    try {
      await api.serialWidgetPause(id, paused);
      setWidgetJob(await api.serialWidgetJob(id));
    } catch (e) {
      setWidgetNotice(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [widgetJob, widgetJobId]);

  const widgetPreviewHex = useMemo(
    () => widgetHex(widgetPreview?.preview_b64),
    [widgetPreview],
  );

  /** 任务进度：轮次 / 跳过节拍 / 累计字节（周期任务的主要可观测面）。 */
  const widgetProgress = useMemo(() => {
    const j = widgetJob;
    if (!j || j.state === undefined) return "";
    const rounds = j.rounds ?? 0;
    const skipped = j.skipped ?? 0;
    const bytes = j.total_bytes ?? 0;
    if (widgetJobActive(j)) {
      const label = j.state === "paused" ? "已暂停" : j.state === "cancelling" ? "停止中…" : "运行中";
      return `${label} · 第 ${rounds} 轮${skipped > 0 ? ` · 跳过 ${skipped} 拍` : ""} · ${bytes} B`;
    }
    if (j.state === "done") {
      return `完成 · ${rounds} 轮 · ${bytes} B${skipped > 0 ? ` · 跳过 ${skipped} 拍` : ""}`;
    }
    if (j.state === "cancelled") return `已停止 · ${bytes} B`;
    if (j.state === "failed") return `失败${j.error ? ` · ${j.error}` : ""}`;
    return "";
  }, [widgetJob]);

  const decoders = caps?.meta?.serial?.decoders ?? [
    { id: "justfloat", label: "JustFloat", channels: "auto" as const },
    { id: "firewater", label: "FireWater", channels: "auto" as const },
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
  const [frames, setFrames] = useState<number[][]>([]);
  const [decodeMeta, setDecodeMeta] = useState<{
    channels: number;
    skipped: number;
    pending: number;
  } | null>(null);
  const [waveErr, setWaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (view !== "wave") return;
    if (!filtered.length) {
      setFrames([]);
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
      .serialDecode({ decoder, dataB64: bytesToB64(bytes) })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) {
          setWaveErr(r.error ?? "解码失败");
          setFrames([]);
          return;
        }
        setWaveErr(null);
        setFrames(r.frames);
        setDecodeMeta({
          channels: r.channels,
          skipped: r.skipped,
          pending: r.pending_bytes,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setWaveErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [view, filtered, decoder]);

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
    const totalCh = decodeMeta?.channels ?? (frames[0]?.length ?? 0);
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

  const remember = useCallback((text: string): void => {
    setHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === text) return prev;
      const next = [...prev, text].slice(-HISTORY_MAX);
      saveHistory(next);
      return next;
    });
    setHistIdx(-1);
  }, []);

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
            (r.via === "monitor" ? "（经监视会话，回显见实时流）" : ""),
        );
        remember(draft);
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
        setDraft(history[next]);
        return;
      }
      if (histIdx === -1) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setDraft("");
      } else {
        setHistIdx(next);
        setDraft(history[next]);
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

  return (
    <div className={s.wrap}>
      <div className={s.toolbar}>
        <SegmentedTabs
          tabs={VIEW_TABS.map((t) => ({ id: t.id, label: t.label }))}
          value={view}
          onChange={setView}
          size="sm"
        />
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
            onChange={(e) => setDecoder(e.currentTarget.value)}
            aria-label="协议解码器"
            title={decoders.find((d) => d.id === decoder)?.desc ?? "协议解码器"}
          >
            {decoders.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
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
        <Switch id="serial-follow" checked={autoScroll} onChange={setFollowAll} label="跟随" />
        <span className={s.meta} title="当前缓冲：未清空、未被环形挤出的字节 / 批次">
          {bytes} B · {chunks} 批
        </span>
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

      {stream.error ? (
        <div className={s.warn} role="alert">
          监视已中断：{stream.error}（服务端已释放串口）
        </div>
      ) : null}
      {stream.paused ? (
        <div className={s.info}>已暂停入环 —— 服务端仍在读口；点「继续」恢复。</div>
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

            {decodeMeta ? (
              <div className={s.waveMeta}>
                {frames.length} 帧 · {decodeMeta.channels} 通道
                {decodeMeta.skipped ? ` · 跳过 ${decodeMeta.skipped}` : ""}
                {decodeMeta.pending ? ` · 半帧 ${decodeMeta.pending} B（下一轮续解）` : ""}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ── 自定义发送组件（M1）：chips + 参数 + 服务端预览 ── */}
      {project && (widgets.length > 0 || widgetWarn.length > 0 || widgetFileError) ? (
        <div className={s.widgetBar}>
          <span className={s.widgetTitle}>组件</span>
          {widgets.map((w) => (
            <button
              key={w.id}
              type="button"
              className={activeWidgetId === w.id ? s.widgetChipOn : s.widgetChip}
              title={`${w.label} · ${w.steps.length} 步${w.group ? ` · ${w.group}` : ""}`}
              onClick={() =>
                setActiveWidgetId(activeWidgetId === w.id ? null : w.id)
              }
            >
              {w.label}
            </button>
          ))}
          {widgetFileError ? (
            <span className={s.widgetErr}>✗ {widgetFileError}</span>
          ) : null}
          {widgetWarn.length > 0 ? (
            <span className={s.widgetErr} title={widgetWarn.join("\n")}>
              ⚠ {widgetWarn.length} 处配置问题
            </span>
          ) : null}
          <span className={s.spacer} />
        </div>
      ) : null}

      {activeWidget ? (
        <div className={s.widgetPanel}>
          {(activeWidget.params ?? []).length === 0 ? (
            <span className={s.meta}>无参数</span>
          ) : (
            (activeWidget.params ?? []).map((p) => (
              <label key={p.name} className={s.widgetField}>
                <span>{p.label ?? p.name}</span>
                {p.type === "bool" ? (
                  <Switch
                    id={`widget-${activeWidget.id}-${p.name}`}
                    checked={Boolean(widgetParams[p.name])}
                    onChange={(v) =>
                      setWidgetParams((prev) => ({ ...prev, [p.name]: v }))
                    }
                  />
                ) : p.type === "enum" ? (
                  <select
                    className={s.select}
                    value={String(widgetParams[p.name] ?? "")}
                    onChange={(e) =>
                      setWidgetParams((prev) => ({
                        ...prev,
                        [p.name]: e.currentTarget.value,
                      }))
                    }
                  >
                    {(p.options ?? []).map((o) => {
                      const x = widgetOption(o);
                      return (
                        <option key={x.value} value={x.value}>
                          {x.label}
                        </option>
                      );
                    })}
                  </select>
                ) : (
                  <Input
                    mono
                    size="sm"
                    className={s.widgetInput}
                    value={String(widgetParams[p.name] ?? "")}
                    placeholder={widgetParamHint(p)}
                    onChange={(e) =>
                      setWidgetParams((prev) => ({
                        ...prev,
                        [p.name]: e.currentTarget.value,
                      }))
                    }
                  />
                )}
              </label>
            ))
          )}
          <span className={s.widgetPreview} title={widgetErr ?? widgetPreviewHex}>
            {widgetErr
              ? `✗ ${widgetErr}`
              : widgetPreview
                ? `预览 ${widgetPreview.bytes ?? 0} B · ${widgetPreviewHex}`
                : "预览中…"}
          </span>
          {widgetProgress ? (
            <span className={s.widgetPreview} title={widgetProgress}>
              {widgetProgress}
            </span>
          ) : null}
          <span className={s.spacer} />
          {activeWidget.repeat ? (
            <Button
              size="sm"
              variant="outline"
              type="button"
              title={`周期发送：每 ${activeWidget.repeat.interval_ms} ms 一轮${
                activeWidget.repeat.count
                  ? `，共 ${activeWidget.repeat.count} 轮`
                  : "，直到手动停止"
              }`}
              disabled={running || widgetBusy || !!widgetErr || widgetJobRunning}
              onClick={() => void doWidgetRun(true)}
            >
              ↻ 周期
            </Button>
          ) : null}
          {widgetJobRunning ? (
            <>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => void doWidgetPause()}
              >
                {widgetJob?.state === "paused" ? "▶ 继续任务" : "❚❚ 暂停任务"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                type="button"
                onClick={() => void doWidgetCancel()}
              >
                ■ 停止任务
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            type="button"
            disabled={running || widgetBusy || !!widgetErr || widgetJobRunning}
            onClick={() => void doWidgetRun(false)}
          >
            {widgetBusy ? "执行中…" : "▶ 发送"}
          </Button>
        </div>
      ) : null}

      {widgetNotice ? (
        <div
          className={widgetNotice.startsWith("✗") ? s.warn : s.info}
          role="status"
        >
          {widgetNotice}
        </div>
      ) : null}

      {/* ── 发送面板：与监视会话同一个口（写穿，不重开）── */}
      <form className={s.write} onSubmit={(e) => void doSend(e)}>
        <IconTerminal className={s.writeIcon} />
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
          disabled={sendFormat === "hex"}
          title={sendFormat === "hex" ? "HEX 模式不追加行尾（二进制帧多一个字节就是错）" : "追加的行结束符"}
        >
          {EOLS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <Input
          mono
          placeholder={
            running
              ? "有 run 在跑：串口与 run 互斥（约束 N5），等它结束"
              : sendFormat === "hex"
                ? "输入十六进制，如 01 A0 FF"
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
        <Button size="sm" variant="primary" type="submit" disabled={running || !draft.trim()}>
          发送
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
      </form>

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
  frames: number[][];
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

function WaveChart({ frames, channels, scaleX, offsetX, onView, follow, onFollowChange }: WaveChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ startClientX: number; startOffset: number } | null>(null);
  const dragActive = useRef(false);
  // ── 取消跟随 = 定格画面 ──────────────────────────────────────
  // 波形是"最近 N 字节"的滚动解码窗口：只钉住 offsetX 没用 —— 窗口本身
  // 在滑，同一个 index 已经对应到新数据，曲线看起来就一直在走。
  // 所以 follow=false 时留下**这一刻的帧快照**，恢复跟随才换回实时帧。
  const [frozen, setFrozen] = useState<number[][] | null>(null);
  useEffect(() => {
    if (frames.length === 0) {
      setFrozen(null);
      return;
    }
    if (follow) {
      setFrozen(null);
      return;
    }
    setFrozen((cur) => cur ?? frames);
  }, [follow, frames]);
  const shown = follow ? frames : (frozen ?? frames);

  const frameChannels = shown[0]?.length ?? 0;
  const shownCh = resolvedChannels(channels, frameChannels);

  // ── 当 frames 更新时自动 follow 到尾 ──────────────────────────
  const lastFramesLen = useRef(0);
  useEffect(() => {
    if (shown.length === 0) {
      onView(scaleX, 0);
      return;
    }
    const prev = lastFramesLen.current;
    lastFramesLen.current = shown.length;
    // 只有在 follow=true 且帧增加时才跳；帧清空（clear）也跳回 0
    if (follow) {
      // 缩放后一屏可见的帧数
      const canvas = canvasRef.current;
      const w = canvas?.clientWidth ?? 480;
      const visible = Math.max(20, Math.ceil(w / scaleX));
      const maxOffset = Math.max(0, shown.length - visible);
      onView(scaleX, maxOffset);
    } else if (shown.length > 0 && prev === 0) {
      // 从空变成有帧，且 follow=false —— 保持 offsetX 合法
      const canvas = canvasRef.current;
      const w = canvas?.clientWidth ?? 480;
      const visible = Math.max(20, Math.ceil(w / scaleX));
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
    const visibleCount = Math.max(2, Math.round(plotW / scaleX));
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

    // ── 通道折线（各通道独立归一化） ──
    for (const ch of shownCh) {
      const values = slice.map((f) => (ch < f.length ? f[ch] : NaN));
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of values) {
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      if (hi === lo) { hi = lo + 1; lo -= 1; }
      ctx.strokeStyle = palette[ch % palette.length];
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) { started = false; continue; }
        const x = xOf(i);
        const y = plotBottom - ((values[i] - lo) / (hi - lo)) * plotH;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // ── 顶部左右标签：起始帧 / 总帧 + 缩放 ──
    ctx.fillStyle = axisLabel;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(`帧 ${startIdx} → ${endIdx - 1}`, padL, 2);
    ctx.textAlign = "right";
    ctx.fillText(`共 ${shown.length} 帧 · 窗口 ${endIdx - startIdx} · ×${scaleX.toFixed(1)}`, w - padR, 2);
  }, [shown, scaleX, offsetX, shownCh]);

  // ── 交互事件 ──────────────────────────────────────────────────
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const xInCanvas = e.clientX - rect.left;
    const padL = 8;
    const plotW = rect.width - padL - 8;
    const frameAtCursor = Math.round(offsetX + Math.max(0, xInCanvas - padL) / scaleX);
    // zoom
    const newScale = Math.min(20, Math.max(1, e.deltaY < 0 ? scaleX * 1.2 : scaleX / 1.2));
    const visibleCount = Math.max(2, Math.round(plotW / newScale));
    let newOffset = frameAtCursor - Math.round((xInCanvas - padL) / newScale);
    newOffset = Math.max(0, Math.min(newOffset, Math.max(0, shown.length - visibleCount)));
    onView(newScale, newOffset);
    if (follow) onFollowChange(false);
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = { startClientX: e.clientX, startOffset: offsetX };
    dragActive.current = true;
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
    const offsetDelta = Math.round(-dx / scaleX);
    const visibleCount = Math.max(2, Math.round(plotW / scaleX));
    let newOffset = dragRef.current.startOffset + offsetDelta;
    newOffset = Math.max(0, Math.min(newOffset, Math.max(0, shown.length - visibleCount)));
    if (newOffset !== dragRef.current.startOffset) onView(scaleX, newOffset);
    if (follow) onFollowChange(false);
  };
  const endDrag = () => { dragActive.current = false; dragRef.current = null; };

  const canvasReady = shown.length > 0;

  return (
    <div className={s.waveBox}>
      {/* 顶部工具栏：通道图例 + 缩放按钮 + 跟随 */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <div className={s.legend} style={{ flex: "1 1 auto" }}>
          {shownCh.map((ch) => (
            <span key={ch} className={s.legendItem}>
              <span className={s.swatch} style={{ background: `var(--elab-ansi-${WAVE_PALETTE[ch % 8][0]})` }} />
              CH{ch}
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

      <canvas
        ref={canvasRef}
        className={s.canvas}
        style={{ cursor: canvasReady ? (dragActive.current ? "grabbing" : "grab") : "default" }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      />
    </div>
  );
}
