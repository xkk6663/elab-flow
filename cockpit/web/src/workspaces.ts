/**
 * 工作区注册表 —— 驾驶舱右列的**单一事实源**。
 *
 * 背景（UI 架构重构，2026-10-08）：此前"加一个 Tab 改 6 处"
 * （LogTab 联合类型 / LogBook ring / clearAll / counts / tabOfEvent /
 * EvidenceRail 四件套），OTA Tab 的白屏事故正是漏改 ring 一处直接崩树。
 * 根治方式：把"工作区"的全部元数据收敛到这一张表 —— 导航项、日志通道、
 * 顶栏快捷动作、置灰理由、空屏文案都从这里派生，**加一个工作区 = 加一条记录**。
 *
 * 工作区 = "一次作业"：构建、烧录、串口是三个静态作业台；
 * 项目声明工具（projects/*.yaml 的 tools: 节）按卡片**动态**生成作业台
 * —— 工具的启动按钮就住在自己的工作区里（此前在阶段轨，职责错位）。
 *
 * 红线：本文件只描述"哪个事件进哪个通道"与"界面长什么样"，
 * 不改任何数据层语义（C24 SSE 单路 / C26 stream/closed / C28 留档非 state）。
 */

import type { Capabilities, ProjectCard } from "./api/types";

export type WorkspaceId = string;

export interface WorkspaceDef {
  id: WorkspaceId;
  /** 导航按钮文案 */
  label: string;
  /** 日志通道名（= LogBook 的 key，事件按 channelOfEvent 落进同名环形缓冲） */
  channel: string;
  /**
   * 工作区顶栏的快捷动作（step id 或 `tool:<name>`）。
   * 构建 Tab 里有「编译」、烧录 Tab 里有「烧录 / 调试校验」、
   * 工具工作区里有「启动」—— 单步执行就该出现在"干这件事的界面"里。
   */
  steps: string[];
  /** 工具工作区给启动按钮一个业务名（如「OTA 升级」）；缺省用 stepLabel */
  actionLabel?: string;
  dim: (card: ProjectCard | null, caps: Capabilities | null) => boolean;
  dimReason: (card: ProjectCard | null, caps: Capabilities | null) => string;
  emptyText: (card: ProjectCard | null, caps: Capabilities | null) => string;
}

/* ── 静态工作区 ─────────────────────────────────────────────── */

const buildWs: WorkspaceDef = {
  id: "build",
  label: "构建",
  channel: "build",
  steps: ["build"],
  dim: () => false,
  dimReason: () => "",
  emptyText: () => "尚无构建输出。点「跑全闭环」或单步「编译」。",
};

const flashWs: WorkspaceDef = {
  id: "flash",
  label: "烧录",
  channel: "flash",
  steps: ["flash", "debug_verify"],
  dim: () => false,
  dimReason: () => "",
  emptyText: () => "尚无烧录输出。点「跑全闭环」或单步「烧录」。",
};

const serialWs: WorkspaceDef = {
  id: "serial",
  label: "串口",
  channel: "serial",
  steps: [],
  dim: (_card, caps) => !(caps?.serial.available ?? false),
  dimReason: (_card, caps) => caps?.serial.hint ?? "串口后端不可用",
  emptyText: (_card, caps) => {
    if (!caps) return "正在读取串口能力…";
    if (!caps.serial.available) {
      return `串口后端不可用（layer=${caps.serial.layer}）。${caps.serial.hint ?? ""}`;
    }
    // 有服务端留档却还是空屏 = 回填被跳过了（例如留档属于别的工程）。
    // 把这件事说出来，否则用户会以为"我明明敲过，怎么什么都没了"。
    if (caps.serial.console.count > 0) {
      return (
        `服务端存有 ${caps.serial.console.count} 条串口留档，但本工程一条也没有` +
        `（留档按工程区分）。点「打开监视」实时看设备输出，` +
        `或在下框手敲一行发给设备。`
      );
    }
    return (
      "尚无串口输出。点「打开监视」实时看设备打印（或跑一次含 monitor 的闭环）；" +
      "也可以直接在下方框里手敲一行发给设备。"
    );
  },
};

/**
 * 调试工作区（P1–P3）：断点/单步/内存/反汇编/监视/外设(SVD)/RTOS 栈水位。
 * ★ 能力门禁走内核自描述 `capabilities.meta.debug`：缺失 = 内核过旧，置灰并提示同步。
 */
const debugWs: WorkspaceDef = {
  id: "debug",
  label: "调试",
  channel: "debug",
  steps: [],
  dim: (card, caps) =>
    !(caps?.meta?.debug?.available ?? false) || !(card?.probe || card?.debug_backend),
  dimReason: (card, caps) =>
    !(caps?.meta?.debug?.available ?? false)
      ? (caps?.meta?.debug
          ? "调试后端不可用"
          : "内核过旧：缺少 meta.debug（请同步 elab 内核）")
      : !(card?.probe || card?.debug_backend)
        ? "该工程既未声明调试探针，芯片也未提供调试后端"
        : "调试后端不可用",
  emptyText: (_card, caps) => {
    if (!caps?.meta?.debug) {
      return "内核未提供调试能力自描述（meta.debug）。请同步内核后重载本页。";
    }
    return "调试工作区：点「开始调试」建立会话（会复位目标并停在 main）。";
  },
};

/** 静态工作区（顺序即导航顺序） */
export const STATIC_WORKSPACES: WorkspaceDef[] = [buildWs, flashWs, serialWs, debugWs];

/**
 * 工具工作区（单一「工具」页，2026-10-08 二次收敛）：
 * 每个工具一个导航 Tab 的第一版实测 7 个 Tab 挤爆右列（用户截图：显示不全），
 * 且"OTA 相关的单步步骤应该放到 OTA 页面里"——工具的全部动作按钮收进**一个**
 * 工作区，日志合进一个通道（step-enter/exit marker 区分是哪次工具），
 * 导航恒为 构建|烧录|串口|工具 四项，永不随工具数量膨胀。
 */
function toolsWs(card: ProjectCard | null, caps: Capabilities | null): WorkspaceDef | null {
  const tools = (card?.tools ?? []).filter((t) => toolEnabled(t.name, caps));
  if (tools.length === 0) return null;
  return {
    id: "tools",
    label: "工具",
    channel: "tools",
    steps: tools.map((t) => `tool:${t.name}`),
    dim: () => false,
    dimReason: () => "",
    emptyText: () => {
      const names = tools.map((t) => `「${t.label}」`).join("、");
      return `尚无工具输出。上方按钮发起项目声明工具（${names}，命令在 projects/*.yaml 的 tools: 节），输出实时进本工作区。`;
    },
  };
}

/* ── profile 装配（R7 / P1-4：cockpit/profiles/*.yaml → capabilities.meta.profile）── */

function profileOf(caps: Capabilities | null) {
  return caps?.meta?.profile ?? null;
}

/** 工具启停：exclude 优先；include 非空 = 只启用列出的工具。 */
function toolEnabled(name: string, caps: Capabilities | null): boolean {
  const t = profileOf(caps)?.tools;
  if (!t) return true;
  if ((t.exclude ?? []).includes(name)) return false;
  const inc = t.include ?? [];
  return inc.length === 0 || inc.includes(name);
}

/**
 * 当前工程的完整工作区列表 = 静态三个 + 「工具」页（卡片声明了 tools: 才出现），
 * 再按 profile 的 `workspaces` 重排/裁剪（缺省或空 = 内置顺序）。
 */
export function workspacesFor(
  card: ProjectCard | null,
  caps: Capabilities | null,
): WorkspaceDef[] {
  const tools = toolsWs(card, caps);
  const defs = tools ? [...STATIC_WORKSPACES, tools] : [...STATIC_WORKSPACES];
  const wanted = profileOf(caps)?.workspaces ?? [];
  if (wanted.length === 0) return defs;
  const ordered = wanted
    .map((id) => defs.find((w) => w.id === id))
    .filter((w): w is WorkspaceDef => w !== undefined);
  // profile 写了未知 id（内核/前端版本不一致）→ 原地回退，不留空右列
  return ordered.length > 0 ? ordered : defs;
}

/** 按 id 找工作区；找不到返回 null（调用方决定回退） */
export function workspaceById(
  card: ProjectCard | null,
  caps: Capabilities | null,
  id: WorkspaceId,
): WorkspaceDef | null {
  return workspacesFor(card, caps).find((w) => w.id === id) ?? null;
}

/* ── 事件 → 通道归类（唯一规则在共享层，本宿主用默认口径）───────── */

/**
 * 事件 → 日志通道名。null = 不属于任何日志通道（如 run/start、心跳类）。
 *
 * ★ 规则本体在 `@elab/cockpit-ui-core`（与 DSH 插件面板同一份）；
 *   本宿主用默认口径：`debug_verify` 与 `flash` 共用「烧录」通道
 *   （三列布局里烧录轨一并展示编程与调试校验输出）。
 *
 *   1. `serial/*`                    → 串口
 *   2. step 为 `tool:<name>`         → 「工具」通道
 *   3. proc/* 与 run/step-* 按 step：
 *      flash / debug_verify → 烧录；monitor → 串口；其余 → 构建
 *      （doctor 归"构建"是有意的：宿主侧纯文本步骤共用一个面板）
 */
export { channelOfEvent } from "@elab/cockpit-ui-core";
