/**
 * 盘点 #9：KNOWN_TOPICS 三处手工镜像的一致性守卫。
 *
 * 背景：SSE 必须按名 `addEventListener`（`onmessage` 收不到带 `event:` 的帧）。
 * 服务端新增 topic 而前端没同步时，那类事件会**静默丢失**——不报错、不停更提示，
 * 只表现为"某类事件再也不来了"。这是收尾阶段最阴的回归形态，值得一条测试。
 *
 * 守卫两件事：
 *   1. 前端 `icd.ts` 的 KNOWN_TOPICS ⊇ 内核 `events.py` 的 KNOWN_TOPICS
 *      ∪ 服务端 SSE 合成帧（`proc/stdout-batch` / `stream/closed`）；
 *   2. 插件自包含镜像 `domain/icd.ts` 与共享层 `icd.ts` 完全一致。
 *
 * （服务端 debug/* 已在前端列表里，但它们是独立信封、不在 events.py 的
 *   KNOWN_TOPICS 内，这里只校验 ⊇ 方向；多余的条目不失败——多订阅一个
 *   永不发生的事件无害，反而是"少一个"才致命。）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// test/ → dsh-elab-cockpit → packages → 仓库根（三级）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EVENTS_PY = path.join(ROOT, 'services', 'elab', 'kernel', 'events.py')
const ICD_TS = path.join(ROOT, 'packages', 'cockpit-ui-core', 'src', 'icd.ts')
const ICD_TS_MIRROR = path.join(ROOT, 'packages', 'dsh-elab-cockpit', 'src', 'domain', 'icd.ts')

/** 服务端合成（不在 events.py KNOWN_TOPICS 里，但 SSE 会发）的 topic。 */
const SERVER_SYNTHETIC = new Set(['proc/stdout-batch', 'stream/closed'])

/** events.py：常量名 → 字符串值（只认 `NAME = "..."` 形态，够用且不误伤）。 */
function pyConsts(src) {
  const consts = {}
  for (const m of src.matchAll(/^([A-Z][A-Z0-9_]+)\s*=\s*"([^"]+)"/gm)) {
    consts[m[1]] = m[2]
  }
  return consts
}

/** events.py 的 KNOWN_TOPICS（frozenset 块内全是常量名引用）。 */
function serverTopics(src) {
  const consts = pyConsts(src)
  const block = src.match(/KNOWN_TOPICS\s*=\s*frozenset\(\{([\s\S]*?)\}\)/)
  assert.ok(block, 'events.py 里找不到 KNOWN_TOPICS frozenset 块（结构变了？先改本测试）')
  const out = []
  for (const m of block[1].matchAll(/([A-Z][A-Z0-9_]*)/g)) {
    const name = m[1]
    assert.ok(name in consts,
      `events.py KNOWN_TOPICS 引用了未定义为字符串字面量的常量：${name}`)
    out.push(consts[name])
  }
  return new Set(out)
}

/** icd.ts 的 KNOWN_TOPICS（`export const KNOWN_TOPICS = [ ... ] as const`）。 */
function icdTopics(src, label) {
  const block = src.match(/export const KNOWN_TOPICS\s*=\s*\[([\s\S]*?)\]\s*as const;/)
  assert.ok(block, `${label} 里找不到 KNOWN_TOPICS 数组（结构变了？先改本测试）`)
  const out = []
  for (const m of block[1].matchAll(/"([^"]+)"/g)) out.push(m[1])
  assert.ok(out.length > 0, `${label} 的 KNOWN_TOPICS 解析结果为空`)
  return out
}

test('前端 KNOWN_TOPICS 覆盖内核 KNOWN_TOPICS ∪ 服务端合成帧（盘点 #9）', () => {
  const server = serverTopics(readFileSync(EVENTS_PY, 'utf8'))
  const front = new Set(icdTopics(readFileSync(ICD_TS, 'utf8'), 'cockpit-ui-core/icd.ts'))

  const missing = [...server, ...SERVER_SYNTHETIC].filter((t) => !front.has(t))
  assert.deepEqual(missing, [],
    `前端 KNOWN_TOPICS 缺少服务端会发的 topic：${missing.join(', ')} —— ` +
    'EventSource 按名订阅收不到未列出的 topic，事件会静默丢失。' +
    '请在 packages/cockpit-ui-core/src/icd.ts 与 domain/icd.ts 两处同步补上。')
})

test('插件自包含镜像 domain/icd.ts 与共享层 icd.ts 的 KNOWN_TOPICS 一致', () => {
  const shared = icdTopics(readFileSync(ICD_TS, 'utf8'), 'cockpit-ui-core/icd.ts')
  const mirror = icdTopics(readFileSync(ICD_TS_MIRROR, 'utf8'), 'domain/icd.ts')
  assert.deepEqual(mirror, shared,
    'domain/icd.ts 的 KNOWN_TOPICS 与共享层不一致 —— 镜像是刻意自包含的' +
    '（host 构建 rootDir 限制），改 topic 时必须两处一起改。')
})

test('events.py 的 KNOWN_TOPICS 每一项都能在 ICD 文档/常量定义中对上（防手滑拼写）', () => {
  // 轻量防线：topic 命名空间必须只落在已知前缀里 —— 新前缀 = 契约级变更，
  // 值得让人停下来想一下，而不是顺手加一行。
  const KNOWN_NS = new Set(['run/', 'proc/', 'serial/', 'stream/'])
  for (const t of serverTopics(readFileSync(EVENTS_PY, 'utf8'))) {
    const ns = [...KNOWN_NS].find((p) => t.startsWith(p))
    assert.ok(ns, `events.py 出现未知命名空间的 topic：${t} —— ` +
      '新命名空间是契约级变更，请同步 docs/ICD_cockpit_events.md。')
  }
})
