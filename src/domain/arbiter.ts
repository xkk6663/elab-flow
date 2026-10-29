/**
 * RunArbiter（§6.2）—— run 归属仲裁 + 串口互斥的 Host 半唯一执行点。
 *
 * 仲裁规则（文档 §6.2，前端只展示结果）：
 *  1. **同一 rootKey 同时最多 1 个 run**：Python `RunManager.spawn` 不检查已有
 *     活动 run（server.py:229-290 实读），并发会真的并行抢串口 —— 必须这里串行化。
 *     第二个请求返回结构化 `busy` 并带 holder。
 *  2. **串口互斥**：服务端已有 409；Host 半把上游 409 转成可读文案（不做预判，
 *     监视状态查询属 P5 后续）。
 *  3. **AI 不抢占人工**：人工 run 进行中，agent 的写请求返回 `human-busy`
 *     （带 nextAction），而不是静默排队。
 *  4. **人工可抢占 AI**：取消永远可用（本仲裁不拦 cancel）。
 *
 * 活性：被持有的 run 用**惰性检查**回收 —— 下一次 tryAcquire 时查
 * `/api/runs` 的活动列表，run 不在了 = 已结束，先释放再继续。不解析 SSE
 * （§4.2：SSE 字节级透传，宿主不碰帧）。查询失败按"仍活着"保守处理。
 */

export type Actor = 'human' | 'agent'

export interface ArbiterHolder {
  rootKey: string
  run: string
  actor: Actor
  steps: string[]
}

export type AcquireResult =
  | { ok: true }
  | {
      ok: false
      code: 'busy' | 'human-busy'
      holder: { run: string; actor: Actor; steps: string[] }
      /** human-busy 时给 agent 的下一步建议（§6.2 规则 3）。 */
      nextAction?: string
    }

export class RunArbiter {
  private holder: ArbiterHolder | null = null
  /** 串行化 tryAcquire/release（惰性活性检查是异步的，不串行会双飞）。 */
  private chain: Promise<unknown> = Promise.resolve()
  /** 被持有的 run 是否仍在活动列表（cockpit /api/runs.active[].id）。 */
  private readonly isRunActive: (run: string) => Promise<boolean>

  // ★ 不用构造器参数属性（parameter properties）：本包单测用 --experimental-strip-types
  //   直接跑 TS，strip-only 模式不支持该语法（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。
  constructor(isRunActive: (run: string) => Promise<boolean>) {
    this.isRunActive = isRunActive
  }

  /** 尝试占用（成功后调 attachRun 回填 run id；spawn 失败调 releaseIfPending）。 */
  async tryAcquire(rootKey: string, actor: Actor, steps: string[]): Promise<AcquireResult> {
    const task = this.chain.then(() => this.acquireLocked(rootKey, actor, steps))
    this.chain = task.catch(() => undefined)
    return task
  }

  private async acquireLocked(rootKey: string, actor: Actor, steps: string[]): Promise<AcquireResult> {
    if (this.holder !== null) {
      const alive = await this.isRunActiveSafe(this.holder.run)
      if (!alive) this.holder = null
    }
    if (this.holder !== null) {
      const h = { run: this.holder.run, actor: this.holder.actor, steps: [...this.holder.steps] }
      if (actor === 'agent' && this.holder.actor === 'human') {
        return { ok: false, code: 'human-busy', holder: h, nextAction: '等待人工 run 结束，或请用户在面板点「■ 取消」' }
      }
      return { ok: false, code: 'busy', holder: h }
    }
    this.holder = { rootKey, run: '', actor, steps: [...steps] }
    return { ok: true }
  }

  /** POST /api/run 成功返回后回填 run id。 */
  attachRun(rootKey: string, run: string): void {
    if (this.holder !== null && this.holder.rootKey === rootKey && this.holder.run === '') {
      this.holder.run = run
    }
  }

  /** spawn 失败等场景撤销占用（仅当 run 尚未回填）。 */
  releaseIfPending(rootKey: string): void {
    if (this.holder !== null && this.holder.rootKey === rootKey && this.holder.run === '') {
      this.holder = null
    }
  }

  /** run 结束/取消后显式释放。 */
  release(run: string): void {
    if (this.holder !== null && this.holder.run === run) this.holder = null
  }

  /** 当前持有者（run 未回填的过渡态视为无）。 */
  current(): ArbiterHolder | null {
    if (this.holder === null || this.holder.run === '') return null
    return { ...this.holder }
  }

  private async isRunActiveSafe(run: string): Promise<boolean> {
    if (run === '') return true // spawn 进行中：保守视为占用
    try {
      return await this.isRunActive(run)
    } catch {
      return true
    }
  }
}
