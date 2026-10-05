import type {
  AdaptResponse,
  Capabilities,
  ElabEvent,
  PlanPreview,
  ProjectsResponse,
  RunsResponse,
  SerialConsoleResponse,
  SerialWriteResult,
  StepId,
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
