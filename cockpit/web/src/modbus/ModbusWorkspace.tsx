/**
 * Modbus 工作区（WebUI）：把主站的能力直接摆到面板上 —— 开/关、轮询、单次读写、
 * 点表实时值、事务流水，以及 DMA 双缓冲诊断。
 *
 * 设计取向（与串口/调试工作区一致）：
 *  - **单一轮询源**：300ms 只打 `/api/modbus/state` 一条（引擎快照 + 增量事务 + 点表），
 *    不做 N 个点各发一条请求 —— 面板的刷新节奏与从站的分组节奏解耦；
 *  - **数值就是证据**：点表每行显示"原始值 → 换算值 + 单位 + 多久之前 + 错误分类"，
 *    超时/异常码不会被悄悄忽略（error 字段直接上色）；
 *  - **写要有摩擦**：面板写寄存器前弹一次 `window.confirm`，把"我要动物理世界"这个
 *    念头强制过一遍；内核侧还要求 `confirm=true`，两层都不省；
 *  - **诊断不另做页面**：地址落在 0x0100..0x010F 的点自动聚成"双缓冲诊断"卡片区，
 *    教程里那几个能证明 DBM 在跑的计数就住在这里（与点表同一份数据，不会对不上）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "../api/client";
import { Button } from "../primitives/Button";
import s from "./ModbusWorkspace.module.css";
import type {
  ModbusEngineState,
  ModbusMap,
  ModbusPointLive,
  ModbusRunResult,
  ModbusStateResponse,
  ModbusTxn,
} from "./types";

const FC_READ = [
  { v: 1, label: "01 读线圈" },
  { v: 2, label: "02 读离散输入" },
  { v: 3, label: "03 读保持寄存器" },
  { v: 4, label: "04 读输入寄存器" },
];

const FC_WRITE = [
  { v: 5, label: "05 写单线圈" },
  { v: 6, label: "06 写单寄存器" },
  { v: 15, label: "15 写多线圈" },
  { v: 16, label: "16 写多寄存器" },
];

const POLL_MS = 300;
const MAX_TXNS = 60;

export interface ModbusWorkspaceProps {
  project: string;
  /** 串口后端是否可用（不可用时按钮置灰，理由与串口工作区同源）。 */
  serialAvailable: boolean;
  serialHint?: string;
}

function fmtValue(p: ModbusPointLive): string {
  const v = p.value;
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(v);
}

function ageText(ts: number): string {
  if (!ts) return "—";
  const d = Date.now() / 1000 - ts;
  if (d < 1) return "刚刚";
  if (d < 60) return `${d.toFixed(1)}s`;
  if (d < 3600) return `${Math.round(d / 60)}m`;
  return `${Math.round(d / 3600)}h`;
}

function errText(r: ModbusRunResult | null): { text: string; ok: boolean } {
  if (!r) return { text: "", ok: true };
  if (r.ok) {
    if (r.broadcast) return { text: "广播写已发出（不等应答）", ok: true };
    const vals = (r.values ?? []).map((v) => String(v)).join(", ");
    const echo =
      r.response && r.response.echo_address !== undefined
        ? `回显 addr=${r.response.echo_address} value=${r.response.echo_value}`
        : "";
    return {
      text: `OK  ${r.elapsed_ms ?? 0}ms / ${r.attempts ?? 1} 次  ${echo}${vals ? `  values=[${vals}]` : ""}`,
      ok: true,
    };
  }
  const e = r.error;
  return {
    text: `失败  ${e?.kind ?? "?"}${e?.code_name ? `（${e.code_name}）` : ""}  ${e?.detail ?? ""}`,
    ok: false,
  };
}

export function ModbusWorkspace({ project, serialAvailable, serialHint }: ModbusWorkspaceProps) {
  const [st, setSt] = useState<ModbusStateResponse | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [last, setLast] = useState<ModbusRunResult | null>(null);
  /** 上一次结果是哪个动作产生的：读 / 写 / 打开时探测（结果行据此换标题，
   *  否则"打开时的 probe 结果"会顶着「单次写」的帽子出现，读的人一头雾水）。 */
  const [lastKind, setLastKind] = useState<'probe' | 'read' | 'write'>('probe');

  // 连接参数（打开时生效；改完要重开 —— 与串口"打开时属性"同一个道理）
  const [unit, setUnit] = useState("1");
  const [timeoutMs, setTimeoutMs] = useState("120");
  const [retries, setRetries] = useState("2");

  // 单次读
  const [rFc, setRFc] = useState(3);
  const [rAddr, setRAddr] = useState("0");
  const [rCount, setRCount] = useState("6");

  // 单次写
  const [wFc, setWFc] = useState(6);
  const [wAddr, setWAddr] = useState("16");
  const [wValue, setWValue] = useState("1");
  /** FC15/16 的批量值：逗号/空格分隔，写前解析成 number[]（内核要 values 数组）。 */
  const [wValues, setWValues] = useState("1,0,1,0");

  const seqRef = useRef(0);
  const txnsRef = useRef<ModbusTxn[]>([]);
  const [txns, setTxns] = useState<ModbusTxn[]>([]);

  const engine: ModbusEngineState | null = st?.engine?.active ? st.engine : null;
  const map: ModbusMap | undefined = st?.map;
  const points: ModbusPointLive[] = useMemo(() => {
    if (engine?.points && engine.points.length > 0) return engine.points;
    return (map?.points ?? []).map((def) => ({
      name: def.name,
      def,
      raw: null,
      value: null,
      unit: def.unit ?? "",
      ts: 0,
      error: "",
    }));
  }, [engine, map]);

  /** DMA 诊断点：地址落在 0x0100..0x010F 且是读保持寄存器 —— 教程里那几个计数。 */
  const diagPoints = useMemo(
    () => points.filter((p) => p.def.fc === 3 && p.def.address >= 0x0100 && p.def.address <= 0x010f),
    [points],
  );

  /** 写表单的地址说明：**按点表反查**，面板不硬编码某个例程的地址含义
   *  （上一版写死"0x10 = LED"，换个从站就变成误导）。 */
  const wTarget = useMemo(() => {
    const addr = Number(wAddr);
    if (!Number.isFinite(addr)) return undefined;
    return points.find((p) => p.def.address === addr);
  }, [points, wAddr]);

  const poll = useCallback(async () => {
    try {
      const res = await api.modbusState(project, seqRef.current);
      setSt(res);
      setErr("");
      if (Array.isArray(res.transactions) && res.transactions.length > 0) {
        const merged = [...txnsRef.current, ...res.transactions].slice(-MAX_TXNS);
        txnsRef.current = merged;
        setTxns(merged);
        seqRef.current = merged[merged.length - 1]?.seq ?? seqRef.current;
      }
    } catch (e) {
      // 轮询失败不该把界面刷成红：只在顶部留一行理由，继续下一轮
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, [project]);

  useEffect(() => {
    seqRef.current = 0;
    txnsRef.current = [];
    setTxns([]);
    setSt(null);
    setLast(null);
  }, [project]);

  useEffect(() => {
    void poll();
    const t = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(t);
  }, [poll]);

  const guard = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}：${e.message}` : String(e));
    } finally {
      setBusy("");
    }
  };

  const doOpen = () =>
    guard("open", async () => {
      const res = await api.modbusOpen({
        project,
        unit_id: Number(unit) || 1,
        timeout_ms: Number(timeoutMs) || 120,
        retries: Number(retries) || 0,
        probe: true,
      });
      const pr = res.probe as ModbusRunResult | undefined;
      if (pr) {
        setLast(pr);
        setLastKind('probe');
      }
      await poll();
    });

  const doClose = () =>
    guard("close", async () => {
      await api.modbusClose();
      await poll();
    });

  const doStart = () =>
    guard("start", async () => {
      await api.modbusStart();
      await poll();
    });

  const doStop = () =>
    guard("stop", async () => {
      await api.modbusStop();
      await poll();
    });

  const doRead = () =>
    guard("read", async () => {
      const r = await api.modbusRead({
        fc: rFc,
        address: Number(rAddr) || 0,
        count: Number(rCount) || 1,
      });
      setLast(r);
      setLastKind('read');
      await poll();
    });

  const doWrite = () => {
    const addr = Number(wAddr) || 0;
    const val = Number(wValue) || 0;
    const multi = wFc === 15 || wFc === 16;
    // FC15/16 走 values 数组（内核拒收"批量写但没 values"）；FC05/06 走单值
    const vals = wValues
      .split(/[\s,;]+/)
      .filter((x) => x !== "")
      .map(Number);
    if (multi) {
      if (vals.length === 0 || vals.some((n) => !Number.isFinite(n))) {
        setErr("批量写的值列表必须是逗号分隔的数字，例如 1,0,1,0");
        return;
      }
      if (wFc === 15 && vals.some((n) => n !== 0 && n !== 1)) {
        setErr("FC15 写线圈只认 0/1（内核会再转成 0xFF00/0x0000）");
        return;
      }
    }
    const fcLabel = FC_WRITE.find((f) => f.v === wFc)?.label ?? `FC${wFc}`;
    const shown = multi ? `${vals.length} 个（${vals.join(", ")}）` : String(val);
    // 摩擦点：写寄存器会真的动硬件（LED / 继电器 / 变频器频率）
    const ok = window.confirm(
      `确认在总线上写？\n\n${fcLabel}\n从站 ${unit} · 地址 ${addr}（0x${addr.toString(16).toUpperCase()}）\n值 ${shown}`,
    );
    if (!ok) return;
    void guard("write", async () => {
      const r = await api.modbusWrite(
        multi
          ? { fc: wFc, address: addr, values: vals }
          : { fc: wFc, address: addr, value: val },
      );
      setLast(r);
      setLastKind('write');
      await poll();
    });
  };

  const stats = engine?.stats;
  const dot =
    busy !== "" ? s.dotRun
      : engine?.polling ? (stats && stats.last_error ? s.dotFail : s.dotOk)
        : engine ? s.dotOk : s.dotIdle;
  const linkLabel = engine
    ? `${engine.session?.port || "auto"}@${engine.session?.baud || "?"} · 从站 ${engine.unit_id} · ${
      engine.polling ? `轮询中（${(engine.groups ?? []).join("/")}）` : "空闲"
    }`
    : "未连接（点「打开主站」）";

  const res = errText(last);

  return (
    <div className={s.wrap}>
      {/* ── 连接条 ───────────────────────────────────────── */}
      <div className={s.bar}>
        <span className={s.barLabel}>
          <span className={`${s.dot} ${dot}`} />
          Modbus RTU 主站
        </span>
        <span className={s.panelMeta}>{linkLabel}</span>
        <span className={s.spacer} />

        <label className={s.field}>
          从站
          <input
            className={s.num}
            value={unit}
            onChange={(e) => setUnit(e.currentTarget.value)}
            disabled={engine !== null}
            aria-label="从站地址"
          />
        </label>
        <label className={s.field}>
          超时ms
          <input
            className={s.num}
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.currentTarget.value)}
            disabled={engine !== null}
            aria-label="事务超时"
          />
        </label>
        <label className={s.field}>
          重试
          <input
            className={s.num}
            value={retries}
            onChange={(e) => setRetries(e.currentTarget.value)}
            disabled={engine !== null}
            aria-label="重试次数"
          />
        </label>

        {engine ? (
          <>
            <Button size="sm" variant="outline" busy={busy === "close"} onClick={() => void doClose()}>
              关闭主站
            </Button>
            {engine.polling ? (
              <Button size="sm" variant="ghost" busy={busy === "stop"} onClick={() => void doStop()}>
                停止轮询
              </Button>
            ) : (
              <Button size="sm" variant="primary" busy={busy === "start"} onClick={() => void doStart()}>
                开始轮询
              </Button>
            )}
          </>
        ) : (
          <Button
            size="sm"
            variant="primary"
            busy={busy === "open"}
            disabled={!serialAvailable}
            title={serialAvailable ? "会复用/打开串口会话，再挂主站" : (serialHint ?? "串口后端不可用")}
            onClick={() => void doOpen()}
          >
            打开主站
          </Button>
        )}
      </div>

      {err ? <div className={s.result + " " + s.resultFail}>{err}</div> : null}

      {/* ── 统计胶囊 ─────────────────────────────────────── */}
      {stats ? (
        <div className={s.bar}>
          <span className={`${s.chip} ${s.chipOk}`}>成功 {stats.ok}</span>
          <span className={`${s.chip} ${stats.timeout > 0 ? s.chipWarn : ""}`}>
            超时 {stats.timeout}
          </span>
          <span className={`${s.chip} ${stats.crc > 0 ? s.chipFail : ""}`}>CRC {stats.crc}</span>
          <span className={`${s.chip} ${stats.exception > 0 ? s.chipWarn : ""}`}>
            异常码 {stats.exception}
          </span>
          <span className={s.chip}>重试 {stats.retry}</span>
          <span className={s.chip}>噪声 {stats.noise}</span>
          <span className={s.spacer} />
          <span className={s.chip}>
            最近成功 {stats.last_ok_ms_ago === null ? "—" : `${stats.last_ok_ms_ago}ms 前`}
          </span>
          {stats.last_error ? (
            <span className={`${s.chip} ${s.chipFail}`}>最近错误 {stats.last_error}</span>
          ) : null}
        </div>
      ) : null}

      <div className={s.cols}>
        {/* ── 左：点表 ───────────────────────────────────── */}
        <div className={s.panel} data-shot="modbus-points">
          <div className={s.panelHead}>
            <span className={s.panelTitle}>点位</span>
            <span className={s.panelMeta}>
              {points.length} 个 · rev {map?.rev ?? "—"}
              {map?.groups?.length ? ` · ${map.groups.length} 组` : ""}
            </span>
            <span className={s.spacer} />
            <span className={s.panelMeta}>地址为协议偏移（40001 → 0）</span>
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>点位</th>
                  <th>FC</th>
                  <th>地址</th>
                  <th>值</th>
                  <th>单位</th>
                  <th>年龄</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.name}>
                    <td className={s.name}>
                      {p.name}
                      {p.def.writable ? <span className={s.wr}>W</span> : null}
                    </td>
                    <td>{String(p.def.fc).padStart(2, "0")}</td>
                    <td>0x{p.def.address.toString(16).toUpperCase().padStart(4, "0")}</td>
                    <td className={p.value === null ? s.stale : s.val}>{fmtValue(p)}</td>
                    <td className={s.unit}>{p.unit || p.def.unit || ""}</td>
                    <td className={s.stale}>{ageText(p.ts)}</td>
                    <td className={p.error ? s.err : s.stale}>
                      {p.error ? p.error : p.ts ? "ok" : "未读"}
                    </td>
                  </tr>
                ))}
                {points.length === 0 ? (
                  <tr>
                    <td colSpan={7} className={s.empty}>
                      该工程没有 Modbus 点表（projects/&lt;工程&gt;.modbus.json）
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 右：读写 + 流水 ────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--elab-space-3)" }}>
          <div className={s.panel} data-shot="modbus-read">
            <div className={s.panelHead}>
              <span className={s.panelTitle}>单次读</span>
              <span className={s.panelMeta}>不等轮询，立刻要一帧</span>
            </div>
            <div className={s.form}>
              <div className={s.formRow}>
                <select
                  className={s.num}
                  style={{ width: 130 }}
                  value={rFc}
                  onChange={(e) => setRFc(Number(e.currentTarget.value))}
                  aria-label="读功能码"
                >
                  {FC_READ.map((f) => (
                    <option key={f.v} value={f.v}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <label className={s.field}>
                  地址
                  <input
                    className={s.num}
                    value={rAddr}
                    onChange={(e) => setRAddr(e.currentTarget.value)}
                  />
                </label>
                <label className={s.field}>
                  数量
                  <input
                    className={s.num}
                    value={rCount}
                    onChange={(e) => setRCount(e.currentTarget.value)}
                  />
                </label>
              </div>
              <Button
                size="sm"
                variant="outline"
                busy={busy === "read"}
                disabled={!engine}
                onClick={() => void doRead()}
              >
                读一次
              </Button>
            </div>
          </div>

          <div className={s.panel} data-shot="modbus-write">
            <div className={s.panelHead}>
              <span className={s.panelTitle}>单次写</span>
              <span className={s.panelMeta}>会动物理世界，按钮前会再确认一次</span>
            </div>
            <div className={s.form}>
              <div className={s.formRow}>
                <select
                  className={s.num}
                  style={{ width: 130 }}
                  value={wFc}
                  onChange={(e) => setWFc(Number(e.currentTarget.value))}
                  aria-label="写功能码"
                >
                  {FC_WRITE.map((f) => (
                    <option key={f.v} value={f.v}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <label className={s.field}>
                  地址
                  <input
                    className={s.num}
                    value={wAddr}
                    onChange={(e) => setWAddr(e.currentTarget.value)}
                  />
                </label>
                {wFc === 15 || wFc === 16 ? (
                  <label className={s.field}>
                    值列表
                    <input
                      className={s.num}
                      style={{ width: 130 }}
                      value={wValues}
                      onChange={(e) => setWValues(e.currentTarget.value)}
                      aria-label="批量写的值列表"
                      placeholder="1,0,1,0"
                    />
                  </label>
                ) : (
                  <label className={s.field}>
                    值
                    <input
                      className={s.num}
                      value={wValue}
                      onChange={(e) => setWValue(e.currentTarget.value)}
                    />
                  </label>
                )}
              </div>
              <Button
                size="sm"
                variant="danger"
                busy={busy === "write"}
                disabled={!engine}
                onClick={doWrite}
              >
                写入
              </Button>
              <span className={s.hintLine}>
                {wTarget
                  ? `0x${(Number(wAddr) || 0).toString(16).toUpperCase().padStart(4, "0")} = ${wTarget.name}${wTarget.def.note ? ` · ${wTarget.def.note}` : ""}`
                  : "该地址不在点表里；写下去前请确认从站文档（地址为协议偏移，40001 → 0）。"}
              </span>
            </div>
          </div>

          <div className={s.panel}>
            <div className={s.panelHead}>
              <span className={s.panelTitle}>事务流水</span>
              <span className={s.panelMeta}>
                最近 {txns.length} 条 · seq {engine?.seq ?? 0}
              </span>
            </div>
            <div className={s.txns}>
              {txns.length === 0 ? (
                <div className={s.empty}>还没有事务。点「打开主站」或「开始轮询」。</div>
              ) : (
                [...txns].reverse().map((t) => (
                  <div
                    key={t.seq}
                    className={`${s.txn} ${t.ok ? s.txnOk : s.txnFail}`}
                    title={`${t.tx_hex}\n${t.rx_hex}${t.error ? `\n${t.error.kind}: ${t.error.detail}` : ""}`}
                  >
                    <span className={s.txnFc}>{String(t.fc).padStart(2, "0")}</span>
                    <span>0x{t.address.toString(16).toUpperCase()}</span>
                    <span className={s.txnAddr}>
                      {t.point || t.label}
                      {t.error ? ` · ${t.error.kind}` : ""}
                    </span>
                    <span className={s.txnMs}>{t.elapsed_ms}ms</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── 上一次结果（读/写/打开时探测共用一行，标题随动作变）────── */}
      {last ? (
        <div className={`${s.panel} ${s.resultBar}`}>
          <span className={s.resultTag}>
            {lastKind === 'write' ? '上次写入' : lastKind === 'read' ? '上次读取' : '打开时探测'}
          </span>
          <span className={res.ok ? s.resultOk : s.resultFail}>{res.text}</span>
        </div>
      ) : null}

      {/* ── 双缓冲诊断（地址 0x0100 段自动成组）──────────────── */}
      {diagPoints.length > 0 ? (
        <div className={s.panel} data-shot="modbus-diag">
          <div className={s.panelHead}>
            <span className={s.panelTitle}>串口 DMA 双缓冲诊断</span>
            <span className={s.panelMeta}>
              RX = DMA2 Stream2 循环缓冲（HT/TC 软件乒乓） · TX = 两块缓冲乒乓
            </span>
          </div>
          <div className={s.diag}>
            {diagPoints.map((p) => (
              <div key={p.name} className={s.diagCell}>
                <div className={s.diagName}>{p.name}</div>
                <div className={s.diagValue}>{fmtValue(p)}</div>
                <div className={s.diagNote}>{p.def.note ?? ""}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
