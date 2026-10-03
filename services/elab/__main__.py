"""elab —— elab-Flow 命令行入口（L3）。

用法
----
    elab list                        列出主机 / 芯片 / 项目
    elab doctor [-p NAME] [--deep]   环境体检 + 两源漂移校验
    elab build  -p NAME [--clean]    YAML 驱动的 configure + build + 统一产物
    elab flash  -p NAME              openocd 烧录
    elab debug  -p NAME [--run]      生成/运行 openocd + gdb

所有参数都来自 YAML（L0/L1/L4），CLI 里没有任何硬编码路径。
"""

from __future__ import annotations

import argparse
import json
import sys

from . import __version__
from .config import Config, ElabError, Host
from . import builder, ci as ci_mod, doctor as doctor_mod, flash as flash_mod
from . import skillgen
from .plan import plan_for


def _add_common(p):
    p.add_argument("--root", help="覆盖 ELAB_ROOT（默认本文件所在目录）")
    p.add_argument("--json", action="store_true", help="机器可读输出")


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="elab",
        description="elab-Flow：一套工具链 + 一套流程，驱动不同芯片的编译/烧录/调试闭环",
    )
    ap.add_argument("--version", action="version", version=f"elab {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="列出主机 / 芯片 / 项目")
    _add_common(p)

    p = sub.add_parser("doctor", help="环境体检 + 两源漂移校验")
    _add_common(p)
    p.add_argument("-p", "--project", help="只检查某个项目")
    p.add_argument("--deep", action="store_true", help="真跑 configure 取实际编译命令作证据")

    p = sub.add_parser("build", help="构建项目")
    _add_common(p)
    p.add_argument("-p", "--project", help="项目名")
    p.add_argument("--all", action="store_true", help="构建全部项目")
    p.add_argument("--clean", action="store_true", help="先清空工作目录")
    p.add_argument("-j", "--jobs", type=int, help="并行任务数")
    p.add_argument("-v", "--verbose", action="store_true", help="透传子进程输出")
    p.add_argument("--dry-run", action="store_true", help="只打印计划，不执行")
    p.add_argument("--no-guard", action="store_true", help="跳过零改动快照比对")

    p = sub.add_parser("flash", help="openocd 烧录")
    _add_common(p)
    p.add_argument("-p", "--project", required=True, help="项目名")
    p.add_argument("--dry-run", action="store_true", help="只打印命令")
    p.add_argument("-v", "--verbose", action="store_true")

    p = sub.add_parser("debug", help="openocd + gdb 调试")
    _add_common(p)
    p.add_argument("-p", "--project", required=True, help="项目名")
    p.add_argument("--run", action="store_true", help="起 openocd + 交互式 gdb")
    p.add_argument("--verify", action="store_true",
                   help="非交互自检：断到 main 后打印证据并退出")

    p = sub.add_parser("loop", help="一键闭环：doctor → build → flash → debug")
    _add_common(p)
    p.add_argument("-p", "--project", required=True, help="项目名")
    p.add_argument("--clean", action="store_true", help="先清空工作目录")
    p.add_argument("--no-debug", action="store_true", help="跳过 debug 自检")
    p.add_argument("--dry-run", action="store_true", help="只跑到 build，不烧录")
    p.add_argument("-v", "--verbose", action="store_true")

    p = sub.add_parser("ci", help="按 ci/matrix.yaml 跑 CI 矩阵")
    _add_common(p)
    p.add_argument("--onhw", action="store_true", help="连上板门禁一起跑（需探针）")
    p.add_argument("--job", help="只跑某个 job")
    p.add_argument("-p", "--project", help="只跑某个项目")
    p.add_argument("--clean", action="store_true", help="先清空工作目录")
    p.add_argument("-v", "--verbose", action="store_true")

    p = sub.add_parser("skill", help="由 chips/*.yaml 生成 per-chip AI skill")
    _add_common(p)
    p.add_argument("-p", "--project", help="按项目推导芯片")
    p.add_argument("--chip", help="按 vendor/id 指定芯片")
    p.add_argument("--all", action="store_true", help="为所有芯片生成")

    return ap


def _cfg(args) -> Config:
    return Config(getattr(args, "root", None))


def main(argv=None) -> int:
    args = _parser().parse_args(argv)
    try:
        return _dispatch(args)
    except ElabError as exc:
        print(f"[elab] 错误：{exc}", file=sys.stderr)
        return 1


def _dispatch(args) -> int:
    cfg = _cfg(args)

    if args.cmd == "list":
        return cmd_list(cfg, args)
    if args.cmd == "doctor":
        return cmd_doctor(cfg, args)
    if args.cmd == "build":
        return cmd_build(cfg, args)
    if args.cmd == "flash":
        return cmd_flash(cfg, args)
    if args.cmd == "debug":
        return cmd_debug(cfg, args)
    if args.cmd == "loop":
        return cmd_loop(cfg, args)
    if args.cmd == "ci":
        return cmd_ci(cfg, args)
    if args.cmd == "skill":
        return cmd_skill(cfg, args)
    return 2


# ── list ──────────────────────────────────────────────────────────
def cmd_list(cfg: Config, args) -> int:
    host = Host(cfg)
    data = {
        "elab_root": str(cfg.root).replace("\\", "/"),
        "host_yaml": cfg.host_path.as_posix(),
        "os": host.os,
        "toolchains": [k for k in (cfg.host.get("toolchains") or {})],
        "arm_gcc_root": host.gcc_root,
        "arm_gcc_version": host.gcc.get("version"),
        "ninja": host.ninja,
        "openocd": host.openocd,
        "chips": [
            {"ref": f"{c.get('vendor')}/{c.get('id')}", "cpu": (c.get("core") or {}).get("cpu"),
             "fpu": (c.get("core") or {}).get("fpu"), "part": c.get("part")}
            for c in _uniq_chips(cfg)
        ],
        "projects": [
            {"name": p.get("name"), "chip": p.get("chip"), "archetype": p.get("archetype"),
             "root": p.get("root")}
            for p in cfg.projects.values()
        ],
    }
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    print(f"elab            {data['elab_root']}")
    print(f"host.yaml       {data['host_yaml']}  (os={host.os})")
    print(f"toolchain       {host.gcc_root}  {host.gcc.get('version')}")
    print(f"ninja           {host.ninja}")
    print(f"openocd         {host.openocd}")
    print()
    print("chips:")
    for c in data["chips"]:
        print(f"  {c['ref']:<26} cpu={c['cpu']:<12} fpu={c['fpu']:<6} {c['part']}")
    print("projects:")
    for p in data["projects"]:
        print(f"  {p['name']:<14} {p['archetype']}-class  chip={p['chip']:<24} {p['root']}")
    return 0


def _uniq_chips(cfg: Config):
    seen, out = set(), []
    for chip in cfg.chips.values():
        key = id(chip)
        if key in seen:
            continue
        seen.add(key)
        out.append(chip)
    return out


# ── doctor ────────────────────────────────────────────────────────
def cmd_doctor(cfg: Config, args) -> int:
    rep = doctor_mod.run(cfg, only=args.project, deep=args.deep)
    if args.json:
        print(json.dumps(
            {"passed": rep.passed,
             "items": [{"level": l, "code": c, "msg": m} for l, c, m in rep.items]},
            ensure_ascii=False, indent=2))
    else:
        print(f"[elab] doctor @ {cfg.root}")
        print(rep.render())
        print()
        if rep.passed:
            extra = f"，{len(rep.warns)} 条告警" if rep.warns else ""
            print(f"[elab] ✓ 体检通过{extra}")
        else:
            print(f"[elab] ✗ {len(rep.errors)} 项失败, {len(rep.warns)} 项告警")
    return 0 if rep.passed else 1


# ── build ─────────────────────────────────────────────────────────
def cmd_build(cfg: Config, args) -> int:
    if args.all:
        names = list(cfg.projects)
    elif args.project:
        names = [args.project]
    else:
        known = ", ".join(sorted(cfg.projects)) or "(无)"
        print(f"[elab] 用法：elab build -p NAME 或 --all\n       可选项目：{known}", file=sys.stderr)
        return 2

    results = []
    silent = (lambda *a, **k: None) if args.json else print
    for name in names:
        plan = plan_for(cfg, name)
        res = builder.build_project(
            plan,
            clean=args.clean,
            jobs=args.jobs,
            verbose=args.verbose,
            dry_run=args.dry_run,
            skip_guard=args.no_guard,
            log=silent,
        )
        results.append(res)
        if not args.json:
            if args.dry_run:
                print(f"[elab] 计划 {name}:")
                print("  " + plan.shell_preview())
            else:
                print(builder.render_summary(res))

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(r["status"] in ("ok", "dry-run") for r in results) else 1


# ── flash / debug ─────────────────────────────────────────────────
def cmd_flash(cfg: Config, args) -> int:
    plan = plan_for(cfg, args.project)
    silent = (lambda *a, **k: None) if args.json else print
    res = flash_mod.flash(plan, dry_run=args.dry_run, verbose=args.verbose, log=silent)
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    elif args.dry_run:
        print("[elab] openocd 命令：")
        print("  " + " ".join(f'"{a}"' if " " in a else a for a in res["argv"]))
    return 0 if res["status"] in ("ok", "dry-run") else 1


def cmd_debug(cfg: Config, args) -> int:
    plan = plan_for(cfg, args.project)
    mode = "verify" if args.verify else ("run" if args.run else "print")
    silent = (lambda *a, **k: None) if args.json else print
    res = flash_mod.debug(plan, mode=mode, log=silent)
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    elif mode == "print":
        print("[elab] ① 启动 openocd 服务：")
        print("  " + " ".join(f'"{a}"' if " " in a else a for a in res["openocd"]))
        print("[elab] ② 连接 gdb：")
        print("  " + " ".join(f'"{a}"' if " " in a else a for a in res["gdb"]))
    return 0 if res["status"] in ("ok", "printed") else 1


# ── loop：一键闭环 ────────────────────────────────────────────────
def cmd_loop(cfg: Config, args) -> int:
    """doctor → build → flash → debug(verify)，一条命令走完闭环。"""
    name = args.project
    steps = []

    def step(no, title):
        print(f"\n{'=' * 62}\n[{no}/4] {title}\n{'=' * 62}")

    # ① doctor
    step(1, f"doctor —— 环境体检 + 漂移校验（{name}）")
    rep = doctor_mod.run(cfg, only=name, deep=False)
    print(rep.render())
    steps.append(("doctor", rep.passed))
    if not rep.passed:
        print("\n[elab] ✗ 体检未通过，闭环中止")
        return 1

    # ② build
    step(2, "build —— YAML 驱动构建 + 统一产物")
    plan = plan_for(cfg, name)
    res = builder.build_project(plan, clean=args.clean, verbose=args.verbose)
    print(builder.render_summary(res))
    steps.append(("build", res["status"] == "ok"))
    if res["status"] != "ok":
        print("\n[elab] ✗ 构建失败，闭环中止")
        return 1

    if args.dry_run:
        print("\n[elab] --dry-run：已停在 build，未烧录")
        return 0

    # ③ flash
    step(3, "flash —— openocd 烧录 + verify")
    f = flash_mod.flash(plan, verbose=args.verbose)
    steps.append(("flash", f["status"] == "ok"))
    if f["status"] != "ok":
        print("\n[elab] ✗ 烧录失败，闭环中止")
        return 1

    # ④ debug verify
    if not args.no_debug:
        step(4, "debug —— 断到 main 自检")
        d = flash_mod.debug(plan, mode="verify")
        steps.append(("debug", d["status"] == "ok"))
        if d["status"] != "ok":
            print("\n[elab] ✗ 调试自检失败")
            return 1
    else:
        steps.append(("debug", None))

    print(f"\n{'=' * 62}")
    for s, ok in steps:
        mark = "✓" if ok else ("—" if ok is None else "✗")
        print(f"  [{mark}] {s}")
    print(f"{'=' * 62}")
    print(f"[elab] ✓✓ 闭环完成：{name}")
    return 0


# ── ci：CI 矩阵 ───────────────────────────────────────────────────
def cmd_ci(cfg: Config, args) -> int:
    silent = (lambda *a, **k: None) if args.json else print
    res = ci_mod.run(cfg, onhw=args.onhw, only_job=args.job,
                     only_project=args.project, clean=args.clean,
                     verbose=args.verbose, log=silent)
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print()
        for j in res["jobs"]:
            mark = {"ok": "✓", "failed": "✗", "skipped": "—"}.get(j["status"], "?")
            extra = f"  ({j.get('reason')})" if j.get("reason") else ""
            print(f"  [{mark}] {j['job']}{extra}")
        print()
        print("[elab] ✓ CI 通过" if res["passed"] else "[elab] ✗ CI 失败")
    return 0 if res["passed"] else 1


# ── skill：生成 per-chip AI skill ─────────────────────────────────
def cmd_skill(cfg: Config, args) -> int:
    silent = (lambda *a, **k: None) if args.json else print
    written = skillgen.generate(cfg, project=args.project, chip_ref=args.chip,
                                all_chips=args.all, log=silent)
    if args.json:
        print(json.dumps(written, ensure_ascii=False, indent=2))
    else:
        print(f"[elab] 已生成 {len(written)} 份 per-chip skill（内容源自 chips/*.yaml）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
