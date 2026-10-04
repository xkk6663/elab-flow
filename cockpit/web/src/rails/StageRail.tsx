import { useEffect, useState } from "react";
import type { Capabilities, ProjectCard, StepId, StepResult } from "../api/types";
import type { RunSnapshot, StepView } from "../store/runStore";
import { Button } from "../primitives/Button";
import { DisclosureRow } from "../primitives/DisclosureRow";
import { Menu } from "../primitives/Menu";
import { PathLabel } from "../primitives/PathLabel";
import { StateDot } from "../primitives/StateDot";
import { Tag, Pill } from "../primitives/Tag";
import { TextShimmer } from "../primitives/TextShimmer";
import { Tooltip } from "../primitives/Tooltip";
import { MemoryGauge } from "../render/MemoryGauge";
import { IconPlay, IconRefresh, IconShield, IconStop, IconWrench } from "../icons";
import s from "./StageRail.module.css";

const STEP_LABEL: Record<string, string> = {
  doctor: "体检",
  doctor_deep: "深度体检",
  build: "编译",
  flash: "烧录",
  debug_verify: "调试校验",
  monitor: "串口闭环",
};

export const stepLabel = (id: string): string => STEP_LABEL[id] ?? id;

export interface StageRailProps {
  card: ProjectCard | null;
  run: RunSnapshot;
  caps: Capabilities | null;
  /** 已发出 POST /api/run，等待 run 启动 */
  busy: boolean;
  onRunAll: () => void;
  onRunSteps: (steps: StepId[]) => void;
  onCancel: () => void;
  onRefresh: () => void;
}

/** 运行中每秒重绘一次"已用时"。不跑时完全不触发重渲染。 */
function useSecondTick(active: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setN((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [active]);
}

function fmtDur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${sec.toFixed(2)}s`;
  return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`;
}

/**
 * 阶段轨（§5.4 中列）—— 驾驶舱核心。
 * R1「此刻在哪一步」、R2 内存占位、R3 烧录、R8 手动干预都在这一列。
 */
export function StageRail({
  card,
  run,
  caps,
  busy,
  onRunAll,
  onRunSteps,
  onCancel,
  onRefresh,
}: StageRailProps) {
  const running = run.status === "running";
  useSecondTick(running);

  if (!card) {
    return (
      <div className={s.rail}>
        <div className={s.empty}>
          <p className={s.emptyTitle}>从左列选一个工程</p>
          <p className={s.emptyHint}>
            工程卡片全部来自 <code>projects/*.yaml</code>。新增工程 = 加一个 yaml，刷新即出现。
          </p>
        </div>
      </div>
    );
  }

  // run 未开始时，用默认步序画"待跑"骨架；run 起来后以 run/start 声明的序列为准
  const declared: StepView[] =
    run.steps.length > 0
      ? run.steps
      : (caps?.steps.default ?? []).map((id, index) => ({
          id,
          index,
          state: "pending" as const,
          detail: "",
          duration_s: 0,
        }));

  const elapsed =
    run.startedAt != null
      ? (run.endedAt ?? Date.now() / 1000) - run.startedAt
      : 0;

  const build = run.lastBuild;
  const lastStep = run.steps.filter((v) => v.result).slice(-1)[0];

  return (
    <div className={s.rail}>
      {/* ── 顶栏：工程名 + 状态 + 用时 ── */}
      <div className={s.head}>
        <div className={s.headMain}>
          <span className={s.projName}>{card.name}</span>
          {run.actor ? (
            <Tag dense tone={run.actor === "human" ? "violet" : "blue"}>
              {run.actor === "human" ? "我点的" : "agent"}
            </Tag>
          ) : null}
        </div>
        <div className={s.headSide}>
          {run.run ? (
            <Tooltip tip={`run id：${run.run}`}>
              <span className={s.runId}>{run.run}</span>
            </Tooltip>
          ) : null}
          {running ? (
            <span className={s.elapsed}>{fmtDur(elapsed)}</span>
          ) : run.endedAt != null && run.startedAt != null ? (
            <span className={s.elapsed}>{fmtDur(run.endedAt - run.startedAt)}</span>
          ) : null}
          {/* 触发器在顶栏正下方，朝上开会被顶栏（z-index:20）盖住 → 必须朝下 */}
          <Tooltip side="bottom" tip="重新读取 projects/*.yaml 与运行列表">
            <Button variant="toolbar" onClick={onRefresh} aria-label="刷新">
              <IconRefresh />
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* ── R1 状态带 ── */}
      <div className={s.band} role="list" aria-label="流水线状态">
        {declared.map((v, i) => (
          <div className={s.bandItem} key={v.id} role="listitem">
            {i > 0 ? (
              <span
                className={[
                  s.connector,
                  declared[i - 1].state === "ok" ? s.connOk : "",
                  declared[i - 1].state === "failed" ? s.connFail : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-hidden="true"
              />
            ) : null}
            <span className={s.bandNode}>
              <StateDot state={v.state} title={`${stepLabel(v.id)} · ${v.state}`} />
              <TextShimmer active={v.state === "running"}>
                <span
                  className={[
                    s.bandLabel,
                    v.state === "running" ? s.bandRunning : "",
                    v.state === "ok" ? s.bandOk : "",
                    v.state === "failed" ? s.bandFail : "",
                    v.state === "skipped" || v.state === "pending" ? s.bandIdle : "",
                  ].join(" ")}
                >
                  {stepLabel(v.id)}
                </span>
              </TextShimmer>
              {v.duration_s > 0 ? (
                <span className={s.bandDur}>{fmtDur(v.duration_s)}</span>
              ) : null}
            </span>
          </div>
        ))}
      </div>

      {/* ── R8 控制条 ── */}
      <div className={s.bar}>
        <Button
          variant="primary"
          icon={<IconPlay />}
          busy={busy}
          disabled={running}
          onClick={onRunAll}
          title="按 ci/matrix.yaml 的全量步序跑一遍（含上板）"
        >
          跑全闭环
        </Button>
        <Menu
          align="left"
          title="只跑指定步骤"
          trigger={
            <Button icon={<IconWrench />} disabled={running} title="单步执行">
              单步
            </Button>
          }
          items={(caps?.steps.all ?? (Object.keys(STEP_LABEL) as StepId[])).map((id) => {
            const ok = card.steps[id]?.ok ?? true;
            return {
              id,
              label: stepLabel(id),
              hint: ok ? "" : "不可用",
              disabled: !ok,
              checked: (caps?.steps.default ?? []).includes(id),
            };
          })}
          onSelect={(id) => onRunSteps([id as StepId])}
        />
        <Button
          variant="danger"
          icon={<IconStop />}
          disabled={!running}
          onClick={onCancel}
          title="杀掉整棵进程树（cmake → ninja → gcc）"
        >
          取消
        </Button>
        <span className={s.barSpacer} />
        {run.status !== "idle" ? (
          <Pill
            tone={
              run.status === "ok"
                ? "green"
                : run.status === "failed"
                  ? "red"
                  : run.status === "cancelled"
                    ? "amber"
                    : "blue"
            }
            title={`run 状态：${run.status}`}
          >
            {run.status}
          </Pill>
        ) : null}
      </div>

      {/* ── R2 内存占位 ── */}
      <section className={s.sect}>
        <h3 className={s.sectTitle}>
          内存占位
          {build?.memory_source === "map" ? (
            <Tag dense tone="amber" title="本次未重新链接，数字由 elab 从 .map 反推">
              取自 .map
            </Tag>
          ) : build?.memory_source === "linker" ? (
            <Tag dense tone="neutral">
              链接器自报
            </Tag>
          ) : null}
        </h3>
        <MemoryGauge memory={build?.memory ?? {}} source={build?.memory_source} />
      </section>

      {/* ── 产物 ── */}
      <section className={s.sect}>
        <h3 className={s.sectTitle}>产物</h3>
        {(() => {
          const art = build?.artifacts ?? {};
          const keys = Object.keys(art);
          if (keys.length === 0) {
            return (
              <div className={s.none}>
                暂无产物。编译成功后这里会列出 <code>elf / hex / bin / map</code>。
              </div>
            );
          }
          return (
            <ul className={s.artList}>
              {keys.map((k) => (
                <li key={k} className={s.artRow}>
                  <span className={s.artKey}>{k}</span>
                  <PathLabel path={art[k].path} suffix={`${(art[k].bytes / 1024).toFixed(1)} KB`} />
                </li>
              ))}
            </ul>
          );
        })()}
        {/* 声明了但没产出 —— 这是 N6 曾经的症状，必须显式可见 */}
        {card.artifacts.map && !(build?.artifacts?.map) ? (
          <div className={s.warnRow}>
            声明了 <code>artifacts.map</code> 但未生成。检查链接行是否带
            <code> -Wl,-Map</code>（elab 通过 <code>-DELAB_MAP_FILE</code> 盖章）。
          </div>
        ) : null}
      </section>

      {/* ── 零改动守卫 ── */}
      {build?.guard ? (
        <section className={s.sect}>
          <h3 className={s.sectTitle}>
            <IconShield className={s.sectIcon} />
            零改动守卫
          </h3>
          <div className={s.guardRow}>
            <Pill tone={build.guard.untouched ? "green" : "red"}>
              {build.guard.untouched ? "未触碰" : "有改动"}
            </Pill>
            <span className={s.guardText}>
              源码树 {build.guard.files_before} 个文件
              {build.guard.changed.length > 0 ? ` · 变更 ${build.guard.changed.length}` : ""}
              {build.guard.added.length > 0 ? ` · 新增 ${build.guard.added.length}` : ""}
              {build.guard.removed.length > 0 ? ` · 删除 ${build.guard.removed.length}` : ""}
            </span>
          </div>
          {!build.guard.untouched ? (
            <ul className={s.guardList}>
              {[...build.guard.changed, ...build.guard.added, ...build.guard.removed]
                .slice(0, 8)
                .map((f) => (
                  <li key={f} className={s.guardFile}>
                    {f}
                  </li>
                ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* ── 串口闭环判定（M3 起有数据） ── */}
      {run.closedLoop ? (
        <section className={s.sect}>
          <h3 className={s.sectTitle}>串口闭环</h3>
          <div className={s.guardRow}>
            <Pill tone={run.closedLoop.verdict === "ok" ? "green" : run.closedLoop.verdict === "failed" ? "red" : "amber"}>
              {run.closedLoop.verdict}
            </Pill>
            <span className={s.guardText} title={run.closedLoop.evidence}>
              命中判据 {run.closedLoop.rule}
            </span>
          </div>
        </section>
      ) : null}

      {/* ── 阶段账本 ── */}
      <section className={[s.sect, s.ledger].join(" ")}>
        <h3 className={s.sectTitle}>阶段账本</h3>
        {run.steps.length === 0 ? (
          <div className={s.none}>还没有 run。点「跑全闭环」或「单步」开始。</div>
        ) : (
          <div className={s.ledgerBody}>
            {run.steps.map((v) => (
              <DisclosureRow
                key={v.id}
                header={
                  <>
                    <StateDot state={v.state} size={8} />
                    <span className={s.ledStep}>{stepLabel(v.id)}</span>
                    <span className={s.ledDetail}>{v.detail}</span>
                    <span className={s.ledDur}>{fmtDur(v.duration_s)}</span>
                  </>
                }
              >
                <StepDetail v={v} />
              </DisclosureRow>
            ))}
          </div>
        )}
        {lastStep?.result?.verdict ? (
          <div className={s.verdictRow}>
            <span className={s.verdictKey}>判定</span>
            <Tag tone={lastStep.result.verdict === "ok" ? "green" : lastStep.result.verdict === "failed" ? "red" : "amber"}>
              {lastStep.result.verdict}
            </Tag>
            <span className={s.verdictDetail}>{lastStep.result.detail}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** 账本展开后的步骤详情 —— 只渲染该步**确实产出**的东西，不做占位填充 */
function StepDetail({ v }: { v: StepView }) {
  const r: StepResult | undefined = v.result;
  if (!r) return <div className={s.none}>（未执行）</div>;
  return (
    <div className={s.detail}>
      {r.detail ? <div className={s.detailLine}>{r.detail}</div> : null}
      {r.memory && Object.keys(r.memory).length > 0 ? (
        <MemoryGauge memory={r.memory} source={r.memory_source} compact />
      ) : null}
      {r.size ? (
        <div className={s.detailLine}>
          text {r.size.text} / data {r.size.data} / bss {r.size.bss} 字节
        </div>
      ) : null}
      {r.artifacts && Object.keys(r.artifacts).length > 0 ? (
        <ul className={s.artList}>
          {Object.keys(r.artifacts).map((k) => (
            <li key={k} className={s.artRow}>
              <span className={s.artKey}>{k}</span>
              <PathLabel path={r.artifacts![k].path} suffix={`${(r.artifacts![k].bytes / 1024).toFixed(1)} KB`} />
            </li>
          ))}
        </ul>
      ) : null}
      {r.evidence && r.evidence.length > 0 ? (
        <ul className={s.evList}>
          {r.evidence.map((e, i) => (
            <li key={i} className={s.evRow}>
              {e}
            </li>
          ))}
        </ul>
      ) : null}
      {!r.detail && !r.memory && !r.artifacts && !r.evidence ? (
        <div className={s.none}>（该步无可展示的结构化结果，日志见右列）</div>
      ) : null}
    </div>
  );
}
