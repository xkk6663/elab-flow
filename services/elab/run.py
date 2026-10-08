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

import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import builder, doctor as doctor_mod, flash as flash_mod
from . import monitor as monitor_mod
from . import serialport as serialport_mod
from ._winproc import proc_kwargs
from .config import Config, ElabError, to_fwd
from .kernel.events import (ACTOR_AGENT, SERIAL_CLOSE, SERIAL_CLOSED_LOOP,
                            SERIAL_LINE, SERIAL_OPEN, EventLog)
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

#: 项目声明工具步骤前缀（``tool:<name>``，定义在 ``projects/*.yaml`` 的
#: ``tools:`` 节）。★ 这是**通用机制**而非业务：框架只知道"跑项目声明的命令、
#: 逐行进事件流"，命令本身与业务语义全部留在项目 YAML 里 —— 纯度原则不受影响。
TOOL_PREFIX = "tool:"


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
    """把 ``"doctor,build"`` 解析成列表，并校验步骤名（防拼写错静默变成 no-op）。

    ``tool:<name>`` 形态在这里只做格式校验；``<name>`` 是否真的在项目 YAML 里
    声明，由 ``_resolve_tool`` 在执行/预览时报错（parse_steps 没有 project 上下文）。
    """
    if not spec:
        return list(default)
    out = [s.strip() for s in spec.split(",") if s.strip()]
    bad = [s for s in out
           if s not in ALL_STEPS
           and not (s.startswith(TOOL_PREFIX) and len(s) > len(TOOL_PREFIX))]
    if bad:
        raise RunError(f"未知步骤：{', '.join(bad)}（可选：{', '.join(ALL_STEPS)}"
                       f"，或 tool:<项目yaml tools 里声明的名字>）")
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


# ── 项目声明工具（tool:<name>）─────────────────────────────────────
def _resolve_tool(cfg: Config, project: str, name: str) -> tuple[list[str], str, str]:
    """项目 YAML 的 ``tools.<name>`` → (argv, cwd, label)。

    YAML 形态（一切业务语义都留在项目配置里，框架只做替换与派发）::

        tools:
          ota:
            label: OTA 升级
            cwd: <工作目录，缺省 = 项目 root>
            env: {IAP_PROFILE: F411}          # 追加到子进程环境
            cmd: [python, "-u", "panels/ota/cli_flash.py",
                  "--port", "${serial_port}", "--firmware", "${work_dir}/411.bin",
                  "--emit-events", "${runs_dir}"]

    模板变量：``${serial_port}``（按项目 serial.port 解析，auto 走选口规则并
    排除蓝牙虚拟口）、``${root}``、``${work_dir}``、``${name}``、``${runs_dir}``。
    """
    proj = cfg.resolved_project(project)
    tools = proj.get("tools") or {}
    if name not in tools:
        raise RunError(f"项目 {project} 的 YAML 未声明 tools.{name}")
    t = tools[name] or {}
    argv = t.get("cmd") or []
    if isinstance(argv, str):
        argv = argv.split()
    if not argv:
        raise RunError(f"tools.{name}.cmd 为空")

    build = proj.get("build") or {}
    root = to_fwd(proj.get("root", ""))
    work_dir = to_fwd(build.get("work_dir", ""))
    runs_dir = str(runs_dir_for(cfg))

    subs = {"serial_port": "", "root": root, "work_dir": work_dir,
            "name": project, "runs_dir": runs_dir}
    if any("${serial_port}" in str(a) for a in argv):
        spec = ((proj.get("serial") or {}).get("port")) or "auto"
        ports, _layer = serialport_mod.list_ports()
        port, why, _cands = serialport_mod.select_port(spec, ports)
        if not port:
            raise RunError(f"tool:{name} 需要串口（{spec}）：{why}")
        subs["serial_port"] = port

    def _sub(s: str) -> str:
        for k, v in subs.items():
            s = s.replace("${" + k + "}", v)
        return s

    argv = [to_fwd(_sub(str(a))) for a in argv]
    cwd = to_fwd(_sub(str(t.get("cwd") or root))) or None
    return argv, cwd or ".", str(t.get("label") or name)


def _run_tool(cfg: Config, project: str, name: str, *, sink) -> "StepOutcome":
    """执行项目声明工具：子进程逐行 → sink（= proc/stdout 事件 + 终端回显）。

    ★ 已知限制：驾驶舱"取消"杀的是 elab run 进程，本子进程会变孤儿继续跑完
      （工具自身有 deadline，最坏情况是自己收尾；孤儿持有的串口在它退出前
      不可复用 —— 与 N5 同性质）。后续可改用 Job Object 一并终结（框架增强项）。
    """
    argv, cwd, label = _resolve_tool(cfg, project, name)
    sink(f"[tool:{name}] {label}")
    sink(f"[tool:{name}] $ {' '.join(argv)}")
    env = dict(os.environ)
    env.update({str(k): str(v) for k, v in
                ((cfg.resolved_project(project).get("tools") or {})
                 .get(name, {}).get("env") or {}).items()})
    t0 = time.time()
    proc = subprocess.Popen(
        argv, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        **proc_kwargs(),
    )
    tail = ""
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip("\r\n")
        if line:
            tail = line
            sink(line)
    rc = proc.wait()
    ok = rc == 0
    dt = time.time() - t0
    sink(f"[tool:{name}] exit={rc} ({dt:.1f}s)")
    return StepOutcome(ok, (tail or f"exit={rc}")[:120], {"exit_code": rc})


def _execute(cfg: Config, step: str, project: str, *, clean: bool, jobs: int | None,
             verbose: bool, sink, elog=None) -> StepOutcome:
    """执行一步。**只调用既有库函数**，不改它们的行为。

    ``elog`` 只被 ``monitor`` 步用：串口是**域事件**（`serial/*`），不能只塞进
    `run/step-exit` 的 detail，否则驾驶舱的串口 Tab / 闭环时间线拿不到逐行数据。
    其余步骤不需要它 —— 它们的结果本来就是"一步一次"的标量。
    """
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
        # ★ 串口事件由**本进程**（这个 run 的唯一写者）发出 —— 契约 §5.3 / §16.5：
        #     serial/open → serial/line（逐行）→ serial/close → serial/closed-loop
        #   monitor.py 是纯库（判据可离线单测），用回调把"串口发生了什么"交出来；
        #   接线放这里，于是"判定"与"传输"不焊死。
        def _ev(topic: str, **fields):
            if elog is not None:
                elog.emit(topic, project=project, **fields)

        v = monitor_mod.run(
            cfg, project, echo=False, log=sink,
            on_open=lambda port, baud, backend, layer: _ev(
                SERIAL_OPEN, port=port, baud=baud, backend=backend, layer=layer),
            on_line=lambda ts, line: _ev(SERIAL_LINE, line=line, t=round(ts, 3)),
            on_close=lambda verdict: _ev(
                SERIAL_CLOSE, port=verdict.port, bytes=verdict.bytes_seen,
                lines=len(verdict.lines), backend=verdict.backend),
        )
        # ★ 三态不能塌成两态：inconclusive（没读到约定关键字）**不是失败**。
        #   与 cmd_loop 的语义保持一致；verdict 原样带给界面，让它分三色渲染。
        ok = v.status != "failed"
        extra = {"verdict": v.status, "serial": v.to_dict()}
        # §16.5：命中即发 ``serial/closed-loop`` 并**带证据行**。
        # ★ rule/evidence 直接取 judge() 已算好的 ``evidence[0]``（它本来就带 rule 键），
        #   不去解析 reason 文案 —— 靠字符串解析是脆的，文案一改就静默失效。
        top = (v.evidence or [{}])[0]
        _ev(SERIAL_CLOSED_LOOP, verdict=v.status,
            rule=top.get("rule") or "",
            evidence=top.get("line") or v.reason or "",
            detail=v.reason or "")
        return StepOutcome(ok, (v.reason or v.status), extra)

    if step.startswith(TOOL_PREFIX):
        return _run_tool(cfg, project, step[len(TOOL_PREFIX):], sink=sink)

    raise RunError(f"未知步骤：{step}")


# ── 只读预演（M2：「先看命令再执行」）────────────────────────────
def preview(cfg: Config, project: str, *, steps=None, clean: bool = False,
            jobs: int | None = None) -> dict:
    """把每个步骤**将要执行**的东西算出来，**什么都不做**。

    为什么值得单独做（R8「可手动干预」的前置）：
    驾驶舱里有"跑全闭环"这种高后果按钮，``--clean`` 还会**真删**工作目录。
    用户按下之前必须能看清它到底会执行什么 —— 尤其是 openocd 用了哪份
    interface/target cfg、cmake 带了哪些 ``-D``、以及哪个目录会被删掉。

    ★ 本函数**不复制任何命令构造逻辑**，而是复用各模块自己的
      dry-run / print 分支。理由：预览一旦与实跑分叉，"先看命令再执行"
      就从保障退化成**误导**，而且分叉是静默的 —— 没人会逐字比对两条命令。
      为此 `builder.build_command()` 被抽成函数、`flash`/`debug` 各加了
      `allow_missing_elf`（预览要能在**还没 build** 时也显示命令）。

    :returns: ``{project, steps, clean, jobs, plan:[...], warnings:[...]}``
              —— 结构直接 JSON 化给 ``/api/plan`` 与 ``elab run --dry-run``。
    """
    steps = parse_steps(",".join(steps) if isinstance(steps, (list, tuple)) else steps)
    plan: list[dict] = []
    warnings: list[str] = []

    # 需要 ELF 的两步共用一个 plan；只在真用得上时才构造（plan_for 会读 YAML）
    _plan_cache: dict = {}

    def _p():
        if "p" not in _plan_cache:
            _plan_cache["p"] = plan_for(cfg, project)
        return _plan_cache["p"]

    for step in steps:
        entry: dict = {"step": step, "spawns": True, "commands": [],
                       "effects": [], "note": "", "blocked": False}

        if step in ("doctor", "doctor_deep"):
            deep = step == "doctor_deep"
            entry["spawns"] = deep
            entry["note"] = ("静态体检：只读 L0/L1/L4 与工具链描述，**不派生子进程**。"
                             if not deep else
                             "深度体检：额外真跑一次 cmake configure（会写工作目录，但不编译）。")

        elif step == "build":
            p = _p()
            res = builder.build_project(p, dry_run=True)
            cmds = [res.get("configure_cmd") or p.configure_cmd(),
                    builder.build_command(p, jobs)]
            entry["commands"] = [c for c in cmds if c]
            entry["work_dir"] = res.get("work_dir", "")
            if clean:
                entry["effects"].append(
                    f"先删除工作目录（不可逆）：{res.get('work_dir', '')}")
            entry["note"] = (f"generator={p.generator}  type={p.build_type}  "
                             f"artifact={Path(p.elf).name if p.elf else '(未声明)'}")

        elif step == "flash":
            p = _p()
            try:
                res = flash_mod.flash(p, dry_run=True, allow_missing_elf=True, log=lambda *a: None)
                entry["commands"] = [res.get("argv") or []]
                if not res.get("elf_exists"):
                    entry["blocked"] = True
                    warnings.append(
                        f"flash 需要 ELF 已存在：{res.get('elf', '')} 目前不存在 —— "
                        f"预览按预期路径给出命令；真烧录前必须先 build。")
                entry["note"] = f"openocd program {{elf}} verify reset exit → {res.get('chip', '')}"
            except ElabError as exc:
                entry["blocked"] = True
                entry["note"] = f"无法给出命令：{exc}"

        elif step == "debug_verify":
            p = _p()
            try:
                res = flash_mod.debug(p, mode="print", allow_missing_elf=True,
                                      log=lambda *a: None)
                entry["commands"] = [res.get("openocd") or [], res.get("gdb") or []]
                if not Path(res.get("elf") or p.elf).exists():
                    entry["blocked"] = True
                    warnings.append(
                        f"debug_verify 需要 ELF 已存在：{p.elf} 目前不存在。")
                entry["note"] = "非交互自检：断到 main → 打证据 → reset run 退出"
            except ElabError as exc:
                entry["blocked"] = True
                entry["note"] = f"无法给出命令：{exc}"

        elif step == "monitor":
            # 串口没有"命令行"可预览，但有**等效的确定性参数**：
            # 选哪个口、什么波特率、按什么判据判 —— 这三样才是"它会做什么"。
            entry["spawns"] = False
            ser = (cfg.resolved_project(project).get("serial") or {})
            mon = (cfg.resolved_project(project).get("monitor") or {})
            host_ser = (cfg.host or {}).get("serial") or {}
            entry["serial"] = {
                "port": ser.get("port") or host_ser.get("default") or "auto",
                "baud": ser.get("baud") or host_ser.get("baud") or 115200,
                "close_on": mon.get("close_on") or [],
                "fail_on": mon.get("fail_on") or [],
                "idle_timeout_s": mon.get("idle_timeout_s"),
            }
            entry["note"] = ("不开子进程：本进程直接读串口（ctypes/pyserial 三层降级），"
                             "判定用 monitor.judge()。★ 与 openocd 互斥（约束 N5），"
                             "故必须排在 flash/debug 之后。")

        elif step.startswith(TOOL_PREFIX):
            # 项目声明工具：能给出的就是"替换完模板变量的最终命令行"本身。
            try:
                argv, cwd, label = _resolve_tool(cfg, project,
                                                 step[len(TOOL_PREFIX):])
                entry["commands"] = [argv]
                entry["note"] = (f"项目声明工具 {label}（cwd={cwd}）。"
                                 "输出逐行进事件流；退出码非 0 即失败。")
            except (RunError, ElabError) as exc:
                entry["blocked"] = True
                entry["note"] = str(exc)

        else:
            entry["spawns"] = False
            entry["note"] = f"未知步骤：{step}"

        plan.append(entry)

    return {"project": project, "steps": list(steps), "clean": bool(clean),
            "jobs": jobs, "plan": plan, "warnings": warnings}


def render_preview(pv: dict) -> str:
    """人读的预览（``elab run --dry-run``）。"""
    head = f"project={pv['project']}  steps={','.join(pv['steps'])}"
    if pv.get("clean"):
        head += "  --clean"
    if pv.get("jobs"):
        head += f"  -j {pv['jobs']}"
    L = [head, "（只读预览：下列命令**不会**被执行）"]
    for e in pv.get("plan", []):
        L.append("")
        L.append(f"── {e['step']}" + ("  [需前置产物]" if e.get("blocked") else ""))
        for x in e.get("effects") or []:
            L.append(f"   ⚠ {x}")
        for cmd in e.get("commands") or []:
            if cmd:
                L.append("   $ " + " ".join(_q(a) for a in cmd))
        s = e.get("serial")
        if s:
            L.append(f"   串口 {s['port']}@{s['baud']}  "
                     f"close_on={s['close_on'] or '无'}  fail_on={s['fail_on'] or '无'}")
        if e.get("note"):
            L.append(f"   · {e['note']}")
    for w in pv.get("warnings") or []:
        L.append("")
        L.append(f"⚠ {w}")
    return "\n".join(L)


def _q(a: str) -> str:
    return f'"{a}"' if (" " in a or "(" in a) else a


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
                              verbose=verbose, sink=io.sink(step), elog=elog)
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
