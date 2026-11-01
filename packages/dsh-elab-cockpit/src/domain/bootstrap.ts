/**
 * 安装向导状态机（纯函数，零 I/O / 零 React）。
 *
 * 方案 §3.1：
 *   unbound → env-ok → root-set → kernel-ok → ready
 *   （工具链体检结果只作 warn/ok 标注，**不阻断**任何状态转移）
 *
 * 状态本身每次由事实重算，不持久化 —— 避免"上次的绿勾骗了这次"；
 * 只持久化配置（elabRoot / pythonPath / 引导条已关闭时间）。
 */

export type BootstrapPhase = 'unbound' | 'env-ok' | 'root-set' | 'kernel-ok' | 'ready'

/** 推导状态所需的最小事实（全部来自 /elab/host 与 /elab/env）。 */
export interface BootstrapFacts {
  /** 解析出的 elab 仓库根（null = 没找到）。 */
  elabRoot: string | null
  /** 宿主半健康：null = 探测中。 */
  hostOk: boolean | null
  /** python 是否可用：null = 尚未探测。 */
  pythonOk: boolean | null
  /** 已接入工程数。 */
  projectCount: number
}

export function deriveBootstrapPhase(f: BootstrapFacts): BootstrapPhase {
  if (f.hostOk === true) return f.projectCount > 0 ? 'ready' : 'kernel-ok'
  if (f.elabRoot !== null) return 'root-set'
  if (f.pythonOk === true) return 'env-ok'
  return 'unbound'
}

/** 向导四步（顺序即展示顺序）。 */
export type BootstrapStepId = 'env' | 'kernel' | 'toolchain' | 'project'

export type StepState = 'done' | 'warn' | 'blocked'

/** 每步的呈现状态：done 绿、warn 黄（不阻断）、blocked 红（需要动作）。 */
export function stepStates(phase: BootstrapPhase): Record<BootstrapStepId, StepState> {
  switch (phase) {
    case 'unbound':
      // 环境还没过：内核/工程都谈不上，工具链只作提示
      return { env: 'blocked', kernel: 'blocked', toolchain: 'warn', project: 'blocked' }
    case 'env-ok':
      return { env: 'done', kernel: 'blocked', toolchain: 'warn', project: 'blocked' }
    case 'root-set':
      return { env: 'done', kernel: 'warn', toolchain: 'warn', project: 'blocked' }
    case 'kernel-ok':
      return { env: 'done', kernel: 'done', toolchain: 'warn', project: 'blocked' }
    case 'ready':
      return { env: 'done', kernel: 'done', toolchain: 'warn', project: 'done' }
  }
}

/** 插件要求的内核最低版本（仅提示：版本旧不阻断功能，方案 §3.5）。 */
export const MIN_KERNEL_VERSION = '2.1.0'

/** 语义版本比较（只处理数字段；非数字按 0）。a<b → -1，相等 → 0，a>b → 1。 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i += 1) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va < vb ? -1 : 1
  }
  return 0
}

/** 内核是否比期望旧（版本未知 = 不判定，交给 existing kernelOld 提示）。 */
export function isKernelOld(version: string | null | undefined, min = MIN_KERNEL_VERSION): boolean {
  if (version === null || version === undefined || version === '') return false
  return compareVersion(version, min) < 0
}
