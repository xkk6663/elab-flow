"""elab.ci —— 按 ci/matrix.yaml 跑 CI 矩阵（L5）。

本地 `elab ci` 与 GitHub Actions 共用同一份 `ci/matrix.yaml`，
所以"本地绿、CI 红"这类不一致在结构上就难以发生。

矩阵分两档：
  host-gate   纯主机可跑（doctor --deep + build）→ 云端 runner
  onhw-gate   需要真实探针（flash + debug_verify）→ self-hosted，可选
默认**不跑** onhw 档（需 `--onhw` 显式开启），因为没有探针时它必然失败。
"""

from __future__ import annotations

from . import _yaml, builder, doctor as doctor_mod, flash as flash_mod
from .config import Config, ElabError
from .plan import plan_for

ONHW_STEPS = {"flash", "debug_verify"}


def load_matrix(cfg: Config) -> dict:
    path = cfg.root / "ci" / "matrix.yaml"
    if not path.exists():
        raise ElabError(f"找不到 CI 矩阵：{path}")
    return _yaml.load_file(path) or {}


def _run_step(cfg: Config, step: str, project: str, *, clean: bool, verbose: bool, log):
    """执行单个步骤，返回 (ok, detail)。"""
    if step == "doctor_deep":
        rep = doctor_mod.run(cfg, only=project, deep=True)
        detail = ", ".join(f"{c}" for lvl, c, _ in rep.items if lvl == "error") or "全绿"
        return rep.passed, detail
    if step == "doctor":
        rep = doctor_mod.run(cfg, only=project, deep=False)
        detail = ", ".join(f"{c}" for lvl, c, _ in rep.items if lvl == "error") or "全绿"
        return rep.passed, detail
    if step == "build":
        plan = plan_for(cfg, project)
        res = builder.build_project(plan, clean=clean, verbose=verbose, log=log)
        mem = res.get("memory") or {}
        detail = " ".join(f"{k} {v['pct']}%" for k, v in mem.items()) or res.get("status", "")
        return res["status"] == "ok", detail
    if step == "flash":
        plan = plan_for(cfg, project)
        res = flash_mod.flash(plan, verbose=verbose, log=log)
        return res["status"] == "ok", res["status"]
    if step == "debug_verify":
        plan = plan_for(cfg, project)
        res = flash_mod.debug(plan, mode="verify", log=log)
        hit = res.get("evidence", [])
        return res["status"] == "ok", (hit[0] if hit else res["status"])
    raise ElabError(f"未知 CI 步骤：{step}")


def run(cfg: Config, *, onhw: bool = False, only_job: str | None = None,
        only_project: str | None = None, clean: bool = False,
        verbose: bool = False, log=print) -> dict:
    matrix = load_matrix(cfg)
    jobs = matrix.get("jobs") or []
    out = {"jobs": [], "passed": True}

    for job in jobs:
        name = job.get("name", "?")
        if only_job and name != only_job:
            continue
        steps = job.get("steps") or []
        is_onhw = bool(ONHW_STEPS & set(steps))
        entry = {"job": name, "desc": job.get("desc", ""), "onhw": is_onhw, "projects": []}

        if is_onhw and not onhw:
            entry["status"] = "skipped"
            entry["reason"] = "上板门禁（需 --onhw）"
            out["jobs"].append(entry)
            log(f"[ci] —— 跳过 {name}（上板门禁，需 --onhw）")
            continue

        log(f"\n[ci] ▶ {name}  ({job.get('desc', '')})")
        job_ok = True
        for project in job.get("projects", []):
            if only_project and project != only_project:
                continue
            proj_entry = {"project": project, "steps": []}
            for step in steps:
                try:
                    ok, detail = _run_step(cfg, step, project, clean=clean,
                                           verbose=verbose, log=log)
                except ElabError as exc:
                    ok, detail = False, str(exc)
                proj_entry["steps"].append({"step": step, "ok": ok, "detail": detail})
                mark = "✓" if ok else "✗"
                log(f"[ci]   [{mark}] {project:<12} {step:<14} {detail}")
                if not ok:
                    job_ok = False
            entry["projects"].append(proj_entry)
        entry["status"] = "ok" if job_ok else "failed"
        if not job_ok:
            out["passed"] = False
        out["jobs"].append(entry)

    return out
