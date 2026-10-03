"""elab.skillgen —— 由 chips/*.yaml 生成 per-chip AI skill（L6）。

设计要点
--------
skill 的内容**不手写**，而是从 `chips/<vendor>/<id>.yaml` + `projects/*.yaml`
渲染出来。这样当芯片参数变化时，skill 不会悄悄过期——
「单一数据源」这条原则一直贯彻到 AI 接入层。

生成物：`skills/<vendor>/<id>/SKILL.md`
作用：让 AI 只读这一个文件，就能在这颗芯片上完成
「改代码 → 编译 → 烧录 → 看日志」的闭环，而不必事先懂 elab-Flow 的全部架构。
"""

from __future__ import annotations

from pathlib import Path

from .config import Config, ElabError, Host, to_fwd


def _chip_ref(chip: dict) -> str:
    return f"{chip.get('vendor')}/{chip.get('id')}"


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


def render(cfg: Config, chip: dict, host: Host) -> str:
    cid = chip.get("id", "?")
    vendor = chip.get("vendor", "?")
    part = chip.get("part", cid)
    core = chip.get("core") or {}
    mem = chip.get("memory") or {}
    dbg = chip.get("debug") or {}
    verify = chip.get("verify") or {}
    projects = _projects_of(cfg, chip)
    primary = projects[0] if projects else None
    proj_name = primary.get("name") if primary else "<project>"

    def hexlen(v):
        try:
            return f"0x{int(v):X} ({int(v)} B)"
        except (TypeError, ValueError):
            return str(v)

    flash = mem.get("flash") or {}
    ram = mem.get("ram") or {}
    fpu = core.get("fpu") or "none"
    fpu_note = "★ 无 FPU → 不产出 -mfloat-abi" if fpu in ("", "none") else f"-mfloat-abi={fpu}"

    lad = []
    A = lad.append

    A("---")
    A(f"name: {vendor}_{cid}")
    A(f'description: "{part}（{core.get("cpu", "?")}）在 elab-Flow 下的编译/烧录/调试闭环。'
      f'当需要在 {part} 上改动固件并验证、或遇到构建/烧录/调试问题时使用。'
      f'触发词：{cid}、{part}、{proj_name}、elab build/flash/debug。"')
    A("agent_created: true")
    A("---")
    A("")
    A(f"# {part} 芯片开发闭环（elab-Flow）")
    A("")
    A("> 本文件由 `elab skill` 从 `chips/*.yaml` 自动生成，**请勿手改**——"
      "改芯片参数请改 YAML 后重跑 `elab skill`。")
    A("")
    A("## 0. 你只需要记住一句话")
    A("")
    A("**业务代码不动，工作流用 `elab` 一条命令走完。**")
    A("elab 是「外骨骼」：它挂在既有工程外面负责 configure / build / flash / debug，")
    A("不改工程的任何文件（构建前后会用文件树快照自证零改动）。")
    A("")
    A("## 1. 芯片身份（数据源：`chips/" + f"{vendor}/{cid}.yaml`）")
    A("")
    A("| 项 | 值 |")
    A("|---|---|")
    A(f"| 型号 | `{part}` |")
    A(f"| 内核 | `{core.get('cpu', '?')}` |")
    A(f"| 浮点 | `{fpu}` — {fpu_note} |")
    A(f"| FLASH | {hexlen(flash.get('length'))} @ `{hex(flash.get('origin', 0))}` |")
    A(f"| RAM | {hexlen(ram.get('length'))} @ `{hex(ram.get('origin', 0))}` |")
    A(f"| 链接脚本 | `{chip.get('linker', {}).get('filename', '?')}`（归工程所有） |")
    A(f"| openocd target | `{dbg.get('openocd_target', '?')}` |")
    A(f"| openocd interface | `{dbg.get('openocd_interface', '?')}` |")
    A(f"| SVD | `{dbg.get('svd') or '（未声明）'}` |")
    A("")
    A("## 2. 接入的工程")
    A("")
    if projects:
        A("| 工程 | 形态 | 业务工程目录（elab 只读，不改） |")
        A("|---|---|---|")
        for p in projects:
            A(f"| `{p.get('name')}` | {p.get('archetype', '?')} 类 | `{to_fwd(p.get('root', ''))}` |")
    else:
        A("（暂无工程引用本芯片）")
    A("")
    A("## 3. 闭环命令")
    A("")
    A("```bash")
    A(f"elab loop  -p {proj_name}            # ★ 一键闭环：doctor→build→flash→debug")
    A(f"elab doctor -p {proj_name} --deep     # 体检 + 校验实际编译参数未漂移")
    A(f"elab build  -p {proj_name} --clean    # 编译，产出 elf/hex/bin 到 .work/")
    A(f"elab flash  -p {proj_name}            # openocd 烧录 + verify")
    A(f"elab debug  -p {proj_name} --verify    # 断到 main 自检（非交互）")
    A(f"elab debug  -p {proj_name} --run       # 交互式 gdb 调试")
    A("```")
    A("")
    A("加 `--json` 可拿到机器可读输出。**产物一律落在 `elab-flow/.work/<project>/`**，"
      "不会污染业务工程目录。")
    A("")

    pitfalls = chip.get("pitfalls") or []
    if pitfalls:
        A("## 4. 坑位（先读这一节，能省掉大部分调试时间）")
        A("")
        for i, p in enumerate(pitfalls, 1):
            A(f"{i}. {p}")
        A("")

    A("## 5. 验收清单（改完代码后逐条核对）")
    A("")
    A(f"- [ ] `elab doctor -p {proj_name}` 全绿（含漂移校验）")
    if verify:
        A(f"- [ ] `elab build -p {proj_name}` 通过，且内存占用与 chip.yaml 一致"
          f"（期望 FLASH {hexlen((verify.get('expect_memory') or {}).get('flash'))}、"
          f"RAM {hexlen((verify.get('expect_memory') or {}).get('ram'))}）")
    else:
        A(f"- [ ] `elab build -p {proj_name}` 通过，elf/hex/bin 均产出")
    A("- [ ] `guard.untouched == true`（业务工程零改动）")
    A(f"- [ ] `elab debug -p {proj_name} --verify` 断到 `main`")
    A("")
    A("## 6. 出问题时的定位顺序")
    A("")
    A("1. `elab doctor` 先跑一遍——它会把「主机路径不可达」「两源漂移」直接指出来。")
    A("2. 编译参数怪 → `elab doctor --deep`（它会真跑 configure，")
    A("   从 `compile_commands.json` 取**实际编译命令**作证据）。")
    A("3. 产物名不对/找不到 elf → 检查通用工具链的 `.elf` 后缀约定（约束 C5）。")
    A("4. 烧录失败 → `elab flash -p … --dry-run` 看 openocd 命令行，")
    A("   再确认探针已插好、`elab.host.yaml` 的 openocd 路径正确。")
    A("")
    return "\n".join(lad) + "\n"


def generate(cfg: Config, *, project: str | None = None, chip_ref: str | None = None,
             all_chips: bool = False, log=print) -> list[dict]:
    host = Host(cfg)
    targets: list[dict] = []
    if project:
        proj = cfg.resolved_project(project)
        targets.append(cfg.chip_of(proj))
    elif chip_ref:
        if chip_ref not in cfg.chips:
            raise ElabError(f"未知芯片：{chip_ref}")
        targets.append(cfg.chips[chip_ref])
    elif all_chips:
        targets = _uniq_chips(cfg)
    else:
        raise ElabError("请指定 -p <项目> 或 --chip <vendor/id> 或 --all")

    written = []
    for chip in targets:
        vendor = chip.get("vendor", "unknown")
        cid = chip.get("id", "unknown")
        out = cfg.root / "skills" / vendor / cid / "SKILL.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        text = render(cfg, chip, host)
        out.write_text(text, encoding="utf-8")
        written.append({"chip": _chip_ref(chip), "path": to_fwd(out), "bytes": len(text)})
        log(f"[elab] ✓ 生成 skill：{to_fwd(out)}  ({len(text)} B)")
    return written
