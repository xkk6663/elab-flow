import type {
  AdaptResponse,
  Capabilities,
  ElabEvent,
  PlanPreview,
  ProjectsResponse,
  RunsResponse,
  SerialBytesTail,
  SerialConsoleResponse,
  SerialDecodeResult,
  SerialFormat,
  SerialMonitorSnapshot,
  SerialMonitorTail,
  SerialWriteResult,
  StepId,
  PacksStatus,
  PkgJob,
  PkgVerifyResult,
} from "./types";

/** 后端契约版本；与 ICD 的 EVENT_SCHEMA_VERSION 比对，不一致就显式报错而不是渲染错位界面 */
import { EVENT_SCHEMA_VERSION } from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return req<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const api = {
  capabilities: () => req<Capabilities>("/api/capabilities"),
  projects: () => req<ProjectsResponse>("/api/projects"),
  runs: () => req<RunsResponse>("/api/runs"),
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
        read_ms: opts.readMs,
        newline: opts.newline,
        hex: opts.hex,
        format: opts.format,
        eol: opts.eol,
        encoding: opts.encoding,
      }),
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

  /** 打开/关闭/清空/暂停/继续监视会话。POST = 明确的副作用（占住/释放独占资源）。 */
  serialMonitorToggle: (
    action: "open" | "close" | "clear" | "pause" | "resume",
    opts?: {
      project?: string;
      baud?: number;
      port?: string;
      actor?: "human" | "agent";
      lease_s?: number;
      allow_agent_write?: boolean;
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
        actor: opts?.actor,
        lease_s: opts?.lease_s,
        allow_agent_write: opts?.allow_agent_write,
      }),
    }),

  /** 无状态协议解码（P3）：输入一段原始字节，返回通道帧。 */
  serialDecode: (opts: {
    decoder: string;
    dataB64?: string;
    hex?: string;
    channels?: number;
  }) =>
    req<SerialDecodeResult>("/api/serial/decode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decoder: opts.decoder,
        data_b64: opts.dataB64,
        hex: opts.hex,
        channels: opts.channels,
      }),
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
    action: "probe" | "write";
    path: string;
    name?: string;
    force?: boolean;
  }) =>
    req<AdaptResponse>("/api/adapt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),

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
