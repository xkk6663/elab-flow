/**
 * Host 半主入口：lazy 启停 cockpit + 注册全部路由 + 定时清理。
 *
 * 与 DSH 的关系：`apply(ctx)` 里用 `ctx.effect()` 登记 disposer，
 * 插件卸载/DSH 退出时 → 关 Job Object → 全树终结（Q16）。
 *
 * ★ 定位（批 2）：本文件是 host 半的**组装单元**（等价第二个组装根，由 main.ts
 *   调用）——它 import 适配器并接线，正如 main.ts 一样；门禁测试对它的
 *   "app 只准 import domain/ports" 规则显式豁免。**编排语义**（发现→适配→发起
 *   →订阅）一律去 app/cockpit-service.ts，不要在这里长业务。
 */
import { dirname, normalize } from 'node:path';
import { CockpitHost, looksLikeElabRoot } from "../adapters/kernel-process/host-process.js";
import { probeEnv } from "../adapters/env/probe.js";
import { cloneKernel, validateBootstrapRequest } from "../adapters/env/bootstrap.js";
import { registerOnce } from "../adapters/kernel-http/route-guard.js";
import { DEFAULT_HOST_ROUTE_CONFIG, registerApiRoute, registerEventsRoute, } from "../adapters/kernel-http/routes.js";
import { runRetention } from "../adapters/fs-store/run-retention.js";
/** 从起点向上找 elab 仓库根（`cockpit/server.py` + `services/elab`）。 */
function findElabRootUpward(from, maxUp = 6) {
    let cur = normalize(from);
    for (let i = 0; i <= maxUp; i += 1) {
        if (looksLikeElabRoot(cur))
            return cur;
        const next = dirname(cur);
        if (next === cur)
            break;
        cur = next;
    }
    return undefined;
}
export function apply(ctx, options = {}) {
    const cfg = { ...DEFAULT_HOST_ROUTE_CONFIG, ...(options.config ?? {}) };
    let current = cfg;
    let host;
    let starting;
    let lastUsed = Date.now();
    /** 解析这次该用哪个 elab 仓库根。 */
    function resolveRoot(sessionId) {
        const explicit = current.elabRoot;
        if (explicit !== 'auto' && explicit.trim() !== '') {
            return looksLikeElabRoot(explicit.trim()) ? explicit.trim() : undefined;
        }
        const cwd = options.resolveCwd?.(sessionId);
        if (cwd !== undefined)
            return findElabRootUpward(cwd);
        return findElabRootUpward(process.cwd());
    }
    /** 根的来源（UI 如实说明"这是你指定的还是自动找到的"）。 */
    function rootSource(sessionId) {
        if (resolveRoot(sessionId) === undefined)
            return null;
        const explicit = current.elabRoot;
        return explicit !== 'auto' && explicit.trim() !== '' ? 'user' : 'auto';
    }
    async function ensureHost(sessionId) {
        lastUsed = Date.now();
        if (host !== undefined) {
            const info = host.info;
            if (info.alive())
                return { baseUrl: info.baseUrl, info: { port: info.port, job: info.job, bootMs: info.bootMs } };
            // 已死：清理后重启
            await host.dispose().catch(() => undefined);
            host = undefined;
        }
        if (starting !== undefined) {
            const h = await starting;
            return { baseUrl: h.info.baseUrl, info: { port: h.info.port, job: h.info.job, bootMs: h.info.bootMs } };
        }
        // ★ sessionId 必须参与解析：auto 模式下唯一可靠来源是会话 cwd
        //   （2026-10-26 实测：不带 sessionId 时 DSH 进程 cwd 向上扫不到仓库根）
        const root = resolveRoot(sessionId);
        if (root === undefined) {
            throw new Error('未找到 elab 仓库根（需要同时包含 cockpit/server.py 与 services/elab）。' +
                '请在设置页指定 elabRoot，或在 elab 仓库内的会话里打开面板。');
        }
        starting = CockpitHost.start({ elabRoot: root, pythonPath: current.pythonPath });
        try {
            const h = await starting;
            host = h;
            return { baseUrl: h.info.baseUrl, info: { port: h.info.port, job: h.info.job, bootMs: h.info.bootMs } };
        }
        finally {
            starting = undefined;
        }
    }
    const deps = {
        ensureHost,
        config: () => current,
        ...(options.arbiter !== undefined ? { arbiter: options.arbiter } : {}),
        ...(options.serialMutex !== undefined ? { serialMutex: options.serialMutex } : {}),
    };
    const disposers = [];
    disposers.push(registerApiRoute(ctx, deps));
    disposers.push(registerEventsRoute(ctx, deps));
    // 健康 / 清理 / 诊断（GET /elab/host）
    disposers.push(registerOnce(ctx, {
        kind: 'exact',
        path: '/elab/host',
        handler: async (req, res) => {
            if (ctx.connection?.requestRejection(req) !== undefined) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: false, error: { code: 'forbidden' } }));
                return;
            }
            // ★ 带上会话 cwd：客户端用 /elab/host?sessionId=… 触发首次仓库根解析
            const url = new URL(req.url ?? '/', 'http://dsh.internal');
            const root = resolveRoot(url.searchParams.get('sessionId') ?? undefined);
            const info = host?.info;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({
                ok: true,
                elabRoot: root ?? null,
                rootSource: rootSource(url.searchParams.get('sessionId') ?? undefined),
                running: info === undefined ? false : info.alive(),
                port: info?.port ?? null,
                pid: info?.pid ?? null,
                job: info?.job ?? null,
                bootMs: info?.bootMs ?? null,
                kernelVersion: info?.kernelVersion ?? null,
                idleKillSec: current.idleKillSec,
                retention: current.retention,
            }));
        },
    }));
    // ── 引导向导：只读环境探测（GET /elab/env）──────────────────────
    disposers.push(registerOnce(ctx, {
        kind: 'exact',
        path: '/elab/env',
        handler: async (req, res) => {
            if (ctx.connection?.requestRejection(req) !== undefined) {
                json(res, 403, { ok: false, error: { code: 'forbidden' } });
                return;
            }
            if (req.method !== 'GET') {
                res.setHeader('Allow', 'GET');
                json(res, 405, { ok: false, error: { code: 'method-not-allowed' } });
                return;
            }
            try {
                const url = new URL(req.url ?? '/', 'http://dsh.internal');
                const sessionId = url.searchParams.get('sessionId') ?? undefined;
                const env = await probeEnv({ pythonPath: current.pythonPath });
                json(res, 200, { ok: true, env, elabRoot: resolveRoot(sessionId) ?? null, rootSource: rootSource(sessionId) });
            }
            catch (error) {
                json(res, 500, { ok: false, error: { code: 'probe-failed', message: String(error) } });
            }
        },
    }));
    // ── 引导向导：写动作（POST /elab/bootstrap）────────────────────
    //   只允许 set-root（校验 + 写配置）与 clone（浅克隆到空目录 + 写配置）。
    disposers.push(registerOnce(ctx, {
        kind: 'exact',
        path: '/elab/bootstrap',
        handler: async (req, res) => {
            if (ctx.connection?.requestRejection(req) !== undefined) {
                json(res, 403, { ok: false, error: { code: 'forbidden' } });
                return;
            }
            if (req.method !== 'POST') {
                res.setHeader('Allow', 'POST');
                json(res, 405, { ok: false, error: { code: 'method-not-allowed' } });
                return;
            }
            let body;
            try {
                body = JSON.parse(await readBody(req));
            }
            catch {
                json(res, 400, { ok: false, error: { code: 'bad-json', message: '请求体不是合法 JSON' } });
                return;
            }
            const check = validateBootstrapRequest(body, looksLikeElabRoot);
            if (check.ok === false) {
                json(res, 400, { ok: false, error: { code: check.code, message: check.message } });
                return;
            }
            const request = check.request;
            if (request.action === 'clone') {
                const cloned = await cloneKernel(request.url, request.dir);
                if (cloned.ok === false) {
                    json(res, 502, { ok: false, error: { code: 'clone-failed', message: cloned.error ?? 'git clone 失败' } });
                    return;
                }
                if (!looksLikeElabRoot(request.dir)) {
                    json(res, 422, {
                        ok: false,
                        error: {
                            code: 'not-elab-root',
                            message: '克隆完成，但目录不是 elab 仓库根（需同时包含 cockpit/server.py 与 services/elab）',
                        },
                    });
                    return;
                }
            }
            // 根已变更 → 丢弃旧进程，下次 ensureHost 按新根起
            const old = host;
            host = undefined;
            void old?.dispose().catch(() => undefined);
            options.onRootPersisted?.(request.dir);
            json(res, 200, { ok: true, action: request.action, elabRoot: request.dir });
        },
    }));
    // 空闲回收：每分钟看一次，超时且没活动 run 就关掉（下次按需重启，实测 ~300ms）
    const idleTimer = setInterval(() => {
        if (host === undefined)
            return;
        if (Date.now() - lastUsed < current.idleKillSec * 1000)
            return;
        const h = host;
        host = undefined;
        void h.dispose().catch(() => undefined);
        ctx.logger?.info?.('dsh-elab-cockpit: idle-reaped cockpit host');
    }, 60_000);
    if (typeof idleTimer.unref === 'function')
        idleTimer.unref();
    // runs 清理：启动 10s 后跑一次，之后每 30 分钟一次
    const retentionOnce = async () => {
        const root = resolveRoot();
        if (root === undefined)
            return;
        try {
            const result = await runRetention(`${root}/.work/.cockpit/runs`, current.retention, [], []);
            if (result.deleted.length > 0) {
                ctx.logger?.info?.(`dsh-elab-cockpit: runs 清理 ${result.deleted.length} 个（保留 ${result.kept}），释放 ${Math.round(result.freedBytes / 1024)}KB`);
            }
        }
        catch (error) {
            ctx.logger?.warn?.(`dsh-elab-cockpit: runs 清理失败：${String(error)}`);
        }
    };
    const retentionBoot = setTimeout(() => void retentionOnce(), 10_000);
    if (typeof retentionBoot.unref === 'function')
        retentionBoot.unref();
    const retentionTimer = setInterval(() => void retentionOnce(), 30 * 60_000);
    if (typeof retentionTimer.unref === 'function')
        retentionTimer.unref();
    const dispose = () => {
        for (const d of disposers) {
            try {
                d();
            }
            catch { /* ignore */ }
        }
        clearInterval(idleTimer);
        clearInterval(retentionTimer);
        clearTimeout(retentionBoot);
        const h = host;
        host = undefined;
        void h?.dispose().catch(() => undefined);
    };
    ctx.effect(() => dispose, 'dsh-elab-cockpit: host routes + lifecycle');
    // 设置页热更新（P4）：保持“函数即 disposer”的旧返回形状（verify-routes.mjs
    // 与单测都这么用），控制器能力以属性挂载，不破坏既有调用方。
    const controller = dispose;
    controller.update = (next) => {
        current = { ...current, ...next };
    };
    controller.ensureHost = (sessionId) => ensureHost(sessionId);
    Object.defineProperty(controller, 'current', { get: () => current });
    return controller;
}
function json(res, code, body) {
    const text = JSON.stringify(body);
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(Buffer.byteLength(text)));
    res.end(text);
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
