import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  autoRange,
  fmtDuration,
  fmtValue,
  measure,
  nearestFrameIndex,
  snapshotJson,
  valueToY,
} from '../src/index.ts'

test('autoRange：忽略无效值、常量通道留白、空数组返回 null', () => {
  assert.deepEqual(autoRange([1, 3, NaN, Infinity, -2]), { lo: -2, hi: 3 })
  const flat = autoRange([5, 5])
  assert.ok(flat)
  assert.ok(flat.lo < 5 && flat.hi > 5)
  assert.equal(autoRange([]), null)
  assert.equal(autoRange([NaN, Infinity]), null)
})

test('valueToY：顶部=0、底部=height；gain 压扁幅度、offset 整体上移', () => {
  // lo=0 hi=10，height=100：v=10 → 顶 0，v=0 → 底 100
  assert.equal(valueToY(10, 0, 10, 100), 0)
  assert.equal(valueToY(0, 0, 10, 100), 100)
  assert.equal(valueToY(5, 0, 10, 100), 50)
  // gain=0.5 → v=10 变成 5 → 中点
  assert.equal(valueToY(10, 0, 10, 100, 0.5), 50)
  // offset=5 → v=0 变成 5 → 中点
  assert.equal(valueToY(0, 0, 10, 100, 1, 5), 50)
  // 常量量程不除零（返回中线）
  assert.equal(valueToY(7, 5, 5, 100), 50)
})

test('nearestFrameIndex：吸附 + 越界夹紧', () => {
  assert.equal(nearestFrameIndex(0, 10), 0)
  assert.equal(nearestFrameIndex(1, 10), 9)
  assert.equal(nearestFrameIndex(0.44, 10), 4)
  assert.equal(nearestFrameIndex(-0.2, 10), 0)
  assert.equal(nearestFrameIndex(1.3, 10), 9)
  assert.equal(nearestFrameIndex(0.5, 0), 0)
})

test('measure：Δ帧 / Δt / ΔY（原始与缩放）', () => {
  const a = { index: 0, t_us: 1_000_000, values: [1, 10] }
  const b = { index: 10, t_us: 1_100_000, values: [3, 4] }
  const r = measure(a, b, [0.5, 2], [0, 0])
  assert.equal(r.d_frames, 10)
  assert.equal(r.dt_us, 100_000)
  assert.deepEqual(r.dy, [2, -6])
  assert.deepEqual(r.dy_scaled, [1, -12])
  // 无时间源 → dt_us=null（不编造）
  assert.equal(measure({ index: 1, values: [1] }, { index: 2, values: [2] }).dt_us, null)
  // 缺值通道给 NaN，不误报
  assert.ok(Number.isNaN(measure({ index: 0, values: [1] }, { index: 1, values: [] }).dy[0]))
})

test('fmtDuration / fmtValue', () => {
  assert.equal(fmtDuration(null), '—')
  assert.equal(fmtDuration(100), '100 μs')
  assert.equal(fmtDuration(100_000), '100 ms')
  assert.equal(fmtDuration(2_500_000), '2.5 s')
  assert.equal(fmtDuration(-500), '-500 μs')
  assert.equal(fmtValue(0.1 + 0.2), '0.3')
  assert.equal(fmtValue(NaN), '—')
})

test('snapshotJson：稳定结构（视口 + 游标 + 通道）', () => {
  const s = JSON.parse(
    snapshotJson({
      frozen: true,
      scaleX: 2,
      offsetX: 10,
      frameCount: 100,
      cursors: { a: { index: 3, t_us: 1, values: [1] }, b: null },
      channels: [{ index: 0, label: 'rpm', unit: 'RPM', gain: 1, offset: 0 }],
      takenAt: '2026-11-04T00:00:00.000Z',
    }),
  )
  assert.equal(s.kind, 'elab-wave-snapshot')
  assert.equal(s.view.scale_x, 2)
  assert.equal(s.cursors.a.i, 3)
  assert.equal(s.cursors.b, null)
  assert.equal(s.channels[0].label, 'rpm')
})
