/**
 * runs 自动清理（Q19）—— 无需人工干预的留存策略。
 *
 * 安全性依据（源码实读 2026-10-26）：
 *   `runs/` 是**纯平铺**目录：`r-<id>.jsonl` + `r-<id>.proc.jsonl` + `r-<id>.log`，
 *   **没有任何索引文件**；`kernel/events.py:523-538` 的 `list_runs()` 靠
 *   "文件名 + 首尾事件"重建元数据 —— 所以删掉任意历史 run 都不会破坏一致性。
 *
 * 保留策略（三条规则取并集 = 满足任意一条即保留）：
 *   ① 最近 `keepCount` 个
 *   ② `keepDays` 天内
 *   ③ 总容量不超过 `maxTotalBytes`（超出时从最旧开始删到阈值以下）
 * 豁免（永不删）：活动 run（`/api/runs.active`）+ 最近一次 run + 本次 SSE 正在跟读的 run。
 *
 * 红线：只删**同时存在且能配对**的三件套；任何一条判断不通过就跳过并记 warn。
 */

import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface RetentionConfig {
  /** 保留最近多少个 run。 */
  keepCount: number
  /** 保留多少天内的 run。 */
  keepDays: number
  /** 目录总容量上限（字节）。 */
  maxTotalBytes: number
  /** 干跑：只算不删（排查用）。 */
  dryRun: boolean
}

export const DEFAULT_RETENTION: RetentionConfig = {
  keepCount: 200,
  keepDays: 14,
  maxTotalBytes: 50 * 1024 * 1024,
  dryRun: false,
}

/** 一个 run 的三件套。 */
export interface RunRecord {
  id: string
  /** 主事件文件 mtime（ms）。 */
  mtimeMs: number
  bytes: number
  /** 实际存在的文件（缺失的不会去删）。 */
  files: string[]
}

export interface RetentionResult {
  scanned: number
  deleted: string[]
  kept: number
  freedBytes: number
  dryRun: boolean
  /** 被豁免的 run id（活动/最近一次）。 */
  exempted: string[]
}

/** run id 形如 `r-0123abcd`；只认这种名字，绝不碰异常文件。 */
export function isRunId(id: string): boolean {
  if (!id.startsWith('r-')) return false
  const body = id.slice(2)
  return body.length > 0 && body.length <= 32 && /^[0-9a-z]+$/i.test(body)
}

/** 从文件名解析 run id；不是 run 文件返回 undefined。 */
export function runIdOf(name: string): string | undefined {
  // 先处理 `.proc.jsonl`，否则会得到 `r-xxx.proc`（events.py 里踩过的同类坑）
  let stem: string
  if (name.endsWith('.proc.jsonl')) stem = name.slice(0, -'.proc.jsonl'.length)
  else if (name.endsWith('.jsonl')) stem = name.slice(0, -'.jsonl'.length)
  else if (name.endsWith('.log')) stem = name.slice(0, -'.log'.length)
  else return undefined
  return isRunId(stem) ? stem : undefined
}

/**
 * 列出目录里的全部 run（按 mtime 降序，最新在前）。
 *
 * @param activeIds 活动 run（豁免）
 */
export async function listRuns(
  runsDir: string,
  activeIds: readonly string[] = [],
): Promise<{ records: RunRecord[]; stray: string[] }> {
  let names: string[]
  try {
    names = await readdir(runsDir)
  } catch {
    return { records: [], stray: [] }
  }
  const byId = new Map<string, RunRecord>()
  const stray: string[] = []
  for (const name of names) {
    const id = runIdOf(name)
    if (id === undefined) {
      // 非 run 文件（例如手工放的 NOTES.md）只报告，不删除
      stray.push(name)
      continue
    }
    const full = join(runsDir, name)
    try {
      const st = await stat(full)
      if (!st.isFile()) continue
      const rec = byId.get(id) ?? { id, mtimeMs: 0, bytes: 0, files: [] }
      rec.files.push(full)
      rec.bytes += st.size
      // run 的时间以主事件文件为准；缺失时退化为任意文件的最大 mtime
      if (name.endsWith('.jsonl') && !name.endsWith('.proc.jsonl')) {
        rec.mtimeMs = st.mtimeMs
      } else if (rec.mtimeMs === 0) {
        rec.mtimeMs = st.mtimeMs
      }
      byId.set(id, rec)
    } catch {
      /* 竞态：文件刚被删，忽略 */
    }
  }
  const records = [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
  void activeIds
  return { records, stray }
}

/**
 * 计算应删除的 run（纯函数，便于单测）。
 *
 * @param records 按 mtime **降序**（最新在前）
 */
export function planDeletion(
  records: readonly RunRecord[],
  cfg: RetentionConfig,
  exemptIds: readonly string[] = [],
  nowMs: number = Date.now(),
): { keep: RunRecord[]; remove: RunRecord[] } {
  const exempt = new Set(exemptIds)
  const keep: RunRecord[] = []
  const remove: RunRecord[] = []
  const cutoff = nowMs - cfg.keepDays * 24 * 60 * 60 * 1000

  records.forEach((rec, index) => {
    if (exempt.has(rec.id) || index < cfg.keepCount || rec.mtimeMs >= cutoff) {
      keep.push(rec)
    } else {
      remove.push(rec)
    }
  })

  // 容量兜底：仍然从**最旧**的 keep 里继续删，直到总容量达标。
  // 豁免项永远不动（否则可能删掉正在看的 run）。
  let total = keep.reduce((s, r) => s + r.bytes, 0)
  if (total > cfg.maxTotalBytes) {
    for (let i = keep.length - 1; i >= 0 && total > cfg.maxTotalBytes; i -= 1) {
      const rec = keep[i]
      if (exempt.has(rec.id)) continue
      remove.push(rec)
      keep.splice(i, 1)
      total -= rec.bytes
    }
  }
  return { keep, remove }
}

/**
 * 执行一次清理。
 *
 * @param activeIds 活动 run（来自 `/api/runs.active`）
 * @param pinnedIds 额外豁免（当前正在 SSE 跟读的 run）
 */
export async function runRetention(
  runsDir: string,
  cfg: RetentionConfig = DEFAULT_RETENTION,
  activeIds: readonly string[] = [],
  pinnedIds: readonly string[] = [],
): Promise<RetentionResult> {
  const { records } = await listRuns(runsDir, activeIds)
  // 最近一次永远豁免（用户很可能正要回看它）
  const newest = records[0]?.id
  const exempt = [...new Set([...activeIds, ...pinnedIds, ...(newest === undefined ? [] : [newest])])]
  const { remove } = planDeletion(records, cfg, exempt)

  const deleted: string[] = []
  let freedBytes = 0
  if (!cfg.dryRun) {
    for (const rec of remove) {
      let ok = true
      for (const file of rec.files) {
        try {
          await unlink(file)
        } catch (error) {
          // 单个文件失败不中断整轮；但绝不算"删成功"
          ok = false
          void error
        }
      }
      if (ok) {
        deleted.push(rec.id)
        freedBytes += rec.bytes
      }
    }
  }
  return {
    scanned: records.length,
    deleted,
    kept: records.length - deleted.length,
    freedBytes,
    dryRun: cfg.dryRun,
    exempted: exempt,
  }
}
