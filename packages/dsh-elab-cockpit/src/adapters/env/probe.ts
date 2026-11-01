/**
 * Host 半 —— 只读环境探测（`GET /elab/env`）。
 *
 * 三条纪律（见 docs/技术方案_插件独立上架与安装向导.md §3.2）：
 *   ① **探测不冒充体检**：只回答"有没有、什么版本"，不下"能不能编译"的结论
 *      —— 真实结论仍由内核 `doctor` 在工程接入后跑（分层：不复制内核判据）；
 *   ② **白名单 + 数组参数**：只跑固定命令、只传 `--version`，不拼 shell 字符串；
 *   ③ **单项失败隔离**：任一命令超时/不存在只让该项 `ok=false`，不影响整体。
 */

import { execFile } from 'node:child_process'

/** 单项探测结果（`version` 取输出首行，截断到 120 字符）。 */
export interface ProbeItem {
  ok: boolean
  version?: string
  error?: string
}

/** 全部探测结果；`ok` = python 可用（向导第 1 步的唯一判据）。 */
export interface EnvProbe {
  ok: boolean
  checkedAt: number
  python: ProbeItem & { path?: string }
  git: ProbeItem
  cmake: ProbeItem
  ninja: ProbeItem
  armGcc: ProbeItem
  openocd: ProbeItem
  pyserial: ProbeItem
}

/** 允许探测的命令白名单（新增命令必须同步本数组与测试）。 */
export const PROBE_COMMANDS = [
  'python',
  'python3',
  'py',
  'git',
  'cmake',
  'ninja',
  'arm-none-eabi-gcc',
  'openocd',
] as const

const PYTHON_CANDIDATES = ['python', 'python3', 'py']

export interface ProbeOptions {
  /** 插件配置里的 pythonPath；`auto`/空 = 依次试候选名。 */
  pythonPath?: string
  timeoutMs?: number
  /** 测试注入点（默认走 execFile）。 */
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<ProbeItem>
}

/** 跑一条白名单命令并取版本首行。失败不抛，返回 `{ok:false,error}`。 */
export function runProbe(cmd: string, args: string[], timeoutMs = 5000): Promise<ProbeItem> {
  return new Promise((resolve) => {
    if (!(PROBE_COMMANDS as readonly string[]).includes(cmd)) {
      resolve({ ok: false, error: `命令不在白名单：${cmd}` })
      return
    }
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        const text = `${String(stdout ?? '')}\n${String(stderr ?? '')}`.trim()
        const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
        if (error !== null) {
          resolve({ ok: false, error: firstLine !== '' ? firstLine.slice(0, 120) : error.message })
          return
        }
        resolve({ ok: true, ...(firstLine !== '' ? { version: firstLine.slice(0, 120) } : {}) })
      },
    )
  })
}

/** 依次试 python 候选，返回第一个可用的（含实际命令名）。 */
async function resolvePython(
  explicit: string | undefined,
  run: NonNullable<ProbeOptions['run']>,
  timeoutMs: number,
): Promise<ProbeItem & { path?: string }> {
  const candidates =
    explicit !== undefined && explicit !== '' && explicit !== 'auto' ? [explicit] : PYTHON_CANDIDATES
  let last: ProbeItem = { ok: false, error: '未找到 python（试过 python/python3/py）' }
  for (const cmd of candidates) {
    const r = await run(cmd, ['--version'], timeoutMs)
    if (r.ok) return { ...r, path: cmd }
    last = r
  }
  return last
}

/** 只读探测全部依赖；任何一项失败都不影响其它项。 */
export async function probeEnv(opts: ProbeOptions = {}): Promise<EnvProbe> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const run = opts.run ?? runProbe
  const python = await resolvePython(opts.pythonPath, run, timeoutMs)
  const [git, cmake, ninja, armGcc, openocd] = await Promise.all([
    run('git', ['--version'], timeoutMs),
    run('cmake', ['--version'], timeoutMs),
    run('ninja', ['--version'], timeoutMs),
    run('arm-none-eabi-gcc', ['--version'], timeoutMs),
    run('openocd', ['--version'], timeoutMs),
  ])
  // pyserial 只能借 python 探：没有 python 就谈不上串口读写
  const pyserial: ProbeItem = python.ok
    ? await run(python.path ?? 'python', ['-c', 'import serial;print(serial.__version__)'], timeoutMs)
    : { ok: false, error: 'python 不可用，无法检测 pyserial' }
  return {
    ok: python.ok,
    checkedAt: Date.now(),
    python,
    git,
    cmake,
    ninja,
    armGcc,
    openocd,
    pyserial,
  }
}
