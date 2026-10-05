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


def _doctor_detail(rep) -> str:
    """失败时带上错误正文，而不是只给一个 code —— CI 排障要看证据。"""
    errs = [(c, m) for lvl, c, m in rep.items if lvl == "error"]
    if not errs:
        return "全绿"
    return "; ".join(f"{c}: {m}" for c, m in errs)


def load_matrix(cfg: Config) -> dict:
    path = cfg.root / "ci" / "matrix.yaml"
    if not path.exists():
        raise ElabError(f"找不到 CI 矩阵：{path}")
    return _yaml.load_file(path) or {}


def _run_step(cfg: Config, step: str, project: str, *, clean: bool, verbose: bool, log):
    """执行单个步骤，返回 ``(ok, detail, extra)``。

    ``extra`` 会**原样并进 CI 报告**（目前只有 ``build`` 用，放产物路径）。

    ★ 为什么产物清单必须进报告：**产物文件名是按工程定的**
      （``at32_test`` → ``TEST.elf``，``at32f421g8u7`` → ``AT32F421G8U7.elf``）。
      早先工作流把上传路径硬编码成 ``.work/*/TEST.*`` —— 接入新工程的后果是
      **云端跑绿、固件却传不上来**（``if-no-files-found: warn`` 静默降级），
      属于典型的"假绿"。报告自带清单后，工作流不必猜名字，
      接入第 4 个工程**无需改 workflow**，可接入性因此不再依赖改 CI 脚本。
    """
    if step == "doctor_deep":
        rep = doctor_mod.run(cfg, only=project, deep=True)
        return rep.passed, _doctor_detail(rep), {}
    if step == "doctor":
        rep = doctor_mod.run(cfg, only=project, deep=False)
        return rep.passed, _doctor_detail(rep), {}
    if step == "build":
        plan = plan_for(cfg, project)
        res = builder.build_project(plan, clean=clean, verbose=verbose, log=log)
        if res["status"] != "ok":
            # ★ 必须带上编译/配置错误正文：否则 CI 只剩 "build-failed" 四个字，无从排障。
            return False, f"{res['status']}: {res.get('error', '')}", {}
        mem = res.get("memory") or {}
        detail = " ".join(f"{k} {v['pct']}%" for k, v in mem.items()) or res["status"]
        return True, detail, {"artifacts": res.get("artifacts") or {},
                              "memory": mem,
                              "memory_source": res.get("memory_source")}
    if step == "flash":
        plan = plan_for(cfg, project)
        res = flash_mod.flash(plan, verbose=verbose, log=log)
        return res["status"] == "ok", res["status"], {}
    if step == "debug_verify":
        plan = plan_for(cfg, project)
        res = flash_mod.debug(plan, mode="verify", log=log)
        hit = res.get("evidence", [])
        return res["status"] == "ok", (hit[0] if hit else res["status"]), {}
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
                extra: dict = {}
                try:
                    ok, detail, extra = _run_step(cfg, step, project, clean=clean,
                                                  verbose=verbose, log=log)
                except ElabError as exc:
                    ok, detail = False, str(exc)
                proj_entry["steps"].append({"step": step, "ok": ok, "detail": detail,
                                            **extra})
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
