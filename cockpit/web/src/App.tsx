import { useCallback, useEffect, useRef, useState } from "react";
import type { Capabilities, ProjectsResponse, StepId } from "./api/types";
import { api, assertSchema } from "./api/client";
import { openRunStream, type StreamHandle } from "./events/sse";
import { logs, type LogTab } from "./store/logs";
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

  const selectProject = useCallback(
    async (name: string) => {
      if (!name) return;
      selectedRef.current = name;
      setSelected(name);
      closeStream();
      resetRun();
      logs.clearAll();
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
    [attach, closeStream],
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
        const res = await api.startRun({ project, steps });
        closeStream();
        resetRun();
        logs.clearAll();
        setAutoScroll(true);
        attach(res.run);
      } catch (e) {
        setNotice(`启动失败：${errmsg(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [attach, closeStream],
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

  const card = catalog?.projects.find((p) => p.name === selected) ?? null;
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
          />
        }
        evidence={
          <EvidenceRail
            caps={caps}
            tab={layout.tab}
            onTab={(t: LogTab) => setTab(t)}
            autoScroll={autoScroll}
            onAutoScrollChange={setAutoScroll}
            onSerialWrite={null}
            serialPort={card?.serial.port || caps?.serial.host_default || ""}
            serialBaud={card?.serial.baud ?? caps?.serial.host_baud ?? 115200}
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
