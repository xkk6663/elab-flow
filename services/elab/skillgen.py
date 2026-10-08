"""elab.skillgen —— 由 chips/*.yaml 生成**平台级** AI skill（L6）。

设计要点
--------
skill 的内容**不手写**，而是从 `chips/<vendor>/<id>.yaml` + `projects/*.yaml`
渲染出来。这样当芯片参数变化时，skill 不会悄悄过期——
「单一数据源」这条原则一直贯彻到 AI 接入层。

★ 平台化命名（约束）：skill 按「芯片平台」聚合，而不是按具体型号——
  STM32 类芯片共用一份 `skills/st/stm32/SKILL.md`，AT32 类共用
  `skills/artery/at32/SKILL.md`。平台名取自 chips/*.yaml 的
  `platform` 字段（缺省回落到芯片 id，保持向后兼容）。
  理由：同平台芯片的编译/烧录/调试工作流高度相似，逐型号一份
  skill 会大量重复且维护面膨胀；一份平台 skill 内按芯片分节。

生成物：`skills/<vendor>/<platform>/SKILL.md`
作用：让 AI 只读这一个文件，就能在该平台的任一接入芯片上完成
「改代码 → 编译 → 烧录 → 看日志」的闭环，而不必事先懂 elab-Flow 的全部架构。
"""

from __future__ import annotations

from pathlib import Path

from .config import Config, ElabError, Host, to_fwd


def _chip_ref(chip: dict) -> str:
    return f"{chip.get('vendor')}/{chip.get('id')}"


def _platform_of(chip: dict) -> str:
    """平台名：chips/*.yaml 的 platform 字段；缺省回落芯片 id（向后兼容）。"""
    return chip.get("platform") or chip.get("id") or "unknown"


def _uniq_chips(cfg: Config) -> list[dict]:
    seen, out = set(), []
    for chip in cfg.chips.values():
        if id(chip) in seen:
            continue
        seen.add(id(chip))
        out.append(chip)
    return out


def _projects_of(cfg: Config, chip: dict) -> list[dict]:
    ref = _chip_ref(chip)
    return [p for p in cfg.projects.values() if p.get("chip") == ref]


def hexlen(v):
    try:
        return f"0x{int(v):X} ({int(v)} B)"
    except (TypeError, ValueError):
        return str(v)


# ── 单芯片章节（无 frontmatter；由平台头部聚合）────────────────────
def render_chip_section(cfg: Config, chip: dict, host: Host) -> list[str]:
    cid = chip.get("id", "?")
    vendor = chip.get("vendor", "?")
    part = chip.get("part", cid)
    core = chip.get("core") or {}
    mem = chip.get("memory") or {}
    dbg = chip.get("debug") or {}
    projects = _projects_of(cfg, chip)
    primary = projects[0] if projects else None
    proj_name = primary.get("name") if primary else "<project>"

    fpu = core.get("fpu") or "none"
    fpu_note = "★ 无 FPU → 不产出 -mfloat-abi" if fpu in ("", "none") else f"-mfloat-abi={fpu}"
    mfpu = core.get("mfpu") or ""
    if mfpu:
        fpu_note += f" + -mfpu={mfpu}"

    L: list[str] = []
    A = L.append

    A(f"## 芯片 {part}（数据源：`chips/{vendor}/{cid}.yaml`）")
    A("")
    A("| 项 | 值 |")
    A("|---|---|")
    A(f"| 型号 | `{part}` |")
    A(f"| 内核 | `{core.get('cpu', '?')}` |")
    A(f"| 浮点 | `{fpu}` — {fpu_note} |")
    A(f"| FLASH | {hexlen(mem.get('flash', {}).get('length'))} @ `{hex(mem.get('flash', {}).get('origin', 0))}` |")
    A(f"| RAM | {hexlen(mem.get('ram', {}).get('length'))} @ `{hex(mem.get('ram', {}).get('origin', 0))}` |")
    A(f"| 链接脚本 | `{chip.get('linker', {}).get('filename', '?')}`（归工程所有） |")
    A(f"| openocd target | `{dbg.get('openocd_target', '?')}` |")
    A(f"| SVD | `{dbg.get('svd') or '（未声明）'}` |")
    A("")

    A("### 接入的工程")
    A("")
    if projects:
        A("| 工程 | 形态 | 业务工程目录（elab 只读，不改） |")
        A("|---|---|---|")
        for p in projects:
            A(f"| `{p.get('name')}` | {p.get('archetype', '?')} 类 | `{to_fwd(p.get('root', ''))}` |")
    else:
        A("（暂无工程引用本芯片）")
    A("")

    A("### 闭环命令（以工程 " + f"`{proj_name}` 为例）")
    A("")
    A("```bash")
    A(f"elab loop  -p {proj_name}            # ★ 一键闭环：doctor→build→flash→debug→monitor")
    A(f"elab doctor -p {proj_name} --deep     # 体检 + 校验实际编译参数未漂移")
    A(f"elab build  -p {proj_name} --clean    # 编译，产出 elf/hex/bin 到 .work/")
    A(f"elab flash  -p {proj_name}            # openocd 烧录 + verify")
    A(f"elab debug  -p {proj_name} --verify    # 断到 main 自检（非交互）")
    A(f"elab monitor -p {proj_name}           # 串口闭环判据：ok / failed / inconclusive")
    A("```")
    A("")

    pitfalls = chip.get("pitfalls") or []
    if pitfalls:
        A("### 坑位（先读这一节，能省掉大部分调试时间）")
        A("")
        for i, p in enumerate(pitfalls, 1):
            A(f"{i}. {p}")
        A("")

    return L


def render_platform(cfg: Config, vendor: str, platform: str,
                    chips: list[dict], host: Host) -> str:
    parts = [c.get("part", c.get("id", "?")) for c in chips]
    proj_names = sorted({p.get("name") for c in chips
                         for p in _projects_of(cfg, c)} - {None})

    L: list[str] = []
    A = L.append

    A("---")
    A(f"name: {platform}")
    parts_join = "、".join(parts)
    projs_join = "、".join(proj_names) or "elab"
    A(f'description: "{platform} 平台芯片（{parts_join}）在 elab-Flow 下的编译/烧录/调试闭环。'
      f"当需要在 {'/'.join(parts)} 上改动固件并验证、或遇到构建/烧录/调试问题时使用。"
      f'触发词：{platform}、{parts_join}、{projs_join}、elab build/flash/debug/monitor。"')
    A("agent_created: true")
    A("---")
    A("")
    A(f"# {platform} 平台开发闭环（elab-Flow）")
    A("")
    A("> 本文件由 `elab skill` 从 `chips/*.yaml` 自动生成，**请勿手改**——"
      "改芯片参数请改 YAML 后重跑 `elab skill`。同一平台多颗芯片聚合在本文件里，按章节区分。")
    A("")
    A("## 0. 你只需要记住一句话")
    A("")
    A("**业务代码不动，工作流用 `elab` 一条命令走完。**")
    A("elab 是「外骨骼」：它挂在既有工程外面负责 configure / build / flash / debug / monitor，")
    A("不改工程的任何文件（构建前后会用文件树快照自证零改动）。")
    A("加 `--json` 可拿到机器可读输出。**产物一律落在 `elab-flow/.work/<project>/`**，"
      "不会污染业务工程目录。")
    A("")
    A("## 1. 平台接入的芯片")
    A("")
    A("| 芯片 | 内核 |")
    A("|---|---|")
    for c in chips:
        A(f"| `{c.get('part', c.get('id'))}` | `{(c.get('core') or {}).get('cpu', '?')}` |")
    A("")

    for chip in chips:
        A("---")
        A("")
        L.extend(render_chip_section(cfg, chip, host))
        A("")

    A("## 通用验收清单（改完代码后逐条核对）")
    A("")
    for name in proj_names or ["<project>"]:
        A(f"**工程 `{name}`**")
        A("")
        A(f"- [ ] `elab doctor -p {name}` 全绿（含漂移校验）")
        A(f"- [ ] `elab build -p {name}` 通过，`guard.untouched == true`（业务工程零改动）")
        A(f"- [ ] `elab debug -p {name} --verify` 断到 `main`")
        A(f"- [ ] `elab monitor -p {name}` 判 **ok**（`^\\[(boot|alive)\\]` 判据命中）")
        A("")
    A("## 通用定位顺序（出问题先走这条）")
    A("")
    A("1. `elab doctor` 先跑一遍——它会把「主机路径不可达」「两源漂移」直接指出来。")
    A("2. 编译参数怪 → `elab doctor --deep`（它会真跑 configure，")
    A("   从 `compile_commands.json` 取**实际编译命令**作证据）。")
    A("3. 产物名不对/找不到 elf → 检查通用工具链的 `.elf` 后缀约定（约束 C5）。")
    A("4. 烧录失败 → `elab flash -p … --dry-run` 看 openocd 命令行，")
    A("   再确认探针已插好、`elab.host.yaml` 的 openocd 路径正确。")
    A("5. **串口能打开却 0 字节** → 两个已知原因：① MCU 停在 halt 态"
      "（debug 收尾没有 `reset run`）——重跑 `elab flash`（自带 Resetting Target）即可；"
      "② openocd/第三方串口工具占用 VCP（约束 N5，serial 与 debug 不可并行）。")
    A("")
    return "\n".join(L) + "\n"


def generate(cfg: Config, *, project: str | None = None, chip_ref: str | None = None,
             all_chips: bool = False, log=print) -> list[dict]:
    """生成平台级 skill。

    选择目标芯片后按 (vendor, platform) 聚合 —— 一份 SKILL.md 覆盖该平台全部芯片，
    因此即使只指定单芯片（-p/--chip），也会重渲染它所在的整份平台文件。
    """
    host = Host(cfg)
    if project:
        proj = cfg.resolved_project(project)
        chosen = [cfg.chip_of(proj)]
    elif chip_ref:
        if chip_ref not in cfg.chips:
            raise ElabError(f"未知芯片：{chip_ref}")
        chosen = [cfg.chips[chip_ref]]
    elif all_chips:
        chosen = _uniq_chips(cfg)
    else:
        raise ElabError("请指定 -p <项目> 或 --chip <vendor/id> 或 --all")

    # 平台聚合：把所选芯片扩成它所在的整个平台组
    groups: dict[tuple[str, str], list[dict]] = {}
    for chip in _uniq_chips(cfg):
        key = (chip.get("vendor", "unknown"), _platform_of(chip))
        groups.setdefault(key, []).append(chip)

    selected_keys = {(c.get("vendor", "unknown"), _platform_of(c)) for c in chosen}

    written = []
    for key in sorted(selected_keys):
        vendor, platform = key
        group = groups[key]
        out = cfg.root / "skills" / vendor / platform / "SKILL.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        text = render_platform(cfg, vendor, platform, group, host)
        out.write_text(text, encoding="utf-8")
        chips_note = "、".join(c.get("part", "?") for c in group)
        log(f"[elab] ✓ 生成平台 skill：{to_fwd(out)}  ({len(text)} B，芯片：{chips_note})")
        written.append({"platform": f"{vendor}/{platform}", "path": to_fwd(out),
                        "bytes": len(text), "chips": [_chip_ref(c) for c in group]})
    return written
