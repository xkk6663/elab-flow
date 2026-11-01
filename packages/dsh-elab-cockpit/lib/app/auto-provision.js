/**
 * 零前置自动准备（宿主半编排）—— 首次打开面板时把内核与工具链备好。
 *
 * 产品约定：
 *   - **唯一不能自动的是主机 Python**：探测不到就 `blocked`，只给指引，绝不代装；
 *   - 内核不存在 → 下载固定版本，下载失败自动回落浅克隆；两条都失败才 `failed`；
 *   - 工具链缺件 → 复用环境包管道安装（sha256 校验 + 固定落点）；
 *   - **幂等**：内核根已就绪就不再下载；环境包已装就不再装；`done` 后再 `start` 直接返回；
 *   - **单飞**：同一时间只跑一份（宿主全局一个实例），重复 start 共享同一 promise；
 *   - 失败/blocked 可 `retry`；错误文案面向用户（不回显原始异常串）。
 *
 * 本文件零 I/O、零适配器 import：下载/探测/安装全部由组装点（host-app）注入。
 */
import { missingToolchain } from "../domain/bootstrap.js";
function initialStatus(kernelVersion) {
    return {
        phase: 'idle',
        step: null,
        stage: '',
        error: null,
        blocked: null,
        kernelVersion,
        updatedAt: Date.now(),
    };
}
export function createAutoProvisioner(deps, options) {
    let status = initialStatus(options.kernelVersion);
    let inFlight = null;
    function publish(patch) {
        status = { ...status, ...patch, updatedAt: Date.now() };
        options.onStatus?.(status);
        return status;
    }
    async function run(sessionId) {
        try {
            // ① 主机 Python 是唯一不可自动的前置：缺了就 blocked，绝不触发任何下载。
            const env = await deps.probe();
            if (env.python.ok !== true) {
                return publish({
                    phase: 'blocked',
                    step: 'probe',
                    stage: '未找到主机 Python',
                    error: null,
                    blocked: {
                        code: 'python-missing',
                        message: '未找到 Python 3.10+，自动准备已暂停（Python 不会被自动安装）。',
                        hint: '请先安装 Python 3.10+（python.org），或在设置页把「python 路径」填成绝对路径（如 C:\\Python312\\python.exe），然后点「重试」。',
                    },
                });
            }
            // ② 内核：已有根就跳过（幂等）；没有才下载，下载失败回落浅克隆。
            let root = deps.resolveRoot(sessionId);
            if (root === null) {
                publish({ phase: 'running', step: 'kernel', stage: `下载内核 v${options.kernelVersion}…`, error: null, blocked: null });
                const dl = await deps.downloadKernel(options.kernelVersion, (text) => {
                    publish({ step: 'kernel', stage: text });
                });
                if (dl.ok) {
                    root = dl.dir;
                    deps.onRootReady(dl.dir);
                }
                else {
                    publish({ step: 'kernel', stage: '下载失败，改用浅克隆…' });
                    const cloned = await deps.cloneKernel();
                    if (cloned.ok) {
                        root = cloned.dir;
                        deps.onRootReady(cloned.dir);
                    }
                    else {
                        return publish({
                            phase: 'failed',
                            step: 'kernel',
                            stage: '内核准备失败',
                            error: {
                                code: 'kernel-unavailable',
                                message: '内核下载与浅克隆都失败了。请检查网络后点「重试」，或用下方手动入口指定已有仓库。',
                                retryable: true,
                            },
                        });
                    }
                }
            }
            // ③ 工具链：探测齐全或环境包已装 → 跳过；否则复用环境包管道安装。
            const missing = missingToolchain(env);
            if (missing.length === 0 || deps.toolchainInstalled()) {
                return publish({
                    phase: 'done',
                    step: 'done',
                    stage: `内核 v${options.kernelVersion} 与工具链已就绪`,
                    error: null,
                    blocked: null,
                });
            }
            publish({
                phase: 'running',
                step: 'toolchain',
                stage: `安装工具链（缺 ${missing.map((t) => t.label).join(' / ')}）…`,
            });
            const installed = await deps.installToolchain((p) => {
                publish({ step: 'toolchain', stage: p.message });
            });
            if (installed.ok === false) {
                return publish({
                    phase: 'failed',
                    step: 'toolchain',
                    stage: '工具链安装失败',
                    error: {
                        code: 'toolchain-failed',
                        message: '工具链下载或校验失败（网络中断或上游文件变化）。可点「重试」，或用下方手动入口。',
                        retryable: true,
                    },
                });
            }
            deps.onToolchainInstalled();
            return publish({
                phase: 'done',
                step: 'done',
                stage: `内核 v${options.kernelVersion} 与工具链已就绪（${installed.tools} 件）`,
                error: null,
                blocked: null,
            });
        }
        catch {
            // 注入函数抛异常也不把原始串甩给用户（只有诊断日志由组装点自己打）。
            return publish({
                phase: 'failed',
                step: status.step,
                stage: '自动准备中断',
                error: {
                    code: 'auto-provision-failed',
                    message: '自动准备中断了。请检查网络后点「重试」，或用下方手动入口。',
                    retryable: true,
                },
            });
        }
    }
    function begin(sessionId, force) {
        if (!options.enabled()) {
            publish({
                phase: 'disabled',
                step: null,
                stage: '自动准备已在设置页关闭（autoProvision=false）',
                error: null,
                blocked: null,
            });
            return { status, settled: Promise.resolve(status) };
        }
        if (inFlight !== null)
            return { status, settled: inFlight };
        if (!force && status.phase === 'done')
            return { status, settled: Promise.resolve(status) };
        publish({
            phase: 'running',
            step: 'probe',
            stage: '检查本机环境…',
            error: null,
            blocked: null,
        });
        const running = run(sessionId);
        inFlight = running;
        const clear = () => {
            if (inFlight === running)
                inFlight = null;
        };
        running.then(clear, clear);
        return { status, settled: running };
    }
    return {
        status() {
            return status;
        },
        start(sessionId) {
            return begin(sessionId, false);
        },
        retry(sessionId) {
            return begin(sessionId, true);
        },
    };
}
