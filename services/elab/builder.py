"""elab.build —— YAML 驱动的 configure + build + 统一产物。

把干跑验证报告 §6 里**手写的那两条 cmake 命令**自动化掉：
参数全部来自 ``plan``（= L0/L1/L4 三份 YAML），无一处手写路径。

落实三条约束：
  D1  调 cmake 前把 ``toolchains.root/bin`` 前置进 PATH（version 可复现）
  C6  hex/bin **由 elab 统一产出**（objcopy），不依赖工程自带 POST_BUILD
  C4  零改动保证用**文件树快照**比对（不依赖 git）
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from .config import ElabError, to_fwd
from .plan import Plan

_IGNORE_DIRS = {".git"}


# ── 零改动保证：文件树快照 ────────────────────────────────────────
def snapshot_tree(root) -> dict:
    root = Path(root)
    out = {}
    if not root.is_dir():
        return out
    for path in root.rglob("*"):
        if any(part in _IGNORE_DIRS for part in path.parts):
            continue
        if path.is_file():
            try:
                st = path.stat()
            except OSError:
                continue
            out[to_fwd(path.relative_to(root))] = (st.st_size, st.st_mtime_ns)
    return out


def diff_snapshot(before: dict, after: dict) -> dict:
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed = sorted(k for k in (set(before) & set(after)) if before[k] != after[k])
    return {"added": added, "removed": removed, "changed": changed}


# ── 产物解析 ──────────────────────────────────────────────────────
_MEM_RE = re.compile(
    r"^\s*(\S+):\s+(\d+)\s*B\s+([\d.]+)\s*KB\s+([\d.]+)%\s*$", re.M
)
_SIZE_RE = re.compile(r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([0-9a-f]+)\s+\S+\s*$", re.M)


def _parse_memory(text: str) -> dict:
    """解析链接器的 ``--print-memory-usage`` 输出（**权威**，但只在真链接时才有）。"""
    out = {}
    for name, used, region_kb, pct in _MEM_RE.findall(text):
        out[name] = {
            "used": int(used),
            "region": int(float(region_kb) * 1024),
            "pct": float(pct),
        }
    return out


# ── .map 兜底：为什么需要它 ───────────────────────────────────────
# `--print-memory-usage` 只在**链接真的发生**时才有输出。而 Ninja 的增量构建
# 在"没有变化"时根本不会 relink → 该输出消失 → 内存占位表变成空的。
# 对驾驶舱来说这是"每次开发时都看得到空表"，不可接受。
#
# 于是从 `.map` 里自己算一遍——顺带让 `.map` 从"装饰品"变成**有承载的文件**
# （它的产出问题正是 N6 修的那件事）。
#
# .map 的两种形态都要认（实测 AT32F421 工程两种都出现）：
#   ① 名与址同行：      `.isr_vector     0x08000000       0xcc`
#   ② 名独占一行、址在下一行（缩进）：`._user_heap_stack` + `\n  0x20000024  0x604 ...`
# 漏掉形态② 会正好少算 heap+stack（本例 0x604 = 1540 B），把 RAM 从 1576 算成 36。
_MAP_SEC_RE = re.compile(
    r"^(?P<name>\.[A-Za-z_][\w.]*)\s+0x(?P<vma>[0-9a-fA-F]+)\s+0x(?P<size>[0-9a-fA-F]+)"
    r"(?:\s+load address\s+0x(?P<lma>[0-9a-fA-F]+))?\s*$"
)
_MAP_NAME_ONLY_RE = re.compile(r"^(?P<name>\.[A-Za-z_][\w.]*)\s*$")
_MAP_INDENT_ADDR_RE = re.compile(
    r"^\s+0x(?P<vma>[0-9a-fA-F]+)\s+0x(?P<size>[0-9a-fA-F]+)"
    r"(?:\s+load address\s+0x(?P<lma>[0-9a-fA-F]+))?\s*$"
)
_MAP_MEMCFG_RE = re.compile(
    r"^(?P<name>\S+)\s+0x(?P<origin>[0-9a-fA-F]+)\s+0x(?P<length>[0-9a-fA-F]+)"
)
#: 不占 Flash 的段（NOBITS 语义）。它们同样带 `load address`，但那只是**名义值**。
#: 判据来自实测：AT32F421 工程只有 3 个带 LMA 的段——
#:   `.data`（初值真存在 Flash → **要算**）、`.bss`、`._user_heap_stack`（只有 `*fill*` → **不算**）。
#: 漏掉 `._user_heap_stack` 的代价：Flash 虚高 1532~1540 B，正好等于该段大小。
_NOBITS_RE = re.compile(
    r"^(\.(bss|tbss|sbss|noinit|persistent|COMMON)(\.|$)"
    r"|\._{0,2}user_heap_stack$)"
)


#: 明确**非 ALLOC**的段：即使其 VMA 落在某个 region 内，也**不占**该 region 的空间。
#: 实测它们在本工程的 `.map` 里 VMA 都是 `0x0`（于是自然落在所有 region 之外），
#: 但那是"运气"而不是保证 —— 换个链接脚本或加个 `--only-section` 就可能把它们挪进
#: Flash，届时几十 KB 的调试段会被算进 Flash 用量。故**按名字显式排除**，不赌地址。
_NON_ALLOC_RE = re.compile(
    r"^(\.debug|\.zdebug|\.comment$|\.ARM\.attributes$|\.note|\.stab)"
)


def _iter_map_sections(body: str):
    """从 ``"Linker script and memory map"`` 之后的正文里产出 ``(name, vma, size, lma)``。

    认**两种**形态（实测 AT32F421 工程两种都出现，少认一种就会算错）：

      ① 名与址同行：  ``.text           0x080000cc     0x11d0``
      ② 名独占一行、址在**下一条缩进行**（最多往后看 3 条非空行）：
         ``._user_heap_stack``  →  ``        0x20000024      0x604 load address 0x...``

    形态②漏认的代价很具体：``._user_heap_stack``（heap+stack 预留）会被整块丢掉，
    RAM 用量从 1576 B 算成 36 B。
    """
    lines = body.splitlines()
    i, n = 0, len(lines)
    while i < n:
        raw = lines[i]
        i += 1
        if not raw.strip():
            continue

        m = _MAP_SEC_RE.match(raw)
        if m:
            g = m.groupdict()
            yield (g["name"], int(g["vma"], 16), int(g["size"], 16),
                   int(g["lma"], 16) if g.get("lma") else None)
            continue

        nm = _MAP_NAME_ONLY_RE.match(raw)
        if not nm:
            continue

        # 形态②：往后最多看 3 条非空行找地址行；一旦撞到下一段的名字行就放弃
        # （**不能消费**那一行，否则外层循环会漏掉那个段）
        seen = 0
        while i < n and seen < 3:
            nxt = lines[i]
            if not nxt.strip():
                i += 1
                seen += 1
                continue
            if _MAP_SEC_RE.match(nxt) or _MAP_NAME_ONLY_RE.match(nxt):
                break
            am = _MAP_INDENT_ADDR_RE.match(nxt)
            if am:
                g = am.groupdict()
                yield (nm.group("name"), int(g["vma"], 16), int(g["size"], 16),
                       int(g["lma"], 16) if g.get("lma") else None)
                i += 1
                break
            i += 1
            seen += 1


def parse_map_memory(path) -> dict:
    """从 GNU ld 的 ``.map`` 反推各 region 用量，返回与 ``_parse_memory`` **同形状**的 dict。

    算法与 ``--print-memory-usage`` 一致（**已用三个工程逐字节对齐验证**）：
      * 段按其 **VMA** 计入所在 region；
      * 若段另有 **LMA**（如 ``.data`` 的初值存在 Flash），再按 LMA 计入一次；
      * **NOBITS 段**（``.bss``、``._user_heap_stack``）不计 LMA —— 它们不占 Flash；
      * region 用量 = **占用区间的跨度**（``max(end) - origin``），**不是各段大小之和**；
      * 无任何分配的 region **不产出**（避免虚报一个 0% 的表盘）。
    """
    path = Path(path)
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8", errors="replace")

    # ① region 表：只取 "Memory Configuration" 到下一个空行块
    regions: list[tuple[str, int, int]] = []
    in_cfg = False
    for raw in text.splitlines():
        if raw.startswith("Memory Configuration"):
            in_cfg = True
            continue
        if in_cfg:
            if not raw.strip():
                if regions:
                    break
                continue
            if raw.lstrip().startswith("Name") and "Origin" in raw:
                continue
            m = _MAP_MEMCFG_RE.match(raw.strip())
            if m:
                name = m.group("name")
                if "default" in name:          # `*default*` 覆盖全地址空间，必须排除
                    continue
                regions.append((name, int(m.group("origin"), 16),
                                int(m.group("length"), 16)))
    if not regions:
        return {}

    # ② 段表：只扫 "Linker script and memory map" 之后
    try:
        body = text.split("Linker script and memory map", 1)[1]
    except IndexError:
        return {}

    # ③ 逐段归属，按 **span** 而非 **sum** 统计
    #
    # ★ 这里踩过一个坑，值得写下来："链接器报的 used"不是各段大小之和，
    #   而是**该 region 被占用区间的跨度**（含段间对齐填充）。
    #   实测：at32f421g8u7 求和 = 11784，链接器自报 = 11788；
    #        stm32_test   求和 = 37776，链接器自报 = 37780。
    #   差值恰好是 `.text` 里一处 4 字节 `*fill*`。
    #   改用 max(end) - origin 后三个工程**逐字节全等**（11788 / 37780 / 4840）。
    #   这也正是 ld 自己的算法：region 的 current 从 origin 起算，只增不减。
    acc: dict[str, dict] = {name: {"origin": origin, "hi": None}
                            for name, origin, _l in regions}

    def _account(addr: int, size: int) -> None:
        for name, origin, length in regions:
            if origin <= addr < origin + length:
                a = acc[name]
                a["hi"] = addr + size if a["hi"] is None else max(a["hi"], addr + size)
                return

    for name, vma, size, lma in _iter_map_sections(body):
        if size == 0 or _NON_ALLOC_RE.match(name):
            continue
        _account(vma, size)
        # `.data` 的初值存在 Flash：除 VMA（RAM）外还要按 LMA（Flash）计一次。
        # NOBITS 段（`.bss`、`._user_heap_stack`）不占 Flash，其 LMA 是名义值 → 跳过。
        if lma is not None and lma != vma and not _NOBITS_RE.match(name):
            _account(lma, size)

    out = {}
    for name, _origin, length in regions:
        if not length:
            continue
        hi = acc[name]["hi"]
        if hi is None:
            continue        # 该 region 无任何分配 → **不产出**（与链接器一致，不虚报 0%）
        origin = acc[name]["origin"]
        used = max(0, hi - origin)
        out[name] = {"used": used, "region": length,
                     "pct": round(used * 100.0 / length, 2)}
    return out


def _parse_size(text: str) -> dict:
    m = _SIZE_RE.search(text)
    if not m:
        return {}
    return {"text": int(m.group(1)), "data": int(m.group(2)), "bss": int(m.group(3))}


def _tail(text: str, n: int = 25) -> str:
    lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    return "\n".join(lines[-n:])


# ── 主流程 ────────────────────────────────────────────────────────
def build_project(
    plan: Plan,
    *,
    clean: bool = False,
    jobs: int | None = None,
    verbose: bool = False,
    dry_run: bool = False,
    skip_guard: bool = False,
    log=print,
) -> dict:
    result: dict = {
        "project": plan.name,
        "chip": plan.chip.get("id"),
        "cpu": (plan.chip.get("core") or {}).get("cpu"),
        "fpu": (plan.chip.get("core") or {}).get("fpu"),
        "source_dir": plan.source_dir,
        "work_dir": plan.work_dir,
        "configure_cmd": plan.configure_cmd(),
        "status": "pending",
    }

    env = plan.host.build_env()
    work_dir = Path(plan.work_dir)

    if dry_run:
        result["status"] = "dry-run"
        return result

    if clean and work_dir.exists():
        shutil.rmtree(work_dir, ignore_errors=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    # 零改动保证：构建前对业务工程做快照
    guard = plan.proj.get("guard") or {}
    snap_root = plan.proj.get("root")
    before = None
    if guard.get("snapshot") and not skip_guard:
        before = snapshot_tree(snap_root)

    t0 = time.time()

    # ① configure
    log(f"[elab] configure → {to_fwd(work_dir)}")
    if verbose:
        log("       " + " ".join(plan.configure_cmd()))
    rc, out, err = _run(plan.configure_cmd(), env, plan.cfg.root, verbose)
    if rc != 0:
        result["status"] = "configure-failed"
        result["error"] = _tail(err or out)
        log("[elab] ✗ configure 失败：\n" + result["error"])
        return result
    log("[elab] ✓ configure")

    # ② build
    cmd = plan.build_cmd()
    if jobs:
        cmd += ["-j", str(jobs)]
    log(f"[elab] build  → {plan.generator}")
    rc, out, err = _run(cmd, env, plan.cfg.root, verbose)
    if rc != 0:
        result["status"] = "build-failed"
        result["error"] = _tail(err or out)
        log("[elab] ✗ build 失败：\n" + result["error"])
        return result
    link_line = next(
        (ln for ln in (out or "").splitlines() if "Linking" in ln and "executable" in ln), ""
    )
    log("[elab] ✓ build" + (f"  ({link_line.strip()})" if link_line else ""))

    result["memory"] = _parse_memory(out or "")

    # ③ 统一产出 hex/bin（C6）
    elf = Path(plan.elf)
    artifacts = {}
    if elf.exists():
        artifacts["elf"] = {"path": to_fwd(elf), "bytes": elf.stat().st_size}
        for kind, path in (("hex", plan.hex), ("bin", plan.bin)):
            if not path:
                continue
            rc2, _, err2 = _run(
                [plan.host.objcopy, "-O", "ihex" if kind == "hex" else "binary",
                 to_fwd(elf), to_fwd(path)],
                env, plan.cfg.root, verbose,
            )
            if rc2 == 0 and Path(path).exists():
                artifacts[kind] = {"path": to_fwd(path), "bytes": Path(path).stat().st_size}
            else:
                log(f"[elab] WARN objcopy({kind}) 失败：{_tail(err2, 3)}")
        # map 文件（由 elab 盖章 -Wl,-Map=${ELAB_MAP_FILE} 产出，见 N6）
        if plan.map_file:
            if Path(plan.map_file).exists():
                artifacts["map"] = {"path": plan.map_file, "bytes": Path(plan.map_file).stat().st_size}
            else:
                # ★ 原实现在此处【静默忽略】，正因如此 N6（artifacts.map 长期空承诺）
                #   才藏了这么久：声明了却拿不到必须出声。
                log(f"[elab] WARN 已声明 artifacts.map 但未生成：{plan.map_file}")
                log("       链接行缺 -Wl,-Map？检查 -DELAB_MAP_FILE 是否已下传（plan.py）")
    else:
        result["status"] = "no-elf"
        result["error"] = f"缺少 ELF 产物：{to_fwd(elf)}（A 类工程 .elf 后缀约定丢失？见 C5）"
        log("[elab] ✗ " + result["error"])
        return result

    # ④ size 统计
    rc3, sout, _ = _run([plan.host.size, to_fwd(elf)], env, plan.cfg.root, False)
    if rc3 == 0:
        result["size"] = _parse_size(sout)

    result["artifacts"] = artifacts

    # ③b 内存占位兜底（★ 驾驶舱的现实需求）
    #     链接器只在**真链接**时才输出 --print-memory-usage。Ninja 增量构建在
    #     "没有变化"时不会 relink → 那段输出消失 → 内存占位表变空。
    #     而"开发时每次看到的都是空表"是不可接受的，故从 .map 自己算一遍。
    #     memory_source 一并带出去，让界面/CI 能说清"这个数字哪来的"。
    result["memory_source"] = "linker" if result.get("memory") else ""
    if not result.get("memory") and artifacts.get("map"):
        m = parse_map_memory(artifacts["map"]["path"])
        if m:
            result["memory"] = m
            result["memory_source"] = "map"
            log("[elab] 内存占位取自 .map（本次未 relink，链接器未输出 --print-memory-usage）")

    result["elapsed_s"] = round(time.time() - t0, 2)

    # ⑤ 零改动核对（C4）
    if before is not None:
        after = snapshot_tree(snap_root)
        d = diff_snapshot(before, after)
        result["guard"] = {
            "root": to_fwd(snap_root),
            "files_before": len(before),
            **d,
            "untouched": not (d["added"] or d["removed"] or d["changed"]),
        }
        if result["guard"]["untouched"]:
            log(f"[elab] ✓ 零改动保证：{snap_root} 的 {len(before)} 个文件均未被触碰")
        else:
            log(f"[elab] ⚠ 业务工程被改动：+{len(d['added'])} -{len(d['removed'])} ~{len(d['changed'])}")

    result["status"] = "ok"
    return result


def _run(cmd, env, cwd, verbose):
    """执行子进程；verbose 时实时透传，否则捕获。"""
    if verbose:
        proc = subprocess.run(cmd, cwd=str(cwd), env=env, text=True)
        return proc.returncode, "", ""
    proc = subprocess.run(
        cmd, cwd=str(cwd), env=env, capture_output=True, text=True,
        errors="replace",
    )
    return proc.returncode, proc.stdout, proc.stderr


# ── 人类可读摘要 ──────────────────────────────────────────────────
def render_summary(result: dict) -> str:
    if result["status"] in ("dry-run",):
        return "[elab] dry-run：未执行任何命令"
    if result["status"] in ("configure-failed", "build-failed", "no-elf"):
        return f"[elab] 失败于 {result['status']}"

    lines = [
        "",
        f"  project   {result['project']}    chip={result['chip']}  "
        f"cpu={result['cpu']}  fpu={result['fpu'] or 'none'}",
        f"  workdir   {result['work_dir']}",
    ]
    mem = result.get("memory") or {}
    if mem:
        lines.append("  memory")
        for name, m in mem.items():
            bar = _bar(m["pct"])
            lines.append(
                f"    {name:<6} {m['used']:>7} B / {m['region']:>7} B  "
                f"{m['pct']:>5.2f}%  {bar}"
            )
    size = result.get("size")
    if size:
        lines.append(
            f"  size      text={size['text']}  data={size['data']}  bss={size['bss']}"
        )
    arts = result.get("artifacts") or {}
    if arts:
        lines.append("  artifacts")
        for kind, info in arts.items():
            lines.append(f"    {kind:<4} {info['bytes']:>8} B  {info['path']}")
    g = result.get("guard")
    if g:
        mark = "✓" if g["untouched"] else "⚠"
        lines.append(
            f"  guard     {mark} untouched={g['untouched']}  "
            f"(+{len(g['added'])} -{len(g['removed'])} ~{len(g['changed'])})"
        )
    lines.append(f"  elapsed   {result.get('elapsed_s')} s")
    return "\n".join(lines)


def _bar(pct: float, width: int = 20) -> str:
    filled = int(round(pct / 100 * width))
    return "[" + "#" * filled + "." * (width - filled) + "]"
