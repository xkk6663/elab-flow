import { useCallback, useEffect, useRef, useState } from "react";
import type { Capabilities, ProjectCard, SerialMonitorSnapshot, StepId } from "../api/types";
import { api } from "../api/client";
import { logs } from "../store/logs";
import { useRun } from "../store/runStore";
import { workspacesFor, type WorkspaceDef, type WorkspaceId } from "../workspaces";
import { LogView, ringToText } from "../render/LogView";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { SegmentedTabs, type SegTab } from "../primitives/SegmentedTabs";
import { Switch } from "../primitives/Switch";
import { Tooltip } from "../primitives/Tooltip";
import { IconDownload, IconTerminal, IconTrash } from "../icons";
import { stepLabel } from "./StageRail";
import s from "./EvidenceRail.module.css";

export interface EvidenceRailProps {
  caps: Capabilities | null;
  /** 当前工程卡片 —— 单步按钮的可用性（`steps[id].ok` 与理由）与工具工作区都来自它 */
  card: ProjectCard | null;
  /** 有 run 在跑时单步/启动按钮全部置灰（串口/调试与 run 互斥） */
  running: boolean;
  /** 触发一个步骤（step id 或 `tool:<name>`）；null = 上层未接线（按钮置灰并说明） */
  onRunSteps: ((steps: string[]) => void) | null;
  /** 当前选中的工程名 —— 打开监视/手写要以它解析端口/波特率 */
  serialProject: string;
  serialPort: string;
  /** 当前工作区（一级导航选中项，持久化在 layoutStore） */
  ws: WorkspaceId;
  onWs: (id: WorkspaceId) => void;
}

/** 轮询间隔（ms）。600ms ≈ 人眼"实时"，又远低于服务端环形缓冲的挤出速度。 */
const MONITOR_POLL_MS = 600;

/** 常用波特率。工程配置里若是非标值，也插进列表 —— 否则 select 显示不出当前值 */
const COMMON_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function baudOptions(current: number): number[] {
  return COMMON_BAUDS.includes(current)
    ? COMMON_BAUDS
    : [...COMMON_BAUDS, current].sort((a, b) => a - b);
}

type Stats = { lines: number; alerts: number; dropped: number };

/**
 * 工作区面板（§5.4 右列）—— 一级导航切"作业台"，每个工作区只挂自己的东西：
 *   构建/烧录 = 闭环日志 + 对应单步按钮；串口 = 监视/手写/波特率；
 *   工具（单一 "tools" 页） = 可换行按钮行 + 所有工具共用的日志通道。
 *
 * ★ 工作区元数据全部来自 `workspaces.ts` 注册表（单一事实源）——
 *   导航项、快捷动作、置灰理由、空屏文案都从表里派生，
 *   加一个工作区 = 注册表加一条，本组件零改动。
 *
 * ★ 按需渲染：LogView 按 `key={ws.id}` 只挂当前工作区的通道；
 *   串口写入表单只在串口工作区存在；未激活工作区没有 DOM、没有订阅。
 */
export function EvidenceRail({
  caps,
  card,
  running,
  onRunSteps,
  serialProject,
  serialPort,
  ws,
  onWs,
}: EvidenceRailProps) {
  const [counts, setCounts] = useState<Record<string, Stats>>(() => logs.counts());
  const [draft, setDraft] = useState("");
  // 跟随滚动：纯本工作区 UI 态，不再提升到 App（瘦身）
  const [autoScroll, setAutoScroll] = useState(true);
  // 波特率覆盖：同理本地化。★ 语义不变：改后立即生效（无状态往返，不需要"重开端口"）
  const [baudOverride, setBaudOverride] = useState<number | null>(null);

  // 工作区解析：持久化的 id 在当前工程下不存在（如切了工程、yaml 改了 tools:）
  // 时回退到第一个 —— 绝不渲染未注册的工作区。
  const all = workspacesFor(card, caps);
  const active: WorkspaceDef = all.find((w) => w.id === ws) ?? all[0];

  // 波特率优先级：用户显式选的 → 工程配置 → 宿主默认 → 115200。
  // ★ 必须与后端 `serialterm.resolve_target()` 的顺序**一致**，否则会出现
  //   "界面显示 9600、实际按 115200 发"这种最难查的不一致。
  const serialBaud = baudOverride ?? card?.serial.baud ?? caps?.serial.host_baud ?? 115200;

  // 徽标计数：book 级单订阅（任何通道变化都惊动一次，250ms 节流）。
  // 通道是动态的，逐通道订阅会随工具数量膨胀；book 级订阅加通道零改动。
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        setCounts(logs.counts());
      }, 250);
    };
    const unsub = logs.subscribeAll(tick);
    return () => {
      if (timer) window.clearTimeout(timer);
      unsub();
    };
  }, []);

  // 只读 run 快照 —— 低频（run/* 与背压告警才变），不会拖累这里的日志渲染路径
  const run = useRun();

  // ── 常驻串口监视（serialmon）───────────────────────────────
  // 快照来源优先级：本组件拉到的 → capabilities 里那份（别的标签页开的会话）。
  const [mon, setMon] = useState<SerialMonitorSnapshot | null>(null);
  const monSnap: SerialMonitorSnapshot | null = mon ?? caps?.serial.monitor ?? null;
  const monActive = !!monSnap?.active;
  const afterRef = useRef(0);

  const toggleMonitor = useCallback(async () => {
    if (monActive) {
      try {
        await api.serialMonitorToggle("close");
        logs.local("serial", "── 监视已关闭 ──");
        setMon({ active: false });
      } catch (e) {
        logs.local("serial", `✗ 关闭监视失败：${e instanceof Error ? e.message : String(e)}`, "alert");
      }
      return;
    }
    try {
      const r = await api.serialMonitorToggle("open", { project: serialProject, baud: serialBaud });
      if (!r.active) {
        logs.local("serial", `✗ 打开监视失败：${r.error ?? "未知原因"}`, "alert");
        return;
      }
      afterRef.current = 0;
      setMon(r);
      logs.local("serial",
        `── 监视已打开 ${r.port}@${r.baud}（实时流只在本页缓冲，重载即失；` +
        `监视期间闭环/CLI 用不了串口 —— 约束 N5）──`);
    } catch (e) {
      // 409（闭环占用）等 —— 服务端已指名道姓，原样上屏
      logs.local("serial", `✗ 打开监视失败：${e instanceof Error ? e.message : String(e)}`, "alert");
    }
  }, [monActive, serialProject, serialBaud]);

  // 轮询增量读回。★ 不进 React 渲染树（logs.local 走命令式追加），重渲染极轻。
  useEffect(() => {
    if (!monActive) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await api.serialMonitor(afterRef.current);
        if (cancelled) return;
        setMon(st);
        if (st.gap > 0) {
          logs.local("serial", `── （服务端缓冲追不上：已挤掉 ≥${st.gap} 行）──`, "warn");
        }
        for (const ln of st.lines) logs.local("serial", ln.text);
        if (st.lines.length) afterRef.current = st.lines[st.lines.length - 1].seq;
        if (!st.active && st.error) {
          // 读线程异常自愈（拔线/口被抢）—— 服务端已收摊，这边如实收尾
          logs.local("serial", `✗ 监视已中断：${st.error}`, "alert");
          setMon({ active: false });
        }
      } catch {
        /* 网络抖动：下一轮再试 */
      }
    };
    void tick();
    const id = window.setInterval(tick, MONITOR_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [monActive]);

  /**
   * 手写通道（M3-b）：一次「写一条 → 收一小段回显」。
   * ★ 这些行**只在本机缓冲里**，重载页面就没了 —— 因为写通道不属于任何 run
   *   （它与 monitor 天然互斥：monitor 在跑时写不进去、也不该写），服务端**没有**
   *   对应事件可重放。与事件行的这个区别必须让人看得见，故用 `TX →` / `←` 前缀区分。
   * （此前提升在 App；工作区化后串口写是串口工作区自己的能力，随之下放。）
   */
  const doSerialWrite = useCallback(
    async (line: string) => {
      logs.local("serial", `TX → ${line}`, "warn");
      try {
        const r = await api.serial({ project: serialProject, data: line, baud: serialBaud });
        if (r.via === "monitor") {
          // ★ 监视会话开着：写进了已打开的口，回显会从实时监视流回来 ——
          //   本请求没有 echo 窗口，渲染话术必须分流（字段语义不同）。
          if (r.ok) {
            logs.local(
              "serial",
              `✓ 已发送 ${r.written}B → ${r.port}@${r.baud}（经监视会话）`,
            );
          } else {
            logs.local("serial", `✗ 发送失败：${r.error ?? "未知原因"}`, "alert");
          }
          return;
        }
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
        logs.local("serial", `✗ ${e instanceof Error ? e.message : String(e)}`, "alert");
      }
    },
    [serialProject, serialBaud],
  );

  // 写通道可用性：既要后端**真的支持写**（M3-b），也要有工程上下文。
  const writable = (caps?.serial.write_available ?? false) && !!serialProject;

  // ── 一级导航（工作区切换）─────────────────────────────────
  const tabs: Array<SegTab<WorkspaceId>> = all.map((w) => {
    const st = counts[w.channel];
    const isSerial = w.id === "serial";
    return {
      id: w.id,
      label: w.label,
      badge: isSerial && st && st.alerts > 0 ? st.alerts : (st?.lines ?? 0),
      tone: isSerial && st && st.alerts > 0 ? "alert" : "normal",
      dim: w.dim(card, caps),
      title: w.dim(card, caps) ? w.dimReason(card, caps) : undefined,
    };
  });

  const ring = logs.ring(active.channel);
  const st: Stats = counts[active.channel] ?? { lines: 0, alerts: 0, dropped: 0 };

  const doExport = useCallback(() => {
    const text = ringToText(ring);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `elab-${active.channel}.log`;
    a.click();
    // 立即 revoke 会让部分浏览器下载失败，延后一拍
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, [ring, active.channel]);

  return (
    <div className={s.rail}>
      <div className={s.head}>
        <SegmentedTabs tabs={tabs} value={active.id} onChange={onWs} size="sm" />
        <span className={s.spacer} />
        <Tooltip side="bottom" tip="导出当前工作区的纯文本日志">
          <Button variant="toolbar" onClick={doExport} aria-label="导出日志">
            <IconDownload />
          </Button>
        </Tooltip>
        <Tooltip side="bottom" tip="清空所有工作区的本地缓冲（不影响服务端 .jsonl，也不清服务端串口留档）">
          <Button
            variant="toolbar"
            onClick={() => logs.clearAll()}
            aria-label="清空日志缓冲"
          >
            <IconTrash />
          </Button>
        </Tooltip>
      </div>

      {/* ── 工具按钮行（工具工作区专属）──
          ★ 独立于顶栏 bar 且 **可换行**（flex-wrap）：4 个 OTA 工具按钮全挤进
            单行 bar 会横向溢出（用户截图"显示不全"的另一半根因）。
            "OTA 相关的单步步骤就该在 OTA 页里" —— 按钮住在工具页顶部，
            日志就在按钮下方，动作与输出同屏。 */}
      {active.steps.some((id) => id.startsWith("tool:")) ? (
        <div className={s.toolRow} role="toolbar" aria-label="项目工具">
          {active.steps
            .filter((id) => id.startsWith("tool:"))
            .map((id) => {
              const av = (card?.steps as Record<string, { ok: boolean; reason: string } | undefined> | undefined)?.[id];
              const ok = av?.ok ?? true;
              const tip = running
                ? "有 run 在跑：等它结束再发起工具"
                : !ok
                  ? av?.reason || "不可用"
                  : `运行项目工具（${id.slice(5)}），输出实时进本工作区`;
              return (
                <Tooltip key={id} tip={tip}>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={running || !ok || !onRunSteps}
                    onClick={() => onRunSteps?.([id as StepId])}
                  >
                    {ws_actionLabel(active, id, card)}
                  </Button>
                </Tooltip>
              );
            })}
        </div>
      ) : null}

      <div className={s.bar}>
        <Switch
          id="follow"
          checked={autoScroll}
          onChange={setAutoScroll}
          label="跟随"
        />
        <span className={s.spacer} />
        {/* ── 本工作区的快捷动作（注册表 ws.steps 驱动）──
            构建 Tab 里有「编译」、烧录 Tab 里有「烧录 / 调试校验」。
            工具按钮不在这里 —— 它们住上面独立的可换行按钮行（工具页专属）。
            按钮可用性与阶段轨同一份来源（`card.steps[id].ok`），两处置灰理由永远一致。 */}
        {active.steps
          .filter((id) => !id.startsWith("tool:"))
          .map((id) => {
            const av = (card?.steps as Record<string, { ok: boolean; reason: string } | undefined> | undefined)?.[id];
            const ok = av?.ok ?? true;
            const label = ws_actionLabel(active, id, card);
            const tip = !running
              ? !ok
                ? av?.reason || "不可用"
                : `只跑这一步：${stepLabel(id)}`
              : "有 run 在跑：串口/调试与 run 互斥，等它结束";
            return (
              <Tooltip key={id} tip={tip}>
                <Button
                  size="sm"
                  disabled={running || !ok || !onRunSteps}
                  onClick={() => onRunSteps?.([id as StepId])}
                >
                  {label}
                </Button>
              </Tooltip>
            );
          })}
        {/* ── 串口工作区：打开/关闭监视（常驻会话，不是闭环判定）── */}
        {active.id === "serial" ? (
          monActive ? (
            <Tooltip tip={`监视中：${monSnap?.port ?? "?"}@${monSnap?.baud ?? "?"} · 已收 ${monSnap?.seq ?? 0} 行 —— 点击关闭并释放串口`}>
              <Button size="sm" variant="outline" onClick={() => void toggleMonitor()}>
                关闭监视
              </Button>
            </Tooltip>
          ) : (
            <Tooltip tip={
              !caps?.serial.available
                ? (caps?.serial.hint ?? "串口后端不可用")
                : running
                  ? "有 run 在跑：串口/SWD 与 run 互斥（约束 N5），等它结束"
                  : !serialProject
                    ? "先在左侧选一个工程"
                    : `打开 ${serialPort || "auto"}@${serialBaud} 实时收流（占用串口直到关闭）`
            }>
              <Button
                size="sm"
                disabled={!caps?.serial.available || running || !serialProject}
                onClick={() => void toggleMonitor()}
              >
                打开监视
              </Button>
            </Tooltip>
          )
        ) : null}
        <span className={s.meta}>
          {st.lines} 行
          {st.alerts > 0 ? ` · ${st.alerts} 告警` : ""}
        </span>
      </div>

      {/* 服务端背压截断（`stream/overrun`，契约 §3.2 / §17.3）。
          ★ 与下面那条**必须分开显示**，因为它们的含义完全不同：
            下面那条是"浏览器自己的环形缓冲挤掉了旧行"（本地、可重来）；
            这条是"服务端来不及发给你"（传输层、真值只在服务端）。
            以前服务端丢弃只写了 `dropped += 1`，界面上没有任何痕迹 ——
            即"服务端如实报告了损失，界面却一个像素都没变"。 */}
      {run.overrun > 0 ? (
        <div className={s.warn}>
          服务端背压截断：为跟上消费速度，本条连接已丢弃 {run.overrun} 条
          {run.overrunScope ? ` ${run.overrunScope}` : ""} 事件。
          完整内容仍在服务端 <code>.proc.jsonl</code> 里，重载本页即可从事件日志补齐。
        </div>
      ) : null}

      {st.dropped > 0 ? (
        <div className={s.warn}>
          日志已截断：环形缓冲容量 4000 行，已丢弃最早的 {st.dropped} 行。
          完整内容仍在服务端 <code>.proc.jsonl</code> 里。
        </div>
      ) : null}

      <LogView
        key={active.id}
        ring={ring}
        autoScroll={autoScroll}
        onAutoScrollChange={setAutoScroll}
        empty={active.emptyText(card, caps)}
      />

      {/* ── 串口手动输入（M3-b 已通：写一条 → 收一段回显，一次请求内闭环）──
          ★ 只在串口工作区挂载（按需渲染） */}
      {active.id === "serial" ? (
        <form
          className={s.write}
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim() || !writable) return;
            void doSerialWrite(draft);
            setDraft("");
          }}
        >
          <IconTerminal className={s.writeIcon} />
          <Input
            mono
            placeholder={
              writable
                ? "输入一行并按回车发送到设备"
                : "串口写通道不可用（后端不支持写，或尚未选择工程）"
            }
            aria-label="串口手动输入"
            value={draft}
            disabled={!writable}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <span className={s.portTag} title={caps?.serial.hint ?? ""}>
            {serialPort || "auto"}
          </span>
          <select
            className={s.baud}
            value={serialBaud}
            onChange={(e) => setBaudOverride(Number(e.currentTarget.value))}
            title="波特率：改后立即生效（下一次发送即用新值）"
            aria-label="串口波特率"
            disabled={!writable}
          >
            {baudOptions(serialBaud).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </form>
      ) : null}
    </div>
  );
}

/** 工作区快捷动作的按钮文案：工具用 card.tools 声明的业务名
 *  （如「OTA 升级」—— yaml 的 tools[].label 是唯一事实源），
 *  其余用步骤名；单步工作区的 actionLabel 仍作 fallback。 */
function ws_actionLabel(w: WorkspaceDef, stepId: string, card: ProjectCard | null): string {
  if (stepId.startsWith("tool:")) {
    const name = stepId.slice(5);
    const t = (card?.tools ?? []).find((x) => x.name === name);
    return t?.label ?? stepLabel(stepId);
  }
  if (w.actionLabel && w.steps.length === 1 && w.steps[0] === stepId) return w.actionLabel;
  return stepLabel(stepId);
}
