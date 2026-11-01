/**
 * dsh-elab-cockpit —— Host 半入口（cordis 插件契约）。
 *
 * 暴露的 HTTP 面（全部先过 `ctx.connection.requestRejection`）：
 *   GET  /elab/host                    健康、端口、Job 状态、留存配置
 *   GET  /elab/api/discover            工程发现（会话 cwd 扫描，纯文件系统）
 *   *    /elab/api/{白名单}             转发到 cockpit 的 /api/*
 *   GET  /elab/events?run=&from=       SSE 字节级透传（保留 id 帧以支持续传）
 *   GET/POST /elab/config              设置页：读/热更新 + 持久化（P4）
 *
 * 设计红线（文档 §4.2 / §14）：
 *   - **方法白名单**，不做通配反代；
 *   - **SSE 不改写帧**（`id:` 是断线续传的唯一游标）；
 *   - 进程托管必须 `-u` + UTF-8（见 host-process.ts）；
 *   - 进程树用 Windows Job Object 终结（见 job-object.ts）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apply as applyHost } from "./app/host-app.js";
import { applyDiscover } from "./adapters/kernel-http/discover-route.js";
import { looksLikeElabRoot } from "./adapters/kernel-process/host-process.js";
import { createSerialMutexTracker } from "./adapters/kernel-http/routes.js";
import { RunArbiter } from "./domain/arbiter.js";
import { registerElabTools } from "./adapters/dsh-tools/tools.js";
import { registerOnce } from "./adapters/kernel-http/route-guard.js";
/** cordis 行 id（与 cordis.patch.yml 一致）。 */
export const name = 'dsh-elab-cockpit';
/** 挂载前必须就绪的服务：路由、连接准入、会话（用于解析 cwd）、工具注册面。 */
export const inject = ['webServer', 'connection', 'sessions', 'tools'];
export function resolveConfig(config) {
    const retention = {
        keepCount: config?.runsKeepCount ?? 200,
        keepDays: config?.runsKeepDays ?? 14,
        maxTotalBytes: (config?.runsMaxTotalMB ?? 50) * 1024 * 1024,
        dryRun: config?.runsCleanupDryRun ?? false,
    };
    const autoProvision = config?.autoProvision ?? true;
    return {
        autoProvision,
        host: {
            elabRoot: config?.elabRoot ?? 'auto',
            pythonPath: config?.pythonPath ?? 'auto',
            idleKillSec: config?.idleKillSec ?? 1800,
            retention,
            autoProvision,
        },
        discover: {
            elabRoot: config?.elabRoot ?? 'auto',
            maxDepth: config?.discoverMaxDepth ?? 3,
            limit: config?.discoverLimit ?? 50,
        },
        tools: {
            autoExposeTools: config?.autoExposeTools ?? true,
            allowAgentWrite: config?.allowAgentWrite ?? false,
        },
    };
}
/** 会话 cwd 解析（与 better-sidebar 同源的降级链，但不做异步查询）。 */
function cwdResolver(ctx) {
    return (sessionId) => {
        if (sessionId === undefined || sessionId === '')
            return undefined;
        // ★ 走 ctx.get()：未 inject 的服务属性在 cordis 里是抛错访问（§15.5c）。
        const sessions = ctx.get('sessions');
        const workingDirectory = ctx.get('workingDirectory');
        const session = sessions?.get(sessionId);
        const wd = session !== undefined ? workingDirectory?.get(session) : undefined;
        if (typeof wd === 'string' && wd !== '')
            return wd;
        const hdr = session?.header?.cwd;
        if (typeof hdr === 'string' && hdr !== '')
            return hdr;
        const def = workingDirectory?.defaultDirectory;
        return typeof def === 'string' && def !== '' ? def : undefined;
    };
}
export function apply(ctx, config, env) {
    const resolved = resolveConfig(config);
    const disposers = [];
    // ① 工程发现（纯文件系统，不依赖 Python）
    const discoverCurrent = { ...resolved.discover };
    disposers.push(applyDiscover(ctx, {
        ...resolved.discover,
        cacheTtlMs: 30_000,
        // ★ 判据唯一真源：与宿主半 /elab/host 完全同一函数（方案 B1）
        isElabRoot: looksLikeElabRoot,
    }));
    // applyDiscover 把热更新入口挂在自己的函数属性上（见 discover-route.ts）
    const discoverUpdate = applyDiscover.update ??
        (() => { });
    // ②' RunArbiter（§6.2）：同一 rootKey 同时最多 1 个 run；
    //    活性用惰性检查（/api/runs 的活动列表），不解析 SSE。
    const arbiter = new RunArbiter(async (run) => {
        try {
            const { baseUrl } = await hostController.ensureHost();
            const res = await fetch(`${baseUrl}/api/runs`, { headers: { Accept: 'application/json' } });
            if (!res.ok)
                return true;
            const data = (await res.json());
            return Array.isArray(data.active) && data.active.some((r) => r !== null && typeof r === 'object' && r.id === run);
        }
        catch {
            return true;
        }
    });
    // 串口监视互斥记账（§6.2 规则 2）
    const serialMutex = createSerialMutexTracker();
    // ② API 代理 + SSE + 进程托管 + runs 清理
    //    onRootPersisted：向导写根后热更新 + 持久化（由下方 config 控制器提供）
    let persistRoot = () => { };
    const hostController = applyHost(ctx, {
        config: resolved.host,
        resolveCwd: cwdResolver(ctx),
        arbiter,
        serialMutex,
        onRootPersisted: (dir) => persistRoot(dir),
    });
    // ③ 设置页配置（P4）：启动时先叠加持久化覆盖，再挂 GET/POST /elab/config
    const persistPath = env?.persistPath ?? join(homedir(), '.dsh', 'dsh-elab-cockpit.config.json');
    const configController = registerConfigRoute(ctx, {
        persistPath,
        initialPatch: resolvePersisted(persistPath),
        get() {
            return {
                elabRoot: hostController.current.elabRoot,
                pythonPath: hostController.current.pythonPath,
                idleKillSec: hostController.current.idleKillSec,
                discoverMaxDepth: discoverCurrent.maxDepth,
                discoverLimit: discoverCurrent.limit,
                autoProvision: hostController.current.autoProvision,
            };
        },
        apply(patch) {
            const hostNext = {};
            if (patch.elabRoot !== undefined)
                hostNext.elabRoot = patch.elabRoot;
            if (patch.pythonPath !== undefined)
                hostNext.pythonPath = patch.pythonPath;
            if (patch.idleKillSec !== undefined)
                hostNext.idleKillSec = patch.idleKillSec;
            if (patch.autoProvision !== undefined)
                hostNext.autoProvision = patch.autoProvision;
            if (Object.keys(hostNext).length > 0)
                hostController.update(hostNext);
            const discoverNext = {};
            if (patch.elabRoot !== undefined) {
                discoverNext.elabRoot = patch.elabRoot;
                discoverCurrent.elabRoot = patch.elabRoot;
            }
            if (patch.discoverMaxDepth !== undefined) {
                discoverNext.maxDepth = patch.discoverMaxDepth;
                discoverCurrent.maxDepth = patch.discoverMaxDepth;
            }
            if (patch.discoverLimit !== undefined) {
                discoverNext.limit = patch.discoverLimit;
                discoverCurrent.limit = patch.discoverLimit;
            }
            if (Object.keys(discoverNext).length > 0)
                discoverUpdate(discoverNext);
        },
        warn: (msg) => ctx.logger?.warn?.(msg),
    });
    // 向导写根 → 与设置页保存同一路径（热更新 + 持久化）
    persistRoot = (dir) => configController.update({ elabRoot: dir });
    // ④ P5 工具化：elab_* agent 工具（§6.1，autoExposeTools=true 时注册）
    if (resolved.tools.autoExposeTools && ctx.tools !== undefined) {
        const toolRegister = ctx.tools.register.bind(ctx.tools);
        registerElabTools((definition) => toolRegister(definition), {
            ensureHost: (sessionId) => hostController.ensureHost(sessionId),
            arbiter,
            allowAgentWrite: () => resolved.tools.allowAgentWrite,
            warn: (msg) => ctx.logger?.warn?.(msg),
        });
    }
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
/** 白名单 + 范围校验；返回 undefined 表示 body 里没有任何合法字段。 */
export function sanitizeConfigPatch(body) {
    if (body === null || typeof body !== 'object')
        return undefined;
    const b = body;
    const out = {};
    if (typeof b.elabRoot === 'string' && (b.elabRoot === 'auto' || isAbsoluteLike(b.elabRoot)))
        out.elabRoot = b.elabRoot;
    if (typeof b.pythonPath === 'string' && (b.pythonPath === 'auto' || isAbsoluteLike(b.pythonPath)))
        out.pythonPath = b.pythonPath;
    if (typeof b.idleKillSec === 'number' && Number.isFinite(b.idleKillSec)) {
        out.idleKillSec = Math.min(86_400, Math.max(60, Math.round(b.idleKillSec)));
    }
    if (typeof b.discoverMaxDepth === 'number' && Number.isFinite(b.discoverMaxDepth)) {
        out.discoverMaxDepth = Math.min(6, Math.max(1, Math.round(b.discoverMaxDepth)));
    }
    if (typeof b.discoverLimit === 'number' && Number.isFinite(b.discoverLimit)) {
        out.discoverLimit = Math.min(500, Math.max(1, Math.round(b.discoverLimit)));
    }
    if (typeof b.autoProvision === 'boolean')
        out.autoProvision = b.autoProvision;
    return Object.keys(out).length > 0 ? out : undefined;
}
function isAbsoluteLike(p) {
    return p.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(p);
}
function resolvePersisted(persistPath) {
    try {
        return sanitizeConfigPatch(JSON.parse(readFileSync(persistPath, 'utf8'))) ?? {};
    }
    catch {
        return {};
    }
}
/**
 * GET/POST /elab/config。POST 合法字段热更新（宿主 + 发现），并合并写入
 * 持久化文件；GET 返回当前生效值。持久化文件在启动时叠加在行配置之上。
 *
 * 返回控制器：`update(patch)` 与 POST 走同一路径（供引导向导写根复用）。
 */
function registerConfigRoute(ctx, opts) {
    // 启动：叠加持久化覆盖（文件不存在/损坏 = 首次运行，用行配置）
    if (Object.keys(opts.initialPatch).length > 0)
        opts.apply(opts.initialPatch);
    const respond = (res, code, body) => {
        const text = JSON.stringify(body);
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(text);
    };
    /** 热更新 + 合并持久化（POST 与向导写根共用）。 */
    const applyAndPersist = (patch) => {
        opts.apply(patch);
        try {
            const merged = { ...resolvePersisted(opts.persistPath), ...patch };
            mkdirSync(join(opts.persistPath, '..'), { recursive: true });
            writeFileSync(opts.persistPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
        }
        catch (error) {
            opts.warn(`dsh-elab-cockpit: 配置持久化失败：${String(error)}`);
        }
    };
    const dispose = registerOnce(ctx, {
        kind: 'exact',
        path: '/elab/config',
        handler: async (req, res) => {
            if (ctx.connection?.requestRejection(req) !== undefined) {
                return respond(res, 403, { ok: false, error: { code: 'forbidden' } });
            }
            if (req.method === 'GET') {
                return respond(res, 200, { ok: true, config: opts.get() });
            }
            if (req.method !== 'POST') {
                res.setHeader('Allow', 'GET, POST');
                return respond(res, 405, { ok: false, error: { code: 'method-not-allowed' } });
            }
            let body;
            try {
                body = JSON.parse(await readBody(req));
            }
            catch {
                return respond(res, 400, { ok: false, error: { code: 'bad-json' } });
            }
            const patch = sanitizeConfigPatch(body);
            if (patch === undefined) {
                return respond(res, 400, { ok: false, error: { code: 'no-valid-fields', message: '没有可识别的配置字段' } });
            }
            applyAndPersist(patch);
            return respond(res, 200, { ok: true, config: opts.get() });
        },
    });
    ctx.effect(() => dispose, 'dsh-elab-cockpit: config route');
    return { dispose, update: applyAndPersist };
}
function readBody(req, limit = 1 << 20) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error(`请求体超过 ${limit} 字节`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
