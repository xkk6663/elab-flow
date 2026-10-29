/**
 * 路由注册的幂等守卫 —— 让 plugin 在「装新 fiber 时旧 fiber 未销毁」时不撞
 * `webserver: duplicate exact route`。
 *
 * 为什么需要（实测 2026-10-26）：
 *   `install_bundle` 的 enable 阶段会先 apply 新 fiber，再销毁旧 fiber；
 *   两者短暂并存时，第二次 `webServer.register({path:'/elab/api/discover'})`
 *   直接抛 `duplicate exact route`，于是整行 activate 失败，
 *   插件从未真正生效（连带 Client 半也不加载）。
 *
 * ★ 状态挂在 ctx 上（WeakMap），不是模块级 Set。
 *   教训：先写成模块级 Set 时，同进程内第二个 ctx（或单测里的第二个假 ctx）
 *   会被误判为"已注册"而整个跳过，导致 routes 数组为空、10 个用例齐刷失败。
 *   隔离粒度必须是"每个 ctx 一份"，因为路由本就挂在那个 ctx 的 webServer 上。
 */
const perContext = new WeakMap();
function keyOf(kind, path) {
    return `${kind}:${path}`;
}
function tableOf(ctx) {
    let t = perContext.get(ctx);
    if (t === undefined) {
        t = new Map();
        perContext.set(ctx, t);
    }
    return t;
}
/**
 * 幂等注册：同一 ctx 上同一 (kind, path) 只真正注册一次。
 *
 * 引用计数：多个持有者（新旧 fiber）都调用时，只有最后一个释放才真正移除路由。
 */
export function registerOnce(ctx, route) {
    const key = keyOf(route.kind, route.path);
    const table = tableOf(ctx);
    const existing = table.get(key);
    if (existing !== undefined) {
        existing.refs += 1;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            existing.refs -= 1;
            if (existing.refs <= 0) {
                table.delete(key);
                try {
                    existing.dispose();
                }
                catch {
                    /* ignore */
                }
            }
        };
    }
    let dispose;
    try {
        dispose = ctx.webServer.register(route);
    }
    catch (error) {
        const msg = String(error);
        if (msg.includes('duplicate')) {
            // 宿主里已有同名路由（别的插件或更早的实例占着）：让出，不阻断其余部分。
            ctx.logger?.warn?.(`dsh-elab-cockpit: route ${key} 已被占用，跳过`);
            return () => undefined;
        }
        throw error;
    }
    const entry = { dispose, refs: 1 };
    table.set(key, entry);
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        entry.refs -= 1;
        if (entry.refs <= 0) {
            table.delete(key);
            try {
                dispose();
            }
            catch {
                /* ignore */
            }
        }
    };
}
/** 当前 ctx 上已注册的路由（诊断用）。 */
export function registeredRoutes(ctx) {
    const t = perContext.get(ctx);
    return t === undefined ? [] : [...t.keys()];
}
