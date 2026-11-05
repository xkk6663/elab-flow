/**
 * 独立 WebUI 调试工作区（P1–P3）。
 *
 * 数据面只走 loopback HTTP ICD（`/api/debug/*`），**不** import 内核源码（分层门禁）。
 *
 * P3 结构（执行计划_调试P3 §6.4）：
 * - `DebugWorkspace` = **会话壳**：会话条（项目·状态·owner）、开/关、单列/并排；
 * - `DebugSessionPane` = **单个会话**：只认 `debugSession`（会话 id），自己拉数、自己订阅 SSE；
 * - 多会话只允许跨工程/跨探针（同工程内核直接 409 `debug-target-busy`）。
 *
 * 其余设计要点不变：
 * - 页签按会话 `features` 白名单渲染 —— 内核没声明/目标不支持的能力不出现；
 * - 数据只在**新的 stop_seq** 拉取，避免暂停时反复打 gdb；
 * - SSE 用命名事件，必须逐 topic `addEventListener`；
 * - 写内存/寄存器/寄存器组默认拒绝（需会话 allow_write），并在 UI 明示会进审计。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Capabilities,
  DebugAuditRecord,
  DebugBreakpoint,
  DebugControlResponse,
  DebugDisasmLine,
  DebugDisasmResponse,
  DebugMemoryResponse,
  DebugPeripheralsResponse,
  DebugRegGroup,
  DebugRtosResponse,
  DebugSessionSnapshot,
  DebugSourceResponse,
  DebugStackFrame,
  DebugVarNode,
  DebugWatchItem,
} from "../api/types";
import { api } from "../api/client";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import s from "./DebugWorkspace.module.css";

export interface DebugWorkspaceProps {
  caps: Capabilities | null;
  /** 当前选中工程（open 会话用） */
  project: string;
  /** 有 run 在跑时调试与 run 互斥 */
  running: boolean;
  /** 项目级调试页签白名单（按芯片收敛；打开会话后以 snapshot.features 为准） */
  debugFeatures?: string[];
}

type TabId = "stack" | "vars" | "regs" | "bps" | "watch" | "src" | "memory"
  | "disasm" | "svd" | "rtos" | "audit" | "out";

const TABS: Array<{ id: TabId; label: string; feature?: string }> = [
  { id: "stack", label: "调用栈", feature: "stack" },
  { id: "vars", label: "变量", feature: "variables" },
  { id: "regs", label: "寄存器", feature: "registers" },
  { id: "bps", label: "断点", feature: "breakpoints" },
  { id: "watch", label: "监视", feature: "watch" },
  // 源码插在「内存」前（§5.3）：断点与单步的主战场，别让用户翻找
  { id: "src", label: "源码", feature: "source" },
  { id: "memory", label: "内存", feature: "memory" },
  { id: "disasm", label: "反汇编", feature: "disasm" },
  { id: "svd", label: "外设", feature: "svd" },
  { id: "rtos", label: "RTOS 栈", feature: "rtos" },
  { id: "audit", label: "审计" },
  { id: "out", label: "输出" },
];

function msg(e: unknown): string {
  // 内核的 hint 常常是唯一能定位现场的一句（如 CMSIS-DAP 握手不符），别丢
  const base = e instanceof Error ? e.message : String(e);
  const hint = (e as { hint?: unknown } | null)?.hint;
  return typeof hint === "string" && hint !== "" ? `${base}（${hint}）` : base;
}

function hexBytes(bytes: string): string[] {
  return bytes.trim() === "" ? [] : bytes.trim().split(/\s+/);
}

/** 16 字节一行：地址 + HEX + ASCII（与 cortex-debug 内存视图同构）。 */
function rowDump(addr: string, bytes: string[]):
Array<{ addr: string; bytes: string[]; hex: string; ascii: string }> {
  const base = Number.parseInt(addr, 16);
  const rows: Array<{ addr: string; bytes: string[]; hex: string; ascii: string }> = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    rows.push({
      addr: `0x${(base + i).toString(16).padStart(8, "0")}`,
      bytes: chunk,
      hex: chunk.join(" ").padEnd(47, " "),
      ascii: chunk.map((b) => {
        const n = Number.parseInt(b, 16);
        return n >= 32 && n < 127 ? String.fromCharCode(n) : ".";
      }).join(""),
    });
  }
  return rows;
}

/** 单元格地址：行首地址 + 单元格序号（HEX）。 */
function cellAddr(rowAddr: string, index: number): string {
  const base = Number.parseInt(rowAddr, 16);
  return `0x${(base + index).toString(16).padStart(8, "0")}`;
}

/** 1 字节 HEX 校验：接受 1–2 位，补零后返回小写两字符。 */
function normByte(raw: string): string | null {
  const v = raw.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,2}$/.test(v)) return null;
  return v.padStart(2, "0").toLowerCase();
}

/** 寄存器值规范化：去 0x、补零到 width/4 位（32 位 = 8 位 HEX）。 */
function normRegValue(raw: string, width = 32): string | null {
  let v = raw.trim();
  if (v.toLowerCase().startsWith("0x")) v = v.slice(2);
  const digits = width / 4;
  if (!new RegExp(`^[0-9a-fA-F]{1,${digits}}$`).test(v)) return null;
  return v.padStart(digits, "0").toLowerCase();
}

// ══════════════════════════════════════════════════════════════
//  会话壳
// ══════════════════════════════════════════════════════════════
export function DebugWorkspace({ caps, project, running, debugFeatures }: DebugWorkspaceProps) {
  const [sessions, setSessions] = useState<DebugSessionSnapshot[]>([]);
  const [activeId, setActiveId] = useState("");
  const [maxSessions, setMaxSessions] = useState(2);
  const [split, setSplit] = useState(false);
  const [stopAt, setStopAt] = useState<"main" | "reset" | "none">("main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outLines, setOutLines] = useState<string[]>([]);
  /** 并排时右列固定显示“第二条会话”，即使当前激活的是别的 */
  const [secondaryId, setSecondaryId] = useState("");

  const pushOut = useCallback((text: string) => {
    setOutLines((prev) => [...prev.slice(-249), `${new Date().toLocaleTimeString()}  ${text}`]);
  }, []);

  const refresh = useCallback(async () => {
    const r = await api.debugSession();
    const list = r.sessions ?? (r.session ? [r.session] : []);
    setSessions(list);
    setMaxSessions(r.max_sessions ?? 2);
    setActiveId((prev) => {
      if (prev && list.some((x) => x.id === prev)) return prev;
      return list[0]?.id ?? "";
    });
    setSecondaryId((prev) => {
      const rest = list.filter((x) => x.id !== (activeId || list[0]?.id));
      if (prev && rest.some((x) => x.id === prev)) return prev;
      return rest[0]?.id ?? "";
    });
  }, [activeId]);

  // 壳层 SSE：只用来同步会话清单（每个 pane 有自己的过滤流）
  useEffect(() => {
    void refresh().catch((e) => setError(msg(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ★ 无会话不建 SSE（盘点 #5）：壳层流只服务于"会话状态变化时刷新清单"，
  //   没开会话时它一个事件也收不到，纯属白占全局名额（上限见 server.py 的
  //   MAX_SSE_CONNS）。多标签页场景下每个空面板都占 1 条，会加速把名额吃满，
  //   让真正需要的流收到 503。首次清单已在上面 refresh 拉过；这里有会话才建流，
  //   会话全关时自动拆掉。
  const hasSessions = sessions.length > 0;
  useEffect(() => {
    if (!hasSessions) return;
    const es = new EventSource("/api/debug/events");
    const bump = () => void refresh().catch(() => undefined);
    for (const topic of ["debug/stop", "debug/state", "debug/closed", "debug/error"]) {
      es.addEventListener(topic, bump);
    }
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSessions]);

  const openSession = async () => {
    if (!project) {
      setError("先在左侧选一个工程");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api.debugOpen({
        project,
        options: { stop_at: stopAt, load: true },
        lease_s: 600,
        allow_write: true,
        actor: "human",
      });
      pushOut(`会话已建立：${r.session?.id ?? ""}（${project}，stop_at=${stopAt}）`);
      await refresh();
      if (r.session?.id) setActiveId(r.session.id);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const closeSession = async (id: string, resume = true) => {
    setBusy(true);
    try {
      await api.debugClose(resume, id);
      pushOut(`会话已关闭：${id}（resume=${resume}）`);
      await refresh();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const active = sessions.find((x) => x.id === activeId) ?? null;
  const secondary = sessions.find((x) => x.id === secondaryId) ?? null;
  const headerWide = useIsWide(1000);
  const dual = split && sessions.length >= 2 && secondary !== null && headerWide;

  return (
    <div className={s.wrap}>
      {/* ── 会话条（P3）：项目 · 状态 · owner · ×；满员后 ＋ 变灰 ── */}
      {sessions.length > 0 ? (
        <div className={s.sessionBar}>
          {sessions.map((x) => (
            <span key={x.id}
              className={`${s.sessionChip} ${x.id === activeId ? s.sessionChipActive : ""}`}>
              <button type="button" className={s.sessionPick}
                onClick={() => setActiveId(x.id)}
                title={`${x.id} · ${x.project} · ${x.state}`}>
                <span className={s.dot} data-state={x.state} />
                <b>{x.project}</b>
                <span className={s.dimText}>{x.owner}</span>
              </button>
              <button type="button" className={s.sessionClose}
                title="关闭这个会话（不影响其它会话）"
                onClick={() => void closeSession(x.id, true)}>×</button>
            </span>
          ))}
          <span className={s.spacer} />
          {sessions.length >= 2 ? (
            <Button size="sm" variant="outline" onClick={() => setSplit((v) => !v)}>
              {split ? "单列" : "并排"}
            </Button>
          ) : null}
          <span className={s.dimText}>{sessions.length}/{maxSessions} 会话</span>
        </div>
      ) : null}

      <div className={s.toolbar}>
        <select
          className={s.select}
          value={stopAt}
          onChange={(e) => setStopAt(e.currentTarget.value as typeof stopAt)}
          aria-label="停止位置"
        >
          <option value="main">停在 main</option>
          <option value="reset">停在复位向量</option>
          <option value="none">下载后直接运行</option>
        </select>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || running || !project || !caps?.meta?.debug?.available
            || sessions.length >= maxSessions}
          onClick={() => void openSession()}
        >
          {sessions.length === 0 ? "开始调试" : "新会话"}
        </Button>
        {!project ? <span className={s.hint}>先在左侧选工程</span> : null}
        {running ? <span className={s.hint}>有 run 在跑：串口/SWD 互斥</span> : null}
        {sessions.length >= maxSessions
          ? <span className={s.hint}>已达会话上限（elab.host.yaml: debug.max_sessions）</span>
          : null}
      </div>

      {error ? <div className={s.error}>{error}</div> : null}

      {sessions.length === 0 ? (
        <div className={s.empty}>
          <div>
            <b>调试工作区</b>
            <p>{caps?.meta?.debug?.available
              ? "建立会话会复位目标、下载 ELF 并停在所选位置。同一工程只能开一条会话。"
              : "内核未提供调试能力（meta.debug 缺失）：请同步内核后重载。"}</p>
            {outLines.length > 0 ? <pre className={s.pre}>{outLines.join("\n")}</pre> : null}
          </div>
        </div>
      ) : (
        <div className={s.panes} data-dual={dual ? "1" : "0"}>
          {active ? (
            <DebugSessionPane
              key={active.id}
              session={active}
              debugFeatures={debugFeatures}
              onError={setError}
              onChanged={() => void refresh().catch(() => undefined)}
              onLog={pushOut}
            />
          ) : null}
          {dual && secondary && secondary.id !== active?.id ? (
            <DebugSessionPane
              key={secondary.id}
              session={secondary}
              debugFeatures={debugFeatures}
              onError={setError}
              onChanged={() => void refresh().catch(() => undefined)}
              onLog={pushOut}
              compact
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 容器宽度观察（并排阈值 1000 px：窄栏两列都不可读 —— D5）。 */
function useIsWide(threshold: number): boolean {
  const [wide, setWide] = useState(
    typeof window === "undefined" ? true : window.innerWidth >= threshold,
  );
  useEffect(() => {
    const el = document.documentElement;
    const check = () => setWide(el.clientWidth >= threshold);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [threshold]);
  return wide;
}

// ══════════════════════════════════════════════════════════════
//  单个会话 pane
// ══════════════════════════════════════════════════════════════
interface PaneProps {
  session: DebugSessionSnapshot;
  debugFeatures?: string[];
  compact?: boolean;
  onError: (text: string) => void;
  onChanged: () => void;
  onLog: (text: string) => void;
}

function DebugSessionPane({
  session, debugFeatures, compact, onError, onChanged, onLog,
}: PaneProps) {
  const sid = session.id;
  const [snap, setSnap] = useState<DebugSessionSnapshot>(session);
  const [tab, setTab] = useState<TabId>("stack");
  const [stopSeq, setStopSeq] = useState(-1);
  const [busy, setBusy] = useState(false);

  // 各页签数据
  const [frames, setFrames] = useState<DebugStackFrame[]>([]);
  const [frame, setFrame] = useState(0);
  const [vars, setVars] = useState<DebugVarNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, DebugVarNode[]>>({});
  const [regGroup, setRegGroup] = useState<string>("all");
  const [regs, setRegs] = useState<DebugRegGroup[]>([]);
  /** 本组草稿：改了但没提交的寄存器值（名 → HEX 串） */
  const [regDraft, setRegDraft] = useState<Record<string, string>>({});
  const [bps, setBps] = useState<DebugBreakpoint[]>([]);
  const [rev, setRev] = useState(0);
  const [bpLoc, setBpLoc] = useState("");
  const [watch, setWatch] = useState<DebugWatchItem[]>([]);
  const [watchExpr, setWatchExpr] = useState("");
  const [memAddr, setMemAddr] = useState("0x20000000");
  const [memCount, setMemCount] = useState(64);
  const [mem, setMem] = useState<DebugMemoryResponse | null>(null);
  const [disasmAddr, setDisasmAddr] = useState("");
  const [disasm, setDisasm] = useState<DebugDisasmResponse | null>(null);
  const [svd, setSvd] = useState<DebugPeripheralsResponse | null>(null);
  const [rtos, setRtos] = useState<DebugRtosResponse | null>(null);
  const [audit, setAudit] = useState<DebugAuditRecord[]>([]);
  const [outLines, setOutLines] = useState<string[]>([]);

  // 源码页签（P3-A）
  const [src, setSrc] = useState<DebugSourceResponse | null>(null);
  const [srcStart, setSrcStart] = useState(1);
  const [srcPick, setSrcPick] = useState(0);
  const [srcErr, setSrcErr] = useState("");
  const srcStopRef = useRef<HTMLDivElement | null>(null);

  // 写权限来自会话（/breakpoints 的 allow_write），不是内核能力位
  const [allowWrite, setAllowWrite] = useState(false);
  const [editCell, setEditCell] = useState<{ addr: string; value: string; orig: string } | null>(null);
  const [editReg, setEditReg] = useState<{ name: string; value: string; orig: string } | null>(null);
  const [editField, setEditField] = useState<{
    reg: string; addr: string; size: number; base: number;
    offset: number; width: number; value: string;
  } | null>(null);
  const [svdQuery, setSvdQuery] = useState("");
  const [svdCollapsed, setSvdCollapsed] = useState<Record<string, boolean>>({});
  const [bpToast, setBpToast] = useState("");

  const disasmRef = useRef<HTMLDivElement | null>(null);
  const pcRef = useRef<HTMLDivElement | null>(null);

  const pushOut = useCallback((text: string) => {
    setOutLines((prev) => [...prev.slice(-249), `${new Date().toLocaleTimeString()}  ${text}`]);
    onLog(`[${session.project}] ${text}`);
  }, [onLog, session.project]);

  const setSession = useCallback((next: DebugSessionSnapshot | null) => {
    if (next) setSnap(next);
    setStopSeq(next?.stop?.seq ?? -1);
  }, []);

  const loadBreakpoints = useCallback(async () => {
    const x = await api.debugBreakpoints({ debugSession: sid });
    setBps(x.breakpoints);
    setRev(x.rev ?? 0);
    setAllowWrite(x.allow_write === true);
  }, [sid]);

  const refreshCommon = useCallback(async () => {
    const r = await api.debugSession(sid);
    const sess = r.session;
    if (!sess) return;
    setSession(sess);
    const jobs: Array<Promise<unknown>> = [loadBreakpoints().catch(() => undefined)];
    if (sess.state === "stopped") {
      jobs.push(api.debugStack({ debugSession: sid }).then((x) => setFrames(x.frames))
        .catch(() => undefined));
      jobs.push(api.debugRegisters({ group: "all", debugSession: sid })
        .then((x) => setRegs(x.groups)).catch(() => undefined));
      jobs.push(api.debugWatch({ debugSession: sid }).then((x) => setWatch(x.watches))
        .catch(() => undefined));
      if (sess.features.includes("rtos")) {
        jobs.push(api.debugRtos({ debugSession: sid }).then((x) => setRtos(x)).catch(() => setRtos(null)));
      }
    }
    await Promise.allSettled(jobs);
  }, [sid, loadBreakpoints, setSession]);

  const loadSource = useCallback(async (file?: string, start?: number) => {
    setSrcErr("");
    try {
      const r = await api.debugSource({
        file, start: start ?? srcStart, count: 160, debugSession: sid,
      });
      setSrc(r);
      setSrcStart(r.start);
      if (r.stop_line) setSrcPick(r.stop_line);
    } catch (e) {
      setSrc(null);
      setSrcErr(msg(e));
    }
  }, [sid, srcStart]);

  const loadVars = useCallback(async (idx = frame) => {
    try {
      const r = await api.debugVariables({ frame: idx, scope: "locals", debugSession: sid });
      setVars(r.nodes);
      setExpanded({});
    } catch (e) {
      setVars([]);
      onError(msg(e));
    }
  }, [frame, sid, onError]);

  const loadMemory = useCallback(async (addr = memAddr, count = memCount) => {
    try {
      setMem(await api.debugMemory({ addr, count, debugSession: sid }));
    } catch (e) {
      onError(msg(e));
    }
  }, [memAddr, memCount, sid, onError]);

  const loadDisasm = useCallback(async (addr = disasmAddr) => {
    try {
      setDisasm(await api.debugDisasm({ addr: addr || undefined, count: 40, debugSession: sid }));
    } catch (e) {
      onError(msg(e));
    }
  }, [disasmAddr, sid, onError]);

  const loadSvd = useCallback(async (path = "") => {
    try {
      setSvd(await api.debugPeripherals({ path, read: path.includes("."), debugSession: sid }));
    } catch (e) {
      onError(msg(e));
    }
  }, [sid, onError]);

  const loadRtos = useCallback(async () => {
    try {
      setRtos(await api.debugRtos({ debugSession: sid }));
    } catch (e) {
      setRtos(null);
      onError(msg(e));
    }
  }, [sid, onError]);

  const loadAudit = useCallback(async () => {
    try {
      setAudit((await api.debugAudit(100)).records);
    } catch (e) {
      onError(msg(e));
    }
  }, [onError]);

  // 初次进入 / 外部状态变化：先拉一次全量
  useEffect(() => {
    setSnap(session);
    setStopSeq(session.stop?.seq ?? -1);
  }, [session]);

  useEffect(() => {
    void refreshCommon().catch((e) => onError(msg(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  // 本 pane 的 SSE：**按 debug_session 过滤**，两列互不串台（D7）
  useEffect(() => {
    const es = new EventSource(`/api/debug/events?debug_session=${encodeURIComponent(sid)}`);
    const onStop = (e: MessageEvent) => {
      let reason = "";
      let bkpt = "";
      try {
        const env = JSON.parse(e.data) as { session?: string; data?: { reason?: string; bkptno?: string } };
        if (env.session && env.session !== sid) return;   // 双保险：信封再判一次
        reason = env.data?.reason ?? "";
        bkpt = env.data?.bkptno ?? "";
      } catch {
        /* 忽略坏帧 */
      }
      if (reason === "breakpoint-hit" || bkpt !== "") {
        const label = bkpt === "" ? "断点" : `断点 #${bkpt}`;
        setBpToast(`命中${label}，已切到调用栈`);
        setTab("stack");
        setFrame(0);
      }
      void refreshCommon();
      pushOut(`${reason === "breakpoint-hit" ? "命中断点" : "停止"}：${e.data}`);
    };
    const onState = (e: MessageEvent) => {
      try {
        const env = JSON.parse(e.data) as { session?: string; data?: { state?: string } };
        if (env.session && env.session !== sid) return;
        if (env.data?.state) {
          void refreshCommon();
          pushOut(`状态：${env.data.state}`);
        }
      } catch {
        /* 忽略坏帧 */
      }
    };
    const onClosed = (e: MessageEvent) => {
      try {
        const env = JSON.parse(e.data) as { session?: string };
        if (env.session && env.session !== sid) return;
      } catch {
        /* 忽略 */
      }
      setFrames([]);
      pushOut("会话已关闭");
      onChanged();
    };
    const onOutput = (e: MessageEvent) => {
      try {
        const env = JSON.parse(e.data) as {
          session?: string; data?: { text?: string; stream?: string };
        };
        if (env.session && env.session !== sid) return;
        if (env.data?.text) pushOut(`[${env.data.stream ?? "log"}] ${env.data.text}`);
      } catch {
        /* 忽略 */
      }
    };
    const onBreakpoint = (e: MessageEvent) => {
      try {
        const env = JSON.parse(e.data) as { session?: string };
        if (env.session && env.session !== sid) return;
      } catch {
        /* 忽略 */
      }
      void loadBreakpoints().catch(() => undefined);
    };
    es.addEventListener("debug/stop", onStop);
    es.addEventListener("debug/state", onState);
    es.addEventListener("debug/closed", onClosed);
    es.addEventListener("debug/output", onOutput);
    es.addEventListener("debug/breakpoint", onBreakpoint);
    // ★ 503 感知（盘点 #3）：服务端满员回 503 时 EventSource 直接 CLOSED、
    //   不会自动重连 —— 不说破的话用户只看到"事件不再来"。至少报一声。
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        pushOut("事件流已断开（可能是 SSE 连接数已满，关掉其它标签页后重开会话）");
      }
    };
    return () => es.close();
  }, [sid, refreshCommon, pushOut, onChanged, loadBreakpoints]);

  useEffect(() => {
    if (bpToast === "") return;
    const timer = window.setTimeout(() => setBpToast(""), 3000);
    return () => window.clearTimeout(timer);
  }, [bpToast]);

  // 新 stop_seq → 重拉当前页签数据
  useEffect(() => {
    if (stopSeq < 0) return;
    if (tab === "stack") void api.debugStack({ debugSession: sid }).then((x) => setFrames(x.frames)).catch(() => undefined);
    if (tab === "vars") void loadVars(0);
    if (tab === "regs") void api.debugRegisters({ group: "all", debugSession: sid })
      .then((x) => { setRegs(x.groups); setRegDraft({}); }).catch(() => undefined);
    if (tab === "bps") void loadBreakpoints().catch(() => undefined);
    if (tab === "watch") void api.debugWatch({ debugSession: sid }).then((x) => setWatch(x.watches)).catch(() => undefined);
    if (tab === "src") void loadSource(src?.file);
    if (tab === "memory") void loadMemory();
    if (tab === "disasm") void loadDisasm();
    if (tab === "svd") void loadSvd(svd?.level === "register" ? `${svd.peripheral?.name}.${svd.register?.name}` : "");
    if (tab === "rtos") void loadRtos();
    if (tab === "audit") void loadAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopSeq, tab]);

  useEffect(() => {
    if (tab !== "disasm") return;
    const el = pcRef.current;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  }, [disasm, tab]);

  // 源码页：停在当前行时自动滚到视野中央
  useEffect(() => {
    if (tab !== "src") return;
    const el = srcStopRef.current;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  }, [src, tab]);

  // ── 动作 ────────────────────────────────────────────────────
  const control = async (action: string, confirm = false, line?: number) => {
    setBusy(true);
    onError("");
    try {
      const r: DebugControlResponse = await api.debugControl({
        action,
        confirm,
        debugSession: sid,
        ...(action === "run_to_line" && src && line !== undefined
          ? { file: src.rel, line } : {}),
      });
      setSnap((prev) => ({ ...prev, state: r.state, stop: r.stop }));
      setStopSeq(r.stop?.seq ?? -1);
      pushOut(`控制：${action} → ${r.state}`);
      await refreshCommon();
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const addBp = async () => {
    if (!bpLoc.trim()) return;
    try {
      const r = await api.debugBreakpoints({ op: "add", location: bpLoc.trim(), rev, debugSession: sid });
      setBps(r.breakpoints);
      setRev(r.rev ?? rev);
      pushOut(`断点 + ${bpLoc.trim()}`);
      setBpLoc("");
    } catch (e) {
      onError(msg(e));
    }
  };

  const addAddrBp = async (addr: string) => {
    try {
      const r = await api.debugBreakpoints({ op: "add", kind: "addr", location: addr, rev, debugSession: sid });
      setBps(r.breakpoints);
      setRev(r.rev ?? rev);
      pushOut(`地址断点 + ${addr}`);
    } catch (e) {
      onError(msg(e));
    }
  };

  /** gutter 点击：切换 `file:line` 源码断点（A3）。 */
  const toggleSourceBp = async (rel: string, line: number) => {
    const loc = `${rel}:${line}`;
    const cur = bps.find((b) => b.kind === "source" && b.location === loc);
    try {
      if (cur) {
        const r = await api.debugBreakpoints({ op: "remove", id: cur.id, rev, debugSession: sid });
        setBps(r.breakpoints);
        setRev(r.rev ?? rev);
        pushOut(`断点 − ${loc}`);
      } else {
        const r = await api.debugBreakpoints({ op: "add", kind: "source", location: loc, rev, debugSession: sid });
        setBps(r.breakpoints);
        setRev(r.rev ?? rev);
        pushOut(`源码断点 + ${loc}`);
      }
    } catch (e) {
      onError(msg(e));
    }
  };

  const bpOp = async (op: "toggle" | "remove", id: string) => {
    try {
      const r = await api.debugBreakpoints({ op, id, rev, debugSession: sid });
      setBps(r.breakpoints);
      setRev(r.rev ?? rev);
    } catch (e) {
      onError(msg(e));
    }
  };

  const editBpCondition = async (bp: DebugBreakpoint) => {
    const v = window.prompt("条件断点（空 = 无条件）", bp.condition);
    if (v === null) return;
    try {
      const r = await api.debugBreakpoints({ op: "update", id: bp.id, condition: v, rev, debugSession: sid });
      setBps(r.breakpoints);
      setRev(r.rev ?? rev);
    } catch (e) {
      onError(msg(e));
    }
  };

  const addWatch = async () => {
    if (!watchExpr.trim()) return;
    try {
      const r = await api.debugWatch({ op: "add", expr: watchExpr.trim(), format: "natural", rev, debugSession: sid });
      setWatch(r.watches);
      setRev(r.rev);
      setWatchExpr("");
    } catch (e) {
      onError(msg(e));
    }
  };

  const removeWatch = async (id: string) => {
    try {
      const r = await api.debugWatch({ op: "remove", id, rev, debugSession: sid });
      setWatch(r.watches);
      setRev(r.rev);
    } catch (e) {
      onError(msg(e));
    }
  };

  const commitByte = async (addr: string, raw: string, orig: string) => {
    const value = normByte(raw);
    if (value === null) {
      onError("请输入 1 字节 HEX（00–FF）");
      return;
    }
    setEditCell(null);
    if (value === orig.toLowerCase()) return;
    try {
      await api.debugWrite({ target: "memory", addr, value, confirm: true, debugSession: sid });
      pushOut(`写内存 ${addr} ← 0x${value}`);
      await loadMemory(memAddr, memCount);
    } catch (e) {
      onError(msg(e));
    }
  };

  /**
   * 行内编辑寄存器 → **只进草稿**，不立即写（§7.3）。
   * 真正落盘在「应用本组」：一次 POST 一批 set + 一条审计，
   * 避免逐行点两下就产生 N 条审计记录。
   */
  const stageReg = (name: string, raw: string, orig: string, width = 32) => {
    const value = normRegValue(raw, width);
    if (value === null) {
      onError(`寄存器值需 1–${width / 4} 位 HEX（${width} 位宽）`);
      return;
    }
    setEditReg(null);
    const normOrig = orig.trim().toLowerCase().replace(/^0x/, "").padStart(width / 4, "0");
    setRegDraft((prev) => {
      const next = { ...prev };
      if (value === normOrig) delete next[name];
      else next[name] = value;
      return next;
    });
  };

  /** 应用本组草稿（P3-C）：一次 POST，一条审计，applied/failed 如实展示。 */
  const applyRegDraft = async () => {
    const items = Object.entries(regDraft).map(([name, value]) => ({ name, value }));
    if (items.length === 0) return;
    setBusy(true);
    try {
      const r = await api.debugRegistersWrite({ items, confirm: true, debugSession: sid });
      const applied = r.applied.map((a) => `${a.name}=${a.after}`).join(" ");
      pushOut(`应用 ${r.applied.length} 个寄存器：${applied}`);
      if (!r.ok && r.failed) {
        onError(`批量写未完成：${r.failed.name}（${r.failed.code}）—— 已写入 ${r.applied.length} 项`);
      }
      setRegDraft({});
      const g = await api.debugRegisters({ group: "all", debugSession: sid });
      setRegs(g.groups);
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const commitField = async () => {
    const ef = editField;
    if (!ef) return;
    const raw = ef.value.trim();
    const num = raw.toLowerCase().startsWith("0x")
      ? Number.parseInt(raw.slice(2), 16)
      : Number.parseInt(raw, 10);
    const max = ef.width >= 32 ? 0x100000000 : 2 ** ef.width;
    if (!Number.isFinite(num) || num < 0 || num >= max) {
      onError(`字段 ${ef.width} 位，取值范围 0–${max - 1}`);
      return;
    }
    const mask = ef.width >= 32 ? 0xffffffff : (2 ** ef.width - 1);
    const cur = ef.base >>> 0;
    const next = ((cur & ~mask) | ((num << ef.offset) & mask)) >>> 0;
    const bytes = Math.max(1, Math.min(4, Math.ceil(ef.size / 8)));
    const value = Array.from({ length: bytes },
      (_, i) => ((next >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join("");
    setEditField(null);
    try {
      await api.debugWrite({ target: "memory", addr: ef.addr, value, confirm: true, debugSession: sid });
      pushOut(`写字段 ${ef.reg} ← ${raw}（寄存器 0x${value}）`);
      await loadSvd(ef.reg);
    } catch (e) {
      onError(msg(e));
    }
  };

  // ── 派生 ────────────────────────────────────────────────────
  const featuresMerged = useMemo(
    () => (snap?.features?.length ? snap.features : (debugFeatures ?? [])),
    [snap, debugFeatures],
  );
  const visibleTabs = TABS.filter((t) => !t.feature || featuresMerged.includes(t.feature));
  const currentTab = visibleTabs.some((t) => t.id === tab) ? tab : visibleTabs[0]?.id;
  const stopped = snap?.state === "stopped";
  const regGroups = regGroup === "all" ? regs : regs.filter((g) => g.name === regGroup);
  const draftCount = Object.keys(regDraft).length;

  // 源码断点表：`rel:line`（与内核持久化格式一致）
  const srcBpMap = useMemo(() => {
    const map = new Map<string, DebugBreakpoint>();
    for (const b of bps) if (b.kind === "source") map.set(b.location, b);
    return map;
  }, [bps]);

  const svdDeviceGroups = useMemo(() => {
    const q = svdQuery.trim().toLowerCase();
    const list = (svd?.peripherals ?? []).filter((p) =>
      q === "" || p.name.toLowerCase().includes(q)
      || (p.description ?? "").toLowerCase().includes(q));
    const map = new Map<string, typeof list>();
    for (const p of list) {
      const g = p.group !== undefined && p.group.trim() !== "" ? p.group : "其它";
      const cur = map.get(g);
      if (cur) cur.push(p);
      else map.set(g, [p]);
    }
    return Array.from(map.entries());
  }, [svd, svdQuery]);

  const svdRegisters = useMemo(() => {
    const q = svdQuery.trim().toLowerCase();
    return (svd?.peripheral?.registers ?? []).filter((r) =>
      q === "" || r.name.toLowerCase().includes(q)
      || (r.description ?? "").toLowerCase().includes(q));
  }, [svd, svdQuery]);

  const toggleVar = async (node: DebugVarNode) => {
    if (expanded[node.name]) {
      const cp = { ...expanded };
      delete cp[node.name];
      setExpanded(cp);
      return;
    }
    if (!node.obj) return;
    try {
      const r = await api.debugVariables({ frame, scope: "children", var: node.obj, debugSession: sid });
      setExpanded((prev) => ({ ...prev, [node.name]: r.nodes }));
    } catch (e) {
      onError(msg(e));
    }
  };

  const pickFrame = (idx: number) => {
    setFrame(idx);
    void loadVars(idx);
  };

  // ── 渲染 ────────────────────────────────────────────────────
  return (
    <div className={s.pane} data-compact={compact ? "1" : "0"}>
      <div className={s.paneHead}>
        <span className={s.stateChip} data-state={snap.state}>{snap.state}</span>
        <span className={s.mono}>{snap.project}</span>
        {snap.stop?.frame?.file ? (
          <span className={s.dimText}>
            {snap.stop.frame.func} · {snap.stop.frame.file.split("/").pop()}:{snap.stop.frame.line ?? "?"}
          </span>
        ) : null}
        <span className={s.spacer} />
        <Button size="sm" disabled={busy || !stopped} onClick={() => void control("continue")}>
          继续
        </Button>
        <Button size="sm" disabled={busy || stopped} onClick={() => void control("pause")}>
          暂停
        </Button>
        <Button size="sm" disabled={busy || !stopped} onClick={() => void control("step_over")}>
          单步
        </Button>
        <Button size="sm" disabled={busy || !stopped} onClick={() => void control("step_in")}>
          步入
        </Button>
        <Button size="sm" disabled={busy || !stopped} onClick={() => void control("step_out")}>
          步出
        </Button>
      </div>

      {bpToast ? <div className={s.toast}>{bpToast}</div> : null}

      <div className={s.body}>
        <div className={s.tabs} role="tablist">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={currentTab === t.id}
              className={currentTab === t.id ? s.tabActive : s.tab}
              onClick={() => {
                setTab(t.id);
                if (t.id === "src" && !src) void loadSource();
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={s.panel}>
          {currentTab === "stack" ? (
            <div className={s.list}>
              {frames.map((f) => (
                <button
                  key={`${f.level}-${f.addr}`}
                  type="button"
                  className={`${s.row} ${f.level === frame ? s.rowActive : ""}`}
                  onClick={() => pickFrame(f.level)}
                >
                  <span className={s.num}>#{f.level}</span>
                  <span className={s.mono}>{f.func}</span>
                  <span className={s.dimText}>
                    {f.file ? `${f.file}:${f.line ?? "?"}` : f.addr}
                  </span>
                  {f.pc ? <span className={s.badge}>PC</span> : null}
                </button>
              ))}
              {frames.length === 0 ? <div className={s.hint}>无调用栈（目标可能在运行）</div> : null}
            </div>
          ) : null}

          {currentTab === "vars" ? (
            <div className={s.list}>
              <div className={s.rowHead}>局部变量 · frame #{frame}</div>
              {vars.map((node) => (
                <div key={node.name}>
                  <button
                    type="button"
                    className={`${s.row} ${node.has_children ? s.clickable : ""}`}
                    onClick={() => void toggleVar(node)}
                  >
                    <span className={s.mono}>{node.name}</span>
                    <span className={s.dimText}>{node.type}</span>
                    <span className={s.value}>{node.value}</span>
                  </button>
                  {(expanded[node.name] ?? []).map((child) => (
                    <div key={`${node.name}.${child.name}`} className={`${s.row} ${s.child}`}>
                      <span className={s.mono}>{child.name}</span>
                      <span className={s.dimText}>{child.type}</span>
                      <span className={s.value}>{child.value}</span>
                    </div>
                  ))}
                </div>
              ))}
              {vars.length === 0 ? <div className={s.hint}>无变量或尚未停止</div> : null}
            </div>
          ) : null}

          {/* ── 寄存器（P3-C：组切换 + 草稿批量应用）── */}
          {currentTab === "regs" ? (
            <div className={s.list}>
              <div className={s.rowHead}>
                <select
                  className={s.select}
                  value={regGroup}
                  onChange={(e) => { setRegGroup(e.currentTarget.value); setRegDraft({}); }}
                  aria-label="寄存器组"
                >
                  <option value="all">全部组</option>
                  {regs.map((g) => (
                    <option key={g.name} value={g.name}>{g.label}</option>
                  ))}
                </select>
                <Button size="sm" disabled={busy || draftCount === 0 || !allowWrite}
                  onClick={() => void applyRegDraft()}>
                  应用本组（{draftCount}）
                </Button>
                {draftCount > 0 ? (
                  <button type="button" className={s.link} onClick={() => setRegDraft({})}>
                    放弃草稿
                  </button>
                ) : null}
                <span className={s.spacer} />
                <span className={s.dimText}>
                  {allowWrite ? "点击改值 → 顶部「应用本组」一次提交（一条审计）" : "只读（会话未开写权限）"}
                </span>
              </div>
              {regGroups.map((g) => (
                <div key={g.name}>
                  <div className={s.group}>{g.label}</div>
                  {g.regs.map((r) => {
                    const editable = r.editable && allowWrite;
                    const editing = editReg?.name === r.name;
                    const draft = regDraft[r.name];
                    const dirty = draft !== undefined && draft !== r.hex.replace(/^0x/, "");
                    return (
                      <div key={r.name}
                        className={`${s.row} ${r.pc ? s.rowAccent : ""} ${dirty ? s.rowDraft : ""}`}>
                        <span className={s.mono}>{r.name}</span>
                        {editing ? (
                          <input
                            className={s.valueInput}
                            autoFocus
                            maxLength={11}
                            value={editReg.value}
                            aria-label={`编辑寄存器 ${r.name}`}
                            onChange={(e) => setEditReg({ ...editReg, value: e.currentTarget.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") stageReg(r.name, editReg.value, editReg.orig, r.width ?? 32);
                              if (e.key === "Escape") setEditReg(null);
                            }}
                            onBlur={() => setEditReg(null)}
                          />
                        ) : (
                          <button
                            type="button"
                            className={editable ? s.valueEdit : s.value}
                            title={editable
                              ? `点击改为 ${r.name} 的新值（草稿，不立即写）`
                              : (r.readonly === "wide" ? "64/128 位只读（待 P3b）"
                                : "只读（pc/lr/xpsr）")}
                            onClick={() => editable
                              ? setEditReg({
                                name: r.name,
                                value: draft ?? r.hex,
                                orig: r.hex,
                              })
                              : undefined}
                          >
                            {draft !== undefined ? `0x${draft}` : r.hex}
                          </button>
                        )}
                        {/* 草稿行不显示旧的自然值：那会让人以为已生效（draft hex 才是意图） */}
                        {dirty ? null : <span className={s.dimText}>{r.natural}</span>}
                        {r.width !== undefined && r.width > 32
                          ? <span className={s.badge}>{r.width} 位</span> : null}
                      </div>
                    );
                  })}
                </div>
              ))}
              {regs.length === 0 ? <div className={s.hint}>无寄存器数据</div> : null}
            </div>
          ) : null}

          {currentTab === "bps" ? (
            <div className={s.list}>
              <div className={s.rowHead}>
                <Input
                  mono
                  placeholder="函数名 / *地址 / 文件:行（如 Core/Src/freertos.c:615）"
                  value={bpLoc}
                  onChange={(e) => setBpLoc(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void addBp(); }}
                />
                <Button size="sm" onClick={() => void addBp()}>添加断点</Button>
                <span className={s.dimText}>rev {rev}</span>
              </div>
              {bps.map((bp) => (
                <div key={bp.id} className={s.row}>
                  <span className={s.badge} data-on={bp.enabled}>{bp.enabled ? "启用" : "禁用"}</span>
                  <span className={s.badge}>{bp.kind}</span>
                  <span className={s.mono}>{bp.location}</span>
                  {bp.condition ? <span className={s.dimText}>if {bp.condition}</span> : null}
                  {!bp.verified ? <span className={s.dimText}>未验证</span> : null}
                  <span className={s.spacer} />
                  <button type="button" className={s.link} onClick={() => void bpOp("toggle", bp.id)}>
                    {bp.enabled ? "禁用" : "启用"}
                  </button>
                  <button type="button" className={s.link} onClick={() => void editBpCondition(bp)}>条件</button>
                  <button type="button" className={s.linkDanger} onClick={() => void bpOp("remove", bp.id)}>删除</button>
                </div>
              ))}
              {bps.length === 0 ? <div className={s.hint}>暂无断点（持久化在 projects/&lt;name&gt;.debug.json）</div> : null}
            </div>
          ) : null}

          {currentTab === "watch" ? (
            <div className={s.list}>
              <div className={s.rowHead}>
                <Input
                  mono
                  placeholder="表达式（如 i、buf[3]、pxCurrentTCB->pcTaskName）"
                  value={watchExpr}
                  onChange={(e) => setWatchExpr(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void addWatch(); }}
                />
                <Button size="sm" onClick={() => void addWatch()}>添加</Button>
              </div>
              {watch.map((w) => (
                <div key={w.id} className={s.row}>
                  <span className={s.mono}>{w.expr}</span>
                  <span className={s.dimText}>{w.type}</span>
                  <span className={s.value}>{w.error ? `✗ ${w.error}` : w.value}</span>
                  {w.hex && w.hex !== w.value ? <span className={s.dimText}>{w.hex}</span> : null}
                  <span className={s.spacer} />
                  <button type="button" className={s.linkDanger} onClick={() => void removeWatch(w.id)}>删除</button>
                </div>
              ))}
              {watch.length === 0 ? <div className={s.hint}>暂无监视项</div> : null}
            </div>
          ) : null}

          {/* ── 源码（P3-A）：窄栏 gutter + 行断点 + 运行到本行 ── */}
          {currentTab === "src" ? (
            <div className={s.srcWrap}>
              <div className={s.rowHead}>
                <Button size="sm" variant="outline" disabled={!src}
                  onClick={() => void loadSource(src?.file, Math.max(1, srcStart - 120))}>↑ 上一页</Button>
                <Button size="sm" variant="outline" disabled={!src || !src.has_more}
                  onClick={() => void loadSource(src?.file, srcStart + 160)}>↓ 下一页</Button>
                <Button size="sm" disabled={busy || !stopped || !src || srcPick <= 0}
                  onClick={() => void control("run_to_line", false, srcPick)}>
                  运行到本行{srcPick > 0 ? `（${srcPick}）` : ""}
                </Button>
                <span className={s.spacer} />
                <span className={s.dimText}>
                  {src ? `${src.rel} · 共 ${src.total} 行` : "—"}
                </span>
              </div>
              {srcErr ? <div className={s.hint}>{srcErr}</div> : null}
              {src ? (
                <div className={s.srcList}>
                  {src.lines.map((ln) => {
                    const loc = `${src.rel}:${ln.no}`;
                    const bp = srcBpMap.get(loc);
                    const isStop = src.stop_line === ln.no;
                    const isPick = srcPick === ln.no;
                    return (
                      <div
                        key={ln.no}
                        ref={isStop ? srcStopRef : undefined}
                        className={`${s.srcRow} ${isStop ? s.srcRowStop : ""} ${isPick && !isStop ? s.srcRowPick : ""}`}
                      >
                        <button
                          type="button"
                          className={s.srcGutter}
                          title={bp ? `删除断点 ${loc}` : `在 ${loc} 设断点`}
                          onClick={() => void toggleSourceBp(src.rel, ln.no)}
                        >
                          <span className={s.srcDot} data-on={bp ? (bp.enabled ? "1" : "0") : ""} />
                          <span className={s.srcNo}>{ln.no}</span>
                        </button>
                        <code
                          className={s.srcText}
                          onClick={() => setSrcPick(ln.no)}
                        >
                          {ln.text === "" ? " " : ln.text}
                        </code>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={s.hint}>
                  {srcErr || "当前停止点无源码信息（检查 -g 调试信息 / ELF 是否最新）"}
                </div>
              )}
            </div>
          ) : null}

          {currentTab === "memory" ? (
            <div className={s.list}>
              <div className={s.rowHead}>
                <Input
                  mono
                  value={memAddr}
                  onChange={(e) => setMemAddr(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void loadMemory(); }}
                />
                <Input
                  mono
                  value={String(memCount)}
                  onChange={(e) => setMemCount(Number(e.currentTarget.value) || 64)}
                  onKeyDown={(e) => { if (e.key === "Enter") void loadMemory(); }}
                />
                <Button size="sm" onClick={() => void loadMemory()}>读取</Button>
                <span className={s.dimText}>{allowWrite ? "点字节可直接改（进审计）" : "只读（会话未开写权限）"}</span>
              </div>
              {mem ? (
                <div className={s.memWrap}>
                  <div className={s.mem}>
                    {rowDump(mem.addr, hexBytes(mem.bytes)).map((line) => (
                      <div key={line.addr} className={s.memRow}>
                        <span className={s.memAddr}>{line.addr}</span>
                        {line.bytes.map((b, i) => {
                          const addr = cellAddr(line.addr, i);
                          const editing = editCell?.addr === addr;
                          if (editing) {
                            return (
                              <input
                                key={addr}
                                className={s.memCellInput}
                                autoFocus
                                maxLength={2}
                                value={editCell.value}
                                aria-label={`编辑 ${addr}`}
                                onChange={(e) => setEditCell({ ...editCell, value: e.currentTarget.value })}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void commitByte(addr, editCell.value, editCell.orig);
                                  if (e.key === "Escape") setEditCell(null);
                                }}
                                onBlur={() => setEditCell(null)}
                              />
                            );
                          }
                          return allowWrite ? (
                            <button
                              key={addr}
                              type="button"
                              className={s.memCell}
                              title={`点击编辑 ${addr}（当前 0x${b}）`}
                              onClick={() => setEditCell({ addr, value: b, orig: b })}
                            >
                              {b}
                            </button>
                          ) : (
                            <span key={addr} className={s.memCell}>{b}</span>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <pre className={s.ascii}>{rowDump(mem.addr, hexBytes(mem.bytes))
                    .map((line) => line.ascii).join("\n")}</pre>
                </div>
              ) : (
                <div className={s.hint}>输入地址后读取</div>
              )}
            </div>
          ) : null}

          {currentTab === "disasm" ? (
            <div className={s.list}>
              <div className={s.rowHead}>
                <Input
                  mono
                  placeholder="地址（空 = 当前 PC）"
                  value={disasmAddr}
                  onChange={(e) => setDisasmAddr(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void loadDisasm(); }}
                />
                <Button size="sm" onClick={() => void loadDisasm()}>反汇编</Button>
              </div>
              <div ref={disasmRef}>
                {disasm?.instructions.map((ins: DebugDisasmLine) => (
                  <div
                    key={ins.addr}
                    ref={ins.pc ? pcRef : undefined}
                    className={`${s.row} ${ins.pc ? s.rowAccent : ""}`}
                  >
                    <button
                      type="button"
                      className={s.addrLink}
                      title="跳到内存视图"
                      onClick={() => {
                        setMemAddr(ins.addr);
                        void loadMemory(ins.addr, memCount);
                        setTab("memory");
                      }}
                    >
                      {ins.addr}
                    </button>
                    <span className={s.mono}>{ins.mnemonic} {ins.operands}</span>
                    {ins.symbol ? <span className={s.dimText}>{ins.symbol}</span> : null}
                    {ins.pc ? <span className={s.badge}>PC</span> : null}
                    <button
                      type="button"
                      className={s.link}
                      title="在此地址设断点"
                      onClick={() => void addAddrBp(ins.addr)}
                    >
                      ⌖
                    </button>
                  </div>
                ))}
              </div>
              {!disasm ? <div className={s.hint}>点「反汇编」</div> : null}
            </div>
          ) : null}

          {currentTab === "svd" ? (
            <div className={s.list}>
              <div className={s.rowHead}>
                {svd && svd.level !== "device" ? (
                  <button type="button" className={s.link} onClick={() => void loadSvd("")}>← 外设</button>
                ) : null}
                <span className={s.dimText}>
                  {svd ? `${svd.svd.name} · ${svd.level}` : "SVD 未加载"}
                </span>
                {svd && svd.level !== "register" ? (
                  <Input
                    mono
                    placeholder={svd.level === "device" ? "搜索外设" : "搜索寄存器"}
                    value={svdQuery}
                    onChange={(e) => setSvdQuery(e.currentTarget.value)}
                  />
                ) : null}
                <span className={s.spacer} />
                {svd?.level === "peripheral" ? (
                  <button type="button" className={s.link}
                          onClick={() => void loadSvd(svd.peripheral?.name ?? "")}>刷新</button>
                ) : null}
              </div>
              {svd?.level === "device" ? (
                <div>
                  {svdDeviceGroups.map(([group, items]) => {
                    const folded = svdCollapsed[group] === true;
                    return (
                      <div key={group}>
                        <button
                          type="button"
                          className={s.group}
                          onClick={() => setSvdCollapsed((prev) => ({ ...prev, [group]: !folded }))}
                        >
                          {folded ? "▸" : "▾"} {group} · {items.length}
                        </button>
                        {folded ? null : (
                          <div className={s.grid}>
                            {items.map((p) => (
                              <button key={p.name} type="button" className={s.card}
                                      onClick={() => void loadSvd(p.name)}>
                                <b>{p.name}</b>
                                <span>{p.base}</span>
                                <span>{p.registers_count ?? 0} 寄存器</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {svdDeviceGroups.length === 0 ? <div className={s.hint}>没有匹配的外设</div> : null}
                </div>
              ) : null}
              {svd?.level === "peripheral" ? (
                <div>
                  <div className={s.rowHead}>
                    <b>{svd.peripheral?.name}</b>
                    <span className={s.dimText}>{svd.peripheral?.base}</span>
                    <span className={s.dimText}>{svd.peripheral?.description}</span>
                  </div>
                  {svdRegisters.map((r) => (
                    <button key={r.name} type="button" className={s.row}
                            onClick={() => void loadSvd(`${svd.peripheral?.name}.${r.name}`)}>
                      <span className={s.mono}>{r.name}</span>
                      <span className={s.dimText}>{r.addr}</span>
                      <span className={s.dimText}>{r.access}</span>
                      <span className={s.value}>{r.fields_count ? `${r.fields_count} 字段` : ""}</span>
                    </button>
                  ))}
                  {svdRegisters.length === 0 ? <div className={s.hint}>没有匹配的寄存器</div> : null}
                </div>
              ) : null}
              {svd?.level === "register" && svd.register ? (
                <div>
                  <div className={s.rowHead}>
                    <b>{svd.peripheral?.name}.{svd.register.name}</b>
                    <span className={s.value}>{svd.register.value ?? "—"}</span>
                    <span className={s.dimText}>{svd.register.description}</span>
                  </div>
                  {(svd.register.fields ?? []).map((f) => {
                    const writable = allowWrite && /write/i.test(svd.register?.access ?? "");
                    const editing = editField?.reg === `${svd.peripheral?.name}.${svd.register?.name}`
                      && editField.offset === f.offset;
                    const base = Number.parseInt(
                      String(svd.register?.value ?? "0").replace(/^0x/, ""), 16) || 0;
                    return (
                      <div key={f.name} className={s.row}>
                        <span className={s.mono}>{f.name}</span>
                        <span className={s.dimText}>[{f.bits}]</span>
                        {editing ? (
                          <input
                            className={s.valueInput}
                            autoFocus
                            value={editField.value}
                            aria-label={`编辑字段 ${f.name}`}
                            onChange={(e) => setEditField({ ...editField, value: e.currentTarget.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void commitField();
                              if (e.key === "Escape") setEditField(null);
                            }}
                            onBlur={() => setEditField(null)}
                          />
                        ) : (
                          <button
                            type="button"
                            className={writable ? s.valueEdit : s.value}
                            title={writable ? `点击改写字段 ${f.name}（读-改-写）` : "字段只读"}
                            onClick={() => {
                              if (!writable || !svd.register) return;
                              setEditField({
                                reg: `${svd.peripheral?.name}.${svd.register.name}`,
                                addr: svd.register.addr,
                                size: svd.register.size,
                                base,
                                offset: f.offset,
                                width: f.width,
                                value: String(f.value),
                              });
                            }}
                          >
                            {f.enum ? `${f.enum.name} (${f.enum.value})` : `${f.value} (${f.hex})`}
                          </button>
                        )}
                        <span className={s.dimText}>{f.description}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {!svd ? <div className={s.hint}>加载中… 或该芯片未提供 SVD</div> : null}
            </div>
          ) : null}

          {currentTab === "rtos" ? (
            <div className={s.list}>
              <div className={s.rowHead}>
                <b>FreeRTOS 任务栈水位</b>
                <span className={s.dimText}>high water mark = 历史最小剩余（字）</span>
                <span className={s.spacer} />
                <button type="button" className={s.link} onClick={() => void loadRtos()}>刷新</button>
              </div>
              <div className={s.rtosHead}>
                <span>任务</span><span>优先级</span><span>状态</span><span>水位</span><span>使用率</span>
              </div>
              {(rtos?.tasks ?? []).map((t) => (
                <div key={t.tcb} className={`${s.rtosRow} ${t.current ? s.rowAccent : ""}`}>
                  <span className={s.mono}>{t.name}{t.current ? " *" : ""}</span>
                  <span>{t.priority ?? "—"}</span>
                  <span className={s.dimText}>{t.state}</span>
                  <span className={s.meter}>
                    <span className={s.meterBg}>
                      <span
                        className={s.meterFill}
                        data-health={t.health}
                        style={{ width: t.used_pct != null ? `${t.used_pct}%` : "0%" }}
                      />
                    </span>
                    <span className={s.dimText} data-health={t.health}>
                      {t.stack_size_bytes != null
                        ? `${t.free_bytes}/${t.stack_size_bytes}B`
                        : `剩 ${t.free_words} 字`}
                    </span>
                  </span>
                  <span className={s.value} data-health={t.health}>
                    {t.used_pct != null ? `${t.used_pct}%` : "—"}
                  </span>
                </div>
              ))}
              {rtos && rtos.tasks.length === 0 ? <div className={s.hint}>未枚举到任务</div> : null}
              {!rtos ? <div className={s.hint}>目标未使用 FreeRTOS，或未停止</div> : null}
            </div>
          ) : null}

          {currentTab === "audit" ? (
            <div className={s.list}>
              <div className={s.rowHead}>
                <b>写操作 / 断点审计</b>
                <span className={s.spacer} />
                <button type="button" className={s.link} onClick={() => void loadAudit()}>刷新</button>
              </div>
              {/* 新记录在最上面：刚写完的那条不该被埋在几十条历史之下 */}
              {audit.slice().reverse().map((a, i) => (
                <div key={`${a.ts}-${i}`} className={s.row}>
                  <span className={s.dimText}>{new Date(a.ts * 1000).toLocaleTimeString()}</span>
                  <span className={s.badge}>{a.action}</span>
                  <span className={s.mono}>{a.target ?? a.location ?? a.id ?? ""}</span>
                  <span className={s.value}>
                    {a.items !== undefined
                      ? `${a.items.length} 项（组）`
                      : `${a.addr ?? a.name ?? ""} ${a.value ?? ""}`}
                  </span>
                  <span className={s.dimText}>{a.actor ?? ""}</span>
                </div>
              ))}
              {audit.length === 0 ? <div className={s.hint}>暂无审计记录</div> : null}
            </div>
          ) : null}

          {currentTab === "out" ? (
            <pre className={s.pre}>{outLines.join("\n") || "（暂无输出）"}</pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
