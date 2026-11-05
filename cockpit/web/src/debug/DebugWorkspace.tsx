/**
 * 独立 WebUI 调试工作区（P1–P3）。
 *
 * 数据面只走 loopback HTTP ICD（`/api/debug/*`），**不** import 内核源码（分层门禁）。
 *
 * 设计要点：
 * - 页签按会话 `features` 白名单渲染 —— 内核没声明/目标不支持的能力不出现；
 * - 数据只在**新的 stop_seq** 拉取，避免暂停时反复打 gdb；
 * - SSE 用的是命名事件，必须逐 topic `addEventListener`；
 * - 写内存/寄存器默认拒绝（需会话 allow_write），并在 UI 明示会进审计。
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

type TabId = "stack" | "vars" | "regs" | "bps" | "watch" | "memory"
  | "disasm" | "svd" | "rtos" | "audit" | "out";

const TABS: Array<{ id: TabId; label: string; feature?: string }> = [
  { id: "stack", label: "调用栈", feature: "stack" },
  { id: "vars", label: "变量", feature: "variables" },
  { id: "regs", label: "寄存器", feature: "registers" },
  { id: "bps", label: "断点", feature: "breakpoints" },
  { id: "watch", label: "监视", feature: "watch" },
  { id: "memory", label: "内存", feature: "memory" },
  { id: "disasm", label: "反汇编", feature: "disasm" },
  { id: "svd", label: "外设", feature: "svd" },
  { id: "rtos", label: "RTOS 栈", feature: "rtos" },
  { id: "audit", label: "审计" },
  { id: "out", label: "输出" },
];

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

export function DebugWorkspace({ caps, project, running, debugFeatures }: DebugWorkspaceProps) {
  const [snap, setSnap] = useState<DebugSessionSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabId>("stack");
  const [stopSeq, setStopSeq] = useState(-1);

  // 各页签数据
  const [frames, setFrames] = useState<DebugStackFrame[]>([]);
  const [frame, setFrame] = useState(0);
  const [vars, setVars] = useState<DebugVarNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, DebugVarNode[]>>({});
  const [regGroup, setRegGroup] = useState<"core" | "fpu" | "all">("core");
  const [regs, setRegs] = useState<DebugRegGroup[]>([]);
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
  const [stopAt, setStopAt] = useState<"main" | "reset" | "none">("main");

  // P1：写权限来自会话（/breakpoints 的 allow_write），不是内核能力位
  const [allowWrite, setAllowWrite] = useState(false);
  /** 行内编辑：一次只编辑一个字节 / 一个寄存器 / 一个 SVD 字段 */
  const [editCell, setEditCell] = useState<{ addr: string; value: string; orig: string } | null>(null);
  const [editReg, setEditReg] = useState<{ name: string; value: string; orig: string } | null>(null);
  const [editField, setEditField] = useState<{
    reg: string; addr: string; size: number; base: number;
    offset: number; width: number; value: string;
  } | null>(null);
  const [svdQuery, setSvdQuery] = useState("");
  const [svdCollapsed, setSvdCollapsed] = useState<Record<string, boolean>>({});
  /** 断点命中通知（自动消失） */
  const [bpToast, setBpToast] = useState("");

  const disasmRef = useRef<HTMLDivElement | null>(null);
  const pcRef = useRef<HTMLDivElement | null>(null);

  const snapRef = useRef<DebugSessionSnapshot | null>(null);
  snapRef.current = snap;

  const pushOut = useCallback((text: string) => {
    setOutLines((prev) => {
      const next = `${new Date().toLocaleTimeString()}  ${text}`;
      return [...prev.slice(-249), next];
    });
  }, []);

  const setSession = useCallback((session: DebugSessionSnapshot | null) => {
    setSnap(session);
    setStopSeq(session?.stop?.seq ?? -1);
  }, []);

  // ── 会话 + 各页签刷新 ────────────────────────────────────────
  const refreshCommon = useCallback(async () => {
    const r = await api.debugSession();
    const sess = r.session;
    setSession(sess);
    if (!sess) {
      setFrames([]);
      return;
    }
    const busyJobs: Array<Promise<unknown>> = [];
    busyJobs.push(api.debugBreakpoints()
      .then((x) => { setBps(x.breakpoints); setRev(x.rev ?? 0); setAllowWrite(x.allow_write === true); })
      .catch(() => undefined));
    if (sess.state === "stopped") {
      busyJobs.push(api.debugStack()
        .then((x) => setFrames(x.frames)).catch(() => undefined));
      busyJobs.push(api.debugRegisters({ group: regGroup })
        .then((x) => setRegs(x.groups)).catch(() => undefined));
      busyJobs.push(api.debugWatch()
        .then((x) => setWatch(x.watches)).catch(() => undefined));
      if (sess.features.includes("rtos")) {
        busyJobs.push(api.debugRtos()
          .then((x) => setRtos(x)).catch(() => setRtos(null)));
      }
    }
    await Promise.allSettled(busyJobs);
  }, [regGroup, setSession]);

  const loadVars = useCallback(async (idx = frame) => {
    try {
      const r = await api.debugVariables({ frame: idx, scope: "locals" });
      setVars(r.nodes);
      setExpanded({});
    } catch (e) {
      setVars([]);
      setError(msg(e));
    }
  }, [frame]);

  const loadMemory = useCallback(async (addr = memAddr, count = memCount) => {
    try {
      setMem(await api.debugMemory({ addr, count }));
    } catch (e) {
      setError(msg(e));
    }
  }, [memAddr, memCount]);

  const loadDisasm = useCallback(async (addr = disasmAddr) => {
    try {
      setDisasm(await api.debugDisasm({ addr: addr || undefined, count: 40 }));
    } catch (e) {
      setError(msg(e));
    }
  }, [disasmAddr]);

  const loadSvd = useCallback(async (path = "") => {
    try {
      setSvd(await api.debugPeripherals({ path, read: path.includes(".") }));
    } catch (e) {
      setError(msg(e));
    }
  }, []);

  const loadRtos = useCallback(async () => {
    try {
      setRtos(await api.debugRtos());
    } catch (e) {
      setRtos(null);
      setError(msg(e));
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const r = await api.debugAudit(100);
      setAudit(r.records);
    } catch (e) {
      setError(msg(e));
    }
  }, []);

  // 初次进入：恢复已有会话（例如 agent 已经开了）
  useEffect(() => {
    void refreshCommon().catch((e) => setError(msg(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SSE：只订阅命名 topic（漏一个该 topic 会静默消失）
  useEffect(() => {
    const es = new EventSource("/api/debug/events");
    const onStop = (e: MessageEvent) => {
      let reason = "";
      let bkpt = "";
      try {
        const env = JSON.parse(e.data) as { data?: { reason?: string; bkptno?: string } };
        reason = env.data?.reason ?? "";
        bkpt = env.data?.bkptno ?? "";
      } catch {
        /* 忽略坏帧 */
      }
      // 断点命中：面板内提示并自动落到调用栈（与插件同源行为）
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
        const env = JSON.parse(e.data) as { data?: { state?: string } };
        if (env.data?.state) {
          void refreshCommon();
          pushOut(`状态：${env.data.state}`);
        }
      } catch {
        /* 忽略坏帧 */
      }
    };
    const onClosed = () => {
      setSession(null);
      setFrames([]);
      pushOut("会话已关闭");
    };
    const onOutput = (e: MessageEvent) => {
      try {
        const env = JSON.parse(e.data) as { data?: { text?: string; stream?: string } };
        if (env.data?.text) pushOut(`[${env.data.stream ?? "log"}] ${env.data.text}`);
      } catch {
        /* 忽略 */
      }
    };
    const onError = (e: MessageEvent) => {
      try {
        const env = JSON.parse(e.data) as { data?: { code?: string; message?: string } };
        pushOut(`错误：${env.data?.code ?? ""} ${env.data?.message ?? ""}`);
      } catch {
        /* 忽略 */
      }
    };
    const onBreakpoint = () => {
      void api.debugBreakpoints()
        .then((x) => { setBps(x.breakpoints); setRev(x.rev ?? 0); setAllowWrite(x.allow_write === true); })
        .catch(() => undefined);
    };
    es.addEventListener("debug/stop", onStop);
    es.addEventListener("debug/state", onState);
    es.addEventListener("debug/closed", onClosed);
    es.addEventListener("debug/output", onOutput);
    es.addEventListener("debug/error", onError);
    es.addEventListener("debug/breakpoint", onBreakpoint);
    return () => es.close();
  }, [refreshCommon, setSession, pushOut]);

  // 断点命中提示：3s 自动消失，不抢焦点
  useEffect(() => {
    if (bpToast === "") return;
    const timer = window.setTimeout(() => setBpToast(""), 3000);
    return () => window.clearTimeout(timer);
  }, [bpToast]);

  // 新 stop_seq → 重拉当前页签数据
  useEffect(() => {
    if (!snap || stopSeq < 0) return;
    if (tab === "stack") void api.debugStack().then((x) => setFrames(x.frames)).catch(() => undefined);
    if (tab === "vars") void loadVars(0);
    if (tab === "regs") void api.debugRegisters({ group: regGroup }).then((x) => setRegs(x.groups)).catch(() => undefined);
    if (tab === "bps") void api.debugBreakpoints().then((x) => { setBps(x.breakpoints); setRev(x.rev ?? 0); }).catch(() => undefined);
    if (tab === "watch") void api.debugWatch().then((x) => setWatch(x.watches)).catch(() => undefined);
    if (tab === "memory") void loadMemory();
    if (tab === "disasm") void loadDisasm();
    if (tab === "svd") void loadSvd(svd?.level === "register" ? `${svd.peripheral?.name}.${svd.register?.name}` : "");
    if (tab === "rtos") void loadRtos();
    if (tab === "audit") void loadAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopSeq, tab]);

  // 反汇编加载后把 PC 行滚到视野中央（断点命中/单步后不丢位置）
  useEffect(() => {
    if (tab !== "disasm") return;
    const el = pcRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }, [disasm, tab]);

  // ── 动作 ────────────────────────────────────────────────────
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
      setSession(r.session);
      pushOut(`会话已建立：${r.session?.id ?? ""}（stop_at=${stopAt}）`);
      await refreshCommon();
      setTab("stack");
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const closeSession = async (resume = true) => {
    setBusy(true);
    try {
      await api.debugClose(resume);
      setSession(null);
      setFrames([]);
      pushOut(`会话已关闭（resume=${resume}）`);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const control = async (action: string, confirm = false) => {
    setBusy(true);
    setError("");
    try {
      const r: DebugControlResponse = await api.debugControl({ action, confirm });
      setSnap((prev) => (prev ? { ...prev, state: r.state, stop: r.stop } : prev));
      setStopSeq(r.stop?.seq ?? -1);
      pushOut(`控制：${action} → ${r.state}`);
      await refreshCommon();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const addBp = async () => {
    if (!bpLoc.trim()) return;
    try {
      const r = await api.debugBreakpoints({ op: "add", location: bpLoc.trim(), rev });
      setBps(r.breakpoints);
      setRev(r.rev ?? rev);
      setBpLoc("");
      pushOut(`断点 + ${bpLoc.trim()}`);
      setBps(r.breakpoints);
    } catch (e) {
      setError(msg(e));
    }
  };

  /** 反汇编行内「设地址断点」（rev 乐观锁与列表一致）。 */
  const addAddrBp = async (addr: string) => {
    try {
      const r = await api.debugBreakpoints({ op: "add", kind: "addr", location: addr, rev });
      setBps(r.breakpoints);
      setRev(r.rev ?? rev);
      pushOut(`地址断点 + ${addr}`);
    } catch (e) {
      setError(msg(e));
    }
  };

  const bpOp = async (op: "toggle" | "remove", id: string) => {
    try {
      const r = await api.debugBreakpoints({ op, id, rev });
      setBps(r.breakpoints);
      setRev(r.rev ?? rev);
    } catch (e) {
      setError(msg(e));
    }
  };

  const editBpCondition = async (bp: DebugBreakpoint) => {
    const v = window.prompt(`条件断点（空 = 无条件）`, bp.condition);
    if (v === null) return;
    try {
      const r = await api.debugBreakpoints({ op: "update", id: bp.id, condition: v, rev });
      setBps(r.breakpoints);
      setRev(r.rev ?? rev);
    } catch (e) {
      setError(msg(e));
    }
  };

  const addWatch = async () => {
    if (!watchExpr.trim()) return;
    try {
      const r = await api.debugWatch({ op: "add", expr: watchExpr.trim(), format: "natural", rev });
      setWatch(r.watches);
      setRev(r.rev);
      setWatchExpr("");
    } catch (e) {
      setError(msg(e));
    }
  };

  const removeWatch = async (id: string) => {
    try {
      const r = await api.debugWatch({ op: "remove", id, rev });
      setWatch(r.watches);
      setRev(r.rev);
    } catch (e) {
      setError(msg(e));
    }
  };

  /** 行内写 1 字节：只发 1 个 HEX 字节，内核会做 before/after 审计。 */
  const commitByte = async (addr: string, raw: string, orig: string) => {
    const value = normByte(raw);
    if (value === null) {
      setError("请输入 1 字节 HEX（00–FF）");
      return;
    }
    setEditCell(null);
    if (value === orig.toLowerCase()) return;
    try {
      await api.debugWrite({ target: "memory", addr, value, confirm: true });
      pushOut(`写内存 ${addr} ← 0x${value}`);
      await loadMemory(memAddr, memCount);
    } catch (e) {
      setError(msg(e));
    }
  };

  /** 行内写寄存器：32 位 HEX（内核白名单只允许 core 寄存器）。 */
  const commitReg = async (name: string, raw: string, orig: string) => {
    let v = raw.trim();
    if (v.toLowerCase().startsWith("0x")) v = v.slice(2);
    if (!/^[0-9a-fA-F]{1,8}$/.test(v)) {
      setError("寄存器值需 1–8 位 HEX（32 位）");
      return;
    }
    const value = v.padStart(8, "0").toLowerCase();
    setEditReg(null);
    const normOrig = orig.trim().toLowerCase().replace(/^0x/, "").padStart(8, "0");
    if (value === normOrig) return;
    try {
      await api.debugWrite({ target: "register", name, value, confirm: true });
      pushOut(`写寄存器 ${name} ← 0x${value}`);
      const r = await api.debugRegisters({ group: regGroup });
      setRegs(r.groups);
    } catch (e) {
      setError(msg(e));
    }
  };

  /** SVD 字段写：读-改-写（保留同寄存器其它位），按寄存器宽度写回。 */
  const commitField = async () => {
    const ef = editField;
    if (!ef) return;
    const raw = ef.value.trim();
    const num = raw.toLowerCase().startsWith("0x")
      ? Number.parseInt(raw.slice(2), 16)
      : Number.parseInt(raw, 10);
    const max = ef.width >= 32 ? 0x100000000 : 2 ** ef.width;
    if (!Number.isFinite(num) || num < 0 || num >= max) {
      setError(`字段 ${ef.width} 位，取值范围 0–${max - 1}`);
      return;
    }
    const mask = ef.width >= 32 ? 0xffffffff : (2 ** ef.width - 1);
    const cur = ef.base >>> 0;
    const next = ((cur & ~mask) | ((num << ef.offset) & mask)) >>> 0;
    const bytes = Math.max(1, Math.min(4, Math.ceil(ef.size / 8)));
    // 内核写内存按字节序列落盘（gdb -data-write-memory-bytes）；ARM 是小端：
    // 必须把整值拆成「低字节在前」，否则 0x0000a00f 会被写成 0x0fa00000。
    const value = Array.from({ length: bytes },
      (_, i) => ((next >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join("");
    setEditField(null);
    try {
      await api.debugWrite({ target: "memory", addr: ef.addr, value, confirm: true });
      pushOut(`写字段 ${ef.reg} ← ${raw}（寄存器 0x${value}）`);
      await loadSvd(ef.reg);
    } catch (e) {
      setError(msg(e));
    }
  };

  // ── 派生 ────────────────────────────────────────────────────
  const features = useMemo(
    () => snap?.features ?? debugFeatures ?? caps?.meta?.debug?.features ?? [],
    [snap, debugFeatures, caps],
  );
  const visibleTabs = TABS.filter((t) => !t.feature || features.includes(t.feature));
  const currentTab = visibleTabs.some((t) => t.id === tab) ? tab : visibleTabs[0]?.id;
  const stopped = snap?.state === "stopped";

  // P2：SVD 搜索 + 按 group 分组（折叠状态保存在本地）
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
      const r = await api.debugVariables({ frame, scope: "children", var: node.obj });
      setExpanded((prev) => ({ ...prev, [node.name]: r.nodes }));
    } catch (e) {
      setError(msg(e));
    }
  };

  const pickFrame = (idx: number) => {
    setFrame(idx);
    void loadVars(idx);
  };

  // ── 渲染 ────────────────────────────────────────────────────
  return (
    <div className={s.wrap}>
      <div className={s.toolbar}>
        {!snap ? (
          <>
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
              disabled={busy || running || !project || !caps?.meta?.debug?.available}
              onClick={() => void openSession()}
            >
              开始调试
            </Button>
            {!project ? <span className={s.hint}>先在左侧选工程</span> : null}
            {running ? <span className={s.hint}>有 run 在跑：串口/SWD 互斥</span> : null}
          </>
        ) : (
          <>
            <span className={s.stateChip} data-state={snap.state}>
              {snap.state}
            </span>
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
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (window.confirm("复位目标？（当前断点仍在）")) void control("reset", true);
              }}
            >
              复位
            </Button>
            <span className={s.spacer} />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void closeSession(true)}>
              关闭并运行
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void closeSession(false)}>
              关闭并停住
            </Button>
          </>
        )}
      </div>

      {error ? <div className={s.error}>{error}</div> : null}
      {bpToast ? <div className={s.toast}>{bpToast}</div> : null}

      {!snap ? (
        <div className={s.empty}>
          <div>
            <b>调试工作区</b>
            <p>{caps?.meta?.debug?.available
              ? "建立会话会复位目标、下载 ELF 并停在所选位置。"
              : "内核未提供调试能力（meta.debug 缺失）：请同步内核后重载。"}</p>
            {outLines.length > 0 ? (
              <pre className={s.pre}>{outLines.join("\n")}</pre>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={s.body}>
          <div className={s.tabs} role="tablist">
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={currentTab === t.id}
                className={currentTab === t.id ? s.tabActive : s.tab}
                onClick={() => setTab(t.id)}
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

            {currentTab === "regs" ? (
              <div className={s.list}>
                <div className={s.rowHead}>
                  <select
                    className={s.select}
                    value={regGroup}
                    onChange={(e) => setRegGroup(e.currentTarget.value as typeof regGroup)}
                  >
                    <option value="core">core</option>
                    <option value="fpu">fpu</option>
                    <option value="all">all</option>
                  </select>
                  <span className={s.dimText}>点寄存器可写（需 allow_write）</span>
                </div>
                {regs.map((g) => (
                  <div key={g.name}>
                    <div className={s.group}>{g.label}</div>
                    {g.regs.map((r) => {
                      const editable = r.editable && allowWrite;
                      const editing = editReg?.name === r.name;
                      return (
                        <div key={r.name} className={`${s.row} ${r.pc ? s.rowAccent : ""}`}>
                          <span className={s.mono}>{r.name}</span>
                          {editing ? (
                            <input
                              className={s.valueInput}
                              autoFocus
                              maxLength={10}
                              value={editReg.value}
                              aria-label={`编辑寄存器 ${r.name}`}
                              onChange={(e) => setEditReg({ ...editReg, value: e.currentTarget.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void commitReg(r.name, editReg.value, editReg.orig);
                                if (e.key === "Escape") setEditReg(null);
                              }}
                              onBlur={() => setEditReg(null)}
                            />
                          ) : (
                            <button
                              type="button"
                              className={editable ? s.valueEdit : s.value}
                              title={editable ? `点击改写 ${r.name}` : "不可写"}
                              onClick={() => editable ? setEditReg({ name: r.name, value: r.hex, orig: r.hex }) : undefined}
                            >
                              {r.hex}
                            </button>
                          )}
                          <span className={s.dimText}>{r.natural}</span>
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
                    placeholder="函数名或 *地址（如 HeartbeatTask）"
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
                {audit.map((a, i) => (
                  <div key={`${a.ts}-${i}`} className={s.row}>
                    <span className={s.dimText}>{new Date(a.ts * 1000).toLocaleTimeString()}</span>
                    <span className={s.badge}>{a.action}</span>
                    <span className={s.mono}>{a.target ?? a.location ?? a.id ?? ""}</span>
                    <span className={s.value}>{a.addr ?? a.name ?? ""} {a.value ?? ""}</span>
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
      )}
    </div>
  );
}
