"""elab.provider —— 工具链 Provider：声明式数据包 + 内置默认链。

设计依据：``docs/design/技术方案_Provider工具链架构.md``（D1–D4）。

- **provider 不是可执行插件**：它只是 ``provider.yaml`` 数据包；执行器只接受
  不可变的 :class:`ResolvedToolchain`，不把数据当代码 import。
- **默认链是代码**（:class:`NativeProvider`）：``.map`` 解析、GDB/MI、串口三态
  等依赖内核状态的能力无法用命令模板表达。
- **缺步骤不回退**（D3）：项目声明了 ``provider:`` 而该步骤没被提供时，
  生成 ``kind=unavailable`` 的 :class:`StepDecl`，执行/预览阶段直接报错。
- **``monitor`` / ``doctor_deep`` 永远不由 provider 提供**：前者是内核串口契约，
  后者依赖内核 configure 探测；项目只可内联 ``tool:`` 覆盖。

发现根（与 ``packs.roots`` 同构）：``ELAB_PROVIDER_ROOTS`` >
``elab.host.yaml: providers.roots`` > ``${ELAB_ROOT}/providers/installed``。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Mapping, Protocol

from . import _yaml, pkg
from .config import Config, ElabError, to_fwd

PROVIDER_FILE = "provider.yaml"
INSTALL_META = ".installed.json"
PROVIDER_API_VERSION = 1
#: 内核保留、任何 provider 都不可提供的步骤。
CORE_ONLY_STEPS: tuple[str, ...] = ("monitor", "doctor_deep")
#: 外部步骤未声明 timeout 时的默认值（秒）。0/负数在加载时即报错。
DEFAULT_TIMEOUTS = {"doctor": 120, "build": 1800, "flash": 600,
                    "debug_verify": 300}
#: 已知调试能力集合（与 ``cockpit/server.py`` 的 ``DEBUG_META`` 同源口径）。
KNOWN_DEBUG_FEATURES = frozenset({
    "session", "control", "stack", "variables", "registers", "breakpoints",
    "memory", "disasm", "watch", "svd", "rtos", "flash_verify",
})

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$")
_SEMVER_RE = re.compile(r"^([0-9]+)\.([0-9]+)\.([0-9]+)(?:[+-][0-9A-Za-z.+-]+)?$")
_ALLOWED_TOP_KEYS = {
    "schema_version", "provider_api", "name", "version", "license",
    "description", "requires", "defaults", "artifacts", "steps", "debug",
}


class ProviderError(ElabError):
    """Provider 加载 / 绑定 / 安装相关的可预期错误。"""


# ── 数据结构（不可变）────────────────────────────────────────────
@dataclass(frozen=True)
class ProviderRef:
    name: str
    version: str
    source: str                       # builtin | provider
    path: str = ""


@dataclass(frozen=True)
class StepDecl:
    step: str
    kind: Literal["native", "external", "unavailable"]
    native: str = ""
    tool_name: str = ""
    label: str = ""
    cmd: tuple[str, ...] = ()
    cwd: str = ""
    env: Mapping[str, str] = field(default_factory=dict)
    env_from_cmd: Mapping = field(default_factory=dict)
    env_prepend_path: tuple[str, ...] = ()
    timeout_s: int = 0
    result: Mapping = field(default_factory=dict)
    reason: str = ""
    hint: str = ""
    provider: str = ""                # 提供者名（external 时）


@dataclass(frozen=True)
class ResolvedToolchain:
    provider: ProviderRef
    steps: Mapping[str, StepDecl]
    artifacts: Mapping[str, str]
    debug: Mapping
    unavailable: tuple[dict, ...] = ()


class ToolchainProvider(Protocol):
    ref: ProviderRef

    def resolve(self, cfg: Config, proj: dict) -> ResolvedToolchain: ...


# ── 发现根 / 安装落点 ────────────────────────────────────────────
def _as_list(raw) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(x) for x in raw if str(x).strip()]
    return [x.strip() for x in str(raw).replace(",", os.pathsep).split(os.pathsep)
            if x.strip()]


def provider_roots(cfg: Config) -> list[Path]:
    raw = os.environ.get("ELAB_PROVIDER_ROOTS")
    if not raw:
        try:
            raw = ((cfg.host or {}).get("providers") or {}).get("roots")
        except ElabError:
            raw = None
    items = _as_list(raw) or [to_fwd(Path(cfg.root) / "providers" / "installed")]
    out: list[Path] = []
    for item in items:
        p = Path(cfg.resolve(str(item), {"ELAB_ROOT": to_fwd(cfg.root)}))
        if p not in out:
            out.append(p)
    # ★ 源码目录 ``providers/official`` **不是**发现根：未安装 = 不可用（D3）。
    #   安装时由 ``elab provider install`` 从市场索引/本地源码复制到 installed。
    return out


def install_root(cfg: Config) -> Path:
    return provider_roots(cfg)[0]


def official_root(cfg: Config) -> Path:
    return Path(cfg.root) / "providers" / "official"


# ── manifest 读取 / 校验 ─────────────────────────────────────────
def read_manifest(path) -> dict:
    p = Path(path)
    if p.is_dir():
        p = p / PROVIDER_FILE
    if not p.exists():
        raise ProviderError(f"不是 provider 目录（缺少 {PROVIDER_FILE}）：{p}")
    try:
        man = _yaml.load_file(p) or {}
    except Exception as exc:                        # noqa: BLE001
        raise ProviderError(f"provider 清单解析失败：{p}：{exc}") from exc
    if not isinstance(man, dict):
        raise ProviderError(f"provider 清单必须是映射：{p}")
    man["_path"] = to_fwd(p)
    return man


def _kernel_steps() -> tuple[str, ...]:
    from . import run as run_mod                    # 延迟导入，避免循环依赖
    return tuple(run_mod.ALL_STEPS)


def _check_cmd(step: str, spec) -> list[str]:
    problems: list[str] = []
    if not isinstance(spec, dict):
        return [f"steps.{step} 必须是映射"]
    cmd = spec.get("cmd")
    if isinstance(cmd, str):
        cmd = cmd.split()
    if not cmd:
        problems.append(f"steps.{step}.cmd 为空（外部步骤必须有命令）")
    elif not isinstance(cmd, (list, tuple)):
        problems.append(f"steps.{step}.cmd 必须是字符串列表")
    elif not all(isinstance(a, str) and a.strip() for a in cmd):
        problems.append(f"steps.{step}.cmd 的每一项必须是非空字符串")
    ts = spec.get("timeout_s")
    if ts is not None:
        if not isinstance(ts, int) or isinstance(ts, bool) or ts <= 0:
            problems.append(f"steps.{step}.timeout_s 必须是正整数：{ts!r}")
    return problems


def validate_manifest(man: dict) -> list[str]:
    """结构 / 兼容性 / fail-fast 校验；返回问题列表（空 = 通过）。"""
    problems: list[str] = []
    for key in man:
        if key == "_path" or key.startswith("x-"):
            continue
        if key not in _ALLOWED_TOP_KEYS:
            problems.append(f"未知顶层字段 {key!r}（扩展字段请用 x- 前缀）")
    if man.get("schema_version") != 1:
        problems.append(f"schema_version 必须为 1：{man.get('schema_version')!r}")
    if man.get("provider_api") != PROVIDER_API_VERSION:
        problems.append(
            f"provider_api 必须为 {PROVIDER_API_VERSION}：{man.get('provider_api')!r}")
    name = str(man.get("name") or "")
    if not name or not _NAME_RE.match(name):
        problems.append(f"name 必须为 vendor/toolchain 形式（小写）：{name!r}")
    ver = str(man.get("version") or "")
    if not _SEMVER_RE.match(ver):
        problems.append(f"version 必须是严格 semver：{ver!r}")
    if not str(man.get("license") or "").strip():
        problems.append("缺少 license（SPDX 标识）")

    req = man.get("requires") or {}
    if not isinstance(req, dict):
        problems.append("requires 必须是映射")
        req = {}
    spec = str(req.get("kernel_api") or "")
    if not spec:
        problems.append("requires.kernel_api 必填（如 \">=1 <2\"）")
    else:
        try:
            if not pkg.satisfies(pkg.KERNEL_API_VERSION, spec):
                problems.append(
                    f"requires.kernel_api {spec} 不满足当前内核 v{pkg.KERNEL_API_VERSION}")
        except pkg.PackError as exc:
            problems.append(str(exc))
    host = req.get("host")
    if host is not None:
        if not isinstance(host, list):
            problems.append("requires.host 必须是列表")
        else:
            for i, item in enumerate(host):
                if not isinstance(item, dict) or not item.get("key"):
                    problems.append(f"requires.host[{i}] 缺少 key")
                    continue
                if str(item.get("check") or "file") not in ("file", "dir", "exe", "nonempty"):
                    problems.append(
                        f"requires.host[{i}].check 只能是 file/dir/exe/nonempty："
                        f"{item.get('check')!r}")
    for key in ("probe", "serial"):
        if key in req and not isinstance(req[key], bool):
            problems.append(f"requires.{key} 必须是布尔值")

    steps = man.get("steps")
    if not isinstance(steps, dict) or not steps:
        problems.append("steps 必填且至少包含一个步骤")
        steps = {}
    allowed = set(_kernel_steps()) - set(CORE_ONLY_STEPS)
    for step, spec_ in steps.items():
        if step in CORE_ONLY_STEPS:
            problems.append(
                f"steps.{step} 不允许由 provider 提供（内核保留：串口/深度体检）")
            continue
        if step not in allowed:
            problems.append(f"未知步骤 steps.{step}（可选：{', '.join(sorted(allowed))}）")
            continue
        problems += _check_cmd(step, spec_)

    defaults = man.get("defaults") or {}
    if not isinstance(defaults, dict):
        problems.append("defaults 必须是映射")
    else:
        if "timeout_s" in defaults and (
                not isinstance(defaults["timeout_s"], int)
                or isinstance(defaults["timeout_s"], bool)
                or defaults["timeout_s"] <= 0):
            problems.append(f"defaults.timeout_s 必须是正整数：{defaults['timeout_s']!r}")
        if "env" in defaults and not isinstance(defaults["env"], dict):
            problems.append("defaults.env 必须是映射")

    dbg = man.get("debug") or {}
    if dbg:
        if not isinstance(dbg, dict):
            problems.append("debug 必须是映射")
        else:
            backend = str(dbg.get("backend") or "native")
            if backend not in ("native", "esp-idf", "gdb-mi"):
                problems.append(f"debug.backend 不支持：{backend!r}")
            feats = dbg.get("features")
            if feats is not None:
                if not isinstance(feats, list):
                    problems.append("debug.features 必须是列表")
                else:
                    bad = [f for f in feats if str(f) not in KNOWN_DEBUG_FEATURES]
                    if bad:
                        problems.append(
                            f"debug.features 含未知能力：{', '.join(map(str, bad))}")
    return problems


# ── 版本约束 ────────────────────────────────────────────────────
def _ver_tuple(s: str) -> tuple[int, int, int]:
    m = _SEMVER_RE.match(str(s))
    if not m:
        m2 = re.match(r"^v?([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?", str(s))
        if not m2:
            return (0, 0, 0)
        return tuple(int(x or 0) for x in m2.groups())  # type: ignore[return-value]
    return tuple(int(x) for x in m.groups())


def _cmp(version: tuple[int, int, int], token: str) -> bool:
    token = token.strip()
    if not token:
        return True
    m = re.match(r"^(>=|<=|>|<|==|=|\^|~)?\s*v?([0-9]+(?:\.[0-9]+){0,2})$", token)
    if not m:
        raise ProviderError(f"无法解析版本约束：{token!r}")
    op = m.group(1) or "=="
    rhs = _ver_tuple(m.group(2))
    if op in ("==", "="):
        return version == rhs
    if op == ">=":
        return version >= rhs
    if op == "<=":
        return version <= rhs
    if op == ">":
        return version > rhs
    if op == "<":
        return version < rhs
    if op == "^":
        return version >= rhs and version[0] == rhs[0]
    if op == "~":
        return version >= rhs and version[:2] == rhs[:2]
    return False


def satisfies_version(version: str, spec: str) -> bool:
    tokens = [t for t in re.split(r"[, ]+", str(spec or "").strip()) if t]
    v = _ver_tuple(version)
    return all(_cmp(v, t) for t in tokens) if tokens else True


def split_ref(ref: str) -> tuple[str, str]:
    """``espressif/idf@>=1 <2`` → ``("espressif/idf", ">=1 <2")``。"""
    s = str(ref or "").strip()
    if "@" not in s:
        return s, ""
    name, _, spec = s.partition("@")
    return name.strip(), spec.strip()


# ── 内置默认链 ──────────────────────────────────────────────────
def _native_decl(step: str) -> StepDecl:
    label = {"doctor": "环境体检", "doctor_deep": "深度体检",
             "build": "原生构建", "flash": "原生烧录",
             "debug_verify": "原生调试校验", "monitor": "内核串口"}.get(step, step)
    return StepDecl(step=step, kind="native", native=step, label=label,
                    provider="elab/native")


def native_decl(step: str) -> StepDecl:
    return _native_decl(step)


class NativeProvider:
    """内置默认链：只把既有内核函数包成统一的 ``StepDecl``，不改变任何行为。"""

    ref = ProviderRef(name="elab/native", version="builtin", source="builtin")

    def resolve(self, cfg: Config, proj: dict) -> ResolvedToolchain:
        steps = {s: _native_decl(s) for s in _kernel_steps()}
        artifacts: dict[str, str] = {}
        try:
            from .plan import plan_for
            artifacts = dict(plan_for(cfg, proj.get("name", "")).artifacts)
        except ElabError:
            artifacts = {}
        return ResolvedToolchain(provider=self.ref, steps=steps,
                                 artifacts=artifacts, debug={})


# ── 外带链（provider.yaml）───────────────────────────────────────
def _merge_step(step: str, defaults: dict, spec: dict, provider_name: str) -> StepDecl:
    env = dict(defaults.get("env") or {})
    env.update(spec.get("env") or {})
    from_cmd: dict = {}
    if isinstance(defaults.get("env_from_cmd"), dict):
        from_cmd.update(defaults["env_from_cmd"])
    if isinstance(spec.get("env_from_cmd"), dict):
        from_cmd.update(spec["env_from_cmd"])
    cmd = spec.get("cmd") or []
    if isinstance(cmd, str):
        cmd = cmd.split()
    timeout = spec.get("timeout_s")
    if timeout is None:
        timeout = defaults.get("timeout_s")
    if timeout is None:
        timeout = DEFAULT_TIMEOUTS.get(step, 0)
    return StepDecl(
        step=step, kind="external", tool_name=step, label=step,
        cmd=tuple(str(a) for a in cmd),
        cwd=str(spec.get("cwd") or defaults.get("cwd") or ""),
        env={str(k): str(v) for k, v in env.items()},
        env_from_cmd=dict(from_cmd),
        env_prepend_path=tuple(str(d) for d in
                               (spec.get("env_prepend_path")
                                or defaults.get("env_prepend_path") or [])),
        timeout_s=int(timeout or 0),
        result=dict(spec.get("result") or {}),
        provider=provider_name,
    )


class DataProvider:
    """外带链：``provider.yaml`` 声明式命令模板。"""

    def __init__(self, man: dict, path: str):
        self.man = man
        self.path = path
        self.ref = ProviderRef(name=str(man["name"]), version=str(man["version"]),
                               source="provider", path=path)

    def resolve(self, cfg: Config, proj: dict) -> ResolvedToolchain:
        from . import run as run_mod                # 延迟导入（循环依赖）
        defaults = self.man.get("defaults") or {}
        steps = {s: _merge_step(s, defaults, spec or {}, self.ref.name)
                 for s, spec in (self.man.get("steps") or {}).items()}

        artifacts = dict(self.man.get("artifacts") or {})
        if artifacts:
            build = proj.get("build") or {}
            subs = {
                "root": to_fwd(proj.get("root", "")),
                "work_dir": to_fwd(build.get("work_dir", "")),
                "name": proj.get("name", ""),
                "runs_dir": str(run_mod.runs_dir_for(cfg)),
                "serial_port": "",
            }
            artifacts = {
                k: run_mod._sub_text(str(v), subs, {}, self.ref.name, cfg)
                for k, v in artifacts.items()
            }
        return ResolvedToolchain(provider=self.ref, steps=steps,
                                 artifacts=artifacts,
                                 debug=dict(self.man.get("debug") or {}))


# ── 注册表 ──────────────────────────────────────────────────────
class ProviderRegistry:
    """扫描 provider roots，按名字/版本解析引用。"""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.providers: dict[str, DataProvider] = {}
        for root in provider_roots(cfg):
            if not root.is_dir():
                continue
            for path in sorted(root.rglob(PROVIDER_FILE),
                               key=lambda p: p.as_posix()):
                man = read_manifest(path)
                problems = validate_manifest(man)
                if problems:
                    raise ProviderError(
                        f"provider 校验失败：{path}\n  - " + "\n  - ".join(problems))
                name = str(man["name"])
                prev = self.providers.get(name)
                if prev is not None and prev.path != to_fwd(path):
                    raise ProviderError(
                        f"provider 重名：{name}（{prev.path} 与 {to_fwd(path)}）")
                self.providers[name] = DataProvider(man, to_fwd(path))

    def installed_names(self) -> list[str]:
        return sorted(self.providers)

    def get(self, name: str) -> DataProvider | None:
        return self.providers.get(name)

    def resolve_ref(self, ref: str) -> DataProvider | NativeProvider:
        name, spec = split_ref(ref)
        if name in ("elab/native", "native"):
            return NativeProvider()
        prov = self.providers.get(name)
        if prov is None:
            hints = ", ".join(self.installed_names()) or "(无)"
            raise ProviderError(
                f"未安装 provider：{name}（已安装：{hints}）\n"
                f"  修复：elab provider install {name}")
        if spec and not satisfies_version(prov.ref.version, spec):
            raise ProviderError(
                f"provider {name} 版本不满足 {spec}：已安装 {prov.ref.version}"
                f"（可用：{', '.join(sorted(self.installed_versions(name)))}）")
        return prov

    def installed_versions(self, name: str) -> list[str]:
        p = self.providers.get(name)
        return [p.ref.version] if p else []


# ── 解析：项目绑定 → 不可变 ResolvedToolchain ────────────────────
def inline_decl(cfg: Config, project: str, proj: dict, step: str,
                spec: str) -> StepDecl:
    """项目内联 ``steps.<step>: tool:<name>`` → ``StepDecl``（与 provider 同构）。"""
    from . import run as run_mod
    name = spec[len(run_mod.TOOL_PREFIX):].strip()
    tools = proj.get("tools") or {}
    t = tools.get(name)
    if not isinstance(t, dict):
        raise ProviderError(
            f"项目 {project} 的 steps.{step} 委托给未声明的 tools.{name}")
    return StepDecl(
        step=step, kind="external", tool_name=name,
        label=str(t.get("label") or name),
        cmd=tuple(str(a) for a in (t.get("cmd") or [])),
        cwd=str(t.get("cwd") or ""),
        env={str(k): str(v) for k, v in (t.get("env") or {}).items()},
        env_from_cmd=dict(t.get("env_from_cmd") or {}),
        env_prepend_path=tuple(str(d) for d in (t.get("env_prepend_path") or [])),
        timeout_s=int(t.get("timeout_s") or 0),
        result=dict(t.get("result") or {}),
        provider="project",
    )


def resolve(cfg: Config, project: str,
            registry: ProviderRegistry | None = None) -> ResolvedToolchain:
    """项目绑定 + provider 步骤 + 内联覆盖 → 不可变工具链视图。

    优先级（高 → 低）：项目 ``steps.tool:`` → provider ``steps`` → 无 provider 时原生链。
    """
    from . import run as run_mod
    proj = cfg.resolved_project(project)
    ref = str(proj.get("provider") or "").strip()
    reg = registry or ProviderRegistry(cfg)
    if ref:
        provider = reg.resolve_ref(ref)
        base = provider.resolve(cfg, proj)
    else:
        base = NativeProvider().resolve(cfg, proj)

    declared = proj.get("steps") or {}
    steps: dict[str, StepDecl] = {}
    unavailable: list[dict] = []
    for step in run_mod.ALL_STEPS:
        spec = declared.get(step)
        if isinstance(spec, str) and spec.startswith(run_mod.TOOL_PREFIX):
            steps[step] = inline_decl(cfg, project, proj, step, spec)
        elif spec is not None:
            raise ProviderError(
                f"项目 {project} 的 steps.{step} 只接受 tool:<name>：{spec!r}")
        elif step == "monitor":
            steps[step] = _native_decl("monitor")
        elif step in base.steps:
            steps[step] = base.steps[step]
        elif ref:
            reason = f"{ref} 未提供 steps.{step}"
            hint = f"在 provider 的 provider.yaml 增加 steps.{step}，或用项目 steps.{step}: tool:<name> 显式覆盖"
            steps[step] = StepDecl(step=step, kind="unavailable", label=step,
                                   reason=reason, hint=hint)
            unavailable.append({"step": step, "code": "provider.step-missing",
                                "message": reason, "hint": hint})
        else:
            steps[step] = _native_decl(step)

    artifacts = dict(base.artifacts or {})
    for k, v in (proj.get("artifacts") or {}).items():
        if str(v or "").strip():
            artifacts[str(k)] = str(v)
    return ResolvedToolchain(provider=base.provider, steps=steps,
                             artifacts=artifacts, debug=base.debug,
                             unavailable=tuple(unavailable))


# ── 可用性（host / probe / serial）───────────────────────────────
def _host_fact(cfg: Config, key: str) -> str:
    from . import run as run_mod
    try:
        return str(run_mod._host_value(cfg, key))
    except ElabError:
        return ""


def _check_one(value: str, kind: str) -> bool:
    if kind == "nonempty":
        return bool(value.strip())
    p = Path(value)
    if kind == "file":
        return p.is_file()
    if kind == "dir":
        return p.is_dir()
    if kind == "exe":
        if not p.is_file():
            return False
        if os.name == "nt":
            return p.suffix.lower() in (".exe", ".cmd", ".bat", ".com")
        return os.access(p, os.X_OK)
    return False


def evaluate(cfg: Config, project: str,
             toolchain: ResolvedToolchain | None = None) -> dict:
    """求 provider ``requires``（host/probe/serial）→ ``{available, reasons}``。"""
    proj = cfg.resolved_project(project)
    tc = toolchain or resolve(cfg, project)
    reasons: list[dict] = []
    if tc.provider.source == "builtin":
        # 内置链：探针/串口归属由各步骤原生判定（保持既有行为）
        return {"available": True, "reasons": []}

    reg = ProviderRegistry(cfg)
    prov = reg.get(tc.provider.name)
    if prov is None:
        return {"available": False,
                "reasons": [{"code": "provider.missing", "key": tc.provider.name,
                             "message": f"未安装 provider：{tc.provider.name}",
                             "hint": f"elab provider install {tc.provider.name}"}]}
    req = prov.man.get("requires") or {}
    for item in req.get("host") or []:
        key = str(item.get("key") or "")
        kind = str(item.get("check") or "file")
        val = _host_fact(cfg, key)
        if not val:
            reasons.append({"code": "host.missing", "key": key,
                            "message": f"主机事实源未声明：${{host:{key}}}",
                            "hint": "在 elab.host.yaml 声明该路径"})
        elif not _check_one(val, kind):
            reasons.append({"code": "host.invalid", "key": key,
                            "message": f"{key}={val} 不是有效的 {kind}",
                            "hint": "检查 elab.host.yaml 或环境变量覆盖"})
    if req.get("probe"):
        probe = str((proj.get("debug") or {}).get("probe") or "")
        probes = ((cfg.host or {}).get("probes") or {}).get("list") or {}
        if not probe or probe not in probes:
            reasons.append({"code": "probe.missing", "key": probe,
                            "message": f"该项目要求探针，但 debug.probe={probe or '空'}",
                            "hint": "在项目 YAML 声明 debug.probe，并确认它在 elab.host.yaml: probes.list"})
    if req.get("serial"):
        from . import serialport as serialport_mod
        spec = ((proj.get("serial") or {}).get("port")) or "auto"
        ports, _layer = serialport_mod.list_ports()
        port, why, _cands = serialport_mod.select_port(spec, ports)
        if not port:
            reasons.append({"code": "serial.unavailable", "key": spec,
                            "message": f"串口不可用（{spec}）：{why}",
                            "hint": "插上串口 / 关闭占用它的程序"})
    return {"available": not reasons, "reasons": reasons}


# ── 安装 / 卸载（P2）─────────────────────────────────────────────
def _find_provider_root(path: Path) -> Path:
    path = Path(path).resolve()
    if (path / PROVIDER_FILE).exists():
        return path
    found = sorted(path.rglob(PROVIDER_FILE))
    if len(found) == 1:
        return found[0].parent
    if not found:
        raise ProviderError(f"目录中没有 {PROVIDER_FILE}：{path}")
    raise ProviderError(f"目录包含 {len(found)} 个 provider，请指定具体目录：{path}")


def _materialize_provider(*, local=None, git=None, ref=None):
    if local:
        p = Path(local).expanduser()
        if not p.exists():
            raise ProviderError(f"本地路径不存在：{p}")
        return _find_provider_root(p), {"type": "local", "path": to_fwd(p)}
    if git:
        url = str(git).replace("git+", "", 1)
        td = tempfile.mkdtemp(prefix="elab-provider-")
        cmd = ["clone", "--depth", "1"]
        if ref:
            cmd += ["--branch", str(ref)]
        cmd += [url, td]
        try:
            pkg._git(cmd)
        except Exception:
            shutil.rmtree(td, ignore_errors=True)
            raise
        return _find_provider_root(Path(td)), {"type": "git", "url": url,
                                               "ref": str(ref or ""), "_temp": td}
    raise ProviderError("缺少 provider 来源（--from 或市场索引）")


def install(cfg: Config, name: str = "", *, local=None, git=None, ref=None,
            sha256: str | None = None, force: bool = False, log=print) -> dict:
    src, origin = _materialize_provider(local=local, git=git, ref=ref)
    try:
        man = read_manifest(src)
        problems = validate_manifest(man)
        if problems:
            raise ProviderError("provider 校验失败：\n  - " + "\n  - ".join(problems))
        real = str(man["name"])
        if name and split_ref(name)[0] != real:
            raise ProviderError(f"安装目标 {name} 与清单 name={real} 不一致")
        h = pkg.tree_hash(src)
        if sha256 and h != sha256:
            raise ProviderError(f"内容 sha256 不匹配：期望 {sha256}，实际 {h}")
        dest = install_root(cfg) / real
        if dest.resolve() == Path(src).resolve():
            raise ProviderError(f"provider 已在安装目录：{dest}（无需重复安装）")
        if dest.exists() and not force:
            raise ProviderError(f"已安装 {real}（{dest}）。升级加 --force，或先 elab provider remove {real}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns(
            ".git", INSTALL_META, "__pycache__"))
        got = pkg.tree_hash(dest)
        if got != h:
            shutil.rmtree(dest, ignore_errors=True)
            raise ProviderError("安装后内容哈希不一致，已回滚")
        meta = {"name": real, "version": str(man["version"]),
                "license": str(man["license"]), "sha256": got,
                "source": {k: v for k, v in origin.items() if not k.startswith("_")}}
        (dest / INSTALL_META).write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log(f"[elab] ✓ 已安装 provider {real}@{meta['version']} → {to_fwd(dest)}")
        return {**meta, "dir": to_fwd(dest)}
    finally:
        td = origin.get("_temp")
        if td:
            shutil.rmtree(td, ignore_errors=True)


def remove(cfg: Config, name: str, *, force: bool = False, log=print) -> dict:
    name = split_ref(name)[0]
    dest = install_root(cfg) / name
    if not (dest / PROVIDER_FILE).exists():
        raise ProviderError(f"未安装 provider：{name}（{to_fwd(dest)}）")
    root = install_root(cfg)
    if not force and root.resolve() not in dest.resolve().parents:
        raise ProviderError(f"拒绝删除非安装目录：{dest}")
    shutil.rmtree(dest)
    log(f"[elab] ✓ 已卸载 provider {name}（{to_fwd(dest)}）")
    return {"name": name, "dir": to_fwd(dest)}


# ── 状态 / 市场 ──────────────────────────────────────────────────
def status(cfg: Config, *, include_market: bool = True, query: str = "") -> dict:
    installed: list[dict] = []
    reg = ProviderRegistry(cfg)
    for name, prov in sorted(reg.providers.items()):
        meta = {}
        meta_path = Path(prov.path).parent / INSTALL_META
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        installed.append({
            "name": name, "version": prov.ref.version,
            "license": str(prov.man.get("license") or ""),
            "description": str(prov.man.get("description") or ""),
            "dir": to_fwd(Path(prov.path).parent),
            "installed": bool(meta),
            "sha256": meta.get("sha256") or "",
            "steps": sorted((prov.man.get("steps") or {})),
            "requires": prov.man.get("requires") or {},
        })
    out = {"roots": [to_fwd(p) for p in provider_roots(cfg)],
           "install_root": to_fwd(install_root(cfg)),
           "installed": installed, "provider_api": PROVIDER_API_VERSION}
    if include_market:
        out["market"] = _market_entries(cfg, query)
    return out


def _market_entries(cfg: Config, query: str = "") -> list[dict]:
    data = pkg.load_market(cfg)
    base = data.get("_base", "")
    entries = list(data.get("providers") or [])
    # 本仓 market/index.json 的 provider 条目也参与展示/安装：
    # 远端包市场可能尚未收录 provider；本地索引是官方源的确定入口。
    local_path = Path(cfg.root) / "market" / "index.json"
    if local_path.exists():
        try:
            local = json.loads(local_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            local = {}
        known = {str(e.get("name")) for e in entries}
        for e in local.get("providers") or []:
            if str(e.get("name")) not in known:
                entries.append({**e, "_base": to_fwd(Path(cfg.root))})
    installed = {p["name"] for p in status(cfg, include_market=False)["installed"]
                 if p["installed"]}
    out: list[dict] = []
    for entry in entries:
        if str(entry.get("kind") or "provider") != "provider":
            continue
        blob = " ".join(str(entry.get(k) or "") for k in
                        ("name", "description", "license"))
        if query and query.lower() not in blob.lower():
            continue
        out.append({**entry,
                    "_base": entry.get("_base") or base,
                    "installed": entry.get("name") in installed})
    return out


def market_entry(cfg: Config, name: str) -> dict | None:
    name = split_ref(name)[0]
    for entry in _market_entries(cfg):
        if entry.get("name") == name:
            return entry
    return None


def entry_source(entry: dict, base: str) -> dict:
    src = entry.get("source") or {}
    typ = str(src.get("type") or "local")
    if typ == "local":
        return {"local": str((Path(base) / str(src.get("path") or "")).resolve())}
    if typ == "git":
        return {"git": str(src.get("url") or ""), "ref": src.get("ref") or ""}
    raise ProviderError(f"未知 provider source.type：{typ!r}")


def index_entries(cfg: Config) -> list[dict]:
    """由 ``providers/official/**`` 生成市场 provider 条目（确定性）。"""
    out: list[dict] = []
    base = Path(cfg.root)
    for path in sorted(official_root(cfg).rglob(PROVIDER_FILE),
                       key=lambda p: p.as_posix()):
        man = read_manifest(path)
        problems = validate_manifest(man)
        if problems:
            raise ProviderError(f"生成索引时 provider 校验失败：{path}\n  - "
                                + "\n  - ".join(problems))
        pdir = path.parent
        try:
            rel = pdir.resolve().relative_to(base.resolve()).as_posix()
        except ValueError:
            rel = to_fwd(pdir)
        out.append({
            "name": str(man["name"]),
            "kind": "provider",
            "version": str(man["version"]),
            "license": str(man["license"]),
            "description": str(man.get("description") or ""),
            "provider_api": int(man.get("provider_api") or 0),
            "requires": man.get("requires") or {},
            "steps": sorted((man.get("steps") or {})),
            "source": {"type": "local", "path": rel},
            "sha256": pkg.tree_hash(pdir),
        })
    return sorted(out, key=lambda e: str(e.get("name")))


def index_problems(cfg: Config, index_path: Path) -> list[str]:
    """``elab pkg index --check`` 的 provider 部分。"""
    try:
        actual = json.loads(Path(index_path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [f"索引不可读：{exc}"]
    expected = index_entries(cfg)
    by = {e.get("name"): e for e in actual.get("providers") or []}
    problems: list[str] = []
    for e in expected:
        cur = by.get(e["name"])
        if not cur:
            problems.append(f"索引缺少 provider：{e['name']}")
            continue
        if str(cur.get("kind") or "") != "provider":
            problems.append(f"{e['name']} 的 kind 必须为 provider：{cur.get('kind')!r}")
        for key in ("version", "sha256", "license", "requires", "provider_api", "steps", "source"):
            if cur.get(key) != e.get(key):
                problems.append(f"{e['name']} 的 {key} 漂移：索引={cur.get(key)!r}，"
                                f"实际={e.get(key)!r}")
    names = {e["name"] for e in expected}
    for name, cur in by.items():
        src = (cur.get("source") or {}).get("type") or "local"
        if src == "local" and name not in names:
            problems.append(f"索引含已删除的内置 provider：{name}")
        if str(cur.get("kind") or "") != "provider":
            problems.append(f"provider 条目 {name} 缺少 kind: provider")
        if str(cur.get("provider_api") or "") != str(PROVIDER_API_VERSION):
            problems.append(f"provider 条目 {name} 的 provider_api 必须为 {PROVIDER_API_VERSION}")
        sha = str(cur.get("sha256") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", sha):
            problems.append(f"provider 条目 {name} 的 sha256 格式非法：{sha!r}")
    return problems


__all__ = [
    "CORE_ONLY_STEPS", "DataProvider", "DEFAULT_TIMEOUTS", "NativeProvider",
    "PROVIDER_API_VERSION", "PROVIDER_FILE", "ProviderError", "ProviderRef",
    "ProviderRegistry", "ResolvedToolchain", "StepDecl", "ToolchainProvider",
    "entry_source", "evaluate", "index_entries", "index_problems", "inline_decl",
    "install", "install_root", "market_entry", "native_decl", "official_root",
    "provider_roots", "read_manifest", "remove", "resolve", "satisfies_version",
    "split_ref", "status", "validate_manifest",
]
