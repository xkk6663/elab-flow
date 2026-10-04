import type { Capabilities, ProjectCard, StepId } from "../api/types";
import { Pill, Tag } from "../primitives/Tag";
import { IconAlert, IconChip, IconPlug } from "../icons";
import s from "./ProjectsRail.module.css";

export interface ProjectsRailProps {
  cards: ProjectCard[];
  selected: string;
  onSelect: (name: string) => void;
  caps: Capabilities | null;
  /** 有 run 在跑时禁用切换（避免"看着 A 的日志、实际跑的是 B"） */
  locked: boolean;
  loading: boolean;
}

/**
 * 工程轨（§5.4 左列 / R6）。
 *
 * ★ M1.6 的验收点是「卡片数据 100% 来自 `projects/*.yaml`，无新元数据」。
 *   本组件**不做任何推导**：所有字段直接读 `ProjectCard`，而 `ProjectCard`
 *   由后端从 YAML + chips/*.yaml 拼出（见 cockpit/server.py `project_cards()`）。
 *   唯一的"计算"是 `derived.built`（ELF 文件在不在）—— 它在后端就标注为派生位。
 */
export function ProjectsRail({
  cards,
  selected,
  onSelect,
  caps,
  locked,
  loading,
}: ProjectsRailProps) {
  // 串口能力来自 /api/capabilities（后端能力协商结果），不是前端猜的
  const serialOk = caps?.serial.available ?? false;

  return (
    <div className={s.rail}>
      <div className={s.head}>
        <span className={s.title}>工程</span>
        <span className={s.count}>{cards.length}</span>
      </div>

      <div className={s.list}>
        {loading ? <div className={s.note}>读取 projects/*.yaml …</div> : null}
        {!loading && cards.length === 0 ? (
          <div className={s.note}>没有工程。在 projects/ 下加一个 *.yaml 就会出现在这里。</div>
        ) : null}

        {cards.map((p) => {
          const isSel = p.name === selected;
          const blocked = (Object.keys(p.steps) as StepId[]).filter((k) => !p.steps[k].ok);
          return (
            <button
              key={p.name}
              type="button"
              className={[s.card, isSel ? s.sel : ""].filter(Boolean).join(" ")}
              aria-current={isSel}
              disabled={locked && !isSel}
              title={locked && !isSel ? "有任务在跑，先取消或等它结束" : p.root}
              onClick={() => onSelect(p.name)}
            >
              <div className={s.row1}>
                <span className={s.name}>{p.name}</span>
                {p.derived.built ? <span className={s.dotBuilt} title="已有构建产物" /> : null}
              </div>
              <div className={s.row2}>
                <Tag tone={p.archetype === "A" ? "blue" : "green"} mono dense>
                  {p.chip || "未指定芯片"}
                </Tag>
                <Tag dense tone="neutral">
                  {p.archetype ? `${p.archetype} 类` : "形态未声明"}
                </Tag>
                {p.generator ? (
                  <Tag dense tone="neutral">
                    {p.generator}
                  </Tag>
                ) : null}
              </div>
              {blocked.length > 0 ? (
                <div className={s.row3}>
                  <IconAlert className={s.warnIcon} />
                  <span className={s.warnText}>
                    {blocked.join(" / ")} 不可用
                  </span>
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* ── 芯片卡 + 探针/串口状态（选中工程） ── */}
      {(() => {
        const p = cards.find((c) => c.name === selected);
        if (!p) return null;
        const ci = p.chip_info;
        const core = ci.core || {};
        return (
          <div className={s.chipBox}>
            <div className={s.chipHead}>
              <IconChip className={s.chipIcon} />
              <span className={s.chipId} title={`${ci.vendor} ${ci.family} ${ci.part}`}>
                {ci.part || ci.id || "—"}
              </span>
            </div>
            <dl className={s.kv}>
              <dt>内核</dt>
              <dd>
                {core.cpu || core.arch || "—"}
                {core.fpu ? ` · ${core.fpu}` : ""}
              </dd>
              <dt>封装</dt>
              <dd>{ci.package || "—"}</dd>
              <dt>主频</dt>
              <dd>{ci.frequency || "—"}</dd>
              <dt>存储</dt>
              <dd className={s.mono}>
                {Object.entries(ci.memory || {})
                  .map(([k, v]) => `${k} ${Math.round(v.length / 1024)}K`)
                  .join(" · ") || "—"}
              </dd>
            </dl>

            <div className={s.io}>
              <div className={s.ioRow}>
                <IconPlug className={s.ioIcon} />
                <span className={s.ioLabel}>探针</span>
                <span className={s.ioVal} title={p.probe}>
                  {p.probe || "未声明"}
                </span>
                <Pill tone={p.probe && p.steps.flash.ok ? "green" : "red"}>
                  {p.probe && p.steps.flash.ok ? "可上板" : "不可用"}
                </Pill>
              </div>
              <div className={s.ioRow}>
                <span className={s.ioIcon} aria-hidden="true">
                  ⌁
                </span>
                <span className={s.ioLabel}>串口</span>
                <span className={s.ioVal} title={caps?.serial.hint ?? ""}>
                  {p.serial.port || "auto"}
                  {p.serial.baud ? ` @${p.serial.baud}` : ""}
                </span>
                <Pill tone={serialOk && p.steps.monitor.ok ? "green" : "amber"}>
                  {p.steps.monitor.ok ? (serialOk ? "就绪" : "后端缺失") : "无判据"}
                </Pill>
              </div>
              <div className={s.ioRow}>
                <span className={s.ioIcon} aria-hidden="true">
                  ⌁
                </span>
                <span className={s.ioLabel}>闭环判据</span>
                <span className={s.ioVal}>
                  close_on ×{p.monitor.close_on}
                  {p.monitor.fail_on ? ` · fail_on ×${p.monitor.fail_on}` : ""}
                </span>
              </div>
              {caps?.serial.hint ? <div className={s.hint}>{caps.serial.hint}</div> : null}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
