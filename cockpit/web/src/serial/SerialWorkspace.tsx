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
import type { Capabilities, SerialChunk, SerialFormat } from "../api/types";
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{
    key: string;
    lastSeq: number;
    term: AnsiTerminal;
    dec: StreamTextDecoder;
  } | null>(null);

  const epoch = stream.snap?.epoch ?? 0;

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
        <Switch id="serial-follow" checked={autoScroll} onChange={setAutoScroll} label="跟随" />
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
            {frames.length > 0 ? (
              <WaveChart frames={frames} channels={decodeMeta?.channels ?? frames[0].length} />
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

/** Canvas 多通道折线：每通道独立归一化（同一屏里量纲不同也能看清形状） */
function WaveChart({ frames, channels }: { frames: number[][]; channels: number }) {
  const hostRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = hostRef.current;
    if (!canvas || frames.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 480;
    const h = canvas.clientHeight || 200;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(canvas);
    const cvar = (name: string) => css.getPropertyValue(name).trim();
    const border = cvar("--elab-border") || "rgba(128,128,128,0.3)";
    const palette = [
      "--elab-ansi-bright-blue",
      "--elab-ansi-bright-green",
      "--elab-ansi-bright-red",
      "--elab-ansi-bright-yellow",
      "--elab-ansi-bright-magenta",
      "--elab-ansi-bright-cyan",
      "--elab-ansi-blue",
      "--elab-ansi-green",
    ];
    const colors = palette.map((p, i) => cvar(p) || ["#4ea1ff", "#4c9a2a", "#e24b4a", "#b3701a", "#b060cc", "#0891b2"][i % 6]);

    // 网格
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const n = frames.length;
    for (let ch = 0; ch < channels; ch++) {
      const values = frames.map((f) => (ch < f.length ? f[ch] : 0));
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of values) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      if (hi === lo) {
        hi = lo + 1;
        lo -= 1;
      }
      ctx.strokeStyle = colors[ch % colors.length];
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
        const y = h - ((values[i] - lo) / (hi - lo)) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, [frames, channels]);

  return (
    <div className={s.waveBox}>
      <canvas ref={hostRef} className={s.canvas} />
      <div className={s.legend}>
        {Array.from({ length: Math.max(0, channels) }, (_, i) => (
          <span key={i} className={s.legendItem}>
            <span
              className={s.swatch}
              style={{
                background: `var(--elab-ansi-${
                  ["bright-blue", "bright-green", "bright-red", "bright-yellow", "bright-magenta", "bright-cyan", "blue", "green"][i % 8]
                })`,
              }}
            />
            CH{i}
          </span>
        ))}
      </div>
    </div>
  );
}
