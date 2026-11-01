/**
 * cockpit 进程托管 —— 一个 rootKey 一个 Python 进程。
 *
 * 三个已实测的硬约束（见文档 §14.3）：
 *   ① **必须 `-u`**：否则子进程 stdout 走管道时是块缓冲，永远等不到
 *      "监听 http://…" 那一行 → 调用方永久挂起（实测挂死一次）。
 *   ② **必须显式 UTF-8**：Windows 默认 GBK，服务端输出里的 `✓`/中文会让
 *      `UnicodeDecodeError` 直接炸（实测）。
 *   ③ **端口用 `--port 0`** 让 OS 分配，再从启动横幅正则解析 ——
 *      避开 8333（默认）与 3333（openocd）冲突，也支持多实例并存。
 *
 * 生命周期：spawn 后立即 arm Job Object（Q16），dispose 时 close Job → 全树终结。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, normalize } from 'node:path';
import { armJobForPid, taskkillTree } from "./job-object.js";
/**
 * 从启动横幅里取端口：`[cockpit] 监听 http://127.0.0.1:6338/`
 *
 * ★ 刻意**不用正则**。本项目里任何含反斜杠的转义序列（`\s` `\d` `\/`）
 *   在经编辑链路落盘时都有被折叠成字面量的风险 —— 实测已两次把
 *   `/\s+/` 变成 `/s+/`、把 `\\` 变成 `\`。纯字符串操作没有这个问题。
 */
export function parsePortFromBanner(line) {
    const marker = '监听';
    const at = line.indexOf(marker);
    if (at < 0)
        return undefined;
    const rest = line.slice(at + marker.length);
    // 取 "http://" 之后的部分
    const scheme = rest.indexOf('//');
    if (scheme < 0)
        return undefined;
    const afterScheme = rest.slice(scheme + 2);
    // 主机与端口之间是最后一个 ':'（IPv6 会加方括号，冒号更多，所以取最后一个）
    const colon = afterScheme.lastIndexOf(':');
    if (colon < 0)
        return undefined;
    let digits = '';
    for (const ch of afterScheme.slice(colon + 1)) {
        if (ch >= '0' && ch <= '9')
            digits += ch;
        else
            break;
    }
    if (digits === '')
        return undefined;
    const port = Number(digits);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}
async function waitReachable(baseUrl, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseUrl}/api/capabilities`, {
                signal: AbortSignal.timeout(1500),
            });
            if (res.ok) {
                // 就绪即抓内核自描述（§16）：版本 + 是否带 meta（UI 提示内核过旧用）
                let cap = {};
                try {
                    cap = (await res.json());
                }
                catch {
                    /* 非 JSON：视为无版本信息 */
                }
                return {
                    kernelVersion: typeof cap.cockpit?.version === 'string' ? cap.cockpit.version : undefined,
                    hasMeta: cap.meta !== undefined,
                };
            }
            last = `HTTP ${res.status}`;
        }
        catch (error) {
            last = error;
        }
        await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`cockpit 端口 ${baseUrl} 在 ${timeoutMs}ms 内未就绪（最后：${String(last)}）`);
}
const PYTHON_CANDIDATES = ['python', 'python3', 'py'];
export function resolvePython(explicit) {
    if (explicit !== undefined && explicit !== '' && explicit !== 'auto')
        return explicit;
    for (const c of PYTHON_CANDIDATES) {
        // 只用 PATH 名字；真正的版本校验交给 spawn 失败后的错误信息
        if (c === 'python')
            return c;
    }
    return 'python';
}
/**
 * 校验 elabRoot 是不是一个 elab 仓库（有 cockpit/ 与 services/elab/）。
 * 只做结构判断，不解析 YAML —— 后者由 Python 侧负责。
 */
export function looksLikeElabRoot(root) {
    if (!isAbsolute(root))
        return false;
    const r = normalize(root);
    return existsSync(join(r, 'cockpit', 'server.py')) && existsSync(join(r, 'services', 'elab'));
}
export class CockpitHost {
    child;
    job;
    tail = [];
    exited = false;
    handle;
    // ★ 不用 TS 参数属性（`constructor(private x)`）：
    //   Node 的 strip-only 类型剥离不支持该语法（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX），
    //   而我们的单测/脚本直接用 `--experimental-strip-types` 跑 TS，构建前就要能跑。
    constructor(handle) {
        this.handle = handle;
    }
    /** 启动一个 cockpit 进程并等待其监听端口。 */
    static async start(opts) {
        if (!looksLikeElabRoot(opts.elabRoot)) {
            throw new Error(`不是 elab 仓库根（缺 cockpit/server.py 或 services/elab）：${opts.elabRoot}`);
        }
        const python = resolvePython(opts.pythonPath);
        const argv = [
            // ① 无缓冲：不传 -u 就会因为管道块缓冲而永远等不到监听横幅
            '-u',
            '-m',
            'cockpit.server',
            '--port',
            '0', // ② OS 分配端口
            ...(opts.extraArgs ?? ['--reload']),
        ];
        // ③ 环境包：先拼 PATH 再注入 ELAB_*（顺序固定，避免 PATH 被覆盖）
        const extraPath = (opts.toolEnv?.pathDirs ?? []).filter((d) => d !== '');
        const env = {
            ...process.env,
            ...(opts.toolEnv?.env ?? {}),
            ...(extraPath.length > 0
                ? { PATH: [extraPath.join(delimiter), process.env.PATH ?? ''].join(delimiter) }
                : {}),
            // ② UTF-8：GBK 解不了 ✓ 与中文
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
            PYTHONPATH: join(opts.elabRoot, 'services'),
        };
        const started = Date.now();
        const child = spawn(python, argv, {
            cwd: opts.elabRoot,
            env,
            windowsHide: true,
            // detached: 让子进程自成进程组（POSIX 降级路径要 -pid 强杀）
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const tail = [];
        const pushTail = (line) => {
            tail.push(line);
            if (tail.length > 40)
                tail.shift();
        };
        // ③ 解析监听横幅（带超时，失败时把 tail 原样抛给调用方诊断）
        const port = await new Promise((resolve, reject) => {
            let buf = '';
            const timer = setTimeout(() => {
                reject(new Error(`cockpit 启动超时（15s）。输出尾部：\n${tail.join('\n') || '(无输出)'}`));
            }, 15_000);
            const onChunk = (chunk) => {
                buf += String(chunk);
                let idx = buf.indexOf('\n');
                while (idx >= 0) {
                    const line = buf.slice(0, idx);
                    buf = buf.slice(idx + 1);
                    pushTail(line);
                    const p = parsePortFromBanner(line);
                    if (p !== undefined) {
                        clearTimeout(timer);
                        resolve(p);
                        return;
                    }
                    idx = buf.indexOf('\n');
                }
            };
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', onChunk);
            child.stderr.on('data', onChunk);
            child.once('error', (e) => {
                clearTimeout(timer);
                reject(new Error(`无法启动 python（${python}）：${e.message}`));
            });
            child.once('exit', (code) => {
                clearTimeout(timer);
                reject(new Error(`cockpit 提前退出 code=${code ?? '?'}。输出尾部：\n${tail.join('\n') || '(无输出)'}`));
            });
        });
        // ④ arm Job Object（Q16）：失败不致命，降级到 taskkill 树
        const jobRes = await armJobForPid(child.pid);
        // 收窄联合类型：只有 status==='armed' 的分支带 kill()
        const armed = jobRes.status === 'armed' ? jobRes : undefined;
        // ⑤ 等到**真正可服务**再返回。
        //    ★ 横幅在 `srv.serve_forever()` 之前就打印了（server.py:1341），
        //      从横幅到 accept 循环启动之间有一个窗口，此时 TCP 连接会被拒
        //      （实测 ECONNREFUSED）。故用一次探活把窗口抹平，而不是让调用方撞运气。
        const base = `http://127.0.0.1:${port}`;
        const kernel = await waitReachable(base, Math.max(1000, 15_000 - (Date.now() - started)));
        const bootMs = Date.now() - started;
        const handle = {
            pid: child.pid,
            port,
            baseUrl: base,
            bootMs,
            ...(kernel.kernelVersion !== undefined ? { kernelVersion: kernel.kernelVersion } : {}),
            ...(kernel.hasMeta !== undefined ? { hasMeta: kernel.hasMeta } : {}),
            job: armed === undefined ? 'unavailable' : 'armed',
            jobReason: jobRes.status === 'unavailable' ? jobRes.reason : undefined,
            async dispose() {
                if (armed !== undefined) {
                    await armed.kill();
                }
                await taskkillTree(child.pid);
            },
            alive: () => child.exitCode === null && !child.killed,
            stderrTail: () => [...tail],
        };
        const self = new CockpitHost(handle);
        self.child = child;
        self.tail = tail;
        child.once('exit', () => {
            self.exited = true;
        });
        return self;
    }
    get info() {
        return {
            ...this.handle,
            alive: () => !this.exited && this.child !== undefined && this.child.exitCode === null,
            stderrTail: () => [...this.tail],
        };
    }
    async dispose() {
        if (this.exited)
            return;
        try {
            this.child?.stdin?.end();
        }
        catch { /* ignore */ }
        await this.handle.dispose();
    }
}
