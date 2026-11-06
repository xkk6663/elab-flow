import type {
  AdaptResponse,
  Capabilities,
  DebugAuditResponse,
  DebugBreakpointsResponse,
  DebugControlResponse,
  DebugDisasmResponse,
  DebugEvaluateResponse,
  DebugMemoryResponse,
  DebugOpenOptions,
  DebugPeripheralsResponse,
  DebugRegistersResponse,
  DebugRegistersWriteResponse,
  DebugRtosResponse,
  DebugSessionResponse,
  DebugSourceResponse,
  DebugStackResponse,
  DebugVariablesResponse,
  DebugWatchResponse,
  ElabEvent,
  PlanPreview,
  ProjectsResponse,
  RunsResponse,
  SerialBytesTail,
  SerialPollResponse,
  SerialConsoleResponse,
  SerialControlResult,
  SerialControlStateResponse,
  SerialDecodeResult,
  SerialDecodedTail,
  SerialFormat,
  SerialFramesResponse,
  SerialFrameEncodeResult,
  SerialFrameTemplatesResponse,
  SerialIssue,
  SerialLogProfile,
  SerialMonitorSnapshot,
  SerialSymbol,
  SerialMonitorTail,
  SerialPreviewResult,
  SerialWriteResult,
  SerialWidget,
  SerialWidgetJob,
  SerialWidgetRunResult,
  SerialWidgetsResponse,
  StepId,
  PacksStatus,
  PkgJob,
  PkgVerifyResult,
} from "./types";
import type {
  ModbusMap,
  ModbusRunResult,
  ModbusStateResponse,
  ModbusTxn,
} from "../modbus/types";

/** 后端契约版本；与 ICD 的 EVENT_SCHEMA_VERSION 比对，不一致就显式报错而不是渲染错位界面 */
import { EVENT_SCHEMA_VERSION } from "./types";

/**
 * 后端错误：保留内核的 `code` / `hint`。
 *
 * 内核两种错误体都要认（早期只认 `{"error": "..."}`，把 hint 丢了）：
 * - 通用：`{"error": "人话"}`
 * - 调试：`{"error": "人话", "code": "debug-xxx", "message": "人话", "hint": "…"}`
 *   → `code` / `hint` 是**同级**字段，不在 `error` 里面
 */
export class ApiError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly status: number;
  constructor(code: string, message: string, extra?: { hint?: string; status?: number }) {
    super(message);
    this.code = code;
    this.hint = extra?.hint ?? "";
    this.status = extra?.status ?? 0;
    this.name = "ApiError";
  }
}

function str(v: unknown): string {
  return typeof v === "string" && v !== "" ? v : "";
}

/**
 * 默认请求超时 / 长任务超时（毫秒）。
 *
 * ★ 为什么**必须**有超时（实测过的故障形态，不是理论）：
 *   `fetch` 默认**永不超时**（只在 TCP 层可能挂几分钟）。内核被强杀、
 *   探针被别的进程占着（`POST /api/debug/session` 的 openocd 等待上限 20 s）、
 *   或某条同步端点卡死时，请求会一直挂着 → 界面永远是「加载中」，且没有取消入口。
 *   更糟的是 HTTP/1.1 同域只有 6 个并发连接：挂住的请求会占住名额，
 *   **其它所有 API 跟着排队**，用户看到的是「整个界面点了没反应」。
 *
 * 15 s 覆盖全部秒级端点（含 monitor/decoded 这类增量读）；
 * 明确会等硬件的端点（openocd 20 s、learn 大样本、串口手写读窗口）
 * 单独用 {@link TIMEOUT_LONG_MS}。
 */
const TIMEOUT_DEFAULT_MS = 15_000;
const TIMEOUT_LONG_MS = 60_000;

/** `AbortSignal.timeout` 的兜底（Safari < 16 / 老 Chromium 没有它）。 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController === "undefined") return undefined;
  const ac = new AbortController();
  window.setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

/** 这一次失败是不是"我们主动掐掉的"（超时）。 */
function isTimeout(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

async function req<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = TIMEOUT_DEFAULT_MS,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      // 调用方显式给了 signal 就用它的（目前无调用方传，留给将来的"取消"按钮）
      signal: init?.signal ?? timeoutSignal(timeoutMs),
      headers: { Accept: "application/json", ...(init?.headers || {}) },
    });
  } catch (e) {
    if (isTimeout(e)) {
      // ★ 文案要能直接指导下一步：只说"超时"用户不知道是网络还是内核死了。
      throw new ApiError(
        "client-timeout",
        `请求超时（${Math.round(timeoutMs / 1000)} s 未响应）：内核可能正忙或已停止响应`,
        { hint: "确认 elab 内核仍在运行；若刚强杀过它，请等面板自动重连后再试" },
      );
    }
    throw e;
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const b = (body ?? {}) as Record<string, unknown>;
    const raw = b.error;
    const nested = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const code = str(nested?.code) || str(b.code) || `http-${res.status}`;
    const message = str(nested?.message) || str(raw) || str(b.message) || `HTTP ${res.status}`;
    const hint = str(nested?.hint) || str(b.hint);
    throw new ApiError(code, message, { hint, status: res.status });
  }
  return body as T;
}

function post<T>(path: string, body: unknown, timeoutMs: number = TIMEOUT_DEFAULT_MS): Promise<T> {
  return req<T>(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

export const api = {
  capabilities: () => req<Capabilities>("/api/capabilities"),
  projects: () => req<ProjectsResponse>("/api/projects"),
  runs: () => req<RunsResponse>("/api/runs"),
  /**
   * 只读「当前在跑的 run」——**不扫历史目录**。
   *
   * ★ 为什么不复用 `runs()`：`/api/runs` 要为每条历史 run 读首尾行（哪怕已优化过），
   *   开销随历史条数增长；而 App 的 2 s 轮询只关心 `active`
   *   （"agent 是不是在别的工程起跑了"）。用轻量端点让轮询与历史规模**解耦**。
   */
  runsActive: () => req<Pick<RunsResponse, "active">>("/api/runs/active"),
  runEvents: (run: string, from = 0) =>
    req<{ events: ElabEvent[] }>(
      `/api/run-events?run=${encodeURIComponent(run)}&from=${from}`,
    ),

  /**
   * 只读命令预览（M2「先看命令再执行」）。
   *
   * ★ 走 **GET**：它没有副作用（不 spawn、不写盘、不发射事件）。
   *   用 POST 会让人以为"点了就动手了"，与它的语义相反。
   */
  plan: (opts: { project: string; steps?: StepId[]; clean?: boolean; jobs?: number }) => {
    const q = new URLSearchParams({ project: opts.project });
    if (opts.steps && opts.steps.length) q.set("steps", opts.steps.join(","));
    if (opts.clean) q.set("clean", "1");
    if (opts.jobs) q.set("jobs", String(opts.jobs));
    return req<PlanPreview>(`/api/plan?${q.toString()}`);
  },

  startRun: (opts: {
    project: string;
    steps?: StepId[];
    clean?: boolean;
    jobs?: number;
  }) =>
    req<{ run: string; project: string; steps: string[]; pid: number }>(
      "/api/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      },
    ),

  cancelRun: (run: string, reason = "用户取消") =>
    req<{ ok: boolean; run: string; rc: number | null; error?: string }>(
      "/api/cancel",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run, reason }),
      },
    ),

  /**
   * 手写通道（M3-b）：写一条出去、收一小段回显 —— **一次请求内闭环**。
   *
   * ★ 走 **POST**：它会**真往设备写字节**，是明确的副作用操作。
   *   与 `/api/plan`（只读预览、走 GET）正好相对 —— 两个端点的动词选择
   *   本身就是"有没有副作用"的声明。
   *
   * 抛错只发生在 400（请求不合法）与 409（串口被在跑的闭环占着）；
   * "写失败"是 **200 + ok:false**，见 `SerialWriteResult` 的注释。
   */
  serial: (opts: {
    project: string;
    data: string;
    port?: string;
    baud?: number;
    /** 线参数覆盖（M1）：如 `8N1` / `7E1`；缺省取工程/宿主配置 */
    line?: string;
    readMs?: number;
    newline?: boolean;
    hex?: boolean;
    /** 发送表示（P1）：ascii/utf8/gbk/hex；与 `hex` 是别名关系 */
    format?: SerialFormat | "text";
    /** 行结束符：none/lf/cr/crlf/tab */
    eol?: string;
    /** 文本编码：utf-8/gbk */
    encoding?: string;
  }) =>
    req<SerialWriteResult>("/api/serial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: opts.project,
        data: opts.data,
        port: opts.port,
        baud: opts.baud,
        line: opts.line,
        read_ms: opts.readMs,
        newline: opts.newline,
        hex: opts.hex,
        format: opts.format,
        eol: opts.eol,
        encoding: opts.encoding,
      }),
    }, TIMEOUT_LONG_MS),

  /** 发送框定时发送：瞬态任务（不落盘），与组件共用内核任务引擎。 */
  serialLoop: (opts: {
    project: string;
    data: string;
    port?: string;
    baud?: number;
    format?: SerialFormat;
    eol?: string;
    encoding?: string;
    interval_ms?: number;
    count?: number;
    dry_run?: boolean;
  }) =>
    req<SerialWidgetRunResult>("/api/serial/loop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),

  /**
   * 只算字节、不碰串口（`dry_run`）。
   * ★ 「自动格式」与字节预览的**唯一事实源**在服务端 ——
   *   前端不在本地编码，否则"预览的字节"与"真发出去的字节"会漂移。
   */
  serialPreview: (opts: {
    project: string;
    data: string;
    port?: string;
    baud?: number;
    /** 线参数覆盖（M1）：预览把"将要用哪条线"一并显示出来 */
    line?: string;
    format?: SerialFormat;
    eol?: string;
    encoding?: string;
  }) =>
    req<SerialPreviewResult>("/api/serial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...opts, dry_run: true }),
    }),

  /**
   * 手写通道的**服务端留档**（M3-b2）。
   *
   * ★ 走 **GET**：纯读，没有副作用 —— 与 `serial()`（POST，会真往设备写字节）
   *   正好相对。同一个模块里两个端点的动词选择，本身就是"有没有副作用"的声明。
   *
   * ★ 这份留档**不是** run 事件流：写通道不属于任何 run，所以它既不能被 SSE
   *   推送，也没有 `seq` 可增量拉取 —— 只能"进来时拉一段最近的"（见 App 的回填）。
   */
  serialConsole: (limit = 50) =>
    req<SerialConsoleResponse>(`/api/serial/console?limit=${encodeURIComponent(limit)}`),

  /**
   * 常驻串口监视（serialmon）：增量读回 + 会话状态。
   *
   * ★ 走 **GET**：读的是"设备说过什么"，纯读无副作用 —— 与 `serialMonitorToggle`
   *   （POST，会开关串口会话）相对，动词纪律同 `serial` / `serialConsole`。
   *   `after` = 浏览器已收到的最大 `seq`；服务端只回 `seq > after` 的行。
   */
  serialMonitor: (after: number) =>
    req<SerialMonitorTail>(`/api/serial/monitor?after=${encodeURIComponent(after)}`),

  /**
   * 会话级共享解码帧（P3.5/M7）：agent 与面板读**同一份**（帧带 t_us）。
   * ★ 波形 Δt 的时间源 —— 没有它时 Δt 显示 `—`，不编造。
   */
  serialDecoded: (after: number) =>
    req<SerialDecodedTail>(`/api/serial/monitor/decoded?after=${encodeURIComponent(after)}`),

  /**
   * 字节面增量拉取（P1）—— **原文为真**，行只是投影。
   *
   * ★ 默认 `dir=all`（含 TX/RX）；`limit` 截断时调用方按最后一条的 `seq` 继续拉。
   */
  serialMonitorBytes: (after: number, opts?: { dir?: "all" | "rx" | "tx"; limit?: number }) => {
    const q = new URLSearchParams({ after: String(after) });
    q.set("dir", opts?.dir ?? "all");
    if (opts?.limit) q.set("limit", String(opts.limit));
    return req<SerialBytesTail>(`/api/serial/monitor/bytes?${q.toString()}`);
  },

  /**
   * 四路增量合并轮询（盘点 #4）：行 + 字节批次 + 结构化 issue + 共享解码帧，
   * **一次请求**带回（issues/decoded 由服务端按 profile/decoder 开关决定）。
   * 轮询连接占用 4 → 1；四路是同一时刻的快照，前端不必再自己拼时序。
   */
  serialPoll: (cursors: {
    line: number;
    byte: number;
    issue: number;
    dec: number;
    dir?: "all" | "rx" | "tx";
  }) => {
    const q = new URLSearchParams({
      line: String(cursors.line),
      byte: String(cursors.byte),
      issue: String(cursors.issue),
      dec: String(cursors.dec),
    });
    q.set("dir", cursors.dir ?? "all");
    return req<SerialPollResponse>(`/api/serial/monitor/poll?${q.toString()}`);
  },

  /**
   * 历史 run 清理（盘点 #11；CLI `elab runs prune` 同一份规则）。
   * keep/days 缺省与 CLI 一致（50 / 30）；days=0 关时间闸；先 dry_run 预览。
   */
  runsPrune: (opts?: { keep?: number; days?: number; dryRun?: boolean }) =>
    req<{
      removed: Array<{ run: string; files: string[]; bytes: number }>;
      kept: number;
      freed_bytes: number;
      dry_run: boolean;
    }>("/api/runs/prune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(opts?.keep !== undefined ? { keep: opts.keep } : {}),
        ...(opts?.days !== undefined ? { days: opts.days } : {}),
        dry_run: opts?.dryRun !== false,
      }),
    }, TIMEOUT_LONG_MS),

  /** 打开/关闭/清空/暂停/继续监视会话。POST = 明确的副作用（占住/释放独占资源）。 */
  serialMonitorToggle: (
    action: "open" | "close" | "clear" | "pause" | "resume" | "restore"
      | "log_profile" | "decoder",
    opts?: {
      project?: string;
      baud?: number;
      port?: string;
      /** 线参数覆盖（M1）：仅 open 有意义（打开时属性） */
      line?: string;
      actor?: "human" | "agent";
      lease_s?: number;
      allow_agent_write?: boolean;
      decoder?: string;
      log_profile?: string;
      /** 连接方式（M4）：serial / tcp-client / tcp-server / udp */
      transport?: string;
      /** 网络配置（M4）：host/port 或 bind/port + allow_remote */
      net?: Record<string, unknown>;
    },
  ) =>
    req<SerialMonitorSnapshot & {
      ok: boolean;
      note?: string;
      error?: string | null;
      cleared_lines?: number;
      cleared_chunks?: number;
      paused?: boolean;
    }>("/api/serial/monitor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        project: opts?.project,
        baud: opts?.baud,
        port: opts?.port,
        line: opts?.line,
        actor: opts?.actor,
        lease_s: opts?.lease_s,
        allow_agent_write: opts?.allow_agent_write,
        decoder: opts?.decoder,
        log_profile: opts?.log_profile,
        transport: opts?.transport,
        net: opts?.net,
      }),
    }),

  // ── 线参数 / DTR-RTS（M1）─────────────────────────────────────
  /**
   * 复位预设清单 + 当前已知线态 + 序列进度。GET = 纯读。
   *
   * ★ 预设来自 `pack.yaml: serial.reset_presets`（芯片差异不写进内核）；
   *   包里没有预设时只返回原始 DTR/RTS 开关所需的空清单。
   */
  serialControlState: (project: string) =>
    req<SerialControlStateResponse>(
      `/api/serial/control?project=${encodeURIComponent(project)}`,
    ),

  // ── 日志诊断（M6）──────────────────────────────────────────────
  /** 可用日志 profile（包 + 工程覆盖）；只读，规则不写死在前端。 */
  serialLogProfiles: (project: string) =>
    req<{ profiles: SerialLogProfile[] }>(
      `/api/serial/log-profiles?project=${encodeURIComponent(project)}`,
    ),

  /** 结构化异常增量读回（panic / hardfault / reset）。 */
  serialIssues: (after: number) =>
    req<SerialMonitorSnapshot & {
      issues: SerialIssue[];
      issue_total: number;
      issue_covered: number;
      gap: number;
      profile: string;
    }>(`/api/serial/monitor/issues?after=${after}`),

  /** 地址 → 函数/文件:行；失败如实返回（ROM 地址标 note，不编造）。 */
  serialSymbolize: (project: string, addrs: string[], profile = "") =>
    req<{
      ok: boolean;
      error: string | null;
      elf?: string;
      tool?: string;
      symbols: SerialSymbol[];
    }>("/api/serial/symbolize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, addrs, profile }),
    }),

  /**
   * 动 DTR/RTS 或跑/取消复位序列。POST = 明确副作用（物理线路动作）。
   *
   * ★ 这是**线路动作**，不是数据：不进字节环、不算 TX、不写 console 日志。
   *   有监视会话时复用同一句柄；没有时会临时开户（open 本身可能拉 DTR）。
   */
  serialControl: (opts: {
    project?: string;
    port?: string;
    line?: string;
    dtr?: boolean;
    rts?: boolean;
    /** 预设名（跑 pack.yaml 里的 steps；异步执行） */
    preset?: string;
    /** true = 取消正在跑的预设序列 */
    cancel?: boolean;
  }) =>
    req<SerialControlResult>("/api/serial/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),

  // ── 自定义发送组件（M1）───────────────────────────────────────
  /**
   * 工程级发送组件（只读投影：rev / widgets / warnings）。
   * GET = 纯读；写动作走 `serialWidgetSave`（POST，会改工程文件）。
   */
  serialWidgets: (project: string) =>
    req<SerialWidgetsResponse>(
      `/api/serial/widgets?project=${encodeURIComponent(project)}`,
    ),

  /**
   * 保存/删除组件。**必须带 rev**：服务端用乐观锁，人的修改不会被旧副本覆盖。
   * rev 不匹配 → HTTP 409，`SerialWidgetsResponse.conflict=true` 且带最新内容。
   */
  serialWidgetSave: (opts: {
    project: string;
    action: "save" | "delete";
    rev: number;
    widget?: SerialWidget;
    id?: string;
  }) =>
    post<SerialWidgetsResponse>("/api/serial/widgets", {
      project: opts.project,
      action: opts.action,
      rev: opts.rev,
      widget: opts.widget,
      id: opts.id,
    }),

  /**
   * 执行组件（`dryRun` 只渲染、不写口）。
   * ★ 400 = 参数/模板不合法；409 = 有闭环占用串口，或已有组件任务在跑；
   *   写口失败是 **200 + ok:false**（与 `serial()` 同一条纪律）。
   */
  serialWidgetRun: (opts: {
    project: string;
    id: string;
    params?: Record<string, unknown>;
    dryRun?: boolean;
    repeat?: boolean;
    confirm?: boolean;
    actor?: "human" | "agent";
  }) =>
    post<SerialWidgetRunResult>("/api/serial/widget/run", {
      project: opts.project,
      id: opts.id,
      params: opts.params,
      dry_run: opts.dryRun === true,
      repeat: opts.repeat === true,
      confirm: opts.confirm === true,
      actor: opts.actor,
    }),

  /**
   * 任务快照（300–500ms 轮询；不新增 SSE topic）。
   * `id` 省略 = 当前未结束的任务（刷新页面后也能找回在跑的那一个）。
   */
  serialWidgetJob: (id = "") =>
    req<SerialWidgetJob>(
      `/api/serial/widget/job${id ? `?id=${encodeURIComponent(id)}` : ""}`,
    ),

  /** 取消任务（人的停止始终优先于 agent）。 */
  serialWidgetCancel: (id: string) =>
    post<{ ok: boolean; id?: string; state?: string; error?: string }>(
      "/api/serial/widget/cancel",
      { id },
    ),

  /** 暂停/恢复周期任务。暂停只挡发送，停掉的节拍照常计入 skipped。 */
  serialWidgetPause: (id: string, paused: boolean) =>
    post<{ ok: boolean; id?: string; state?: string; paused?: boolean; error?: string }>(
      "/api/serial/widget/pause",
      { id, paused },
    ),

  /** 无状态协议解码（P3）：输入一段原始字节，返回通道帧。 */
  serialDecode: (opts: {
    decoder: string;
    dataB64?: string;
    hex?: string;
    channels?: number;
    /** 帧协议解码（M5）：工程名 + profile 由服务端装载（前端不缓存配置） */
    project?: string;
    profile?: string;
  }) =>
    req<SerialDecodeResult>("/api/serial/decode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decoder: opts.decoder,
        data_b64: opts.dataB64,
        hex: opts.hex,
        channels: opts.channels,
        project: opts.project,
        profile: opts.profile,
      }),
    }),

  // ── 帧协议（M5）───────────────────────────────────────────────
  /** 工程帧协议只读投影（rev / profiles / warnings）；文件不存在 = rev 0。 */
  serialFrames: (project: string) =>
    req<SerialFramesResponse>(
      `/api/serial/frames?project=${encodeURIComponent(project)}`,
    ),

  /**
   * 保存/删除帧 profile。**必须带 rev**（乐观锁）；冲突返回 conflict=true + 最新内容。
   * 保存成功后建议重设一次 decoder —— 会话里缓存的是旧 profile 快照。
   */
  serialFramesSave: (opts: {
    project: string;
    action: "save" | "delete";
    rev: number;
    profile?: unknown;
    id?: string;
  }) =>
    post<SerialFramesResponse>("/api/serial/frames", {
      project: opts.project,
      action: opts.action,
      rev: opts.rev,
      profile: opts.profile,
      id: opts.id,
    }),

  /** 无硬件预览：把一段样本字节按指定 profile / 未保存草稿解码。 */
  serialFramesPreview: (opts: {
    project?: string;
    id?: string;
    profile?: unknown;
    hex?: string;
    dataB64?: string;
  }) =>
    req<SerialDecodeResult>("/api/serial/frames/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: opts.project,
        id: opts.id,
        profile: opts.profile,
        hex: opts.hex,
        data_b64: opts.dataB64,
      }),
    }),

  /** 反向组帧（P1）：字段值 → 字节；支持未保存草稿与 variant。 */
  serialFramesEncode: (opts: {
    project?: string;
    id?: string;
    profile?: unknown;
    values?: Record<string, unknown>;
    variant?: string | number;
    lengthValue?: number;
  }) =>
    post<SerialFrameEncodeResult>("/api/serial/frames/encode", {
      project: opts.project,
      id: opts.id,
      profile: opts.profile,
      values: opts.values,
      variant: opts.variant,
      length_value: opts.lengthValue,
    }),

  /** 只读模板库（P1）：`templates/frames/*.json`，坏模板在 errors 里回报。 */
  serialFrameTemplates: () =>
    req<SerialFrameTemplatesResponse>("/api/serial/frames/templates"),

  /**
   * 抓包学习（P4.1）：给一段样本字节，**产草稿不落盘**。
   * 返回 confidence / evidence / warnings，草稿放进 `draft`（可直接当 profile 用）。
   */
  serialFramesLearn: (opts: {
    hex?: string;
    dataB64?: string;
    capture?: string;
    name?: string;
    fieldCount?: number;
  }) =>
    req<{
      ok: boolean;
      draft?: unknown;
      confidence?: number;
      evidence?: string[];
      warnings?: string[];
      decode_rate?: number;
      error?: string;
      preview?: { total_frames?: number; channels?: number };
    }>("/api/serial/frames/learn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hex: opts.hex,
        b64: opts.dataB64,
        capture: opts.capture,
        name: opts.name,
        field_count: opts.fieldCount,
      }),
    }, TIMEOUT_LONG_MS),

  /** 帧级健康度（P3.1）：帧率 / 到达间隔 / 错误分类 / 每 variant 计数。 */
  serialFrameStats: (windowS = 10) =>
    req<{
      ok?: boolean;
      active?: boolean;
      frames: number;
      fps: number;
      decoder?: string;
      interval_ms?: { mean: number; p95: number; max: number; min: number };
      reasons?: Record<string, number>;
      variants?: Record<string, number>;
      error_rate?: number;
      pending_bytes?: number;
    }>(`/api/serial/monitor/stats?window_s=${windowS}`),

  /** 模板 → 工程 profile（走 rev 乐观锁，不覆盖冲突）。 */
  serialFrameTemplateImport: (opts: {
    project: string;
    rev: number;
    template: string;
    newId?: string;
  }) =>
    post<SerialFramesResponse>("/api/serial/frames/templates/import", {
      project: opts.project,
      rev: opts.rev,
      template: opts.template,
      new_id: opts.newId,
    }),

  /**
   * 显式录制（K5）：`start` 把字节写成有界 JSONL（`.work/.cockpit/`），
   * `stop` 收尾并返回文件路径与统计。**只存字节**，可回放。
   */
  serialCapture: (action: "start" | "stop" | "status", project = "") =>
    req<{
      ok: boolean;
      path?: string;
      bytes?: number;
      chunks?: number;
      truncated?: boolean;
      error?: string;
      note?: string;
      capture?: {
        active: boolean;
        path: string;
        bytes: number;
        chunks: number;
        truncated: boolean;
        error: string | null;
        max_bytes: number;
      } | null;
    }>("/api/serial/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, project }),
    }),

  /**
   * 一键适配（M5.6）。**两段式**：`action:"probe"`（只读）永远在前，
   * `action:"write"`（写 `projects/<name>.yaml`）是用户看得见的独立第二段 ——
   * 与 `plan`（GET，纯读）→ `startRun`（POST，真跑）的动词纪律同一条：
   * "落不落盘"不许藏在一个按钮里。
   *
   * 抛错 = 400（路径不合法 / 有未决项拒绝写入 / 人工接管保护命中）。
   * `tier:"T3"` **不是**错误 —— 它是探测数据（"需要真改造"），界面要能说清原因。
   */
  adapt: (opts: {
    action: "probe" | "write" | "check";
    path: string;
    name?: string;
    force?: boolean;
  }) =>
    req<AdaptResponse>("/api/adapt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),

  /**
   * POST /api/pick-folder：请**同机内核**代开系统原生「选择文件夹」对话框。
   *
   * 浏览器沙箱拿不到本地目录的绝对路径，而适配要求绝对路径 —— 内核与用户
   * 在同一台机器上，是唯一合适的中介。返回 `{ path }` 或 `{ cancelled: true }`。
   */
  pickFolder: (initial?: string) =>
    req<{ path?: string; cancelled?: boolean }>("/api/pick-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initial: initial ?? "" }),
    }),

  /**
   * POST /api/project：工程接入文件的重命名 / 移除 / 切换探针。
   *
   * 只动 `projects/<name>.yaml`（业务工程零改动）；成功后服务端已重载 Config，
   * 前端只需重新拉 `/api/projects`。移除会先留 `<name>.yaml.bak`。
   * `set_probe` 只改 `debug.probe`（保留注释）；调试会话打开时内核回 409。
   */
  projectAdmin: (
    opts:
      | { action: "rename"; name: string; new_name: string }
      | { action: "remove"; name: string }
      | { action: "set_probe"; name: string; probe: string },
  ) =>
    post<{ action: string; status: string; name: string; old?: string; probe?: string; path: string }>(
      "/api/project",
      opts,
    ),

  // ── 适配包 / 社区市场（与 DSH 面板同形；逻辑全在内核）──────────────
  /** GET /api/packs：已装包 + （可选）市场条目。market=false 跳过市场索引读取。 */
  packs: (opts?: { market?: boolean; q?: string }) => {
    const q = new URLSearchParams();
    if (opts?.market === false) q.set("market", "0");
    if (opts?.q !== undefined && opts.q !== "") q.set("q", opts.q);
    const qs = q.toString();
    return req<PacksStatus>(`/api/packs${qs === "" ? "" : `?${qs}`}`);
  },
  /** GET /api/pkg/job：包操作任务快照（202 后 500ms 轮询）。 */
  pkgJob: (jobId: string) =>
    req<PkgJob>(`/api/pkg/job?job=${encodeURIComponent(jobId)}`),
  /**
   * POST /api/pkg/install：**只收包名**（来源与 sha256 由内核从市场索引解析）。
   * official=true → 装本仓 `packs/official` 里的内置包（离线）。
   */
  pkgInstall: (opts: { name: string; official?: boolean; force?: boolean }) =>
    post<PkgJob>("/api/pkg/install", {
      name: opts.name,
      ...(opts.official === true ? { official: true } : {}),
      ...(opts.force === true ? { force: true } : {}),
    }),
  pkgRemove: (opts: { name: string }) => post<PkgJob>("/api/pkg/remove", { name: opts.name }),
  pkgUpdate: (opts: { name?: string; force?: boolean } = {}) =>
    post<PkgJob>("/api/pkg/update", {
      ...(opts.name !== undefined && opts.name !== "" ? { name: opts.name } : {}),
      ...(opts.force === true ? { force: true } : {}),
    }),
  /** verify 是同步 200（只读、快）。name 缺省 = 全部已装包。 */
  pkgVerify: (opts: { name?: string } = {}) =>
    post<{ ok: boolean; results: PkgVerifyResult[] }>("/api/pkg/verify", {
      ...(opts.name !== undefined && opts.name !== "" ? { name: opts.name } : {}),
    }),
  /** 首次进入市场：现场遍历 GitHub 上现有 elab-pack 仓库（202 + job）。 */
  marketRefresh: () => post<PkgJob>("/api/pkg/market", {}),
  /** activate 是同步 200：启用一套已装包 + 重生成平台 skill + 重载 Config。 */
  pkgActivate: (opts: { name: string }) =>
    post<Record<string, unknown>>("/api/pkg/activate", { name: opts.name }),

  // ── 调试会话（GET 只读 / POST 副作用 / DELETE 释放，ICD §6）──────────
  //   ★ `debugSession` = 调试会话 id（选择哪条 gdb 会话）；
  //     与 `sessionId`（聊天会话，路由工程目录）**不是**同一个东西。
  /** GET /api/debug/session —— 会话清单 + 默认会话快照（无会话为 null）。 */
  debugSession: (debugSession?: string) =>
    req<DebugSessionResponse>(
      `/api/debug/session${debugSession ? `?debug_session=${encodeURIComponent(debugSession)}` : ""}`),

  /**
   * POST /api/debug/session —— 建立会话。
   * 副作用明确：占用 SWD/串口、复位目标、下载 ELF 并断到 `stop_at`。
   */
  debugOpen: (opts: {
    project: string;
    options?: DebugOpenOptions;
    lease_s?: number;
    allow_write?: boolean;
    actor?: "human" | "agent";
  }) =>
    req<DebugSessionResponse>("/api/debug/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: opts.project,
        options: opts.options,
        lease_s: opts.lease_s,
        allow_write: opts.allow_write,
        actor: opts.actor ?? "human",
      }),
    }, TIMEOUT_LONG_MS),

  /**
   * DELETE /api/debug/session —— 关闭会话并（默认）恢复目标运行。
   * ★ 多会话下必须带 `debug_session`；缺省只在恰有一条会话时生效。
   */
  debugClose: (resume = true, debugSession?: string) =>
    req<{ closed: boolean; resumed?: boolean; session?: string }>(
      `/api/debug/session?resume=${resume ? 1 : 0}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume, reason: "user-closed", actor: "human",
                               debug_session: debugSession ?? "" }),
      },
    ),

  /** POST /api/debug/control —— 执行/暂停/单步/复位/运行到行；reset 必须带 confirm。 */
  debugControl: (opts: {
    action: string; addr?: string; file?: string; line?: number;
    confirm?: boolean; debugSession?: string;
  }) =>
    post<DebugControlResponse>("/api/debug/control", {
      action: opts.action,
      ...(opts.addr !== undefined ? { addr: opts.addr } : {}),
      ...(opts.file !== undefined ? { file: opts.file } : {}),
      ...(opts.line !== undefined ? { line: opts.line } : {}),
      ...(opts.confirm !== undefined ? { confirm: opts.confirm } : {}),
      debug_session: opts.debugSession ?? "",
    }),

  /** GET /api/debug/stack —— 调用栈（thread 缺省 = 当前线程）。 */
  debugStack: (opts: { thread?: number; debugSession?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.thread !== undefined) q.set("thread", String(opts.thread));
    if (opts.debugSession) q.set("debug_session", opts.debugSession);
    const qs = q.toString();
    return req<DebugStackResponse>(`/api/debug/stack${qs ? `?${qs}` : ""}`);
  },

  /** GET /api/debug/variables —— 局部/参数/子节点。 */
  debugVariables: (opts: {
    frame?: number;
    scope?: "locals" | "args" | "children";
    var?: string;
    debugSession?: string;
  } = {}) => {
    const q = new URLSearchParams({
      frame: String(opts.frame ?? 0),
      scope: opts.scope ?? "locals",
    });
    if (opts.var !== undefined) q.set("var", opts.var);
    if (opts.debugSession) q.set("debug_session", opts.debugSession);
    return req<DebugVariablesResponse>(`/api/debug/variables?${q.toString()}`);
  },

  /** GET /api/debug/registers —— 寄存器分组（core/fpu/all）。 */
  debugRegisters: (opts: {
    group?: string; format?: "natural" | "hex"; debugSession?: string;
  } = {}) => {
    const q = new URLSearchParams({
      group: opts.group ?? "core",
      format: opts.format ?? "natural",
    });
    if (opts.debugSession) q.set("debug_session", opts.debugSession);
    return req<DebugRegistersResponse>(`/api/debug/registers?${q.toString()}`);
  },

  /** POST /api/debug/registers —— 按组批量写（整批校验，applied/failed 如实返回）。 */
  debugRegistersWrite: (opts: {
    items: Array<{ name: string; value: string }>;
    confirm?: boolean;
    debugSession?: string;
  }) =>
    post<DebugRegistersWriteResponse>("/api/debug/registers", {
      items: opts.items,
      confirm: opts.confirm !== false,
      debug_session: opts.debugSession ?? "",
    }),

  /** GET /api/debug/source —— 源码页签（file 缺省 = 当前停止帧）。 */
  debugSource: (opts: {
    file?: string; start?: number; count?: number; debugSession?: string;
  } = {}) => {
    const q = new URLSearchParams();
    if (opts.file) q.set("file", opts.file);
    if (opts.start !== undefined) q.set("start", String(opts.start));
    if (opts.count !== undefined) q.set("count", String(opts.count));
    if (opts.debugSession) q.set("debug_session", opts.debugSession);
    const qs = q.toString();
    return req<DebugSourceResponse>(`/api/debug/source${qs ? `?${qs}` : ""}`);
  },

  /**
   * GET /api/debug/breakpoints 列断点；op != list 时走 POST（添加/切换/删除）。
   * ★ 读走 GET、写走 POST 的动词纪律与 `/api/plan` → `/api/run` 同源。
   */
  debugBreakpoints: (opts: {
    op?: "list" | "add" | "update" | "toggle" | "remove";
    id?: string;
    kind?: "func" | "addr" | "source";
    location?: string;
    condition?: string;
    enabled?: boolean;
    hardware?: boolean;
    temporary?: boolean;
    /** 工程配置 rev（乐观锁；GET 返回的值原样带回） */
    rev?: number;
    debugSession?: string;
  } = {}) => {
    const op = opts.op ?? "list";
    if (op === "list") {
      const ds = opts.debugSession ?? "";
      return req<DebugBreakpointsResponse>(
        `/api/debug/breakpoints${ds ? `?debug_session=${encodeURIComponent(ds)}` : ""}`);
    }
    return post<DebugBreakpointsResponse>("/api/debug/breakpoints",
      { ...opts, op, debug_session: opts.debugSession ?? "" });
  },

  /** GET /api/debug/memory —— 读目标内存（count 上限 4096）。 */
  debugMemory: (opts: { addr: string; count?: number; debugSession?: string }) => {
    const q = new URLSearchParams({ addr: opts.addr });
    if (opts.count !== undefined) q.set("count", String(opts.count));
    if (opts.debugSession) q.set("debug_session", opts.debugSession);
    return req<DebugMemoryResponse>(`/api/debug/memory?${q.toString()}`);
  },

  /** GET /api/debug/disasm —— 反汇编（addr 空 = 当前 PC，mode=2 为 Thumb）。 */
  debugDisasm: (opts: {
    addr?: string; count?: number; mode?: number; debugSession?: string;
  } = {}) => {
    const q = new URLSearchParams();
    if (opts.addr !== undefined && opts.addr !== "") q.set("addr", opts.addr);
    q.set("count", String(opts.count ?? 32));
    q.set("mode", String(opts.mode ?? 2));
    if (opts.debugSession) q.set("debug_session", opts.debugSession);
    return req<DebugDisasmResponse>(`/api/debug/disasm?${q.toString()}`);
  },

  /** POST /api/debug/evaluate —— 表达式求值（`&line`、`buf[16]`、`pxCurrentTCB`）。 */
  debugEvaluate: (opts: { expr: string; frame?: number; debugSession?: string }) =>
    post<DebugEvaluateResponse>("/api/debug/evaluate", {
      expr: opts.expr,
      ...(opts.frame !== undefined ? { frame: opts.frame } : {}),
      debug_session: opts.debugSession ?? "",
    }),

  /**
   * POST /api/debug/write —— 写目标内存/寄存器。
   * ★ 默认拒绝（`allow_write=false`）；每次写都进 `.work/debug-audit.jsonl`。
   */
  debugWrite: (opts: {
    target: "memory" | "register";
    addr?: string;
    name?: string;
    value: string;
    /** 内核要求写操作显式确认（require_write 的第二道闸门） */
    confirm?: boolean;
    debugSession?: string;
  }) => post<{ ok: boolean; written?: number; name?: string; addr?: string }>(
    "/api/debug/write", { ...opts, debug_session: opts.debugSession ?? "" }),

  /** GET/POST /api/debug/watch —— 监视列表（持久化，写操作带 rev 乐观锁）。 */
  debugWatch: (opts: {
    op?: "list" | "add" | "update" | "remove";
    id?: string;
    expr?: string;
    format?: string;
    rev?: number;
    debugSession?: string;
  } = {}) => {
    const op = opts.op ?? "list";
    if (op === "list") {
      const ds = opts.debugSession ?? "";
      return req<DebugWatchResponse>(
        `/api/debug/watch${ds ? `?debug_session=${encodeURIComponent(ds)}` : ""}`);
    }
    return post<DebugWatchResponse>("/api/debug/watch",
      { ...opts, op, debug_session: opts.debugSession ?? "" });
  },

  /** GET /api/debug/audit —— 最近写操作/断点审计。 */
  debugAudit: (limit = 100) =>
    req<DebugAuditResponse>(`/api/debug/audit?limit=${limit}`),

  /** GET /api/debug/peripherals —— SVD 三级懒加载（path 空 = 外设清单）。 */
  debugPeripherals: (opts: {
    path?: string; read?: boolean; debugSession?: string;
  } = {}) => {
    const q = new URLSearchParams();
    if (opts.path) q.set("path", opts.path);
    if (opts.read) q.set("read", "1");
    if (opts.debugSession) q.set("debug_session", opts.debugSession);
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return req<DebugPeripheralsResponse>(`/api/debug/peripherals${suffix}`);
  },

  /** GET /api/debug/rtos —— FreeRTOS 任务与栈水位。 */
  debugRtos: (opts: { debugSession?: string } = {}) =>
    req<DebugRtosResponse>(
      `/api/debug/rtos${opts.debugSession ? `?debug_session=${encodeURIComponent(opts.debugSession)}` : ""}`),

  /* ── Modbus RTU 主站（面板 300ms 只需轮询这一条 state）────────────── */

  /** GET /api/modbus/state —— 引擎快照 + 增量事务 + 点表（引擎没起来也回点表）。 */
  modbusState: (project: string, after = 0) =>
    req<ModbusStateResponse>(
      `/api/modbus/state?project=${encodeURIComponent(project)}&after=${after}`,
    ),

  /** POST /api/modbus/open —— 复用/代开串口会话后挂主站（probe 顺手读设备 ID）。 */
  modbusOpen: (body: {
    project: string;
    port?: string;
    baud?: number;
    unit_id?: number;
    timeout_ms?: number;
    retries?: number;
    probe?: boolean;
  }) => post<{ ok: boolean; engine: unknown; map: ModbusMap; probe?: unknown }>("/api/modbus/open", body),

  modbusClose: () => post<{ ok: boolean }>("/api/modbus/close", {}),

  /** POST /api/modbus/start —— 起轮询（groups 省略 = 用点表里的分组）。 */
  modbusStart: (groups?: unknown) =>
    post<{ ok: boolean; started?: number }>("/api/modbus/start", groups === undefined ? {} : { groups }),

  modbusStop: () => post<{ ok: boolean }>("/api/modbus/stop", {}),

  /** POST /api/modbus/read —— 单次读（FC01/02/03/04）。 */
  modbusRead: (body: { fc: number; address: number; count: number; unit_id?: number }) =>
    post<ModbusRunResult>("/api/modbus/read", body),

  /** POST /api/modbus/write —— 单次写；内核要求 confirm=true（面板先弹确认）。 */
  modbusWrite: (body: {
    fc: number;
    address: number;
    value?: number;
    values?: number[];
    unit_id?: number;
    broadcast?: boolean;
  }) => post<ModbusRunResult>("/api/modbus/write", { ...body, confirm: true }),

  /** GET /api/modbus/transactions —— 增量事务流水（?after= 游标）。 */
  modbusTransactions: (after = 0) =>
    req<{ transactions: ModbusTxn[]; seq: number; capacity: number; covered: number }>(
      `/api/modbus/transactions?after=${after}`,
    ),

  /** GET/POST /api/modbus/map —— 读点表（不带 map）/ 保存（带 map + rev）。 */
  modbusMap: (project: string) =>
    req<{ ok: boolean; map: ModbusMap; source: string }>(
      `/api/modbus/map?project=${encodeURIComponent(project)}`,
    ),
  modbusMapSave: (project: string, map: ModbusMap, rev: number) =>
    post<{ ok: boolean; map: ModbusMap }>("/api/modbus/map", { project, map, rev }),
};

/**
 * 启动时校验前后端契约版本一致。
 *
 * 不做这个校验的代价：ICD 改了字段名，后端已经新格式，前端还在按旧字段渲染，
 * 结果是**界面正常但数据错位**（例如内存表盘永远显示 0%）—— 这种 bug 最难查。
 */
export async function assertSchema(caps: Capabilities): Promise<void> {
  if (caps.schema_version !== EVENT_SCHEMA_VERSION) {
    throw new Error(
      `事件契约版本不一致：后端 ${caps.schema_version}，前端 ${EVENT_SCHEMA_VERSION}。` +
        `请同步 docs/ICD_cockpit_events.md、kernel/events.py 与 src/api/types.ts。`,
    );
  }
}

export { EVENT_SCHEMA_VERSION };
