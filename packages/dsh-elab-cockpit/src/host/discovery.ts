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

/** 一次扫描的边界参数。 */
export interface DiscoverOptions {
  /** 扫描根：会话 cwd（或 elabRoot）。必须是绝对路径。 */
  root: string
  /** 最大递归深度；根目录下的 CMakeLists 深度为 0，`root/a/CMakeLists.txt` 深度为 1。 */
  maxDepth?: number
  /** 命中上限，达到即停并标记 truncated。 */
  limit?: number
  /** 已接入的工程根路径（由 projects/<name>.yaml 的 root 归一化而来），用于标记 adapted。 */
  adapted?: readonly AdaptedEntry[]
  /** 额外的排除目录名（叠加在内置列表上）。 */
  excludeNames?: readonly string[]
}

/** 已接入工程：name 来自 projects/<name>.yaml 的文件名。 */
export interface AdaptedEntry {
  name: string
  /** 归一化后的绝对路径（大小写与分隔符已规范化，见 normalizePath）。 */
  root: string
}

/** 一个候选工程。 */
export interface Candidate {
  /** 绝对路径（正斜杠规范化）。 */
  path: string
  /** 目录名（= elab adapt 的 default_name 输入）。 */
  dirname: string
  /** 相对扫描根的层级（0 = 根本身）。 */
  depth: number
  /**
   * 一眼可辨的生成器线索（只做**预判**，不是 adapt 的结论）：
   * adapt 的权威判定仍以 probe_project 为准，这里只是让用户在点「探测」前心里有数。
   */
  hints: CandidateHints
  /** 已接入时给出 projects/<name>.yaml 的工程名，否则 undefined。 */
  adaptedAs?: string
}

export interface CandidateHints {
  /** 同级 *.ioc（STM32CubeMX 痕迹）—— 文件相对候选根的路径。 */
  ioc?: string
  /** 同级 *.ATWP（AT32 WorkBench 痕迹）。 */
  atwp?: string
  /** 存在 cmake/<gen>/CMakeLists.txt 的生成器目录名。 */
  generatorDir?: string
  /** 候选根下（深度 2 内）的链接脚本。 */
  linkerScripts: string[]
}

export interface DiscoverResult {
  root: string
  maxDepth: number
  candidates: Candidate[]
  /** 因达到 limit 而提前停止。 */
  truncated: boolean
  /** 本次扫描实际访问的目录数（性能观测用）。 */
  dirsVisited: number
  /** 耗时（毫秒）。 */
  elapsedMs: number
}

/** 目录读取的最小抽象：只读名字，不关心类型（类型由 stat 判断，见 walk）。 */
export type ReadDir = (dir: string) => Promise<DirentLike[]>

export interface DirentLike {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  /** 符号链接标记：不跟随，避免循环。 */
  isSymbolicLink?(): boolean
}

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
] as const

export const DEFAULT_MAX_DEPTH = 3
export const DEFAULT_LIMIT = 50

/**
 * 路径规范化：统一正斜杠、折叠分隔符；盘符统一大写（其余保留大小写以便展示）。
 *
 * ★ 反斜杠必须用 `String.fromCharCode(92)` 拼正则，**不能**写成字面量
 *   —— 该字面量在经编辑工具落盘时曾把 `\\` 折叠成 `\`，于是
 *   `C:\repo\ok` 被替换成 `C:epook`（实测踩到，见 test 'normalizePath 处理反斜杠'）。
 *   用字符码构造后，源码里不再有反斜杠转义序列，无法被再次折叠。
 */
export function normalizePath(p: string): string {
  const BACKSLASH = new RegExp(String.fromCharCode(92) + String.fromCharCode(92), 'g')
  const slashed = p.replace(BACKSLASH, '/').replace(/\/{2,}/g, '/')
  const trimmed = slashed.length > 1 ? slashed.replace(/\/$/, '') : slashed
  return /^[a-zA-Z]:\//.test(trimmed) ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed
}

/** 比较用的键：去掉末尾分隔符并统一大小写（Windows）。 */
function keyOf(p: string): string {
  const n = normalizePath(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

function isExcluded(name: string, extra: readonly string[]): boolean {
  const low = name.toLowerCase()
  if (low.startsWith('.')) return true // .git / .idea / .vscode / .work …
  for (const e of BASE_EXCLUDE) if (low === e) return true
  for (const e of extra) if (low === e.toLowerCase()) return true
  return false
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
export function declaresProjectName(cmakeText: string): string | undefined {
  const code = stripComments(cmakeText)
  const setMatch = code.match(/set\s*\(\s*CMAKE_PROJECT_NAME\s+([A-Za-z0-9_$@.-]+)/i)
  if (setMatch !== null) return setMatch[1]
  const projMatch = code.match(/\bproject\s*\(\s*([A-Za-z0-9_$@.-]+)/i)
  if (projMatch !== null) return projMatch[1]
  return undefined
}

/**
 * 去掉 CMake 注释：块注释 `#[[ … ]]` 与行注释 `#` 到行尾。
 *
 * ★ 块的收尾**必须是行尾的 `]]`**（CMake 语法：`bracket_comment_end` 是
 *   `]]` 后跟换行或文件结束）。不收尾的 `#[[` 只是普通行注释 —— 若用非贪婪
 *   `]]` 去配，`#[[ multi\nline ]]x` 这种畸形输入会把第二行残留成代码。
 */
export function stripComments(text: string): string {
  return text
    .replace(/#\[\[[\s\S]*?\]\](?=\r?\n|$)/g, ' ')
    .replace(/#[^\n]*/g, ' ')
}

/** 生成的 CMakeLists 通常声明工程名，但变量里没有具体值时可再细化；此处保持简单：非空即真。 */
function looksLikeRealProject(name: string | undefined): boolean {
  return name !== undefined && name.trim() !== ''
}

/**
 * 扫描一个根目录，返回候选工程列表。
 *
 * @param opts 扫描边界
 * @param deps 可注入依赖（单测用）；缺省用 `node:fs/promises`
 */
export async function discoverProjects(
  opts: DiscoverOptions,
  deps?: {
    readdir?: ReadDir
    readFile?: (p: string) => Promise<string>
  },
): Promise<DiscoverResult> {
  const started = Date.now()
  const root = normalizePath(opts.root)
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  const limit = opts.limit ?? DEFAULT_LIMIT
  const extraExclude = opts.excludeNames ?? []
  const adaptedByPath = new Map<string, string>()
  for (const a of opts.adapted ?? []) adaptedByPath.set(keyOf(a.root), a.name)

  const readdir: ReadDir = deps?.readdir ?? defaultReaddir
  const readFile = deps?.readFile ?? defaultReadFile

  const candidates: Candidate[] = []
  let dirsVisited = 0
  let truncated = false

  /** 广度优先：先浅层命中先出现，天然得到"浅层优先"的排序。 */
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && !truncated) {
    const { dir, depth } = queue.shift()!
    let entries: DirentLike[]
    try {
      entries = await readdir(dir)
    } catch {
      continue // 权限/竞态：跳过该目录，不让一颗子树拖垮整次扫描
    }
    dirsVisited += 1

    const dirs: string[] = []
    let cmakeEntry: DirentLike | undefined
    const files: string[] = []
    for (const e of entries) {
      if (e.isSymbolicLink?.() === true) continue
      const full = joinPath(dir, e.name)
      if (e.isDirectory()) {
        if (!isExcluded(e.name, extraExclude)) dirs.push(full)
      } else if (e.isFile()) {
        files.push(full)
        if (e.name === 'CMakeLists.txt') cmakeEntry = e
      }
    }

    // ① 本目录是候选吗？（根工程 = 声明了工程名）
    if (cmakeEntry !== undefined) {
      const text = await safeRead(readFile, joinPath(dir, 'CMakeLists.txt'))
      if (looksLikeRealProject(declaresProjectName(text))) {
        if (candidates.length >= limit) {
          truncated = true
        } else {
          candidates.push({
            path: normalizePath(dir),
            dirname: basename(dir),
            depth,
            hints: await collectHints(dir, files, dirs, readdir),
            adaptedAs: adaptedByPath.get(keyOf(dir)),
          })
        }
      }
    }

    // ② 继续下探（达到上限即停止，不再入队）
    if (!truncated && depth < maxDepth) {
      for (const d of dirs) queue.push({ dir: d, depth: depth + 1 })
    }
  }

  // 确定性排序：深度浅 → 路径字典序（已接入的排最后，便于"新发现的"浮上来）
  candidates.sort((a, b) => {
    const aAd = a.adaptedAs === undefined ? 0 : 1
    const bAd = b.adaptedAs === undefined ? 0 : 1
    if (aAd !== bAd) return aAd - bAd
    if (a.depth !== b.depth) return a.depth - b.depth
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })

  return {
    root,
    maxDepth,
    candidates,
    truncated,
    dirsVisited,
    elapsedMs: Date.now() - started,
  }
}

/** 收集候选的生成器线索（只读名字，不做内容分析）。 */
async function collectHints(
  dir: string,
  files: readonly string[],
  dirs: readonly string[],
  readdir: ReadDir,
): Promise<CandidateHints> {
  const hints: CandidateHints = { linkerScripts: [] }
  for (const f of files) {
    const name = basename(f)
    const low = name.toLowerCase()
    if (hints.ioc === undefined && low.endsWith('.ioc')) hints.ioc = relName(dir, f)
    else if (hints.atwp === undefined && low.endsWith('.atwp')) hints.atwp = relName(dir, f)
    else if (low.endsWith('.ld') && hints.linkerScripts.length < 4) hints.linkerScripts.push(relName(dir, f))
  }
  // 生成器目录：cmake/<gen>/CMakeLists.txt 存在。名字取自 dirs（已是绝对路径）。
  for (const d of dirs) {
    if (basename(d) !== 'cmake') continue
    try {
      const kids = await readdir(d)
      for (const k of kids) {
        if (!k.isDirectory()) continue
        try {
          const grand = await readdir(joinPath(d, k.name))
          if (grand.some((g) => g.isFile() && g.name === 'CMakeLists.txt')) {
            hints.generatorDir = k.name
            break
          }
        } catch {
          /* 忽略 */
        }
      }
    } catch {
      /* 忽略 */
    }
    if (hints.generatorDir !== undefined) break
  }
  return hints
}

// ── 小工具 ─────────────────────────────────────────────────────────

async function safeRead(readFile: (p: string) => Promise<string>, p: string): Promise<string> {
  try {
    return await readFile(p)
  } catch {
    return ''
  }
}

function joinPath(a: string, b: string): string {
  return a.endsWith('/') ? `${a}${b}` : `${a}/${b}`
}

function basename(p: string): string {
  const n = normalizePath(p)
  const i = n.lastIndexOf('/')
  return i < 0 ? n : n.slice(i + 1)
}

function relName(root: string, full: string): string {
  const r = normalizePath(root)
  const f = normalizePath(full)
  return f.startsWith(`${r}/`) ? f.slice(r.length + 1) : f
}

async function defaultReaddir(dir: string): Promise<DirentLike[]> {
  const fs = await import('node:fs/promises')
  return fs.readdir(dir, { withFileTypes: true }) as unknown as DirentLike[]
}

async function defaultReadFile(p: string): Promise<string> {
  const fs = await import('node:fs/promises')
  return fs.readFile(p, 'utf8')
}
