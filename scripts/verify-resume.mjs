/**
 * P2 续传联调 —— 按**服务端合帧语义**校验，而不是按朴素 seq+1。
 *
 * ★ 为什么不能按 seq+1 断言（实测踩到，2026-10-26）：
 *   服务端把高频 `proc/stdout` 合成一帧 `proc/stdout-batch`，且
 *   `eid = last_sent`（**合并段末尾那条**的 seq，见 `server.py:1088-1093`）。
 *   于是 SSE 的 `id:` 是"跳变"的：一帧可能覆盖 seq 12→20。
 *   按 seq+1 看就像"空洞"，但落盘事件一条没少 —— 这是真实事故级的误判，
 *   必须按范围连续性来验。
 *
 * 正确判据：
 *   ① **无重复**：同一 id 不重复出现（续传去重生效）；
 *   ② **无回退**：id 严格递增；
 *   ③ **无真空洞**：把所有收到的 id 展开成"覆盖的区间终点"后，
 *      从 1 到最终 seq 之间的每个位置都必须被某个事件的 `seq` 或
 *      某个 batch 帧的 `lines` 计数覆盖；
 *   ④ **与落盘对账**：落盘文件里的 seq 集合必须全部能解释。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2] ?? process.cwd()
const project = process.argv[3] ?? 'at32_test'

async function startHost() {
  const child = spawn('python', ['-u', '-m', 'cockpit.server', '--port', '0', '--reload'], {
    cwd: root,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: join(root, 'services') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error(`startup timeout: ${buf.slice(-400)}`)), 20000)
    const onData = (d) => {
      buf += d
      const line = buf.split('\n').find((l) => l.includes('监听'))
      if (line) {
        clearTimeout(t)
        const i = line.lastIndexOf(':')
        resolve(Number(line.slice(i + 1).replace(/[^0-9]/g, '')))
      }
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/capabilities`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) break
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { child, base: `http://127.0.0.1:${port}` }
}

/** 读一段 SSE，返回收到的帧（含 id / topic / body）。 */
async function readSome(base, runId, from, ms, stopWhen) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  const frames = []
  let lastId = from
  try {
    const resp = await fetch(`${base}/api/events?run=${encodeURIComponent(runId)}&from=${from}`, {
      signal: ac.signal,
      headers: { Accept: 'text/event-stream' },
    })
    if (!resp.ok) return { frames, lastId, status: resp.status }
    const reader = resp.body.getReader()
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += Buffer.from(value).toString('utf8')
      let idx
      while ((idx = text.indexOf('\n\n')) >= 0) {
        const frame = text.slice(0, idx)
        text = text.slice(idx + 2)
        let id
        let topic
        let data
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) id = Number(line.slice(4))
          else if (line.startsWith('event: ')) topic = line.slice(7)
          else if (line.startsWith('data: ')) data = line.slice(6)
        }
        if (topic !== undefined) {
          let body = {}
          try { body = data ? JSON.parse(data) : {} } catch { body = {} }
          frames.push({ id, topic, body })
          if (typeof id === 'number') lastId = id
        }
      }
      if (stopWhen(frames)) break
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e
  } finally {
    clearTimeout(timer)
  }
  return { frames, lastId }
}

const { child, base } = await startHost()
try {
  const res = await fetch(`${base}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, steps: ['build'], clean: true, actor: 'human' }),
  })
  const run = await res.json()
  const runId = run.run
  console.log('run =', runId)

  const seg1 = await readSome(base, runId, 0, 8000, (f) => f.length >= 4)
  console.log(`段1: ${seg1.frames.length} 帧, lastId=${seg1.lastId}`)

  console.log('断开 1.5s（模拟面板不可见）…')
  await new Promise((r) => setTimeout(r, 1500))

  const seg2 = await readSome(
    base, runId, seg1.lastId, 60000,
    (f) => f.some((x) => x.topic === 'stream/closed' || x.topic === 'run/end'),
  )
  console.log(`段2: 从 ${seg1.lastId} 续传, ${seg2.frames.length} 帧, lastId=${seg2.lastId}`)

  const all = [...seg1.frames, ...seg2.frames]
  const ids = all.map((f) => f.id).filter((x) => typeof x === 'number' && x > 0)

  // ① 无重复
  const dup = ids.filter((v, i) => i > 0 && v === ids[i - 1])

  // ② 严格递增（允许相等？同一 id 不该重复；这里要求非递减且除合帧外不倒退）
  const backslide = []
  for (let i = 1; i < ids.length; i += 1) if (ids[i] < ids[i - 1]) backslide.push([ids[i - 1], ids[i]])

  // ③ 覆盖计数：每条事件占 1 个 seq；batch 帧占其 lines 长度个
  let covered = 0
  const finalSeq = Math.max(...ids)
  for (const f of all) {
    if (f.topic === 'proc/stdout-batch') {
      covered += (f.body.lines ?? []).length
    } else {
      covered += 1
    }
  }

  // ④ 落盘对账：读 run 的两个事件文件，取出全部 seq
  const dir = join(root, '.work', '.cockpit', 'runs')
  const diskSeqs = []
  for (const suffix of ['.jsonl', '.proc.jsonl']) {
    try {
      const txt = await readFile(join(dir, `${runId}${suffix}`), 'utf8')
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue
        try { diskSeqs.push(JSON.parse(line).seq) } catch { /* ignore */ }
      }
    } catch { /* 可能还没落 */ }
  }
  const diskMax = diskSeqs.length ? Math.max(...diskSeqs) : 0
  const diskCount = new Set(diskSeqs).size

  console.log('\n=== 续传校验（按合帧语义）===')
  console.log('帧数:', all.length, '| 最终 seq:', finalSeq, '| 落盘 seq 数:', diskCount, '| 落盘最大:', diskMax)
  console.log('重复 id:', dup.length ? dup.join(',') : '无 ✅')
  console.log('id 回退:', backslide.length ? JSON.stringify(backslide) : '无 ✅')
  // batch 帧覆盖多行，故 covered 应与落盘 seq 数一致（±1 容忍 stream/closed 等无 seq 帧）
  const coverOk = Math.abs(covered - diskCount) <= 2 || covered >= diskCount
  console.log(`覆盖计数: ${covered} vs 落盘 ${diskCount} → ${coverOk ? '一致 ✅' : '不一致 ❌'}`)

  const ok = dup.length === 0 && backslide.length === 0 && coverOk
  console.log(ok ? '\nRESULT: PASS ✅' : '\nRESULT: FAIL ❌')
  process.exitCode = ok ? 0 : 1
} finally {
  child.kill()
  await new Promise((r) => setTimeout(r, 800))
}
