import { useState } from "react";
import type { AdaptResponse, Capabilities, ProjectCard, StepId } from "../api/types";
import { api } from "../api/client";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { Pill, Tag } from "../primitives/Tag";
import { Tooltip } from "../primitives/Tooltip";
import { IconAlert, IconChip, IconCollapseLeft, IconPlug } from "../icons";
import { toggleRail } from "../store/layoutStore";
import s from "./ProjectsRail.module.css";

function errmsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ProjectsRailProps {
  cards: ProjectCard[];
  selected: string;
  onSelect: (name: string) => void;
  caps: Capabilities | null;
  /** 有 run 在跑时禁用切换（避免"看着 A 的日志、实际跑的是 B"） */
  locked: boolean;
  loading: boolean;
  /** 适配写入成功后由 App 收尾：刷新目录 + 选中新工程（M5.6） */
  onAdapted: (name: string) => void;
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
  onAdapted,
}: ProjectsRailProps) {
  // 串口能力来自 /api/capabilities（后端能力协商结果），不是前端猜的
  const serialOk = caps?.serial.available ?? false;
  // boot 子工程分组展开状态（默认展开——首次见到的用户仍能"看见"归属关系）
  const [bootOpen, setBootOpen] = useState<Record<string, boolean>>({});

  /** 单张工程卡。bootChild=true 时渲染为宿主卡的正下方缩进形态（C1 归属语义）。 */
  const projectCard = (p: ProjectCard, bootChild = false) => {
    const isSel = p.name === selected;
    const blocked = (Object.keys(p.steps) as StepId[]).filter((k) => !p.steps[k].ok);
    const stamp = p.ota?.boot_stamp ?? null;
    return (
      <button
        type="button"
        className={[s.card, isSel ? s.sel : "", bootChild ? s.cardBoot : ""]
          .filter(Boolean)
          .join(" ")}
        aria-current={isSel}
        disabled={locked && !isSel}
        title={locked && !isSel ? "有任务在跑，先取消或等它结束" : p.root}
        onClick={() => onSelect(p.name)}
      >
        <div className={s.row1}>
          {bootChild ? (
            <span className={s.bootLink} aria-hidden="true">
              ↳
            </span>
          ) : null}
          <span className={s.name}>{p.name}</span>
          {p.derived.built ? <span className={s.dotBuilt} title="已有构建产物" /> : null}
        </div>
        <div className={s.row2}>
          {bootChild ? (
            <Tag tone="violet" mono dense>
              BOOT 子工程 · {p.boot_owner}
            </Tag>
          ) : null}
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
        {/* OTA 关键信息（C3 冻结台账直读）：槽型 + boot 归属 + 冻结状态一行讲完 */}
        {p.ota && !bootChild ? (
          <div className={s.rowOta}>
            <Tag tone={stamp ? "green" : "amber"} mono dense>
              OTA{p.ota.slots > 1 ? ` 双槽×${p.ota.slots}` : " 单槽"}
            </Tag>
            <span className={s.otaText}>
              boot {p.ota.boot_project}
              {stamp
                ? ` v${stamp.version} · 冻结 ${stamp.flashed_at.slice(5, 16)}`
                : " · 未冻结（随下次烧录带上）"}
            </span>
          </div>
        ) : null}
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
  };

  return (
    <div className={s.rail}>
      <div className={s.head}>
        <span className={s.title}>工程</span>
        <span className={s.count}>{cards.length}</span>
        <span className={s.headSpacer} />
        <AdaptPanel onAdapted={onAdapted} locked={locked} />
        {/* 显式收起按钮（2026-10-08）：此前只有"拖拽条双击折叠"，用户根本发现不了。
            收起是整列行为 —— 连同底部芯片型号信息板一起藏起，专注驾驶舱状态。 */}
        <Tooltip side="bottom" tip="收起工程列（连芯片信息一起），专注驾驶舱；点击左缘竖条可展开">
          <Button variant="toolbar" onClick={() => toggleRail("projects")} aria-label="收起工程列">
            <IconCollapseLeft />
          </Button>
        </Tooltip>
      </div>

      <div className={s.list}>
        {loading ? <div className={s.note}>读取 projects/*.yaml …</div> : null}
        {!loading && cards.length === 0 ? (
          <div className={s.note}>没有工程。在 projects/ 下加一个 *.yaml 就会出现在这里。</div>
        ) : null}

        {/* boot 子工程（C1）不与宿主并列：嵌在宿主卡正下方，分组可收起。
            归属来自 /api/projects 的 boot_owner（交叉引用派生），前端零推导。 */}
        {cards
          .filter((p) => !p.boot_owner)
          .map((p) => {
            const kids = cards.filter((k) => k.boot_owner === p.name);
            const open = bootOpen[p.name] ?? true;
            return (
              <div key={p.name} className={s.combo}>
                {projectCard(p)}
                {kids.length > 0 ? (
                  <div className={s.bootGroup}>
                    {/* 披露按钮独立于卡片 <button> 之外（button 不可嵌套），
                        收起后仍显示组头，归属关系不失联 */}
                    <button
                      type="button"
                      className={s.bootToggle}
                      aria-expanded={open}
                      title={open ? "收起 boot 子工程" : "展开 boot 子工程"}
                      onClick={() =>
                        setBootOpen((m) => ({ ...m, [p.name]: !open }))
                      }
                    >
                      <span className={s.bootChevron} aria-hidden="true">
                        {open ? "▾" : "▸"}
                      </span>
                      <span>
                        boot 子工程 · {kids.map((k) => k.name).join("、")}
                      </span>
                    </button>
                    {open
                      ? kids.map((k) => (
                          <div key={k.name} className={s.bootChild}>
                            {projectCard(k, true)}
                          </div>
                        ))
                      : null}
                  </div>
                ) : null}
              </div>
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
              {p.ota ? (
                <>
                  <dt>OTA</dt>
                  <dd>
                    {p.ota.slots > 1 ? "双槽 A/B" : "单槽"}
                    {" · boot "}
                    <span className={s.mono}>{p.ota.boot_project || "—"}</span>
                    {p.ota.boot_stamp
                      ? ` · v${p.ota.boot_stamp.version}（${p.ota.boot_stamp.flashed_at} 冻结）`
                      : " · 未冻结"}
                  </dd>
                </>
              ) : null}
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

/**
 * 一键适配面板（M5.6）—— 收起时只是标题栏里的一个小按钮。
 *
 * ★ 流程刻意做成**两段**：先「探测」（只读，把将生成的接入文件摆在明面上），
 *   再「写入」。与后端 probe/write 两段式一一对应 —— "落不落盘"不许藏在一个
 *   按钮里（与 /api/plan → /api/run 的动词纪律同一条）。
 * ★ 三绿灯 verify **不在这里做**：那是 build 级长任务，写完引导用户去点
 *   「体检 + 编译」—— 复用现有 run 通道，进度走 SSE、结果落事件流。
 */
function AdaptPanel({
  onAdapted,
  locked,
}: {
  onAdapted: (name: string) => void;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"probe" | "write" | null>(null);
  const [res, setRes] = useState<AdaptResponse | null>(null);
  const [err, setErr] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        className={s.adaptBtn}
        aria-label="适配新工程"
        title="把图形配置器导出的工程接进 elab（先探测，再写入）"
        onClick={() => {
          setOpen(true);
          setRes(null);
          setErr("");
        }}
      >
        ＋ 适配
      </button>
    );
  }

  const p = res?.probe;
  const blocked = !!p && (p.tier === "T3" || p.ambiguities.length > 0);
  const writeStatus = res?.action === "write" ? res.result?.status : undefined;
  const writeOk = writeStatus === "written" || writeStatus === "identical";

  async function run(action: "probe" | "write") {
    setBusy(action);
    setErr("");
    try {
      const r = await api.adapt({ action, path, name: name || undefined });
      setRes(r);
      setName(r.name);
      if (action === "write" &&
          (r.result?.status === "written" || r.result?.status === "identical")) {
        onAdapted(r.name);
      }
    } catch (e) {
      setErr(errmsg(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={s.adaptBox} role="group" aria-label="适配新工程">
      <div className={s.adaptRow}>
        <Input
          mono
          value={path}
          onChange={(e) => setPath(e.currentTarget.value)}
          placeholder="工程根目录（绝对路径，含 CMakeLists.txt）"
          aria-label="待适配工程路径"
        />
        <Button
          variant="toolbar"
          disabled={!path.trim() || busy !== null}
          onClick={() => void run("probe")}
        >
          {busy === "probe" ? "探测中…" : "探测"}
        </Button>
        <Button
          variant="toolbar"
          disabled={blocked || busy !== null || !res}
          title={
            blocked
              ? "先解决探测给出的阻断项（或用 CLI elab adapt --write --force）"
              : "写入 projects/<name>.yaml"
          }
          onClick={() => void run("write")}
        >
          {busy === "write" ? "写入中…" : "写入"}
        </Button>
        <button
          type="button"
          className={s.adaptBtn}
          aria-label="收起适配面板"
          onClick={() => setOpen(false)}
        >
          收起
        </button>
      </div>

      {err ? (
        <div className={s.adaptErr} role="alert">
          <IconAlert className={s.warnIcon} />
          {err}
        </div>
      ) : null}

      {p ? (
        <div className={s.adaptResult}>
          <div className={s.adaptTags}>
            {p.tier === "T3" ? (
              <Tag tone="red" mono dense>T3 · 无 CMakeLists</Tag>
            ) : (
              <Tag tone="green" mono dense>{p.tier} · 可适配</Tag>
            )}
            <Tag dense tone={p.confidence === "high" ? "blue" : "neutral"}>
              置信度 {p.confidence}
            </Tag>
            {p.generator ? <Tag dense tone="neutral">{p.generator}</Tag> : null}
            {p.chip_ref ? <Tag tone="blue" mono dense>{p.chip_ref}</Tag> : null}
            {p.baud ? <Tag dense tone="neutral">{p.usart || "串口"} @ {p.baud}</Tag> : null}
          </div>

          {p.tier === "T3" ? (
            <div className={s.adaptNote}>
              在图形配置器（AT32 WorkBench / STM32CubeMX）里把工具链切换到 CMake
              后重新导出，再回来探测。
            </div>
          ) : null}

          {p.ambiguities.length > 0 ? (
            <div className={s.adaptErr}>
              <IconAlert className={s.warnIcon} />
              <span>
                阻断项（探测不猜，须人工裁决）：
                {p.ambiguities.join("；")}
              </span>
            </div>
          ) : null}

          <label className={s.adaptNameRow}>
            <span className={s.adaptNameLabel}>工程名</span>
            <Input
              mono
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              aria-label="写入的工程名"
            />
          </label>

          {writeStatus ? (
            <div className={writeOk ? s.adaptNote : s.adaptErr}>
              {writeOk ? (
                <>
                  ✓ {writeStatus === "written" ? "已写入" : "内容一致（幂等）"}
                  {" — "}
                  {res?.next.hint}（{res?.next.steps.join(" + ")}）
                </>
              ) : writeStatus === "hand-edited" ? (
                "该工程已被人工接管（generated-by 标记缺失），未覆盖 —— 如确需重生成，用 CLI：elab adapt <path> --write --force"
              ) : writeStatus === "differs" ? (
                "已存在且内容不同，未覆盖 —— 用 CLI：elab adapt <path> --write --force（会先备份 .bak）"
              ) : (
                `写入结果：${writeStatus}`
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {locked ? (
        <div className={s.adaptNote}>有任务在跑 —— 适配只读不受影响，但写入后请等它结束再验证。</div>
      ) : null}
    </div>
  );
}
