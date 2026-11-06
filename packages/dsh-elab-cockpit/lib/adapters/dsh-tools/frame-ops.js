/**
 * frame 组实现：profile 管理（list/get/preview/save/delete/encode/templates/import）
 * 与协议自学习（learn/verify/auto/codegen）。
 *
 * 红线（不变）：
 *  - Agent 只写**声明式 JSON**，不生成可执行解码器；
 *  - learn 只产草稿（不落盘），save/delete/import 才写盘 → 受 allowAgentWrite
 *    + `rev` 乐观锁双重约束；
 *  - profile 支持位域/变长 length_field/多 ID variants/校验预设/转义/多帧头/
 *    空闲分包/数组/字符串/f16/位标志（schema 权威在 SERIAL_META.frames.schema）。
 */
import { cockpit } from "./runtime.js";
/** JSON 文本 → 对象（失败返回结构化错误，不抛）。 */
function parseJsonArg(text, what) {
    if (text === undefined || text === '')
        return { ok: true, value: undefined };
    try {
        return { ok: true, value: JSON.parse(text) };
    }
    catch {
        return { ok: false, error: `${what} 必须是合法 JSON 字符串` };
    }
}
/** `elab_frame` 门面：profile 库管理。 */
export async function frameAction(deps, action, args) {
    const draft = parseJsonArg(args.profile, 'profile');
    if (!draft.ok)
        return { ok: false, code: 'bad-json', note: draft.error };
    const vals = parseJsonArg(args.values, 'values');
    if (!vals.ok)
        return { ok: false, code: 'bad-json', note: vals.error };
    const project = args.project ?? '';
    const needProject = () => {
        if (!project)
            throw new Error('该 action 需要 project');
    };
    try {
        if (action === 'list' || action === 'get') {
            needProject();
            const res = await cockpit(deps, `/api/serial/frames?project=${encodeURIComponent(project)}`);
            if (action === 'list')
                return res;
            if (!args.id)
                throw new Error('get 需要 id');
            const profiles = res.profiles ?? [];
            const hit = profiles.find((p) => p.id === args.id);
            if (!hit) {
                return { ok: false, code: 'not-found', note: `没有 profile：${args.id}`, profiles: profiles.map((p) => p.id) };
            }
            return { ...res, profile: hit };
        }
        if (action === 'templates') {
            const res = await cockpit(deps, '/api/serial/frames/templates');
            if (!args.template)
                return res;
            const list = res.templates ?? [];
            const hit = list.find((t) => t.id === args.template);
            if (!hit) {
                return { ok: false, code: 'not-found', note: `没有模板：${args.template}`, templates: list.map((t) => t.id) };
            }
            return { ...res, template: hit, profile: hit.profile };
        }
        if (action === 'preview') {
            if (!draft.value && (!project || !args.id)) {
                throw new Error('preview 需要 project+id，或 profile 草稿');
            }
            const body = {
                ...(draft.value
                    ? { profile: draft.value }
                    : { project, id: args.id }),
                ...(args.hex !== undefined ? { hex: args.hex } : {}),
                ...(args.b64 !== undefined ? { b64: args.b64 } : {}),
            };
            return await cockpit(deps, '/api/serial/frames/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        }
        if (action === 'encode') {
            if (!draft.value && (!project || !args.id)) {
                throw new Error('encode 需要 project+id，或 profile 草稿');
            }
            const body = {
                ...(draft.value
                    ? { profile: draft.value }
                    : { project, id: args.id }),
                values: vals.value ?? {},
                ...(args.variant !== undefined ? { variant: args.variant } : {}),
                ...(args.length_value !== undefined ? { length_value: args.length_value } : {}),
            };
            return await cockpit(deps, '/api/serial/frames/encode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        }
        if (action === 'save' || action === 'delete' || action === 'import') {
            if (!deps.allowAgentWrite()) {
                return {
                    ok: false,
                    code: 'agent-write-disabled',
                    note: '改 profile 会写盘：需要用户在设置里开启 allowAgentWrite',
                };
            }
            if (args.rev === undefined) {
                throw new Error('写操作需要 rev（先 action=list 取 rev 再重试）');
            }
            if (action === 'save') {
                if (!draft.value)
                    throw new Error('save 需要 profile JSON');
                needProject();
                return await cockpit(deps, '/api/serial/frames', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'save', project, rev: args.rev, profile: draft.value }),
                });
            }
            if (action === 'delete') {
                needProject();
                if (!args.id)
                    throw new Error('delete 需要 id');
                return await cockpit(deps, '/api/serial/frames', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'delete', project, rev: args.rev, id: args.id }),
                });
            }
            needProject();
            if (!args.template)
                throw new Error('import 需要 template');
            return await cockpit(deps, '/api/serial/frames/templates/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project,
                    rev: args.rev,
                    template: args.template,
                    ...(args.new_id !== undefined ? { new_id: args.new_id } : {}),
                }),
            });
        }
        return {
            ok: false,
            code: 'bad-action',
            note: 'action 必须是 list/get/preview/save/delete/encode/templates/import',
        };
    }
    catch (error) {
        return {
            ok: false,
            code: 'frame-profile-failed',
            note: error instanceof Error ? error.message : String(error),
        };
    }
}
/** `elab_frame_learn` 门面：协议自学习闭环（learn/verify/auto/codegen）。 */
export async function frameLearnAction(deps, action, args) {
    const draft = parseJsonArg(args.profile, 'profile');
    if (!draft.ok)
        return { ok: false, code: 'bad-json', note: draft.error };
    const project = args.project ?? '';
    try {
        if (action === 'learn') {
            // 只产草稿：这里**不写盘**，所以不需要 allowAgentWrite。
            if (args.capture === undefined && args.hex === undefined &&
                args.b64 === undefined && args.frames === undefined) {
                throw new Error('learn 需要 capture / frames / hex / b64 之一');
            }
            const parsedFrames = parseJsonArg(args.frames, 'frames');
            if (!parsedFrames.ok)
                return { ok: false, code: 'bad-json', note: parsedFrames.error };
            const parsedHints = parseJsonArg(args.hints, 'hints');
            if (!parsedHints.ok)
                return { ok: false, code: 'bad-json', note: parsedHints.error };
            return await cockpit(deps, '/api/serial/frames/learn', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(args.capture !== undefined ? { capture: args.capture } : {}),
                    ...(args.frames !== undefined ? { frames: parsedFrames.value } : {}),
                    ...(args.hex !== undefined ? { hex: args.hex } : {}),
                    ...(args.b64 !== undefined ? { b64: args.b64 } : {}),
                    ...(args.hints !== undefined ? { hints: parsedHints.value ?? {} } : {}),
                    ...(args.field_count !== undefined ? { field_count: args.field_count } : {}),
                    ...(args.name !== undefined ? { name: args.name } : {}),
                }),
            });
        }
        if (action === 'verify') {
            if (!draft.value && (!project || !args.id)) {
                throw new Error('verify 需要 project+id，或 profile 草稿');
            }
            return await cockpit(deps, '/api/serial/frames/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(draft.value ? { profile: draft.value } : { project, id: args.id }),
                    ...(args.hex !== undefined ? { hex: args.hex } : {}),
                    ...(args.b64 !== undefined ? { b64: args.b64 } : {}),
                    ...(args.capture !== undefined ? { capture: args.capture } : {}),
                }),
            });
        }
        if (action === 'auto') {
            if (args.hex === undefined && args.b64 === undefined &&
                args.capture === undefined) {
                throw new Error('auto 需要 hex / b64 / capture 之一');
            }
            return await cockpit(deps, '/api/serial/frames/auto', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(project ? { project } : {}),
                    ...(args.hex !== undefined ? { hex: args.hex } : {}),
                    ...(args.b64 !== undefined ? { b64: args.b64 } : {}),
                    ...(args.capture !== undefined ? { capture: args.capture } : {}),
                    ...(args.apply !== undefined ? { apply: args.apply } : {}),
                }),
            });
        }
        if (action === 'codegen') {
            if (!draft.value && (!project || !args.id)) {
                throw new Error('codegen 需要 project+id，或 profile 草稿');
            }
            return await cockpit(deps, '/api/serial/frames/codegen', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(draft.value ? { profile: draft.value } : { project, id: args.id }),
                    ...(args.write !== undefined ? { write: args.write } : {}),
                    ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
                }),
            });
        }
        return {
            ok: false,
            code: 'bad-action',
            note: 'action 必须是 learn/verify/auto/codegen',
        };
    }
    catch (error) {
        return {
            ok: false,
            code: 'frame-learn-failed',
            note: error instanceof Error ? error.message : String(error),
        };
    }
}
