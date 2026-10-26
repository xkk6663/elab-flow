/**
 * elab 工程发现（`/elab/api/discover`）—— 纯函数核心。
 *
 * 设计要点（均为实测/源码推导，不是拍脑袋）：
 *
 * ① **根工程判定**：不能"见到 CMakeLists.txt 就算一个工程"。本仓库实测有 7 个，
 *    其中 `components/ota|serial` 是被上层工程 `add_subdirectory()` 引用的**子目录
 *    CMake**——它们没有 `project()`/`CMAKE_PROJECT_NAME`，接进 elab 只会得到
 *    "工程名为空 + 产物名不确定"的探测失败。故以"声明了工程名"为根工程标志
 *    （`elab adapt` 的 ③ 步同样以 `_detect_project_name` 为前提）。
 *
 * ② **深度**：`elab-flow` 的真实布局是 `examples/<PROJ>/CMakeLists.txt`（深度 2），
 *    离线工程常见 `repo/fw/app/CMakeLists.txt`（深度 3）。取 3 是覆盖面与耗时的折中；
 *    实测本仓库深度 3 内共 7 个命中、扫描 < 5ms。
 *
 * ③ **排除优先级高于一切**：`build/`、`.work/`（elab 自己的产物目录）、`node_modules/`、
 *    `third_party/`、`vendor/`、以 `.` 开头的目录。**必须在进入目录前剪枝**，
 *    否则一进 `build/` 就会撞上 CMake 生成的 `_deps/` 树（动辄上千目录）。
 *
 * ④ **上限 + 截断标志**：命中数达上限即停止并返回 `truncated: true`，
 *    让 UI 如实告知"还有更多"，而不是静默截断。
 *
 * ⑤ **确定性输出**：结果按 (深度, 路径) 排序，同一目录树重复扫描结果逐字节一致
 *    （便于缓存与测试断言）。
 *
 * 本模块**不做任何网络/子进程调用**，只读文件系统；`readdir` 可注入，便于单测。
 */
/** 内置排除目录（按名，大小写不敏感）。 */
const BASE_EXCLUDE = [
    'build',
    'cmake-build-debug',
    'cmake-build-release',
    'cmake-build-relwithdebinfo',
    'cmake-build-minsizerel',
    '.work',
    'node_modules',
    'third_party',
    'third-party',
    'vendor',
    'out',
    'dist',
];
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_LIMIT = 50;
/**
 * 路径规范化：统一正斜杠、折叠分隔符；盘符统一大写（其余保留大小写以便展示）。
 *
 * ★ 反斜杠必须用 `String.fromCharCode(92)` 拼正则，**不能**写成字面量
 *   —— 该字面量在经编辑工具落盘时曾把 `\\` 折叠成 `\`，于是
 *   `C:\repo\ok` 被替换成 `C:epook`（实测踩到，见 test 'normalizePath 处理反斜杠'）。
 *   用字符码构造后，源码里不再有反斜杠转义序列，无法被再次折叠。
 */
export function normalizePath(p) {
    const BACKSLASH = new RegExp(String.fromCharCode(92) + String.fromCharCode(92), 'g');
    const slashed = p.replace(BACKSLASH, '/').replace(/\/{2,}/g, '/');
    const trimmed = slashed.length > 1 ? slashed.replace(/\/$/, '') : slashed;
    return /^[a-zA-Z]:\//.test(trimmed) ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}
/** 比较用的键：去掉末尾分隔符并统一大小写（Windows）。 */
function keyOf(p) {
    const n = normalizePath(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
}
function isExcluded(name, extra) {
    const low = name.toLowerCase();
    if (low.startsWith('.'))
        return true; // .git / .idea / .vscode / .work …
    for (const e of BASE_EXCLUDE)
        if (low === e)
            return true;
    for (const e of extra)
        if (low === e.toLowerCase())
            return true;
    return false;
}
/**
 * 根工程判定：CMakeLists 文本里是否声明了工程名。
 *
 * 覆盖两种写法（与 `elab adapt` 的 `_detect_project_name` 同源）：
 *   - `project(<name> …)`
 *   - `set(CMAKE_PROJECT_NAME <name>)`   ← WorkBench/CubeMX 的导出写法
 *
 * 注释行先剔除，避免把 `# project(foo)` 当成声明。
 */
export function declaresProjectName(cmakeText) {
    const code = stripComments(cmakeText);
    const setMatch = code.match(/set\s*\(\s*CMAKE_PROJECT_NAME\s+([A-Za-z0-9_$@.-]+)/i);
    if (setMatch !== null)
        return setMatch[1];
    const projMatch = code.match(/\bproject\s*\(\s*([A-Za-z0-9_$@.-]+)/i);
    if (projMatch !== null)
        return projMatch[1];
    return undefined;
}
/**
 * 去掉 CMake 注释：块注释 `#[[ … ]]` 与行注释 `#` 到行尾。
 *
 * ★ 块的收尾**必须是行尾的 `]]`**（CMake 语法：`bracket_comment_end` 是
 *   `]]` 后跟换行或文件结束）。不收尾的 `#[[` 只是普通行注释 —— 若用非贪婪
 *   `]]` 去配，`#[[ multi\nline ]]x` 这种畸形输入会把第二行残留成代码。
 */
export function stripComments(text) {
    return text
        .replace(/#\[\[[\s\S]*?\]\](?=\r?\n|$)/g, ' ')
        .replace(/#[^\n]*/g, ' ');
}
/** 生成的 CMakeLists 通常声明工程名，但变量里没有具体值时可再细化；此处保持简单：非空即真。 */
function looksLikeRealProject(name) {
    return name !== undefined && name.trim() !== '';
}
/**
 * 扫描一个根目录，返回候选工程列表。
 *
 * @param opts 扫描边界
 * @param deps 可注入依赖（单测用）；缺省用 `node:fs/promises`
 */
export async function discoverProjects(opts, deps) {
    const started = Date.now();
    const root = normalizePath(opts.root);
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const extraExclude = opts.excludeNames ?? [];
    const adaptedByPath = new Map();
    for (const a of opts.adapted ?? [])
        adaptedByPath.set(keyOf(a.root), a.name);
    const readdir = deps?.readdir ?? defaultReaddir;
    const readFile = deps?.readFile ?? defaultReadFile;
    const candidates = [];
    let dirsVisited = 0;
    let truncated = false;
    /** 广度优先：先浅层命中先出现，天然得到"浅层优先"的排序。 */
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length > 0 && !truncated) {
        const { dir, depth } = queue.shift();
        let entries;
        try {
            entries = await readdir(dir);
        }
        catch {
            continue; // 权限/竞态：跳过该目录，不让一颗子树拖垮整次扫描
        }
        dirsVisited += 1;
        const dirs = [];
        let cmakeEntry;
        const files = [];
        for (const e of entries) {
            if (e.isSymbolicLink?.() === true)
                continue;
            const full = joinPath(dir, e.name);
            if (e.isDirectory()) {
                if (!isExcluded(e.name, extraExclude))
                    dirs.push(full);
            }
            else if (e.isFile()) {
                files.push(full);
                if (e.name === 'CMakeLists.txt')
                    cmakeEntry = e;
            }
        }
        // ① 本目录是候选吗？（根工程 = 声明了工程名）
        if (cmakeEntry !== undefined) {
            const text = await safeRead(readFile, joinPath(dir, 'CMakeLists.txt'));
            if (looksLikeRealProject(declaresProjectName(text))) {
                if (candidates.length >= limit) {
                    truncated = true;
                }
                else {
                    candidates.push({
                        path: normalizePath(dir),
                        dirname: basename(dir),
                        depth,
                        hints: await collectHints(dir, files, dirs, readdir),
                        adaptedAs: adaptedByPath.get(keyOf(dir)),
                    });
                }
            }
        }
        // ② 继续下探（达到上限即停止，不再入队）
        if (!truncated && depth < maxDepth) {
            for (const d of dirs)
                queue.push({ dir: d, depth: depth + 1 });
        }
    }
    // 确定性排序：深度浅 → 路径字典序（已接入的排最后，便于"新发现的"浮上来）
    candidates.sort((a, b) => {
        const aAd = a.adaptedAs === undefined ? 0 : 1;
        const bAd = b.adaptedAs === undefined ? 0 : 1;
        if (aAd !== bAd)
            return aAd - bAd;
        if (a.depth !== b.depth)
            return a.depth - b.depth;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return {
        root,
        maxDepth,
        candidates,
        truncated,
        dirsVisited,
        elapsedMs: Date.now() - started,
    };
}
/** 收集候选的生成器线索（只读名字，不做内容分析）。 */
async function collectHints(dir, files, dirs, readdir) {
    const hints = { linkerScripts: [] };
    for (const f of files) {
        const name = basename(f);
        const low = name.toLowerCase();
        if (hints.ioc === undefined && low.endsWith('.ioc'))
            hints.ioc = relName(dir, f);
        else if (hints.atwp === undefined && low.endsWith('.atwp'))
            hints.atwp = relName(dir, f);
        else if (low.endsWith('.ld') && hints.linkerScripts.length < 4)
            hints.linkerScripts.push(relName(dir, f));
    }
    // 生成器目录：cmake/<gen>/CMakeLists.txt 存在。名字取自 dirs（已是绝对路径）。
    for (const d of dirs) {
        if (basename(d) !== 'cmake')
            continue;
        try {
            const kids = await readdir(d);
            for (const k of kids) {
                if (!k.isDirectory())
                    continue;
                try {
                    const grand = await readdir(joinPath(d, k.name));
                    if (grand.some((g) => g.isFile() && g.name === 'CMakeLists.txt')) {
                        hints.generatorDir = k.name;
                        break;
                    }
                }
                catch {
                    /* 忽略 */
                }
            }
        }
        catch {
            /* 忽略 */
        }
        if (hints.generatorDir !== undefined)
            break;
    }
    return hints;
}
// ── 小工具 ─────────────────────────────────────────────────────────
async function safeRead(readFile, p) {
    try {
        return await readFile(p);
    }
    catch {
        return '';
    }
}
function joinPath(a, b) {
    return a.endsWith('/') ? `${a}${b}` : `${a}/${b}`;
}
function basename(p) {
    const n = normalizePath(p);
    const i = n.lastIndexOf('/');
    return i < 0 ? n : n.slice(i + 1);
}
function relName(root, full) {
    const r = normalizePath(root);
    const f = normalizePath(full);
    return f.startsWith(`${r}/`) ? f.slice(r.length + 1) : f;
}
async function defaultReaddir(dir) {
    const fs = await import('node:fs/promises');
    return fs.readdir(dir, { withFileTypes: true });
}
async function defaultReadFile(p) {
    const fs = await import('node:fs/promises');
    return fs.readFile(p, 'utf8');
}
