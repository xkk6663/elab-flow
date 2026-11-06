import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Capabilities, ProjectCard, StepId } from "../api/types";
import { api } from "../api/client";
import { logs } from "../store/logs";
import { useRun } from "../store/runStore";
import { workspacesFor, type WorkspaceDef, type WorkspaceId } from "../workspaces";
import { LogView, ringToText } from "../render/LogView";
import { useSerialStream } from "../serial/useSerialStream";
import { SerialWorkspace } from "../serial/SerialWorkspace";
import { DebugWorkspace } from "../debug/DebugWorkspace";
import { ModbusWorkspace } from "../modbus/ModbusWorkspace";
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

/** 常用波特率。工程配置里若是非标值，也插进列表 —— 否则 select 显示不出当前值 */
const COMMON_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function baudOptions(current: number): number[] {
  return COMMON_BAUDS.includes(current)
    ? COMMON_BAUDS
    : [...COMMON_BAUDS, current].sort((a, b) => a - b);
}

/** 端口/波特率/线参数偏好：用户级 UI 选择，跨刷新保留（localStorage 不可写时只在本次会话生效） */
const PORT_PREF_KEY = "elab.serial.port";
const BAUD_PREF_KEY = "elab.serial.baud";
const LINE_PREF_KEY = "elab.serial.line";
/** 连接方式偏好（M4）：serial / tcp-client / tcp-server / udp */
const TRANSPORT_PREF_KEY = "elab.serial.transport";
/** 网络配置偏好（M4）：{host, port, allow_remote} */
const NET_PREF_KEY = "elab.serial.net";
/** 「非回环警告已确认」标记：只弹一次，之后尊重用户的选择 */
const REMOTE_WARN_KEY = "elab.serial.allow_remote_warned";

function loadPortPref(): string | null {
  try {
    const v = window.localStorage.getItem(PORT_PREF_KEY);
    return v !== null && v !== "" ? v : null;
  } catch {
    return null;
  }
}

function loadBaudPref(): number | null {
  try {
    const n = Number(window.localStorage.getItem(BAUD_PREF_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function loadLinePref(): string | null {
  try {
    const v = window.localStorage.getItem(LINE_PREF_KEY);
    return v !== null && v !== "" ? v : null;
  } catch {
    return null;
  }
}

function loadTransportPref(): string | null {
  try {
    const v = window.localStorage.getItem(TRANSPORT_PREF_KEY);
    return v !== null && v !== "" ? v : null;
  } catch {
    return null;
  }
}

export interface NetPref {
  host: string;
  port: number;
  allow_remote: boolean;
}

function loadNetPref(): NetPref | null {
  try {
    const raw = window.localStorage.getItem(NET_PREF_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<NetPref>;
    const port = Number(j.port);
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host: String(j.host ?? "127.0.0.1"), port,
      allow_remote: Boolean(j.allow_remote) };
  } catch {
    return null;
  }
}

/** 线参数文本（`7E1` / `7E1:rtscts`）→ 可编辑部件。非法文本回退 8N1。 */
function parseLine(text: string): {
  bits: number; parity: string; stop: string; flow: string;
} {
  const m = /^([5-8])([NEOMS])(1\.5|1|2)(?:[-:/]([A-Za-z]+))?$/.exec(text.trim());
  if (!m) return { bits: 8, parity: "N", stop: "1", flow: "none" };
  return { bits: Number(m[1]), parity: m[2], stop: m[3],
    flow: (m[4] || "none").toLowerCase() };
}

/** 部件 → 内核接受的文本形式（无流控时不带后缀）。 */
function composeLine(p: { bits: number; parity: string; stop: string; flow: string }): string {
  const base = `${p.bits}${p.parity}${p.stop}`;
  return p.flow === "none" ? base : `${base}:${p.flow}`;
}

function savePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 忽略：偏好仅本次会话有效 */
  }
}

/** 传输种类的人话标签：未登记的 kind 直接显示原值（不猜）。 */
const TRANSPORT_LABELS: Record<string, string> = {
  serial: "串口",
  "tcp-client": "TCP 客户端",
  "tcp-server": "TCP 服务端",
  udp: "UDP",
};

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
  serialPort: serialPortBase,
  ws,
  onWs,
}: EvidenceRailProps) {
  const [counts, setCounts] = useState<Record<string, Stats>>(() => logs.counts());
  const [draft, setDraft] = useState("");
  // 跟随滚动：纯本工作区 UI 态，不再提升到 App（瘦身）
  const [autoScroll, setAutoScroll] = useState(true);
  // 波特率覆盖：同理本地化。★ 语义不变：改后立即生效（无状态往返，不需要"重开端口"）
  const [baudOverride, setBaudOverride] = useState<number | null>(loadBaudPref);
  // 端口覆盖：用户显式选择优先于工程配置/宿主默认；打开监视时按它解析
  const [portOverride, setPortOverride] = useState<string | null>(loadPortPref);
  // 线参数覆盖（M1）：打开时属性 —— 改后需重开监视才生效
  const [lineOverride, setLineOverride] = useState<string | null>(loadLinePref);
  // 连接方式 + 网络配置（M4）：默认 serial；网络传输默认只绑 127.0.0.1
  const [transportOverride, setTransportOverride] = useState<string | null>(loadTransportPref);
  const [netPref, setNetPref] = useState<NetPref | null>(loadNetPref);

  // 工作区解析：持久化的 id 在当前工程下不存在（如切了工程、yaml 改了 tools:）
  // 时回退到第一个 —— 绝不渲染未注册的工作区。
  const all = workspacesFor(card, caps);
  const active: WorkspaceDef = all.find((w) => w.id === ws) ?? all[0];

  // 波特率优先级：用户显式选的 → 工程配置 → 宿主默认 → 115200。
  // ★ 必须与后端 `serialterm.resolve_target()` 的顺序**一致**，否则会出现
  //   "界面显示 9600、实际按 115200 发"这种最难查的不一致。
  const serialBaud = baudOverride ?? card?.serial.baud ?? caps?.serial.host_baud ?? 115200;

  // 端口优先级：用户显式选的 → 工程配置 → 宿主默认 → auto。
  // ★ `auto` 把选择权交给内核（USB 优先、排蓝牙、有歧义就报错，不猜）。
  const serialPort = portOverride ?? serialPortBase;

  // 线参数优先级：用户显式选的 → 工程配置 → 宿主默认 → 8N1。
  // ★ 与 `serialtransport.resolve()` 同一顺序；线参数是**打开时属性**，
  //   改后需重开监视/重新发送才生效（这不是"没生效"的 bug，是串口的事实）。
  const cardLine = card?.serial.line;
  const serialLine = lineOverride
    ?? (typeof cardLine === "string" ? cardLine : cardLine?.text)
    ?? caps?.serial.host_line?.text
    ?? "8N1";

  // ── 连接方式（M4）─────────────────────────────────────────────
  // 优先级与 `serialtransport.resolve()` 一致：本页覆盖 → 工程 serial.transport
  // → 内核自描述默认（serial）。传输种类来自 `meta.serial.transports`，
  // 面板只渲染，不写死业务名词（内核过旧时才用下面这份最小兜底清单）。
  const transportKinds: string[] = caps?.meta?.serial?.transports?.kinds
    ?? ["serial", "tcp-client", "tcp-server", "udp"];
  const transport = transportOverride ?? card?.serial?.transport
    ?? caps?.meta?.serial?.transports?.default ?? "serial";
  const isNet = transport !== "serial";
  const netDefaults = caps?.meta?.serial?.transports?.net?.defaults?.[transport] ?? {};
  const projNet = card?.serial?.net ?? {};
  const netHost = netPref?.host
    ?? String(projNet.host ?? projNet.bind ?? netDefaults.host ?? netDefaults.bind ?? "127.0.0.1");
  const netPort = netPref?.port
    ?? Number(projNet.port ?? netDefaults.port ?? 9000);
  const netAllowRemote = netPref?.allow_remote
    ?? Boolean(projNet.allow_remote ?? false);
  /** `tcp-client` 要 host，`tcp-server`/`udp` 要 bind —— 同一份解析器的两个键。 */
  const netPayload = useMemo(() => {
    if (!isNet) return undefined;
    return transport === "tcp-client"
      ? { host: netHost, port: netPort, allow_remote: netAllowRemote }
      : { bind: netHost, port: netPort, allow_remote: netAllowRemote };
  }, [isNet, transport, netHost, netPort, netAllowRemote]);
  const saveNet = (next: NetPref): void => {
    setNetPref(next);
    savePref(NET_PREF_KEY, JSON.stringify(next));
  };
  const onTransportChange = (v: string): void => {
    setTransportOverride(v);
    savePref(TRANSPORT_PREF_KEY, v);
  };
  /** 放开到非回环：首次必须弹一次警告（本机工具不该默认把数据面暴露到局域网）。 */
  const onAllowRemote = (v: boolean): void => {
    if (v) {
      let warned = false;
      try {
        warned = window.localStorage.getItem(REMOTE_WARN_KEY) === "1";
      } catch {
        warned = false;
      }
      if (!warned) {
        const ok = window.confirm(
          "确认放开到非回环地址？\n\n" +
          "串口监视默认只允许本机回环（127.0.0.1）。放开后，局域网内的其他机器 " +
          "可以连到这条设备数据面（TCP 服务端）或把数据发过来（UDP）。\n\n" +
          "只在受控网络里这么做。");
        if (!ok) return;
        try {
          window.localStorage.setItem(REMOTE_WARN_KEY, "1");
        } catch {
          /* 仅本次会话有效 */
        }
      }
    }
    saveNet({ host: netHost, port: netPort, allow_remote: v });
  };

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
  // 数据面全部收在 `useSerialStream`：行 + 字节双游标、纪元重置、本地镜像。
  // 只有串口工作区可见时才轮询（离开页面不占带宽）。
  const serialWsActive = active.id === "serial";
  const stream = useSerialStream({
    initial: caps?.serial.monitor ?? null,
    project: serialProject,
    port: serialPort,
    baud: serialBaud,
    line: serialLine,
    transport: isNet ? transport : "",
    net: netPayload,
    enabled: serialWsActive,
  });

  // 闭环结束 → 内核可能已按 `resume_after_run` 自动把会话开回来（原会话不存在时
  // 会新开一个）。前端并不知情，界面会停在「监视未启动」，此时手动开又会被内核的
  // "已在运行"挡住（表现为**串口怎么也打不开**）。收尾时只读同步一次即可接上。
  const runWasLive = useRef(run.status === "running");
  const resyncSerial = stream.resync;
  useEffect(() => {
    if (runWasLive.current && run.status !== "running") void resyncSerial();
    runWasLive.current = run.status === "running";
  }, [run.status, resyncSerial]);

  // 监视进行中时，下拉框显示**会话真实的连接方式**（内核回传的 kind），
  // 否则"已经连到 tcp://…，界面却写着串口"会让人以为连错了。
  const transportShown = stream.active
    ? (stream.snap?.kind ?? transport)
    : transport;
  const isNetShown = transportShown !== "serial";
  const liveNet = (stream.snap?.net ?? {}) as Record<string, unknown>;
  const netHostShown = stream.active
    ? String(liveNet.host ?? liveNet.bind ?? "") : netHost;
  const netPortShown = stream.active ? Number(liveNet.port ?? 0) : netPort;

  const toggleMonitor = useCallback(async () => {
    if (stream.active) {
      await stream.close();
      logs.local("serial", "── 监视已关闭 ──");
      return;
    }
    const r = await stream.open();
    if (!r.ok) {
      logs.local("serial", `✗ 打开监视失败：${r.error ?? "未知原因"}`, "alert");
      return;
    }
    logs.local("serial",
      `── 监视已打开 ${stream.snap?.port ?? "?"}@${stream.snap?.baud ?? "?"}（实时流只在本页缓冲，重载即失；` +
      `监视期间闭环/CLI 用不了串口 —— 约束 N5）──`);
  }, [stream]);

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
        const r = await api.serial({ project: serialProject, data: line, baud: serialBaud, port: serialPort, line: serialLine });
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
    [serialProject, serialBaud, serialPort, serialLine],
  );

  // 写通道可用性：既要后端**真的支持写**（M3-b），也要有工程上下文。
  // ★ 网络传输（M4）没有"无状态往返"这一路（会话才是那条链路）：必须监视已开，
  //   写入才会走 `write_through` —— 否则会在底下偷偷开一条串口。
  const writable = (isNet ? stream.active : (caps?.serial.write_available ?? false))
    && !!serialProject;

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

  // ── 串口端口/波特率：监视运行时锁死（换口必须重开串口），展示的是**实际**会话值 ──
  const portShown = stream.active ? (stream.snap?.port ?? serialPort) : serialPort || "auto";
  const baudShown = stream.active ? (stream.snap?.baud ?? serialBaud) : serialBaud;
  // 线参数同理：运行中显示**实际**会话值（可能是工程配置而非本页覆盖）。
  const lineShown = stream.active
    ? (stream.snap?.line_text ?? serialLine)
    : serialLine;
  const portList = (caps?.serial.ports ?? []).map((p) => ({
    name: p.name,
    label: p.kind === "bluetooth" ? `${p.name}（蓝牙）` : p.name,
  }));
  if (portShown !== "" && portShown !== "auto" && !portList.some((p) => p.name === portShown)) {
    portList.unshift({ name: portShown, label: `${portShown}（当前）` });
  }
  const onPortChange = (v: string): void => {
    setPortOverride(v);
    savePref(PORT_PREF_KEY, v);
  };
  const onBaudChange = (v: number): void => {
    setBaudOverride(v);
    savePref(BAUD_PREF_KEY, String(v));
  };
  const onLineChange = (v: string): void => {
    setLineOverride(v);
    savePref(LINE_PREF_KEY, v);
  };
  // 选项来自内核自描述（`meta.serial.line`）；内核过旧时才用最小兜底清单。
  const lineForms: string[] = caps?.meta?.serial?.line?.text_forms
    ?? ["8N1", "7E1", "8O1", "8N2", "5N1.5"];
  const lineList = lineForms.includes(lineShown) ? lineForms : [lineShown, ...lineForms];
  const lineParts = parseLine(lineShown);
  const flowForms: string[] = caps?.meta?.serial?.line?.flow
    ?? ["none", "rtscts", "xonxoff", "dsrdtr"];
  const flowList = flowForms.includes(lineParts.flow)
    ? flowForms : [lineParts.flow, ...flowForms];

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
                : `只跑这一步：${stepLabel(id, card)}`
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
        {/* ── 串口工作区：端口/波特率选择 + 打开/关闭监视（常驻会话，不是闭环判定）──
            ★ 监视开着时选择器锁死：换口必须重开串口（会话绑的是某个物理口）。 */}
        {active.id === "serial" ? (
          <>
            {/* 连接方式（M4）：串口 / TCP 客户端 / TCP 服务端 / UDP —— 来自内核自描述 */}
            <select
              className={s.baud}
              style={{ maxWidth: "118px" }}
              value={transportShown}
              onChange={(e) => onTransportChange(e.currentTarget.value)}
              title={stream.active
                ? "监视进行中：先关闭监视再换连接方式"
                : "连接方式：串口 = 物理串口；网络三种走 socket（默认只绑 127.0.0.1）"}
              aria-label="连接方式"
              disabled={stream.active}
            >
              {transportKinds.map((k) => (
                <option key={k} value={k}>
                  {TRANSPORT_LABELS[k] ?? k}
                </option>
              ))}
            </select>
            {isNetShown ? (
              <>
                <input
                  className={s.netField}
                  style={{ width: "132px" }}
                  value={netHostShown}
                  onChange={(e) => saveNet({ host: e.currentTarget.value,
                    port: netPort, allow_remote: netAllowRemote })}
                  title={transportShown === "tcp-client"
                    ? "目标地址（host）：默认 127.0.0.1"
                    : "绑定地址（bind）：默认 127.0.0.1"}
                  aria-label="网络地址"
                  spellCheck={false}
                  disabled={stream.active}
                />
                <input
                  className={s.netField}
                  style={{ width: "62px" }}
                  value={netPortShown}
                  onChange={(e) => saveNet({ host: netHost,
                    port: Number(e.currentTarget.value) || 0,
                    allow_remote: netAllowRemote })}
                  title="端口：默认 9000（刻意避开 openocd 的 3333）"
                  aria-label="网络端口"
                  inputMode="numeric"
                  disabled={stream.active}
                />
                <Switch
                  id="allow_remote"
                  checked={netAllowRemote}
                  onChange={onAllowRemote}
                  label="允许非回环"
                />
              </>
            ) : (
              <>
            <select
              className={s.baud}
              style={{ maxWidth: "132px" }}
              value={portShown}
              onChange={(e) => onPortChange(e.currentTarget.value)}
              title={stream.active ? "监视进行中：先关闭监视再换端口" : "选择串口；auto = 内核按 USB 优先自动解析（有歧义会报错而不是猜）"}
              aria-label="串口端口"
              disabled={stream.active}
            >
              <option value="auto">auto（自动选口）</option>
              {portList.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
            <select
              className={s.baud}
              value={baudShown}
              onChange={(e) => onBaudChange(Number(e.currentTarget.value))}
              title={stream.active ? "监视进行中：先关闭监视再换波特率" : "波特率：下一次打开监视/发送时生效"}
              aria-label="串口波特率"
              disabled={stream.active}
            >
              {baudOptions(baudShown).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <select
              className={s.baud}
              style={{ maxWidth: "92px" }}
              value={composeLine(lineParts)}
              onChange={(e) => onLineChange(composeLine({
                ...parseLine(e.currentTarget.value), flow: lineParts.flow }))}
              title={stream.active
                ? "监视进行中：线参数在打开时固定，先关闭监视再改"
                : "数据位/校验/停止位：下一次打开监视或发送时生效"}
              aria-label="串口线参数"
              disabled={stream.active}
            >
              {lineList.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <select
              className={s.baud}
              style={{ maxWidth: "104px" }}
              value={lineParts.flow}
              onChange={(e) => onLineChange(composeLine({
                ...lineParts, flow: e.currentTarget.value }))}
              title="流控：none=无 / rtscts=硬件 / xonxoff=软件 / dsrdtr=DTR-DSR"
              aria-label="串口流控"
              disabled={stream.active}
            >
              {flowList.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
              </>
            )}
            {stream.active ? (
            <Tooltip tip={`监视中：${stream.snap?.port ?? "?"}@${stream.snap?.baud ?? "?"} · 已收 ${stream.snap?.seq ?? 0} 行 / ${stream.snap?.chunk_seq ?? 0} 批 —— 点击关闭并释放串口`}>
              <Button size="sm" variant="outline" onClick={() => void toggleMonitor()}>
                关闭监视
              </Button>
            </Tooltip>
          ) : (
            <Tooltip tip={
              !isNet && !caps?.serial.available
                ? (caps?.serial.hint ?? "串口后端不可用")
                : running
                  ? "有 run 在跑：串口/SWD 与 run 互斥（约束 N5），等它结束"
                  : !serialProject
                    ? "先在左侧选一个工程"
                    : isNet
                      ? `打开 ${transport}://${netHost}:${netPort} 实时收流（占用该链路直到关闭）`
                      : `打开 ${serialPort || "auto"}@${serialBaud} 实时收流（占用串口直到关闭）`
            }>
              <Button
                size="sm"
                disabled={(isNet ? false : !caps?.serial.available) || running || !serialProject}
                onClick={() => void toggleMonitor()}
              >
                打开监视
              </Button>
            </Tooltip>
          )}
          </>
        ) : null}
        {stream.active && stream.snap?.state === "reconnecting" ? (
          <span className={s.warn} role="status">
            掉线重连中{stream.snap?.down_s ? `（${stream.snap.down_s}s）` : ""}
            {stream.snap?.last_error ? `：${stream.snap.last_error}` : ""}
          </span>
        ) : null}
        {stream.active && stream.snap?.state === "suspended" ? (
          <span className={s.meta} role="status">
            已让位给闭环{stream.snap?.suspend_reason ? `（${stream.snap.suspend_reason}）` : ""} · run 结束自动恢复
          </span>
        ) : null}
        {stream.snap?.stats ? (
          <span className={s.meta} title="最近 1s 的 RX/TX 速率（服务端统计）">
            ↓{(stream.snap.stats.rx_bps / 1024).toFixed(1)}K ↑
            {(stream.snap.stats.tx_bps / 1024).toFixed(1)}K B/s
          </span>
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

      {/* ── 监视会话开着：整块换成完整串口工作区（行/字节/终端/波形）──
          ★ 不开监视时仍显示闭环日志（monitor 步骤的 serial/* 事件 + 手写留档），
            两者职责不同：run 事件是"证据"，监视是"实时看"。 */}
      {serialWsActive && stream.active ? (
        <SerialWorkspace
          stream={stream}
          caps={caps}
          project={serialProject}
          running={running}
        />
      ) : active.id === "debug" ? (
        <DebugWorkspace
          caps={caps}
          project={serialProject}
          running={running}
          debugFeatures={card?.name === serialProject ? card.debug_features : undefined}
        />
      ) : active.id === "modbus" ? (
        <ModbusWorkspace
          project={serialProject}
          serialAvailable={caps?.serial.available ?? false}
          serialHint={caps?.serial.hint ?? undefined}
        />
      ) : (
        <LogView
          key={active.id}
          ring={ring}
          autoScroll={autoScroll}
          onAutoScrollChange={setAutoScroll}
          empty={active.emptyText(card, caps)}
        />
      )}

      {/* ── 串口手动输入（M3-b 已通：写一条 → 收一段回显，一次请求内闭环）──
          ★ 监视开着时由 SerialWorkspace 的发送面板接管（同口写穿，不重开） */}
      {active.id === "serial" && !stream.active ? (
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
          <span className={s.portTag} title={isNetShown
            ? `${transportShown}://${netHostShown}:${netPortShown}`
            : `${serialPort || "auto"}@${serialBaud}`}>
            {isNetShown
              ? `${transportShown}://${netHostShown}:${netPortShown}`
              : serialPort || "auto"}
          </span>
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
    return t?.label ?? stepLabel(stepId, card);
  }
  if (w.actionLabel && w.steps.length === 1 && w.steps[0] === stepId) return w.actionLabel;
  return stepLabel(stepId, card);
}
