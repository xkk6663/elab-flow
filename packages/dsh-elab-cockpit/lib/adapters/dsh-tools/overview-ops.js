/**
 * overview 组实现：elab_status（只读总览）。
 *
 * 为什么单独一个文件：状态是 agent 的**第一跳**（先看工程名/步骤可用性/串口现状，
 * 再决定调哪个门面），它的返回形状是其余工具的前置条件来源。
 */
import { cockpit } from "./runtime.js";
export async function statusSnapshot(deps) {
    const projects = await cockpit(deps, '/api/projects');
    const cards = projects.projects ?? projects.cards ?? [];
    const current = deps.arbiter.current();
    const caps = await cockpit(deps, '/api/capabilities');
    const serial = caps.serial;
    return {
        ok: true,
        projects: cards.map((c) => ({
            name: String(c.name ?? ''),
            ...(typeof c.root === 'string' ? { root: c.root } : {}),
            tools: Array.isArray(c.tools) ? c.tools : [],
            steps: c.steps ?? {},
        })),
        activeRun: current,
        // 串口现状：端口候选 + 当前会话（含 opened_by / lease_remaining_s）——
        // agent 换口前先看这里，不用猜 / 也不用先 open 一次试错。
        serial: serial === undefined ? null : {
            available: serial.available === true,
            layer: serial.layer ?? '',
            hint: serial.hint ?? null,
            backend: serial.backend ?? '',
            write_available: serial.write_available === true,
            host_default: serial.host_default ?? '',
            host_baud: serial.host_baud ?? 115200,
            ports: (serial.ports ?? []).map((p) => ({
                name: String(p.name ?? ''),
                kind: String(p.kind ?? ''),
                desc: String(p.desc ?? ''),
            })),
            monitor: serial.monitor ?? null,
        },
    };
}
