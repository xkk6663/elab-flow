import type {
  Capabilities,
  ElabEvent,
  PlanPreview,
  ProjectsResponse,
  RunsResponse,
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
