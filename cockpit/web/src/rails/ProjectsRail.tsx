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
  /** 工程改名 / 移除 / 切换探针成功后由 App 收尾：刷新目录并重新选中 */
  onManaged: (res: {
    action: "rename" | "remove" | "set_probe";
    name: string;
    new_name?: string;
    probe?: string;
  }) => void;
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
  onManaged,
}: ProjectsRailProps) {
  // 串口能力来自 /api/capabilities（后端能力协商结果），不是前端猜的
  const serialOk = caps?.serial.available ?? false;
  // boot 子工程分组展开状态（默认展开——首次见到的用户仍能"看见"归属关系）
  const [bootOpen, setBootOpen] = useState<Record<string, boolean>>({});
  // 工程管理菜单（同一时刻只开一个）：重命名 / 重新探测 / 移除
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyMan, setBusyMan] = useState(false);
  const [manErr, setManErr] = useState("");
  const [manNote, setManNote] = useState("");
  // 探针胶囊（与 DSH 面板同源）：选项/可用性来自 capabilities.meta.probes
  const [probeFor, setProbeFor] = useState<string | null>(null);
  const [busyProbe, setBusyProbe] = useState(false);
  const probeList = caps?.meta?.probes?.list ?? [];

  async function doSetProbe(name: string, probe: string) {
    setBusyProbe(true);
    setManErr("");
    try {
      const r = await api.projectAdmin({ action: "set_probe", name, probe });
      setProbeFor(null);
      onManaged({ action: "set_probe", name, probe: r.probe ?? probe });
    } catch (e) {
      setManErr(errmsg(e));
    } finally {
      setBusyProbe(false);
    }
  }

  async function doRename(name: string) {
    const next = renameValue.trim();
    if (!next || next === name) {
      setMenuFor(null);
      return;
    }
    setBusyMan(true);
    setManErr("");
    setManNote("");
    try {
      const r = await api.projectAdmin({ action: "rename", name, new_name: next });
      setMenuFor(null);
      onManaged({ action: "rename", name, new_name: r.name });
    } catch (e) {
      setManErr(errmsg(e));
    } finally {
      setBusyMan(false);
    }
  }

  async function doRemove(name: string) {
    const ok = window.confirm(
      `移除工程 ${name}？\n\n只会删除 projects/${name}.yaml（自动保留 .yaml.bak），` +
        "业务工程一个字节都不会改；需要恢复时把 .bak 改回 .yaml 即可。",
    );
    if (!ok) return;
    setBusyMan(true);
    setManErr("");
    setManNote("");
    try {
      const r = await api.projectAdmin({ action: "remove", name });
      setMenuFor(null);
      onManaged({ action: "remove", name: r.name });
    } catch (e) {
      setManErr(errmsg(e));
    } finally {
      setBusyMan(false);
    }
  }

  /** 重新探测 = 只读校验：工程文件有没有变（identical / drift / missing）。 */
  async function doCheck(name: string, root: string) {
    setBusyMan(true);
    setManErr("");
    setManNote("");
    try {
      const r = await api.adapt({ action: "check", path: root, name });
      const st = r.result?.status ?? "";
      setManNote(
        st === "identical"
          ? "✓ 接入文件与工程当前状态一致（no-op）"
          : st === "drift"
            ? "⚠ 工程已变更（配置漂移）：建议重新适配写入，或手工核对"
            : st === "missing"
              ? "尚未适配（接入文件不存在）"
              : `检查结果：${st || "未知"}`,
      );
    } catch (e) {
      setManErr(errmsg(e));
    } finally {
      setBusyMan(false);
    }
  }

  /** 单张工程卡。bootChild=true 时渲染为宿主卡的正下方缩进形态（C1 归属语义）。 */
  const projectCard = (p: ProjectCard, bootChild = false) => {
    const isSel = p.name === selected;
    const blocked = (Object.keys(p.steps) as StepId[]).filter((k) => !p.steps[k].ok);
    const stamp = p.ota?.boot_stamp ?? null;
    return (
      <div className={s.cardWrap} key={p.name}>
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

      {/* 「⋯」工程管理：重命名 / 重新探测（只读）/ 移除接入文件 */}
      {!bootChild ? (
        <button
          type="button"
          className={[s.moreBtn, menuFor === p.name ? s.moreBtnOn : ""]
            .filter(Boolean)
            .join(" ")}
          aria-label={`管理工程 ${p.name}`}
          title="重命名 / 重新探测 / 移除"
          onClick={() => {
            const next = menuFor === p.name ? null : p.name;
            setMenuFor(next);
            setRenameValue(p.name);
            setManErr("");
            setManNote("");
          }}
        >
          ⋯
        </button>
      ) : null}

      {menuFor === p.name ? (
        <div className={s.menu} role="menu" aria-label={`工程 ${p.name} 管理`}>
          <div className={s.menuTitle}>
            <span className={s.menuName}>{p.name}</span>
            <span className={s.menuRoot} title={p.root}>{p.root}</span>
          </div>
          <label className={s.menuRename}>
            <span>重命名</span>
            <input
              className={s.menuInput}
              value={renameValue}
              onChange={(e) => setRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doRename(p.name);
                if (e.key === "Escape") setMenuFor(null);
              }}
              aria-label="新工程名"
              spellCheck={false}
            />
          </label>
          <div className={s.menuRow}>
            <Button variant="toolbar" disabled={busyMan} onClick={() => void doRename(p.name)}>
              改名
            </Button>
            <Button
              variant="toolbar"
              disabled={busyMan}
              title="只读复探测：工程变更后接入文件是否已漂移"
              onClick={() => void doCheck(p.name, p.root)}
            >
              重新探测
            </Button>
            <Button
              variant="toolbar"
              disabled={busyMan}
              title="移除 projects/<name>.yaml（保留 .bak；业务工程不动）"
              onClick={() => void doRemove(p.name)}
            >
              移除
            </Button>
          </div>
          {manErr ? <div className={s.adaptErr}>{manErr}</div> : null}
          {manNote ? <div className={s.adaptNote}>{manNote}</div> : null}
        </div>
      ) : null}
      </div>
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
        // 委托烧录/校验（steps.flash / debug_verify = tool:<name>）不需要探针
        const flashDelegated = Boolean(p.delegated?.flash || p.delegated?.debug_verify);
        // 芯片声明的调试后端（如 ESP-IDF）：无 probe 也能开调试页签；
        // 探针可能板载也可能需外接（ESP32-S31-Korvo-1 就需外接 JTAG）。
        const chipDebug = Boolean(p.debug_backend) && !p.probe;
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
              <div className={s.ioRow} style={{ position: "relative" }}>
                <IconPlug className={s.ioIcon} />
                <span className={s.ioLabel}>探针</span>
                <button
                  type="button"
                  disabled={locked || busyProbe || probeList.length === 0}
                  onClick={() => {
                    setManErr("");
                    setProbeFor(probeFor === p.name ? null : p.name);
                  }}
                  title={
                    probeList.length === 0
                      ? "内核未提供探针清单（同步内核后重试）"
                      : "切换 debug.probe（只改接入文件；调试会话打开时会失败）"
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    flex: "1 1 auto",
                    minWidth: 0,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    cursor: locked || busyProbe ? "default" : "pointer",
                    opacity: locked || busyProbe ? 0.6 : 1,
                  }}
                >
                  <span className={s.ioVal} title={flashDelegated ? "烧录/校验由项目工具执行（无需探针）" : (chipDebug ? `芯片调试后端 ${p.debug_backend}（探针可板载或外接）` : p.probe)}>
                    {p.probe || (flashDelegated ? "委托工具" : (chipDebug ? "调试后端" : "未声明"))}
                  </span>
                  <span style={{ fontSize: 9, color: "var(--elab-fg-faint)" }}>▾</span>
                </button>
                <Pill
                  tone={flashDelegated || chipDebug || (p.probe && p.steps.flash.ok) ? "green" : "red"}
                  title={flashDelegated
                    ? "烧录/校验委托给项目工具（如 esptool），走 USB 串口，不依赖探针"
                    : chipDebug
                      ? `芯片已声明调试后端：${p.debug_backend}；实际连接取决于探针（板载或外接），仍需烧录/调试时校验`
                      : "配置层面：工程已声明探针且烧录步骤可用；探针是否插好由烧录时 OpenOCD 判定"}
                >
                  {flashDelegated ? "委托工具" : chipDebug ? "调试后端" : (p.probe && p.steps.flash.ok ? "已配置" : "未配置")}
                </Pill>
                {probeFor === p.name ? (
                  <div
                    style={{
                      position: "absolute",
                      // ★ 向上弹（2026-11-03）：芯片卡在左栏最底部，向下弹会被视口下边缘
                      //   裁掉——用户只看到第一项（"显示不全"）。向上有工程列表的整片空间。
                      bottom: "calc(100% + 3px)",
                      left: 64,
                      zIndex: 50,
                      minWidth: 156,
                      maxHeight: "40vh",
                      overflowY: "auto",
                      padding: 4,
                      borderRadius: 6,
                      border: "1px solid var(--elab-border, #333)",
                      background: "var(--elab-bg-raised, #1b1b1f)",
                      boxShadow: "0 6px 18px rgba(0,0,0,.35)",
                    }}
                  >
                    {probeList.map((it) => {
                      const unavailable = it.available === false;
                      const active = it.name === p.probe;
                      return (
                        <button
                          key={it.name}
                          type="button"
                          disabled={unavailable || active || busyProbe}
                          onClick={() => void doSetProbe(p.name, it.name)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            width: "100%",
                            padding: "3px 6px",
                            border: "none",
                            borderRadius: 4,
                            background: "transparent",
                            color: unavailable
                              ? "var(--elab-fg-faint)"
                              : "var(--elab-fg-primary)",
                            fontSize: "var(--elab-fs-xs)",
                            textAlign: "left",
                            cursor: unavailable || active ? "default" : "pointer",
                          }}
                        >
                          <span>{it.name}</span>
                          <span
                            style={{
                              marginLeft: "auto",
                              fontSize: 9,
                              color: "var(--elab-fg-faint)",
                            }}
                          >
                            {unavailable ? "接口缺失" : active ? "当前" : "接口就绪"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              {probeFor === p.name && manErr ? (
                <div className={s.adaptErr}>{manErr}</div>
              ) : null}
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
  // 记住上次适配的工程路径：换工程/重导时少敲一次长路径（只存本地，不上传）
  const [path, setPath] = useState(() => {
    try {
      return localStorage.getItem("elab.adapt.path") ?? "";
    } catch {
      return "";
    }
  });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"probe" | "write" | null>(null);
  const [picking, setPicking] = useState(false);
  const [res, setRes] = useState<AdaptResponse | null>(null);
  const [err, setErr] = useState("");

  /** 请同机内核代开系统原生「选择文件夹」对话框（浏览器拿不到本地绝对路径）。 */
  async function browse(initial = "") {
    setPicking(true);
    setErr("");
    try {
      const r = await api.pickFolder(initial);
      if (r.path) {
        setOpen(true);
        setPath(r.path);
        setRes(null);
        await run("probe", r.path);
      }
    } catch (e) {
      // 无桌面会话 / 精简 Python 没有 tkinter：回落到手工输入
      setOpen(true);
      setErr(`无法打开系统目录选择框（${errmsg(e)}）—— 请手工输入绝对路径`);
    } finally {
      setPicking(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className={s.adaptBtn}
        aria-label="适配新工程"
        title="打开系统「选择文件夹」对话框，选中工程后自动只读探测"
        disabled={picking}
        onClick={() => void browse(path)}
      >
        {picking ? "选择中…" : "＋ 适配"}
      </button>
    );
  }

  const p = res?.probe;
  const blocked = !!p && (p.tier === "T3" || p.ambiguities.length > 0);
  const writeStatus = res?.action === "write" ? res.result?.status : undefined;
  const writeOk = writeStatus === "written" || writeStatus === "identical";

  async function run(action: "probe" | "write", target = path) {
    setBusy(action);
    setErr("");
    try {
      const r = await api.adapt({ action, path: target, name: name || undefined });
      setRes(r);
      setName(r.name);
      try {
        localStorage.setItem("elab.adapt.path", target.trim());
      } catch {
        /* 隐私模式禁用 localStorage：忽略 */
      }
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
        <button
          type="button"
          className={s.adaptBtn}
          aria-label="浏览工程目录"
          title="打开系统「选择文件夹」对话框"
          disabled={picking || busy !== null}
          onClick={() => void browse(path)}
        >
          {picking ? "选择中…" : "浏览…"}
        </button>
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
