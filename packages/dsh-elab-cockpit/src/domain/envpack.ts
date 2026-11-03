/**
 * 「一键环境包」清单 —— 纯函数，零 I/O。
 *
 * 插件瘦：**不内置任何工具二进制**，只内置一份清单（`envpacks/manifest.json`），
 * 记录每个工具的官方上游直链、sha256、解压后要注入的环境变量。
 * 下载/校验/解压/探测全在适配器层（`adapters/env/envpack.ts`）。
 *
 * 注入约定：内核侧 L0 主机视图支持 `ELAB_CMAKE` / `ELAB_NINJA` / `ELAB_OPENOCD`
 * / `ELAB_OPENOCD_SCRIPTS` / `ELAB_ARM_GCC_ROOT` 环境变量覆盖（见内核
 * `services/elab/config.py` 的 `Host`），所以环境包**不改**仓库里的 elab.host.yaml。
 */

export interface EnvToolSpec {
  id: string
  label: string
  /** 上游发布版本号（人类可读，也用于"已装且版本一致就跳过"）。 */
  version: string
  /** 官方上游直链（https）。 */
  url: string
  /** 期望的内容哈希；空 = 首次下载时记录（TOFU），并给出警告。 */
  sha256: string
  /** 下载体积提示（MB），仅用于 UI 预估。 */
  sizeHintMB?: number
  /** 解压后要注入的环境变量；`${root}` = 该工具的解压根。 */
  env: Record<string, string>
  /** 需要前置进 PATH 的相对目录（相对 `${root}`）。 */
  path: string[]
  /** 版本探测：相对可执行 + 参数（失败只警告，不让安装失败）。 */
  probe?: [string, ...string[]]
}

export interface EnvPackSpec {
  /** 平台键，如 `win32-x64`。 */
  id: string
  label: string
  platform: { os: string; arch: string }
  tools: EnvToolSpec[]
}

export interface EnvPackManifest {
  schema: number
  packs: EnvPackSpec[]
}

/** 当前运行平台的键（Node 的 `process.platform` / `process.arch` 口径）。 */
export function platformKey(os: string, arch: string): string {
  return `${os}-${arch}`
}

/** 在清单里找当前平台的包；没有则 null（UI 显示"暂无此平台环境包"）。 */
export function findPack(manifest: EnvPackManifest | null, key: string): EnvPackSpec | null {
  if (manifest === null) return null
  return manifest.packs.find((p) => p.id === key) ?? null
}

/** `${root}` 展开成该工具的解压目录（正斜杠，与内核路径口径一致）。 */
export function expandTemplate(value: string, root: string): string {
  return value.split('${root}').join(root)
}

/** 一个工具要注入的环境变量（宿主侧 spawn 用）。 */
export function toolEnv(spec: EnvToolSpec, root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(spec.env)) out[k] = expandTemplate(v, root)
  return out
}

/** 一个工具要前置进 PATH 的绝对目录。 */
export function toolPathDirs(spec: EnvToolSpec, root: string): string[] {
  return spec.path.map((rel) => (rel === '' || rel === '.' ? root : `${root}/${rel}`))
}

/** 合并整包的环境变量（工具间互不覆盖；同键后者胜）。 */
export function packEnv(pack: EnvPackSpec, roots: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of pack.tools) {
    const root = roots[t.id]
    if (root === undefined) continue
    Object.assign(out, toolEnv(t, root))
  }
  return out
}

/** 合并整包的 PATH 目录。 */
export function packPathDirs(pack: EnvPackSpec, roots: Record<string, string>): string[] {
  const out: string[] = []
  for (const t of pack.tools) {
    const root = roots[t.id]
    if (root === undefined) continue
    out.push(...toolPathDirs(t, root))
  }
  return out
}

/**
 * 首次启动自动准备的内核版本（固定版本，不跟 main 走）。
 * 与 `MIN_KERNEL_VERSION`（插件能接受的最低版本）不是同一件事：这个版本号
 * 决定"零前置下载哪一个 tag"；UI 与宿主半共用同一常量，避免文案/请求漂移。
 */
export const DEFAULT_KERNEL_VERSION = '3.1.0'

/** 内核下载归档的 URL（GitHub tag 源码归档，与内核仓同源）。 */
export function kernelArchiveUrl(repo: string, version: string): string {
  return `${repo.replace(/\.git$/, '')}/archive/refs/tags/v${version}.zip`
}

/** 内核版本号允许的形状（只接受 `x.y` / `x.y.z`，避免把任意字符串拼进 URL）。 */
export function isValidKernelVersion(version: string): boolean {
  return /^[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)
}
