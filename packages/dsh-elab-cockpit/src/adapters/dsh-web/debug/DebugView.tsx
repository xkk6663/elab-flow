/**
 * DebugView —— 右侧栏调试面板（Cortex-Debug 功能面的窄栏复刻）。
 *
 * 数据纪律：
 *  - 面板**只读**内核 `/api/debug/*` 投影；不 import 内核源码（AGENTS §3）。
 *  - stop 事件的 `stop_seq` 是唯一刷新闸门：收到新 seq 才重拉栈/变量/寄存器。
 *  - 会话状态轮询只为租约倒计时与"别处已开"的接续；事件面用独立 SSE。
 *
 * 窄栏（320–520px）：工具条一行、数据视图用分组子页签（§10.1），宽屏双列。
 */

import React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import type {
  DebugApi,
  DebugAuditRecord,
  DebugBreakpoint,
  DebugDisasmResponse,
  DebugMemoryResponse,
  DebugPeripheralsResponse,
  DebugRegGroup,
  DebugRtosResponse,
  DebugSessionSnapshot,
  DebugStackFrame,
  DebugSvdField,
  DebugVarNode,
  DebugWatchItem,
} from '../../../domain/debug.ts'

type Tab = 'stack' | 'vars' | 'regs' | 'bps' | 'watch' | 'mem'
  | 'disasm' | 'periph' | 'rtos' | 'audit' | 'out'

const MONO: CSSProperties = { fontFamily: 'var(--elab-font-mono)', fontSize: 'var(--elab-fs-xs)' }
const STATE_TEXT: Record<string, string> = {
  starting: '启动中', running: '运行中', stopped: '已暂停', closing: '关闭中', closed: '已关闭', error: '错误',
}
const OWNER_TEXT: Record<string, string> = { human: '人工', agent: 'Agent' }
const ROW: CSSProperties = {
  display: 'flex', gap: '6px', alignItems: 'baseline', minWidth: 0,
  padding: '2px 6px', borderBottom: '1px solid var(--elab-border)',
}
const BTN: CSSProperties = {
  padding: '1px 7px', fontSize: 'var(--elab-fs-xs)', borderRadius: 'var(--elab-radius-sm)',
  border: '1px solid var(--elab-border)', background: 'transparent',
  color: 'var(--elab-fg-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
}
const INPUT: CSSProperties = {
  flex: '1 1 auto', minWidth: 0, padding: '2px 6px', fontSize: 'var(--elab-fs-xs)',
  fontFamily: 'var(--elab-font-mono)', borderRadius: 'var(--elab-radius-sm)',
  border: '1px solid var(--elab-border)', background: 'var(--elab-bg-code)',
  color: 'var(--elab-fg-primary)',
}

interface OutputLine {
  id: number
  text: string
  tone: 'normal' | 'alert'
}

export interface DebugViewProps {
  sessionId?: string
  visible?: boolean
  /** 当前工程（无会话时用于"开始调试"）。 */
  project: string
  /** 宿主内核是否声明了调试能力（缺 meta.debug 时整个视图不渲染）。 */
  available: boolean
  /** 面板整体不可用（例如没有工程）。 */
  disabled?: boolean
  /** 返回工作区（调试视图是内部覆盖视图，不新增 DSH 槽位）。 */
  onBack?: () => void
  /** ICD 客户端（由组装点注入；视图不得直接 import kernel-http）。 */
  api: DebugApi
}

export function DebugView(props: DebugViewProps): React.ReactElement | null {
  const { sessionId, visible = true, project, available, disabled = false, onBack, api } = props

  const [snap, setSnap] = useState<DebugSessionSnapshot | null>(null)
  const [error, setError] = useState<{ code: string; message: string; hint?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>('stack')

  const [frames, setFrames] = useState<DebugStackFrame[]>([])
  const [frameIdx, setFrameIdx] = useState(0)
  const [varsMode, setVarsMode] = useState<'locals' | 'args'>('locals')
  const [vars, setVars] = useState<DebugVarNode[]>([])
  const [children, setChildren] = useState<Record<string, DebugVarNode[]>>({})
  const [regs, setRegs] = useState<DebugRegGroup[]>([])
  const [bps, setBps] = useState<DebugBreakpoint[]>([])
  const [allowWrite, setAllowWrite] = useState(false)
  const [output, setOutput] = useState<OutputLine[]>([])
  const [bpKind, setBpKind] = useState<'func' | 'addr'>('func')
  const [bpLocation, setBpLocation] = useState('')
  const [bpCond, setBpCond] = useState('')
  const [watches, setWatches] = useState<DebugWatchItem[]>([])
  const [watchExpr, setWatchExpr] = useState('')
  const [watchRev, setWatchRev] = useState(0)
  const [memAddr, setMemAddr] = useState('0x20000000')
  const [memCount, setMemCount] = useState('64')
  const [mem, setMem] = useState<DebugMemoryResponse | null>(null)
  const [disasm, setDisasm] = useState<DebugDisasmResponse | null>(null)
  const [periph, setPeriph] = useState<DebugPeripheralsResponse | null>(null)
  const [rtos, setRtos] = useState<DebugRtosResponse | null>(null)
  const [audit, setAudit] = useState<DebugAuditRecord[]>([])
  // P1/P2 行内编辑（一次只编辑一个单元）
  const [editCell, setEditCell] = useState<{ addr: string; value: string; orig: string } | null>(null)
  const [editReg, setEditReg] = useState<{ name: string; value: string; orig: string } | null>(null)
  const [editField, setEditField] = useState<{
    reg: string; addr: string; size: number; base: number
    offset: number; width: number; value: string
  } | null>(null)
  const [svdQuery, setSvdQuery] = useState('')
  const [svdCollapsed, setSvdCollapsed] = useState<Record<string, boolean>>({})
  /** 断点命中提示（自动消失，不抢焦点） */
  const [bpToast, setBpToast] = useState('')
  /** 宽屏（≥680px）双列：左栈/变量/监视，右寄存器/外设 */
  const [wide, setWide] = useState(false)
  const pcRef = useRef<HTMLDivElement | null>(null)
  const dataRef = useRef<HTMLDivElement | null>(null)

  const outId = useRef(0)
  const dataSeq = useRef(-1)
  const pushOut = useCallback((text: string, tone: OutputLine['tone'] = 'normal') => {
    outId.current += 1
    setOutput((prev) => [...prev.slice(-199), { id: outId.current, text, tone }])
  }, [])

  const applySnap = useCallback((s: DebugSessionSnapshot | null) => {
    setSnap(s)
    if (s?.error != null) setError(s.error)
  }, [])

  const reloadSession = useCallback(async () => {
    try {
      const r = await api.debugSession(sessionId)
      applySnap(r.session)
    } catch {
      /* 内核暂时读不到：保持旧快照，不阻塞面板 */
    }
  }, [applySnap, sessionId])

  // ── 会话状态轮询（1.5s）：租约倒计时 / 别处已开 / 关闭后收尾 ──
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const r = await api.debugSession(sessionId)
        if (!cancelled) applySnap(r.session)
      } catch {
        /* ignore */
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [visible, sessionId, applySnap])

  // ── 数据面：只在 stopped 且 stop_seq 变化时重拉（避免 UI 自激） ──
  const refreshData = useCallback(async (stopSeq: number, frame: number): Promise<void> => {
    dataSeq.current = stopSeq
    setChildren({})
    try {
      const [st, vs, rg, bp] = await Promise.all([
        api.debugStack({ sessionId }),
        api.debugVariables({ frame, scope: varsMode, sessionId }),
        api.debugRegisters({ group: 'core', sessionId }),
        api.debugBreakpoints({ sessionId }),
      ])
      setFrames(st.frames)
      setVars(vs.nodes)
      setRegs(rg.groups)
      setBps(bp.breakpoints)
      setAllowWrite(bp.allow_write === true)
    } catch {
      /* 会话关闭/切换的瞬态失败：不往输出里刷红字（下次 stopped 会重拉） */
    }
  }, [sessionId, varsMode])

  useEffect(() => {
    const s = snap
    if (s === null || s.state !== 'stopped' || s.stop === null) return
    if (s.stop.seq === dataSeq.current) return
    void refreshData(s.stop.seq, frameIdx)
  }, [snap, frameIdx, refreshData])

  // ── P1/P2/P3 数据面：切页签或新 stop_seq 时按需拉取（不预取，窄栏省流量） ──
  const refreshExtra = useCallback(async (): Promise<void> => {
    if (snap === null || snap.state !== 'stopped') return
    try {
      if (tab === 'watch') {
        const w = await api.debugWatch({ sessionId })
        setWatches(w.watches)
        setWatchRev(w.rev)
      } else if (tab === 'mem') {
        setMem(await api.debugMemory({
          addr: memAddr, count: Math.max(1, Math.min(1024, Number(memCount) || 64)), sessionId,
        }))
      } else if (tab === 'disasm') {
        setDisasm(await api.debugDisasm({ sessionId }))
      } else if (tab === 'periph') {
        setPeriph(await api.debugPeripherals({ sessionId }))
      } else if (tab === 'rtos') {
        setRtos(await api.debugRtos({ sessionId }))
      } else if (tab === 'audit') {
        const a = await api.debugAudit({ limit: 100, sessionId })
        setAudit(a.records)
      }
    } catch (e) {
      if (tab === 'rtos') setRtos(null)
      pushOut(`${tab} 读取失败：${e instanceof Error ? e.message : String(e)}`, 'alert')
    }
  }, [snap, tab, sessionId, memAddr, memCount, pushOut])

  useEffect(() => {
    if (snap?.state !== 'stopped') return
    void refreshExtra()
  }, [tab, snap?.stop?.seq]) // eslint-disable-line react-hooks/exhaustive-deps

  const addWatch = useCallback(async (): Promise<void> => {
    const expr = watchExpr.trim()
    if (expr === '') return
    try {
      const r = await api.debugWatch({ op: 'add', expr, format: 'natural', rev: watchRev, sessionId })
      setWatches(r.watches)
      setWatchRev(r.rev)
      setWatchExpr('')
    } catch (e) {
      setError({ code: 'debug-watch-failed', message: e instanceof Error ? e.message : String(e) })
    }
  }, [watchExpr, watchRev, sessionId])

  const removeWatch = useCallback(async (id: string): Promise<void> => {
    try {
      const r = await api.debugWatch({ op: 'remove', id, rev: watchRev, sessionId })
      setWatches(r.watches)
      setWatchRev(r.rev)
    } catch (e) {
      setError({ code: 'debug-watch-failed', message: e instanceof Error ? e.message : String(e) })
    }
  }, [watchRev, sessionId])

  const readMem = useCallback(async (): Promise<void> => {
    try {
      setMem(await api.debugMemory({
        addr: memAddr, count: Math.max(1, Math.min(1024, Number(memCount) || 64)), sessionId,
      }))
    } catch (e) {
      setError({ code: 'debug-memory-failed', message: e instanceof Error ? e.message : String(e) })
    }
  }, [memAddr, memCount, sessionId])

  /** 行内写 1 字节（需人类会话 allow_write；内核记 before/after 审计）。 */
  const commitByte = useCallback(async (addr: string, raw: string, orig: string): Promise<void> => {
    const v = raw.trim().replace(/^0x/i, '')
    if (!/^[0-9a-fA-F]{1,2}$/.test(v)) {
      setError({ code: 'debug-write-invalid', message: '请输入 1 字节 HEX（00–FF）' })
      return
    }
    const value = v.padStart(2, '0').toLowerCase()
    setEditCell(null)
    if (value === orig.toLowerCase()) return
    try {
      await api.debugWrite({ target: 'memory', addr, value, confirm: true, sessionId })
      pushOut(`写内存 ${addr} <- 0x${value}`)
      await readMem()
    } catch (e) {
      setError({ code: 'debug-write-failed', message: e instanceof Error ? e.message : String(e) })
    }
  }, [api, sessionId, pushOut, readMem])

  /** 行内写寄存器（32 位 HEX，只允许内核白名单里的 core 寄存器）。 */
  const commitReg = useCallback(async (name: string, raw: string, orig: string): Promise<void> => {
    let v = raw.trim()
    if (v.toLowerCase().startsWith('0x')) v = v.slice(2)
    if (!/^[0-9a-fA-F]{1,8}$/.test(v)) {
      setError({ code: 'debug-write-invalid', message: '寄存器值需 1–8 位 HEX（32 位）' })
      return
    }
    const value = v.padStart(8, '0').toLowerCase()
    setEditReg(null)
    const normOrig = orig.trim().toLowerCase().replace(/^0x/, '').padStart(8, '0')
    if (value === normOrig) return
    try {
      await api.debugWrite({ target: 'register', name, value, confirm: true, sessionId })
      pushOut(`写寄存器 ${name} <- 0x${value}`)
      const r = await api.debugRegisters({ group: 'core', sessionId })
      setRegs(r.groups)
    } catch (e) {
      setError({ code: 'debug-write-failed', message: e instanceof Error ? e.message : String(e) })
    }
  }, [api, sessionId, pushOut])

  /** SVD 字段写：读-改-写，保留同寄存器其它位，按寄存器宽度写回。 */
  const commitField = useCallback(async (): Promise<void> => {
    const ef = editField
    if (ef === null) return
    const raw = ef.value.trim()
    const num = raw.toLowerCase().startsWith('0x')
      ? Number.parseInt(raw.slice(2), 16)
      : Number.parseInt(raw, 10)
    const max = ef.width >= 32 ? 0x100000000 : 2 ** ef.width
    if (!Number.isFinite(num) || num < 0 || num >= max) {
      setError({ code: 'debug-write-invalid', message: `字段 ${ef.width} 位，范围 0–${max - 1}` })
      return
    }
    const mask = ef.width >= 32 ? 0xffffffff : (2 ** ef.width - 1)
    const next = ((ef.base >>> 0) & ~mask | ((num << ef.offset) & mask)) >>> 0
    const bytes = Math.max(1, Math.min(4, Math.ceil(ef.size / 8)))
    // 内核写内存按字节序列落盘（gdb -data-write-memory-bytes）；ARM 是小端：
    // 必须把整值拆成「低字节在前」，否则 0x0000a00f 会被写成 0x0fa00000。
    const value = Array.from({ length: bytes },
      (_, i) => ((next >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')).join('')
    setEditField(null)
    try {
      await api.debugWrite({ target: 'memory', addr: ef.addr, value, confirm: true, sessionId })
      pushOut(`写字段 ${ef.reg} <- ${raw}（寄存器 0x${value}）`)
      setPeriph(await api.debugPeripherals({ path: ef.reg, read: true, sessionId }))
    } catch (e) {
      setError({ code: 'debug-write-failed', message: e instanceof Error ? e.message : String(e) })
    }
  }, [api, editField, sessionId, pushOut])

  /** 反汇编行内「设地址断点」，并回列表刷新。 */
  const addAddrBp = useCallback(async (addr: string): Promise<void> => {
    try {
      await api.debugBreakpoints({ op: 'add', kind: 'addr', location: addr, sessionId })
      const r = await api.debugBreakpoints({ sessionId })
      setBps(r.breakpoints)
      setAllowWrite(r.allow_write === true)
      pushOut(`地址断点 + ${addr}`)
    } catch (e) {
      setError({ code: 'debug-breakpoint-failed', message: e instanceof Error ? e.message : String(e) })
    }
  }, [api, sessionId, pushOut])

  const loadPeriph = useCallback(async (path: string, read: boolean): Promise<void> => {
    try {
      setPeriph(await api.debugPeripherals({ path, read, sessionId }))
    } catch (e) {
      setError({ code: 'debug-svd-failed', message: e instanceof Error ? e.message : String(e) })
    }
  }, [sessionId])

  // 停止态切换帧：重拉变量
  const selectFrame = useCallback((idx: number): void => {
    setFrameIdx(idx)
    const s = snap
    if (s === null || s.state !== 'stopped') return
    void api.debugVariables({ frame: idx, scope: varsMode, sessionId })
      .then((r) => { setVars(r.nodes); setChildren({}) })
      .catch(() => { /* 帧切失败：保留旧列表 */ })
  }, [snap, varsMode, sessionId])

  // 变量作用域切换
  useEffect(() => {
    if (snap?.state !== 'stopped') return
    void api.debugVariables({ frame: frameIdx, scope: varsMode, sessionId })
      .then((r) => { setVars(r.nodes); setChildren({}) })
      .catch(() => { /* ignore */ })
  }, [varsMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 调试 SSE：stop/state/输出/断点实时进面板 ──
  useEffect(() => {
    if (!visible || !available || snap === null) return
    const q = new URLSearchParams()
    if (sessionId !== undefined && sessionId !== '') q.set('sessionId', sessionId)
    const es = new EventSource(`/elab/debug/events?${q.toString()}`)
    const onMsg = (ev: MessageEvent<string>): void => {
      let env: { topic?: string; data?: Record<string, unknown> } | undefined
      try { env = JSON.parse(ev.data) as { topic?: string; data?: Record<string, unknown> } } catch { return }
      if (env === undefined) return
      const topic = String(env.topic ?? '')
      const data = env.data ?? {}
      if (topic === 'debug/output') {
        const text = String(data.text ?? '')
        if (text !== '') pushOut(text)
        return
      }
      if (topic === 'debug/error') {
        setError({ code: String(data.code ?? 'debug-error'), message: String(data.message ?? '调试错误') })
        pushOut(String(data.message ?? ''), 'alert')
        return
      }
      if (topic === 'debug/closed') {
        pushOut(`会话结束（resume=${String(data.resumed)}）`)
        void reloadSession()
        return
      }
      if (topic === 'debug/stop') {
        const reason = String(data.reason ?? '')
        const bkpt = String(data.bkptno ?? '')
        if (reason === 'breakpoint-hit' || bkpt !== '') {
          setBpToast(bkpt === '' ? '命中断点，已切到调用栈' : `命中断点 #${bkpt}，已切到调用栈`)
          setTab('stack')
          setFrameIdx(0)
        }
        void reloadSession()
        return
      }
      if (topic === 'debug/opened' || topic === 'debug/state' || topic === 'debug/breakpoint') {
        void reloadSession()
      }
    }
    for (const topic of ['debug/opened', 'debug/state', 'debug/stop', 'debug/breakpoint',
      'debug/output', 'debug/error', 'debug/closed']) {
      es.addEventListener(topic, onMsg as EventListener)
    }
    es.onmessage = onMsg
    es.onerror = () => { /* 断线后由浏览器重连；会话轮询仍在跑 */ }
    return () => es.close()
  }, [visible, available, snap?.id, sessionId, pushOut, reloadSession]) // eslint-disable-line react-hooks/exhaustive-deps

  // 容器宽度探测：窄栏保持单列，宽屏启用双列（不依赖 DSH 栏位宽度约定）
  useEffect(() => {
    const el = dataRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWide(w >= 680)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [available])

  // P2：SVD 搜索 + 按 group 分组（折叠状态本地保存）
  const svdGroups = useMemo(() => {
    const q = svdQuery.trim().toLowerCase()
    const list = (periph?.peripherals ?? []).filter((p) =>
      q === '' || p.name.toLowerCase().includes(q)
      || (p.description ?? '').toLowerCase().includes(q))
    const map = new Map<string, typeof list>()
    for (const p of list) {
      const g = p.group !== undefined && p.group.trim() !== '' ? p.group : '其它'
      const cur = map.get(g)
      if (cur !== undefined) cur.push(p)
      else map.set(g, [p])
    }
    return Array.from(map.entries())
  }, [periph, svdQuery])

  const svdRegs = useMemo(() => {
    const q = svdQuery.trim().toLowerCase()
    return (periph?.peripheral?.registers ?? []).filter((r) =>
      q === '' || r.name.toLowerCase().includes(q)
      || (r.description ?? '').toLowerCase().includes(q))
  }, [periph, svdQuery])

  // 断点命中提示 3s 自动消失
  useEffect(() => {
    if (bpToast === '') return
    const timer = window.setTimeout(() => setBpToast(''), 3000)
    return () => window.clearTimeout(timer)
  }, [bpToast])

  // 反汇编 PC 行自动滚到视野中央
  useEffect(() => {
    if (tab !== 'disasm') return
    const el = pcRef.current
    if (el !== null && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'auto' })
    }
  }, [disasm, tab])

  // ── 动作 ──
  const open = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.debugOpen({
        project,
        options: { stop_at: 'main' },
        lease_s: 600,
        allow_write: true,
        sessionId,
      })
      applySnap(r.session)
      pushOut(`调试会话已打开（${r.session?.id ?? ''}）`)
      setTab('stack')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError({ code: 'debug-open-failed', message: msg })
    } finally {
      setBusy(false)
    }
  }, [applySnap, project, pushOut, sessionId])

  const control = useCallback(async (action: string): Promise<void> => {
    setBusy(true)
    try {
      await api.debugControl({
        action,
        sessionId,
        ...(action === 'reset' ? { confirm: true } : {}),
      })
      await reloadSession()
    } catch (e) {
      setError({ code: 'debug-control-failed', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }, [reloadSession, sessionId])

  const closeSession = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.debugClose({ resume: true, sessionId })
      pushOut(`会话已关闭（resumed=${String(r.resumed)}）`)
      applySnap(null)
      setFrames([]); setVars([]); setRegs([]); setBps([]); setChildren({})
    } catch (e) {
      setError({ code: 'debug-close-failed', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }, [applySnap, pushOut, sessionId])

  const addBreakpoint = useCallback(async (): Promise<void> => {
    const loc = bpLocation.trim()
    if (loc === '') return
    try {
      await api.debugBreakpoints({
        op: 'add', kind: bpKind, location: loc, condition: bpCond.trim(), sessionId,
      })
      setBpLocation('')
      setBpCond('')
      const r = await api.debugBreakpoints({ sessionId })
      setBps(r.breakpoints)
    } catch (e) {
      setError({ code: 'debug-breakpoint-failed', message: e instanceof Error ? e.message : String(e) })
    }
  }, [bpCond, bpKind, bpLocation, sessionId])

  const bpOp = useCallback(async (op: 'toggle' | 'remove', id: string): Promise<void> => {
    try {
      await api.debugBreakpoints({ op, id, sessionId })
      const r = await api.debugBreakpoints({ sessionId })
      setBps(r.breakpoints)
    } catch (e) {
      setError({ code: 'debug-breakpoint-failed', message: e instanceof Error ? e.message : String(e) })
    }
  }, [sessionId])

  const expandVar = useCallback(async (node: DebugVarNode, path: string): Promise<void> => {
    if (children[path] !== undefined) {
      setChildren((prev) => {
        const next = { ...prev }
        delete next[path]
        return next
      })
      return
    }
    try {
      const r = await api.debugVariables({ frame: frameIdx, scope: 'children', var: node.name, sessionId })
      setChildren((prev) => ({ ...prev, [path]: r.nodes }))
    } catch (e) {
      pushOut(`展开 ${node.name} 失败：${e instanceof Error ? e.message : String(e)}`, 'alert')
    }
  }, [children, frameIdx, pushOut, sessionId])

  if (!available) return null
  const running = snap !== null && snap.state === 'running'
  const stopped = snap !== null && snap.state === 'stopped'
  const lease = snap !== null && snap.owner === 'agent' && snap.lease_remaining_s > 0
  // 页签按会话 features 白名单渲染：内核没声明 svd/rtos 时对应页不出现（AGENTS §4）
  const features = snap?.features ?? []
  const tabs: Array<[Tab, string]> = [
    ['stack', `调用栈 ${frames.length}`],
    ['vars', '变量'],
    ['regs', '寄存器'],
    ['bps', `断点 ${bps.length}`],
    ...(features.includes('watch') ? [['watch', '监视'] as [Tab, string]] : []),
    ['mem', '内存'],
    ['disasm', '反汇编'],
    ...(features.includes('svd') ? [['periph', '外设'] as [Tab, string]] : []),
    ...(features.includes('rtos') ? [['rtos', 'RTOS 栈'] as [Tab, string]] : []),
    ['audit', '审计'],
    ['out', '输出'],
  ]
  // 复位瞬间内核的 stop 帧可能是空的（补拉在途）：用已取到的栈顶帧兜底，别让位置条只剩 "??"
  const stopView = snap?.stop == null
    ? null
    : snap.stop.frame.func === '' && frames.length > 0
      ? { ...snap.stop, frame: frames[0], pc: snap.stop.pc !== '' ? snap.stop.pc : frames[0].addr }
      : snap.stop

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 工具条 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap',
        padding: '4px 6px', borderBottom: '1px solid var(--elab-border)', flex: '0 0 auto',
      }}>
        {onBack !== undefined && (
          <button type="button" onClick={onBack} style={BTN} title="返回工作区" aria-label="返回工作区">
            {'\u2190'}
          </button>
        )}
        {snap === null || snap.state === 'closed' || snap.state === 'error' ? (
          <button
            type="button"
            disabled={disabled || busy || project === ''}
            onClick={() => void open()}
            style={{ ...BTN, borderColor: 'var(--elab-accent)', color: 'var(--elab-accent)' }}
            title="建立会话：复位 → 下载 ELF → 断到 main"
          >
            {busy ? '启动中…' : '开始调试'}
          </button>
        ) : (
          <>
            <button type="button" disabled={busy || !stopped} onClick={() => void control('continue')} style={BTN}>继续</button>
            <button type="button" disabled={busy || !running} onClick={() => void control('pause')} style={BTN}>暂停</button>
            <button type="button" disabled={busy || !stopped} onClick={() => void control('step_over')} style={BTN}>单步</button>
            <button type="button" disabled={busy || !stopped} onClick={() => void control('step_in')} style={BTN}>步入</button>
            <button type="button" disabled={busy || !stopped} onClick={() => void control('step_out')} style={BTN}>步出</button>
            <button type="button" disabled={busy || !stopped} onClick={() => void control('stepi')} style={BTN}>指令</button>
            <button type="button" disabled={busy} onClick={() => void control('reset')} style={BTN}>复位</button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void closeSession()}
              style={{ ...BTN, borderColor: 'var(--elab-status-fail)', color: 'var(--elab-status-fail)' }}
              title="关闭会话并恢复目标运行（C36）"
            >
              关闭
            </button>
          </>
        )}
        {snap !== null && (
          <span style={{ marginLeft: 'auto', ...MONO, color: 'var(--elab-fg-muted)' }}>
            <span style={{
              color: snap.state === 'stopped' ? 'var(--elab-status-run)'
                : snap.state === 'running' ? 'var(--elab-status-ok)' : 'var(--elab-fg-muted)',
            }}>
              {STATE_TEXT[snap.state] ?? snap.state}
            </span>
            {` · ${OWNER_TEXT[snap.owner] ?? snap.owner}${lease ? ` · ${snap.lease_remaining_s}s` : ''}`}
          </span>
        )}
      </div>

      {/* 位置条 */}
      {stopped && stopView !== null && (
        <div style={{ ...MONO, flex: '0 0 auto', padding: '3px 6px', borderBottom: '1px solid var(--elab-border)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--elab-accent)' }}>{stopView.frame.func || '??'}</span>
          {stopView.frame.file !== '' && (
            <span style={{ color: 'var(--elab-fg-secondary)' }}>{` @ ${stopView.frame.file}${stopView.frame.line === null ? '' : `:${stopView.frame.line}`}`}</span>
          )}
          {stopView.pc !== '' && <span style={{ color: 'var(--elab-fg-muted)' }}>{`  ${stopView.pc}`}</span>}
          {stopView.warn !== undefined && <span style={{ color: 'var(--elab-status-run)' }}>{`  ⚠ ${stopView.warn}`}</span>}
        </div>
      )}

      {error !== null && (
        <div style={{ flex: '0 0 auto', padding: '3px 6px', borderBottom: '1px solid var(--elab-border)', color: 'var(--elab-status-fail)', fontSize: 'var(--elab-fs-xs)' }}>
          {`${error.code}：${error.message}`}
          {error.hint !== undefined && <span style={{ color: 'var(--elab-fg-muted)' }}>{`（${error.hint}）`}</span>}
        </div>
      )}

      {bpToast !== '' && (
        <div style={{ flex: '0 0 auto', margin: '3px 6px', padding: '3px 8px', border: '1px solid var(--elab-accent)', borderRadius: 'var(--elab-radius-sm)', background: 'var(--elab-bg-raised)', color: 'var(--elab-accent)', fontSize: 'var(--elab-fs-xs)' }}>
          {bpToast}
        </div>
      )}

      {/* 子页签 */}
      {snap !== null && (
        <div style={{ display: 'flex', gap: '2px', flex: '0 0 auto', padding: '3px 6px', borderBottom: '1px solid var(--elab-border)', flexWrap: 'wrap' }}>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              style={{
                ...BTN,
                borderColor: tab === id ? 'var(--elab-accent)' : 'var(--elab-border)',
                color: tab === id ? 'var(--elab-accent)' : 'var(--elab-fg-muted)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* 数据区：窄栏单列；宽屏（≥680px）左右双列（左栈/变量/监视，右寄存器/外设） */}
      <div ref={dataRef} style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', overflow: 'hidden', background: 'var(--elab-bg-surface)' }}>
      <div style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto' }}>
        {snap === null && (
          <div style={{ padding: 'var(--elab-space-3)', color: 'var(--elab-fg-secondary)', fontSize: 'var(--elab-fs-sm)', lineHeight: 1.6 }}>
            {project === ''
              ? '先在工作区选中/接入一个工程。'
              : `工程「${project}」：点「开始调试」会复位、下载 ELF 并停在 main。注册器和调用栈与 Agent 共用同一份会话数据。`}
          </div>
        )}

        {snap !== null && snap.state === 'starting' && (
          <div style={{ padding: 'var(--elab-space-3)', color: 'var(--elab-fg-secondary)', fontSize: 'var(--elab-fs-sm)' }}>
            正在启动 openocd / gdb …
          </div>
        )}

        {tab === 'stack' && snap !== null && (
          <div>
            {frames.length === 0 && <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>（无栈帧 / 目标正在运行）</div>}
            {frames.map((f) => (
              <button
                key={f.level}
                type="button"
                onClick={() => selectFrame(f.level)}
                style={{
                  ...ROW, width: '100%', textAlign: 'left', border: 'none',
                  background: f.level === frameIdx ? 'var(--elab-bg-raised)' : 'transparent',
                  cursor: 'pointer', color: 'var(--elab-fg-primary)',
                }}
              >
                <span style={{ color: 'var(--elab-fg-muted)', flex: '0 0 20px' }}>{`#${f.level}`}</span>
                <span style={{ flex: '0 0 auto', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: f.pc ? 'var(--elab-accent)' : 'var(--elab-fg-primary)', fontFamily: 'var(--elab-font-mono)', fontSize: 'var(--elab-fs-xs)' }}>{f.func}</span>
                <span style={{ flex: '1 1 auto', minWidth: 0, marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--elab-fg-muted)', fontFamily: 'var(--elab-font-mono)', fontSize: 'var(--elab-fs-xs)' }} title={f.file === '' ? '' : `${f.file}:${f.line ?? '?'}`}>
                  {f.file === '' ? '' : `${f.file}:${f.line ?? '?'}`}
                </span>
                {f.addr !== '' && (
                  <span style={{ flex: '0 0 auto', color: 'var(--elab-fg-muted)', fontFamily: 'var(--elab-font-mono)', fontSize: 'var(--elab-fs-xs)' }}>{f.addr}</span>
                )}
              </button>
            ))}
            {snap.threads.length > 1 && (
              <div style={{ ...ROW, color: 'var(--elab-fg-muted)' }}>
                {snap.threads.map((t) => `${t.current ? '●' : '○'} ${t.name || `#${t.id}`}`).join('   ')}
              </div>
            )}
          </div>
        )}

        {tab === 'vars' && snap !== null && (
          <div>
            <div style={{ display: 'flex', gap: '4px', padding: '4px 6px' }}>
              <button type="button" onClick={() => setVarsMode('locals')} style={{ ...BTN, color: varsMode === 'locals' ? 'var(--elab-accent)' : 'var(--elab-fg-muted)' }}>局部</button>
              <button type="button" onClick={() => setVarsMode('args')} style={{ ...BTN, color: varsMode === 'args' ? 'var(--elab-accent)' : 'var(--elab-fg-muted)' }}>参数</button>
              <span style={{ marginLeft: 'auto', color: 'var(--elab-fg-muted)', ...MONO }}>{`帧 #${frameIdx}`}</span>
            </div>
            {vars.length === 0 && <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>（无变量；可能未带 -g 或已优化）</div>}
            {vars.map((v) => (
              <VarRow key={v.name} node={v} path={v.name} depth={0} open={children} onToggle={expandVar} />
            ))}
          </div>
        )}

        {tab === 'regs' && snap !== null && (
          <div>
            {regs.map((g) => (
              <div key={g.name}>
                <div style={{ padding: '3px 6px', color: 'var(--elab-fg-muted)', ...MONO }}>{g.label}</div>
                {g.regs.map((r) => {
                  const editable = r.editable === true && allowWrite
                  const editing = editReg?.name === r.name
                  return (
                    <div key={r.name} style={ROW}>
                      <span style={{ color: r.pc ? 'var(--elab-accent)' : 'var(--elab-fg-secondary)', flex: '0 0 52px' }}>{r.name}</span>
                      {editing ? (
                        <input
                          autoFocus
                          maxLength={10}
                          value={editReg.value}
                          aria-label={`编辑寄存器 ${r.name}`}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditReg({ ...editReg, value: e.currentTarget.value })}
                          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                            if (e.key === 'Enter') void commitReg(r.name, editReg.value, editReg.orig)
                            if (e.key === 'Escape') setEditReg(null)
                          }}
                          onBlur={() => setEditReg(null)}
                          style={{ width: '84px', padding: '0 3px', border: '1px solid var(--elab-accent)', borderRadius: '2px', background: 'var(--elab-bg-code)', color: 'var(--elab-fg-primary)', ...MONO }}
                        />
                      ) : (
                        <button
                          type="button"
                          title={editable ? `点击改写 ${r.name}` : '不可写'}
                          onClick={() => editable ? setEditReg({ name: r.name, value: r.hex, orig: r.hex }) : undefined}
                          style={{ padding: '0 2px', border: '1px dashed transparent', borderRadius: '2px', background: 'transparent', color: 'var(--elab-fg-primary)', cursor: editable ? 'pointer' : 'default', ...MONO }}
                        >
                          {r.hex}
                        </button>
                      )}
                      <span style={{ marginLeft: 'auto', color: 'var(--elab-fg-muted)', ...MONO }}>{r.natural}</span>
                      {r.flags !== undefined && (
                        <span style={{ color: 'var(--elab-status-run)', ...MONO }}>
                          {Object.entries(r.flags).filter(([, v]) => v === 1).map(([k]) => k).join('')}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
            {regs.length === 0 && <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>（目标运行中，寄存器不可读）</div>}
          </div>
        )}

        {tab === 'bps' && snap !== null && (
          <div>
            <div style={{ display: 'flex', gap: '4px', padding: '4px 6px', flexWrap: 'wrap' }}>
              <select value={bpKind} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setBpKind(e.currentTarget.value === 'addr' ? 'addr' : 'func')} style={{ ...INPUT, flex: '0 0 64px' }}>
                <option value="func">函数</option>
                <option value="addr">地址</option>
              </select>
              <input
                value={bpLocation}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBpLocation(e.currentTarget.value)}
                placeholder={bpKind === 'func' ? '函数名，如 vTaskDelay' : '地址，如 0x080001a4'}
                style={INPUT}
              />
              <input value={bpCond} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBpCond(e.currentTarget.value)} placeholder="条件（可选）" style={{ ...INPUT, flex: '1 1 60px', minWidth: 0 }} />
              <button type="button" onClick={() => void addBreakpoint()} style={{ ...BTN, flex: '0 0 auto', color: 'var(--elab-accent)' }}>添加</button>
            </div>
            {bps.length === 0 && <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>（暂无断点。窄栏没有编辑器 gutter，请用函数/地址断点）</div>}
            {bps.map((b) => (
              <div key={b.id} style={ROW}>
                <span style={{ color: b.enabled ? 'var(--elab-status-fail)' : 'var(--elab-fg-faint)' }}>●</span>
                <span style={{ ...MONO, color: 'var(--elab-fg-primary)' }}>{b.location || b.id}</span>
                {b.condition !== '' && <span style={{ color: 'var(--elab-fg-muted)', ...MONO }}>{`if ${b.condition}`}</span>}
                <span style={{ marginLeft: 'auto', color: 'var(--elab-fg-muted)', ...MONO }}>{`×${b.hit_count}`}</span>
                <button type="button" onClick={() => void bpOp('toggle', b.id)} style={BTN}>{b.enabled ? '禁用' : '启用'}</button>
                <button type="button" onClick={() => void bpOp('remove', b.id)} style={BTN}>删除</button>
              </div>
            ))}
            {allowWrite && (
              <div style={{ padding: '4px 6px', color: 'var(--elab-fg-muted)', fontSize: 'var(--elab-fs-xs)' }}>
                当前会话为人类所有：可写内存/寄存器（Agent 写受 allow_write 与 confirm 双重闸门限制）。
              </div>
            )}
          </div>
        )}

        {tab === 'watch' && snap !== null && (
          <div>
            <div style={{ display: 'flex', gap: '4px', padding: '4px 6px' }}>
              <input
                value={watchExpr}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWatchExpr(e.currentTarget.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') void addWatch() }}
                placeholder="表达式，如 g_hb_frame.on_frame"
                style={INPUT}
              />
              <button type="button" onClick={() => void addWatch()} style={{ ...BTN, color: 'var(--elab-accent)' }}>添加</button>
            </div>
            {watches.length === 0 && <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>（暂无监视。只在暂停态求值，列表跨会话保留）</div>}
            {watches.map((w) => (
              <div key={w.id} style={ROW}>
                <span style={{ ...MONO, color: 'var(--elab-fg-secondary)' }}>{w.expr}</span>
                <span style={{ marginLeft: 'auto', ...MONO, color: w.error !== undefined ? 'var(--elab-status-fail)' : 'var(--elab-fg-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {w.error !== undefined ? w.error : (w.natural || w.value || w.hex)}
                </span>
                <button type="button" onClick={() => void removeWatch(w.id)} style={BTN}>删除</button>
              </div>
            ))}
          </div>
        )}

        {tab === 'mem' && snap !== null && (
          <div>
            <div style={{ display: 'flex', gap: '4px', padding: '4px 6px', flexWrap: 'wrap' }}>
              <input value={memAddr} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMemAddr(e.currentTarget.value)} placeholder="地址，如 0x20000010" style={{ ...INPUT, flex: '1 1 110px' }} />
              <input value={memCount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMemCount(e.currentTarget.value)} placeholder="字节数" style={{ ...INPUT, flex: '0 0 56px' }} />
              <button type="button" onClick={() => void readMem()} style={BTN}>读取</button>
            </div>
            {mem !== null && (
              <div style={{ ...MONO, padding: '4px 6px', color: 'var(--elab-fg-primary)' }}>
                {memRows(mem).map((row) => (
                  <div key={row.addr} style={{ display: 'flex', alignItems: 'center', whiteSpace: 'pre' }}>
                    <span style={{ color: 'var(--elab-fg-faint)', marginRight: '6px' }}>{row.addr}</span>
                    {row.bytes.map((b, i) => {
                      const addr = `0x${(Number.parseInt(row.addr, 16) + i).toString(16).padStart(8, '0')}`
                      const editing = editCell?.addr === addr
                      if (editing) {
                        return (
                          <input
                            key={addr}
                            autoFocus
                            maxLength={2}
                            value={editCell.value}
                            aria-label={`编辑 ${addr}`}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditCell({ ...editCell, value: e.currentTarget.value })}
                            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                              if (e.key === 'Enter') void commitByte(addr, editCell.value, editCell.orig)
                              if (e.key === 'Escape') setEditCell(null)
                            }}
                            onBlur={() => setEditCell(null)}
                            style={{ width: '20px', margin: '0 1px', padding: 0, textAlign: 'center', border: '1px solid var(--elab-accent)', borderRadius: '2px', background: 'var(--elab-bg-surface)', color: 'var(--elab-fg-primary)', font: 'inherit' }}
                          />
                        )
                      }
                      return allowWrite ? (
                        <button
                          key={addr}
                          type="button"
                          title={`点击编辑 ${addr}（当前 0x${b}）`}
                          onClick={() => setEditCell({ addr, value: b, orig: b })}
                          style={{ minWidth: '17px', margin: '0 1px', padding: 0, border: 'none', borderRadius: '2px', background: 'transparent', color: 'var(--elab-fg-primary)', font: 'inherit', cursor: 'pointer' }}
                        >
                          {b}
                        </button>
                      ) : (
                        <span key={addr} style={{ minWidth: '17px', margin: '0 1px', textAlign: 'center' }}>{b}</span>
                      )
                    })}
                    <span style={{ color: 'var(--elab-fg-muted)', marginLeft: '6px' }}>{row.ascii}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ padding: '4px 6px', color: 'var(--elab-fg-muted)', fontSize: 'var(--elab-fs-xs)' }}>
              {allowWrite ? '点 HEX 字节可直接改写（内核记 before/after 审计）。' : '只读：写内存需要人类会话且 allow_write=true。'}
            </div>
          </div>
        )}

        {tab === 'disasm' && snap !== null && (
          <div>
            <div style={{ display: 'flex', gap: '4px', padding: '4px 6px' }}>
              <button type="button" onClick={() => void api.debugDisasm({ sessionId }).then(setDisasm).catch(() => undefined)} style={BTN}>刷新</button>
              <button type="button" disabled={!stopped || busy} onClick={() => void control('stepi')} style={BTN}>指令单步</button>
            </div>
            {disasm === null && <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>（暂无指令；目标需暂停）</div>}
            {disasm?.instructions.map((ins) => (
              <div
                key={ins.addr}
                ref={ins.pc ? pcRef : undefined}
                style={{ ...ROW, background: ins.pc ? 'var(--elab-bg-raised)' : 'transparent' }}
              >
                <button
                  type="button"
                  title="跳到内存视图"
                  onClick={() => {
                    setMemAddr(ins.addr)
                    setTab('mem')
                    void api.debugMemory({ addr: ins.addr, count: Math.max(1, Math.min(1024, Number(memCount) || 64)), sessionId })
                      .then(setMem).catch(() => undefined)
                  }}
                  style={{ ...MONO, flex: '0 0 74px', padding: 0, border: 'none', background: 'none', color: ins.pc ? 'var(--elab-accent)' : 'var(--elab-fg-faint)', cursor: 'pointer', textAlign: 'left' }}
                >
                  {ins.addr}
                </button>
                {ins.pc && (
                  <span style={{ ...MONO, flex: '0 0 auto', padding: '0 3px', borderRadius: '2px', background: 'var(--elab-accent)', color: 'var(--elab-bg-canvas)' }}>PC</span>
                )}
                <span style={{ ...MONO, color: 'var(--elab-fg-primary)', flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {`${ins.mnemonic} ${ins.operands}`}
                </span>
                {ins.symbol !== '' && <span style={{ ...MONO, color: 'var(--elab-fg-muted)', flex: '0 0 auto', maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ins.symbol}</span>}
                <button
                  type="button"
                  title="在此地址设断点"
                  onClick={() => void addAddrBp(ins.addr)}
                  style={{ ...BTN, flex: '0 0 auto', padding: '0 4px' }}
                >
                  ⌖
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === 'periph' && snap !== null && (
          <div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', padding: '4px 6px' }}>
              <span style={{ ...MONO, color: 'var(--elab-fg-muted)' }}>{periph?.svd.name ?? 'SVD'}</span>
              {periph?.level !== 'device' && periph?.peripheral !== undefined && (
                <span style={{ ...MONO, color: 'var(--elab-accent)' }}>{periph.peripheral.name}</span>
              )}
              {periph?.level !== 'register' && (
                <input
                  value={svdQuery}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSvdQuery(e.currentTarget.value)}
                  placeholder={periph?.level === 'device' ? '搜索外设' : '搜索寄存器'}
                  style={{ ...INPUT, flex: '0 0 108px' }}
                />
              )}
              <button type="button" onClick={() => void loadPeriph('', false)} style={{ ...BTN, marginLeft: 'auto' }}>顶层</button>
            </div>
            {periph === null && <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>（无 SVD 或目标未暂停）</div>}
            {periph?.level === 'device' && svdGroups.map(([group, items]) => {
              const folded = svdCollapsed[group] === true
              return (
                <div key={group}>
                  <button
                    type="button"
                    onClick={() => setSvdCollapsed((prev) => ({ ...prev, [group]: !folded }))}
                    style={{ ...ROW, width: '100%', border: 'none', background: 'transparent', color: 'var(--elab-fg-muted)', cursor: 'pointer', ...MONO }}
                  >
                    {`${folded ? '▸' : '▾'} ${group} · ${items.length}`}
                  </button>
                  {!folded && items.map((p) => (
                    <button key={p.name} type="button" onClick={() => void loadPeriph(p.name, false)} style={{ ...ROW, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--elab-fg-primary)' }}>
                      <span style={{ ...MONO, color: 'var(--elab-accent)', flex: '0 0 76px' }}>{p.name}</span>
                      <span style={{ ...MONO, color: 'var(--elab-fg-muted)' }}>{p.base}</span>
                      <span style={{ marginLeft: 'auto', ...MONO, color: 'var(--elab-fg-faint)' }}>{`${p.registers_count ?? 0} reg`}</span>
                    </button>
                  ))}
                </div>
              )
            })}
            {periph?.level === 'device' && svdGroups.length === 0 && (
              <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>没有匹配的外设</div>
            )}
            {periph?.level === 'peripheral' && svdRegs.map((r) => (
              <button key={r.name} type="button" onClick={() => void loadPeriph(`${periph.peripheral?.name ?? ''}.${r.name}`, true)} style={{ ...ROW, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--elab-fg-primary)' }}>
                <span style={{ ...MONO, color: 'var(--elab-accent)', flex: '0 0 86px' }}>{r.name}</span>
                <span style={{ ...MONO, color: 'var(--elab-fg-muted)' }}>{r.addr}</span>
                <span style={{ marginLeft: 'auto', ...MONO, color: 'var(--elab-fg-faint)' }}>{`${r.fields_count ?? 0} 字段`}</span>
              </button>
            ))}
            {periph?.level === 'peripheral' && svdRegs.length === 0 && (
              <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>没有匹配的寄存器</div>
            )}
            {periph?.level === 'register' && periph.register !== undefined && (
              <div>
                <div style={{ ...ROW, color: 'var(--elab-fg-primary)' }}>
                  <b style={MONO}>{`${periph.peripheral?.name ?? ''}.${periph.register.name}`}</b>
                  <span style={{ ...MONO, color: 'var(--elab-fg-muted)' }}>{periph.register.addr}</span>
                  <span style={{ marginLeft: 'auto', ...MONO, color: 'var(--elab-accent)' }}>{periph.register.value ?? '—'}</span>
                </div>
                {(periph.register.fields ?? []).map((f: DebugSvdField) => {
                  const writable = allowWrite && /write/i.test(periph.register?.access ?? '')
                  const editing = editField?.reg === `${periph.peripheral?.name ?? ''}.${periph.register?.name}`
                    && editField.offset === f.offset
                  const base = Number.parseInt(String(periph.register?.value ?? '0').replace(/^0x/, ''), 16) || 0
                  return (
                    <div key={f.name} style={ROW}>
                      <span style={{ ...MONO, color: 'var(--elab-fg-secondary)', flex: '0 0 96px' }}>{f.name}</span>
                      <span style={{ ...MONO, color: 'var(--elab-fg-muted)' }}>{`[${f.bits}]`}</span>
                      {editing ? (
                        <input
                          autoFocus
                          value={editField.value}
                          aria-label={`编辑字段 ${f.name}`}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditField({ ...editField, value: e.currentTarget.value })}
                          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                            if (e.key === 'Enter') void commitField()
                            if (e.key === 'Escape') setEditField(null)
                          }}
                          onBlur={() => setEditField(null)}
                          style={{ marginLeft: 'auto', width: '72px', padding: '0 3px', border: '1px solid var(--elab-accent)', borderRadius: '2px', background: 'var(--elab-bg-code)', color: 'var(--elab-fg-primary)', ...MONO }}
                        />
                      ) : (
                        <button
                          type="button"
                          title={writable ? `点击改写字段 ${f.name}（读-改-写）` : '字段只读'}
                          onClick={() => {
                            if (!writable || periph.register === undefined) return
                            setEditField({
                              reg: `${periph.peripheral?.name ?? ''}.${periph.register.name}`,
                              addr: periph.register.addr,
                              size: periph.register.size,
                              base,
                              offset: f.offset,
                              width: f.width,
                              value: String(f.value),
                            })
                          }}
                          style={{ marginLeft: 'auto', padding: '0 2px', border: '1px dashed transparent', borderRadius: '2px', background: 'transparent', color: 'var(--elab-fg-primary)', cursor: writable ? 'pointer' : 'default', ...MONO }}
                        >
                          {f.enum !== null ? f.enum.name : `0x${f.value.toString(16)}`}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'rtos' && snap !== null && (
          <div>
            {rtos === null ? (
              <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>（未暂停，或 ELF 里没有 FreeRTOS 调试信息）</div>
            ) : (
              <>
                <div style={{ padding: '4px 6px', color: 'var(--elab-fg-muted)', ...MONO }}>
                  {`${rtos.count} 个任务 · pxCurrentTCB ${rtos.current_tcb}${rtos.note !== undefined ? ` · ${rtos.note}` : ''}`}
                </div>
                {rtos.tasks.map((t) => (
                  <div key={t.tcb} style={ROW}>
                    <span style={{ ...MONO, flex: '0 0 96px', color: t.current ? 'var(--elab-accent)' : 'var(--elab-fg-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{`${t.current ? '*' : ''}${t.name}`}</span>
                    <span style={{ ...MONO, color: 'var(--elab-fg-muted)' }}>{t.priority ?? '—'}</span>
                    <span style={{ ...MONO, color: 'var(--elab-fg-muted)' }}>{t.state}</span>
                    <span style={{ marginLeft: 'auto', ...MONO, color: healthColor(t.health) }}>
                      {t.stack_size_bytes !== null ? `${t.free_bytes}/${t.stack_size_bytes}B` : `剩 ${t.free_words} 字`}
                    </span>
                  </div>
                ))}
                <div style={{ padding: '4px 6px', color: 'var(--elab-fg-muted)', fontSize: 'var(--elab-fs-xs)' }}>
                  水位 = 未被 0xA5 覆盖的字数（历史最小剩余）。使用率需要 pxEndOfStack，算不出就不猜（显示 —）。
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'audit' && snap !== null && (
          <div>
            <div style={{ padding: '4px 6px', color: 'var(--elab-fg-muted)', ...MONO }}>{`最近 ${audit.length} 条（.work/debug-audit.jsonl）`}</div>
            {audit.length === 0 && <div style={{ padding: '8px', color: 'var(--elab-fg-muted)', ...MONO }}>（暂无审计记录）</div>}
            {audit.slice().reverse().map((rec, i) => (
              <div key={`${rec.ts}-${i}`} style={ROW}>
                <span style={{ ...MONO, color: 'var(--elab-fg-faint)', flex: '0 0 62px' }}>{new Date(rec.ts * 1000).toLocaleTimeString()}</span>
                <span style={{ ...MONO, color: 'var(--elab-accent)', flex: '0 0 auto' }}>{rec.action}</span>
                <span style={{ ...MONO, color: 'var(--elab-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[rec.actor, rec.target, rec.addr, rec.value, rec.location, rec.name].filter((x) => x !== undefined && x !== '').join(' ')}
                </span>
              </div>
            ))}
          </div>
        )}

        {tab === 'out' && (
          <div style={{ padding: '4px 6px' }}>
            {output.length === 0 && <div style={{ color: 'var(--elab-fg-muted)', ...MONO }}>（MI 输出会出现在这里）</div>}
            {output.map((l) => (
              <div key={l.id} style={{ ...MONO, color: l.tone === 'alert' ? 'var(--elab-status-fail)' : 'var(--elab-fg-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {l.text}
              </div>
            ))}
          </div>
        )}
      </div>

      {wide && (tab === 'stack' || tab === 'vars' || tab === 'watch') && (
        <aside style={{ flex: '0 0 42%', minWidth: '170px', borderLeft: '1px solid var(--elab-border)', overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 6px', borderBottom: '1px solid var(--elab-border)' }}>
            <span style={{ ...MONO, color: 'var(--elab-fg-muted)' }}>寄存器</span>
            {snap?.svd.available === true && <span style={{ ...MONO, color: 'var(--elab-fg-faint)' }}>· SVD 就绪</span>}
            <button type="button" onClick={() => setTab('regs')} style={{ ...BTN, marginLeft: 'auto' }}>全屏</button>
          </div>
          {regs.map((g) => (
            <div key={g.name}>
              <div style={{ padding: '3px 6px', color: 'var(--elab-fg-muted)', ...MONO }}>{g.label}</div>
              {g.regs.map((r) => (
                <div key={r.name} style={ROW}>
                  <span style={{ color: r.pc ? 'var(--elab-accent)' : 'var(--elab-fg-secondary)', flex: '0 0 48px', ...MONO }}>{r.name}</span>
                  <span style={{ color: 'var(--elab-fg-primary)', ...MONO }}>{r.hex}</span>
                </div>
              ))}
            </div>
          ))}
          {regs.length === 0 && <div style={{ padding: '6px', color: 'var(--elab-fg-muted)', ...MONO }}>（目标运行中，寄存器不可读）</div>}
          <div style={{ display: 'flex', gap: '4px', padding: '4px 6px', borderTop: '1px solid var(--elab-border)' }}>
            <span style={{ ...MONO, color: 'var(--elab-fg-muted)' }}>外设</span>
            <button type="button" onClick={() => setTab('periph')} style={{ ...BTN, marginLeft: 'auto' }}>打开</button>
          </div>
        </aside>
      )}

      {wide && (tab === 'regs' || tab === 'periph') && (
        <aside style={{ flex: '0 0 40%', minWidth: '160px', order: -1, borderRight: '1px solid var(--elab-border)', overflow: 'auto' }}>
          <div style={{ padding: '4px 6px', borderBottom: '1px solid var(--elab-border)', color: 'var(--elab-fg-muted)', ...MONO }}>调用栈</div>
          {frames.slice(0, 12).map((f, i) => (
            <button
              key={`${f.addr}-${i}`}
              type="button"
              onClick={() => { setTab('stack'); selectFrame(i) }}
              style={{ ...ROW, width: '100%', border: 'none', borderBottom: '1px solid var(--elab-border)', background: i === frameIdx ? 'var(--elab-bg-raised)' : 'transparent', color: 'var(--elab-fg-primary)', cursor: 'pointer' }}
            >
              <span style={{ ...MONO, color: 'var(--elab-accent)', flex: '0 0 18px' }}>{`#${i}`}</span>
              <span style={{ ...MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.func || f.addr}</span>
            </button>
          ))}
          {frames.length === 0 && <div style={{ padding: '6px', color: 'var(--elab-fg-muted)', ...MONO }}>（暂停后可见）</div>}
        </aside>
      )}
      </div>

      {/* 底部提示 */}
      {snap !== null && (
        <div style={{ flex: '0 0 auto', padding: '3px 6px', borderTop: '1px solid var(--elab-border)', color: 'var(--elab-fg-muted)', fontSize: 'var(--elab-fs-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {snap.chip !== '' ? `${snap.chip} · gdb server:${snap.port}` : `gdb server:${snap.port}`}
          {snap.svd.available ? ' · SVD 就绪' : ''}
          {' · 关闭会话会自动恢复运行'}
        </div>
      )}
    </div>
  )
}

type MemRow = { addr: string; bytes: string[]; ascii: string }

/** 16 字节一行（字节单元可编辑 → 需要独立展示，不能再拼成一段文本）。 */
function memRows(m: DebugMemoryResponse): MemRow[] {
  const raw = m.bytes.split(/\s+/).filter((x) => x !== '')
  const start = Number.parseInt(m.addr, 16)
  if (raw.length === 0 || !Number.isFinite(start)) return []
  const rows: MemRow[] = []
  for (let i = 0; i < raw.length; i += 16) {
    const chunk = raw.slice(i, i + 16)
    rows.push({
      addr: `0x${(start + i).toString(16).padStart(8, '0')}`,
      bytes: chunk,
      ascii: chunk.map((b) => {
        const n = Number.parseInt(b, 16)
        return n >= 32 && n < 127 ? String.fromCharCode(n) : '.'
      }).join(''),
    })
  }
  return rows
}

function healthColor(h: 'ok' | 'warn' | 'critical'): string {
  if (h === 'critical') return 'var(--elab-status-fail)'
  if (h === 'warn') return 'var(--elab-status-run)'
  return 'var(--elab-fg-muted)'
}

/** 变量行（递归展开；`children` 缓存按 path 存）。 */
function VarRow(props: {
  node: DebugVarNode
  path: string
  depth: number
  open: Record<string, DebugVarNode[]>
  onToggle: (node: DebugVarNode, path: string) => Promise<void>
  key?: string
}): React.ReactElement {
  const { node, path, depth, open, onToggle } = props
  const kids = open[path]
  return (
    <div>
      <div style={{ ...ROW, paddingLeft: `${6 + depth * 12}px` }}>
        {node.has_children ? (
          <button
            type="button"
            onClick={() => void onToggle(node, path)}
            style={{ border: 'none', background: 'transparent', color: 'var(--elab-accent)', cursor: 'pointer', padding: 0, width: '10px' }}
          >
            {kids === undefined ? '▸' : '▾'}
          </button>
        ) : <span style={{ width: '10px' }} />}
        <span style={{ color: 'var(--elab-fg-secondary)', ...MONO }}>{node.name}</span>
        {node.type !== '' && <span style={{ color: 'var(--elab-fg-faint)', ...MONO }}>{node.type}</span>}
        <span style={{ marginLeft: 'auto', color: 'var(--elab-fg-primary)', ...MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.value}</span>
      </div>
      {kids !== undefined && kids.map((c) => (
        <VarRow key={`${path}.${c.name}`} node={c} path={`${path}.${c.name}`} depth={depth + 1} open={open} onToggle={onToggle} />
      ))}
    </div>
  )
}
