/**
 * dsh-elab-iframe —— Host 入口（构建产物，ESM）。与 src/index.ts 语义一致。
 * 探针只做两件事：托管 cockpit（-u/UTF-8/--port 0/就绪探活），把地址交给 Client。
 */
import { existsSync } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'dsh-elab-iframe'
export const inject = ['webServer', 'connection']

export function looksLikeElabRoot(root) {
  if (!isAbsolute(root)) return false
  const r = normalize(root)
  return existsSync(join(r, 'cockpit', 'server.py')) && existsSync(join(r, 'services', 'elab'))
}

function findUpward(from, maxUp = 8) {
  let cur = normalize(from)
  for (let i = 0; i <= maxUp; i += 1) {
    if (looksLikeElabRoot(cur)) return cur
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return undefined
}

export function parsePortFromBanner(line) {
  const at = line.indexOf('\u76d1\u542c')
  if (at < 0) return undefined
  const rest = line.slice(at + 2)
  const scheme = rest.indexOf('//')
  if (scheme < 0) return undefined
  const afterScheme = rest.slice(scheme + 2)
  const colon = afterScheme.lastIndexOf(':')
  if (colon < 0) return undefined
  let digits = ''
  for (const ch of afterScheme.slice(colon + 1)) {
    if (ch >= '0' && ch <= '9') digits += ch
    else break
  }
  if (digits === '') return undefined
  const port = Number(digits)
  return port > 0 && port < 65536 ? port : undefined
}

async function startProbe(root, python) {
  const t0 = Date.now()
  const child = spawn(python, ['-u', '-m', 'cockpit.server', '--port', '0'], {
    cwd: root,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: join(root, 'services') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tail = []
  const port = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('cockpit startup timeout: ' + tail.slice(-6).join(' | '))), 20000)
    const onData = (d) => {
      buf += String(d)
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        tail.push(line)
        if (tail.length > 40) tail.shift()
        const p = parsePortFromBanner(line)
        if (p !== undefined) {
          clearTimeout(timer)
          resolve(p)
          return
        }
        idx = buf.indexOf('\n')
      }
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(new Error('cannot spawn python: ' + e.message))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('cockpit exited code=' + code + ': ' + tail.slice(-6).join(' | ')))
    })
  })
  const base = 'http://127.0.0.1:' + port
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(base + '/api/capabilities', { signal: AbortSignal.timeout(1200) })
      if (r.ok) break
    } catch {
      /* keep waiting */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    child,
    port,
    pid: child.pid,
    bootMs: Date.now() - t0,
    url: base + '/',
    distReady: existsSync(join(root, 'cockpit', 'web', 'dist', 'index.html')),
  }
}

async function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* already gone */
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

function jsonOut(res, code, body) {
  const text = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(Buffer.byteLength(text)))
  res.end(text)
}

export function apply(ctx, config) {
  const opts = config || {}
  let host
  let starting

  const resolveRoot = () => {
    const explicit = opts.elabRoot || 'auto'
    if (explicit !== 'auto' && String(explicit).trim() !== '') {
      return looksLikeElabRoot(String(explicit).trim()) ? String(explicit).trim() : undefined
    }
    return findUpward(process.cwd())
  }

  const ensure = async () => {
    if (host !== undefined && host.child.exitCode === null) return host
    if (starting !== undefined) return starting
    const root = resolveRoot()
    if (root === undefined) {
      throw new Error('elab root not found (need cockpit/server.py and services/elab)')
    }
    starting = startProbe(root, opts.pythonPath || 'python')
    try {
      host = await starting
      return host
    } finally {
      starting = undefined
    }
  }

  const fence = (req) => ctx.connection === undefined || ctx.connection.requestRejection(req) === undefined
  const disposers = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/elab-iframe/url',
      handler: async (req, res) => {
        if (!fence(req)) return jsonOut(res, 403, { ok: false, error: { code: 'forbidden' } })
        try {
          const h = await ensure()
          jsonOut(res, 200, { ok: true, url: h.url, port: h.port, pid: h.pid, bootMs: h.bootMs, distReady: h.distReady })
        } catch (e) {
          jsonOut(res, 503, { ok: false, error: { code: 'host-unavailable', message: String((e && e.message) || e) } })
        }
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/elab-iframe/host',
      handler: async (req, res) => {
        if (!fence(req)) return jsonOut(res, 403, { ok: false, error: { code: 'forbidden' } })
        jsonOut(res, 200, {
          ok: true,
          elabRoot: resolveRoot() || null,
          running: host !== undefined && host.child.exitCode === null,
          port: host ? host.port : null,
          pid: host ? host.pid : null,
          bootMs: host ? host.bootMs : null,
          distReady: host ? host.distReady : null,
        })
      },
    }),
  )

  const dispose = () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    const h = host
    host = undefined
    if (h !== undefined) void killTree(h.pid)
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-elab-iframe: probe lifecycle')
  return dispose
}
