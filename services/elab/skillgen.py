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

    raw_path = str(chip.get("_path") or f"chips/{vendor}/{cid}.yaml")
    try:
        src_path = to_fwd(Path(raw_path).relative_to(cfg.root))
    except ValueError:
        src_path = raw_path
    A(f"## 芯片 {part}（数据源：`{src_path}`，适配包 `{chip.get('_pack', '?')}`）")
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


def render_adapt_skill(cfg: Config) -> str:
    """工程适配专用 skill（`elab skill --adapt`）。

    ★ 与平台 skill 的区别：平台 skill 回答"这颗芯片上怎么跑闭环"，
      本 skill 回答"**一个新工程**怎么接进来"——探测、写 projects/*.yaml、
      三绿灯自证、以及每种 status 该做什么。已装适配包只作为数据源列出。
    """
    packs = sorted(cfg.packs.values(), key=lambda r: str(r.get("name") or ""))
    chips = [f"{r.get('name')}（{len(r.get('chips') or [])} 颗芯片）" for r in packs]

    L: list[str] = []
    A = L.append
    A("---")
    A("name: elab-adapt")
    A('description: "把一个已有的嵌入式工程（CubeMX / WorkBench / 手写 CMake）'
      "接入 elab-Flow：确定性探测 → 生成 projects/<name>.yaml → 三绿灯自证。"
      '当需要适配新工程、或 elab adapt 报歧义/漂移/drift 时使用。'
      '触发词：适配、接入工程、elab adapt、projects yaml、T3、drift、hand-edited。"')
    A("agent_created: true")
    A("---")
    A("")
    A("# 工程适配（elab-Flow）")
    A("")
    A("> 本文件由 `elab skill --adapt` 生成，**请勿手改**。")
    A("")
    A("## 0. 一句话")
    A("")
    A("**适配 ≠ 改造**：产出物只有 `projects/<name>.yaml`，业务工程一个字节都不动。")
    A("")
    A("## 1. 标准动作")
    A("")
    A("```bash")
    A("elab adapt <工程目录>            # ① 只探测，打印证据链（不写盘）")
    A("elab adapt <工程目录> --write    # ② 写 projects/<name>.yaml")
    A("elab adapt <工程目录> --check    # ③ 幂等复探测（identical / drift）")
    A("elab adapt <工程目录> --verify   # ④ 三绿灯：doctor --deep + build + guard.untouched")
    A("```")
    A("")
    A("## 2. status 语义（看这一步该做什么）")
    A("")
    A("| status | 含义 | 该做什么 |")
    A("|---|---|---|")
    A("| `written` | 首次写入成功 | 跑 `--verify` |")
    A("| `identical` | 已适配且内容一致（no-op） | 无需动作 |")
    A("| `differs` | 文件已存在但内容不同 | 确认工程确实变了再 `--force`（会留 `.bak`） |")
    A("| `drift` | 复探测结果与落盘文件不一致 | 工程被改过：重新 `--write`（**不会**自动覆盖） |")
    A("| `hand-edited` | 人工接管（`generated-by` 标记被删） | 默认不覆盖；确需机器接管才 `--force` |")
    A("| `missing` | 尚未适配 | 先 `--write` |")
    A("")
    A("## 3. 证据分级（冲突时高级别胜，低级别写进 conflicts）")
    A("")
    A("- **E1 编译事实**：编译宏 / 编译命令（最权威）")
    A("- **E2 生成器结构化元数据**：`at32_chip.json` / `*.ioc`")
    A("- **E3 链接事实**：ld 的 MEMORY、工具链 `-T`")
    A("- **E4 结构约定**：目录名 / 变量名 / 文件名")
    A("- **E5 生成器模板**：`*.ATWP` 等，**可能过期**（实测被证伪过一次）")
    A("- **E6 文件名猜测**")
    A("")
    A("## 4. 不猜：`ambiguities` 是阻断项")
    A("")
    A("探测有未决项时 `--write` 会**拒绝写入**（除非 `--force`）。")
    A("典型未决项：A/B 类互相矛盾的链接变量、多个 ld 候选、匹配不到芯片。")
    A("先解决证据，不要用 `--force` 掩盖。")
    A("")
    A("## 5. 平台形态（两类工程都要挂 inject，但原因不同）")
    A("")
    A("- **A 类**：工具链由 `CMakePresets.json` 的 `toolchainFile` 指定；")
    A("  接管后 preset 不再加载，故必须靠 `CMAKE_PROJECT_INCLUDE` 补齐工程自述约定。")
    A("- **B 类**：`CMakeLists.txt` 行内 `include()` 自带工具链；接管后仍会执行，必须抢回来。")
    A("")
    A("## 6. 当前已安装的适配包（芯片知识来源）")
    A("")
    if chips:
        for c in chips:
            A(f"- {c}")
    else:
        A("- （无）—— 先 `elab pkg bootstrap` 或 `elab pkg install <vendor>/<platform>`，"
          "否则探测不到任何芯片。")
    A("")
    A("## 7. 失败排查")
    A("")
    A("1. **T3**（没有 `CMakeLists.txt`）→ 回图形配置器把工具链切成 CMake 再导出。")
    A("2. **匹配不到芯片** → 装对应适配包；**不要**把厂商分支写进内核。")
    A("3. **drift** → 读 `--check` 的输出差异，确认是工程变了还是适配包芯片参数变了。")
    A("4. **构建后业务工程被改动** → 看 `guard.untouched`；这是适配事故，不是正常状态。")
    A("")
    return "\n".join(L) + "\n"


def generate_adapt(cfg: Config, *, log=print) -> list[dict]:
    """生成适配专用 skill（`skills/elab-adapt` + DSH 发现路径镜像）。"""
    text = render_adapt_skill(cfg)
    written = []
    for rel in (Path("skills") / "elab-adapt", Path(".agents") / "skills" / "elab-adapt"):
        out = cfg.root / rel / "SKILL.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        log(f"[elab] ✓ 生成适配 skill：{to_fwd(out)}  ({len(text)} B)")
        written.append({"skill": "elab-adapt", "path": to_fwd(out), "bytes": len(text)})
    return written


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
        # DSH 发现路径桥（批 3，docs/架构调研 §5）：agent 运行时从
        # `<root>/.agents/skills/<platform>/SKILL.md` 发现 skill（与
        # `.agents/skills/elab-loop` 同一机制），而内核原生输出在
        # `skills/<vendor>/<platform>/` —— 生成物与发现路径曾错位。
        # 只加不改：原路径输出保留，这里双写镜像（§6 风险表"双写过渡"）。
        mirror = cfg.root / ".agents" / "skills" / platform / "SKILL.md"
        mirror.parent.mkdir(parents=True, exist_ok=True)
        mirror.write_text(text, encoding="utf-8")
        chips_note = "、".join(c.get("part", "?") for c in group)
        log(f"[elab] ✓ 生成平台 skill：{to_fwd(out)}  (+镜像 {to_fwd(mirror)})"
            f"  ({len(text)} B，芯片：{chips_note})")
        written.append({"platform": f"{vendor}/{platform}", "path": to_fwd(out),
                        "mirror": to_fwd(mirror),
                        "bytes": len(text), "chips": [_chip_ref(c) for c in group]})
    return written
