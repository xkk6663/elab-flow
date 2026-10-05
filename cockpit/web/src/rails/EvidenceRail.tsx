import { useCallback, useEffect, useState } from "react";
import type { Capabilities, ProjectCard, StepId } from "../api/types";
import { logs, type LogTab } from "../store/logs";
import { useRun } from "../store/runStore";
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
  /** 当前工程卡片 —— 单步按钮的可用性（`steps[id].ok` 与理由）来自它 */
  card: ProjectCard | null;
  /** 有 run 在跑时单步按钮全部置灰（串口/调试与 run 互斥） */
  running: boolean;
  /** 在本 Tab 内直接触发对应单步；null = 上层未接线（按钮置灰并说明） */
  onRunSteps: ((steps: StepId[]) => void) | null;
  tab: LogTab;
  onTab: (t: LogTab) => void;
  autoScroll: boolean;
  onAutoScrollChange: (v: boolean) => void;
  /** 串口写入通道（M3-b 已通）。为 null、或后端不支持写时 → 输入框置灰并说明原因 */
  onSerialWrite: ((line: string) => void) | null;
  serialPort: string;
  serialBaud: number;
  /** 改波特率**立即生效** —— 下一次发送就用新值（无状态往返，不需要先"重开端口"） */
  onSerialBaudChange: (baud: number) => void;
}

/**
 * 每个 Tab 对应的单步按钮 —— 单步执行就该出现在"干这件事的界面"里：
 * 构建 Tab 里有「编译」、烧录 Tab 里有「烧录 / 调试校验」、串口 Tab 里有「串口闭环」。
 * 按钮可用性与阶段轨同一份来源（`card.steps[id].ok`），两处置灰理由永远一致。
 */
const TAB_STEPS: Record<LogTab, StepId[]> = {
  build: ["build"],
  flash: ["flash", "debug_verify"],
  serial: ["monitor"],
};

/** 常用波特率。工程配置里若是非标值，也插进列表 —— 否则 select 显示不出当前值 */
const COMMON_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function baudOptions(current: number): number[] {
  return COMMON_BAUDS.includes(current)
    ? COMMON_BAUDS
    : [...COMMON_BAUDS, current].sort((a, b) => a - b);
}

type Counts = Record<LogTab, { lines: number; alerts: number; dropped: number }>;

/**
 * 证据轨（§5.4 右列 / R2 R3 R4 R5）。
 * 三个 Tab 是"同一套渲染层的三个入口"—— 这样 R4「日志情况」只有一份实现。
 */
export function EvidenceRail({
  caps,
  card,
  running,
  onRunSteps,
  tab,
  onTab,
  autoScroll,
  onAutoScrollChange,
  onSerialWrite,
  serialPort,
  serialBaud,
  onSerialBaudChange,
}: EvidenceRailProps) {
  const [counts, setCounts] = useState<Counts>(() => logs.counts());
  const [draft, setDraft] = useState("");

  // 徽标计数：低频节流刷新（250ms）。日志行刷在 LogView 里，这里只管数字。
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        setCounts(logs.counts());
      }, 250);
    };
    const unsubs = (["build", "flash", "serial"] as LogTab[]).map((k) =>
      logs.for(k).subscribe(tick),
    );
    return () => {
      if (timer) window.clearTimeout(timer);
      for (const u of unsubs) u();
    };
  }, []);

  const ring = logs.for(tab);
  const st = counts[tab];
  // 只读 run 快照 —— 低频（run/* 与背压告警才变），不会拖累这里的日志渲染路径
  const run = useRun();
  // 写通道可用性：既要 App 接上了回调，又要后端**真的支持写**（M3-b）。
  // 两者分开判断，是为了让"没接线"与"后端不支持"给出不同的置灰理由。
  const writable = !!onSerialWrite && (caps?.serial.write_available ?? false);

  const tabs: Array<SegTab<LogTab>> = [
    { id: "build", label: "构建", badge: counts.build.lines },
    { id: "flash", label: "烧录", badge: counts.flash.lines },
    {
      id: "serial",
      label: "串口",
      badge: counts.serial.alerts > 0 ? counts.serial.alerts : counts.serial.lines,
      tone: counts.serial.alerts > 0 ? "alert" : "normal",
      dim: !(caps?.serial.available ?? false),
      title: caps?.serial.available ? undefined : (caps?.serial.hint ?? "串口后端不可用"),
    },
  ];

  const doExport = useCallback(() => {
    const text = ringToText(ring);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `elab-${tab}.log`;
    a.click();
    // 立即 revoke 会让部分浏览器下载失败，延后一拍
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, [ring, tab]);

  return (
    <div className={s.rail}>
      <div className={s.head}>
        <SegmentedTabs tabs={tabs} value={tab} onChange={onTab} size="sm" />
        <span className={s.spacer} />
        <Tooltip side="bottom" tip="导出当前 Tab 的纯文本日志">
          <Button variant="toolbar" onClick={doExport} aria-label="导出日志">
            <IconDownload />
          </Button>
        </Tooltip>
        <Tooltip side="bottom" tip="清空三个 Tab 的本地缓冲（不影响服务端 .jsonl，也不清服务端串口留档）">
          <Button
            variant="toolbar"
            onClick={() => logs.clearAll()}
            aria-label="清空日志缓冲"
          >
            <IconTrash />
          </Button>
        </Tooltip>
      </div>

      <div className={s.bar}>
        <Switch
          id="follow"
          checked={autoScroll}
          onChange={onAutoScrollChange}
          label="跟随"
        />
        <span className={s.spacer} />
        {/* ── 本 Tab 的单步按钮（用户要求：单步执行要出现在具体界面里）── */}
        {TAB_STEPS[tab].map((id) => {
          const av = card?.steps[id];
          const ok = av?.ok ?? true;
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
                onClick={() => onRunSteps?.([id])}
              >
                {stepLabel(id)}
              </Button>
            </Tooltip>
          );
        })}
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
        key={tab}
        ring={ring}
        autoScroll={autoScroll}
        onAutoScrollChange={onAutoScrollChange}
        empty={emptyTextFor(tab, caps)}
      />

      {/* ── 串口手动输入（M3-b 已通：写一条 → 收一段回显，一次请求内闭环） ── */}
      {tab === "serial" ? (
        <form
          className={s.write}
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim() || !writable || !onSerialWrite) return;
            onSerialWrite(draft);
            setDraft("");
          }}
        >
          <IconTerminal className={s.writeIcon} />
          <Input
            mono
            placeholder={
              writable
                ? "输入一行并按回车发送到设备"
                : "串口写通道不可用（后端不支持写，或尚未接线）"
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
            onChange={(e) => onSerialBaudChange(Number(e.currentTarget.value))}
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

function emptyTextFor(tab: LogTab, caps: Capabilities | null): string {
  if (tab === "serial") {
    if (!caps) return "正在读取串口能力…";
    if (!caps.serial.available) {
      return `串口后端不可用（layer=${caps.serial.layer}）。${caps.serial.hint ?? ""}`;
    }
    // 有服务端留档却还是空屏 = 回填被跳过了（例如留档属于别的工程）。
    // 把这件事说出来，否则用户会以为"我明明敲过，怎么什么都没了"。
    if (caps.serial.console.count > 0) {
      return (
        `服务端存有 ${caps.serial.console.count} 条串口留档，但本工程一条也没有` +
        `（留档按工程区分）。跑一次含 monitor 的闭环，` +
        `或在下框手敲一行，即可看到输出。`
      );
    }
    return (
      "尚无串口输出。跑一次含 monitor 的闭环即可看到设备打印；" +
      "也可以直接在下方框里手敲一行发给设备。"
    );
  }
  if (tab === "flash") return "尚无烧录输出。点「跑全闭环」或单步「烧录」。";
  return "尚无构建输出。";
}
