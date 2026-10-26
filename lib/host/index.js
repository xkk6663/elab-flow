/**
 * Host 半主入口：lazy 启停 cockpit + 注册全部路由 + 定时清理。
 *
 * 与 DSH 的关系：`apply(ctx)` 里用 `ctx.effect()` 登记 disposer，
 * 插件卸载/DSH 退出时 → 关 Job Object → 全树终结（Q16）。
 */
import { dirname, normalize } from 'node:path';
import { CockpitHost, looksLikeElabRoot } from "./host-process.js";
import { registerOnce } from "./route-guard.js";
import { DEFAULT_HOST_ROUTE_CONFIG, registerApiRoute, registerEventsRoute, } from "./routes.js";
import { runRetention } from "./run-retention.js";
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
    const deps = { ensureHost, config: () => current, ...(options.arbiter !== undefined ? { arbiter: options.arbiter } : {}) };
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
                running: info === undefined ? false : info.alive(),
                port: info?.port ?? null,
                pid: info?.pid ?? null,
                job: info?.job ?? null,
                bootMs: info?.bootMs ?? null,
                idleKillSec: current.idleKillSec,
                retention: current.retention,
            }));
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
