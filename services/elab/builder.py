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
    out = {}
    for name, used, region_kb, pct in _MEM_RE.findall(text):
        out[name] = {
            "used": int(used),
            "region": int(float(region_kb) * 1024),
            "pct": float(pct),
        }
    return out


def _parse_size(text: str) -> dict:
    m = _SIZE_RE.search(text)
    if not m:
        return {}
    return {"text": int(m.group(1)), "data": int(m.group(2)), "bss": int(m.group(3))}


def _tail(text: str, n: int = 12) -> str:
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
        # map 文件（若工程已生成）
        if plan.map_file and Path(plan.map_file).exists():
            artifacts["map"] = {"path": plan.map_file, "bytes": Path(plan.map_file).stat().st_size}
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
