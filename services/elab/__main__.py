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
from . import adapt as adapt_mod, builder, ci as ci_mod, doctor as doctor_mod, flash as flash_mod
from . import monitor as monitor_mod
from . import run as run_mod
from . import serialport as serialport_mod
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

    p = sub.add_parser("loop", help="一键闭环：doctor → build → flash → debug → monitor")
    _add_common(p)
    p.add_argument("-p", "--project", required=True, help="项目名")
    p.add_argument("--clean", action="store_true", help="先清空工作目录")
    p.add_argument("--no-flash", action="store_true", help="跳过 flash 烧录（无探针环境）")
    p.add_argument("--no-debug", action="store_true", help="跳过 debug 自检")
    p.add_argument("--no-monitor", action="store_true", help="跳过串口闭环判据")
    p.add_argument("--dry-run", action="store_true",
                   help="只读预览本轮将执行的命令与效果（什么都不执行）。"
                        "想\"只跑 doctor+build 不烧录\"请用 --no-flash --no-debug --no-monitor")
    p.add_argument("-v", "--verbose", action="store_true")

    p = sub.add_parser("monitor",
                       help="串口闭环判据：读串口 → 判 ok / failed / inconclusive")
    _add_common(p)
    p.add_argument("-p", "--project", required=True, help="项目名")
    p.add_argument("--port", help="覆盖 serial.port（默认取 projects/*.yaml 的 auto）")
    p.add_argument("--seconds", type=float, default=0.0,
                   help="观察窗口秒数（默认取 close_on.within_s）")
    p.add_argument("-q", "--quiet", action="store_true", help="不回显收到的每一行")
    p.add_argument("--reset-port", action="store_true",
                   help="先尝试软复位该 USB 设备（等价拔插一次 DAP-Link，通常需管理员权限）")
    p.add_argument("--caps", action="store_true", help="只打印串口后端能力并退出")

    p = sub.add_parser("ci", help="按 ci/matrix.yaml 跑 CI 矩阵")
    _add_common(p)
    p.add_argument("--onhw", action="store_true", help="连上板门禁一起跑（需探针）")
    p.add_argument("--job", help="只跑某个 job")
    p.add_argument("-p", "--project", help="只跑某个项目")
    p.add_argument("--clean", action="store_true", help="先清空工作目录")
    p.add_argument("-v", "--verbose", action="store_true")

    p = sub.add_parser("run",
                       help="事件驱动运行：跑一串步骤并可选地发射 cockpit 事件流")
    _add_common(p)
    p.add_argument("-p", "--project", required=True, help="项目名")
    p.add_argument("--steps", help=f"逗号分隔，默认 {','.join(run_mod.DEFAULT_STEPS)}"
                                   f"（可选：{','.join(run_mod.ALL_STEPS)}）")
    p.add_argument("--emit-events", action="store_true",
                   help="把事件写成只追加 JSONL（驾驶舱跟读它；见 docs/ICD_cockpit_events.md）")
    p.add_argument("--events-dir", help="覆盖运行产物目录（默认 .work/.cockpit/runs）")
    p.add_argument("--run-id", help="指定 run id（默认自动分配 r-<8hex>）")
    p.add_argument("--actor", choices=["agent", "human"], default="agent",
                   help="这条时间线上是谁在操作（契约要求每条事件都在位）")
    p.add_argument("--clean", action="store_true", help="build 前清空工作目录")
    p.add_argument("-j", "--jobs", type=int, help="并行任务数")
    p.add_argument("-v", "--verbose", action="store_true", help="透传子进程输出")
    p.add_argument("-q", "--quiet", action="store_true", help="不回显逐行输出")
    p.add_argument("--keep-going", action="store_true",
                   help="失败也继续跑后续步骤（默认失败即停）")
    p.add_argument("--dry-run", action="store_true", dest="dry_run",
                   help="只读预览：打印每步将执行的命令/效果，**不执行任何东西**")

    p = sub.add_parser("skill", help="由 chips/*.yaml 生成 per-chip AI skill")
    _add_common(p)
    p.add_argument("-p", "--project", help="按项目推导芯片")
    p.add_argument("--chip", help="按 vendor/id 指定芯片")
    p.add_argument("--all", action="store_true", help="为所有芯片生成")

    p = sub.add_parser("adapt",
                       help="一键适配图形配置器导出的工程（确定性探测 → 生成 projects/*.yaml）")
    _add_common(p)
    p.add_argument("path", nargs="?", default=".",
                   help="要适配的工程目录（须含 CMakeLists.txt）")
    p.add_argument("-n", "--name", help="项目名（默认由目录名推导）")
    p.add_argument("--probe", action="store_true", help="只探测并打印结论（默认行为）")
    p.add_argument("--write", action="store_true", help="生成 projects/<name>.yaml")
    p.add_argument("--check", action="store_true",
                   help="幂等校验：已适配且与重新探测一致 → no-op（CI 守卫用）")
    p.add_argument("--verify", action="store_true",
                   help="适配后跑三绿灯：doctor --deep + build + guard.untouched")
    p.add_argument("--force", action="store_true",
                   help="存在未决项 / 人工改动时仍写入（覆盖前自动 .bak）")
    p.add_argument("--clean", action="store_true", help="--verify 时先清空工作目录")
    p.add_argument("-v", "--verbose", action="store_true", help="--verify 时透传子进程输出")

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
    if args.cmd == "run":
        return cmd_run(cfg, args)
    if args.cmd == "skill":
        return cmd_skill(cfg, args)
    if args.cmd == "adapt":
        return cmd_adapt(cfg, args)
    if args.cmd == "monitor":
        return cmd_monitor(cfg, args)
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


# ── monitor：串口闭环判据 ─────────────────────────────────────────
def cmd_monitor(cfg: Config, args) -> int:
    """退出码：0=ok，1=failed，2=inconclusive（★ 三态各有码，才能区分"没证据"与"失败"）。"""
    if args.caps:
        caps = serialport_mod.capabilities()
        ports, backend = serialport_mod.list_ports()
        data = {"capabilities": caps, "backend": backend,
                "ports": [{"name": p.name, "kind": p.kind, "device": p.device,
                           "desc": p.desc} for p in ports]}
        if args.json:
            print(json.dumps(data, ensure_ascii=False, indent=2))
            return 0 if caps["available"] else 2
        print(f"[monitor] 串口后端 layer={caps['layer']}  "
              f"pyserial={caps['pyserial']}  win32={caps['win32_ctypes']}  "
              f"可用={caps['available']}")
        if caps.get("hint"):
            print(f"          {caps['hint']}")
        print(f"[monitor] 枚举（backend={backend}，已去重）：")
        for p in ports:
            print(f"          {p}")
        chosen, why, _ = serialport_mod.select_port("auto", ports)
        print(f"[monitor] auto → {chosen or '(无)'}：{why}")
        return 0 if caps["available"] else 2

    silent = (lambda *a, **k: None) if args.json else print
    v = monitor_mod.run(cfg, args.project, port=args.port or "",
                        seconds=args.seconds, echo=not args.quiet,
                        reset_port=args.reset_port, log=silent)
    if args.json:
        print(json.dumps(v.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(monitor_mod.render(v))
    return monitor_mod.exit_code(v)


# ── loop：一键闭环 ────────────────────────────────────────────────
def cmd_loop(cfg: Config, args) -> int:
    """doctor → build → flash → debug → monitor，一条命令走完闭环。

    ★ 阶段顺序不是随意的：monitor 必须在 flash/debug **之后** ——
      DAP-Link 是复合 USB 设备，openocd 占着 SWD 时它的虚拟串口打不开（约束 N5）。
    """
    name = args.project

    # ★ `--dry-run` 在本仓库**只有一个意思**：只读预览，什么都不执行。
    #   历史包袱：本命令早先把它实现成"跑到 build 就停"（真编译、不烧录），
    #   而同族的 `elab build/flash --dry-run` 是"只打印命令"。同一个 flag
    #   在两条子命令上意思相反，是最容易误伤的那类陷阱 ——
    #   用户以为"预览一下"，结果真编译了（还有 `--clean` 时甚至会删掉工作目录）。
    #   故统一到"只读预览"；原来那个能力**并未丢失**，用现成的
    #   `--no-flash --no-debug --no-monitor` 即可（或直接 `elab build`）。
    if args.dry_run:
        # 预览的步骤序列必须**与下面真正要跑的一致**（含 --no-* 开关的影响），
        # 否则预览又变成"说的和做的不一样"。
        pv_steps = ["doctor", "build"]
        if not args.no_flash:
            pv_steps.append("flash")
        if not args.no_debug:
            pv_steps.append("debug_verify")
        if not args.no_monitor:
            pv_steps.append("monitor")
        return cmd_run(cfg, argparse.Namespace(
            project=name, steps=",".join(pv_steps), clean=args.clean, jobs=None,
            verbose=args.verbose, actor="agent", emit_events=False,
            run_id=None, quiet=False, events_dir=None, keep_going=False,
            json=getattr(args, "json", False), dry_run=True))

    steps = []
    # 步骤总数随 --no-* 开关变化；**别再手写编号**（旧版写死 [3/5]/[4/5]，
    # 加了 --no-flash 之后编号就会自相矛盾）。
    n_steps = 2 + (0 if args.no_flash else 1) + \
        (0 if args.no_debug else 1) + (0 if args.no_monitor else 1)
    _no = [0]

    def step(_unused, title):
        _no[0] += 1
        print(f"\n{'=' * 62}\n[{_no[0]}/{n_steps}] {title}\n{'=' * 62}")

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

    # ③ flash
    if not args.no_flash:
        step(3, "flash —— openocd 烧录 + verify")
        f = flash_mod.flash(plan, verbose=args.verbose)
        steps.append(("flash", f["status"] == "ok"))
        if f["status"] != "ok":
            print("\n[elab] ✗ 烧录失败，闭环中止")
            return 1
    else:
        # 无探针环境（CI/笔记本上没插板）：doctor+build 仍然可跑，这正是
        # `--no-flash --no-debug --no-monitor` 的用途 —— 它替换掉了旧版
        # `--dry-run` 那个"跑到 build 就停"的语义（见 cmd_loop 顶部注释）。
        steps.append(("flash", None))

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

    # ⑤ monitor：串口闭环判据（必须排在 openocd 之后，见约束 N5）
    mon_status = None
    if not args.no_monitor:
        step(5, "monitor —— 串口闭环判据（close_on / fail_on）")
        v = monitor_mod.run(cfg, name, echo=not args.json)
        print(monitor_mod.render(v))
        if v.status == "failed":
            mon_status = False
        elif v.status == "ok":
            mon_status = True
        else:
            mon_status = "inconcl"      # ★ 无证据 ≠ 失败，不中断闭环
        steps.append(("monitor", mon_status))

    print(f"\n{'=' * 62}")
    failed = False
    for s, ok in steps:
        mark = {True: "✓", False: "✗", None: "—", "inconcl": "?"}.get(ok, "?")
        extra = "  (无结论：未见约定关键字)" if ok == "inconcl" else ""
        print(f"  [{mark}] {s}{extra}")
        if ok is False:
            failed = True
    print(f"{'=' * 62}")
    if failed:
        print(f"[elab] ✗ 闭环未通过：{name}")
        return 1
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


# ── run：事件驱动运行 ─────────────────────────────────────────────
def cmd_run(cfg: Config, args) -> int:
    """跑一串步骤，可选地把每一步写成事件。

    退出码：0 = 全部步骤通过；1 = 有步骤失败。**与 `elab ci` 一致**，
    方便驾驶舱/脚本直接看码而不必解析输出。
    """
    # ★ `--dry-run` 走**另一条路**：预览是只读的，绝不发射事件、绝不写工作目录。
    #   退出码恒为 0（"能不能预览出来"不是"预览出来的东西能不能跑通"）。
    if getattr(args, "dry_run", False):
        pv = run_mod.preview(cfg, args.project, steps=args.steps,
                             clean=args.clean, jobs=args.jobs)
        if args.json:
            print(json.dumps(pv, ensure_ascii=False, indent=2))
        else:
            print()
            print(run_mod.render_preview(pv))
        return 0

    res = run_mod.run(
        cfg, args.project,
        steps=args.steps, clean=args.clean, jobs=args.jobs,
        verbose=args.verbose, actor=args.actor,
        emit_events=args.emit_events, run_id=args.run_id,
        echo=not args.quiet, runs_dir=args.events_dir,
        keep_going=args.keep_going,
    )
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print()
        print(run_mod.render(res))
        if args.emit_events:
            print(f"[elab] 事件 → {res['events']['state']}")
            print(f"       跟读 → {res['events']['proc']}")
    return 0 if res["ok"] else 1


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


# ── adapt：一键适配 ───────────────────────────────────────────────
def cmd_adapt(cfg: Config, args) -> int:
    """探测 →（可选）写接入文件 →（可选）三绿灯自证。

    退出码约定（供 CI / agent 消费）：
      probe  : 0 = 可适配；1 = T3（无 CMakeLists.txt，需真改造）
      write  : 0 = written/identical；1 = 被拒（未决项）/ differs / hand-edited
      check  : 0 = identical；1 = drift/missing
      verify : 0 = 三绿灯全过
    """
    silent = (lambda *a, **k: None) if args.json else print

    if args.verify:
        rc = _adapt_verify(cfg, args, silent)
        return rc

    res = adapt_mod.run(cfg, path=args.path, name=args.name or "",
                        write_it=args.write, check=args.check,
                        force=args.force, log=silent)

    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0 if res.get("tier") != "T3" else 1

    if res["tier"] == "T3":
        return 1
    if args.check:
        return 0 if (res.get("result") or {}).get("status") == "identical" else 1
    if args.write:
        st = (res.get("result") or {}).get("status")
        return 0 if st in ("written", "identical") else 1
    return 0


def _adapt_verify(cfg: Config, args, log) -> int:
    """适配 → 重载配置 → 三绿灯：doctor --deep + build + guard.untouched。

    这是「适配成功」的可证伪判据：不只看文件写没写出来，
    还要证明①接入声明与环境自洽、②真能编译出 elf、③业务工程一个字节没动。
    """
    probe = adapt_mod.probe_project(cfg, args.path)
    name = args.name or adapt_mod.default_name(probe)

    log(f"{'=' * 62}\n[adapt 1/5] 确定性探测\n{'=' * 62}")
    log(adapt_mod.render_probe(probe))
    if probe.tier == "T3":
        log("\n[adapt] ✗ T3：工程根目录没有 CMakeLists.txt，无法适配")
        return 1

    log(f"\n{'=' * 62}\n[adapt 2/5] 生成接入文件 projects/{name}.yaml\n{'=' * 62}")
    wr = adapt_mod.write(cfg, probe, name=name, force=args.force, log=log)
    if wr["status"] not in ("written", "identical"):
        log(f"[adapt] ✗ 接入文件未就绪（status={wr['status']}）")
        return 1

    # 新增了 projects/*.yaml → 必须重载 Config 才能让 doctor/plan 看到它
    cfg2 = Config(getattr(args, "root", None))
    if name not in cfg2.projects:
        log(f"[adapt] ✗ 重载后仍未发现项目 {name}（检查 {wr['path']} 的 name/root 字段）")
        return 1

    log(f"\n{'=' * 62}\n[adapt 3/5] doctor --deep —— 接入声明 vs 实际编译命令\n{'=' * 62}")
    rep = doctor_mod.run(cfg2, only=name, deep=True)
    log(rep.render())
    if not rep.passed:
        log(f"\n[adapt] ✗ 体检未通过（{len(rep.errors)} 项失败）")
        return 1
    log("[adapt] ✓ 体检通过")

    log(f"\n{'=' * 62}\n[adapt 4/5] build —— 真编译 + 统一产物\n{'=' * 62}")
    plan = plan_for(cfg2, name)
    res = builder.build_project(plan, clean=args.clean, verbose=args.verbose, log=log)
    log(builder.render_summary(res))
    if res["status"] != "ok":
        log(f"\n[adapt] ✗ 构建失败（{res['status']}）")
        return 1

    guard = res.get("guard") or {}
    untouched = guard.get("untouched")

    log(f"\n{'=' * 62}\n[adapt 5/5] 三绿灯判据\n{'=' * 62}")
    def g(ok):
        return "✓" if ok else "✗"
    log(f"  [{g(rep.passed)}] doctor --deep        接入声明与环境自洽")
    log(f"  [{g(res['status'] == 'ok')}] build               产出 {len(res.get('artifacts') or {})} 个产物")
    log(f"  [{g(untouched)}] guard.untouched     业务工程零改动"
        + ("" if untouched is None else
           f"  (+{len(guard.get('added') or [])} -{len(guard.get('removed') or [])}"
           f" ~{len(guard.get('changed') or [])})"))
    if untouched is False:
        log("\n[adapt] ✗ 业务工程被改动了 —— 违背「适配≠改造」，请检查构建是否写了源目录")
        return 1
    log(f"\n[adapt] ✓✓✓ 三绿灯达成：{name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
