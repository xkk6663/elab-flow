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
function rowDump(addr: string, bytes: string[]): Array<{ addr: string; hex: string; ascii: string }> {
  const base = Number.parseInt(addr, 16);
  const rows: Array<{ addr: string; hex: string; ascii: string }> = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    rows.push({
      addr: `0x${(base + i).toString(16).padStart(8, "0")}`,
      hex: chunk.join(" ").padEnd(47, " "),
      ascii: chunk.map((b) => {
        const n = Number.parseInt(b, 16);
        return n >= 32 && n < 127 ? String.fromCharCode(n) : ".";
      }).join(""),
    });
  }
  return rows;
}

export function DebugWorkspace({ caps, project, running }: DebugWorkspaceProps) {
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
      .then((x) => { setBps(x.breakpoints); setRev(x.rev ?? 0); })
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
      void refreshCommon();
      pushOut(`停止：${e.data}`);
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
    es.addEventListener("debug/stop", onStop);
    es.addEventListener("debug/state", onState);
    es.addEventListener("debug/closed", onClosed);
    es.addEventListener("debug/output", onOutput);
    es.addEventListener("debug/error", onError);
    return () => es.close();
  }, [refreshCommon, setSession, pushOut]);

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

  const writeMem = async () => {
    const addr = window.prompt("写内存：目标地址（HEX）", memAddr);
    if (!addr) return;
    const value = window.prompt("写入字节（HEX，空格分隔，如 01 02 03）", "");
    if (!value) return;
    if (!window.confirm(`确认写入 ${addr} ← ${value}？（会记入审计）`)) return;
    try {
      await api.debugWrite({ target: "memory", addr, value });
      pushOut(`写内存 ${addr} ← ${value}`);
      await loadMemory(addr, memCount);
    } catch (e) {
      setError(msg(e));
    }
  };

  const writeReg = async (name: string) => {
    const value = window.prompt(`写寄存器 ${name}（HEX/十进制）`, "");
    if (!value) return;
    if (!window.confirm(`确认写寄存器 ${name} ← ${value}？`)) return;
    try {
      await api.debugWrite({ target: "register", name, value });
      pushOut(`写寄存器 ${name} ← ${value}`);
      const r = await api.debugRegisters({ group: regGroup });
      setRegs(r.groups);
    } catch (e) {
      setError(msg(e));
    }
  };

  // ── 派生 ────────────────────────────────────────────────────
  const features = useMemo(
    () => snap?.features ?? caps?.meta?.debug?.features ?? [],
    [snap, caps],
  );
  const visibleTabs = TABS.filter((t) => !t.feature || features.includes(t.feature));
  const currentTab = visibleTabs.some((t) => t.id === tab) ? tab : visibleTabs[0]?.id;
  const stopped = snap?.state === "stopped";
  const allowWrite = caps?.meta?.debug?.available ?? false; // 会话 open 时已带 allow_write

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
                    {g.regs.map((r) => (
                      <button
                        key={r.name}
                        type="button"
                        className={`${s.row} ${r.pc ? s.rowAccent : ""}`}
                        title={r.editable && allowWrite ? "点击写寄存器" : "不可写"}
                        onClick={() => r.editable && allowWrite ? void writeReg(r.name) : undefined}
                      >
                        <span className={s.mono}>{r.name}</span>
                        <span className={s.value}>{r.hex}</span>
                        <span className={s.dimText}>{r.natural}</span>
                      </button>
                    ))}
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
                  <Button size="sm" variant="outline" disabled={!allowWrite} onClick={() => void writeMem()}>
                    写内存
                  </Button>
                </div>
                {mem ? (
                  <div className={s.memWrap}>
                    <pre className={s.mem}>
                      {rowDump(mem.addr, hexBytes(mem.bytes)).map((line) => (
                        <div key={line.addr}>{`${line.addr}  ${line.hex}`}</div>
                      ))}
                    </pre>
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
                {disasm?.instructions.map((ins: DebugDisasmLine) => (
                  <div key={ins.addr} className={`${s.row} ${ins.pc ? s.rowAccent : ""}`}>
                    <span className={s.mono}>{ins.addr}</span>
                    <span className={s.mono}>{ins.mnemonic} {ins.operands}</span>
                    {ins.symbol ? <span className={s.dimText}>{ins.symbol}</span> : null}
                    {ins.pc ? <span className={s.badge}>PC</span> : null}
                  </div>
                ))}
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
                  <span className={s.spacer} />
                  {svd?.level === "peripheral" ? (
                    <button type="button" className={s.link}
                            onClick={() => void loadSvd(svd.peripheral?.name ?? "")}>刷新</button>
                  ) : null}
                </div>
                {svd?.level === "device" ? (
                  <div className={s.grid}>
                    {(svd.peripherals ?? []).map((p) => (
                      <button key={p.name} type="button" className={s.card}
                              onClick={() => void loadSvd(p.name)}>
                        <b>{p.name}</b>
                        <span>{p.base}</span>
                        <span>{p.registers_count ?? 0} 寄存器</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {svd?.level === "peripheral" ? (
                  <div>
                    <div className={s.rowHead}>
                      <b>{svd.peripheral?.name}</b>
                      <span className={s.dimText}>{svd.peripheral?.base}</span>
                      <span className={s.dimText}>{svd.peripheral?.description}</span>
                    </div>
                    {(svd.peripheral?.registers ?? []).map((r) => (
                      <button key={r.name} type="button" className={s.row}
                              onClick={() => void loadSvd(`${svd.peripheral?.name}.${r.name}`)}>
                        <span className={s.mono}>{r.name}</span>
                        <span className={s.dimText}>{r.addr}</span>
                        <span className={s.dimText}>{r.access}</span>
                        <span className={s.value}>{r.fields_count ? `${r.fields_count} 字段` : ""}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {svd?.level === "register" && svd.register ? (
                  <div>
                    <div className={s.rowHead}>
                      <b>{svd.peripheral?.name}.{svd.register.name}</b>
                      <span className={s.value}>{svd.register.value ?? "—"}</span>
                      <span className={s.dimText}>{svd.register.description}</span>
                    </div>
                    {(svd.register.fields ?? []).map((f) => (
                      <div key={f.name} className={s.row}>
                        <span className={s.mono}>{f.name}</span>
                        <span className={s.dimText}>[{f.bits}]</span>
                        <span className={s.value}>{f.enum ? `${f.enum.name} (${f.enum.value})` : `${f.value} (${f.hex})`}</span>
                        <span className={s.dimText}>{f.description}</span>
                      </div>
                    ))}
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
