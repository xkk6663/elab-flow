import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  InstalledPack,
  MarketPack,
  PacksStatus,
  PkgJob,
  PkgVerifyResult,
} from "../api/types";
import { api } from "../api/client";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { SegmentedTabs } from "../primitives/SegmentedTabs";
import { Tag } from "../primitives/Tag";
import s from "./PacksView.module.css";

type Tab = "market" | "installed";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "market", label: "市场" },
  { id: "installed", label: "已安装" },
];

/** 包操作 job 的中文动作名（market = 首屏遍历 GitHub）。 */
const ACTION_LABEL: Record<string, string> = {
  install: "安装",
  remove: "卸载",
  update: "更新",
  market: "市场遍历",
};

/**
 * 芯片适配包视图（市场 / 已安装）—— 与 DSH 面板的 `PackSettingsView` 同形。
 *
 * ★ 只做**呈现**：兼容性、启用语义、sha256、来源解析全部来自内核投影
 *   （`PacksStatus`）。本组件不认识厂商，也不为任何芯片开分支。
 * ★ 写操作只发包名；install/remove/update/market 回 202 + job，再 500ms 轮询
 *   `/api/pkg/job`；verify/activate 同步 200。
 * ★ 有 job 在跑 = 闭环冻结（内核 `/api/run` 会 409）——界面必须显式说出来。
 */
export interface PacksViewProps {
  /** 有闭环在跑（内核也会 409 拦，但界面先禁用更清楚）。 */
  runActive: boolean;
  /** 关闭市场视图，回到驾驶舱。 */
  onClose: () => void;
  /** 启用了新的适配包：App 需要刷新工程目录（芯片集合可能变了）。 */
  onActivated?: () => void;
}

export function PacksView({ runActive, onClose, onActivated }: PacksViewProps) {
  const [tab, setTab] = useState<Tab>("market");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<PacksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 正在跑（或刚跑完）的包操作任务。 */
  const [job, setJob] = useState<PkgJob | null>(null);
  /** verify 结果（按包名）。 */
  const [verifies, setVerifies] = useState<Record<string, PkgVerifyResult>>({});
  /** 正在等待的某个同步动作（activate）。 */
  const [pending, setPending] = useState<string | null>(null);

  const jobActive = job !== null && (job.state === "queued" || job.state === "running");
  /** 市场遍历只读 GitHub、不改芯片数据 → 不冻结闭环（内核侧同样不拦）。 */
  const marketJobActive = jobActive && job !== null && job.action === "market";
  const frozen = runActive || (jobActive && !marketJobActive);

  const load = useCallback(
    async (q: string, withMarket: boolean) => {
      setLoading(true);
      setError(null);
      try {
        setStatus(await api.packs({ market: withMarket, q }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // 页签/搜索变化 → 重新拉投影（市场页签才读市场索引：离线/慢网时不拖累已安装页）
  useEffect(() => {
    if (tab !== "market") {
      void load("", false);
      return;
    }
    const t = setTimeout(() => void load(query.trim(), true), 300);
    return () => clearTimeout(t);
  }, [tab, query, load]);

  const watchJob = useCallback((first: PkgJob) => {
    setJob(first);
    setNotice(null);
  }, []);

  /** 轮询结束时要按**当前**页签刷新（effect 里不直接依赖 query/tab，免得多余重跑）。 */
  const refreshArgs = useRef<{ tab: Tab; query: string }>({ tab, query });
  refreshArgs.current = { tab, query };

  // 首次打开市场页签：现场遍历一遍 GitHub 上现有的 elab-pack 仓库（异步 job）。
  // 没有 GITHUB_TOKEN 时可能被限流 → 失败只提示，不阻断：界面继续显示已有索引。
  const crawled = useRef(false);
  useEffect(() => {
    if (tab !== "market" || crawled.current) return;
    crawled.current = true;
    void api
      .marketRefresh()
      .then(watchJob)
      .catch((e: unknown) =>
        setError(
          `未能现场遍历 GitHub（${e instanceof Error ? e.message : String(e)}）—— 仍显示最近一次市场索引`,
        ),
      );
  }, [tab, watchJob]);

  useEffect(() => {
    if (job === null) return;
    if (job.state !== "queued" && job.state !== "running") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const snap = await api.pkgJob(job.id);
          if (cancelled) return;
          setJob(snap);
          if (snap.state === "ok" || snap.state === "failed") {
            // 操作落盘后投影已变：刷新列表（也拿到新的 active / chips）
            const cur = refreshArgs.current;
            void load(cur.tab === "market" ? cur.query.trim() : "", cur.tab === "market");
          }
        } catch (e) {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
          setJob({ ...job, state: "failed", stage: "轮询失败", error: String(e) });
        }
      })();
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job, load]);

  const fail = (e: unknown): void => {
    setError(e instanceof Error ? e.message : String(e));
  };

  const doInstall = (name: string, official: boolean): void => {
    setError(null);
    setNotice(null);
    void api
      .pkgInstall({ name, official })
      .then(watchJob)
      .catch(fail);
  };

  const doRemove = (name: string): void => {
    setError(null);
    setNotice(null);
    void api.pkgRemove({ name }).then(watchJob).catch(fail);
  };

  const doUpdate = (name: string): void => {
    setError(null);
    setNotice(null);
    void api
      .pkgUpdate({ name })
      .then((j) => {
        // 已是最新时内核直接返回 job(ok, 无日志)；照样展示结论
        watchJob(j);
      })
      .catch(fail);
  };

  const doVerify = (name: string): void => {
    setError(null);
    void api
      .pkgVerify({ name })
      .then((r) => {
        const one = r.results.find((x) => x.name === name) ?? r.results[0];
        if (one !== undefined) setVerifies((cur) => ({ ...cur, [one.name]: one }));
        setNotice(one?.ok === true ? `${name} 校验通过（内容哈希一致）` : `${name} 校验未通过`);
      })
      .catch(fail);
  };

  const doActivate = (name: string): void => {
    setError(null);
    setNotice(null);
    setPending(name);
    void api
      .pkgActivate({ name })
      .then((r) => {
        setNotice(`已启用 ${name}（一次只启用一套，其余包仍保留在本地）`);
        const p = (r as { packs?: PacksStatus }).packs;
        if (p !== undefined) setStatus(p);
        else void load("", false);
        onActivated?.();
      })
      .catch(fail)
      .finally(() => setPending(null));
  };

  // ── 派生 ──
  const installed = useMemo(
    () => (status?.installed ?? []).filter((p) => p.installed),
    [status],
  );
  const officialLocal = useMemo(
    () => (status?.installed ?? []).filter((p) => p.status === "official" && !p.installed),
    [status],
  );
  const marketPacks = status?.market?.packs ?? [];

  const renderInstallRow = (p: MarketPack | InstalledPack, official: boolean): ReactNode => {
    const compat = p.compatible;
    const installedRec = status?.installed.find((x) => x.name === p.name);
    const isInstalled = installedRec?.installed === true;
    const isActive = installedRec?.active === true;
    const disabled = frozen || !compat.ok;
    return (
      <div key={p.name} className={s.row}>
        <div className={s.nameRow}>
          <span className={s.name}>{p.name}</span>
          {isActive ? <Tag tone="green" dense>启用中</Tag> : null}
          {isInstalled && !isActive ? <Tag dense>已安装</Tag> : null}
        </div>
        {p.description !== undefined && p.description !== "" ? (
          <span className={s.desc}>{p.description}</span>
        ) : null}
        <PackMeta pack={p} />
        {compat.ok ? null : (
          <div className={s.compatFail}>{`不兼容：${compat.reasons.join("；")}`}</div>
        )}
        <div className={s.actions}>
          {isInstalled ? (
            isActive ? (
              <span className={s.mutedText}>当前启用的芯片适配包</span>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={disabled || pending === p.name}
                title="启用这套包（其余包保留在本地，随时切回）"
                onClick={() => doActivate(p.name)}
              >
                {pending === p.name ? "启用中…" : "启用"}
              </Button>
            )
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={disabled}
              title={disabled ? "有闭环/包操作在跑，或包与内核不兼容" : `安装 ${p.name}`}
              onClick={() => doInstall(p.name, official)}
            >
              安装
            </Button>
          )}
        </div>
      </div>
    );
  };

  const renderInstalledRow = (p: InstalledPack): ReactNode => {
    const v = verifies[p.name];
    const disabled = frozen;
    return (
      <div key={p.name} className={s.row}>
        <div className={s.nameRow}>
          <span className={s.name}>{p.name}</span>
          {p.active ? <Tag tone="green" dense>启用中</Tag> : null}
        </div>
        <PackMeta pack={p} />
        <span className={s.path}>{p.dir}</span>
        {v !== undefined ? (
          <div className={v.ok ? s.verifyOk : s.verifyFail}>
            {v.ok ? "校验通过（内容哈希一致）" : `校验未通过：${v.problems.join("；")}`}
          </div>
        ) : null}
        <div className={s.actions}>
          {p.active ? null : (
            <Button
              variant="primary"
              size="sm"
              disabled={disabled || pending === p.name}
              onClick={() => doActivate(p.name)}
            >
              {pending === p.name ? "启用中…" : "启用"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => doVerify(p.name)}>
            校验
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            title="按市场索引更新（内容哈希强校验）"
            onClick={() => doUpdate(p.name)}
          >
            更新
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={disabled}
            title={p.active ? "卸载后自动启用下一个已装包；没有则清空" : "只删安装目录"}
            onClick={() => doRemove(p.name)}
          >
            卸载
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-label="芯片适配包">
      <div className={s.panel}>
        {/* 顶栏：标题 + 返回 */}
        <div className={s.head}>
          <Button variant="ghost" size="sm" onClick={onClose} title="返回驾驶舱">
            ← 返回
          </Button>
          <span className={s.title}>芯片适配包</span>
          <span className={s.spacer} />
          {status?.active !== undefined && status.active !== "" ? (
            <span className={s.active} title="当前启用的芯片适配包（一次只启用一套）">
              {`启用：${status.active}`}
            </span>
          ) : null}
        </div>

        {/* 页签 */}
        <div className={s.tabs}>
          <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} size="sm" />
        </div>

        {/* 闭环冻结提示：有 run 或包操作时 */}
        {frozen ? (
          <div className={s.frozen}>
            {jobActive
              ? "安装期间闭环已冻结（无法发起 run）——等包操作完成后自动解除"
              : "有闭环正在跑：包操作已禁用（会改芯片数据）"}
          </div>
        ) : null}

        {/* 包操作任务进度 */}
        {job !== null ? (
          <div className={s.job}>
            <div className={s.jobHead}>
              <span
                className={
                  job.state === "ok" ? s.jobOk : job.state === "failed" ? s.jobFail : s.jobRun
                }
              >
                {`${ACTION_LABEL[job.action] ?? job.action}${job.name ? ` ${job.name}` : ""}：${job.stage}`}
              </span>
              <span className={s.spacer} />
              {job.state === "ok" || job.state === "failed" ? (
                <Button variant="outline" size="sm" onClick={() => setJob(null)}>
                  关闭
                </Button>
              ) : null}
            </div>
            {job.error !== null ? <div className={s.jobFail}>{job.error}</div> : null}
            {job.log.length > 0 ? (
              <div className={s.jobLog}>{job.log.slice(-8).join("\n")}</div>
            ) : null}
          </div>
        ) : null}

        {notice !== null ? <div className={s.notice}>{notice}</div> : null}
        {error !== null ? (
          <div className={s.error} role="alert">
            {error}
          </div>
        ) : null}

        {/* 内容 */}
        <div className={s.body}>
          {tab === "market" ? (
            <>
              <div className={s.search}>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  placeholder="搜索芯片包：名称 / 厂商 / 平台（如 stm32、at32）"
                  aria-label="搜索芯片适配包"
                />
                {query !== "" ? (
                  <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                    清空
                  </Button>
                ) : null}
              </div>

              {loading ? <div className={s.mutedText}>读取中…</div> : null}

              {status?.market?.error !== undefined && status?.market?.error !== null ? (
                <div className={s.warn}>{`市场索引读取失败：${status.market.error}`}</div>
              ) : null}

              {query.trim() === "" ? (
                <>
                  {/* 首屏：直接把市场里的**全部**可用包列出来（无需输入） */}
                  {marketPacks.length > 0 ? (
                    <>
                      <div className={s.sectionLabel}>
                        {`市场（GitHub 发现 ${marketPacks.length} 个）`}
                      </div>
                      {marketPacks.map((p) => renderInstallRow(p, false))}
                    </>
                  ) : marketJobActive ? (
                    <div className={s.mutedText}>正在遍历 GitHub 上的芯片适配包…</div>
                  ) : (
                    <div className={s.empty}>
                      市场里暂时没有可用包：可在上方输入名称过滤，或装本机官方源里的内置包。
                    </div>
                  )}
                  {officialLocal.length > 0 ? (
                    <>
                      <div className={s.sectionLabel}>本机官方源（离线可装）</div>
                      {officialLocal.map((p) => renderInstallRow(p, true))}
                    </>
                  ) : null}
                  {marketPacks.length > 0 ? (
                    <div className={s.footnote}>
                      以上为市场里的全部适配包；输入名称可过滤。内容留在作者仓库，一次只启用一套。
                    </div>
                  ) : null}
                </>
              ) : marketPacks.length === 0 && !loading ? (
                <div className={s.empty}>
                  {`没有匹配「${query.trim()}」的芯片包（可试试厂商名：stm32 / at32 / …）`}
                </div>
              ) : (
                marketPacks.map((p) => renderInstallRow(p, false))
              )}
            </>
          ) : (
            <>
              {loading ? <div className={s.mutedText}>读取中…</div> : null}
              {installed.length === 0 && !loading ? (
                <div className={s.empty}>
                  还没有安装任何芯片适配包：去「市场」搜索（例如 stm32），或装本机官方源里的内置包。
                </div>
              ) : (
                installed.map((p) => renderInstalledRow(p))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PackMeta({ pack }: { pack: InstalledPack | MarketPack }) {
  const chips = pack.chips ?? [];
  return (
    <div className={s.meta}>
      <span className={s.ver}>{`v${pack.version ?? "?"}`}</span>
      {pack.status === "official" ? <Tag tone="green" dense>官方</Tag> : null}
      {pack.license !== undefined && pack.license !== null && pack.license !== "" ? (
        <span className={s.license}>{pack.license}</span>
      ) : null}
      {chips.length > 0 ? (
        <span className={s.chips} title={chips.join("、")}>
          {`芯片：${chips.join("、")}`}
        </span>
      ) : null}
    </div>
  );
}
