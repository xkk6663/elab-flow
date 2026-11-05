/**
 * P5 工具化 —— `elab_*` agent 工具（§6.1 工具表）。
 *
 * 红线：
 *  - **人机共用同一份 plans 解析**（domain/pipeline.ts 的 `resolveRunSteps`）：
 *    `elab_build`→plan 'basic'、`elab_triple`→'triple'、`elab_loop`→'loop'，
 *    写操作全部落到 `POST /api/run`，人按的按钮与 Agent 调的工具有完全相同语义。
 *  - 写操作 actor='agent'（面板会出现蓝色 agent 标，用户可见即可取消，Q11 不预审批）。
 *  - 一律回**结构化**结果（含 run id）；日志不塞工具输出，Agent 需要时用 `elab_log`。
 *  - 串口写 / 适配写盘受 `allowAgentWrite` 门控（默认关，§6.2 规则 6）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveRunSteps } from "../../domain/pipeline.js";
/** 拿到 cockpit baseUrl 后执行一次 JSON HTTP 调用。 */
async function cockpit(deps, path, init) {
    const { baseUrl } = await deps.ensureHost();
    const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let body = null;
    try {
        body = text === '' ? null : JSON.parse(text);
    }
    catch {
        throw new Error(`cockpit ${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!res.ok) {
        const err = body?.error;
        throw new Error(err?.message ?? `cockpit ${path} HTTP ${res.status}`);
    }
    return body;
}
const jsonOutput = {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};
/**
 * defineTool 的类型边界：宿主内核的 execute 契约返回 JsonValue，而我们的
 * 结构化结果是普通对象（字段含 unknown）——统一经 JSON 序列化收敛
 * （我们的返回本来就是纯 JSON 数据，语义无损）。presentCall 的 kind 用
 * ToolCallKind 的合法值（'execute'/'edit'/'read'）。
 */
function makeTool(def) {
    return defineTool({
        ...def,
        execute: async (args, exec) => JSON.parse(JSON.stringify(await def.execute(args))),
    });
}
/** §16：拉内核自描述的档位定义（meta.plans）；拿不到 = undefined，走内置 PLANS。 */
async function kernelPlanDefs(deps) {
    try {
        const { baseUrl } = await deps.ensureHost();
        const res = await fetch(`${baseUrl}/api/capabilities`, { headers: { Accept: 'application/json' } });
        if (!res.ok)
            return undefined;
        const cap = (await res.json());
        const plans = cap.meta?.plans;
        if (!Array.isArray(plans))
            return undefined;
        const out = [];
        for (const p of plans) {
            if (typeof p?.id !== 'string' || !Array.isArray(p.steps))
                continue;
            out.push({
                id: p.id,
                steps: p.steps.map(String),
                requiresHardware: p.requires_hardware === true,
            });
        }
        return out.length > 0 ? out : undefined;
    }
    catch {
        return undefined;
    }
}
/** 三档工具的公共实现：解析 plan → 仲裁 → POST /api/run（actor=agent）。 */
async function runPlanTool(deps, args, plan) {
    const { baseUrl } = await deps.ensureHost();
    const projects = await cockpit(deps, '/api/projects');
    const cards = projects.projects ?? projects.cards ?? [];
    const card = cards.find((c) => String(c.name ?? '') === args.project);
    if (card === undefined) {
        const names = cards.map((c) => String(c.name ?? '')).filter(Boolean);
        throw new Error(`未找到工程「${args.project}」（可用：${names.length > 0 ? names.join('、') : '（无）'}）；可先用 elab_status 查看`);
    }
    const availability = (card.steps ?? {});
    const resolved = resolveRunSteps({
        plan,
        availability,
        plans: await kernelPlanDefs(deps),
    });
    const acquire = await deps.arbiter.tryAcquire('tool', 'agent', resolved.steps);
    if (!acquire.ok) {
        return {
            ok: false,
            code: acquire.code,
            holder: acquire.holder,
            ...(acquire.nextAction !== undefined ? { nextAction: acquire.nextAction } : {}),
        };
    }
    try {
        const r = await cockpit(deps, '/api/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project: args.project,
                steps: resolved.steps,
                ...(args.clean === true ? { clean: true } : {}),
                ...(typeof args.jobs === 'number' && args.jobs > 0 ? { jobs: args.jobs } : {}),
                actor: 'agent',
            }),
        });
        deps.arbiter.attachRun('tool', r.run);
        return {
            ok: true,
            run: r.run,
            project: args.project,
            steps: resolved.steps,
            ...(resolved.skipped.length > 0 ? { skipped: resolved.skipped } : {}),
            note: '进度在面板实时可见；需要日志用 elab_log（含 run id）',
        };
    }
    catch (error) {
        deps.arbiter.releaseIfPending('tool');
        throw error;
    }
}
/** elab_log：run 事件流 → 纯文本尾部 N 行（不塞全量）。 */
async function logTail(deps, args) {
    const run = args.run ?? deps.arbiter.current()?.run;
    if (run === undefined || run === '') {
        throw new Error('没有进行中的 run（可用 elab_status 查看，或先发起一个）');
    }
    const tail = Math.min(2000, Math.max(1, Math.round(args.tail ?? 200)));
    const { baseUrl } = await deps.ensureHost();
    const data = await cockpit(deps, `/api/run-events?run=${encodeURIComponent(run)}&from=0`);
    const events = data.events ?? [];
    const lines = [];
    for (const e of events) {
        const topic = String(e.topic ?? '');
        if (args.step !== undefined && args.step !== '' && String(e.step ?? '') !== args.step)
            continue;
        if (topic === 'proc/stdout-batch') {
            for (const l of e.lines ?? [])
                lines.push(l);
        }
        else if (topic === 'proc/stdout' || topic === 'proc/stderr') {
            lines.push(String(e.line ?? ''));
        }
        else if (topic === 'run/step-enter') {
            lines.push(`▶ 进入 ${String(e.step ?? '')}`);
        }
        else if (topic === 'run/step-exit') {
            lines.push(`${e.ok ? '✓' : '✗'} ${String(e.step ?? '')} ${e.ok ? '完成' : `失败：${String(e.detail ?? '')}`}`);
        }
    }
    const total = lines.length;
    return {
        ok: true,
        run,
        total,
        lines: lines.slice(-tail),
        truncated: total > tail,
    };
}
/** 拉一段字节批次（P1）：agent 读串口的唯一数据面。 */
async function fetchBytes(deps, after, opts = {}) {
    const q = new URLSearchParams({ after: String(after) });
    if (opts.direction !== undefined && opts.direction !== 'all')
        q.set('dir', opts.direction);
    if (opts.limit !== undefined && opts.limit > 0)
        q.set('limit', String(opts.limit));
    return cockpit(deps, `/api/serial/monitor/bytes?${q.toString()}`);
}
/** 拉一段会话级共享解码帧（P3.5）：与面板波页同源。 */
async function fetchDecoded(deps, after) {
    return cockpit(deps, `/api/serial/monitor/decoded?after=${Math.max(0, Math.round(after))}`);
}
/** 批次 → agent 可读文本（UTF-8 投影 + 原始 hex 兜底）。 */
function chunkText(dataB64) {
    const bytes = Buffer.from(dataB64, 'base64');
    return {
        text: bytes.toString('utf8'),
        hex: bytes.toString('hex').replace(/([0-9a-f]{2})(?=[0-9a-f])/g, '$1 '),
    };
}
const AGENT_JSON = {
    'Content-Type': 'application/json',
    'x-elab-actor': 'agent',
};
/** 调试会话快照（agent 与面板同一份；不含 MI 原始噪声）。 */
async function debugSession(deps) {
    return cockpit(deps, '/api/debug/session');
}
/** 打开调试会话（actor=agent → 租约到点自动关闭并恢复运行）。 */
async function debugOpen(deps, args) {
    if (args.project === '')
        throw new Error('需要 project（用 elab_status 查看工程名）');
    const r = await cockpit(deps, '/api/debug/session', {
        method: 'POST',
        headers: AGENT_JSON,
        body: JSON.stringify({
            project: args.project,
            options: {
                ...(args.stop_at !== undefined ? { stop_at: args.stop_at } : {}),
                ...(args.load !== undefined ? { load: args.load } : {}),
            },
            ...(args.lease_s !== undefined ? { lease_s: args.lease_s } : {}),
        }),
    });
    return {
        ok: true,
        session: r.session ?? null,
        note: '面板会在新会话时自动切到调试视图；用户与你看到同一份调用栈/寄存器（人机同源）',
    };
}
/** 控制：continue/pause/step_over/step_in/step_out/stepi/reset/restart/run_to。 */
async function debugControl(deps, args) {
    const before = await debugSession(deps);
    const seq = Number(before.session?.stop?.seq ?? 0);
    const r = await cockpit(deps, '/api/debug/control', {
        method: 'POST',
        headers: AGENT_JSON,
        body: JSON.stringify({
            action: args.action,
            ...(args.addr !== undefined ? { addr: args.addr } : {}),
            ...(args.confirm === true ? { confirm: true } : {}),
        }),
    });
    // 单步/运行到地址是"命令返回后还要等 *stopped"：内核已等了 15s，这里再兜一层
    if (['step_over', 'step_in', 'step_out', 'stepi', 'run_to'].includes(args.action)) {
        const waited = await waitForStop(deps, seq, Math.min(20_000, Math.max(1_000, (args.wait_s ?? 8) * 1000)));
        return { ok: true, ...r, ...waited };
    }
    return { ok: true, ...r };
}
/** 等下一个 stop（stop_seq 严格递增；避免与旧事件混淆）。 */
async function waitForStop(deps, afterSeq, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const snap = await debugSession(deps);
        const s = snap.session;
        if (s === null)
            return { stop: null, note: '会话已关闭' };
        const state = String(s.state ?? '');
        const stop = s.stop;
        const stopSeq = Number(stop?.seq ?? 0);
        if (state === 'error')
            return { stop, stop_seq: stopSeq, note: '调试会话进入 error' };
        if (state === 'stopped' && stopSeq > afterSeq)
            return { stop, stop_seq: stopSeq };
        await sleep(400);
    }
    return { timedOut: true, note: `等待 stop 超时（${timeoutMs}ms）；用 elab_debug_inspect 看当前状态` };
}
/** 只读 inspect：session/stack/variables/registers/breakpoints/memory/disasm/evaluate。 */
async function debugInspect(deps, args) {
    const q = (kv) => {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(kv))
            if (v !== undefined)
                p.set(k, String(v));
        const s = p.toString();
        return s === '' ? '' : `?${s}`;
    };
    switch (args.what) {
        case 'session':
            return debugSession(deps);
        case 'stack':
            return cockpit(deps, `/api/debug/stack${q({ thread: args.thread })}`);
        case 'variables':
            return cockpit(deps, `/api/debug/variables${q({ frame: args.frame ?? 0, scope: args.scope ?? 'locals', var: args.var })}`);
        case 'registers':
            return cockpit(deps, `/api/debug/registers${q({ group: args.group ?? 'core', format: args.format ?? 'natural' })}`);
        case 'breakpoints':
            return cockpit(deps, '/api/debug/breakpoints');
        case 'memory': {
            if (args.addr === undefined || args.addr === '')
                throw new Error('memory 需要 addr');
            return cockpit(deps, `/api/debug/memory${q({ addr: args.addr, count: args.count ?? 64 })}`);
        }
        case 'disasm':
            return cockpit(deps, `/api/debug/disasm${q({ addr: args.addr, count: args.count ?? 16, mode: 2 })}`);
        case 'evaluate': {
            if (args.expr === undefined || args.expr === '')
                throw new Error('evaluate 需要 expr');
            return cockpit(deps, '/api/debug/evaluate', {
                method: 'POST',
                headers: AGENT_JSON,
                body: JSON.stringify({ expr: args.expr, ...(args.frame !== undefined ? { frame: args.frame } : {}) }),
            });
        }
        default:
            return {
                ok: false,
                code: 'bad-inspect',
                note: 'what 必须是 session/stack/variables/registers/breakpoints/memory/disasm/evaluate',
            };
    }
}
/** 断点：list/add/update/toggle/remove（函数/地址；条件断点走 update）。 */
async function debugBreakpoint(deps, args) {
    if (args.op === 'list' || args.op === '')
        return cockpit(deps, '/api/debug/breakpoints');
    if (!['add', 'update', 'toggle', 'remove'].includes(args.op)) {
        return { ok: false, code: 'bad-op', note: 'op 必须是 list/add/update/toggle/remove' };
    }
    return cockpit(deps, '/api/debug/breakpoints', {
        method: 'POST',
        headers: AGENT_JSON,
        body: JSON.stringify({
            op: args.op,
            ...(args.id !== undefined ? { id: args.id } : {}),
            ...(args.kind !== undefined ? { kind: args.kind } : {}),
            ...(args.location !== undefined ? { location: args.location } : {}),
            ...(args.condition !== undefined ? { condition: args.condition } : {}),
            ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
            ...(args.hardware === true ? { hardware: true } : {}),
        }),
    });
}
/** 关闭会话：默认 resume=true（monitor reset run），绝不把板子留在 halt。 */
async function debugClose(deps, args) {
    const r = await cockpit(deps, '/api/debug/session', {
        method: 'DELETE',
        headers: AGENT_JSON,
        body: JSON.stringify({ resume: args.resume !== false, reason: 'agent-closed' }),
    });
    return {
        ok: true,
        ...r,
        note: r.resumed === true
            ? '目标已恢复运行（心跳/串口闭环可以继续）'
            : '目标未恢复运行（resume=false 或恢复命令失败）；如需心跳请重新上电或再开一次会话后正常关闭',
    };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * 包写操作：`POST /api/pkg/<action>` → 202 + job → 轮询到终态。
 *
 * ★ install **不** gate `allowAgentWrite`（用户明确要求 agent 能自行安装芯片包）：
 *   安装只写 `packs/installed/`，是"装驱动"级别的操作，不碰硬件、不碰业务工程。
 * ★ 内核同一时刻只允许一个包操作（有闭环在跑会 409），失败原因原样带回。
 */
async function pkgAction(deps, action, body, waitS) {
    const first = await cockpit(deps, `/api/pkg/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let snap = first;
    const deadline = Date.now() + Math.max(5, waitS) * 1000;
    while ((snap.state === 'queued' || snap.state === 'running') && Date.now() < deadline) {
        await sleep(500);
        snap = await cockpit(deps, `/api/pkg/job?job=${encodeURIComponent(first.id)}`);
    }
    const stillRunning = snap.state === 'queued' || snap.state === 'running';
    return {
        ok: snap.state === 'ok',
        job: snap.id,
        action: snap.action,
        name: snap.name,
        state: snap.state,
        stage: snap.stage,
        ...(snap.error !== null && snap.error !== undefined && snap.error !== '' ? { error: snap.error } : {}),
        log: (snap.log ?? []).slice(-40),
        ...(snap.result !== null && snap.result !== undefined ? { result: snap.result } : {}),
        ...(stillRunning
            ? { waiting: true, note: '仍在后台进行（git clone / 哈希可能较久）；稍后用 action=status 查看结果' }
            : {}),
    };
}
/** 适配包投影 → agent 可读的紧凑摘要（不把整份 status JSON 塞进上下文）。 */
function packsSummary(data) {
    const installed = Array.isArray(data.installed)
        ? data.installed.filter((p) => p.installed === true)
        : [];
    return {
        active: String(data.active ?? ''),
        chips: data.chips ?? [],
        installed: installed.map((p) => ({
            name: String(p.name ?? ''),
            version: p.version ?? null,
            status: String(p.status ?? ''),
            active: p.active === true,
            compatible: p.compatible ?? null,
        })),
        official_source: Array.isArray(data.installed)
            ? data.installed
                .filter((p) => p.status === 'official' && p.installed !== true)
                .map((p) => String(p.name ?? ''))
            : [],
    };
}
/** 搜索结果 → agent 可读的紧凑卡片。 */
function marketSummary(data, q) {
    const market = (data.market ?? {});
    const packs = Array.isArray(market.packs)
        ? market.packs.map((p) => ({
            name: String(p.name ?? ''),
            version: p.version ?? null,
            vendor: p.vendor ?? null,
            platform: p.platform ?? null,
            status: p.status ?? null,
            chips: p.chips ?? [],
            installed: p.installed === true,
            compatible: p.compatible ?? null,
        }))
        : [];
    return {
        query: q,
        count: packs.length,
        packs,
        ...(market.error !== null && market.error !== undefined ? { market_error: market.error } : {}),
    };
}
/**
 * agent 侧使用契约（常驻系统提示段与 `elab_guide` 工具共用同一份文案）。
 * 只放编排话术与纪律；步骤标签 / 档位定义仍以内核 `STEP_META` / `KERNEL_PLANS` 为准。
 */
export const AGENT_USAGE = [
    'elab 驾驶舱插件已挂载（DSH 右栏 ELAB 面板）。',
    '- 嵌入式固件任务优先用 elab_* 工具，不要手写 cmake / openocd / pyocd 命令。',
    '- 先 elab_status 拿工程名与每步可用性；再 elab_triple（编译+烧录+调试校验）或 elab_loop（完整闭环）；日志用 elab_log。',
    '- 串口：elab_serial_monitor(open) → elab_serial_read / elab_serial_wait；调试：elab_debug_open → elab_debug_control → elab_debug_inspect → elab_debug_close（关闭会恢复运行）。',
    '- 单飞：同一会话同时只允许 1 个 run；串口监视会自动让位给烧录/调试（内核挂起并恢复），无需先关监视；串口写、适配写盘、录制受 allowAgentWrite 门控，被拒时告知用户开权限，不要绕路重试。',
    '- 你发起的 run 会实时出现在右栏面板，用户可见也可取消；「LED 均匀闪烁」只能由用户肉眼确认，你只凭串口 tick / toggles 判活。',
    '- 需要完整工具清单与排障时调 elab_guide。',
].join('\n');
/** `elab_guide` 的结构化正文（渐进披露：常驻提示只留 AGENT_USAGE）。 */
export function agentGuidePayload() {
    return {
        ok: true,
        usage: AGENT_USAGE,
        tools: [
            { name: 'elab_status', use: '工程列表 + 每步可用性 + 当前 run + 串口现状（只读，写操作前先调）' },
            { name: 'elab_build', use: '只编译' },
            { name: 'elab_triple', use: '编译 + 烧录 + 调试校验' },
            { name: 'elab_loop', use: '完整闭环（缺什么自动剔除并在返回里说明）' },
            { name: 'elab_step', use: '指定步骤组合，如 build / flash,debug_verify' },
            { name: 'elab_preview', use: '预览将执行的计划（命令 / 产物 / 超时），不落盘' },
            { name: 'elab_cancel', use: '取消当前 run（人和 agent 发起的都能取消）' },
            { name: 'elab_log', use: '读 run 日志尾部 N 行，可按步骤过滤' },
            { name: 'elab_serial_monitor', use: 'open / close / decoder / clear / pause / resume 串口监视' },
            { name: 'elab_serial_read', use: '按游标读串口批次（direction=rx/tx/all）' },
            { name: 'elab_serial_wait', use: '等匹配正则的串口行（判心跳 / 等日志）' },
            { name: 'elab_serial', use: '向串口写数据（需要 allowAgentWrite）' },
            { name: 'elab_serial_capture', use: '录制 start / stop / status（写盘需 allowAgentWrite）' },
            { name: 'elab_debug_open', use: '起 openocd + gdb，停在 main（需内核 meta.debug）' },
            { name: 'elab_debug_control', use: 'continue / pause / step / reset / run_to' },
            { name: 'elab_debug_inspect', use: '栈 / 变量 / 寄存器 / 断点 / 内存等只读视图' },
            { name: 'elab_debug_close', use: '关闭调试并恢复运行（resume=false 才留在 halt）' },
            { name: 'elab_adapt', use: '接入工程目录（write=false 只读探测）' },
            { name: 'elab_pkg', use: '芯片适配包 status / search / install / activate / remove' },
        ],
        rules: [
            '同一会话单飞：最多 1 个 run；human-busy 时等结束或请用户取消，不要重试刷屏。',
            '串口让位：监视开着也能直接发起含烧录/调试的 run —— 内核自动挂起监视、释放口，run 收尾按 serial.resume_after_run 恢复；不要先让用户关监视。',
            '写门控：串口写 / 适配写盘 / 录制默认被 allowAgentWrite 拒绝；如实转告用户怎么开。',
            '可视化：发起 run 后右栏面板自动点亮阶梯与通道日志；失败时把对应通道日志尾转述给人。',
            '判活纪律：agent 只读串口 tick / toggles；「LED 均匀闪烁」必须由用户肉眼确认。',
        ],
        panel: '右栏 ELAB：工程行 · 适配横幅 · 阶段梯 · 三连/闭环/取消/预览 · 构建/烧录/调试/串口通道日志 · 串口四视图。',
    };
}
/** 注册全部 elab_* 工具（autoExposeTools=true 时由入口调用）。 */
export function registerElabTools(register, deps) {
    const disposers = [];
    const add = (definition) => {
        try {
            disposers.push(register(definition));
        }
        catch (error) {
            deps.warn(`dsh-elab-cockpit: 工具注册失败 ${String(error)}`);
        }
    };
    add(makeTool({
        name: 'elab_status',
        description: '查看 elab 驾驶舱状态：工程列表（含各步骤可用性与原因）、当前 run 归属与步骤、cockpit 进程健康，' +
            '以及串口现状（端口候选 / 当前监视会话 / 租约剩余）。只读。写操作前先调它确认工程名与端口。',
        parameters: {},
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'read', title: '查看 elab 驾驶舱状态' }),
        async execute() {
            const { baseUrl } = await deps.ensureHost();
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
        },
    }));
    add(makeTool({
        name: 'elab_guide',
        description: '返回 elab 驾驶舱的 agent 使用契约：工具清单与用途、调用顺序、单飞/串口互斥、写门控、面板可视化与判活纪律。' +
            '只读、不启动内核；不确定该用哪个 elab_* 工具或第一次接手工程时先调它。',
        parameters: {},
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'read', title: '查看 elab 使用指南' }),
        async execute() {
            return agentGuidePayload();
        },
    }));
    add(makeTool({
        name: 'elab_build',
        description: '编译指定工程（plan=basic，只跑 build）。返回 run id；进度在 DSH 面板实时可见，需要日志用 elab_log。',
        parameters: {
            project: { type: 'string', required: true, description: '工程名（用 elab_status 查询）' },
            clean: { type: 'boolean', description: '先删除工作目录再编译（不可逆，谨慎）' },
            jobs: { type: 'number', description: '并行度 -j（默认由工程决定）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 编译' }),
        async execute(args) {
            return runPlanTool(deps, args, 'basic');
        },
    }));
    add(makeTool({
        name: 'elab_triple',
        description: '编译+烧录+调试校验（plan=triple，三连；需要硬件在位）。返回 run id；面板实时可见进度。',
        parameters: {
            project: { type: 'string', required: true, description: '工程名（用 elab_status 查询）' },
            clean: { type: 'boolean', description: '先删除工作目录（不可逆，谨慎）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 三连（编译+烧录+调试）' }),
        async execute(args) {
            return runPlanTool(deps, args, 'triple');
        },
    }));
    add(makeTool({
        name: 'elab_loop',
        description: '跑完整闭环（plan=loop：体检→编译→烧录→调试校验→串口闭环；缺什么自动剔除并在返回里说明）。返回 run id。',
        parameters: {
            project: { type: 'string', required: true, description: '工程名（用 elab_status 查询）' },
            clean: { type: 'boolean', description: '先删除工作目录（不可逆，谨慎）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 完整闭环' }),
        async execute(args) {
            return runPlanTool(deps, args, 'loop');
        },
    }));
    add(makeTool({
        name: 'elab_step',
        description: '按**显式步骤**执行（与面板里的单步按钮同源）：doctor / build / flash / debug_verify / monitor，' +
            '以及项目声明的 tool:<name>；steps 用逗号分隔。显式步骤不可用时**直接报错**（不静默剔除）。' +
            '返回 run id，进度在面板实时可见。',
        parameters: {
            project: { type: 'string', required: true, description: '工程名（用 elab_status 查询）' },
            steps: { type: 'string', required: true, description: '逗号分隔，如 build 或 flash,debug_verify 或 tool:ota' },
            clean: { type: 'boolean', description: '先删除工作目录（不可逆，谨慎）' },
            jobs: { type: 'number', description: '并行度 -j（默认由工程决定）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 单步执行' }),
        async execute(args) {
            const wanted = args.steps.split(',').map((s) => s.trim()).filter(Boolean);
            if (wanted.length === 0) {
                return { ok: false, code: 'bad-steps', note: 'steps 不能为空（逗号分隔，如 build 或 flash,debug_verify）' };
            }
            const projects = await cockpit(deps, '/api/projects');
            const cards = projects.projects ?? projects.cards ?? [];
            const card = cards.find((c) => String(c.name ?? '') === args.project);
            if (card === undefined) {
                const names = cards.map((c) => String(c.name ?? '')).filter(Boolean);
                throw new Error(`未找到工程「${args.project}」（可用：${names.length > 0 ? names.join('、') : '（无）'}）；可先用 elab_status 查看`);
            }
            const availability = (card.steps ?? {});
            const declaredTools = new Set((card.tools ?? []).map((t) => `tool:${String(t.name ?? '')}`));
            for (const s of wanted) {
                if (s.startsWith('tool:')) {
                    if (!declaredTools.has(s)) {
                        return {
                            ok: false,
                            code: 'unknown-step',
                            step: s,
                            note: `工程未声明工具「${s.slice(5)}」（项目 yaml 的 tools: 节里没有它）`,
                        };
                    }
                    continue;
                }
                const av = availability[s];
                if (av === undefined) {
                    return {
                        ok: false,
                        code: 'unknown-step',
                        step: s,
                        note: `未知步骤「${s}」；已知步骤：${Object.keys(availability).join('、')}`,
                    };
                }
                if (av.ok === false) {
                    return { ok: false, code: 'step-unavailable', step: s, note: av.reason ?? '该步骤当前不可用' };
                }
            }
            const acquire = await deps.arbiter.tryAcquire('tool', 'agent', wanted);
            if (!acquire.ok) {
                return {
                    ok: false,
                    code: acquire.code,
                    holder: acquire.holder,
                    ...(acquire.nextAction !== undefined ? { nextAction: acquire.nextAction } : {}),
                };
            }
            try {
                const r = await cockpit(deps, '/api/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        project: args.project,
                        steps: wanted,
                        ...(args.clean === true ? { clean: true } : {}),
                        ...(typeof args.jobs === 'number' && args.jobs > 0 ? { jobs: args.jobs } : {}),
                        actor: 'agent',
                    }),
                });
                deps.arbiter.attachRun('tool', r.run);
                return {
                    ok: true,
                    run: r.run,
                    project: args.project,
                    steps: wanted,
                    note: '进度在面板实时可见；需要日志用 elab_log（含 run id）',
                };
            }
            catch (error) {
                deps.arbiter.releaseIfPending('tool');
                throw error;
            }
        },
    }));
    add(makeTool({
        name: 'elab_preview',
        description: '只读预览将执行的命令（GET /api/plan：不 spawn、不写盘、不发事件）。' +
            'steps 缺省 = 工程默认步序；返回每步 argv 与 --clean 的删除目标。',
        parameters: {
            project: { type: 'string', required: true, description: '工程名' },
            steps: { type: 'string', description: '逗号分隔；缺省=默认闭环步序' },
            clean: { type: 'boolean', description: '按 --clean 预览（会显式列出删除目录）' },
            jobs: { type: 'number', description: '并行度 -j' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 命令预览' }),
        async execute(args) {
            const qs = new URLSearchParams({ project: args.project });
            if (args.steps !== undefined && args.steps.trim() !== '')
                qs.set('steps', args.steps.trim());
            if (args.clean === true)
                qs.set('clean', '1');
            if (typeof args.jobs === 'number' && args.jobs > 0)
                qs.set('jobs', String(args.jobs));
            return cockpit(deps, `/api/plan?${qs.toString()}`);
        },
    }));
    add(makeTool({
        name: 'elab_cancel',
        description: '取消当前 run（杀整棵进程树）。无论 run 由人还是 agent 发起都可取消（§6.2 规则 4）。',
        parameters: {
            run: { type: 'string', description: '要取消的 run id；缺省 = 当前活动 run' },
            reason: { type: 'string', description: '取消原因（记入日志）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 取消 run' }),
        async execute(args) {
            const run = args.run ?? deps.arbiter.current()?.run;
            if (run === undefined || run === '')
                return { ok: false, note: '当前没有活动 run' };
            const r = await cockpit(deps, '/api/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ run, ...(args.reason !== undefined ? { reason: args.reason } : {}) }),
            });
            return { ok: r.ok === true, run };
        },
    }));
    add(makeTool({
        name: 'elab_serial',
        description: '向指定工程的串口写数据（写硬件！需要 allowAgentWrite 开启）。默认 UTF-8 文本 + CRLF；' +
            'format=auto 由服务端自动判定 HEX/文本；format=hex 时 data 按十六进制字节发送。' +
            '给 interval_ms 即为定时发送（返回工作快照，state=running，用 job_id 轮询/停止）。',
        parameters: {
            project: { type: 'string', required: true, description: '工程名' },
            data: { type: 'string', required: true, description: '要写入的内容（不含换行符；hex 格式时为十六进制串）' },
            baud: { type: 'number', description: '波特率（默认 115200）' },
            format: { type: 'string', description: 'auto / utf8 / ascii / gbk / hex（默认 utf8）' },
            eol: { type: 'string', description: 'none / lf / crlf（默认 crlf；hex 自动 none）' },
            encoding: { type: 'string', description: '文本编码（默认 utf-8）' },
            interval_ms: {
                type: 'number',
                description: '定时发送间隔（毫秒，≥20）。给了就是周期任务，返回 job 快照',
            },
            count: { type: 'number', description: '定时发送轮次；0 = 直到手动停止（最长 600s）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'edit', title: 'elab 串口写' }),
        async execute(args) {
            if (!deps.allowAgentWrite()) {
                return {
                    ok: false,
                    code: 'agent-write-disabled',
                    nextAction: '串口写硬件需要用户在设置里开启 allowAgentWrite；或请用户在面板串口通道手动输入',
                };
            }
            const loop = args.interval_ms !== undefined;
            return cockpit(deps, loop ? '/api/serial/loop' : '/api/serial', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project: args.project,
                    data: args.data,
                    ...(args.baud !== undefined ? { baud: args.baud } : {}),
                    ...(args.format !== undefined ? { format: args.format } : {}),
                    ...(args.eol !== undefined ? { eol: args.eol } : {}),
                    ...(args.encoding !== undefined ? { encoding: args.encoding } : {}),
                    ...(args.interval_ms !== undefined ? { interval_ms: args.interval_ms } : {}),
                    ...(args.count !== undefined ? { count: args.count } : {}),
                }),
            });
        },
    }));
    add(makeTool({
        name: 'elab_serial_monitor',
        description: '常驻串口监视会话（open/close/decoder/clear/pause/resume）。agent 打开时默认带 lease_s 租约，' +
            '到期自动释放端口（避免把串口一直占死）。读数据用 elab_serial_read / elab_serial_wait；' +
            'action=decoder 会让**面板波形页与人看到的画面**同步切到同一解码器（同源帧）。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: 'open / close / decoder / clear / pause / resume',
            },
            project: { type: 'string', description: '工程名（open 时用于解析端口/波特率）' },
            port: { type: 'string', description: '显式端口（缺省取工程配置）' },
            baud: { type: 'number', description: '显式波特率（缺省取工程配置）' },
            lease_s: { type: 'number', description: '租约秒数（open 时默认 120；0 = 无租约）' },
            decoder: {
                type: 'string',
                description: 'decoder 动作时：justfloat / firewater；传空串 = 关闭共享解码',
            },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 串口监视' }),
        async execute(args) {
            const action = args.action;
            if (!['open', 'close', 'decoder', 'clear', 'pause', 'resume'].includes(action)) {
                return { ok: false, code: 'bad-action', note: `action 必须是 open/close/decoder/clear/pause/resume：${args.action}` };
            }
            const body = { action };
            if (action === 'open') {
                body.actor = 'agent';
                if (args.project !== undefined)
                    body.project = args.project;
                if (args.port !== undefined)
                    body.port = args.port;
                if (args.baud !== undefined)
                    body.baud = args.baud;
                body.lease_s = args.lease_s !== undefined ? args.lease_s : 120;
                // 写权限随用户设置（默认关）；读不受限。
                body.allow_agent_write = deps.allowAgentWrite();
            }
            if (action === 'decoder') {
                body.actor = 'agent';
                body.decoder = args.decoder ?? '';
            }
            return cockpit(deps, '/api/serial/monitor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        },
    }));
    add(makeTool({
        name: 'elab_serial_read',
        description: '增量读取串口监视会话的原始字节（带方向/时间/序号）。返回 next_after 游标与 text/hex 投影；' +
            '没有会话时先 elab_serial_monitor action=open。只读，不写硬件。',
        parameters: {
            after: { type: 'number', description: '上次返回的 next_after（缺省 0 = 从当前环起点）' },
            direction: { type: 'string', description: 'all / rx / tx（默认 all；rx=设备输出，tx=我们写出的）' },
            limit: { type: 'number', description: '最多返回多少批次（默认 500，上限 4096）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 读串口' }),
        async execute(args) {
            const after = Math.max(0, Math.round(args.after ?? 0));
            const direction = (args.direction ?? 'all');
            const limit = Math.min(4096, Math.max(1, Math.round(args.limit ?? 500)));
            const tail = await fetchBytes(deps, after, { direction, limit });
            if (tail.active !== true) {
                return {
                    ok: false,
                    active: false,
                    note: '没有进行中的串口监视；先用 elab_serial_monitor action=open（需要硬件在位）',
                };
            }
            const chunks = (tail.chunks ?? []).map((c) => {
                const { text, hex } = chunkText(c.data_b64);
                return { seq: c.seq, dir: c.dir, t: c.t, len: c.len, text, hex };
            });
            return {
                ok: true,
                active: true,
                epoch: tail.epoch,
                next_after: chunks.length > 0 ? chunks[chunks.length - 1].seq : after,
                gap: tail.gap ?? 0,
                paused: tail.paused === true,
                error: tail.error ?? null,
                chunks,
            };
        },
    }));
    add(makeTool({
        name: 'elab_serial_wait',
        description: '等待串口监视流里出现匹配文本（正则或子串），返回匹配时刻前后的批次。超时返回 ok=false。' +
            '用于“发命令后等设备回 OK/数据”这类时序断言。只读。',
        parameters: {
            pattern: { type: 'string', required: true, description: '要等待的正则表达式（大小写敏感）' },
            after: { type: 'number', description: '起始游标（缺省 = 当前环末尾之后的新数据）' },
            direction: { type: 'string', description: 'all / rx / tx（默认 rx）' },
            timeout_ms: { type: 'number', description: '超时毫秒（默认 5000，上限 60000）' },
            poll_ms: { type: 'number', description: '轮询间隔毫秒（默认 150）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 等待串口输出' }),
        async execute(args) {
            let re;
            try {
                re = new RegExp(args.pattern);
            }
            catch (error) {
                return { ok: false, code: 'bad-pattern', note: error instanceof Error ? error.message : String(error) };
            }
            const direction = (args.direction ?? 'rx');
            const timeout = Math.min(60000, Math.max(100, Math.round(args.timeout_ms ?? 5000)));
            const poll = Math.min(2000, Math.max(50, Math.round(args.poll_ms ?? 150)));
            const start = Math.max(0, Math.round(args.after ?? 0));
            const deadline = Date.now() + timeout;
            let cursor = start;
            const collected = [];
            let carried = '';
            while (Date.now() < deadline) {
                const tail = await fetchBytes(deps, cursor, { direction, limit: 500 });
                if (tail.active !== true) {
                    return {
                        ok: false,
                        active: false,
                        note: '串口监视会话不存在或已结束；先用 elab_serial_monitor action=open（需要硬件在位）',
                    };
                }
                for (const c of tail.chunks ?? []) {
                    const { text } = chunkText(c.data_b64);
                    collected.push({ seq: c.seq, dir: c.dir, t: c.t, text });
                    cursor = c.seq;
                    if (re.test(text) || re.test(carried + text)) {
                        return {
                            ok: true,
                            matched: true,
                            pattern: args.pattern,
                            after: start,
                            next_after: cursor,
                            chunks: collected.slice(-32),
                        };
                    }
                    carried = (carried + text).slice(-512);
                }
                await sleep(poll);
            }
            return {
                ok: false,
                matched: false,
                timeout: true,
                pattern: args.pattern,
                next_after: cursor,
                chunks: collected.slice(-32),
            };
        },
    }));
    add(makeTool({
        name: 'elab_serial_decode',
        description: '无状态协议解码（justfloat / firewater）。justfloat = N×4 小端 float + 尾 00 00 80 7F；' +
            'firewater = ASCII 逗号分隔 float + 换行。半帧以 pending_b64 原样带回，拼下一批再解。' +
            'apply=true 时同一 decoder 会写入会话——面板波形页随之人机同图（人看到的就是这份帧）。',
        parameters: {
            decoder: { type: 'string', required: true, description: 'justfloat / firewater' },
            hex: { type: 'string', description: '十六进制字节串（与 data_b64 二选一）' },
            data_b64: { type: 'string', description: 'base64 字节串（与 hex 二选一）' },
            channels: { type: 'number', description: '显式通道数（缺省自动推断）' },
            apply: {
                type: 'boolean',
                description: '是否把该 decoder 落到会话（面板波形页同步展示；默认 false 仅本次解码）',
            },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 串口解码' }),
        async execute(args) {
            const payload = {
                decoder: args.decoder,
                ...(args.hex !== undefined ? { hex: args.hex } : {}),
                ...(args.data_b64 !== undefined ? { data_b64: args.data_b64 } : {}),
                ...(args.channels !== undefined ? { channels: args.channels } : {}),
            };
            const result = await cockpit(deps, '/api/serial/decode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (args.apply !== true)
                return result;
            // 落会话：人看到的波形页与本次解码同源（同一 decoder + 同一帧环）
            try {
                const applied = await cockpit(deps, '/api/serial/monitor', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'decoder', actor: 'agent', decoder: args.decoder }),
                });
                return { ...result, applied: true, session: applied };
            }
            catch (error) {
                return {
                    ...result,
                    applied: false,
                    note: `解码成功但未能落到会话（没有进行中的监视？）：${error instanceof Error ? error.message : String(error)}`,
                };
            }
        },
    }));
    add(makeTool({
        name: 'elab_serial_decoded',
        description: '增量读取**会话级共享解码帧**（与面板波形页同一份数据）：agent 先把 decoder 落到会话' +
            '（elab_serial_monitor action=decoder 或 elab_serial_decode apply=true），再用本工具拿结构化 ' +
            'values 数组下结论——人看到的波形就是这些帧。返回 next_after 游标与 gap（环挤掉的帧数）。',
        parameters: {
            after: { type: 'number', description: '上次返回的 next_after（缺省 0 = 从帧环起点）' },
            limit: { type: 'number', description: '最多返回多少帧（默认 200，上限 1024）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 读解码帧' }),
        async execute(args) {
            const after = Math.max(0, Math.round(args.after ?? 0));
            const limit = Math.min(1024, Math.max(1, Math.round(args.limit ?? 200)));
            const tail = await fetchDecoded(deps, after);
            if (tail.active !== true) {
                return {
                    ok: false,
                    active: false,
                    note: '没有进行中的串口监视；先用 elab_serial_monitor action=open（需要硬件在位）',
                };
            }
            const all = tail.frames ?? [];
            const frames = all.slice(-limit);
            return {
                ok: true,
                active: true,
                epoch: tail.epoch,
                decoder: tail.decoder,
                decoder_by: tail.decoder_by,
                channels: tail.channels,
                total_frames: tail.total_frames,
                skipped: tail.skipped,
                pending_bytes: tail.pending_bytes,
                covered: tail.covered,
                error: tail.error ?? null,
                next_after: all.length > 0 ? all[all.length - 1].seq : after,
                gap: tail.gap ?? 0,
                frames,
            };
        },
    }));
    add(makeTool({
        name: 'elab_serial_capture',
        description: '显式录制串口字节（证据，可回放）：start 开始录、stop 收尾返回文件路径与统计、' +
            'status 查当前录制。文件是有界 JSONL（默认上限 5 MiB），到顶自动停录并标 truncated。' +
            '只存原始字节（bytes_b64），不存文本投影。',
        parameters: {
            action: { type: 'string', required: true, description: 'start / stop / status' },
            project: { type: 'string', description: '工程名（可省略；用于文件命名与留档关联）' },
            max_bytes: { type: 'number', description: '录制文件上限（字节；缺省 5 MiB）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'edit', title: 'elab 串口录制' }),
        async execute(args) {
            if (args.action !== 'status' && !deps.allowAgentWrite()) {
                return {
                    ok: false,
                    code: 'agent-write-disabled',
                    nextAction: '录制会写盘，需要用户在设置里开启 allowAgentWrite；只用 status 可查看当前是否在录',
                };
            }
            return cockpit(deps, '/api/serial/capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: args.action,
                    ...(args.project !== undefined ? { project: args.project } : {}),
                    ...(args.max_bytes !== undefined ? { max_bytes: args.max_bytes } : {}),
                }),
            });
        },
    }));
    add(makeTool({
        name: 'elab_serial_widget',
        description: '工程级「串口发送组件」（参数 + send/delay/wait 序列 + 周期发送）。' +
            'action=list 列组件；preview 只渲染字节；run 执行（写硬件！需要 allowAgentWrite；' +
            '返回 running 时用 status 轮询到终态）；status 查任务（job_id 缺省 = 当前任务）；' +
            'cancel/pause 停止/暂停（人的停止永远优先，agent 也可主动让路）；save/delete 改配置（需要 allowAgentWrite）。' +
            '组件配置在 projects/<name>.widgets.json，写操作带 rev 乐观锁（冲突时重读再存）。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: 'list / preview / run / status / cancel / pause / resume / save / delete',
            },
            project: { type: 'string', description: '工程名（list/preview/run/save/delete 必填）' },
            id: { type: 'string', description: '组件 id（preview/run/save/delete 必填）' },
            params: { type: 'string', description: '参数 JSON，如 {"n":3}（缺省 = 组件默认值）' },
            repeat: { type: 'boolean', description: 'run 时 true = 按组件 repeat 配置周期跑' },
            confirm: { type: 'boolean', description: 'run 时 true = 已确认（组件 confirm=true 必须）' },
            job_id: { type: 'string', description: 'status/cancel/pause 的任务 id；缺省 = 当前任务' },
            widget: { type: 'string', description: 'save 时组件定义 JSON（字符串）' },
            rev: { type: 'number', description: 'save/delete 时的乐观锁版本（来自 list 的 rev）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'edit', title: 'elab 串口发送组件' }),
        async execute(args) {
            const action = args.action;
            const project = args.project ?? '';
            const needProject = ['list', 'preview', 'run', 'save', 'delete'].includes(action);
            if (needProject && project === '') {
                return { ok: false, code: 'missing-project', note: '该 action 需要 project（工程名）' };
            }
            if (['run', 'save', 'delete'].includes(action) && !deps.allowAgentWrite()) {
                return {
                    ok: false,
                    code: 'agent-write-disabled',
                    nextAction: '组件发送/改配置会写硬件或工程文件，需要用户在设置里开启 allowAgentWrite；'
                        + '只读请用 action=list / preview / status',
                };
            }
            let params;
            if (args.params !== undefined && args.params.trim() !== '') {
                try {
                    const parsed = JSON.parse(args.params);
                    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        params = parsed;
                    }
                    else {
                        return { ok: false, code: 'bad-params', note: 'params 必须是 JSON 对象（如 {"n":3}）' };
                    }
                }
                catch {
                    return { ok: false, code: 'bad-params', note: 'params 不是合法 JSON' };
                }
            }
            try {
                if (action === 'list') {
                    return await cockpit(deps, `/api/serial/widgets?project=${encodeURIComponent(project)}`);
                }
                if (action === 'status') {
                    const q = args.job_id !== undefined && args.job_id !== '' ? `?id=${encodeURIComponent(args.job_id)}` : '';
                    return await cockpit(deps, `/api/serial/widget/job${q}`);
                }
                if (action === 'preview') {
                    return await cockpit(deps, '/api/serial/widget/run', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            project, id: args.id ?? '',
                            ...(params !== undefined ? { params } : {}),
                            dry_run: true,
                        }),
                    });
                }
                if (action === 'run') {
                    return await cockpit(deps, '/api/serial/widget/run', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-elab-actor': 'agent' },
                        body: JSON.stringify({
                            project, id: args.id ?? '',
                            ...(params !== undefined ? { params } : {}),
                            ...(args.repeat === true ? { repeat: true } : {}),
                            ...(args.confirm === true ? { confirm: true } : {}),
                            actor: 'agent',
                        }),
                    });
                }
                if (action === 'cancel' || action === 'pause' || action === 'resume') {
                    let jobId = args.job_id ?? '';
                    if (jobId === '') {
                        const cur = await cockpit(deps, '/api/serial/widget/job');
                        jobId = cur.job_id ?? '';
                        if (jobId === '')
                            return { ok: false, note: '当前没有组件任务' };
                    }
                    const path = action === 'cancel' ? '/api/serial/widget/cancel' : '/api/serial/widget/pause';
                    const body = action === 'cancel' ? { id: jobId } : { id: jobId, paused: action === 'pause' };
                    return await cockpit(deps, path, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                }
                if (action === 'save') {
                    if (args.widget === undefined || args.widget === '') {
                        return { ok: false, code: 'missing-widget', note: 'save 需要 widget（组件定义 JSON）' };
                    }
                    return await cockpit(deps, '/api/serial/widgets', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            action: 'save', project, rev: args.rev ?? 0,
                            widget: JSON.parse(args.widget),
                        }),
                    });
                }
                if (action === 'delete') {
                    return await cockpit(deps, '/api/serial/widgets', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'delete', project, rev: args.rev ?? 0, id: args.id ?? '' }),
                    });
                }
                return { ok: false, code: 'unknown-action', note: `未知 action：${action}` };
            }
            catch (error) {
                return {
                    ok: false,
                    code: 'widget-request-failed',
                    note: error instanceof Error ? error.message : String(error),
                    nextAction: action === 'save' || action === 'delete'
                        ? 'rev 冲突或组件不合法：先 action=list 重读，再按最新 rev 重试'
                        : undefined,
                };
            }
        },
    }));
    add(makeTool({
        name: 'elab_adapt',
        description: '把一个工程目录接入 elab（生成 projects/<name>.yaml）。write=false 只读探测并给出报告；write=true 落盘（需要 allowAgentWrite）。',
        parameters: {
            path: { type: 'string', required: true, description: '工程目录绝对路径' },
            write: { type: 'boolean', description: 'true = 写入适配文件；缺省 false = 只读探测' },
            name: { type: 'string', description: '适配名（write 时用；缺省取目录名）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'edit', title: 'elab 工程适配' }),
        async execute(args) {
            const write = args.write === true;
            if (write && !deps.allowAgentWrite()) {
                return {
                    ok: false,
                    code: 'agent-write-disabled',
                    nextAction: '适配写盘需要用户在设置里开启 allowAgentWrite；或用 write=false 先看探测报告',
                };
            }
            return cockpit(deps, '/api/adapt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: write ? 'write' : 'probe', path: args.path, ...(args.name !== undefined ? { name: args.name } : {}) }),
            });
        },
    }));
    add(makeTool({
        name: 'elab_pkg',
        description: '芯片适配包（一切芯片差异皆包）：status 查看已装/启用、search 搜索社区市场、' +
            'install 安装（按包名，source/sha256 由内核解析；official=true 装本机官方源内置包）、' +
            'activate 启用（一次只启用一套，其余保留在本地）、remove/update/verify 卸载/更新/校验。' +
            '安装期间内核会冻结闭环（有 run 在跑时包操作返回 409）。agent 可自行安装。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: 'status / search / install / activate / remove / update / verify',
            },
            name: { type: 'string', description: '包名（如 st/stm32、artery/at32；install/activate/remove 必填）' },
            query: { type: 'string', description: 'search 关键词（名称 / 厂商 / 平台，如 stm32、at32）' },
            official: { type: 'boolean', description: 'install 时 true = 装本机官方源（离线，如 st/stm32）' },
            force: { type: 'boolean', description: 'install/update 时强制重装同版本' },
            wait_s: { type: 'number', description: 'install/remove/update 等待秒数（默认 180；超时则返回后台 job 状态）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'edit', title: 'elab 芯片包管理' }),
        async execute(args) {
            const action = args.action;
            const waitS = Math.min(900, Math.max(5, Math.round(args.wait_s ?? 180)));
            const needName = ['install', 'activate', 'remove'].includes(action);
            if (needName && (args.name === undefined || args.name === '')) {
                return { ok: false, code: 'missing-name', note: '该 action 需要 name（如 st/stm32）' };
            }
            try {
                if (action === 'status') {
                    const data = await cockpit(deps, '/api/packs?market=0');
                    return { ok: true, ...packsSummary(data), roots: data.roots ?? [], install_root: data.install_root ?? '' };
                }
                if (action === 'search') {
                    const q = args.query ?? '';
                    const qs = new URLSearchParams({ market: '1' });
                    if (q !== '')
                        qs.set('q', q);
                    const data = await cockpit(deps, `/api/packs?${qs.toString()}`);
                    return { ok: true, ...marketSummary(data, q) };
                }
                if (action === 'install') {
                    return await pkgAction(deps, 'install', {
                        name: args.name,
                        ...(args.official === true ? { official: true } : {}),
                        ...(args.force === true ? { force: true } : {}),
                    }, waitS);
                }
                if (action === 'remove') {
                    return await pkgAction(deps, 'remove', { name: args.name }, waitS);
                }
                if (action === 'update') {
                    return await pkgAction(deps, 'update', {
                        ...(args.name !== undefined && args.name !== '' ? { name: args.name } : {}),
                        ...(args.force === true ? { force: true } : {}),
                    }, waitS);
                }
                if (action === 'verify') {
                    return await cockpit(deps, '/api/pkg/verify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...(args.name !== undefined && args.name !== '' ? { name: args.name } : {}) }),
                    });
                }
                if (action === 'activate') {
                    const r = await cockpit(deps, '/api/pkg/activate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: args.name }),
                    });
                    const packs = (r.packs ?? {});
                    return {
                        ok: true,
                        active: r.active ?? args.name,
                        skills: r.skills ?? [],
                        ...(Object.keys(packs).length > 0 ? { packs: packsSummary(packs) } : {}),
                    };
                }
                return {
                    ok: false,
                    code: 'bad-action',
                    note: `action 必须是 status/search/install/activate/remove/update/verify：${action}`,
                };
            }
            catch (error) {
                return {
                    ok: false,
                    code: 'pkg-error',
                    error: error instanceof Error ? error.message : String(error),
                    note: '有闭环在跑时包操作会被 409 拦住；等 run 结束后重试',
                };
            }
        },
    }));
    add(makeTool({
        name: 'elab_log',
        description: '读取某个 run 的日志尾部 N 行纯文本（默认 200，可按步骤过滤）。run 缺省 = 当前活动 run。',
        parameters: {
            run: { type: 'string', description: 'run id；缺省 = 当前活动 run' },
            step: { type: 'string', description: '只看某一步（doctor/build/flash/debug_verify/monitor）' },
            tail: { type: 'number', description: '尾部行数（默认 200，上限 2000）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 读日志' }),
        async execute(args) {
            return logTail(deps, args);
        },
    }));
    // ── 调试会话（P0/P1）：Agent 可开、可单步、可读栈/寄存器 ──
    add(makeTool({
        name: 'elab_debug_open',
        description: '打开调试会话（openocd + gdb MI）：复位 → 下载 ELF（可按 load=false 跳过）→ 停在 main。' +
            '面板会在新会话时自动切到调试视图；你与用户看到同一份调用栈/寄存器（人机同源）。' +
            '同一时刻只允许一个会话；闭环/串口监视在跑会被 409 拦住。',
        parameters: {
            project: { type: 'string', required: true, description: '工程名（elab_status 可查）' },
            stop_at: { type: 'string', description: 'main（默认）/ reset / none' },
            load: { type: 'boolean', description: '是否下载 ELF；默认按工程声明（无 flash.images 时下载）' },
            lease_s: { type: 'number', description: 'agent 租约秒数（默认 600，60–1800；到期自动关闭并恢复运行）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 打开调试会话' }),
        async execute(args) {
            const stopAt = ['main', 'reset', 'none'].includes(String(args.stop_at ?? ''))
                ? args.stop_at
                : undefined;
            return debugOpen(deps, {
                project: args.project,
                ...(stopAt !== undefined ? { stop_at: stopAt } : {}),
                ...(args.load !== undefined ? { load: args.load } : {}),
                ...(typeof args.lease_s === 'number' ? { lease_s: args.lease_s } : {}),
            });
        },
    }));
    add(makeTool({
        name: 'elab_debug_control',
        description: '驱动调试会话：continue / pause / step_over / step_in / step_out / stepi / reset / restart / run_to。' +
            '单步类动作会等 stop 后返回新位置（stop_seq 严格递增，避免拿到旧事件）。',
        parameters: {
            action: { type: 'string', required: true, description: 'continue/pause/step_over/step_in/step_out/stepi/reset/restart/run_to' },
            addr: { type: 'string', description: 'run_to 的目标地址（如 0x080001a4）' },
            confirm: { type: 'boolean', description: 'reset 需要 true（会复位目标）' },
            wait_s: { type: 'number', description: '单步等待秒数（默认 8，上限 20）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 调试控制' }),
        async execute(args) {
            return debugControl(deps, args);
        },
    }));
    add(makeTool({
        name: 'elab_debug_inspect',
        description: '读取调试数据（只读）：session / stack / variables / registers / breakpoints / memory / disasm / evaluate。' +
            '目标运行时返回 debug-target-running；先 pause。',
        parameters: {
            what: { type: 'string', required: true, description: 'session/stack/variables/registers/breakpoints/memory/disasm/evaluate' },
            frame: { type: 'number', description: '栈帧号（variables/evaluate 用）' },
            scope: { type: 'string', description: 'locals/args/children（variables）' },
            var: { type: 'string', description: '要展开的变量名（scope=children）' },
            thread: { type: 'number', description: '线程 id（stack）' },
            group: { type: 'string', description: 'core/fpu/all（registers）' },
            format: { type: 'string', description: 'natural/hex（registers）' },
            addr: { type: 'string', description: 'memory/disasm 起始地址' },
            count: { type: 'number', description: 'memory 字节数（≤4096）/ disasm 指令数（≤128）' },
            expr: { type: 'string', description: 'evaluate 表达式（如 dwTickCount）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 读调试数据' }),
        async execute(args) {
            return debugInspect(deps, args);
        },
    }));
    add(makeTool({
        name: 'elab_debug_breakpoint',
        description: '断点管理：list / add / update / toggle / remove。窄栏没有源码 gutter —— 用函数名或地址断点，条件断点走 update。',
        parameters: {
            op: { type: 'string', required: true, description: 'list/add/update/toggle/remove' },
            id: { type: 'string', description: '断点 id（update/toggle/remove）' },
            kind: { type: 'string', description: 'func（默认）/ addr' },
            location: { type: 'string', description: '函数名或地址' },
            condition: { type: 'string', description: '条件表达式（可选）' },
            enabled: { type: 'boolean', description: 'update 时启用/禁用' },
            hardware: { type: 'boolean', description: '硬件断点（-h）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 断点' }),
        async execute(args) {
            return debugBreakpoint(deps, args);
        },
    }));
    add(makeTool({
        name: 'elab_debug_wait',
        description: '等待下一个 stop（默认从现在起 10s）。命中断点/单步结束后返回位置与 stop_seq。',
        parameters: {
            after_seq: { type: 'number', description: '只认比它大的 stop_seq；缺省 = 当前会话的 stop.seq' },
            timeout_s: { type: 'number', description: '等待秒数（默认 10，上限 60）' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'elab 等调试停止' }),
        async execute(args) {
            let after = args.after_seq;
            if (after === undefined) {
                const snap = await debugSession(deps);
                const s = snap.session;
                after = Number((s?.stop?.seq) ?? 0);
            }
            const timeout = Math.min(60, Math.max(1, Math.round(args.timeout_s ?? 10))) * 1000;
            return waitForStop(deps, Number(after), timeout);
        },
    }));
    add(makeTool({
        name: 'elab_debug_close',
        description: '关闭调试会话并**恢复目标运行**（monitor reset run，C36）。resume=false 才会让板子留在 halt（仅排障用）。',
        parameters: {
            resume: { type: 'boolean', description: '默认 true：复位并运行；false = 保持 halt' },
        },
        output: jsonOutput,
        presentCall: () => ({ card: 'generic', kind: 'execute', title: 'elab 关闭调试会话' }),
        async execute(args) {
            return debugClose(deps, args);
        },
    }));
    return () => {
        for (const d of disposers) {
            try {
                d();
            }
            catch {
                /* ignore */
            }
        }
    };
}
