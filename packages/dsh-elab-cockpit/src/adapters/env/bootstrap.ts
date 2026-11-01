/**
 * Host 半 —— 引导写动作（`POST /elab/bootstrap`）：**只做两件事**。
 *
 *   `set-root`：校验指定目录确实是 elab 仓库根 → 写配置（不克隆）；
 *   `clone`   ：浅克隆一个 https 仓库到**空目录** → 校验 → 写配置。
 *
 * 纪律（方案 §3.7）：
 *   不静默写盘（clone 必须 `confirm:true`）、不执行任意命令（git 只用固定参数，
 *   url 必须是 https）、不覆盖用户已有检出（目标目录必须不存在或为空）。
 *   拉取更新（pull）**不在这里执行** —— UI 只给可复制命令。
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'

/** 根判据由组装点注入（唯一真源 = kernel-process 的 `looksLikeElabRoot`）。 */
export type RootPredicate = (dir: string) => boolean

export type BootstrapRequest =
  | { action: 'set-root'; dir: string }
  | { action: 'clone'; url: string; dir: string }

export type BootstrapValidation =
  | { ok: true; request: BootstrapRequest }
  | { ok: false; code: string; message: string }

/** 目录不存在或为空（避免覆盖用户已有内容）。 */
function isAbsentOrEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true
  try {
    return readdirSync(dir).length === 0
  } catch {
    return false
  }
}

/**
 * 校验 `POST /elab/bootstrap` 的请求体。返回 `ok:false` 时带人话错误码，
 * 宿主直接 400 回显（不抛异常）。
 */
export function validateBootstrapRequest(
  body: unknown,
  isElabRoot: RootPredicate,
): BootstrapValidation {
  if (body === null || typeof body !== 'object') {
    return { ok: false, code: 'bad-request', message: '请求体必须是 JSON 对象' }
  }
  const b = body as Record<string, unknown>
  const action = typeof b.action === 'string' ? b.action : ''
  if (action === 'set-root') {
    if (typeof b.dir !== 'string' || !isAbsolute(b.dir)) {
      return { ok: false, code: 'bad-dir', message: 'dir 必须是绝对路径' }
    }
    const dir = normalize(b.dir.trim())
    if (!isElabRoot(dir)) {
      return {
        ok: false,
        code: 'not-elab-root',
        message: '该目录不是 elab 仓库根（需同时包含 cockpit/server.py 与 services/elab）',
      }
    }
    return { ok: true, request: { action: 'set-root', dir } }
  }
  if (action === 'clone') {
    if (b.confirm !== true) {
      return { ok: false, code: 'confirm-required', message: '克隆会写盘，需要 confirm:true' }
    }
    if (typeof b.url !== 'string' || !/^https:\/\/[^/\s]+/.test(b.url.trim())) {
      return { ok: false, code: 'bad-url', message: '只允许 https:// 仓库地址' }
    }
    if (typeof b.dir !== 'string' || !isAbsolute(b.dir)) {
      return { ok: false, code: 'bad-dir', message: 'dir 必须是绝对路径' }
    }
    const dir = normalize(b.dir.trim())
    if (!isAbsentOrEmpty(dir)) {
      return {
        ok: false,
        code: 'dir-not-empty',
        message: '目标目录已存在且非空（为避免覆盖已有检出，请换一个空目录）',
      }
    }
    return { ok: true, request: { action: 'clone', url: b.url.trim(), dir } }
  }
  return { ok: false, code: 'unknown-action', message: `不支持的 action：${action || '(空)'}` }
}

export interface CloneResult {
  ok: boolean
  stdout?: string
  error?: string
}

/** 浅克隆（固定参数 `clone --depth 1`；url 已校验为 https）。 */
export function cloneKernel(url: string, dir: string, timeoutMs = 180_000): Promise<CloneResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['clone', '--depth', '1', url, dir],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 },
      (error, stdout, stderr) => {
        const text = `${String(stdout ?? '')}${String(stderr ?? '')}`.trim()
        if (error !== null) {
          resolve({ ok: false, error: text !== '' ? text.slice(-800) : error.message })
          return
        }
        resolve({ ok: true, stdout: text.slice(-400) })
      },
    )
  })
}
