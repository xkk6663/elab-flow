/**
 * run-retention 单测：用真临时目录（清理是破坏性操作，必须真删才可信）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_RETENTION,
  isRunId,
  listRuns,
  planDeletion,
  runIdOf,
  runRetention,
} from '../src/host/run-retention.ts'

let ROOT
let seq = 0

before(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'elab-retention-'))
})

after(async () => {
  if (ROOT !== undefined) await rm(ROOT, { recursive: true, force: true })
})

/** 造一个 run 三件套，并指定 mtime。 */
async function makeRun(dir, id, ageDays) {
  await mkdir(dir, { recursive: true })
  const t = (Date.now() - ageDays * 86400_000) / 1000
  for (const suffix of ['.jsonl', '.proc.jsonl', '.log']) {
    const p = join(dir, `${id}${suffix}`)
    await writeFile(p, 'x'.repeat(100), 'utf8')
    await utimes(p, t, t)
  }
}

async function freshDir() {
  seq += 1
  const d = join(ROOT, `runs${seq}`)
  await mkdir(d, { recursive: true })
  return d
}

test('runIdOf 正确剥离 .proc.jsonl（不能得到 r-xxx.proc）', () => {
  assert.equal(runIdOf('r-0123abcd.jsonl'), 'r-0123abcd')
  assert.equal(runIdOf('r-0123abcd.proc.jsonl'), 'r-0123abcd')
  assert.equal(runIdOf('r-0123abcd.log'), 'r-0123abcd')
  assert.equal(runIdOf('NOTES.md'), undefined)
  assert.equal(runIdOf('r-jsonl'), undefined)
})

test('isRunId 只认 r-<字母数字>', () => {
  assert.equal(isRunId('r-09de17f4'), true)
  assert.equal(isRunId('r-'), false)
  assert.equal(isRunId('x-123'), false)
  assert.equal(isRunId('r-a/b'), false)
})

test('planDeletion：保留最近 N 个（年龄条件不干扰时）', () => {
  const now = Date.now()
  // ★ 规则是"三条取并集"：keepCount / keepDays / 容量，满足任意一条即保留。
  //   所以要验证"条数"，必须让旧记录确实超出 keepDays —— 否则全被"天数"保住。
  const recs = [0, 1, 2, 3, 4].map((i) => ({
    id: `r-${i}`,
    mtimeMs: now - (i + 1) * 30 * 86400_000, // 1..5 个月前
    bytes: 100,
    files: [],
  }))
  const { keep, remove } = planDeletion(
    recs,
    { ...DEFAULT_RETENTION, keepCount: 2, keepDays: 7, maxTotalBytes: 1e9 },
    [],
    now,
  )
  assert.deepEqual(keep.map((r) => r.id), ['r-0', 'r-1'])
  assert.deepEqual(remove.map((r) => r.id), ['r-2', 'r-3', 'r-4'])
})

test('planDeletion：条数以内即使很老也保留（并集语义）', () => {
  const now = Date.now()
  const recs = [0, 1, 2].map((i) => ({
    id: `r-${i}`,
    mtimeMs: now - (i + 1) * 100 * 86400_000,
    bytes: 100,
    files: [],
  }))
  const { keep } = planDeletion(
    recs,
    { ...DEFAULT_RETENTION, keepCount: 3, keepDays: 1, maxTotalBytes: 1e9 },
    [],
    now,
  )
  assert.equal(keep.length, 3)
})

test('planDeletion：保留 N 天内（即便超过条数）', () => {
  const now = Date.now()
  const recs = [
    { id: 'r-new', mtimeMs: now - 1000, bytes: 100, files: [] },
    { id: 'r-mid', mtimeMs: now - 3 * 86400_000, bytes: 100, files: [] },
    { id: 'r-old', mtimeMs: now - 30 * 86400_000, bytes: 100, files: [] },
  ]
  const { keep } = planDeletion(recs, { ...DEFAULT_RETENTION, keepCount: 1, keepDays: 7 }, [], now)
  assert.deepEqual(keep.map((r) => r.id), ['r-new', 'r-mid'])
})

test('planDeletion：豁免项永不删（即使超龄超量）', () => {
  const now = Date.now()
  const recs = [
    { id: 'r-live', mtimeMs: now - 99 * 86400_000, bytes: 100, files: [] },
    { id: 'r-dead', mtimeMs: now - 99 * 86400_000, bytes: 100, files: [] },
  ]
  const { keep, remove } = planDeletion(recs, { ...DEFAULT_RETENTION, keepCount: 0, keepDays: 1 }, ['r-live'], now)
  assert.deepEqual(keep.map((r) => r.id), ['r-live'])
  assert.deepEqual(remove.map((r) => r.id), ['r-dead'])
})

test('planDeletion：容量兜底从最旧删起', () => {
  const now = Date.now()
  const recs = [0, 1, 2, 3].map((i) => ({
    id: `r-${i}`,
    mtimeMs: now - i * 1000,
    bytes: 1000,
    files: [],
  }))
  const { keep, remove } = planDeletion(
    recs,
    { ...DEFAULT_RETENTION, keepCount: 99, keepDays: 999, maxTotalBytes: 2500 },
    [],
    now,
  )
  assert.equal(keep.length, 2)
  assert.ok(keep.reduce((s, r) => s + r.bytes, 0) <= 2500)
  assert.deepEqual(remove.map((r) => r.id), ['r-3', 'r-2'])
})

test('runRetention 真删：只删过期的，保留最新与豁免', async () => {
  const dir = await freshDir()
  await makeRun(dir, 'r-aaaa0001', 30) // 老
  await makeRun(dir, 'r-aaaa0002', 30) // 老
  await makeRun(dir, 'r-aaaa0003', 0) // 新（豁免：最近一次）
  const before = await readdir(dir)
  const res = await runRetention(
    dir,
    { keepCount: 1, keepDays: 7, maxTotalBytes: 1e9, dryRun: false },
    ['r-aaaa0001'],
  )
  const after = await readdir(dir)
  // r-aaaa0001 被 active 豁免；r-aaaa0003 是最新豁免；只剩 r-aaaa0002 该删
  assert.deepEqual(res.deleted, ['r-aaaa0002'])
  assert.equal(after.length, before.length - 3)
  assert.ok(after.some((f) => f.startsWith('r-aaaa0001')))
  assert.ok(after.some((f) => f.startsWith('r-aaaa0003')))
})

test('runRetention dryRun 不删任何文件', async () => {
  const dir = await freshDir()
  await makeRun(dir, 'r-bbbb0001', 30)
  await makeRun(dir, 'r-bbbb0002', 30)
  await makeRun(dir, 'r-bbbb0003', 0)
  const before = await readdir(dir)
  const res = await runRetention(dir, { keepCount: 1, keepDays: 1, maxTotalBytes: 1, dryRun: true })
  assert.equal(res.deleted.length, 0)
  assert.equal((await readdir(dir)).length, before.length)
})

test('非 run 文件（stray）绝不删除', async () => {
  const dir = await freshDir()
  await makeRun(dir, 'r-cccc0001', 30)
  await makeRun(dir, 'r-cccc0002', 0)
  await writeFile(join(dir, 'NOTES.md'), 'keep me', 'utf8')
  await runRetention(dir, { keepCount: 1, keepDays: 1, maxTotalBytes: 1e9, dryRun: false })
  const after = await readdir(dir)
  assert.ok(after.includes('NOTES.md'))
})

test('listRuns 按 mtime 降序，且 .proc.jsonl 不计入 run 数', async () => {
  const dir = await freshDir()
  await makeRun(dir, 'r-dddd0001', 2)
  await makeRun(dir, 'r-dddd0002', 1)
  const { records } = await listRuns(dir)
  assert.deepEqual(records.map((r) => r.id), ['r-dddd0002', 'r-dddd0001'])
  assert.equal(records.length, 2)
  assert.equal(records[0].files.length, 3)
})

test('目录不存在时静默返回空', async () => {
  const res = await runRetention(join(ROOT, 'nope'), DEFAULT_RETENTION)
  assert.equal(res.scanned, 0)
  assert.equal(res.deleted.length, 0)
})
