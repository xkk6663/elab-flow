/**
 * 串口监视的**数据面**（P1）：双游标（行 + 字节批次）+ 连接纪元。
 *
 * 为什么需要一个 hook：
 *   监视是**服务进程的单例**，但界面可能同时有多个消费点（工具栏状态、
 *   工作区视图）。若各自轮询，游标会互相偷吃（一个组件推进了 `after`，
 *   另一个就永远收不到那一段）。这里只保留一套游标，视图只读。
 *
 * ★ 纪元纪律：`epoch` 每次 open 自增。发现变化 → **立即重置两个游标**。
 *   不重置的后果：重开监视后服务端 `seq/chunk_seq` 从 1 开始，旧游标（例如 800）
 *   会让界面静默地"永远没有新数据"——不报错，只是不动。
 *
 * 轮询而非 SSE：串口流不属于任何 run（C17/C24），刻意不新增 SSE topic；
 * 500ms 一次拉取足够"人眼实时"，又不会把服务端拖成热点。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type {
  SerialChunk,
  SerialFormat,
  SerialMonitorLine,
  SerialMonitorSnapshot,
  SerialWriteResult,
} from "../api/types";

export const SERIAL_POLL_MS = 500;
/** 本地镜像上限：与服务端同一数量级，防长时间开着把页面内存吃光。 */
const MAX_LOCAL_LINES = 2000;
const MAX_LOCAL_CHUNKS = 4096;
const MAX_LOCAL_BYTES = 1 << 20;

export interface SerialSendOpts {
  format: SerialFormat;
  eol: string;
  encoding?: string;
}

export interface SerialStream {
  snap: SerialMonitorSnapshot | null;
  active: boolean;
  paused: boolean;
  lines: SerialMonitorLine[];
  chunks: SerialChunk[];
  /** 行/批次被环形缓冲挤掉的累计数（只增不减；clear 不重置） */
  gapLines: number;
  gapChunks: number;
  error: string | null;
  open(): Promise<{ ok: boolean; error?: string }>;
  close(): Promise<void>;
  clear(): Promise<void>;
  setPaused(next: boolean): Promise<void>;
  send(data: string, opts: SerialSendOpts): Promise<SerialWriteResult>;
}

export interface UseSerialStreamArgs {
  /** capabilities 里那份快照（别的标签页开的会话也能看见） */
  initial: SerialMonitorSnapshot | null;
  project: string;
  port: string;
  baud: number;
  /** 只有串口工作区可见时才轮询（离开页面就别占带宽） */
  enabled: boolean;
}

export function useSerialStream({
  initial,
  project,
  port,
  baud,
  enabled,
}: UseSerialStreamArgs): SerialStream {
  const [snap, setSnap] = useState<SerialMonitorSnapshot | null>(initial);
  const [lines, setLines] = useState<SerialMonitorLine[]>([]);
  const [chunks, setChunks] = useState<SerialChunk[]>([]);
  const [gaps, setGaps] = useState({ lines: 0, chunks: 0 });
  const [error, setError] = useState<string | null>(null);

  const snapRef = useRef<SerialMonitorSnapshot | null>(initial);
  const lineCursor = useRef(0);
  const chunkCursor = useRef(0);
  const epochRef = useRef<number>(-1);
  const bytesRef = useRef(0);
  /** 请求代际：clear / 重开之后，忽略在途的旧响应 */
  const genRef = useRef(0);
  const busyRef = useRef(false);

  const active = !!snap?.active;
  const paused = !!snap?.paused;

  const remember = useCallback((next: SerialMonitorSnapshot) => {
    snapRef.current = { ...snapRef.current, ...next };
    setSnap(snapRef.current);
  }, []);

  /** 重置本地镜像与游标（清空/换纪元时用） */
  const resetLocal = useCallback(() => {
    lineCursor.current = 0;
    chunkCursor.current = 0;
    bytesRef.current = 0;
    setLines([]);
    setChunks([]);
    setGaps({ lines: 0, chunks: 0 });
  }, []);

  const seedFromSnapshot = useCallback((s: SerialMonitorSnapshot) => {
    snapRef.current = s;
    epochRef.current = s.epoch ?? 0;
    // ★ 接入**别人开的**会话时从 0 追起：服务端环形缓冲里已有的内容
    //   应当对当前标签页可见（而不是"从接入这一刻起才有画面"）。
    lineCursor.current = 0;
    chunkCursor.current = 0;
    bytesRef.current = 0;
    setSnap(s);
  }, []);

  // ── 轮询 ────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !active) return;
    let disposed = false;

    const tick = async () => {
      if (busyRef.current) return;          // 上一轮还没回来，跳过（防雪崩）
      busyRef.current = true;
      const gen = genRef.current;
      try {
        const [lt, bt] = await Promise.all([
          api.serialMonitor(lineCursor.current),
          api.serialMonitorBytes(chunkCursor.current),
        ]);
        if (disposed || gen !== genRef.current) return;

        // ① 纪元变化 = 有人重开了会话 → 两个游标必须一起重置。
        const ep = lt.epoch ?? bt.epoch ?? 0;
        if (epochRef.current !== ep) {
          epochRef.current = ep;
          resetLocal();
          remember(lt);
          return;
        }

        remember(lt);

        // ② 行：游标按服务端累计值走（paused/被挤掉时也能正确前进）
        if (lt.lines.length) {
          setLines((prev) => {
            const next = prev.concat(lt.lines);
            return next.length > MAX_LOCAL_LINES
              ? next.slice(next.length - MAX_LOCAL_LINES)
              : next;
          });
        }
        const missed =
          (lt.seq ?? lineCursor.current) - lineCursor.current - lt.lines.length;
        lineCursor.current = lt.seq ?? lineCursor.current;
        if (lt.gap > 0 || missed > 0) {
          const lost = Math.max(lt.gap, missed);
          setGaps((g) => ({ ...g, lines: g.lines + lost }));
        }

        // ③ 字节批次（**始终按 all 拉**；方向过滤在客户端做，避免切方向时游标失真）
        if (bt.chunks.length) {
          setChunks((prev) => {
            const next = prev.concat(bt.chunks);
            let total = bytesRef.current + bt.chunks.reduce((n, c) => n + c.len, 0);
            let cut = 0;
            while (
              cut < next.length &&
              (next.length - cut > MAX_LOCAL_CHUNKS || total > MAX_LOCAL_BYTES)
            ) {
              total -= next[cut].len;
              cut += 1;
            }
            bytesRef.current = total;
            return cut ? next.slice(cut) : next;
          });
        }
        const missedChunks =
          (bt.chunk_seq ?? chunkCursor.current) - chunkCursor.current - bt.chunks.length;
        chunkCursor.current = bt.chunk_seq ?? chunkCursor.current;
        if (bt.gap > 0 || missedChunks > 0) {
          const lost = Math.max(bt.gap, missedChunks);
          setGaps((g) => ({ ...g, chunks: g.chunks + lost }));
        }

        // ④ 读线程异常自愈 / 别的标签页关了 → 如实收尾
        if (!lt.active) {
          if (lt.error) setError(lt.error);
          remember({ ...lt, active: false });
        }
      } catch {
        /* 网络抖动：下一轮再试（不做自动重试轰炸） */
      } finally {
        busyRef.current = false;
      }
    };

    void tick();
    const id = window.setInterval(tick, SERIAL_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(id);
      busyRef.current = false;
    };
  }, [enabled, active, resetLocal, remember]);

  // ── 会话操作 ────────────────────────────────────────────────
  const open = useCallback(async () => {
    genRef.current += 1;
    setError(null);
    try {
      const r = await api.serialMonitorToggle("open", { project, baud, port });
      if (!r.active) {
        const msg = r.error ?? "未知原因";
        setError(msg);
        return { ok: false, error: msg };
      }
      epochRef.current = r.epoch ?? 0;
      resetLocal();
      remember(r);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      return { ok: false, error: msg };
    }
  }, [project, baud, port, resetLocal, remember]);

  const close = useCallback(async () => {
    genRef.current += 1;
    try {
      await api.serialMonitorToggle("close");
    } catch {
      /* 关闭失败也让界面收尾：口可能已经被读线程释放 */
    }
    remember({ active: false });
  }, [remember]);

  const clear = useCallback(async () => {
    genRef.current += 1;
    try {
      await api.serialMonitorToggle("clear");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    // seq/chunk_seq 不回退（服务端保持单调），游标停在当前累计值即可。
    lineCursor.current = snapRef.current?.seq ?? lineCursor.current;
    chunkCursor.current = snapRef.current?.chunk_seq ?? chunkCursor.current;
    bytesRef.current = 0;
    setLines([]);
    setChunks([]);
    setGaps({ lines: 0, chunks: 0 });
  }, []);

  const setPaused = useCallback(
    async (next: boolean) => {
      try {
        const r = await api.serialMonitorToggle(next ? "pause" : "resume");
        if (snapRef.current) {
          remember({ ...snapRef.current, paused: r.paused ?? next });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [remember],
  );

  const send = useCallback(
    (data: string, opts: SerialSendOpts) =>
      api.serial({
        project,
        data,
        port,
        baud,
        format: opts.format,
        eol: opts.eol,
        encoding: opts.encoding,
      }),
    [project, port, baud],
  );

  // initial 变化（别的标签页在 caps 刷新后体现）时同步一次
  useEffect(() => {
    if (initial && initial.active && !snapRef.current?.active) {
      seedFromSnapshot(initial);
    }
  }, [initial, seedFromSnapshot]);

  return {
    snap,
    active,
    paused,
    lines,
    chunks,
    gapLines: gaps.lines,
    gapChunks: gaps.chunks,
    error,
    open,
    close,
    clear,
    setPaused,
    send,
  };
}
