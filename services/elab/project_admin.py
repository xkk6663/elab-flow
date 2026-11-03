"""elab.project_admin —— `projects/*.yaml` 的生命周期管理（重命名 / 移除 / 切换探针）。

★ 只动**接入层文件**，业务工程一个字节都不碰（guard 文件树快照不受影响）。
★ 每次成功操作后由调用方重载 ``Config``（`/api/adapt` 写盘后同源）：
   不重载则左侧工程卡不会变化（C29 的同一教训）。
"""

from __future__ import annotations

import re
from pathlib import Path

from .config import Config, ElabError, Host, to_fwd

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def _yaml_path(cfg: Config, name: str) -> Path:
    return cfg.root / "projects" / f"{name}.yaml"


def _boot_referrers(cfg: Config, name: str) -> list[str]:
    """哪些芯片把该工程声明成 ``ota_layout.boot_project``（改名/删除会断裂）。"""
    refs = []
    for chip_ref, chip in cfg.chips.items():
        if str((chip.get("ota_layout") or {}).get("boot_project") or "") == name:
            refs.append(chip_ref)
    return refs


def rename(cfg: Config, old: str, new: str) -> dict:
    """把 ``projects/<old>.yaml`` 改名为 ``<new>.yaml`` 并同步 ``name:`` 字段。

    - 只改**文件基名 + name 行 + 按工程名派生的 work_dir**；
      工程内的 ``project_name``（产物名）属于业务事实，**不动**。
    - ``projects/*.yaml`` 的键来自 ``name:`` 而不是文件名，故两处必须一起改。
    """
    old = (old or "").strip()
    new = (new or "").strip()
    if not old or not new:
        raise ElabError("重命名需要 name 与 new_name")
    if not _NAME_RE.match(new):
        raise ElabError(f"工程名只能含字母/数字/下划线/点/中划线：{new!r}")

    src = _yaml_path(cfg, old)
    dst = _yaml_path(cfg, new)
    if not src.is_file():
        raise ElabError(f"工程不存在：{old}（没有 projects/{old}.yaml）")
    if new == old:
        return {"status": "identical", "name": old, "path": to_fwd(src)}
    if dst.exists():
        raise ElabError(f"工程名已被占用：{new}（projects/{new}.yaml 已存在）")

    refs = _boot_referrers(cfg, old)
    if refs:
        raise ElabError(
            f"{old} 被芯片 {', '.join(refs)} 的 ota_layout.boot_project 引用 —— "
            "改名会断裂 boot 级联，请先改适配包 chips/*.yaml")

    text = src.read_text(encoding="utf-8")
    text2, n = re.subn(r"(?m)^name:\s*\S+[ \t]*$", f"name: {new}", text, count=1)
    if n == 0:
        raise ElabError(f"projects/{old}.yaml 缺少顶层 name 行，无法安全改名")
    # 生成器的首行注释也带工程名，一并改成新名（不按旧名匹配：历史文件可能已漂）。
    text2 = re.sub(r"(?m)^(#\s*projects/).*?(\.yaml)",
                   rf"\g<1>{new}\g<2>", text2, count=1)
    # work_dir 若按工程名派生（elab adapt 的默认写法），跟随改名；
    # 否则保持用户自定义路径不变。
    text2 = re.sub(
        rf"(?m)^(\s*work_dir:\s*\${{ELAB_ROOT}}/\.work/){re.escape(old)}([ \t]*)$",
        rf"\g<1>{new}\g<2>", text2)

    dst.write_text(text2, encoding="utf-8")
    src.unlink()
    return {"status": "renamed", "name": new, "old": old, "path": to_fwd(dst)}


def set_probe(cfg: Config, name: str, probe: str) -> dict:
    """切换 ``projects/<name>.yaml`` 的 ``debug.probe``（保留注释与其它字段）。

    ★ 只改 ``debug:`` 块里的 probe 行，**不重新生成** yaml（避免覆盖手工调整）。
    ★ 探针必须已在 ``elab.host.yaml`` 的 ``probes.list`` 中声明，且接口文件存在。
    """
    name = (name or "").strip()
    probe = (probe or "").strip()
    if not name or not probe:
        raise ElabError("切换探针需要 name 与 probe")

    src = _yaml_path(cfg, name)
    if not src.is_file():
        raise ElabError(f"工程不存在：{name}（没有 projects/{name}.yaml）")
    host = Host(cfg)
    if probe not in host.probes:
        opts = ", ".join(sorted(host.probes)) or "（空）"
        raise ElabError(f"未知探针：{probe}（elab.host.yaml 可选：{opts}）")

    icfg = str((host.probe(probe) or {}).get("interface_cfg") or "").strip()
    scripts = host.openocd_scripts
    if icfg and scripts and not (Path(scripts) / icfg).is_file():
        raise ElabError(
            f"探针 {probe} 的接口文件不存在：{icfg}（OpenOCD scripts：{scripts}）")

    text = src.read_text(encoding="utf-8")
    m = re.search(r"(?m)^debug:[ \t]*(?:#.*)?\r?\n", text)
    if m is None:
        if text and not text.endswith("\n"):
            text += "\n"
        text += f"debug:\n  probe: {probe}\n"
    else:
        start = m.end()
        nxt = re.search(r"(?m)^[A-Za-z_][A-Za-z0-9_-]*:", text[start:])
        end = start + nxt.start() if nxt else len(text)
        block = text[start:end]
        block2, n = re.subn(
            r"(?m)^([ \t]+probe:[ \t]*)(\S+)([ \t]*(?:#.*)?)$",
            rf"\g<1>{probe}\g<3>", block, count=1)
        if n == 0:
            block2 = f"  probe: {probe}\n" + block
        text = text[:start] + block2 + text[end:]

    src.write_text(text, encoding="utf-8")
    return {"status": "probe-set", "name": name, "probe": probe, "path": to_fwd(src)}


def remove(cfg: Config, name: str) -> dict:
    """移除 ``projects/<name>.yaml``（先留一份 ``.bak`` 再删）。

    ``*.bak`` 不匹配 ``projects/*.yaml`` 的通配，所以不会再出现在工程轨里；
    需要恢复时把 ``.bak`` 改回 ``.yaml`` 即可。
    """
    name = (name or "").strip()
    if not name:
        raise ElabError("缺少 name")

    src = _yaml_path(cfg, name)
    if not src.is_file():
        raise ElabError(f"工程不存在：{name}（没有 projects/{name}.yaml）")

    refs = _boot_referrers(cfg, name)
    if refs:
        raise ElabError(
            f"{name} 被芯片 {', '.join(refs)} 的 ota_layout.boot_project 引用 —— "
            "移除会断裂 boot 级联，请先改适配包 chips/*.yaml")

    backup = Path(str(src) + ".bak")
    backup.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    src.unlink()
    return {"status": "removed", "name": name, "backup": to_fwd(backup),
            "path": to_fwd(src)}
