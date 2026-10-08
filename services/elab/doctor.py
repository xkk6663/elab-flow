"""elab.doctor —— 环境与"两源漂移"体检。

三层体检：
  1. **L0 主机层**：所有声明路径是否可达；工具链版本是否与声明一致。
  2. **交叉引用**：项目→芯片、项目→探针、芯片→openocd cfg 是否都能解析。
  3. **两源漂移**（本设计的核心价值）：
     对自带 CMake 的工程，芯片参数在"工程里"和"chip.yaml 里"各有一份。
     doctor 拿 ``verify.expect_*`` 去比对**工程实际**的
     链接脚本内存布局 / 编译 flags / 预定义宏，不一致即报 ERROR。
     ``--deep`` 会真跑一次 configure（到 ``.work/<name>.doctor``）后
     从 compile_commands.json 取"实际编译命令"作证据。
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
from pathlib import Path

from ._winproc import proc_kwargs
from .config import Config, ElabError, Host, to_fwd
from . import ota_layout as ota_layout
from .plan import Plan, plan_for

OK, WARN, ERROR, INFO = "ok", "warn", "error", "info"
_ICON = {OK: "OK  ", WARN: "WARN", ERROR: "FAIL", INFO: "info"}


class Report:
    def __init__(self):
        self.items: list[tuple[str, str, str]] = []

    def add(self, level: str, code: str, msg: str):
        self.items.append((level, code, msg))
        return self

    def ok(self, code, msg):
        return self.add(OK, code, msg)

    def warn(self, code, msg):
        return self.add(WARN, code, msg)

    def fail(self, code, msg):
        return self.add(ERROR, code, msg)

    def info(self, code, msg):
        return self.add(INFO, code, msg)

    @property
    def errors(self):
        return [i for i in self.items if i[0] == ERROR]

    @property
    def warns(self):
        return [i for i in self.items if i[0] == WARN]

    @property
    def passed(self) -> bool:
        return not self.errors

    def render(self) -> str:
        lines = []
        for level, code, msg in self.items:
            lines.append(f"  [{_ICON[level]}] {code:<22} {msg}")
        return "\n".join(lines)


# ── 链接脚本内存布局 ──────────────────────────────────────────────
def parse_ld_memory(path) -> dict:
    """解析 ld 的 ``MEMORY { ... }`` 段 → ``{region: (origin, length)}``。"""
    try:
        txt = Path(path).read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {}
    txt = re.sub(r"/\*.*?\*/", "", txt, flags=re.S)
    m = re.search(r"MEMORY\s*\{(.*?)\}", txt, re.S)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        mm = re.match(
            r"\s*([A-Za-z0-9_]+)\s*(\([^)]*\))?\s*:\s*"
            r"ORIGIN\s*=\s*([^,\s]+)\s*,?\s*LENGTH\s*=\s*([^,\s]+)",
            line,
        )
        if mm:
            out[mm.group(1)] = (_parse_num(mm.group(3)), _parse_num(mm.group(4)))
    return out


def _parse_num(s: str) -> int:
    s = s.strip().rstrip(",").strip()
    mul = 1
    if s and s[-1] in "KkMm":
        mul = 1024 if s[-1] in "Kk" else 1024 * 1024
        s = s[:-1]
    try:
        return int(s, 0) * mul
    except ValueError:
        return -1


def _fmt(n: int) -> str:
    return f"0x{n:X} ({n})"


# ── 单项检查 ──────────────────────────────────────────────────────
def check_host(cfg: Config, rep: Report, host: Host):
    rep.info("host.yaml", to_fwd(cfg.host_path))

    gcc_root = host.gcc_root
    if gcc_root and Path(gcc_root).is_dir():
        rep.ok("toolchain.root", f"{gcc_root}  (声明版本 {host.gcc.get('version', '?')})")
    else:
        rep.fail("toolchain.root", f"工具链根目录不存在：{gcc_root!r}")

    if Path(host.cc).exists():
        rep.ok("toolchain.cc", Path(host.cc).name)
    else:
        rep.fail("toolchain.cc", f"找不到交叉编译器：{host.cc}")

    # 版本漂移：声明值 vs 实测值
    declared = str(host.gcc.get("version", "")).strip()
    if declared and Path(host.cc).exists():
        try:
            out = subprocess.run(
                [host.cc, "--version"], capture_output=True, text=True, timeout=20,
                **proc_kwargs(),
            ).stdout
            m = re.search(r"(\d+\.\d+\.\d+)", out)
            actual = m.group(1) if m else "?"
            if actual == declared:
                rep.ok("toolchain.version", f"{actual} == 声明值")
            else:
                rep.fail(
                    "toolchain.version",
                    f"实测 {actual} ≠ 声明 {declared}（elab.host.yaml 需更新）",
                )
        except (OSError, subprocess.SubprocessError) as exc:
            rep.warn("toolchain.version", f"无法探测版本：{exc}")

    if host.ninja and Path(host.ninja).exists():
        rep.ok("tools.ninja", to_fwd(host.ninja))
    else:
        rep.fail("tools.ninja", f"ninja 不存在：{host.ninja!r}")

    cm = host.cmake
    if cm in ("", "auto", None):
        found = _which("cmake")
        if found:
            rep.ok("tools.cmake", f"{found} (auto，要求 ≥ {host.cmake_min})")
        else:
            rep.fail("tools.cmake", "PATH 上找不到 cmake")
    else:
        rep.ok("tools.cmake", cm)

    if host.openocd and Path(host.openocd).exists():
        rep.ok("tools.openocd", to_fwd(host.openocd))
    else:
        rep.warn("tools.openocd", f"openocd 不存在：{host.openocd!r}（build 不受影响）")

    if host.openocd_scripts and Path(host.openocd_scripts).is_dir():
        rep.ok("openocd.scripts", to_fwd(host.openocd_scripts))
    else:
        rep.warn("openocd.scripts", f"openocd scripts 目录不存在：{host.openocd_scripts!r}")

    # 探针的 interface cfg —— 属于 L0，与芯片正交（同一个 DAP-Link 可驱动多颗芯片）
    scripts = host.openocd_scripts
    if scripts and Path(scripts).is_dir():
        for pname, probe in (host.probes or {}).items():
            ic = probe.get("interface_cfg")
            if not ic:
                continue
            if Path(scripts, ic).exists():
                rep.ok(f"probe.{pname}", f"{ic}  (backend={probe.get('backend')})")
            else:
                rep.warn(f"probe.{pname}", f"interface cfg 不存在：{ic}")

    if host.gdb and Path(host.gdb).exists():
        rep.ok("tools.gdb", Path(host.gdb).name)
    else:
        rep.warn("tools.gdb", f"ARM gdb 不存在：{host.gdb!r}（debug 不可用）")


def _which(name: str):
    from shutil import which

    return which(name)


def check_chip(rep: Report, cfg: Config, host: Host, chip: dict):
    cid = chip.get("id", "?")
    core = chip.get("core") or {}
    cpu = core.get("cpu", "")
    fpu = core.get("fpu", "")

    if cpu:
        rep.ok(f"chip.{cid}.cpu", cpu)
    else:
        rep.fail(f"chip.{cid}.cpu", "chip.yaml 缺少 core.cpu")

    if not fpu or fpu == "none":
        rep.info(f"chip.{cid}.fpu", f"{fpu or '(未声明)'} → 不产出 -mfloat-abi")
    else:
        rep.info(f"chip.{cid}.fpu", f"{fpu} → -mfloat-abi={fpu}")

    dbg = chip.get("debug") or {}

    # target cfg 属于【芯片】；interface cfg 属于【探针】（见 check_host）
    tgt = dbg.get("openocd_target")
    scripts = host.openocd_scripts
    if scripts and Path(scripts).is_dir():
        if not tgt:
            rep.warn(f"chip.{cid}.target", "未声明（flash/debug 不可用）")
        elif Path(scripts, tgt).exists():
            rep.ok(f"chip.{cid}.target", tgt)
        else:
            rep.warn(f"chip.{cid}.target", f"openocd cfg 不存在：{tgt}")
    svd = dbg.get("svd")
    if not svd:
        rep.info(f"chip.{cid}.svd", "未声明（影响 IDE 寄存器视图，不影响编译）")
    else:
        found = host.resolve_svd(svd)
        if found:
            rep.ok(f"chip.{cid}.svd", f"{svd} → {found}")
        else:
            rep.warn(f"chip.{cid}.svd",
                     f"未找到 {svd}（搜索根见 elab.host.yaml: svd_roots）")


def check_project(rep: Report, cfg: Config, host: Host, plan: Plan):
    name = plan.name
    proj = plan.proj
    rep.info(f"proj.{name}", f"archetype={proj.get('archetype', '?')}  chip={proj.get('chip')}")

    if Path(plan.source_dir).is_dir():
        rep.ok(f"proj.{name}.root", plan.source_dir)
    else:
        rep.fail(f"proj.{name}.root", f"业务工程目录不存在：{plan.source_dir}")

    src = to_fwd(proj.get("build", {}).get("source", ""))
    if src and Path(src).exists():
        rep.ok(f"proj.{name}.source", src)
    else:
        rep.warn(f"proj.{name}.source", f"构建入口不存在：{src!r}")

    for label, path in (("toolchain_file", plan.toolchain_file),
                        ("project_include", plan.project_include)):
        if path and Path(path).exists():
            rep.ok(f"proj.{name}.{label}", Path(path).name)
        else:
            rep.fail(f"proj.{name}.{label}", f"文件不存在：{path!r}")

    if plan.linker_script and Path(plan.linker_script).exists():
        rep.ok(f"proj.{name}.ld", Path(plan.linker_script).name)
    else:
        rep.fail(f"proj.{name}.ld", f"链接脚本不存在：{plan.linker_script!r}")

    # 探针
    if plan.probe:
        if host.probe(plan.probe):
            rep.ok(f"proj.{name}.probe", plan.probe)
        else:
            rep.warn(f"proj.{name}.probe", f"探针 {plan.probe!r} 未在 elab.host.yaml 声明")
    else:
        rep.warn(f"proj.{name}.probe", "未指定探针")


def check_drift(rep: Report, plan: Plan):
    """两源漂移：工程自带 ld 的 MEMORY vs chip.yaml 的内存声明。

    单镜像项目：ld region 必须**逐字节等于**芯片容量（旧行为，不变）。
    OTA 双镜像项目（flash.images 已声明，C33）：改为**镜像级口径** ——
      ① 每个镜像的 ld region 必须落在芯片物理范围内（BOOT 18K / APP 44K 都
         ≠ 芯片 64K，逐字节相等口径必然误报）；
      ② 各镜像在 **flash** 上的分区互不重叠（RAM 两个镜像都声明全量是 OTA
         惯例——boot/app 不同时运行，不参与互斥检查）；
      ③ bin 镜像的 address 必须等于其 ld 的 flash 区起点（烧错位 = 跑飞）。
    """
    # ★ OTA 分区表三方对账（方案 A/M1）：chips yaml ota_layout ↔
    #   flash.images 烧录地址 ↔ 各镜像 ld 的 FLASH ORIGIN。
    #   刻意放在 expect_memory 早退之前 —— 它只依赖 ota_layout 自身，
    #   不该因为芯片没写 verify.expect_memory 而被跳过。
    if plan.ota_layout:
        phys = (plan.chip.get("memory") or {}).get("flash") or None
        physical = None
        if isinstance(phys, dict) and phys.get("origin") is not None and phys.get("length") is not None:
            physical = (_parse_num(str(phys["origin"])), _parse_num(str(phys["length"])))
        problems = ota_layout_drift(plan.ota_layout, plan.flash_images, physical)
        if problems:
            rep.fail(f"drift.{plan.name}.ota-layout", "OTA 分区表漂移：" + "; ".join(problems))
        else:
            rep.ok(
                f"drift.{plan.name}.ota-layout",
                f"ota_layout ↔ 烧录地址 ↔ ld 三方一致（{len(plan.flash_images)} 镜像）",
            )

    chip = plan.chip
    verify = chip.get("verify") or {}
    expect = verify.get("expect_memory")
    if not expect:
        rep.info(f"drift.{plan.name}.memory", "chip.yaml 未声明 verify.expect_memory，跳过")
        return
    if not plan.linker_script or not Path(plan.linker_script).exists():
        rep.warn(f"drift.{plan.name}.memory", "链接脚本不可读，跳过内存比对")
        return

    if plan.flash_images:
        _check_drift_images(rep, plan, expect)
    else:
        _check_drift_single(rep, plan, expect)

    # 通用约定守卫：gcc.cmake 必须带 .elf 后缀（约束 C5）
    tc = Path(plan.toolchain_file) if plan.toolchain_file else None
    if tc and tc.exists():
        txt = tc.read_text(encoding="utf-8", errors="ignore")
        if "CMAKE_EXECUTABLE_SUFFIX_C" in txt and ".elf" in txt:
            rep.ok(f"convention.{plan.name}.elf", "通用工具链带 .elf 后缀约定 (C5)")
        else:
            rep.warn(f"convention.{plan.name}.elf",
                     "通用工具链缺少 .elf 后缀约定 → A 类工程产物会静默改名 (C5)")


def _chip_physical(plan: Plan) -> dict:
    """芯片物理内存范围：优先 chip.memory（含 origin），回退 expect_memory 标量。"""
    out: dict[str, tuple[int | None, int]] = {}
    for k, v in (plan.chip.get("memory") or {}).items():
        if isinstance(v, dict) and v.get("length") is not None:
            origin = _parse_num(str(v["origin"])) if v.get("origin") is not None else None
            out[k] = (origin, _parse_num(str(v["length"])))
    if not out:
        for k, v in ((plan.chip.get("verify") or {}).get("expect_memory") or {}).items():
            if isinstance(v, dict):
                origin = _parse_num(str(v.get("origin"))) if v.get("origin") is not None else None
                out[k] = (origin, _parse_num(str(v.get("length"))))
            else:
                out[k] = (None, _parse_num(str(v)))
    return out


def ota_layout_drift(layout: dict, flash_images: list[dict],
                     physical: tuple[int, int] | None) -> list[str]:
    """OTA 分区表三方对账（★ 方案 A/M1，纯函数；返回问题列表，空 = 一致）。

    ① 每个分区 ⊆ 芯片物理 flash；
    ② flash.images 每个带地址的镜像，地址必须命中【恰好一个】分区起点；
    ③ 命中分区的起点必须与该镜像 ld 的 FLASH ORIGIN 一致（跨文件漂移）。
    分区互斥在 plan 归一化（normalize_ota_layout）已 fail-fast，此处不重复。
    """
    problems: list[str] = []
    regions = {k: (layout[k]["addr"], layout[k]["size"]) for k in ota_layout.REGION_KEYS}

    # ★ 双槽校验（方案 §3.1）：槽互斥/覆盖性已在 plan 归一化 fail-fast，
    #   这里补"槽 ⊆ 物理 flash"与"出厂 app 镜像必须落槽 A 起点"。
    slots = layout.get("slots") or []
    if slots:
        for i, s in enumerate(slots):
            if physical is not None:
                p_origin, p_len = physical
                if not (p_origin <= s["addr"] and s["addr"] + s["size"] <= p_origin + p_len):
                    problems.append(
                        f"slots[{i}] {s['addr']:#x}+{s['size']:#x} 越界物理 flash "
                        f"{p_origin:#x}+{p_len:#x}"
                    )

    if physical is not None:
        p_origin, p_len = physical
        for key, (addr, size) in regions.items():
            if not (p_origin <= addr and addr + size <= p_origin + p_len):
                problems.append(
                    f"{key} {addr:#x}+{size:#x} 越界物理 flash {p_origin:#x}+{p_len:#x}"
                )

    for idx, img in enumerate(flash_images):
        raw = img.get("address")
        if not raw:
            continue  # elf 无显式地址 → 自带地址，无从对账（合法）
        addr = int(raw, 16) if isinstance(raw, str) else int(raw)
        hit = [k for k, (ra, _rs) in regions.items() if ra == addr]
        if len(hit) != 1:
            problems.append(
                f"flash.images[{idx}] 地址 {addr:#x} 未命中任何分区起点"
                f"（命中 {'/'.join(hit) if hit else '无'}）"
            )
            continue
        key = hit[0]
        # ★ 双槽（§3.1）：app 镜像（命中 app 区起点 == 槽A）必须是烧槽 A——出厂固件
        #   永远落 ACTIVE 槽；槽 B 只由 boot 的升级流程写入，flash.images 不许碰。
        if key == "app" and slots and addr != slots[0]["addr"]:
            problems.append(
                f"flash.images[{idx}] 地址 {addr:#x} ≠ 槽A起点 {slots[0]['addr']:#x}"
                "（出厂镜像必须烧槽 A）"
            )
        ld = img.get("ld")
        if not ld:
            continue
        if not Path(ld).exists():
            problems.append(f"flash.images[{idx}] ld 不可读：{ld}")
            continue
        regs = parse_ld_memory(ld)
        flash_key = next((r for r in regs if "FLASH" in r.upper()), None) if regs else None
        if flash_key is None:
            problems.append(f"flash.images[{idx}] 未能从 {Path(ld).name} 解析 FLASH 段")
        elif regs[flash_key][0] != addr:
            problems.append(
                f"flash.images[{idx}]（{Path(ld).name}）ld FLASH ORIGIN "
                f"{regs[flash_key][0]:#x} ≠ 命中分区 {key} 起点 {addr:#x}"
            )
    return problems


def _check_drift_images(rep: Report, plan: Plan, expect):
    """镜像级内存对账（C33）：⊆ 物理 + flash 互斥 + bin 地址对齐 ld 起点。"""
    physical = _chip_physical(plan)
    good, details = True, []

    segs: dict[str, list[tuple[str, int, int]]] = {}   # chip_key -> [(镜像名, origin, len)]
    for idx, img in enumerate(plan.flash_images):
        ld = img.get("ld") or plan.linker_script
        tag = f"#{idx}({Path(ld).name})" if img.get("ld") else f"#{idx}({Path(plan.linker_script).name})"
        if not ld or not Path(ld).exists():
            good = False
            details.append(f"{tag}: ld 不可读")
            continue
        regions = parse_ld_memory(ld)
        if not regions:
            good = False
            details.append(f"{tag}: 未能解析 MEMORY 段")
            continue
        for key in expect:
            match = next((r for r in regions if key.upper() in r.upper()), None)
            if match is None:
                good = False
                details.append(f"{tag}.{key}: ld 未声明该区")
                continue
            origin, length = regions[match]
            phys = physical.get(key)
            if phys:
                p_origin, p_len = phys
                if p_origin is not None and not (
                        p_origin <= origin and origin + length <= p_origin + p_len):
                    good = False
                    details.append(
                        f"{tag}.{key}: {_fmt(length)}@{origin:#x} 越界 "
                        f"(物理 {_fmt(p_len)}@{p_origin:#x})")
                elif p_origin is None and p_len and length > p_len:
                    good = False
                    details.append(f"{tag}.{key}: {_fmt(length)} > 物理 {_fmt(p_len)}")
                if "flash" in key.lower():
                    segs.setdefault(key, []).append((tag, origin, length))
            details.append(f"{tag}.{key}={_fmt(length)}@{origin:#x}")

        # ③ bin 镜像地址必须对齐其 ld 的 flash 起点
        if img["format"] == "bin" and img.get("address"):
            m = next((r for r in regions if "FLASH" in r.upper()), None)
            if m and int(img["address"], 16) != regions[m][0]:
                good = False
                details.append(
                    f"{tag}: bin address {img['address']} ≠ {m} 起点 "
                    f"{regions[m][0]:#x}（烧错位 = 跑飞）")

    # ② flash 分区互斥（RAM 不查——boot/app 不同时运行，各自声明全量是惯例）
    for key, lst in segs.items():
        ordered = sorted(lst, key=lambda t: t[1])
        for a, b in zip(ordered, ordered[1:]):
            if a[1] + a[2] > b[1]:
                good = False
                details.append(
                    f"flash 分区重叠：{a[0]}[{a[1]:#x}~{a[1]+a[2]:#x}] ∩ "
                    f"{b[0]}[{b[1]:#x}~{b[1]+b[2]:#x}]")

    if good:
        rep.ok(f"drift.{plan.name}.memory",
               f"双镜像布局合法（{len(plan.flash_images)} 镜像 ⊆ 芯片物理，flash 分区互斥）")
    else:
        rep.fail(f"drift.{plan.name}.memory", "镜像内存布局漂移：" + "; ".join(details))


def _check_drift_single(rep: Report, plan: Plan, expect):
    """单镜像口径（旧行为）：ld region 逐字节等于芯片容量。"""
    regions = parse_ld_memory(plan.linker_script)
    if not regions:
        rep.warn(f"drift.{plan.name}.memory", f"未能从 {Path(plan.linker_script).name} 解析 MEMORY 段")
        return

    good = True
    details = []
    for key, exp in expect.items():
        match = next((r for r in regions if key.upper() in r.upper()), None)
        if match is None:
            good = False
            details.append(f"{key}=未找到")
            continue
        origin, length = regions[match]
        if isinstance(exp, dict):
            exp_origin, exp_len = _parse_num(str(exp.get("origin"))), _parse_num(str(exp.get("length")))
        else:
            exp_origin, exp_len = None, _parse_num(str(exp))
        if length != exp_len or (exp_origin is not None and origin != exp_origin):
            good = False
            details.append(f"{key}: ld={_fmt(length)} ≠ chip={_fmt(exp_len)}")
        else:
            details.append(f"{key}={_fmt(length)}")
    if good:
        rep.ok(f"drift.{plan.name}.memory", "ld MEMORY 与 chip.yaml 一致 [" + ", ".join(details) + "]")
    else:
        rep.fail(f"drift.{plan.name}.memory", "内存布局漂移：" + "; ".join(details))


def deep_check(rep: Report, plan: Plan) -> dict:
    """真跑一次 configure，从 compile_commands.json 取实际编译命令作证据。"""
    scratch = plan.work_dir + ".doctor"
    Path(scratch).parent.mkdir(parents=True, exist_ok=True)

    # 复用 plan 的 -D，只替换 -B
    cmd = list(plan.configure_cmd())
    b = cmd.index("-B")
    cmd[b + 1] = scratch

    env = plan.host.build_env()
    try:
        proc = subprocess.run(
            cmd, cwd=str(plan.cfg.root), env=env,
            capture_output=True, text=True, timeout=300, **proc_kwargs(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        rep.fail(f"deep.{plan.name}", f"configure 无法启动：{exc}")
        return {"configure_ok": False}
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or proc.stdout or "").strip().splitlines()[-8:])
        rep.fail(f"deep.{plan.name}", f"configure 失败 (rc={proc.returncode})\n{tail}")
        return {"configure_ok": False}
    rep.ok(f"deep.{plan.name}", f"configure 通过（证据目录 {Path(scratch).name}）")

    cc_path = Path(scratch) / "compile_commands.json"
    if not cc_path.exists():
        rep.warn(f"deep.{plan.name}.evidence", "未生成 compile_commands.json，无法取编译命令")
        return {"configure_ok": True}

    entries = json.loads(cc_path.read_text(encoding="utf-8"))
    if not entries:
        rep.warn(f"deep.{plan.name}.evidence", "compile_commands.json 为空")
        return {"configure_ok": True}

    # 取一条"业务源文件"的编译命令作为代表（优先 main.c）
    entry = next((e for e in entries if str(e.get("file", "")).endswith("main.c")), entries[0])
    args = entry.get("arguments")
    cmdline = " ".join(args) if args else entry.get("command", "")
    src_name = Path(str(entry.get("file", "?"))).name

    verify = plan.chip.get("verify") or {}
    for flag in verify.get("expect_flags", []) or []:
        if flag in cmdline:
            rep.ok(f"deep.{plan.name}.flag", f"{flag}  (来自 {src_name})")
        else:
            rep.fail(f"deep.{plan.name}.flag", f"实际编译命令缺少 {flag}")
    for d in verify.get("expect_defines", []) or []:
        if re.search(rf"-D{d}(\b|=|$)", cmdline) or f"-D{d}" in cmdline:
            rep.ok(f"deep.{plan.name}.define", f"-D{d}")
        else:
            rep.fail(f"deep.{plan.name}.define", f"实际编译命令缺少 -D{d}")

    fpu = (plan.chip.get("core") or {}).get("fpu", "")
    if (not fpu or fpu == "none") and "-mfloat-abi" in cmdline:
        rep.fail(f"deep.{plan.name}.fpu", "无 FPU 芯片却出现了 -mfloat-abi（C7 回归）")

    # 链接行份数：确认 -T 只出现一次（约束 C1）
    ld = Path(plan.linker_script).name
    if ld and "-T" in cmdline:
        rep.info(f"deep.{plan.name}.linkflags", f"代表命令含链接参数（ld={ld}）")

    return {"configure_ok": True, "entry": src_name}


# ── 对外入口 ──────────────────────────────────────────────────────
def run(cfg: Config, only: str | None = None, deep: bool = False) -> Report:
    rep = Report()
    host = Host(cfg)
    check_host(cfg, rep, host)

    names = [only] if only else list(cfg.projects)
    for name in names:
        try:
            plan = plan_for(cfg, name)
        except ElabError as exc:
            rep.fail(f"proj.{name}", str(exc))
            continue
        check_chip(rep, cfg, host, plan.chip)
        check_project(rep, cfg, host, plan)
        check_drift(rep, plan)
        if deep:
            deep_check(rep, plan)
    return rep
