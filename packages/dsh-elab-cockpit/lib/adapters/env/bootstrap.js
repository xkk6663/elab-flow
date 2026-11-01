/**
 * Host 半 —— 引导写动作（`POST /elab/bootstrap`）：四件事。
 *
 *   `set-root`         ：校验指定目录确实是 elab 仓库根 → 写配置（不克隆）；
 *   `clone`            ：浅克隆一个 https 仓库到**空目录** → 校验 → 写配置；
 *   `install-toolchain`：下载官方环境包（GCC / CMake / Ninja / OpenOCD）→ 注入 ELAB_*；
 *   `download-kernel`   ：按 `vX.Y.Z` tag 下载内核源码归档 → 解到 `~/.dsh/elab/kernels/`。
 *
 * 纪律（方案 §3.7）：
 *   不静默写盘（一律 `confirm:true`）、不执行任意命令（git / 下载只用固定参数，
 *   url 必须是 https）、不覆盖用户已有检出（目标目录必须不存在或为空）。
 *   拉取更新（pull）**不在这里执行** —— UI 只给可复制命令。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { isValidKernelVersion } from "../../domain/envpack.js";
import { ELAB_REPO, kernelsRoot } from "./kernel-download.js";
/** 目录不存在或为空（避免覆盖用户已有内容）。 */
function isAbsentOrEmpty(dir) {
    if (!existsSync(dir))
        return true;
    try {
        return readdirSync(dir).length === 0;
    }
    catch {
        return false;
    }
}
/**
 * 校验 `POST /elab/bootstrap` 的请求体。返回 `ok:false` 时带人话错误码，
 * 宿主直接 400 回显（不抛异常）。
 */
export function validateBootstrapRequest(body, isElabRoot) {
    if (body === null || typeof body !== 'object') {
        return { ok: false, code: 'bad-request', message: '请求体必须是 JSON 对象' };
    }
    const b = body;
    const action = typeof b.action === 'string' ? b.action : '';
    if (action === 'set-root') {
        if (typeof b.dir !== 'string' || !isAbsolute(b.dir)) {
            return { ok: false, code: 'bad-dir', message: 'dir 必须是绝对路径' };
        }
        const dir = normalize(b.dir.trim());
        if (!isElabRoot(dir)) {
            return {
                ok: false,
                code: 'not-elab-root',
                message: '该目录不是 elab 仓库根（需同时包含 cockpit/server.py 与 services/elab）',
            };
        }
        return { ok: true, request: { action: 'set-root', dir } };
    }
    if (action === 'clone') {
        if (b.confirm !== true) {
            return { ok: false, code: 'confirm-required', message: '克隆会写盘，需要 confirm:true' };
        }
        if (typeof b.url !== 'string' || !/^https:\/\/[^/\s]+/.test(b.url.trim())) {
            return { ok: false, code: 'bad-url', message: '只允许 https:// 仓库地址' };
        }
        if (typeof b.dir !== 'string' || !isAbsolute(b.dir)) {
            return { ok: false, code: 'bad-dir', message: 'dir 必须是绝对路径' };
        }
        const dir = normalize(b.dir.trim());
        if (!isAbsentOrEmpty(dir)) {
            return {
                ok: false,
                code: 'dir-not-empty',
                message: '目标目录已存在且非空（为避免覆盖已有检出，请换一个空目录）',
            };
        }
        return { ok: true, request: { action: 'clone', url: b.url.trim(), dir } };
    }
    if (action === 'install-toolchain') {
        if (b.confirm !== true) {
            return { ok: false, code: 'confirm-required', message: '安装环境包会下载并写盘，需要 confirm:true' };
        }
        const pack = typeof b.pack === 'string' && b.pack.trim() !== '' ? b.pack.trim() : undefined;
        return pack === undefined
            ? { ok: true, request: { action: 'install-toolchain' } }
            : { ok: true, request: { action: 'install-toolchain', pack } };
    }
    if (action === 'download-kernel') {
        if (b.confirm !== true) {
            return { ok: false, code: 'confirm-required', message: '下载内核会写盘，需要 confirm:true' };
        }
        const version = typeof b.version === 'string' ? b.version.trim().replace(/^v/i, '') : '';
        if (!isValidKernelVersion(version)) {
            return { ok: false, code: 'bad-version', message: 'version 需为 x.y 或 x.y.z（如 2.1.0）' };
        }
        return { ok: true, request: { action: 'download-kernel', version } };
    }
    // 零前置自动准备：写盘范围固定（~/.dsh/elab/**），且由 autoProvision 配置门控，
    // 因此不走 confirm（它不是"某一次用户没点的动作"，而是产品默认行为）。
    if (action === 'auto-provision') {
        return { ok: true, request: { action: 'auto-provision' } };
    }
    return { ok: false, code: 'unknown-action', message: `不支持的 action：${action || '(空)'}` };
}
/**
 * 自动回落用的固定克隆落点：`~/.dsh/elab/kernels/clone`（插件自有目录，
 * 不碰用户工作区）。UI 不需要知道家目录，路径完全由宿主半决定。
 */
export function defaultCloneDir() {
    return join(kernelsRoot(), 'clone');
}
/**
 * 浅克隆到固定落点（内核下载失败时的自动回落）。
 *
 * 幂等：目录已是 elab 仓库根 → 直接复用；在上一次半途失败留下的残缺目录
 * （仍在 `~/.dsh/elab` 内）→ 清掉重来。错误文案面向用户，不回显原始 stdout。
 */
export async function cloneKernelDefault(isElabRoot) {
    const dir = defaultCloneDir();
    try {
        if (existsSync(dir)) {
            if (isElabRoot(dir))
                return { ok: true, dir };
            rmSync(dir, { recursive: true, force: true });
        }
    }
    catch {
        return { ok: false, code: 'clone-failed', message: '无法清理上次残留的克隆目录，请手动删除后重试' };
    }
    const cloned = await cloneKernel(ELAB_REPO, dir);
    if (cloned.ok === false) {
        return { ok: false, code: 'clone-failed', message: 'git 浅克隆失败（请检查网络与 git 是否可用）' };
    }
    if (!isElabRoot(dir)) {
        return { ok: false, code: 'not-elab-root', message: '克隆完成，但目录不是 elab 仓库根' };
    }
    return { ok: true, dir };
}
/** 浅克隆（固定参数 `clone --depth 1`；url 已校验为 https）。 */
export function cloneKernel(url, dir, timeoutMs = 180_000) {
    return new Promise((resolve) => {
        execFile('git', ['clone', '--depth', '1', url, dir], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
            const text = `${String(stdout ?? '')}${String(stderr ?? '')}`.trim();
            if (error !== null) {
                resolve({ ok: false, error: text !== '' ? text.slice(-800) : error.message });
                return;
            }
            resolve({ ok: true, stdout: text.slice(-400) });
        });
    });
}
