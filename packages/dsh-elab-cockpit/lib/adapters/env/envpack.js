/**
 * Host 半 —— 一键环境包（下载 → 校验 → 解压 → 版本探测 → 写状态）。
 *
 * 纪律：
 *   ① **不内置二进制**：包内容物来自清单里的官方上游直链（https）；
 *   ② **校验优先**：清单有 sha256 就硬校验；没有则首次记录（TOFU）并警告；
 *   ③ **幂等**：同版本 + 同 URL 且目录在 → 直接跳过，不重复下载；
 *   ④ **不改仓库**：只落在 `~/.dsh/elab/env/<packId>/`，靠 ELAB_* 环境变量注入，
 *      内核的 elab.host.yaml 保持"一台机器的事实源"不被插件改写。
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { findPack, packEnv, packPathDirs, platformKey, } from "../../domain/envpack.js";
/** 清单随包分发：`envpacks/manifest.json`（src 与 lib 到包根都是三级）。 */
const MANIFEST_URL = new URL('../../../envpacks/manifest.json', import.meta.url);
export function envRoot() {
    return join(homedir(), '.dsh', 'elab', 'env');
}
export function readManifest() {
    try {
        const raw = readFileSync(MANIFEST_URL, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.packs))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function statePath(packId) {
    return join(envRoot(), packId, 'pack.json');
}
export function readInstalledPack(packId) {
    const key = packId ?? platformKey(process.platform, process.arch);
    try {
        const parsed = JSON.parse(readFileSync(statePath(key), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/** spawn 时用：已装包要注入的环境变量 + 要前置进 PATH 的目录（无则 null）。 */
export function installedPackEnv() {
    const key = platformKey(process.platform, process.arch);
    const state = readInstalledPack(key);
    const pack = findPack(readManifest(), key);
    if (state === null || pack === null)
        return null;
    const roots = {};
    for (const tool of pack.tools) {
        const installed = state.tools[tool.id];
        if (installed !== undefined && existsSync(installed.root))
            roots[tool.id] = installed.root;
    }
    if (Object.keys(roots).length === 0)
        return null;
    return { env: packEnv(pack, roots), pathDirs: packPathDirs(pack, roots) };
}
function openStream(url, hops) {
    return new Promise((resolve, reject) => {
        if (hops > 5) {
            reject(new Error('重定向次数过多'));
            return;
        }
        const req = httpsGet(url, { headers: { 'User-Agent': 'dsh-elab-cockpit-envpack' } }, (res) => {
            const code = res.statusCode ?? 0;
            if (code >= 300 && code < 400 && typeof res.headers.location === 'string') {
                res.resume();
                resolve(openStream(new URL(res.headers.location, url).toString(), hops + 1));
                return;
            }
            if (code !== 200) {
                res.resume();
                reject(new Error(`HTTP ${code}（${url}）`));
                return;
            }
            resolve(res);
        });
        req.setTimeout(60_000, () => req.destroy(new Error('下载超时（无数据 60s）')));
        req.on('error', reject);
    });
}
export function downloadToFile(url, dest) {
    return new Promise((resolve) => {
        openStream(url, 0).then((res) => {
            const hash = createHash('sha256');
            let bytes = 0;
            const out = createWriteStream(dest);
            res.on('data', (chunk) => {
                bytes += chunk.length;
                hash.update(chunk);
            });
            res.on('error', (e) => {
                out.destroy();
                resolve({ ok: false, error: `下载中断：${e.message}` });
            });
            res.pipe(out);
            out.on('finish', () => resolve({ ok: true, bytes, sha256: hash.digest('hex') }));
            out.on('error', (e) => resolve({ ok: false, error: `写文件失败：${e.message}` }));
        }).catch((e) => resolve({ ok: false, error: String(e instanceof Error ? e.message : e) }));
    });
}
/** 解压后若只有唯一顶层目录（上游归档惯例），逐层下探它作为解压根（不搬文件）。 */
export function unwrapSingleDir(dir) {
    let cur = dir;
    for (let i = 0; i < 3; i += 1) {
        const entries = readdirSync(cur);
        if (entries.length !== 1)
            break;
        const only = join(cur, entries[0]);
        if (!statSync(only).isDirectory())
            break;
        cur = only;
    }
    return cur;
}
export function probeTool(dir, probe) {
    return new Promise((resolve) => {
        const [rel, ...args] = probe;
        execFile(join(dir, rel), args, { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
            const text = `${String(stdout ?? '')}${String(stderr ?? '')}`.trim();
            if (error !== null && text === '') {
                resolve(undefined);
                return;
            }
            resolve(text.split(/\r?\n/)[0]?.slice(0, 160));
        });
    });
}
/**
 * 安装当前平台的整套环境包（可重复调用：已装且版本一致的工具会被跳过）。
 */
export async function installEnvPack(packId, onProgress) {
    const manifest = readManifest();
    const key = packId ?? platformKey(process.platform, process.arch);
    const pack = findPack(manifest, key);
    if (pack === null) {
        return {
            ok: false,
            code: 'no-pack',
            message: `清单里没有当前平台的环境包（${key}）；只支持清单里列出的平台`,
        };
    }
    const warnings = [];
    const prev = readInstalledPack(pack.id);
    const tools = {};
    const base = join(envRoot(), pack.id);
    mkdirSync(base, { recursive: true });
    for (const spec of pack.tools) {
        const dest = join(base, spec.id);
        const old = prev?.tools[spec.id];
        if (old !== undefined &&
            old.version === spec.version &&
            old.sourceUrl === spec.url &&
            existsSync(dest)) {
            tools[spec.id] = old;
            onProgress?.({ phase: 'skip', toolId: spec.id, message: `${spec.label} 已是 ${spec.version}，跳过` });
            continue;
        }
        onProgress?.({ phase: 'download', toolId: spec.id, message: `下载 ${spec.label}…` });
        const tmpZip = join(base, `${spec.id}-${randomUUID()}.zip`);
        const dl = await downloadToFile(spec.url, tmpZip);
        if (dl.ok === false) {
            rmSync(tmpZip, { force: true });
            return { ok: false, code: 'download-failed', message: `${spec.label} 下载失败：${dl.error ?? '未知原因'}` };
        }
        onProgress?.({ phase: 'verify', toolId: spec.id, message: `校验 ${spec.label}…` });
        const want = spec.sha256.trim().toLowerCase();
        const got = dl.sha256 ?? '';
        let verified = false;
        if (want !== '') {
            if (want !== got) {
                rmSync(tmpZip, { force: true });
                return {
                    ok: false,
                    code: 'sha256-mismatch',
                    message: `${spec.label} 校验失败：期望 ${want}，实际 ${got}`,
                };
            }
            verified = true;
        }
        else {
            const w = `${spec.label} 未在清单声明 sha256，已按首次下载记录（${got.slice(0, 12)}…）；请核对后写回清单`;
            warnings.push(w);
        }
        onProgress?.({ phase: 'extract', toolId: spec.id, message: `解压 ${spec.label}…` });
        rmSync(dest, { recursive: true, force: true });
        try {
            new AdmZip(tmpZip).extractAllTo(dest, true);
        }
        catch (e) {
            rmSync(tmpZip, { force: true });
            return { ok: false, code: 'extract-failed', message: `${spec.label} 解压失败：${String(e)}` };
        }
        finally {
            rmSync(tmpZip, { force: true });
        }
        const root = unwrapSingleDir(dest);
        let probeVersion;
        if (spec.probe !== undefined) {
            onProgress?.({ phase: 'probe', toolId: spec.id, message: `探测 ${spec.label} 版本…` });
            probeVersion = await probeTool(root, spec.probe);
            if (probeVersion === undefined) {
                warnings.push(`${spec.label} 已解压但版本探测失败（${spec.probe[0]}）—— 可能缺运行库，编译时再确认`);
            }
        }
        tools[spec.id] = {
            id: spec.id,
            version: spec.version,
            root,
            sourceUrl: spec.url,
            sha256: got,
            verified,
            ...(probeVersion !== undefined ? { probeVersion } : {}),
        };
    }
    const state = { packId: pack.id, installedAt: Date.now(), tools };
    writeFileSync(statePath(pack.id), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    onProgress?.({ phase: 'done', toolId: '*', message: `环境包 ${pack.label} 就绪` });
    return { ok: true, packId: pack.id, state, warnings };
}
export function envPackStatus() {
    const key = platformKey(process.platform, process.arch);
    const pack = findPack(readManifest(), key);
    const state = readInstalledPack(key);
    const installed = pack === null || state === null
        ? 0
        : pack.tools.filter((t) => state.tools[t.id] !== undefined).length;
    return {
        platformKey: key,
        packId: pack?.id ?? null,
        label: pack?.label ?? null,
        toolsTotal: pack?.tools.length ?? 0,
        toolsInstalled: installed,
        sizeHintMB: pack === undefined || pack === null
            ? 0
            : pack.tools.reduce((n, t) => n + (t.sizeHintMB ?? 0), 0),
        installedAt: state?.installedAt ?? null,
        warnings: [],
    };
}
