"""elab.setup —— 装完芯片包后的环境自检与安装引导（只读）。

为什么需要它：芯片包只是**数据**（芯片参数 / 指纹 / 坑位），真正让板子跑起来
的是主机上的工具链。装完包却没人告诉用户"还缺什么"，就会出现"装了 ESP32 包
但根本用不了"的体验。本模块在 ``elab pkg install/bootstrap/update/activate``
之后自动跑一遍，也作为 ``elab setup`` 子命令单独可用。

它只做三件事，**不执行任何安装命令、不写 elab.host.yaml**：

1. **看包**：是否已安装 / 已启用、包内有哪些芯片。
2. **看 provider / 工具链**：包的 ``vendor_fingerprints[*].provider_hint``
   指向的 provider 是否安装、``requires.host`` 是否就绪；缺什么逐项上报。
3. **给下一步**：官方 provider 源码里的 ``toolchain`` 块（安装命令 / docs /
   要填的 host 键）只用于**展示**，由用户自己决定装不装。
"""

from __future__ import annotations

import os
import sys

from . import doctor as doctor_mod
from . import pkg, provider
from .config import Config, ElabError, Host

_ICON = {"ok": "OK  ", "warn": "WARN", "error": "FAIL", "info": "info"}

#: 原生链（无 provider_hint）缺失项 → 修复提示。键是 ``doctor.check_host`` 的 code。
_NATIVE_FIX = {
    "toolchain.root": "安装 arm-none-eabi-gcc，并在 elab.host.yaml: toolchains.arm-none-eabi.root 填路径",
    "toolchain.cc": "arm-none-eabi-gcc 不在预期目录；检查 toolchains.arm-none-eabi.root",
    "toolchain.version": "把 elab.host.yaml: toolchains.arm-none-eabi.version 改成实测版本",
    "tools.ninja": "安装 ninja，并在 elab.host.yaml: tools.ninja.path 填路径",
    "tools.cmake": "安装 cmake（≥3.22），或填 tools.cmake.path",
    "tools.openocd": "烧录需要 openocd：填 tools.openocd.path",
    "openocd.scripts": "填 tools.openocd.scripts（openocd 的 scripts 目录）",
    "tools.gdb": "调试需要 ARM gdb（通常随 arm-none-eabi 工具链）",
}


# ── 小工具 ────────────────────────────────────────────────────────
def _add(items, seen, level, code, message, *, action="", detail=None):
    """去重后追加一条自检项（同一 code+message 只保留第一次）。"""
    key = (code, message)
    if key in seen:
        return
    seen.add(key)
    item = {"level": level, "code": code, "message": message}
    if action:
        item["action"] = action
    if detail:
        item["detail"] = [str(x) for x in detail]
    items.append(item)


def _next(next_steps, text):
    text = str(text or "").strip()
    if text and text not in next_steps:
        next_steps.append(text)


def _provider_hints(man: dict) -> list[str]:
    """包声明的 provider 软提示（``vendor_fingerprints[*].provider_hint``）。"""
    out: list[str] = []
    for fp in man.get("vendor_fingerprints") or []:
        if not isinstance(fp, dict):
            continue
        hint = str(fp.get("provider_hint") or "").strip()
        if hint and hint not in out:
            out.append(hint)
    return out


def _official_manifest(cfg: Config, name: str) -> dict | None:
    """在 ``providers/official/**`` 里按名字找 provider 清单（仅用于展示安装引导）。

    ★ 这不是发现根：只用来看 ``toolchain`` / ``requires.host`` 的说明，
      未安装的 provider 仍然不可用（不回退，D3）。
    """
    root = provider.official_root(cfg)
    if not root.is_dir():
        return None
    for path in sorted(root.rglob(provider.PROVIDER_FILE), key=lambda p: p.as_posix()):
        try:
            man = provider.read_manifest(path)
        except ElabError:
            continue
        if str(man.get("name") or "") == name:
            return man
    return None


def _toolchain_info(man: dict | None) -> dict:
    tc = (man or {}).get("toolchain") or {}
    if not isinstance(tc, dict):
        tc = {}
    install = tc.get("install") if isinstance(tc.get("install"), dict) else {}
    lines: dict[str, list[str]] = {}
    for key, value in install.items():
        if isinstance(value, list):
            lines[str(key)] = [str(x) for x in value if str(x).strip()]
        elif isinstance(value, str) and value.strip():
            lines[str(key)] = [x for x in value.splitlines() if x.strip()]
    return {
        "name": str(tc.get("name") or ""),
        "version": str(tc.get("version") or ""),
        "docs": str(tc.get("docs") or ""),
        "install": lines,
        "host_keys": [str(k) for k in (tc.get("host_keys") or [])],
    }


def _platform_key() -> str:
    """当前平台键（与 provider ``toolchain.install`` 的平台名一致）。"""
    if os.name == "nt":
        return "windows"
    return "macos" if sys.platform == "darwin" else "linux"


def _install_cmd(tc: dict, os_name: str) -> tuple[str, list[str]]:
    """取当前系统的安装命令（缺失时退回第一个平台，并如实标注平台）。"""
    install = tc.get("install") or {}
    cmd = install.get(os_name)
    if cmd:
        return os_name, list(cmd)
    for name, value in install.items():
        if value:
            return str(name), list(value)
    return "", []


def _generic_host(cfg: Config, items, seen) -> None:
    """原生链包：用 doctor 的主机层检查（gcc / ninja / cmake / openocd / gdb）。"""
    rep = doctor_mod.Report()
    try:
        doctor_mod.check_host(cfg, rep, Host(cfg))
    except ElabError as exc:
        _add(items, seen, "error", "host.yaml", str(exc))
        return
    for level, code, msg in rep.items:
        action = "" if level == doctor_mod.OK else _NATIVE_FIX.get(code, "")
        _add(items, seen, level, code, msg, action=action)


def _project_checks(cfg: Config, project: str, items, seen, next_steps,
                    missing_providers: set, host_seen: set) -> None:
    """工程级：串口 / 探针是否就绪（复用 provider.evaluate 的判定）。"""
    try:
        cfg.resolved_project(project)
    except ElabError as exc:
        _add(items, seen, "error", "project", str(exc),
             action="检查 projects/*.yaml 与包内芯片")
        return
    try:
        tc = provider.resolve(cfg, project)
        state = provider.evaluate(cfg, project, tc)
    except ElabError as exc:
        # provider 缺失 / 版本不符已在包级上报，这里不重复同一条
        text = str(exc)
        if any(name in text for name in missing_providers):
            return
        _add(items, seen, "error", "project.provider", text.splitlines()[0])
        return
    seen_reasons: set = set()
    for reason in state.get("reasons") or []:
        code = str(reason.get("code") or "")
        key = str(reason.get("key") or "")
        # 主机键已由包级 requires.host 检查覆盖，不重复
        if code in ("host.missing", "host.invalid") and key in host_seen:
            continue
        dedupe = f"{code}:{key}"
        if dedupe in seen_reasons:
            continue
        seen_reasons.add(dedupe)
        level = "error" if code in ("host.missing", "host.invalid", "probe.missing") else "warn"
        _add(items, seen, level, f"project.{code}", str(reason.get("message") or ""),
             action=str(reason.get("hint") or ""))
        _next(next_steps, reason.get("hint"))


# ── 主入口 ────────────────────────────────────────────────────────
def pack_report(cfg: Config, pack: str = "", project: str = "") -> dict:
    """对某个适配包做一次环境自检（缺省 = 当前启用的包）。返回可 JSON 的报告。"""
    # 重载：刚安装/启用的包可能还没进原 cfg 缓存
    cfg = Config(cfg.root)
    items: list[dict] = []
    seen: set = set()
    next_steps: list[str] = []
    report = {"ok": False, "pack": {}, "providers": [], "project": project,
              "items": items, "next": next_steps}

    try:
        packs = cfg.packs
        active = pkg.active_pack(cfg, packs)
    except ElabError as exc:
        _add(items, seen, "error", "pack.discover", str(exc),
             action="检查 packs/installed 内的 pack.yaml")
        _next(next_steps, "检查适配包目录与 pack.yaml")
        return report

    # 带工程时优先用工程固定的包（``pack: vendor/platform``），否则用当前启用的包
    pinned = False
    if project and not pack:
        try:
            pinned_name = str(cfg.resolved_project(project).get("pack") or "").strip()
        except ElabError:
            pinned_name = ""
        if pinned_name:
            pack, pinned = pinned_name, True

    name = str(pack or (active or {}).get("name") or "").strip()
    rec = packs.get(name) if name else None
    if not rec:
        if pack:
            _add(items, seen, "error", "pack.missing", f"未安装适配包：{pack}",
                 action=f"elab pkg install {pack}")
            _next(next_steps, f"elab pkg install {pack}")
        else:
            _add(items, seen, "warn", "pack.none",
                 "尚未安装任何芯片适配包（通用骨架不内置芯片）",
                 action="elab pkg bootstrap（官方包）或 elab pkg search（社区市场）")
            _next(next_steps, "elab pkg bootstrap")
            _next(next_steps, "elab pkg search <关键词>")
        return report

    man = rec.get("manifest") or {}
    pack_info = {
        "name": str(rec.get("name") or ""),
        "version": str(man.get("version") or ""),
        "dir": str(rec.get("dir") or ""),
        "installed": bool(rec.get("installed")),
        "active": bool(active and active.get("name") == rec.get("name")),
        "chips": list(rec.get("chips") or []),
    }
    report["pack"] = pack_info
    label = f"{pack_info['name']}@{pack_info['version']}" if pack_info["version"] else pack_info["name"]

    if not pack_info["installed"]:
        _add(items, seen, "warn", "pack.source",
             f"{label} 只在源码目录，尚未安装", action=f"elab pkg install {name} --from {pack_info['dir']}")
        _next(next_steps, f"elab pkg install {name} --from {pack_info['dir']}")
    elif not pack_info["active"] and not pinned:
        current = str((active or {}).get("name") or "无")
        _add(items, seen, "warn", "pack.inactive",
             f"{label} 已安装但未启用（当前启用：{current}；固定包项目不受影响）",
             action=f"elab pkg activate {name}")
        _next(next_steps, f"elab pkg activate {name}")
    else:
        suffix = "（已启用）" if pack_info["active"] else "（工程固定包）"
        _add(items, seen, "ok", "pack.installed", f"{label}{suffix}")

    if pack_info["chips"]:
        _add(items, seen, "ok", "pack.chips", "、".join(pack_info["chips"]))
    else:
        _add(items, seen, "error", "pack.chips", "包内没有芯片 YAML（chips/*.yaml）",
             action="重新安装包或检查包内容")

    hints = _provider_hints(man)
    host_seen: set = set()
    if not hints:
        _add(items, seen, "info", "provider.none",
             "该包未绑定工具链 provider：使用内核原生工具链")
        _generic_host(cfg, items, seen)
    else:
        try:
            registry = provider.ProviderRegistry(cfg)
        except ElabError as exc:
            _add(items, seen, "error", "provider.registry", str(exc),
                 action="elab provider list")
            registry = None
        for ref in hints:
            report["providers"].append(_provider_checks(
                cfg, registry, ref, items, seen, next_steps, host_seen))

    if project:
        missing_providers = {p["name"] for p in report["providers"]
                             if not p["installed"]}
        _project_checks(cfg, project, items, seen, next_steps,
                        missing_providers, host_seen)

    missing = [i for i in items if i["level"] == "error"]
    report["ok"] = not missing
    if not missing:
        if project:
            _next(next_steps, f"elab doctor -p {project}")
        elif cfg.projects:
            _next(next_steps, "elab setup -p <工程名>")
        else:
            _next(next_steps, "elab doctor")
    return report


def _provider_checks(cfg: Config, registry, ref: str, items, seen, next_steps,
                     host_seen: set) -> dict:
    """单个 provider_hint：是否安装 / 版本 / requires.host / 工具链安装引导。"""
    name, spec = provider.split_ref(ref)
    prov = registry.get(name) if registry else None
    src_man = prov.man if prov is not None else _official_manifest(cfg, name)
    tc = _toolchain_info(src_man)
    entry = {"name": name, "installed": prov is not None,
             "version": prov.ref.version if prov else "",
             "steps": sorted((prov.man.get("steps") or {})) if prov else [],
             "toolchain": tc, "host": [], "action": ""}

    if prov is None:
        cmd = f"elab provider install {name}"
        entry["action"] = cmd
        _add(items, seen, "error", f"provider.{name}",
             f"未安装工具链 provider：{name}", action=cmd)
        _next(next_steps, cmd)
    elif spec and not provider.satisfies_version(prov.ref.version, spec):
        cmd = f"elab provider install {name} --force"
        entry["action"] = cmd
        _add(items, seen, "error", f"provider.{name}.version",
             f"provider {name}@{prov.ref.version} 不满足约束 {spec}", action=cmd)
        _next(next_steps, cmd)
    else:
        _add(items, seen, "ok", f"provider.{name}",
             f"provider {name}@{prov.ref.version}（steps="
             f"{','.join(entry['steps']) or '-'}）")

    host = provider.host_checks(cfg, src_man or {})
    entry["host"] = host
    missing_keys: list[str] = []
    for h in host:
        key = h["key"]
        if key in host_seen:
            continue
        host_seen.add(key)
        if h["ok"]:
            _add(items, seen, "ok", f"host.{key}", f"{key} = {h['value']}")
        else:
            missing_keys.append(key)
            _add(items, seen, "error", f"host.{key}", h["message"], action=h["hint"])

    # 工具链安装引导：只在 host 真的缺东西时展示；命令原文由用户自己执行
    if missing_keys and tc["name"]:
        os_name, cmd = _install_cmd(tc, _platform_key())
        title = tc["name"] + (f" {tc['version']}" if tc["version"] else "")
        detail = []
        if tc["docs"]:
            detail.append(f"文档：{tc['docs']}")
        if cmd:
            detail.append(f"{os_name} 安装：")
            detail += cmd
        _add(items, seen, "info", f"toolchain.{name}",
             f"{title}（安装引导，不会自动执行）", detail=detail)
        keys = "、".join(missing_keys)
        _next(next_steps, f"按上方命令安装 {title}，并在 elab.host.yaml 填写：{keys}")
    elif missing_keys:
        _next(next_steps, "在 elab.host.yaml 填写：" + "、".join(missing_keys))
    return entry


def render(report: dict) -> str:
    """人类可读输出（与 ``--json`` 同一份数据）。"""
    lines: list[str] = []
    pack = report.get("pack") or {}
    head = "[elab] setup"
    if pack:
        head += f"：{pack.get('name')}"
        if pack.get("version"):
            head += f"@{pack['version']}"
    lines.append(head)
    for item in report.get("items") or []:
        lines.append(f"  [{_ICON.get(item['level'], 'info')}] "
                     f"{item['code']:<22} {item['message']}")
        for line in item.get("detail") or []:
            lines.append(f"           {line}")
        if item.get("action") and item["level"] != "ok":
            lines.append(f"           → {item['action']}")
    if report.get("project"):
        lines.append(f"  工程：{report['project']}")
    steps = report.get("next") or []
    if steps:
        lines.append("下一步：")
        for i, step in enumerate(steps, 1):
            lines.append(f"  {i}. {step}")
    if report.get("ok"):
        lines.append("[elab] ✓ 环境自检通过")
    else:
        lines.append("[elab] ✗ 环境未就绪（见上面的缺失项）")
    return "\n".join(lines)


__all__ = ["pack_report", "render"]
