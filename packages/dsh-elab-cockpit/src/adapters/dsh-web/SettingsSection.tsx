/**
 * 设置节（settings.section，P4 融合）—— DSH 设置 → ELAB 驾驶舱。
 *
 * 可改：elab 仓库根 / python 路径 / 自动托管回收秒数 / 发现深度与上限。
 * 读 GET /elab/config，保存 POST /elab/config：宿主**热更新**（不重启即生效）
 * 并持久化到 `~/.dsh/dsh-elab-cockpit.config.json`（下次启动自动叠加）。
 *
 * 全部走 --elab-* 令牌（§5.5）；不保存不存在的字段（宿主白名单校验）。
 */
import React, { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { elabApi, type ElabConfig } from '../kernel-http/icd-client.ts'
import type { EnvProbe, ProbeItem } from '../../domain/icd.ts'

const inputStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  padding: '3px 8px',
  fontSize: '12px',
  borderRadius: '6px',
  border: '1px solid var(--elab-border)',
  background: 'var(--elab-bg-surface)',
  color: 'var(--elab-fg-primary)',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
  marginBottom: '8px',
}

const labelStyle: React.CSSProperties = {
  flex: '0 0 96px',
  fontSize: '12px',
  color: 'var(--elab-fg-secondary)',
}

/** 环境灯：一行 label + 版本/错误（绿色可用 / 黄色缺件）。 */
function probeRow(label: string, item: ProbeItem | undefined, busy: boolean): ReactNode {
  const ok = item?.ok === true
  return (
    <div key={label} style={{ display: 'flex', gap: '8px', fontSize: '11px', lineHeight: 1.9 }}>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: '8px',
          height: '8px',
          marginTop: '6px',
          borderRadius: '50%',
          background: ok ? 'var(--elab-status-ok)' : 'var(--elab-status-run)',
        }}
      />
      <span style={{ flex: '0 0 150px', color: 'var(--elab-fg-secondary)' }}>{label}</span>
      <span style={{ color: 'var(--elab-fg-muted)', wordBreak: 'break-all' }}>
        {ok ? (item?.version ?? '可用') : busy ? '检测中…' : (item?.error ?? '未检测到')}
      </span>
    </div>
  )
}

export function SettingsSection(_props: Record<string, unknown>): ReactNode {
  const [cfg, setCfg] = useState<ElabConfig | null>(null)
  const [draft, setDraft] = useState<Partial<ElabConfig>>({})
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  // 环境分段（复用 GET /elab/env；只读、不 spawn 内核）
  const [env, setEnv] = useState<EnvProbe | null>(null)
  const [envBusy, setEnvBusy] = useState(false)

  const loadEnv = (): void => {
    setEnvBusy(true)
    void (async () => {
      try {
        const r = await elabApi.env()
        setEnv(r.env)
      } catch {
        /* 探测失败不阻断设置页（面板会提示） */
      } finally {
        setEnvBusy(false)
      }
    })()
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await elabApi.getConfig()
        if (cancelled) return
        setCfg(r.config)
        setStatus('idle')
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    loadEnv()
    // 只在挂载时探一次；手动「重新检测」在环境分段里
  }, [])

  const set = (patch: Partial<ElabConfig>): void => setDraft((cur) => ({ ...cur, ...patch }))

  const save = (): void => {
    if (Object.keys(draft).length === 0) return
    setStatus('saving')
    void (async () => {
      try {
        const r = await elabApi.saveConfig(draft)
        setCfg(r.config)
        setDraft({})
        setStatus('saved')
      } catch (e) {
        setStatus('error')
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }

  // 环境包（一键安装）：官方上游直链下载 → 校验 → 解到 ~/.dsh/elab/env → 注入 ELAB_*
  const [packBusy, setPackBusy] = useState(false)
  const [packNotice, setPackNotice] = useState<string | null>(null)

  const installToolchain = (): void => {
    setPackBusy(true)
    setPackNotice(null)
    void (async () => {
      try {
        const r = await elabApi.bootstrap({ action: 'install-toolchain', confirm: true })
        const warnings = r.envPack?.warnings ?? []
        setPackNotice(
          `已安装 ${r.envPack?.tools ?? 0} 件工具包${warnings.length > 0 ? `（${warnings.length} 条告警）` : ''}；内核重启后生效`,
        )
        loadEnv()
      } catch (e) {
        setPackNotice(`安装失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setPackBusy(false)
      }
    })()
  }

  if (cfg === null) {
    return (
      <div className="elab-root" style={{ padding: '12px', fontSize: '12px', color: 'var(--elab-fg-muted)' }}>
        {status === 'error' ? `配置读取失败：${error ?? '未知原因'}` : '正在读取配置…'}
      </div>
    )
  }

  return (
    <div className="elab-root" style={{ padding: '12px', fontSize: '12px', color: 'var(--elab-fg-primary)' }}>
      <div style={rowStyle}>
        <span style={labelStyle}>elab 仓库根</span>
        <input
          value={draft.elabRoot ?? cfg.elabRoot}
          onChange={(e: any) => set({ elabRoot: e.currentTarget.value })}
          placeholder="auto = 由会话 cwd 向上找"
          aria-label="elab 仓库根"
          style={inputStyle}
        />
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>python 路径</span>
        <input
          value={draft.pythonPath ?? cfg.pythonPath}
          onChange={(e: any) => set({ pythonPath: e.currentTarget.value })}
          placeholder="auto = 走 PATH 的 python"
          aria-label="python 路径"
          style={inputStyle}
        />
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>自动准备</span>
        <input
          type="checkbox"
          checked={draft.autoProvision ?? cfg.autoProvision}
          onChange={(e: any) => set({ autoProvision: Boolean(e.currentTarget.checked) })}
          aria-label="首次打开自动准备内核与工具链"
          style={{ accentColor: 'var(--elab-accent)', cursor: 'pointer' }}
        />
        <span style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>
          {'首次打开面板自动下载内核 / 浅克隆回落 / 安装工具链（只写 ~/.dsh/elab；主机 Python 不会被自动安装）'}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>空闲回收(秒)</span>
        <input
          type="number"
          min={60}
          max={86400}
          value={draft.idleKillSec ?? cfg.idleKillSec}
          onChange={(e: any) => set({ idleKillSec: Number(e.currentTarget.value) })}
          aria-label="空闲回收秒数"
          style={{ ...inputStyle, flex: '0 1 120px' }}
        />
        <span style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>cockpit 进程空闲多久自动退出（60–86400）</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>发现深度</span>
        <input
          type="number"
          min={1}
          max={6}
          value={draft.discoverMaxDepth ?? cfg.discoverMaxDepth}
          onChange={(e: any) => set({ discoverMaxDepth: Number(e.currentTarget.value) })}
          aria-label="发现扫描深度"
          style={{ ...inputStyle, flex: '0 1 80px' }}
        />
        <span style={labelStyle}>候选上限</span>
        <input
          type="number"
          min={1}
          max={500}
          value={draft.discoverLimit ?? cfg.discoverLimit}
          onChange={(e: any) => set({ discoverLimit: Number(e.currentTarget.value) })}
          aria-label="发现候选上限"
          style={{ ...inputStyle, flex: '0 1 80px' }}
        />
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          onClick={save}
          disabled={status === 'saving' || Object.keys(draft).length === 0}
          style={{
            padding: '3px 14px',
            fontSize: '12px',
            borderRadius: '6px',
            border: '1px solid var(--elab-btn-primary-border)',
            background: 'var(--elab-btn-primary-bg)',
            color: 'var(--elab-btn-primary-fg)',
            cursor: 'pointer',
          }}
        >
          {status === 'saving' ? '保存中…' : '保存（立即生效）'}
        </button>
        {status === 'saved' ? <span style={{ color: 'var(--elab-status-ok)' }}>{'已保存并热更新'}</span> : null}
        {status === 'error' ? <span style={{ color: 'var(--elab-status-fail)' }}>{`失败：${error ?? '未知原因'}`}</span> : null}
        <span style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>{'保存后写入 ~/.dsh/dsh-elab-cockpit.config.json，重启仍生效'}</span>
      </div>

      {/* 环境（只读探测；与安装向导同一数据源，不 spawn 内核） */}
      <div style={{ marginTop: '12px', borderTop: '1px solid var(--elab-border)', paddingTop: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
          <span style={{ fontWeight: 600 }}>{'环境'}</span>
          <button
            onClick={loadEnv}
            disabled={envBusy}
            style={{
              padding: '2px 10px',
              fontSize: '11px',
              borderRadius: '6px',
              border: '1px solid var(--elab-border-strong)',
              background: 'transparent',
              color: 'var(--elab-fg-secondary)',
              cursor: 'pointer',
            }}
          >
            {envBusy ? '检测中…' : '重新检测'}
          </button>
          <button
            onClick={installToolchain}
            disabled={packBusy}
            style={{
              padding: '2px 10px',
              fontSize: '11px',
              borderRadius: '6px',
              border: '1px solid var(--elab-btn-primary-border)',
              background: 'var(--elab-btn-primary-bg)',
              color: 'var(--elab-btn-primary-fg)',
              cursor: 'pointer',
            }}
          >
            {packBusy ? '安装中…' : '一键安装工具链'}
          </button>
        </div>
        {packNotice !== null ? (
          <div style={{ fontSize: '11px', marginBottom: '6px', color: 'var(--elab-fg-secondary)' }}>{packNotice}</div>
        ) : null}
        {env === null ? (
          <div style={{ fontSize: '11px', color: 'var(--elab-fg-muted)' }}>
            {'尚未检测（缺件只影响编译/烧录/调试，不阻断面板）'}
          </div>
        ) : (
          <div>
            {probeRow('python', env.python, envBusy)}
            {probeRow('pyserial', env.pyserial, envBusy)}
            {probeRow('git', env.git, envBusy)}
            {probeRow('arm-none-eabi-gcc', env.armGcc, envBusy)}
            {probeRow('cmake', env.cmake, envBusy)}
            {probeRow('ninja', env.ninja, envBusy)}
            {probeRow('openocd', env.openocd, envBusy)}
          </div>
        )}
      </div>
    </div>
  )
}
