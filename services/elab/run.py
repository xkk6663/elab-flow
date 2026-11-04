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

import json
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import builder, doctor as doctor_mod, flash as flash_mod
from . import monitor as monitor_mod
from . import serialport as serialport_mod
from ._winproc import proc_kwargs
from .config import Config, ElabError, Host, to_fwd
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

#: ``${env:NAME}`` 模板（``tools.<name>.env`` → 进程环境依次查找）。
_ENV_REF_RE = re.compile(r"\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}")
#: ``${host:tools.idf.python}`` —— 引用 L0 主机事实源，项目 YAML 不写死路径。
_HOST_REF_RE = re.compile(r"\$\{host:([^}]+)\}")
#: ``${json_args:FILE#KEY}`` 整段 argv 展开（如 esptool 的 offset/file 对）。
_JSON_ARGS_RE = re.compile(r"^\$\{json_args:(.+)#([^#]+)\}$")

#: ``${host:...}`` 的短名 → Host 属性（Host 属性已含环境变量覆盖）。
_HOST_ALIASES = {
    "idf.python": "idf_python",
    "idf.path": "idf_root",
    "idf.idf_path": "idf_root",
    "idf.root": "idf_root",
    "idf.tools_path": "idf_tools_path",
    "idf.version": "idf_version",
    "idf.venv": "idf_venv",
    "gdb_riscv": "gdb_riscv",
    "gdb_riscv.path": "gdb_riscv",
    "openocd_esp32": "openocd_esp32",
    "openocd_esp32.path": "openocd_esp32",
    "openocd_esp32.scripts": "openocd_esp32_scripts",
}
#: ``env_from_cmd`` 只认 ``KEY=VALUE`` 行；``WARNING: ...`` 之类自然被排除。
_KEYVAL_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

#: ``env_from_cmd`` 结果缓存（同一进程内按 "命令 + 基础环境" 复用）。
#: ESP-IDF 的 ``idf_tools.py export`` 每次约 0.5–1s，闭环五步不该重复五次。
_ENV_FROM_CMD_CACHE: dict = {}


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

    def end(self, ok, steps_ok, steps_failed, verdict="ok"):
        if self.elog:
            self.elog.end(ok, steps_ok, steps_failed, actor=self.actor,
                          verdict=verdict)


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
def _delegated_tool(cfg: Config, project: str, step: str) -> str:
    """``steps.<step> == 'tool:<name>'`` → 返回 ``name``；否则返回空串。

    ★ 委托步骤的事件 ``step`` 仍必须是**规范步骤名**（build/flash/...），
      否则日志会全落进 ``tools`` 通道（``channels.ts`` 的归类规则）。
    """
    proj = cfg.resolved_project(project)
    spec = (proj.get("steps") or {}).get(step)
    if isinstance(spec, str) and spec.startswith(TOOL_PREFIX):
        name = spec[len(TOOL_PREFIX):].strip()
        if name:
            return name
    return ""


def validate_delegation(cfg: Config, project: str, steps) -> None:
    """启动前校验 ``steps`` 委托：目标工具存在、``monitor`` 不可委托。

    失败发生在 spawn 之前 —— 面板能立刻显示原因，而不是跑到一半才报错。
    """
    proj = cfg.resolved_project(project)
    tools = proj.get("tools") or {}
    declared = proj.get("steps") or {}
    for step in steps:
        spec = declared.get(step)
        if spec is None:
            continue
        if not isinstance(spec, str) or not spec.startswith(TOOL_PREFIX):
            raise RunError(
                f"项目 {project} 的 steps.{step} 只接受 tool:<name>：{spec!r}")
        name = spec[len(TOOL_PREFIX):].strip()
        if not name:
            raise RunError(f"项目 {project} 的 steps.{step} 缺少工具名")
        if step == "monitor":
            raise RunError(
                f"项目 {project} 的 steps.monitor 不允许委托（{spec}）："
                f"串口三态与 serial/* 事件必须走内核 monitor")
        if name not in tools:
            raise RunError(
                f"项目 {project} 的 steps.{step} 委托给未声明的 tools.{name}")


def _tool_spec(cfg: Config, project: str, name: str) -> tuple[dict, dict]:
    """→ ``(已插值项目, tools.<name> 原始映射)``。"""
    proj = cfg.resolved_project(project)
    tools = proj.get("tools") or {}
    if name not in tools:
        raise RunError(f"项目 {project} 的 YAML 未声明 tools.{name}")
    t = tools[name] or {}
    if not isinstance(t, dict):
        raise RunError(f"tools.{name} 必须是映射")
    return proj, t


def _tool_subs(cfg: Config, project: str, proj: dict, strings) -> dict:
    """构造项目作用域模板变量（``${serial_port}`` 只在真要用时才去选口）。"""
    build = proj.get("build") or {}
    root = to_fwd(proj.get("root", ""))
    work_dir = to_fwd(build.get("work_dir", ""))
    runs_dir = str(runs_dir_for(cfg))
    subs = {"serial_port": "", "root": root, "work_dir": work_dir,
            "name": project, "runs_dir": runs_dir}
    # 芯片 / 项目事实：provider 的公共命令模板不写死目标与波特率（技术方案 §7）。
    try:
        chip = cfg.chip_of(proj) or {}
    except ElabError:
        chip = {}
    subs["chip.target"] = str(chip.get("idf_target") or chip.get("target")
                              or chip.get("id") or "")
    subs["chip.flash_chip"] = str(chip.get("flash_chip")
                                  or (chip.get("verify") or {}).get("flash_chip") or "")
    subs["project.serial.baud"] = str((proj.get("serial") or {}).get("baud") or 115200)
    if any("${serial_port}" in str(a) for a in strings):
        spec = ((proj.get("serial") or {}).get("port")) or "auto"
        ports, _layer = serialport_mod.list_ports()
        port, why, _cands = serialport_mod.select_port(spec, ports)
        if not port:
            raise RunError(f"项目 {project} 的工具需要串口（{spec}）：{why}")
        subs["serial_port"] = port
    return subs


def _host_value(cfg: Config, key: str) -> str:
    """``${host:...}`` → L0 主机事实源（Host 属性优先，其次 yaml 点路径）。"""
    host = Host(cfg)
    attr = _HOST_ALIASES.get(key) or key.replace("-", "_").replace(".", "_")
    if hasattr(host, attr):
        val = getattr(host, attr)
        if isinstance(val, str) and val.strip():
            return val
    node = cfg.host
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            node = None
            break
        node = node[part]
    if isinstance(node, str) and node.strip():
        return cfg.resolve(node)
    raise RunError(f"未定义的主机事实源 ${{host:{key}}}（见 elab.host.yaml）")


def _sub_text(s: str, subs: dict, env_spec: dict, name: str,
              cfg: Config | None = None) -> str:
    """项目模板变量 + ``${env:NAME}`` + ``${host:...}``。

    三者可能互相嵌套（如 ``IDF_PATH: "${host:tools.idf.idf_path}"``），
    故解析到稳定为止；命中不到就 fail-fast，不把 ``${...}`` 漏给子进程。
    """
    for k, v in subs.items():
        s = s.replace("${" + k + "}", v)

    def _repl(m: re.Match) -> str:
        key = m.group(1)
        if key in env_spec:
            return str(env_spec[key])
        if key in os.environ:
            return os.environ[key]
        raise RunError(f"tools.{name} 引用了未定义环境变量 ${{env:{key}}}")

    def _host_repl(m: re.Match) -> str:
        if cfg is None:
            raise RunError(f"tools.{name} 无法解析 ${{host:{m.group(1)}}}（缺少配置上下文）")
        return _host_value(cfg, m.group(1))

    for _ in range(10):
        new = _ENV_REF_RE.sub(_repl, s)
        new = _HOST_REF_RE.sub(_host_repl, new)
        if new == s:
            break
        s = new
    # ★ fail-fast：未知命名空间不允许漏给子进程（技术方案 §4.5.4）。
    #   ``${json_args:...}`` 是整段 argv 展开，留到 _expand_json_args 处理。
    bad = re.search(r"\$\{(?!json_args:)[^{}]+\}", s)
    if bad:
        raise RunError(
            f"tools.{name} 引用了未知模板 {bad.group(0)}"
            f"（可用：项目变量 / ${{env:...}} / ${{host:...}} / ${{chip.*}}）")
    return s


def _json_offset_key(k) -> tuple[int, int]:
    try:
        return (0, int(str(k), 16))
    except ValueError:
        return (1, 0)


def _json_pairs(node, base: Path) -> list[str]:
    """JSON 里的 offset→file 映射 → esptool 的 ``[offset, file, ...]``。"""
    if isinstance(node, dict):
        out: list[str] = []
        for k in sorted(node.keys(), key=_json_offset_key):
            v = node[k]
            if isinstance(v, dict):
                off, f = v.get("offset", k), v.get("file") or v.get("path")
            else:
                off, f = k, v
            if not f:
                continue
            out += [str(off), to_fwd(base / str(f))]
        return out
    if isinstance(node, list):
        out = []
        for it in node:
            if isinstance(it, dict) and (it.get("file") or it.get("path")):
                out += [str(it.get("offset", "")), to_fwd(base / str(it.get("file") or it.get("path")))]
            elif isinstance(it, str):
                out.append(to_fwd(base / it))
        return out
    raise RunError(f"${{json_args}} 的取值必须是映射或列表：{type(node).__name__}")


def _expand_json_args(argv: list[str], cwd: str) -> list[str]:
    """把恰好为 ``${json_args:FILE#KEY}`` 的 argv 元素展开成多项。

    ★ 典型来源：ESP-IDF 的 ``build/flasher_args.json#flash_files`` ——
      偏移与产物名由构建产物自己声明，项目 YAML 不再写死。
    """
    out: list[str] = []
    for a in argv:
        m = _JSON_ARGS_RE.match(a)
        if not m:
            out.append(a)
            continue
        fname, key = m.group(1).strip(), m.group(2).strip()
        p = Path(fname)
        if not p.is_absolute():
            p = Path(cwd) / p
        if not p.is_file():
            raise RunError(f"${{json_args}} 文件不存在：{to_fwd(p)}（请先构建）")
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RunError(f"${{json_args}} 读取失败：{to_fwd(p)}（{exc}）") from exc
        node = data
        for part in key.split("."):
            if not isinstance(node, dict) or part not in node:
                raise RunError(f"${{json_args:{to_fwd(p)}#{key}}} 缺少键 {part!r}")
            node = node[part]
        out.extend(_json_pairs(node, p.parent))
    return out


def _decl_command(cfg: Config, project: str, decl
                  ) -> tuple[list[str], str, str, dict, dict]:
    """``StepDecl`` → ``(argv, cwd, label, proj, subs)``（已完成模板替换）。

    provider 步骤与项目内联 ``tool:`` 走**同一个** materialize 函数 ——
    这是 "--dry-run 与真实执行共享 ResolvedToolchain" 的落地方式（技术方案 §3）。
    """
    proj = cfg.resolved_project(project)
    argv = list(decl.cmd)
    if not argv:
        raise RunError(f"步骤 {decl.step} 没有可用命令（provider={decl.provider}）")
    env_spec = dict(decl.env)
    root = to_fwd(proj.get("root", ""))
    extra = (list(argv)
             + [str(decl.cwd or ""), str(decl.env_from_cmd or "")]
             + [str(v) for v in env_spec.values()]
             + list(decl.env_prepend_path))
    subs = _tool_subs(cfg, project, proj, extra)

    def _sub(s: str) -> str:
        return _sub_text(str(s), subs, env_spec, decl.tool_name or decl.step, cfg)

    argv = [to_fwd(_sub(a)) for a in argv]
    cwd = to_fwd(_sub(decl.cwd or root)) or "."
    argv = _expand_json_args(argv, cwd)
    label = decl.label or decl.tool_name or decl.step
    return argv, cwd, label, proj, subs


def _tool_command(cfg: Config, project: str, name: str
                  ) -> tuple[list[str], str, str, dict, dict, dict]:
    """→ ``(argv, cwd, label, proj, tool, subs)``（argv/cwd 已完成模板替换）。"""
    proj, t = _tool_spec(cfg, project, name)
    from . import provider as provider_mod
    decl = provider_mod.inline_decl(cfg, project, proj, name, f"{TOOL_PREFIX}{name}")
    argv, cwd, label, proj, subs = _decl_command(cfg, project, decl)
    return argv, cwd, label, proj, t, subs


def _resolve_tool(cfg: Config, project: str, name: str) -> tuple[list[str], str, str]:
    """项目 YAML 的 ``tools.<name>`` → (argv, cwd, label)。

    模板变量：``${serial_port}``（按项目 serial.port 解析，auto 走选口规则并
    排除蓝牙虚拟口）、``${root}``、``${work_dir}``、``${name}``、``${runs_dir}``，
    以及 ``${env:NAME}``（``tools.<name>.env`` → 进程环境）。
    """
    argv, cwd, label, _proj, _t, _subs = _tool_command(cfg, project, name)
    return argv, cwd, label


# ── 环境合并（env_from_cmd / env_prepend_path）─────────────────────
def _env_key(env: dict, key: str) -> str:
    """Windows 下环境键大小写不敏感：返回字典里**已存在**的键形。"""
    if key in env:
        return key
    if os.name == "nt":
        low = key.lower()
        for k in env:
            if k.lower() == low:
                return k
    return key


def _merge_key_values(env: dict, text: str, path_key: str) -> None:
    """把 ``KEY=VALUE`` 行合并进 ``env``（``%PATH%`` / ``$PATH`` 就地展开）。"""
    path_key = str(path_key or "PATH")
    cur_path = env.get(_env_key(env, path_key), env.get("PATH", ""))
    for line in text.splitlines():
        if not _KEYVAL_RE.match(line):
            continue
        k, _, v = line.partition("=")
        if k.upper() == path_key.upper():
            v = v.replace("%PATH%", cur_path).replace("$PATH", cur_path)
            env[_env_key(env, path_key)] = v
        else:
            env[_env_key(env, k)] = v


def _apply_env_from_cmd(env: dict, spec: dict, sub, *, cwd: str) -> None:
    """执行 ``env_from_cmd.cmd``，把输出的 ``KEY=VALUE`` 合并进 ``env``。"""
    cmd = spec.get("cmd") or []
    if isinstance(cmd, str):
        cmd = cmd.split()
    if not cmd:
        return
    cmd = [to_fwd(sub(str(a))) for a in cmd]
    path_key = str(spec.get("path_key") or "PATH")

    cache_key = (tuple(cmd), tuple(sorted((str(k), str(v)) for k, v in env.items())))
    text = _ENV_FROM_CMD_CACHE.get(cache_key)
    if text is None:
        try:
            proc = subprocess.run(
                cmd, cwd=cwd if os.path.isdir(cwd) else None, env=env,
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=60, check=False, **proc_kwargs())
        except (OSError, subprocess.SubprocessError) as exc:
            raise RunError(f"env_from_cmd 执行失败：{exc}") from exc
        text = proc.stdout or ""
        _ENV_FROM_CMD_CACHE[cache_key] = text
    _merge_key_values(env, text, path_key)


def _apply_prepend_path(env: dict, dirs) -> None:
    dirs = [str(d) for d in dirs if str(d).strip()]
    if not dirs:
        return
    key = _env_key(env, "PATH")
    env[key] = os.pathsep.join(dirs + ([env.get(key, "")] if env.get(key) else []))


def _kill_tree(proc) -> None:
    """杀整棵进程树（与 ``RunManager.cancel`` 同一条命令，触发者是超时）。"""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       capture_output=True, text=True, errors="replace",
                       check=False)
        return
    try:
        proc.kill()
    except OSError:
        pass


def _run_tool(cfg: Config, project: str, name: str, *, sink) -> "StepOutcome":
    """执行项目声明工具（兼容入口）：转成 ``StepDecl`` 后与 provider 同路径执行。"""
    from . import provider as provider_mod
    proj, _t = _tool_spec(cfg, project, name)
    decl = provider_mod.inline_decl(cfg, project, proj, name, f"{TOOL_PREFIX}{name}")
    return _run_decl(cfg, project, decl, sink=sink)


def _run_decl(cfg: Config, project: str, decl, *, sink) -> "StepOutcome":
    """执行外部步骤（provider 或项目内联）：子进程逐行 → sink。

    ★ 已知限制：驾驶舱"取消"杀的是 elab run 进程；Windows 下 ``taskkill /T``
      会连带子树，但 ``elab run`` 自身崩溃时子进程仍可能残留 —— 与 N5 同性质。
    """
    argv, cwd, label, _proj, subs = _decl_command(cfg, project, decl)
    env_spec = dict(decl.env)
    tag = decl.tool_name or decl.step

    def _sub(s) -> str:
        return _sub_text(str(s), subs, env_spec, tag, cfg)

    sink(f"[tool:{tag}] {label}")
    sink(f"[tool:{tag}] $ {' '.join(argv)}")

    env = dict(os.environ)
    for k, v in env_spec.items():
        env[_env_key(env, str(k))] = _sub(v)

    from_cmd = decl.env_from_cmd or {}
    if isinstance(from_cmd, dict) and from_cmd.get("cmd"):
        _apply_env_from_cmd(env, from_cmd, _sub, cwd=cwd)
    _apply_prepend_path(env, [_sub(d) for d in decl.env_prepend_path])

    if not os.path.isabs(argv[0]):
        if not shutil.which(argv[0], path=env.get(_env_key(env, "PATH"))):
            raise RunError(f"步骤 {decl.step} 的命令不存在：{argv[0]}（PATH 未命中）")
    if not os.path.isdir(cwd):
        raise RunError(f"步骤 {decl.step} 的 cwd 不存在：{cwd}")

    timeout_s = decl.timeout_s
    marker = str((decl.result or {}).get("marker") or "")
    t0 = time.time()
    try:
        proc = subprocess.Popen(
            argv, cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            **proc_kwargs(),
        )
    except OSError as exc:
        raise RunError(f"步骤 {decl.step} 启动失败：{exc}") from exc

    timed_out = threading.Event()
    timer = None
    if timeout_s:
        def _on_timeout():
            timed_out.set()
            _kill_tree(proc)

        timer = threading.Timer(float(timeout_s), _on_timeout)
        timer.daemon = True
        timer.start()

    extra: dict = {}
    tail = ""
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip("\r\n")
            if marker and line.startswith(marker):
                # 结构化结果标记：合并进 extra；坏标记原样当普通日志（不吞）
                try:
                    data = json.loads(line[len(marker):])
                except json.JSONDecodeError:
                    data = None
                if isinstance(data, dict):
                    extra.update(data)
                    continue
            if line:
                tail = line
                sink(line)
        rc = proc.wait()
    finally:
        if timer:
            timer.cancel()
        try:
            proc.stdout.close()
        except OSError:
            pass

    dt = time.time() - t0
    if timed_out.is_set():
        sink(f"[tool:{tag}] timeout after {timeout_s}s")
        return StepOutcome(False, f"timeout after {timeout_s}s",
                           {**extra, "exit_code": rc, "timeout_s": timeout_s})
    ok = rc == 0
    sink(f"[tool:{tag}] exit={rc} ({dt:.1f}s)")
    return StepOutcome(ok, (tail or f"exit={rc}")[:120], {**extra, "exit_code": rc})


def _check_artifacts(tc, extra: dict, sink) -> None:
    """外部步骤产物检查（技术方案 §8）：声明了但不存在 → 进 ``artifacts_missing``。

    只检查、不阻塞：产物缺失通常说明前面那步没跑/失败，由调用方决定。
    """
    missing = [k for k, v in (tc.artifacts or {}).items()
               if str(v).strip() and not Path(str(v)).exists()]
    if missing:
        extra["artifacts_missing"] = missing
        sink(f"[toolchain] 产物缺失：{', '.join(missing)}")


def _execute(cfg: Config, step: str, project: str, *, clean: bool, jobs: int | None,
             verbose: bool, sink, elog=None, toolchain=None) -> StepOutcome:
    """执行一步。**只调用既有库函数**，不改它们的行为。

    ``elog`` 只被 ``monitor`` 步用：串口是**域事件**（`serial/*`），不能只塞进
    `run/step-exit` 的 detail，否则驾驶舱的串口 Tab / 闭环时间线拿不到逐行数据。
    其余步骤不需要它 —— 它们的结果本来就是"一步一次"的标量。

    ★ ``toolchain`` 是**唯一**的步骤来源：外部步骤（provider/内联 ``tool:``）与
      原生步骤都按 ``StepDecl`` 分派；``kind=unavailable`` 直接报错，**不回退**（D3）。
    """
    from . import provider as provider_mod
    tc = toolchain or provider_mod.resolve(cfg, project)
    decl = tc.steps.get(step)

    if decl is not None and decl.kind == "unavailable":
        raise RunError(decl.reason + (f"；{decl.hint}" if decl.hint else ""))
    if decl is not None and decl.kind == "external":
        out = _run_decl(cfg, project, decl, sink=sink)
        if decl.provider == "project":
            # 兼容既有事件契约：项目内联委托仍带 delegated_to。
            out.extra["delegated_to"] = f"{TOOL_PREFIX}{decl.tool_name}"
        out.extra.update({"provider": tc.provider.name,
                          "provider_version": tc.provider.version,
                          "provider_source": tc.provider.source})
        if step == "build" and out.ok:
            # 委托构建后从 .map 回填内存占位（与原生 build 同一条兜底逻辑）：
            # 否则 ESP-IDF 等外带工程的驾驶舱内存表永远是空的。
            mp = (tc.artifacts or {}).get("map", "")
            if mp and Path(mp).is_file():
                mem = builder.parse_map_memory(mp)
                if mem:
                    out.extra["memory"] = mem
                    out.extra["memory_source"] = "map"
                    sink(f"[tool:{decl.tool_name}] 内存占位取自 .map：{to_fwd(mp)}")
        if step in ("build", "flash"):
            _check_artifacts(tc, out.extra, sink)
        return out

    if decl is not None and decl.kind == "native":
        step = decl.native
    tool_name = _delegated_tool(cfg, project, step)
    if decl is None and tool_name:
        out = _run_tool(cfg, project, tool_name, sink=sink)
        out.extra["delegated_to"] = f"{TOOL_PREFIX}{tool_name}"
        return out

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
    validate_delegation(cfg, project, steps)
    from . import provider as provider_mod
    tc = provider_mod.resolve(cfg, project)
    _assert_steps_available(cfg, tc, project, steps)

    # 需要 ELF 的两步共用一个 plan；只在真用得上时才构造（plan_for 会读 YAML）
    _plan_cache: dict = {}

    def _p():
        if "p" not in _plan_cache:
            _plan_cache["p"] = plan_for(cfg, project)
        return _plan_cache["p"]

    for step in steps:
        entry: dict = {"step": step, "spawns": True, "commands": [],
                       "effects": [], "note": "", "blocked": False}
        decl = tc.steps.get(step)

        # ★ 外部步骤分支必须放在原生分支之前：否则 ESP32 的 build 预览会构造
        #   ARM cmake 命令 —— 用户看到的是**错的命令**（违反预览与实跑同源）。
        if decl is not None and decl.kind == "external":
            try:
                argv, cwd, label, _proj, _subs = _decl_command(cfg, project, decl)
                entry["commands"] = [argv]
                entry["work_dir"] = cwd
                entry["provider"] = decl.provider
                entry["note"] = (
                    f"provider {tc.provider.name}@{tc.provider.version} → "
                    f"steps.{step}（{label}，cwd={cwd}）"
                    if decl.provider != "project" else
                    f"委托给 tools.{decl.tool_name}（{label}，cwd={cwd}）")
            except (RunError, ElabError) as exc:
                entry["blocked"] = True
                entry["note"] = str(exc)
            plan.append(entry)
            continue

        if decl is not None and decl.kind == "unavailable":
            entry["spawns"] = False
            entry["blocked"] = True
            entry["note"] = decl.reason + (f"；{decl.hint}" if decl.hint else "")
            plan.append(entry)
            continue

        # 兼容：``--steps tool:<name>`` 直接点某个工具（不属于规范步骤）。
        tool_name = _delegated_tool(cfg, project, step) if decl is None else ""
        if tool_name:
            try:
                argv, cwd, label = _resolve_tool(cfg, project, tool_name)
                entry["commands"] = [argv]
                entry["work_dir"] = cwd
                entry["note"] = f"委托给 tools.{tool_name}（{label}，cwd={cwd}）"
            except (RunError, ElabError) as exc:
                entry["blocked"] = True
                entry["note"] = str(exc)
            plan.append(entry)
            continue

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

    out = {"project": project, "steps": list(steps), "clean": bool(clean),
           "jobs": jobs, "plan": plan, "warnings": warnings}
    if tc.provider.source != "builtin":
        out["provider"] = {"name": tc.provider.name, "version": tc.provider.version,
                           "source": tc.provider.source, "path": tc.provider.path}
    return out


def _assert_steps_available(cfg: Config, tc, project: str, steps) -> None:
    """请求的步骤若不可用 → 预览/实跑直接失败（D3，不回退）。

    两类不可用：① provider 未提供该步骤；② provider 的 host/probe/serial
    前提未满足（``serial`` 只在步骤命令真的引用 ``${serial_port}`` 时才算）。
    """
    from . import provider as provider_mod
    state = None
    if tc.provider.source == "provider":
        state = provider_mod.evaluate(cfg, project, tc)
    for step in steps:
        decl = tc.steps.get(step)
        if decl is not None and decl.kind == "unavailable":
            raise RunError(
                f"项目 {project} 的步骤 {step} 不可用：{decl.reason}"
                + (f"；{decl.hint}" if decl.hint else ""))
        if decl is None or decl.kind != "external" or not state:
            continue
        serial_needed = any("${serial_port}" in str(a) for a in decl.cmd)
        reasons = [r for r in state.get("reasons") or []
                   if r.get("code") != "serial.unavailable" or serial_needed]
        if reasons:
            raise RunError(
                f"项目 {project} 的步骤 {step} 不可用（provider "
                f"{tc.provider.name}@{tc.provider.version}）："
                + "；".join(str(r.get("message") or r) for r in reasons))


def render_preview(pv: dict) -> str:
    """人读的预览（``elab run --dry-run``）。"""
    head = f"project={pv['project']}  steps={','.join(pv['steps'])}"
    if pv.get("clean"):
        head += "  --clean"
    if pv.get("jobs"):
        head += f"  -j {pv['jobs']}"
    L = [head, "（只读预览：下列命令**不会**被执行）"]
    p = pv.get("provider")
    if p:
        L.append(f"provider={p['name']}@{p['version']}  source={p['source']}  {p.get('path', '')}")
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
    validate_delegation(cfg, project, steps)
    from . import provider as provider_mod
    tc = provider_mod.resolve(cfg, project)
    _assert_steps_available(cfg, tc, project, steps)

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
                              verbose=verbose, sink=io.sink(step), elog=elog,
                              toolchain=tc)
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
        # ★ 三态必须一路传到总账（2026-11-03）：monitor 的 "inconclusive" 早先只写在
        #   单步 detail 里，`ok` 仍为真 → 界面顶栏/CLI 都显示"全部通过"，
        #   用户没接串口却看到闭环 ok（实为"没验证"）。总账因此独立于 ok 再给一个
        #   verdict：failed > inconclusive > ok。ok 保持"没有失败步骤"的原语义，
        #   下游要区分"通过"与"未验证"必须读 verdict。
        inconclusive = [r["step"] for r in results
                        if r.get("verdict") == "inconclusive"]
        verdict = ("failed" if steps_failed
                   else "inconclusive" if inconclusive else "ok")
        io.end(all_ok, steps_ok, steps_failed, verdict=verdict)
    finally:
        if elog:
            elog.close()

    return {
        "run": elog.run_id if elog else None,
        "project": project,
        "steps": results,
        "ok": all_ok,
        "verdict": verdict,
        "inconclusive": inconclusive,
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
        mark = "?" if (r["ok"] and r.get("verdict") == "inconclusive") \
               else ("✓" if r["ok"] else "✗")
        lines.append(f"  [{mark}] {r['step']:<13} {r['duration_s']:6.2f}s  {r['detail']}")
    head = f"run={res['run']}  project={res['project']}" if res.get("run") else \
           f"project={res['project']}  (未发射事件)"
    verdict = res.get("verdict") or ("ok" if res["ok"] else "failed")
    tail = {"inconclusive": "? 已完成，但有步骤未验证（inconclusive）"}.get(
        verdict, "✓ 全部通过" if res["ok"] else "✗ 有步骤失败")
    return "\n".join([head, *lines, tail])
