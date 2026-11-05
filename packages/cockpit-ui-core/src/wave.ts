/**
 * 波形测量的纯数学（M7）：坐标映射 / 最近点吸附 / Δ 计算 / 自动量程 / 格式化。
 *
 * ★ 为什么单独成模块：cockpit 与 DSH 插件的 canvas 交互是**两套薄壳**，
 *   数学放进共享层就只有一个事实源 —— 两边同操作必须同结果（方案 §4.7）。
 *   这里不依赖 React / DOM / 任何宿主 API，纯函数可单测。
 *
 * 时间语义：`t_us` 是**RX 批次**的采集时刻 —— 同一批解出的多帧时间相同。
 * 因此 Δt 的精度受批大小限制，界面必须标注"批次时间精度"，不得宣称微秒级精确。
 */

/** 参与测量的最小帧形状（比完整 ICD 窄，方便两面板复用）。 */
export interface WaveProbe {
  /** 帧序号（调用方给的原生下标） */
  index: number;
  /** 批次采集时刻（微秒）；缺省 = 无时间源（Δt 显示 —） */
  t_us?: number;
  /** 原始通道值；null = 多 ID 下该帧不携带此通道 */
  values: Array<number | null>;
}

export interface Range {
  lo: number;
  hi: number;
}

/** 一屏内的自动量程：忽略 NaN/±∞；空数组或全无效返回 null（调用方跳过该通道）。 */
export function autoRange(values: Array<number | null>): Range | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (hi === lo) {
    // 常量通道：给一点上下留白，否则除零（折线会被画到无穷远）
    return { lo: lo - Math.abs(lo || 1) * 0.5, hi: hi + Math.abs(hi || 1) * 0.5 };
  }
  return { lo, hi };
}

/**
 * 值 → 画布 y（顶部为 0）。
 *
 * `gain`/`offset` 是**用户显式坐标**：`v' = v * gain + offset`。
 * 归一化仍用**原始值**的量程 `lo/hi` —— 这样调 gain 会真的压扁/放大曲线，
 * 调 offset 会真的整条上移（方案 §4.7 验收 2）。
 */
export function valueToY(
  v: number,
  lo: number,
  hi: number,
  height: number,
  gain = 1,
  offset = 0,
): number {
  const span = hi - lo
  if (!Number.isFinite(span) || span === 0) return height / 2
  return height - ((v * gain + offset - lo) / span) * height
}

/** 画布 x（相对绘图区）→ 最近帧下标；越界夹到 [0, count-1]。 */
export function nearestFrameIndex(ratio: number, count: number): number {
  if (count <= 0) return 0
  if (!Number.isFinite(ratio)) return 0
  const i = Math.round(ratio * (count - 1))
  return Math.max(0, Math.min(count - 1, i))
}

/**
 * 两点测量（游标 A/B）。
 *
 * 返回：
 * - `d_frames` —— 帧差（B 减 A，可能为负：游标顺序不限）
 * - `dt_us` —— 时间差（毫秒/微秒由 UI 格式化）；任一点无 t_us → null
 * - `dy` —— 每个通道的**原始值**差
 * - `dy_scaled` —— 套用 gain/offset 后的差（`Δ(v*gain)`，offset 相消）
 */
export function measure(
  a: WaveProbe,
  b: WaveProbe,
  gain: number[] = [],
  offset: number[] = [],
): {
  d_frames: number
  dt_us: number | null
  dy: number[]
  dy_scaled: number[]
} {
  const n = Math.max(a.values.length, b.values.length)
  const dy: number[] = []
  const dyScaled: number[] = []
  for (let ch = 0; ch < n; ch++) {
    const va = a.values[ch]
    const vb = b.values[ch]
    if (va === null || vb === null || !Number.isFinite(va) || !Number.isFinite(vb)) {
      dy.push(NaN)
      dyScaled.push(NaN)
      continue
    }
    const g = Number.isFinite(gain[ch]) ? gain[ch] : 1
    // offset 在两点间相消：Δ(v*gain+offset) = gain*Δv
    void offset
    dy.push(vb - va)
    dyScaled.push((vb - va) * g)
  }
  const hasT = Number.isFinite(a.t_us) && Number.isFinite(b.t_us)
  return {
    d_frames: b.index - a.index,
    dt_us: hasT ? (b.t_us as number) - (a.t_us as number) : null,
    dy,
    dy_scaled: dyScaled,
  }
}

/** Δt 的人话格式：<1ms 用 μs，<1s 用 ms，其余用 s（保留 3 位有效小数）。 */
export function fmtDuration(us: number | null): string {
  if (us === null || !Number.isFinite(us)) return '—'
  const a = Math.abs(us)
  const sign = us < 0 ? '-' : ''
  if (a < 1000) return `${sign}${round(a, 1)} μs`
  if (a < 1_000_000) return `${sign}${round(a / 1000, 3)} ms`
  return `${sign}${round(a / 1_000_000, 3)} s`
}

/** 数值格式化：去除浮点尾巴（0.30000000000000004 → 0.3），保留最多 4 位小数。 */
export function fmtValue(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e6 || (a > 0 && a < 1e-4)) return v.toExponential(2)
  return String(round(v, 4))
}

function round(v: number, digits: number): number {
  const p = 10 ** digits
  return Math.round(v * p) / p
}

/** 复制快照的 JSON（视口 + 游标 + 通道配置；方案 §4.7 决策 8：不做 CSV）。 */
export function snapshotJson(input: {
  frozen: boolean
  scaleX: number
  offsetX: number
  frameCount: number
  cursors: { a: WaveProbe | null; b: WaveProbe | null }
  channels: { index: number; label: string; unit?: string; gain: number; offset: number }[]
  takenAt?: string
}): string {
  return JSON.stringify(
    {
      kind: 'elab-wave-snapshot',
      v: 1,
      taken_at: input.takenAt ?? new Date().toISOString(),
      frozen: input.frozen,
      view: { scale_x: input.scaleX, offset_x: input.offsetX, frames: input.frameCount },
      cursors: {
        a: input.cursors.a
          ? { i: input.cursors.a.index, t_us: input.cursors.a.t_us ?? null, v: input.cursors.a.values }
          : null,
        b: input.cursors.b
          ? { i: input.cursors.b.index, t_us: input.cursors.b.t_us ?? null, v: input.cursors.b.values }
          : null,
      },
      channels: input.channels,
    },
    null,
    2,
  )
}
