"""elab.adapt —— 图形配置器导出工程的「一键适配」（确定性探测器）。

背景 / 设计约束（详见 docs/技术方案_闭环驾驶舱.md §19）
-----------------------------------------------------
- **适配 ≠ 改造**：产出物只有 `projects/<name>.yaml`，业务工程**一个字节都不动**。
  验收 oracle 就是既有的 ``guard.untouched`` 文件树快照 —— "我没改你代码"是可断言的。
- **证据分级 E1–E6**：冲突时高级别胜，低级别异议写进 ``conflicts[]``，
  **绝不静默采信低级别证据**（`template.ATWP` 已被实测证伪过一次：它写 C8T7，
  而编译宏是 G8U7）。
- **确定性**：探测与渲染都是纯函数，不含时间戳、不依赖 LLM ——
  便于 ``--check`` 幂等比对与 CI 守卫。
- **不猜**：证据不足记入 ``ambiguities[]``，交给人 / agent 裁决，而不是编一个值。

用法
----
    elab adapt <path>            # 探测并打印结论（不写文件）
    elab adapt <path> --write    # 生成 projects/<name>.yaml
    elab adapt <path> --check    # 幂等校验（已适配且一致 → no-op）
    elab adapt <path> --verify   # 三绿灯：doctor --deep + build + guard.untouched
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .config import Config, ElabError, to_fwd
from .doctor import parse_ld_memory

# ── 证据级别（rank 越小越权威）────────────────────────────────────
E1_COMPILE = "E1"    # 编译事实：要送进编译器的宏 / 编译命令
E2_META = "E2"       # 生成器结构化元数据：at32_chip.json / *.ioc
E3_LINK = "E3"       # 链接事实：ld 的 MEMORY、工具链的 -T
E4_STRUCT = "E4"     # 结构约定：目录名 / 变量名 / 文件名 —— 判厂商最可靠
E5_TEMPLATE = "E5"   # 生成器模板文件：*.ATWP 等，**可能过期**
E6_NAME = "E6"       # 文件名猜测

_LEVEL_RANK = {E1_COMPILE: 1, E2_META: 2, E3_LINK: 3, E4_STRUCT: 4, E5_TEMPLATE: 5, E6_NAME: 6}
_LEVEL_DESC = {
    E1_COMPILE: "编译事实",
    E2_META: "生成器结构化元数据",
    E3_LINK: "链接事实",
    E4_STRUCT: "结构约定",
    E5_TEMPLATE: "生成器模板文件（可能过期）",
    E6_NAME: "文件名猜测",
}

# 厂商生成器目录 → vendor
VENDOR_BY_GEN_DIR = {"at32_workbench": "artery", "stm32cubemx": "st"}
# 生成器 define 变量名（第二指纹）
SYMS_VAR_BY_GEN = {"at32_workbench": "WK_Defines_Syms", "stm32cubemx": "MX_Defines_Syms"}

_STD_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]


@dataclass
class Fact:
    """一条带出处的结论。"""

    key: str
    value: str
    level: str
    evidence: str


@dataclass
class Probe:
    """探测结果（纯数据，可 JSON 化）。"""

    root: str
    dirname: str = ""
    vendor: str = ""
    generator: str = ""
    archetype: str = ""
    project_name: str = ""
    chip_macro: str = ""
    defines: list[str] = field(default_factory=list)
    chip_ref: str = ""
    chip_evidence: str = ""
    linker_script: str = ""
    linker_variable: str = ""
    toolchain_cmake: str = ""
    cpu: str = ""
    fpu: str = ""
    float_abi: str = ""
    memory: dict = field(default_factory=dict)
    baud_raw: int = 0
    baud: int = 0
    usart: str = ""
    tx_pin: str = ""
    rx_pin: str = ""
    uses_freertos: bool = False
    can_print: bool = False        # 固件是否真有串口输出能力（有 __io_putchar 定义 + printf 调用）
    tier: str = "T1"
    facts: list[Fact] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    ambiguities: list[str] = field(default_factory=list)   # 阻断项：不猜，须人工/agent 裁决
    notes: list[str] = field(default_factory=list)         # 提示项：已解决/仅供参考，不阻断

    @property
    def confidence(self) -> str:
        if self.ambiguities:
            return "low"
        if self.conflicts:
            return "medium"
        return "high"

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        d["facts"] = [{"key": f.key, "value": f.value, "level": f.level, "evidence": f.evidence}
                      for f in self.facts]
        d["confidence"] = self.confidence
        return d


# ── 小工具 ────────────────────────────────────────────────────────
def _read(p) -> str:
    try:
        return Path(p).read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _rel(root: Path, p) -> str:
    try:
        return to_fwd(Path(p).relative_to(root))
    except ValueError:
        return to_fwd(p)


def _nearest_baud(n: int) -> int:
    return min(_STD_BAUDS, key=lambda b: abs(b - n)) if n else 0


# ── 探测：厂商 / 生成器（E4 + E5）───────────────────────────────────
def _detect_vendor(root: Path, cmake_text: str, gen_dirs: list[str],
                   atwp: list[Path], ioc: list[Path]) -> tuple[str, str, str, list[str]]:
    """返回 (vendor, generator, evidence, extra_notes)。"""
    hits: dict[str, list[tuple[str, str]]] = {"artery": [], "st": []}

    for d, v in VENDOR_BY_GEN_DIR.items():
        if re.search(rf"add_subdirectory\(\s*(?:cmake/)?{re.escape(d)}\b", cmake_text):
            hits[v].append((E4_STRUCT, f"CMakeLists.txt: add_subdirectory(cmake/{d})"))

    for d in gen_dirs:
        p = root / "cmake" / d / "CMakeLists.txt"
        t = _read(p)
        var = SYMS_VAR_BY_GEN.get(d)
        if var and var in t:
            hits[VENDOR_BY_GEN_DIR[d]].append(
                (E4_STRUCT, f"cmake/{d}/CMakeLists.txt: {var}"))

    if atwp:
        hits["artery"].append((E5_TEMPLATE, f"{_rel(root, atwp[0])}: 存在 *.ATWP 工程文件"))
    if ioc:
        hits["st"].append((E5_TEMPLATE, f"{_rel(root, ioc[0])}: 存在 *.ioc 工程文件"))

    a, s = hits["artery"], hits["st"]
    notes: list[str] = []
    if a and s:
        notes.append("同时发现 artery 与 st 的生成器特征 —— 请人工确认厂商")
        return "", "", "", notes
    if not a and not s:
        return "", "", "", ["未发现任何已知生成器特征（既非 AT32 WorkBench 也非 STM32CubeMX）"]

    pick = a or s
    vendor = "artery" if a else "st"
    # 生成器目录名
    gen = ""
    for d, v in VENDOR_BY_GEN_DIR.items():
        if v == vendor and d in gen_dirs:
            gen = d
    if not gen:
        gen = "at32_workbench" if vendor == "artery" else "stm32cubemx"
    # 取最高级别证据作代表
    best = sorted(pick, key=lambda x: _LEVEL_RANK[x[0]])[0]
    return vendor, gen, best[1], notes


# ── 探测：archetype（E4；第二指纹见 linker_variable）─────────────────
def _detect_archetype(root: Path, cmake_text: str) -> tuple[str, str, list[str]]:
    """A / B。B = CMakeLists 行内 include 自带工具链（接管后仍会执行 → 必须抢回来）。"""
    notes: list[str] = []
    for m in re.finditer(r'^\s*include\(\s*"([^"]+\.cmake)"\s*\)', cmake_text, re.M):
        rel = m.group(1)
        p = root / rel
        if not p.exists():
            notes.append(f"CMakeLists.txt 行内 include(\"{rel}\") 指向的文件不存在")
            continue
        t = _read(p)
        if "CMAKE_C_COMPILER" in t or "-mcpu" in t:
            return "B", f'CMakeLists.txt: include("{rel}")（行内挂自带工具链，接管后仍会执行）', notes

    presets = root / "CMakePresets.json"
    if presets.exists() and re.search(r'"toolchainFile"\s*:', _read(presets)):
        return "A", "CMakePresets.json: toolchainFile（命令行级，接管后不再加载）", notes
    return "", "", notes + ["既未发现行内 include 工具链，也无 preset toolchainFile：无法判定 A/B"]


# ── 探测：工具链文件 ──────────────────────────────────────────────
def _detect_toolchain(root: Path, presets_text: str, cmake_text: str,
                      ) -> tuple[str, str, list[str], list[str]]:
    """返回 (相对路径, evidence, ambiguities, notes)。优先 preset → 行内 include → glob。"""
    amb: list[str] = []
    notes: list[str] = []

    from_preset = ""
    m = re.search(r'"toolchainFile"\s*:\s*"([^"]+)"', presets_text)
    if m:
        v = m.group(1).replace("${sourceDir}", "")
        from_preset = v.lstrip("/\\")

    from_inline = ""
    m = re.search(r'^\s*include\(\s*"([^"]+\.cmake)"\s*\)', cmake_text, re.M)
    if m:
        from_inline = m.group(1)

    found: list[str] = []
    cmake_dir = root / "cmake"
    if cmake_dir.is_dir():
        for p in sorted(cmake_dir.glob("*.cmake")):
            if "CMAKE_C_COMPILER" in _read(p):
                found.append(f"cmake/{p.name}")

    chosen = from_preset or from_inline or (found[0] if found else "")
    if chosen and not (root / chosen).exists():
        amb.append(f"工具链文件 {chosen} 不存在")
        chosen = ""

    others = [f for f in found if f != chosen]
    if others:
        if from_preset or from_inline:
            # 已有权威指定者（preset / 行内 include）→ 其它候选只是提示，不阻断写入
            decided = "CMakePresets.json" if from_preset else "CMakeLists.txt 行内 include"
            notes.append(
                f"cmake/ 下另有候选工具链 {others}，已按 {decided} 指定的 "
                f"{chosen or '无'} 为准（其余不参与）")
        else:
            amb.append(f"cmake/ 下存在多个候选工具链 {found}，无法确定用哪个")

    ev = ""
    if from_preset:
        ev = f"CMakePresets.json: toolchainFile = {from_preset}"
    elif from_inline:
        ev = f'CMakeLists.txt: include("{from_inline}")'
    elif chosen:
        ev = f"cmake/ 目录扫描（唯一含 CMAKE_C_COMPILER 的文件）：{chosen}"
    return chosen, ev, amb, notes


# ── 探测：链接脚本 + 链接变量（E3 / E4）────────────────────────────
def _detect_linker(root: Path, tc_text: str) -> tuple[str, str, str, list[str]]:
    """返回 (ld 相对路径, 链接变量名, evidence, ambiguities)。"""
    cands: list[str] = []
    for m in re.finditer(r"-T\s*\\?\"?[^\"\s]*?([A-Za-z0-9_.\-]+\.ld)", tc_text):
        if m.group(1) not in cands:
            cands.append(m.group(1))

    link_var = ""
    if re.search(r"set\(\s*CMAKE_C_LINK_FLAGS\b", tc_text):
        link_var = "CMAKE_C_LINK_FLAGS"
    elif re.search(r"set\(\s*CMAKE_EXE_LINKER_FLAGS\b", tc_text):
        link_var = "CMAKE_EXE_LINKER_FLAGS"

    amb: list[str] = []
    existing = [c for c in cands if (root / c).exists()]
    if not existing:
        return "", link_var, "", ["未能从工具链文件中解析出链接脚本（-T ），或文件不在工程根目录"]
    if len(existing) > 1:
        amb.append(f"工具链文件里出现多个链接脚本候选 {existing} —— 请人工指定")
    return existing[0], link_var, f"工具链文件: -T {existing[0]}", amb


# ── 探测：编译 flags（E1）──────────────────────────────────────────
def _detect_flags(tc_text: str) -> tuple[str, str, str, str]:
    """返回 (cpu, fpu, float_abi, raw)。"""
    raw = ""
    m = re.search(r'TARGET_FLAGS\s+"([^"]*)"', tc_text)
    if m:
        raw = m.group(1)
    else:
        m = re.search(r'set\(\s*CMAKE_C_FLAGS\s+"([^"]*)"', tc_text)
        if m:
            raw = m.group(1)

    def grab(pat):
        mm = re.search(pat, raw)
        return mm.group(1) if mm else ""

    cpu = grab(r"-mcpu=([A-Za-z0-9\-]+)")
    fpu = grab(r"-mfpu=([A-Za-z0-9\-]+)")
    abi = grab(r"-mfloat-abi=([a-z]+)")
    return cpu, fpu, abi, raw


# ── 探测：芯片宏（E1）────────────────────────────────────────────
def _detect_defines(root: Path, generator: str) -> tuple[list[str], str, str]:
    """返回 (defines, 主要型号宏, evidence)。"""
    var = SYMS_VAR_BY_GEN.get(generator, "")
    p = root / "cmake" / generator / "CMakeLists.txt"
    t = _read(p)
    if not var or var not in t:
        return [], "", ""
    m = re.search(rf"set\(\s*{var}\b(.*?)\n\s*\)", t, re.S)
    if not m:
        return [], "", ""
    body = m.group(1)
    defines: list[str] = []
    for line in body.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("$<"):   # 跳过生成器表达式
            continue
        defines.append(s)
    # 主要型号宏：去掉通用宏
    generic = {"USE_STDPERIPH_DRIVER", "USE_HAL_DRIVER", "DEBUG", "NDEBUG"}
    macro = ""
    for d in defines:
        if d not in generic:
            macro = d
            break
    return defines, macro, f"{_rel(root, p)}: {var} → {', '.join(defines)}"


# ── 探测：工程名（E1）─────────────────────────────────────────────
def _detect_project_name(cmake_text: str) -> tuple[str, str]:
    m = re.search(r"set\(\s*CMAKE_PROJECT_NAME\s+([^\s\)]+)\s*\)", cmake_text)
    if m:
        return m.group(1), f"CMakeLists.txt: set(CMAKE_PROJECT_NAME {m.group(1)})"
    m = re.search(r"^\s*project\(\s*([^\s\)]+)", cmake_text, re.M)
    if m:
        return m.group(1), f"CMakeLists.txt: project({m.group(1)})"
    return "", ""


# ── 探测：FreeRTOS（E4，信息性）────────────────────────────────────
def _detect_freertos(root: Path, gen_dirs: list[str]) -> tuple[bool, str]:
    """工程是否把 FreeRTOS 编成 OBJECT 库。

    仅作记录（当前无消费者）：把「实测事实」落进 YAML 以保持与手写接入文件
    逐字段一致，从而让 ``--check`` 能对既有工程报 no-op 而非 drift。
    """
    for d in gen_dirs:
        p = root / "cmake" / d / "CMakeLists.txt"
        t = _read(p)
        m = re.search(r"add_library\(\s*FreeRTOS\b([^\)]*)\)", t)
        if m:
            return True, f"{_rel(root, p)}: add_library(FreeRTOS{m.group(1).rstrip()})"
    return False, ""


# ── 探测：固件是否有串口输出能力（E4）─────────────────────────────
def _detect_stdout(root: Path) -> tuple[bool, str]:
    """工程源码里是否**既有** ``__io_putchar`` 的定义、**又有** ``printf`` 调用。

    ★ 必须区分「声明」与「定义」：``syscalls.c`` 里那句
      ``extern int __io_putchar(int ch) __attribute__((weak));`` 只是声明 ——
      有它 **并不代表** printf 能跑。实测 AT32F421G8U7 初版正是如此：
      ``_write()`` 会调到弱符号解析出的地址 0（= 跳飞）。所以这里找的是
      ``int __io_putchar(...) {`` 这种**带函数体的定义**。

    判不出来时返回 False —— 于是 render() 只给注释模板，不假装闭环能成。
    """
    cands: list[Path] = []
    for d in (root / "project" / "src", root / "Core" / "Src", root / "src"):
        if d.is_dir():
            cands += sorted(d.glob("*.c"))
    if not cands:
        skip = {"libraries", "Drivers", "Middlewares", "build", ".work"}
        cands = [p for p in sorted(root.rglob("*.c"))
                 if not (skip & set(p.parts))]

    def_ev = use_ev = ""
    for p in cands:
        t = _read(p)
        if not def_ev and re.search(
                r"^\s*int\s+__io_putchar\s*\([^)]*\)\s*\{", t, re.M):
            def_ev = f"{_rel(root, p)}: 定义了 __io_putchar（带函数体）"
        if not use_ev and re.search(r"\bprintf\s*\(", t):
            use_ev = f"{_rel(root, p)}: 调用了 printf"
        if def_ev and use_ev:
            break
    if def_ev and use_ev:
        return True, f"{def_ev}；{use_ev}"
    return False, ""


# ── 探测：生成器模板里的芯片（E5）与被证伪时的冲突 ────────────────
def _check_template(root: Path, atwp: list[Path], ioc: list[Path],
                    macro: str) -> tuple[str, int, str, str, str, list[str]]:
    """返回 (模板声明型号, baud_raw, usart, tx, rx, conflicts)。"""
    conflicts: list[str] = []
    declared, baud_raw, usart, tx, rx = "", 0, "", "", ""

    if atwp:
        t = _read(atwp[0])
        rel = _rel(root, atwp[0])
        m = re.search(r"<MCUName>([^<]+)</MCUName>", t)
        if m:
            declared = m.group(1)
            if macro and declared != macro:
                conflicts.append(
                    f"{rel} 声明 {declared}，与编译宏 {macro} 不符"
                    f"（{E5_TEMPLATE} < {E1_COMPILE}）—— 已按编译宏为准忽略")
        m = re.search(r'name="RealBaudRate"\s+value="(\d+)"', t)
        if m:
            baud_raw = int(m.group(1))
        m = re.search(r"<([A-Z]+[0-9]*I*U*SART[0-9]*)>", t)
        if m:
            usart = m.group(1)
        for pin in re.finditer(
                r'pinname="([A-Z]+\d+)"\s+signalname="([A-Z0-9_]+)"', t):
            sig = pin.group(2)
            if sig.endswith("_TX"):
                tx = pin.group(1)
            elif sig.endswith("_RX"):
                rx = pin.group(1)

    if ioc:
        t = _read(ioc[0])
        rel = _rel(root, ioc[0])
        m = re.search(r"^Mcu\.CPN=(.+)$", t, re.M)
        if m:
            declared = m.group(1).strip()
            # ★ 注意：CPN 是具体封装型号（如 STM32F103C8T6），宏是族级（STM32F103xB），
            #   两者本就不该相等 —— 只有「家族」不符才算冲突，不能拿 CPN 直接比宏。
            fam = re.search(r"^Mcu\.Family=(.+)$", t, re.M)
            if fam and macro and not macro.lower().startswith(fam.group(1).strip().lower()):
                conflicts.append(
                    f"{rel} 家族 {fam.group(1).strip()} 与编译宏 {macro} 不符"
                    f"（{E5_TEMPLATE} < {E1_COMPILE}）—— 已按编译宏为准忽略")
    return declared, baud_raw, usart, tx, rx, conflicts


# ── 探测：芯片匹配到 chips/*.yaml（E1）────────────────────────────
def _match_chip(cfg: Config, macro: str, defines: list[str]) -> tuple[str, str, str]:
    """返回 (chip_ref, evidence, ambiguity)。"""
    if not macro:
        return "", "", "未能解析出型号编译宏 —— 无法匹配芯片"

    for ref, chip in cfg.chips.items():
        if "/" not in ref:
            continue
        if (chip.get("part") or "") == macro:
            return ref, f"编译宏 {macro} == chips/{ref}.yaml:part", ""
    for ref, chip in cfg.chips.items():
        if "/" not in ref:
            continue
        if macro in (chip.get("compiler_defines") or []):
            return ref, f"编译宏 {macro} ∈ chips/{ref}.yaml:compiler_defines", ""

    for ref, chip in cfg.chips.items():
        if "/" not in ref:
            continue
        part = chip.get("part") or ""
        if part and (part.startswith(macro) or macro.startswith(part)):
            return ref, f"前缀相近：{part} ≈ {macro}", \
                f"芯片为前缀近似匹配（{part} ≈ {macro}），请人工确认"
    return "", "", f"chips/ 下没有与编译宏 {macro} 匹配的芯片 —— 需先纳新芯片"


# ── 主探测 ────────────────────────────────────────────────────────
def probe_project(cfg: Config, path) -> Probe:
    root = Path(path).resolve()
    if not root.is_dir():
        raise ElabError(f"目录不存在：{root}")

    p = Probe(root=to_fwd(root), dirname=root.name)
    entry = root / "CMakeLists.txt"
    if not entry.exists():
        p.tier = "T3"
        p.ambiguities.append(
            "工程根目录没有 CMakeLists.txt —— 属于 T3（需真改造）。"
            "请在 AT32 WorkBench / STM32CubeMX 里把工具链切换到 CMake 后重新导出。")
        return p

    cmake_text = _read(entry)
    presets_text = _read(root / "CMakePresets.json")
    atwp = sorted(root.glob("*.ATWP"))
    ioc = sorted(root.glob("*.ioc"))
    gen_dirs = [d for d in VENDOR_BY_GEN_DIR
                if (root / "cmake" / d / "CMakeLists.txt").exists()]

    # ① 厂商 / 生成器
    vendor, generator, v_ev, v_notes = _detect_vendor(root, cmake_text, gen_dirs, atwp, ioc)
    p.vendor, p.generator = vendor, generator
    if v_ev:
        p.facts.append(Fact("vendor", f"{vendor}（{generator}）", E4_STRUCT, v_ev))
    p.ambiguities += v_notes

    # ② archetype
    arch, arch_ev, arch_notes = _detect_archetype(root, cmake_text)
    p.archetype = arch
    if arch_ev:
        p.facts.append(Fact("archetype", arch, E4_STRUCT, arch_ev))
    p.ambiguities += arch_notes

    # ③ 工程名
    pname, pn_ev = _detect_project_name(cmake_text)
    p.project_name = pname
    if pn_ev:
        p.facts.append(Fact("project_name", pname, E1_COMPILE, pn_ev))
    else:
        p.ambiguities.append("未能解析工程名（CMAKE_PROJECT_NAME / project()）—— 产物名将不确定")

    # ④ 工具链文件
    tc, tc_ev, tc_amb, tc_notes = _detect_toolchain(root, presets_text, cmake_text)
    p.toolchain_cmake = tc
    p.ambiguities += tc_amb
    p.notes += tc_notes
    tc_text = _read(root / tc) if tc else ""
    if tc_ev:
        p.facts.append(Fact("toolchain_cmake", tc, E4_STRUCT, tc_ev))

    # ⑤ 链接脚本
    ld, link_var, ld_ev, ld_notes = _detect_linker(root, tc_text)
    p.linker_script, p.linker_variable = ld, link_var
    if ld_ev:
        p.facts.append(Fact("linker_script", ld, E3_LINK, ld_ev))
    p.ambiguities += ld_notes

    # ★ archetype 第二指纹：链接变量名（连到约束 C1）
    #   与 E5 那条不同 —— 这不是「分级已裁决」，而是「两个同级证据互相矛盾」：
    #   archetype 判错会让注入策略失效、直接构建失败，故升格为未决项，不静默采信。
    if arch and link_var:
        want = "CMAKE_C_LINK_FLAGS" if arch == "B" else "CMAKE_EXE_LINKER_FLAGS"
        if link_var != want:
            p.ambiguities.append(
                f"archetype 判为 {arch} 类（依据 CMakeLists 是否行内 include 工具链），"
                f"但工具链用的链接变量是 {link_var}，而 {arch} 类预期 {want} —— "
                f"两个同级证据互相矛盾，请人工确认 archetype")

    # ⑥ 编译 flags
    cpu, fpu, abi, raw = _detect_flags(tc_text)
    p.cpu, p.fpu, p.float_abi = cpu, fpu, abi
    if raw:
        p.facts.append(Fact("compile_flags", raw.strip(), E1_COMPILE, f"工具链文件: TARGET_FLAGS"))

    # ⑦ 芯片宏
    defines, macro, d_ev = _detect_defines(root, generator)
    p.defines, p.chip_macro = defines, macro
    if d_ev:
        p.facts.append(Fact("chip_macro", macro, E1_COMPILE, d_ev))

    # ⑧ 芯片匹配
    ref, c_ev, c_amb = _match_chip(cfg, macro, defines)
    p.chip_ref, p.chip_evidence = ref, c_ev
    if c_ev:
        p.facts.append(Fact("chip", ref, E1_COMPILE, c_ev))
    if c_amb:
        p.ambiguities.append(c_amb)

    # ⑨ 内存布局（E3）
    if ld:
        mem = parse_ld_memory(root / ld)
        p.memory = {k: {"origin": v[0], "length": v[1]} for k, v in mem.items()}
        if mem:
            p.facts.append(Fact("memory",
                                " ".join(f"{k}={hex(v[1])}" for k, v in mem.items()),
                                E3_LINK, f"{ld} MEMORY 段"))

    # ⑩ 生成器模板（E5）+ 冲突
    declared, baud_raw, usart, tx, rx, conflicts = _check_template(
        root, atwp, ioc, macro)
    p.baud_raw, p.usart, p.tx_pin, p.rx_pin = baud_raw, usart, tx, rx
    p.conflicts += conflicts
    if baud_raw:
        p.baud = _nearest_baud(baud_raw)
        p.facts.append(Fact("baud", f"{p.baud}（模板实测 {baud_raw}）", E5_TEMPLATE,
                            f"{_rel(root, atwp[0] if atwp else ioc[0])}: RealBaudRate={baud_raw}"))

    # ⑪ 内存 vs chip.yaml 一致性（提前暴露漂移）
    if ref and p.memory:
        exp = ((cfg.chips.get(ref) or {}).get("verify") or {}).get("expect_memory") or {}
        for k, v in exp.items():
            got = (p.memory.get(k.upper()) or {}).get("length")
            if got is not None and got != v:
                p.conflicts.append(
                    f"{k} 内存不一致：工程 ld={hex(got)} ≠ chips/{ref}.yaml={hex(v)}"
                    f"（{E3_LINK} 为准的是 ld，请同步 chip.yaml）")

    # ⑫ FreeRTOS（E4，信息性）
    frt, frt_ev = _detect_freertos(root, gen_dirs)
    p.uses_freertos = frt
    if frt_ev:
        p.facts.append(Fact("uses_freertos", "true", E4_STRUCT, frt_ev))

    # ⑬ 串口输出能力（E4）—— 决定要不要生成真实的 monitor 判据
    p.can_print, so_ev = _detect_stdout(root)
    if so_ev:
        p.facts.append(Fact("stdout", "有输出能力", E4_STRUCT, so_ev))

    return p


# ── 渲染 projects/*.yaml ──────────────────────────────────────────
def default_name(p: Probe) -> str:
    n = re.sub(r"[^A-Za-z0-9_]+", "_", p.dirname).strip("_").lower()
    return n or "project"


def _root_expr(cfg: Config, p: Probe) -> str:
    rp = Path(p.root)
    try:
        rel = rp.relative_to(cfg.root)
        return f"${{ELAB_ROOT}}/{to_fwd(rel)}"
    except ValueError:
        return to_fwd(rp)


def render(cfg: Config, p: Probe, name: str) -> str:
    proj_name = p.project_name or name
    pn = proj_name
    L: list[str] = []
    A = L.append

    A(f"# projects/{name}.yaml —— 由 `elab adapt` 确定性生成，请勿手改")
    A("# generated-by: elab adapt   ← 机器生成标记；删掉此行即视为人工接管，elab 将不再覆盖")
    A("#")
    A("# 生成依据见文末 provenance 段（逐条记「结论 ← 哪个文件的什么内容」）。")
    A("# 本文件不含时间戳：同一工程重复生成必得同样内容，便于 --check 与 CI 守卫比对。")
    A("# 要改芯片参数请改 chips/*.yaml；要改工程请改工程本身，本文件只管「怎么接进来」。")
    A("")
    A(f"name: {name}")
    A(f"root: {_root_expr(cfg, p)}")
    A(f"chip: {p.chip_ref or 'TODO/待确认'}")
    A(f"archetype: {p.archetype or '?'}")
    A("")
    A("build:")
    A("  kind: cmake")
    A("  source: ${root}/CMakeLists.txt")
    A(f"  work_dir: ${{ELAB_ROOT}}/.work/{name}")
    A("  generator: Ninja")
    A("  toolchain_file:  ${ELAB_ROOT}/toolchains/gcc.cmake")
    A("  project_include: ${ELAB_ROOT}/toolchains/inject.cmake")
    A(f"  linker_script:   ${{root}}/{p.linker_script or '<TODO>.ld'}")
    A("  build_type: Debug")
    A(f"  project_name: {pn}")
    if p.uses_freertos:
        A("  uses_freertos: true            # 信息性：工程把 FreeRTOS 编成 OBJECT 库")
    A("")
    A("artifacts:")
    A(f"  elf: ${{work_dir}}/{pn}.elf")
    A(f"  hex: ${{work_dir}}/{pn}.hex")
    A(f"  bin: ${{work_dir}}/{pn}.bin")
    A(f"  map: ${{work_dir}}/{pn}.map")
    A("")
    A("debug:")
    A("  probe: atlink")
    A("  gdb_script: ${ELAB_ROOT}/toolchains/gdb/break_main.gdb")
    A("")
    A("guard:")
    A("  untouched: true")
    A("  snapshot: true")
    A("  snapshot_root: ${root}")
    A("")
    A("# ── 串口闭环判据（docs/技术方案_闭环驾驶舱.md §16）───────────────")
    A("serial:")
    if p.baud:
        A(f"  baud: {p.baud}          # 来源：生成器模板 RealBaudRate（见 provenance.baud）")
    A("  port: auto        # 自动选口：会跳过蓝牙虚拟口（本机 COM3-8 均为 BthModem）")
    A("")
    if p.can_print:
        A("# 固件探测到输出能力（见 provenance.stdout），故给出**真实判据** —— 闭环可被机器判定：")
        A("#   close_on 命中任意一条 → ok；fail_on 优先于 close_on；都没中且超时 → inconclusive。")
        A("#   pattern 逐行匹配，命中行会原文带进事件作证据。")
        A("# ★ ^\\[(boot|alive)\\] 是 elab 约定的「存活关键字」；固件换关键字请同步改这里。")
        A("monitor:")
        A("  close_on:")
        A('    - { kind: regex, pattern: "^\\\\[(boot|alive)\\\\]", within_s: 10 }')
        A("  fail_on:")
        A('    - { kind: regex, pattern: "HardFault|Hard Fault|assert|PANIC" }')
        A("  idle_timeout_s: 30")
    else:
        A("# ★ 未生成 monitor.close_on —— 探测**没有**在工程源码里同时找到「__io_putchar 的定义」")
        A("#   与「printf 调用」，固件大概率无输出，判据必然不命中。")
        A("#   要启用闭环需在工程里补两处（属「业务代码」，建议写进 WorkBench 的 user code")
        A("#   区块，重新生成代码不会丢）：")
        A("#     ① 定义 __io_putchar —— 注意 syscalls.c 只做了 weak 声明、**没有定义**；")
        A("#        只有声明时 printf 的 _write() 会调到地址 0（跳飞）。")
        A("#     ② 在 main.c 的 user code 区块里打印关键字。")
        A("#   在此之前，monitor 步骤判为 inconclusive（不是 failed）—— 见 §16.1。")
        A("#")
        A("# monitor:")
        A("#   close_on:")
        A('#     - { kind: regex, pattern: "^\\\\[(boot|alive)\\\\]", within_s: 10 }')
        A("#   fail_on:")
        A('#     - { kind: regex, pattern: "HardFault|Hard Fault|assert|PANIC" }')
        A("#   idle_timeout_s: 30")
    A("")
    A("# ── 证据链 ───────────────────────────────────────────────────────")
    A("provenance:")
    for f in p.facts:
        A(f"  {f.key}:")
        A(f"    value: \"{f.value}\"")
        A(f"    level: {f.level}          # {_LEVEL_DESC.get(f.level, '')}")
        A(f"    evidence: \"{f.evidence}\"")
    A(f"  confidence: \"{p.confidence}\"")
    if p.conflicts:
        A("  conflicts:")
        for c in p.conflicts:
            A(f"    - \"{c}\"")
    if p.ambiguities:
        A("  ambiguities:")
        for a in p.ambiguities:
            A(f"    - \"{a}\"")
    if p.notes:
        A("  notes:")
        for n in p.notes:
            A(f"    - \"{n}\"")
    if p.tx_pin or p.rx_pin:
        A("  serial_pins: \"%s TX=%s RX=%s\"" % (p.usart or "?", p.tx_pin or "?", p.rx_pin or "?"))
    return "\n".join(L) + "\n"


# ── 写盘 / 幂等 ───────────────────────────────────────────────────
def write(cfg: Config, p: Probe, *, name: str = "", force: bool = False,
          check: bool = False, log=print) -> dict:
    name = name or default_name(p)
    out = cfg.root / "projects" / f"{name}.yaml"
    text = render(cfg, p, name)

    if p.tier == "T3":
        raise ElabError("该工程没有 CMakeLists.txt，无法适配（T3）。"
                        "请在图形配置器里把工具链切成 CMake 后重新导出。")
    if p.ambiguities and not force:
        raise ElabError(
            "探测存在未决项，拒绝写入（用 --force 强制写入，或先解决问题）：\n  - "
            + "\n  - ".join(p.ambiguities))
    if not p.chip_ref and not force:
        raise ElabError("未能匹配到 chips/*.yaml 中的芯片，拒绝写入（--force 可强制）")

    result = {"name": name, "path": to_fwd(out), "written": False,
              "check": check, "existed": out.exists()}

    if check:
        if not out.exists():
            result["status"] = "missing"
            log(f"[adapt] ✗ {to_fwd(out)} 不存在 —— 尚未适配")
            return result
        cur = out.read_text(encoding="utf-8")
        if cur == text:
            result["status"] = "identical"
            log(f"[adapt] ✓ 已适配且内容一致（no-op）：{to_fwd(out)}")
        else:
            result["status"] = "drift"
            log(f"[adapt] ⚠ {to_fwd(out)} 与重新探测的结果不一致 —— 工程可能已变更")
        return result

    # 人工接管保护（A7）：头部标记被删 → 视为用户手改，不覆盖
    if out.exists():
        cur = out.read_text(encoding="utf-8")
        if "generated-by" not in cur and not force:
            result["status"] = "hand-edited"
            log(f"[adapt] ⚠ {to_fwd(out)} 已被人工接管（generated-by 标记缺失），未覆盖")
            return result
        if cur == text:
            result["status"] = "identical"
            log(f"[adapt] ✓ 内容一致，无需重写：{to_fwd(out)}")
            return result
        if not force:
            result["status"] = "differs"
            log(f"[adapt] ⚠ {to_fwd(out)} 已存在且内容不同 —— 用 --force 覆盖")
            return result
        result["backup"] = to_fwd(out) + ".bak"
        Path(str(out) + ".bak").write_text(cur, encoding="utf-8")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    result["written"] = True
    result["status"] = "written"
    result["bytes"] = len(text)
    log(f"[adapt] ✓ 生成 {to_fwd(out)}  ({len(text)} B)")
    return result


# ── 顶层入口（CLI 用）─────────────────────────────────────────────
def run(cfg: Config, *, path, name: str = "", write_it: bool = False,
        check: bool = False, force: bool = False, log=print) -> dict:
    p = probe_project(cfg, path)
    out = {"probe": p.to_dict(), "tier": p.tier,
           "confidence": p.confidence, "name": name or default_name(p)}

    if check or write_it:
        out["result"] = write(cfg, p, name=name, force=force, check=check, log=log)
    else:
        log(render_probe(p))
    return out


def render_probe(p: Probe) -> str:
    """人类可读的探测报告（每行都标证据级别与出处）。"""
    L: list[str] = []
    A = L.append
    A(f"[adapt] 目标：{p.root}")
    if p.tier == "T3":
        A("  [✗] 无 CMakeLists.txt → T3（需真改造）：请在图形配置器里改用 CMake 工具链后重新导出")
        return "\n".join(L)
    A(f"  档位      : {p.tier}")
    A(f"  厂商/生成器: {p.vendor or '?'} / {p.generator or '?'}")
    A(f"  形态      : {p.archetype or '?'} 类")
    A(f"  芯片      : {p.chip_ref or '(未匹配)'}   [宏 {p.chip_macro or '?'}]")
    A(f"  工程名    : {p.project_name or '?'}   → 产物 {p.project_name or '?'}.elf/hex/bin/map")
    A(f"  链接脚本  : {p.linker_script or '?'}   (链接变量 {p.linker_variable or '?'})")
    A(f"  编译参数  : -mcpu={p.cpu or '?'} -mfpu={p.fpu or '(无)'} -mfloat-abi={p.float_abi or '(无)'}")
    if p.memory:
        A("  内存      : " + " ".join(f"{k}={hex(v['length'])}" for k, v in p.memory.items()))
    if p.baud:
        A(f"  串口      : {p.usart or '?'} {p.baud} baud  (TX={p.tx_pin or '?'} RX={p.rx_pin or '?'})")
    A("  输出能力  : " + ("有 → 将生成 monitor 判据，串口闭环可被机器判定"
                          if p.can_print else
                          "无 → 不生成 monitor 判据，串口闭环会判 inconclusive（§16.1）"))
    A("")
    A("  证据链：")
    for f in sorted(p.facts, key=lambda x: _LEVEL_RANK[x.level]):
        A(f"    [{f.level}] {f.key:<15} {f.evidence}")
    if p.conflicts:
        A("")
        A("  ⚠ 冲突（低级别证据被高级别否决）：")
        for c in p.conflicts:
            A(f"    - {c}")
    if p.ambiguities:
        A("")
        A("  ⚠ 未决项（需人工/agent 裁决，不猜）：")
        for a in p.ambiguities:
            A(f"    - {a}")
    if p.notes:
        A("")
        A("  · 提示（已解决/仅供参考，不阻断）：")
        for n in p.notes:
            A(f"    - {n}")
    A("")
    A(f"  置信度：{p.confidence}")
    return "\n".join(L)
