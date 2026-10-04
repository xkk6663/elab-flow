"""elab.run —— 事件驱动的运行器（L3↔L6 的同一条路径）。

``elab run`` 与驾驶舱**共用这一个入口**（技术方案 §5.1 的"CLI 与 cockpit 同路径"）：

    cockpit-server(父) ──spawn──> elab run -p at32_test --emit-events
            │                              │
            │                     log=emit → 追加 .work/.cockpit/runs/<id>.jsonl
            └──follow(只追加文件)──────────┘

**为什么必须是独立进程**（第一硬约束 K1）：
``builder._run()`` 用的是 ``subprocess.run(capture_output=True)``。若把它塞进服务端线程，
HTTP 服务会被拖死、SSE 推不出去；``flash.debug`` 起 openocd 时还会阻塞 20s 等端口。
故本模块只做"我自己的事"，**不关心谁在跟读**——它只是把事件写进只追加文件。

**回归安全**：本模块**不修改** ``builder``/``flash``/``doctor``/``ci`` 的既有行为，
只在它们已经留好的 ``log=`` seam 上挂一个事件的 sink。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

from . import builder, doctor as doctor_mod, flash as flash_mod
from . import monitor as monitor_mod
from .config import Config, ElabError, to_fwd
from .kernel.events import ACTOR_AGENT, EventLog
from .plan import plan_for

#: 可执行的步骤。前 5 个与 ``ci/matrix.yaml`` 的 ``steps`` 取值**同源**（K9：不复制流程），
#: ``monitor`` 是驾驶舱扩展（矩阵里没有，因为它是 §16 判据引擎的入口）。
ALL_STEPS: tuple[str, ...] = (
    "doctor", "doctor_deep", "build", "flash", "debug_verify", "monitor",
)

#: 驾驶舱默认两步（= M1 验收范围：doctor + build）。
#: 刻意用浅 ``doctor`` 而不是 ``doctor_deep``：后者会真跑一次 configure，
#: 在"点一下看看"的交互里太慢；需要强证据时显式传 ``--steps doctor_deep,build``。
DEFAULT_STEPS: tuple[str, ...] = ("doctor", "build")

#: 需要探针（上板）的步骤。驾驶舱据此把按钮置灰，避免"点了必然失败"。
ONHW_STEPS: frozenset[str] = frozenset({"flash", "debug_verify", "monitor"})


class RunError(ElabError):
    pass


# ── 路径 ─────────────────────────────────────────────────────────
def runs_dir_for(cfg: Config) -> Path:
    """运行产物目录（技术方案 §4.3.4）。

    可在 ``elab.host.yaml`` 用 ``cockpit.runs_dir`` 覆盖；默认 ``.work/.cockpit/runs``。
    """
    override = ((cfg.host or {}).get("cockpit") or {}).get("runs_dir")
    if override:
        return Path(cfg.resolve(override, {"ELAB_ROOT": to_fwd(cfg.root)}))
    return Path(cfg.root) / ".work" / ".cockpit" / "runs"


def parse_steps(spec: str | None, *, default=DEFAULT_STEPS) -> list[str]:
    """把 ``"doctor,build"`` 解析成列表，并校验步骤名（防拼写错静默变成 no-op）。"""
    if not spec:
        return list(default)
    out = [s.strip() for s in spec.split(",") if s.strip()]
    bad = [s for s in out if s not in ALL_STEPS]
    if bad:
        raise RunError(f"未知步骤：{', '.join(bad)}（可选：{', '.join(ALL_STEPS)}）")
    if not out:
        raise RunError("--steps 解析为空")
    return out


# ── 发射/打印的统一出口 ──────────────────────────────────────────
class _IO:
    """有事件时"落盘 + 打印"都做；没事件时退化为纯打印。

    ★ 这十几行就是契约 §17.4 的落地点：**同一份事件**既进文件、又进终端。
      因此"终端里看到的"和"界面上看到的"不可能漂移（风险 K8）。
    """

    def __init__(self, elog: EventLog | None, *, echo: bool, actor: str):
        self.elog = elog
        self.echo = echo
        self.actor = actor

    def sink(self, step: str):
        if self.elog is not None:
            return self.elog.proc_sink(step, echo=self.echo, actor=self.actor)

        def _plain(*args, **kwargs):
            if self.echo:
                print(" ".join(str(a) for a in args), flush=True)
        return _plain

    def start(self, steps, project):
        if self.elog:
            self.elog.start(steps, project=project, actor=self.actor)

    def step_enter(self, step, index, total):
        if self.elog:
            self.elog.step_enter(step, index, total, actor=self.actor)

    def step_exit(self, step, ok, detail, dt, extra):
        if self.elog:
            self.elog.step_exit(step, ok, detail, dt, actor=self.actor, **extra)

    def end(self, ok, steps_ok, steps_failed):
        if self.elog:
            self.elog.end(ok, steps_ok, steps_failed, actor=self.actor)


# ── 单步执行 ─────────────────────────────────────────────────────
@dataclass
class StepOutcome:
    ok: bool
    detail: str = ""
    #: 进 ``run/step-exit`` 的额外字段（契约 §3.1 的产物域/内存域）。**字段名即契约**。
    extra: dict = field(default_factory=dict)


def _detail_memory(res: dict) -> str:
    mem = res.get("memory") or {}
    return " ".join(f"{k} {v['pct']}%" for k, v in mem.items())


def _execute(cfg: Config, step: str, project: str, *, clean: bool, jobs: int | None,
             verbose: bool, sink) -> StepOutcome:
    """执行一步。**只调用既有库函数**，不改它们的行为。"""
    if step in ("doctor", "doctor_deep"):
        rep = doctor_mod.run(cfg, only=project, deep=(step == "doctor_deep"))
        # 把逐条证据也推进事件流 —— 界面上的"证据轨"就靠它，而不是靠猜
        for line in rep.render().splitlines():
            sink(line)
        if rep.passed:
            return StepOutcome(True, "全绿", {"checks": len(rep.items)})
        errs = "; ".join(f"{code}: {msg}" for lvl, code, msg in rep.items if lvl == "error")
        return StepOutcome(False, errs or "体检未通过")

    if step == "build":
        plan = plan_for(cfg, project)
        res = builder.build_project(plan, clean=clean, jobs=jobs,
                                    verbose=verbose, log=sink)
        ok = res.get("status") == "ok"
        detail = _detail_memory(res) if ok else f"{res.get('status')}: {res.get('error', '')}"
        extra = {
            "memory": res.get("memory") or {},
            "artifacts": res.get("artifacts") or {},
        }
        # 内存数字的来源（linker / map）—— 界面据此说明"这个数字哪来的"，
        # 免得在增量构建下看到一样的数字却以为链接器真的跑过。
        if res.get("memory_source"):
            extra["memory_source"] = res["memory_source"]
        if res.get("size"):
            extra["size"] = res["size"]
        guard = res.get("guard")
        if guard:
            extra["guard"] = guard
        if res.get("elapsed_s") is not None:
            extra["build_elapsed_s"] = res["elapsed_s"]
        return StepOutcome(ok, detail, extra)

    if step == "flash":
        plan = plan_for(cfg, project)
        res = flash_mod.flash(plan, verbose=verbose, log=sink)
        ok = res.get("status") == "ok"
        evidence = res.get("evidence") or []
        detail = (evidence[0] if evidence else res.get("status", "")) if ok \
            else f"{res.get('status')}: {evidence[-1] if evidence else ''}"
        return StepOutcome(ok, detail, {"evidence": evidence})

    if step == "debug_verify":
        plan = plan_for(cfg, project)
        res = flash_mod.debug(plan, mode="verify", log=sink)
        ok = res.get("status") == "ok"
        evidence = res.get("evidence") or []
        return StepOutcome(ok, evidence[0] if evidence else res.get("status", ""),
                           {"evidence": evidence})

    if step == "monitor":
        v = monitor_mod.run(cfg, project, echo=False, log=sink)
        # ★ 三态不能塌成两态：inconclusive（没读到约定关键字）**不是失败**。
        #   与 cmd_loop 的语义保持一致；verdict 原样带给界面，让它分三色渲染。
        ok = v.status != "failed"
        extra = {"verdict": v.status, "serial": v.to_dict()}
        return StepOutcome(ok, (v.reason or v.status), extra)

    raise RunError(f"未知步骤：{step}")


# ── 主流程 ───────────────────────────────────────────────────────
def run(cfg: Config, project: str, *, steps=None, clean: bool = False,
        jobs: int | None = None, verbose: bool = False, actor: str = ACTOR_AGENT,
        emit_events: bool = False, run_id: str | None = None, echo: bool = True,
        runs_dir=None, keep_going: bool = False) -> dict:
    """跑一串步骤，可选地把每一步写成事件。

    :returns: ``{run, project, steps, ok, runs_dir, events:{...}}``

    失败即停（默认）。理由：build 挂了还去 flash 只会得到一个更难懂的错误。
    ``keep_going=True`` 可一路跑完（对应 ``elab ci`` 的行为）。
    """
    steps = parse_steps(",".join(steps) if isinstance(steps, (list, tuple)) else steps)

    rd = Path(runs_dir) if runs_dir else runs_dir_for(cfg)
    elog = EventLog(rd, run_id=run_id, project=project) if emit_events else None
    io = _IO(elog, echo=echo, actor=actor)

    results: list[dict] = []
    steps_ok: list[str] = []
    steps_failed: list[str] = []
    all_ok = True

    try:
        io.start(steps, project)
        for i, step in enumerate(steps):
            io.step_enter(step, i, len(steps))
            t0 = time.time()
            try:
                oc = _execute(cfg, step, project, clean=clean, jobs=jobs,
                              verbose=verbose, sink=io.sink(step))
            except ElabError as exc:
                oc = StepOutcome(False, str(exc))
            dt = time.time() - t0
            io.step_exit(step, oc.ok, oc.detail, dt, oc.extra)

            results.append({"step": step, "ok": oc.ok, "detail": oc.detail,
                            "duration_s": round(dt, 3), **oc.extra})
            (steps_ok if oc.ok else steps_failed).append(step)
            if not oc.ok:
                all_ok = False
                if not keep_going:
                    break
        io.end(all_ok, steps_ok, steps_failed)
    finally:
        if elog:
            elog.close()

    return {
        "run": elog.run_id if elog else None,
        "project": project,
        "steps": results,
        "ok": all_ok,
        "runs_dir": to_fwd(rd) if elog else "",
        "events": {
            "enabled": bool(elog),
            "state": to_fwd(elog.state_path) if elog else "",
            "proc": to_fwd(elog.proc_path) if elog else "",
            "log": to_fwd(elog.log_path) if elog else "",
        },
    }


def render(res: dict) -> str:
    """人读摘要。步骤细节已实时打过了，这里只补一句总账。"""
    lines = []
    for r in res.get("steps", []):
        mark = "✓" if r["ok"] else "✗"
        lines.append(f"  [{mark}] {r['step']:<13} {r['duration_s']:6.2f}s  {r['detail']}")
    head = f"run={res['run']}  project={res['project']}" if res.get("run") else \
           f"project={res['project']}  (未发射事件)"
    tail = "✓ 全部通过" if res["ok"] else "✗ 有步骤失败"
    return "\n".join([head, *lines, tail])
