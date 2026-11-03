/**
 * 串口监视的**数据面**：双游标（行 + 字节批次）+ 连接纪元。
 * 移植自 `cockpit/web/src/serial/useSerialStream.ts`，差异只有取数口：
 * 这里走注入的串口端口（`SerialPort`，组装点在 CockpitPane），不 import 内核源码、
 * 也不 import 兄弟适配器。
 *
 * ★ 纪元纪律：`epoch` 每次 open 自增。发现变化 → **立即重置两个游标**。
 * ★ 轮询而非 SSE：串口流不属于任何 run，500ms 一次足够"人眼实时"。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { SerialPort } from '../../../app/ports.ts'
import type {
  SerialChunk,
  SerialDecodedFrame,
  SerialDecodedTail,
  SerialMonitorLine,
  SerialMonitorSnapshot,
} from '../../../domain/icd.ts'

export const SERIAL_POLL_MS = 500
const MAX_LOCAL_LINES = 2000
const MAX_LOCAL_CHUNKS = 4096
const MAX_LOCAL_BYTES = 1 << 20
/** 本地波形帧上限；与服务端帧环（1024）同量级，多出的按帧序号挤掉。 */
const MAX_LOCAL_DEC_FRAMES = 1024

export interface SerialSendOpts {
  format: string
  eol: string
  encoding?: string
}

export interface SerialStream {
  snap: SerialMonitorSnapshot | null
  active: boolean
  paused: boolean
  lines: SerialMonitorLine[]
  chunks: SerialChunk[]
  /** 行/批次被环形缓冲挤掉的累计数（只增不减；clear 不重置） */
  gapLines: number
  gapChunks: number
  gapDecoded: number
  /**
   * 会话级共享解码帧（P3.5）：agent 选定 decoder 后，内核在 RX 入环时增量解码，
   * 这里拉到的就是**人看到的波形**本身 —— agent 与面板同源。
   */
  decoded: SerialDecodedFrame[]
  decodedSnap: SerialDecodedTail | null
  error: string | null
  /** 打开监视；`decoder` = 上次选定（跨会话记忆，缺省为空 = 不启用共享解码）。 */
  open(decoder?: string): Promise<{ ok: boolean; error?: string }>
  close(): Promise<void>
  clear(): Promise<void>
  setPaused(next: boolean): Promise<void>
  /** 选解码器（human 面板操作；agent 用 action=decoder 走同一条会话属性）。 */
  setDecoder(decoder: string): Promise<{ ok: boolean; error?: string }>
  send(data: string, opts: SerialSendOpts): Promise<{
    ok: boolean
    written: number
    port: string
    baud: number
    /** 服务端实际使用的格式（auto 会落成 utf8/hex） */
    format?: string
    /** 实际追加的行尾（HEX 为空串） */
    eol?: string
    via?: 'monitor'
    echoed: string[]
    read_ms: number
    error: string | null
  }>
}

export interface UseSerialStreamArgs {
  /** 串口数据面端口（CockpitPane 注入 elabApi 的串口子集）。 */
  api: SerialPort
  /** capabilities 里那份快照（别处已开的会话也能看见） */
  initial: SerialMonitorSnapshot | null
  project: string
  port: string
  baud: number
  /** 只有串口通道可见时才轮询 */
  enabled: boolean
  sessionId?: string
}

export function useSerialStream({ api, initial, project, port, baud, enabled, sessionId }: UseSerialStreamArgs): SerialStream {
  const [snap, setSnap] = useState<SerialMonitorSnapshot | null>(initial)
  const [lines, setLines] = useState<SerialMonitorLine[]>([])
  const [chunks, setChunks] = useState<SerialChunk[]>([])
  const [decoded, setDecoded] = useState<SerialDecodedFrame[]>([])
  const [decodedSnap, setDecodedSnap] = useState<SerialDecodedTail | null>(null)
  const [gaps, setGaps] = useState({ lines: 0, chunks: 0, decoded: 0 })
  const [error, setError] = useState<string | null>(null)

  const snapRef = useRef<SerialMonitorSnapshot | null>(initial)
  const lineCursor = useRef(0)
  const chunkCursor = useRef(0)
  /** 共享解码帧游标（帧序号单调；换 decoder / clear 都不回退） */
  const decCursor = useRef(0)
  /** 上一次拉到的 decoder —— 变化即本地帧重新开始（不同解码器的值不可混画） */
  const decDecoder = useRef('')
  const epochRef = useRef<number>(-1)
  const bytesRef = useRef(0)
  /** 请求代际：clear / 重开之后，忽略在途的旧响应 */
  const genRef = useRef(0)
  const busyRef = useRef(false)

  const active = snap?.active === true
  const paused = snap?.paused === true

  const remember = useCallback((next: SerialMonitorSnapshot) => {
    snapRef.current = { ...(snapRef.current ?? {}), ...next }
    setSnap(snapRef.current)
  }, [])

  /** 重置本地镜像与游标（清空/换纪元时用） */
  const resetLocal = useCallback(() => {
    lineCursor.current = 0
    chunkCursor.current = 0
    decCursor.current = 0
    decDecoder.current = ''
    bytesRef.current = 0
    setLines([])
    setChunks([])
    setDecoded([])
    setDecodedSnap(null)
    setGaps({ lines: 0, chunks: 0, decoded: 0 })
  }, [])

  const seedFromSnapshot = useCallback((s: SerialMonitorSnapshot) => {
    snapRef.current = s
    epochRef.current = s.epoch ?? 0
    lineCursor.current = 0
    chunkCursor.current = 0
    decCursor.current = 0
    bytesRef.current = 0
    setSnap(s)
  }, [])

  // ── 轮询 ────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !active) return
    let disposed = false

    const tick = async (): Promise<void> => {
      if (busyRef.current) return
      busyRef.current = true
      const gen = genRef.current
      try {
        // 快照上 decoder 非空 = 会话已启用共享解码（agent 或人选定），才拉帧。
        const wantDecoded = (snapRef.current?.decode?.decoder ?? '') !== ''
        const [lt, bt, dt] = await Promise.all([
          api.serialMonitor(lineCursor.current, sessionId),
          api.serialMonitorBytes(chunkCursor.current, { sessionId }),
          wantDecoded
            ? api.serialMonitorDecoded(decCursor.current, sessionId)
            : Promise.resolve(null),
        ])
        if (disposed || gen !== genRef.current) return

        // ① 纪元变化 = 有人重开了会话 → 两个游标必须一起重置。
        const ep = lt.epoch ?? bt.epoch ?? 0
        if (epochRef.current !== ep) {
          epochRef.current = ep
          resetLocal()
          remember(lt)
          return
        }

        remember(lt)

        // ② 行：游标按服务端累计值走（paused/被挤掉时也能正确前进）
        if (lt.lines.length > 0) {
          setLines((prev) => {
            const next = prev.concat(lt.lines)
            return next.length > MAX_LOCAL_LINES ? next.slice(next.length - MAX_LOCAL_LINES) : next
          })
        }
        const missedLines = (lt.seq ?? lineCursor.current) - lineCursor.current - lt.lines.length
        lineCursor.current = lt.seq ?? lineCursor.current
        if (lt.gap > 0 || missedLines > 0) {
          const lost = Math.max(lt.gap, missedLines)
          setGaps((g) => ({ ...g, lines: g.lines + lost }))
        }

        // ③ 字节批次（始终按 all 拉；方向过滤在客户端做，避免切方向时游标失真）
        if (bt.chunks.length > 0) {
          setChunks((prev) => {
            const next = prev.concat(bt.chunks)
            let total = bytesRef.current + bt.chunks.reduce((n, c) => n + c.len, 0)
            let cut = 0
            while (cut < next.length && (next.length - cut > MAX_LOCAL_CHUNKS || total > MAX_LOCAL_BYTES)) {
              total -= next[cut].len
              cut += 1
            }
            bytesRef.current = total
            return cut > 0 ? next.slice(cut) : next
          })
        }
        const missedChunks = (bt.chunk_seq ?? chunkCursor.current) - chunkCursor.current - bt.chunks.length
        chunkCursor.current = bt.chunk_seq ?? chunkCursor.current
        if (bt.gap > 0 || missedChunks > 0) {
          const lost = Math.max(bt.gap, missedChunks)
          setGaps((g) => ({ ...g, chunks: g.chunks + lost }))
        }

        // ④ 共享解码帧（P3.5）：同一份帧就是面板波形页画的（agent 与人同图）
        if (dt !== null) {
          setDecodedSnap(dt)
          if (dt.decoder !== decDecoder.current) {
            // 换了解码器：旧帧的值来自别一种协议，不能混画；帧序号仍单调，游标不回退。
            decDecoder.current = dt.decoder
            setDecoded([])
          }
          if (dt.frames.length > 0) {
            setDecoded((prev) => {
              const next = prev.concat(dt.frames)
              return next.length > MAX_LOCAL_DEC_FRAMES
                ? next.slice(next.length - MAX_LOCAL_DEC_FRAMES)
                : next
            })
          }
          const missedFrames = dt.next_after - decCursor.current - dt.frames.length
          decCursor.current = dt.next_after
          if (dt.gap > 0 || missedFrames > 0) {
            const lost = Math.max(dt.gap, missedFrames)
            setGaps((g) => ({ ...g, decoded: g.decoded + lost }))
          }
        }

        // ⑤ 读线程异常自愈 / 别处关了 → 如实收尾
        if (!lt.active) {
          if (lt.error !== undefined && lt.error !== null) setError(lt.error)
          remember({ ...lt, active: false })
        }
      } catch {
        /* 网络抖动：下一轮再试（不做自动重试轰炸） */
      } finally {
        busyRef.current = false
      }
    }

    void tick()
    const id = window.setInterval(() => void tick(), SERIAL_POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(id)
      busyRef.current = false
    }
  }, [enabled, active, sessionId, resetLocal, remember, api])

  // ── 会话操作 ────────────────────────────────────────────────
  const open = useCallback(async (decoder?: string): Promise<{ ok: boolean; error?: string }> => {
    genRef.current += 1
    setError(null)
    try {
      const r = (await api.serialMonitorToggle('open', {
        project,
        baud,
        port,
        actor: 'human',
        ...(decoder !== undefined && decoder !== '' ? { decoder } : {}),
        sessionId,
      })) as unknown as SerialMonitorSnapshot & { ok?: boolean; error?: string }
      if (r.active !== true) {
        const msg = r.error ?? '未知原因'
        setError(msg)
        return { ok: false, error: msg }
      }
      epochRef.current = r.epoch ?? 0
      resetLocal()
      remember(r)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      return { ok: false, error: msg }
    }
  }, [project, baud, port, sessionId, resetLocal, remember, api])

  const close = useCallback(async (): Promise<void> => {
    genRef.current += 1
    try {
      await api.serialMonitorToggle('close', { sessionId })
    } catch {
      /* 关闭失败也让界面收尾：口可能已经被读线程释放 */
    }
    remember({ active: false })
  }, [sessionId, remember, api])

  const clear = useCallback(async (): Promise<void> => {
    genRef.current += 1
    try {
      await api.serialMonitorToggle('clear', { sessionId })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    // seq/chunk_seq 不回退（服务端保持单调），游标停在当前累计值即可
    lineCursor.current = snapRef.current?.seq ?? lineCursor.current
    chunkCursor.current = snapRef.current?.chunk_seq ?? chunkCursor.current
    bytesRef.current = 0
    setLines([])
    setChunks([])
    setDecoded([])
    setDecodedSnap(null)
    setGaps({ lines: 0, chunks: 0, decoded: 0 })
  }, [sessionId, api])

  /**
   * 选解码器（human 选定）—— 写的是**会话属性**，所以 agent 随后用
   * `elab_serial_decoded` 读到的帧，与这里面板画的帧是同一份。
   */
  const setDecoder = useCallback(
    async (decoder: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const r = (await api.serialMonitorToggle('decoder', {
          decoder,
          actor: 'human',
          sessionId,
        })) as unknown as { ok?: boolean; error?: string; active?: boolean }
        if (r.ok === false) {
          setError(r.error ?? '设置解码器失败')
          return { ok: false, error: r.error ?? '设置解码器失败' }
        }
        // 本地帧从新解码器重新开始；游标保持（服务端帧序号单调，不回退）
        decDecoder.current = decoder
        setDecoded([])
        setDecodedSnap(null)
        // 快照里的 decode 投影立即跟着变，下一轮 tick 就会开始拉帧（不用等一次往返）
        if (snapRef.current !== null) {
          const prevDecode = snapRef.current.decode
          remember({
            ...snapRef.current,
            decode: {
              decoder,
              decoder_by: 'human',
              channels: prevDecode?.channels ?? 0,
              total_frames: 0,
              skipped: 0,
              pending_bytes: 0,
              covered: prevDecode?.covered ?? 0,
              updated_at: Date.now() / 1000,
              error: null,
            },
          })
        }
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        return { ok: false, error: msg }
      }
    },
    [sessionId, remember, api],
  )

  const setPaused = useCallback(
    async (next: boolean): Promise<void> => {
      try {
        const r = await api.serialMonitorToggle(next ? 'pause' : 'resume', { sessionId })
        if (snapRef.current !== null) {
          remember({ ...snapRef.current, paused: (r.paused as boolean | undefined) ?? next })
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [sessionId, remember, api],
  )

  const send = useCallback(
    (data: string, opts: SerialSendOpts) =>
      api.serial({
        project,
        data,
        port,
        baud,
        format: opts.format,
        eol: opts.eol,
        ...(opts.encoding !== undefined ? { encoding: opts.encoding } : {}),
        sessionId,
      }),
    [project, port, baud, sessionId, api],
  )

  // initial 变化（别处开了会话后 caps 刷新）时同步一次
  useEffect(() => {
    if (initial !== null && initial.active === true && snapRef.current?.active !== true) seedFromSnapshot(initial)
  }, [initial, seedFromSnapshot])

  return {
    snap,
    active,
    paused,
    lines,
    chunks,
    decoded,
    decodedSnap,
    gapLines: gaps.lines,
    gapChunks: gaps.chunks,
    gapDecoded: gaps.decoded,
    error,
    open,
    close,
    clear,
    setPaused,
    setDecoder,
    send,
  }
}
