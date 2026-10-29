/**
 * 事件与 API 的类型契约。
 *
 * ★ 本文件是 `docs/ICD_cockpit_events.md` 的**前端侧镜像**。
 *   改字段名/语义必须三处同步：ICD、`services/elab/kernel/events.py`、本文件。
 *   （ICD §7「兼容性承诺汇总」）
 */
export const EVENT_SCHEMA_VERSION = 1;
/**
 * 已知 topic 全集（ICD §3）。
 *
 * ★ 为什么必须**显式枚举**：服务端把 topic 放在 SSE 的 `event:` 字段里
 *   （`event: run/step-exit`），而 `EventSource` **只按名订阅**，`onmessage`
 *   仅接收无 `event:` 的帧。因此"新 topic 自动可见"在 SSE 协议层面做不到。
 *
 *   这条限制的后果必须说清楚（ICD §7 已同步记录）：
 *     - 新增 topic 属于**跨端协同变更**，不是单端兼容变更；
 *     - 漏掉一个 topic 的症状是"界面某块静默不更新"，而非报错 —— 很难查；
 *     - 防御手段就是本文件与 ICD §3 的 topic 表逐条对齐（`npm run build` 前 review）。
 *
 *   `reduce()` 的 default 分支仍保留"未知 topic 原样返回"，用于兜住
 *   `run-events` 回放（走 JSON，不经 SSE）时可能出现的更新协议。
 */
/**
 * SSE **命名事件**白名单 —— 必须覆盖服务端会发出的**每一个** topic。
 *
 * ★ 为什么这张表是"活命的"（ICD §6.1 的硬约束，实测踩过 P0）：
 *   `EventSource.onmessage` **只接收没有 `event:` 字段的帧**；带 `event: <topic>`
 *   的帧只有 `addEventListener(<topic>, …)` 才收得到。而服务端**每帧都写
 *   `event: <topic>`**。所以：漏一个 topic = 该 topic 的事件在浏览器里
 *   **静默消失**——不报错、不抛异常、`onerror` 也不触发，只是那块 UI 永远不更新。
 *
 *   实测事故：本表原缺 `proc/stdout-batch`。而 run **跑起来之后**所有编译日志
 *   都以合并帧 `proc/stdout-batch` 下发 → **实时编译日志 100% 不可见**；
 *   而 `GET /api/events` 对**已结束**的 run 走"按 seq 重放"分支，重放的是
 *   `.proc.jsonl` 里的**逐条** `proc/stdout`（能收到）→ 于是"刷新页面/看历史
 *   run 有日志、真跑起来没日志"。这个不对称是它最迷惑人的地方。
 *
 *   守卫：`tests/it_cockpit_server.py::test_known_topics_covers_server_emitted`
 *   会把这张表与服务端 `SSE_TOPICS` 做集合比对 —— 新增 topic 时必须两端一起改。
 */
export const KNOWN_TOPICS = [
    // run/* —— 状态通道（.jsonl）
    "run/start",
    "run/step-enter",
    "run/step-exit",
    "run/end",
    "run/cancel",
    // proc/* —— 进程输出通道（.proc.jsonl）；batch 是服务端 100ms 合并帧
    "proc/stdout",
    "proc/stderr",
    "proc/stdout-batch",
    "proc/exit",
    // serial/* —— 串口闭环（M3）
    "serial/open",
    "serial/line",
    "serial/close",
    "serial/error",
    "serial/closed-loop",
    // 流控制
    "stream/overrun",
    "stream/closed",
];
