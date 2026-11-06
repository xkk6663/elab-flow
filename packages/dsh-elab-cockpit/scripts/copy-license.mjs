/**
 * 把仓库根的 LICENSE / NOTICE 复制到插件包根，供 npm 包携带。
 *
 * ★ 为什么必须带：Apache-2.0 §4(d) 要求「再分发时必须携带 NOTICE」。
 *   npm 只会自动带上包根的 README 与 LICENSE，**NOTICE 不在自动名单里**
 *   （npm 的 files 数组不写它，它就不会进 tarball）—— 所以两件事都要做：
 *     ① 复制到包根（LICENSE 走 npm 自动通道，NOTICE 走 files 数组）；
 *     ② package.json#files 里显式列 "NOTICE"。
 *
 * ★ 为什么不入库而要生成：仓库根是唯一事实源。两份手抄的副本迟早漂移，
 *   而漂移的许可证声明比没有更糟。这里改成**打包时从根复制**，
 *   生成的副本被 .gitignore 排除，不入库、不漂移。
 *
 * ★ 触发时机：npm 生命周期里 `prepack` 在 `npm pack` / `npm publish` 之前跑，
 *   所以发布出来的包一定带着当次的 LICENSE / NOTICE。
 */
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pkgRoot, '..', '..')

const FILES = ['LICENSE', 'NOTICE']

let copied = 0
for (const name of FILES) {
  const src = join(repoRoot, name)
  const dst = join(pkgRoot, name)
  if (!existsSync(src)) {
    // 独立检出插件目录（没有仓库根）时跳过，不阻断打包。
    console.warn(`[copy-license] 仓库根没有 ${name}，跳过（插件包将不带该文件）`)
    continue
  }
  copyFileSync(src, dst)
  copied += 1
}

console.log(`[copy-license] 已复制 ${copied}/${FILES.length} 个文件到插件包根`)
