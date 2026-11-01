/**
 * Host 半 —— 按版本下载内核（tag 源码归档），多版本并存。
 *
 * 与「浅克隆」的关系：
 *   - `clone`   ：开发用，跟着 main 走（`git pull --ff-only` 可升级）；
 *   - `download`：**下载即用**，按 `vX.Y.Z` 拉 GitHub tag 源码归档解到
 *     `~/.dsh/elab/kernels/vX.Y.Z/`，不需要 git、可多版本并存。
 *
 * 只做下载 + 解压 + 定位根；"是不是 elab 仓库根"仍由调用方用
 * `looksLikeElabRoot` 判定（判据唯一真源在 kernel-process）。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import AdmZip from 'adm-zip'

import { isValidKernelVersion, kernelArchiveUrl } from '../../domain/envpack.ts'
import { downloadToFile, unwrapSingleDir } from './envpack.ts'

/** 内核源码仓（与 README / 市场同一事实源）。 */
export const ELAB_REPO = 'https://github.com/xkk6663/elab-flow'

export function kernelsRoot(): string {
  return join(homedir(), '.dsh', 'elab', 'kernels')
}

export type KernelDownloadResult =
  | { ok: true; dir: string; version: string }
  | { ok: false; code: string; message: string }

/**
 * 下载 `v<version>` 并解到 `~/.dsh/elab/kernels/v<version>/`。
 * 已存在则直接复用（幂等），不重复下载。
 */
export async function downloadKernelTag(
  version: string,
  repo: string = ELAB_REPO,
  onPhase?: (phase: 'download' | 'extract') => void,
): Promise<KernelDownloadResult> {
  const v = version.trim().replace(/^v/i, '')
  if (!isValidKernelVersion(v)) {
    return { ok: false, code: 'bad-version', message: `版本号形状不对：${version}（需 x.y 或 x.y.z）` }
  }
  const base = join(kernelsRoot(), `v${v}`)
  if (existsSync(base)) {
    const root = unwrapSingleDir(base)
    return { ok: true, dir: root, version: v }
  }

  mkdirSync(base, { recursive: true })
  const zip = join(base, 'kernel.zip')
  onPhase?.('download')
  const dl = await downloadToFile(kernelArchiveUrl(repo, v), zip)
  if (dl.ok === false) {
    rmSync(base, { recursive: true, force: true })
    return { ok: false, code: 'download-failed', message: `内核 v${v} 下载失败：${dl.error ?? '未知原因'}` }
  }
  onPhase?.('extract')
  try {
    new AdmZip(zip).extractAllTo(base, true)
  } catch (e) {
    rmSync(base, { recursive: true, force: true })
    return { ok: false, code: 'extract-failed', message: `内核 v${v} 解压失败：${String(e)}` }
  } finally {
    rmSync(zip, { force: true })
  }
  return { ok: true, dir: unwrapSingleDir(base), version: v }
}
