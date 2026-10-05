import { useEffect, useState } from "react";
import type { Capabilities, PlanPreview, ProjectCard, StepId, StepResult } from "../api/types";
import { api } from "../api/client";
import type { RunSnapshot, StepView } from "../store/runStore";
import { Button } from "../primitives/Button";
import { DisclosureRow } from "../primitives/DisclosureRow";
import { Input } from "../primitives/Input";
import { PathLabel } from "../primitives/PathLabel";
import { StateDot } from "../primitives/StateDot";
import { Switch } from "../primitives/Switch";
import { Tag, Pill } from "../primitives/Tag";
import { TextShimmer } from "../primitives/TextShimmer";
import { Tooltip } from "../primitives/Tooltip";
import { MemoryGauge } from "../render/MemoryGauge";
import { IconPlay, IconRefresh, IconShield, IconStop } from "../icons";
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

/**
 * 「跑全闭环」的步序（C30）。
 *
 * ★ 必须**显式**传给 `POST /api/run`：后端不传 steps 时只跑
 *   `DEFAULT_STEPS = doctor + build`（那是 M1 验收范围的"默认两步"，不是全闭环）
 *   —— 此前「跑全闭环」按钮恰恰不传 steps，于是跑完编译就停，与按钮承诺不符。
 *
 * 全闭环 = 全部步骤去掉 `doctor_deep`（它是 doctor 的重型变体、会真跑一次
 * configure，不是流水线上独立的一站），再按当前工程可用性过滤 ——
 * 没接板就把 flash / debug_verify / monitor 滤掉，否则是"点一下必然失败"。
 */
export function fullLoopSteps(
  card: ProjectCard | null,
  caps: Capabilities | null,
): StepId[] {
  const all = (caps?.steps.all ?? Object.keys(STEP_LABEL)) as StepId[];
  return all.filter((id) => id !== "doctor_deep" && (card?.steps[id]?.ok ?? true));
}

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
  /** M2 运行参数：`--clean` 会**真删**工作目录，`-j` 只影响构建并行度 */
  clean: boolean;
  onCleanChange: (v: boolean) => void;
  jobs: number | null;
  onJobsChange: (v: number | null) => void;
}

/** 把 argv 还原成一条可读命令行（只做展示，不参与任何执行）。 */
function shellJoin(argv: string[]): string {
  return argv
    .map((a) => (a.includes(" ") || a.includes("(") ? `"${a}"` : a))
    .join(" ");
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
  clean,
  onCleanChange,
  jobs,
  onJobsChange,
}: StageRailProps) {
  const running = run.status === "running";
  useSecondTick(running);

  // ── M2 命令预览（只读）──────────────────────────────────────
  const [pv, setPv] = useState<PlanPreview | null>(null);
  const [pvBusy, setPvBusy] = useState(false);
  const [pvErr, setPvErr] = useState<string | null>(null);

  const doPreview = async (steps?: StepId[]) => {
    const name = card?.name;
    if (!name) return;
    setPvBusy(true);
    setPvErr(null);
    try {
      setPv(await api.plan({ project: name, steps, clean, jobs: jobs ?? undefined }));
    } catch (e) {
      setPvErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPvBusy(false);
    }
  };

  // 切工程 / 换参数后旧的预览就失效了 —— 留着它比不留更坏（会指错工程）。
  useEffect(() => {
    setPv(null);
    setPvErr(null);
  }, [card?.name, clean, jobs]);

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

  // run 未开始时，用"全闭环"的步序画"待跑"骨架；run 起来后以 run/start 声明的序列为准。
  // ★ 骨架必须与 onRunAll 实际传的步序同源（同一个 fullLoopSteps），否则
  //   "骨架画着五步、点下去只跑两步"这种自相矛盾会直接暴露给用户。
  const declared: StepView[] =
    run.steps.length > 0
      ? run.steps
      : fullLoopSteps(card, caps).map((id, index) => ({
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
          title="完整闭环：体检 → 编译 → 烧录 → 调试校验 → 串口闭环（不可用的步骤自动排除）"
        >
          跑全闭环
        </Button>
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
        {/* ★ M2「先看命令再执行」：预览是**只读**的（GET /api/plan），
            不 spawn、不写盘、不发射事件 —— 与「跑全闭环」形成对照。
            它存在的理由：`--clean` 会真删工作目录、flash 会真烧板，
            按下之前必须能看清"到底会执行什么"。 */}
        <Button
          icon={<IconShield />}
          busy={pvBusy}
          disabled={!card}
          onClick={() => void doPreview()}
          title="只读预览：本轮将执行的命令与副作用，什么都不执行"
        >
          预览
        </Button>
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

      {/* ── 单步执行：一步一颗独立按钮（不再藏在下拉菜单里）──
          每颗按钮的可用性来自 `card.steps[id].ok`（服务端已算好"不可用的理由"），
          置灰时 tooltip 直接说出原因 —— 不让用户点了才知道失败。 */}
      <div className={[s.bar, s.stepBar].join(" ")} role="group" aria-label="单步执行">
        <span className={s.stepBarLabel}>单步</span>
        {(caps?.steps.all ?? (Object.keys(STEP_LABEL) as StepId[])).map((id) => {
          const st = card.steps[id];
          const ok = st?.ok ?? true;
          const onhw = (caps?.steps.onhw ?? []).includes(id);
          const tip = !ok
            ? st?.reason || "不可用"
            : `只跑这一步：${stepLabel(id)}${onhw ? "（需探针在位）" : ""}`;
          return (
            <Tooltip key={id} tip={tip}>
              <Button
                size="sm"
                disabled={running || !ok}
                onClick={() => onRunSteps([id as StepId])}
              >
                {stepLabel(id)}
              </Button>
            </Tooltip>
          );
        })}
      </div>

      {/* ── M2 运行参数（clean / jobs）── */}
      <div className={s.bar}>
        <div className={s.pvFlags}>
          <Switch
            id="clean"
            checked={clean}
            disabled={running}
            onChange={onCleanChange}
            label="--clean"
          />
          <span className={s.pvNote}>先清空工作目录</span>
        </div>
        <span className={s.barSpacer} />
        <div className={s.pvFlags}>
          <span className={s.pvNote}>-j</span>
          <Input
            className={s.pvJobs}
            mono
            disabled={running}
            placeholder="自动"
            value={jobs === null ? "" : String(jobs)}
            onChange={(e) => {
              const v = e.target.value.trim();
              const n = Number(v);
              onJobsChange(v === "" || !Number.isFinite(n) || n <= 0 ? null : Math.floor(n));
            }}
            aria-label="并行任务数"
          />
        </div>
      </div>

      {/* ── M2 命令预览（只读）── */}
      {pvErr ? (
        <section className={s.sect}>
          <div className={s.pvWarn}>预览失败：{pvErr}</div>
        </section>
      ) : null}
      {pv ? (
        <section className={s.sect}>
          <h3 className={s.sectTitle}>
            命令预览 · {pv.project}
            <button className={s.pvClose} onClick={() => setPv(null)} type="button">
              关闭
            </button>
          </h3>
          <div className={s.pvNote}>
            只读预览：下列命令**不会**被执行
            {pv.clean ? " · 已勾选 --clean" : ""}
            {pv.jobs ? ` · -j ${pv.jobs}` : ""}
          </div>
          {pv.warnings.map((w, i) => (
            <div className={s.pvWarn} key={`w${i}`}>
              ⚠ {w}
            </div>
          ))}
          {pv.plan.map((e) => (
            <div className={s.pvStep} key={e.step}>
              <div className={s.pvStepHead}>
                {stepLabel(e.step)}
                {e.blocked ? <Tag dense tone="amber">需前置产物</Tag> : null}
                {!e.spawns ? <Tag dense tone="neutral">不派生子进程</Tag> : null}
              </div>
              {e.effects.map((x, i) => (
                <div className={s.pvEffect} key={`e${i}`}>
                  ⚠ {x}
                </div>
              ))}
              {e.commands
                .filter((c) => c.length > 0)
                .map((c, i) => (
                  <pre className={s.pvCmd} key={`c${i}`}>
                    $ {shellJoin(c)}
                  </pre>
                ))}
              {e.serial ? (
                <div className={s.pvNote}>
                  串口 {e.serial.port}@{e.serial.baud}
                  {e.serial.idle_timeout_s ? ` · 静默超时 ${e.serial.idle_timeout_s}s` : ""}
                </div>
              ) : null}
              {e.note ? <div className={s.pvNote}>· {e.note}</div> : null}
            </div>
          ))}
        </section>
      ) : null}

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
            <span className={s.guardText} title={run.closedLoop.evidence || run.closedLoop.rule}>
              {run.closedLoop.rule
                ? `命中判据 ${run.closedLoop.rule}`
                : run.closedLoop.verdict === "failed"
                  ? "命中 fail_on"
                  : "未命中任何判据"}
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
