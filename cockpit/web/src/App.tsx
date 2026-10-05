import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Capabilities,
  ProjectsResponse,
  SerialConsoleRecord,
  StepId,
} from "./api/types";
import { api, assertSchema } from "./api/client";
import { openRunStream, type StreamHandle } from "./events/sse";
import { logs, type LogLine, type LogTab } from "./store/logs";
import {
  markStreamClosed,
  reset as resetRun,
  useRun,
} from "./store/runStore";
import { cycleTheme, useTheme, type ThemeMode } from "./store/themeStore";
import { LIMITS, setFontScale, setTab, useLayout } from "./store/layoutStore";
import { AppFrame } from "./AppFrame";
import { ProjectsRail } from "./rails/ProjectsRail";
import { StageRail } from "./rails/StageRail";
import { EvidenceRail } from "./rails/EvidenceRail";
import { Button } from "./primitives/Button";
import { Pill } from "./primitives/Tag";
import { Tooltip } from "./primitives/Tooltip";
import { IconAlert, IconMoon, IconMonitor, IconSun, IconTerminal } from "./icons";
import s from "./App.module.css";

function errmsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const THEME_ICON: Record<ThemeMode, typeof IconSun> = {
  light: IconSun,
  dark: IconMoon,
  system: IconMonitor,
};

/**
 * 进入串口 Tab 时回填多少条服务端留档。
 *
 * ★ 60 条 ≈ 30 次手敲往返 —— 够看清"我刚做过什么"，又不至于把证据轨淹掉。
 *   取多了还有一个坏处：留档是**会滚动**的（`MAX_RECORDS=2000`），
 *   一次回填 2000 行会让人误以为"这些永远不会丢"，与本文件里反复强调的
 *   那句"留档不是 state"相矛盾。
 */
const SERIAL_HISTORY_LIMIT = 60;

/**
 * console 留档的一条 → 证据轨的一行。
 *
 * ★ 前缀刻意与**实时**手写通道逐字一致（`TX →` / `←`）：同一件事不该因为
 *   "这行是读回来的"就换一种写法。区别体现在**行首的时间戳**上 ——
 *   实时行没有（它刚发生），留档行有（它可能发生在几小时前）。
 */
function serialRecToLine(rec: SerialConsoleRecord): { text: string; tone?: LogLine["tone"] } {
  // `t` 形如 "2026-10-05T14:03:11"（服务端本地时间，已格式化好）
  const stamp = String(rec.t || "").slice(11, 19) || "--:--:--";
  if (rec.dir === "tx") {
    return {
      text: `✎ ${stamp}  TX → ${rec.text}`,
      tone: rec.ok === false ? "alert" : "warn",
    };
  }
  return { text: `   ${stamp}  ← ${rec.text}` };
}

export default function App() {
  const layout = useLayout();
  const theme = useTheme();
  const run = useRun();

  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [catalog, setCatalog] = useState<ProjectsResponse | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [conn, setConn] = useState<"idle" | "connecting" | "open" | "reconnecting">("idle");
  // M2 运行参数。**故意不放 localStorage**：`--clean` 会真删工作目录，
  // 把它持久化成"下次默认开启"是一个会咬人的默认值。
  const [clean, setClean] = useState(false);
  const [jobs, setJobs] = useState<number | null>(null);
  // 串口手写通道（M3-b）的波特率覆写。null = "还没改过，跟工程/宿主默认走"。
  const [baudOverride, setBaudOverride] = useState<number | null>(null);

  const streamRef = useRef<StreamHandle | null>(null);
  const selectedRef = useRef("");

  const closeStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    setConn("idle");
  }, []);

  /**
   * 把一个 run 的完整事件流接进来。
   *
   * ★ **只用 SSE 一条路**（不区分"历史 / 实时"）：服务端 `_sse()` 的策略本就是
   *   "先重放 `after_seq` 之后的存量，再跟读活队列"，所以历史 run 会走
   *   重放分支并以 `stream/closed(run-finished)` 收尾，实时 run 会走队列分支。
   *   两条路径在服务端已统一，前端就不必再分叉 —— 少一条分支就少一类竞态。
   */
  const attach = useCallback(
    (runId: string) => {
      closeStream();
      setConn("connecting");
      streamRef.current = openRunStream(runId, {
        from: 0,
        onState: (st) => setConn(st),
        onClosed: (reason) => {
          setConn("idle");
          markStreamClosed(reason);
          if (reason === "unknown-run") {
            setNotice(`找不到 run ${runId} 的事件文件（可能已被清理）`);
          }
        },
      });
    },
    [closeStream],
  );

  /**
   * 回填**服务端**的串口留档（M3-b2）。
   *
   * ★ 时机是"每次清空本地缓冲之后、挂上 SSE 之前"，而不是"进串口 Tab 时"：
   *   证据轨的 `LogView` 是纯追加渲染，**没有**"插入历史到顶部"的能力。
   *   若等用户切到串口 Tab 再回填，那时实时 monitor 行可能已经在缓冲里了，
   *   回填只会接在后面 —— 看起来就是**时间倒错**（旧命令排在新的设备输出之后）。
   *   在清空之后立刻回填，顺序天然正确：留档在前、实时在后。
   *
   * ★ 失败**静默**：留档读不出来不该挡住跑闭环。串口本身能用才是要紧事 ——
   *   这正是"console 日志不是 state"的另一面：它是锦上添花，不是判据。
   */
  const backfillSerial = useCallback(async (project: string) => {
    if (!project) return;
    try {
      const r = await api.serialConsole(SERIAL_HISTORY_LIMIT);
      // 留档是**全局**的（同一个端口可能被多个工程用过），按 `project` 过滤。
      // 没写 project 的老记录一律保留 —— 宁可多显示一行，也别把历史吞掉。
      const mine = r.records.filter((x) => !x.project || x.project === project);
      if (!mine.length) return;
      const more = r.count > r.records.length;
      logs.history("serial", [
        {
          text:
            `── 服务端串口留档：本工程 ${mine.length} 条` +
            (more ? `（服务端共 ${r.count} 条，已载入最近 ${r.records.length} 条）` : "") +
            " ──",
        },
        ...mine.map(serialRecToLine),
        { text: "── 留档到此为止，以下是本次会话 ──" },
      ]);
    } catch {
      /* 静默：见上 */
    }
  }, []);

  const selectProject = useCallback(
    async (name: string) => {
      if (!name) return;
      selectedRef.current = name;
      setSelected(name);
      closeStream();
      resetRun();
      logs.clearAll();
      // ★ 必须 await：要保证留档先落进缓冲，attach() 的实时重放才接在它后面
      await backfillSerial(name);
      setAutoScroll(true);
      setNotice(null);
      try {
        const { runs, active } = await api.runs();
        // ① 正在跑的优先（可能是 agent 在别处启动的）。
        //    ★ 必须**按 started_at 取最新**，不能 `find()` 取第一个：
        //      同一工程可能同时存在多条记录（服务端登记簿的历史条目、
        //      或真并发两个 run），`find` 拿到的顺序不保证是"最新的"。
        //      实测踩过：新起 build-only，界面却挂到上一条已结束的 doctor+build，
        //      把旧日志当成本次现场 —— 正是"取到了更早那条"。
        const live = active
          .filter((a) => a.project === name && a.alive !== false)
          .sort((a, b) => b.started_at - a.started_at)[0];
        if (live) {
          attach(live.run);
          return;
        }
        // ② 没有在跑的 → 显示该工程最近一次的留档（这样页面刷新后仍能看到上次结果）
        const mine = runs.filter((r) => r.project === name);
        mine.sort((a, b) => b.started_at - a.started_at);
        if (mine[0]) attach(mine[0].run);
      } catch (e) {
        setNotice(`读取运行列表失败：${errmsg(e)}`);
      }
    },
    [attach, backfillSerial, closeStream],
  );

  const loadAll = useCallback(
    async (autoSelect: boolean) => {
      setLoading(true);
      try {
        const c = await api.capabilities();
        // ★ 先校验契约版本再渲染。不做这一步的代价：后端改了字段名，前端
        //   仍能画出界面但数据错位（内存表盘永远 0%），极难排查（§17 的教训）。
        await assertSchema(c);
        const p = await api.projects();
        setCaps(c);
        setCatalog(p);
        setFatal(null);
        if (autoSelect) {
          const want =
            selectedRef.current && p.projects.some((x) => x.name === selectedRef.current)
              ? selectedRef.current
              : (p.projects[0]?.name ?? "");
          if (want) await selectProject(want);
        }
      } catch (e) {
        setFatal(errmsg(e));
      } finally {
        setLoading(false);
      }
    },
    [selectProject],
  );

  useEffect(() => {
    void loadAll(true);
    return () => closeStream();
  }, [loadAll, closeStream]);

  const startRun = useCallback(
    async (steps?: StepId[]) => {
      const project = selectedRef.current;
      if (!project) return;
      setBusy(true);
      setNotice(null);
      try {
        const res = await api.startRun({
          project,
          steps,
          clean: clean || undefined,
          jobs: jobs ?? undefined,
        });
        closeStream();
        resetRun();
        logs.clearAll();
        // 与 selectProject 同理：留档先落，实时 monitor 行再接上去。
        // 手写通道与闭环互斥（N5），所以这里的留档必定是**这次**跑之前的 —— 不会串味。
        await backfillSerial(project);
        setAutoScroll(true);
        attach(res.run);
      } catch (e) {
        setNotice(`启动失败：${errmsg(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [attach, backfillSerial, closeStream, clean, jobs],
  );

  const cancelRun = useCallback(async () => {
    const rid = run.run;
    if (!rid) return;
    try {
      const res = await api.cancelRun(rid);
      if (!res.ok) setNotice(res.error || "取消失败");
    } catch (e) {
      setNotice(`取消失败：${errmsg(e)}`);
    }
  }, [run.run]);

  const onSelect = useCallback(
    (name: string) => {
      void selectProject(name);
    },
    [selectProject],
  );

  /**
   * 一键适配写入成功后的收尾（M5.6）：刷新目录（让新 `projects/<name>.yaml`
   * 变成卡片）并选中新工程。顺序不能反 —— selectProject 不依赖 catalog，
   * 但用户看到的列表必须已经包含新卡片。
   */
  const onAdapted = useCallback(
    (name: string) => {
      void (async () => {
        await loadAll(false);
        await selectProject(name);
      })();
    },
    [loadAll, selectProject],
  );

  const card = catalog?.projects.find((p) => p.name === selected) ?? null;
  // 波特率优先级：用户显式选的 → 工程配置 → 宿主默认 → 115200。
  // ★ 必须与后端 `serialterm.resolve_target()` 的顺序**一致**，否则会出现
  //   "界面显示 9600、实际按 115200 发"这种最难查的不一致。
  const serialBaud = baudOverride ?? card?.serial.baud ?? caps?.serial.host_baud ?? 115200;
  const serialPort = card?.serial.port || caps?.serial.host_default || "";

  /**
   * 手写通道（M3-b）：一次「写一条 → 收一小段回显」。
   *
   * ★ 这些行**只在本机缓冲里**，重载页面就没了 —— 因为写通道不属于任何 run
   *   （它与 monitor 天然互斥：monitor 在跑时写不进去、也不该写），服务端**没有**
   *   对应事件可重放。与事件行的这个区别必须让人看得见，故用 `TX →` / `←` 前缀区分。
   */
  const doSerialWrite = useCallback(
    async (line: string) => {
      const project = selectedRef.current;
      logs.local("serial", `TX → ${line}`, "warn");
      try {
        const r = await api.serial({ project, data: line, baud: serialBaud });
        if (!r.ok) {
          logs.local("serial", `✗ 发送失败：${r.error ?? "未知原因"}`, "alert");
          return;
        }
        logs.local(
          "serial",
          `✓ 已发送 ${r.written}B → ${r.port}@${r.baud}（${r.backend}/${r.layer}）`,
        );
        for (const ln of r.echoed) logs.local("serial", `← ${ln}`);
        if (!r.echoed.length) {
          logs.local(
            "serial",
            `（${r.read_ms}ms 窗口内无回显 —— 设备不回应也可能是正常的）`,
          );
        }
      } catch (e) {
        logs.local("serial", `✗ ${errmsg(e)}`, "alert");
      }
    },
    [serialBaud],
  );
  const ThemeIcon = THEME_ICON[theme];

  if (fatal) {
    return (
      <div className={s.fatal}>
        <IconAlert className={s.fatalIcon} />
        <h1 className={s.fatalTitle}>驾驶舱无法启动</h1>
        <p className={s.fatalMsg}>{fatal}</p>
        <pre className={s.fatalCmd}>python -m cockpit.server</pre>
        <p className={s.fatalHint}>
          后端与前端是同一份契约（<code>docs/ICD_cockpit_events.md</code>）。
          上面这条错误要么是后端没起、要么是前后端契约版本不一致。
        </p>
        <Button variant="primary" onClick={() => void loadAll(true)}>
          重试
        </Button>
      </div>
    );
  }

  const header = (
    <>
      <span className={s.brand}>elab cockpit</span>
      <Pill tone={conn === "open" ? "green" : conn === "idle" ? "neutral" : "blue"}>
        {conn === "idle" ? "空闲" : conn === "open" ? "已连接" : "连接中"}
      </Pill>
      {caps ? (
        <Tooltip side="bottom" tip={`契约版本 ${caps.schema_version} · 根目录 ${caps.root}`}>
          <span className={s.ver}>v{caps.cockpit.version}</span>
        </Tooltip>
      ) : null}
      <span className={s.headerSpacer} />
      {caps ? (
        <Tooltip
          side="bottom"
          tip={
            caps.serial.available
              ? `串口后端就绪（layer=${caps.serial.layer}）`
              : (caps.serial.hint ?? "串口后端不可用")
          }
        >
          <span className={s.serialChip}>
            <IconTerminal className={s.serialIcon} />
            {caps.serial.available ? `${caps.serial.ports.length} 个口` : "串口不可用"}
          </span>
        </Tooltip>
      ) : null}
      {/* ★ 顶栏的 tooltip 必须 side="bottom"：触发器贴着视口顶部，默认朝上开
          会被 html/body/#root 的 overflow:hidden 裁掉，等于"提示永远不出现"。
          实测就是这么发现的（hover 顶栏按钮时可见 tooltip 数为 0）。 */}
      <Tooltip side="bottom" tip={`字号（当前 ${layout.fontScale.toFixed(2)}×）`}>
        <span className={s.fontCtl}>
          <button
            type="button"
            className={s.fontBtn}
            onClick={() => setFontScale(layout.fontScale - 0.05)}
            disabled={layout.fontScale <= LIMITS.fontScale.min + 1e-6}
            aria-label="缩小字号"
          >
            A−
          </button>
          <button
            type="button"
            className={s.fontBtn}
            onClick={() => setFontScale(layout.fontScale + 0.05)}
            disabled={layout.fontScale >= LIMITS.fontScale.max - 1e-6}
            aria-label="放大字号"
          >
            A+
          </button>
        </span>
      </Tooltip>
      <Tooltip side="bottom" tip={`主题：${theme}（点击循环 系统→亮→暗）`}>
        <Button variant="toolbar" onClick={cycleTheme} aria-label="切换主题">
          <ThemeIcon />
        </Button>
      </Tooltip>
    </>
  );

  return (
    <div className={s.shell}>
      <AppFrame
        header={header}
        projects={
          <ProjectsRail
            cards={catalog?.projects ?? []}
            selected={selected}
            onSelect={onSelect}
            caps={caps}
            locked={run.status === "running"}
            loading={loading}
            onAdapted={onAdapted}
          />
        }
        stage={
          <StageRail
            card={card}
            run={run}
            caps={caps}
            busy={busy}
            onRunAll={() => void startRun()}
            onRunSteps={(steps) => void startRun(steps)}
            onCancel={() => void cancelRun()}
            onRefresh={() => void loadAll(false)}
            clean={clean}
            onCleanChange={setClean}
            jobs={jobs}
            onJobsChange={setJobs}
          />
        }
        evidence={
          <EvidenceRail
            caps={caps}
            tab={layout.tab}
            onTab={(t: LogTab) => setTab(t)}
            autoScroll={autoScroll}
            onAutoScrollChange={setAutoScroll}
            onSerialWrite={doSerialWrite}
            serialPort={serialPort}
            serialBaud={serialBaud}
            onSerialBaudChange={setBaudOverride}
          />
        }
        compactSelector={
          <select
            className={s.select}
            value={selected}
            onChange={(e) => onSelect(e.currentTarget.value)}
            aria-label="选择工程"
          >
            {(catalog?.projects ?? []).map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} · {p.chip}
              </option>
            ))}
          </select>
        }
      />

      {notice ? (
        <div className={s.notice} role="status">
          <IconAlert className={s.noticeIcon} />
          <span className={s.noticeText}>{notice}</span>
          <button
            type="button"
            className={s.noticeClose}
            onClick={() => setNotice(null)}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
