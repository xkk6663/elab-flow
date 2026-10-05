"""Dry-run verifier for cockpit.cmd (manual, not in CI).

win-bat-launcher-verify 技能的干跑法：不改业务行为本身，只把「副作用语句」
改写为 echo 后执行副本，多 variant 覆盖分支，且每个 variant 的 **stderr 必须为空**。

被改写的副作用：
  probe  powershell TCP 探测 → exit /b %DRYRUN_PROBE%（variant 1/2 伪造结果）
  start  起服务 / 开浏览器   → echo [dryrun-start]/[dryrun-open]
  timeout / pause            → rem（失败分支的 40 次等待瞬间跑完）

Variant：
  A. DRYRUN_PROBE=0  服务已在跑 → 只开浏览器，rc=0
  B. DRYRUN_PROBE=1  起不来   → 走「20s 未起来」失败分支，rc=1
  C. 真探测（端口 5301 上有真服务）→ 只改写 start 语句，rc=0（验真实 socket 路径）
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "cockpit.cmd"


def build_variant(source: str, fake_probe: bool) -> str:
    out = []
    for line in source.splitlines():
        s = line.strip()
        low = s.lower()
        if fake_probe and low.startswith("powershell"):
            # 注意：脚本主体里 exit /b 会直接终止整个批处理，
            # 必须用子 cmd 置 errorlevel（语义与 powershell 探测一致：只改 ERRORLEVEL）
            out.append("cmd /c exit %DRYRUN_PROBE%")
            continue
        if not fake_probe and low.startswith("powershell"):
            out.append(line)  # variant C：保留真探测
            continue
        if low.startswith("start ") and "cockpit" in low:
            # 起服务的 start（title 带 cockpit）→ 留痕
            out.append("echo [dryrun-start] " + s)
            continue
        if low.startswith("start "):
            # 开浏览器的 start（start "" "%URL%"）→ 留痕
            out.append("echo [dryrun-open] " + s)
            continue
        if low.startswith("timeout ") or s == "pause":
            out.append("rem [dryrun] " + s)
            continue
        out.append(line)
    return "\r\n".join(out) + "\r\n"


def run(variant: str, env_extra: dict[str, str]) -> tuple[int, str, str]:
    with tempfile.NamedTemporaryFile(
        "w", suffix=".cmd", delete=False, encoding="ascii", newline="\r\n"
    ) as f:
        f.write(variant)
        path = f.name
    try:
        env = os.environ.copy()
        env.update(env_extra)
        # PATH 前置 System32（与脚本自身行为一致，屏蔽 MSYS 干扰）
        env["PATH"] = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                   "System32") + os.pathsep + env.get("PATH", "")
        p = subprocess.run(["cmd", "/d", "/c", path], capture_output=True,
                           text=True, env=env, timeout=120,
                           cwd=str(ROOT))
        return p.returncode, p.stdout, p.stderr
    finally:
        os.unlink(path)


def main() -> int:
    src = SRC.read_text(encoding="ascii")  # 纯 ASCII：非 ASCII 字符直接抛
    print(f"[ok] cockpit.cmd is pure ASCII ({len(src)} bytes)")

    dry = build_variant(src, fake_probe=True)
    real = build_variant(src, fake_probe=False)

    fails: list[str] = []

    # Variant A：服务已在跑
    rc, out, err = run(dry, {"DRYRUN_PROBE": "0"})
    ok = rc == 0 and "[dryrun-open]" in out and "[dryrun-start]" not in out and err == ""
    print(f"[{'ok' if ok else 'FAIL'}] A already-running: rc={rc} "
          f"open={'[dryrun-open]' in out} start={'[dryrun-start]' in out} stderr={err!r}")
    if not ok:
        fails.append("A")
        print(out)

    # Variant B：服务起不来 → 失败分支
    rc, out, err = run(dry, {"DRYRUN_PROBE": "1"})
    ok = (rc == 1 and "[dryrun-start]" in out
          and "did not come up" in out and err == "")
    print(f"[{'ok' if ok else 'FAIL'}] B not-coming-up: rc={rc} "
          f"started={'[dryrun-start]' in out} failmsg={'did not come up' in out} stderr={err!r}")
    if not ok:
        fails.append("B")
        print(out)

    # Variant C：真 socket 探测（真服务在 5301）
    rc, out, err = run(real, {"COCKPIT_PORT": "5301"})
    ok = rc == 0 and "[dryrun-open]" in out and "[dryrun-start]" not in out and err == ""
    print(f"[{'ok' if ok else 'FAIL'}] C real-probe@5301: rc={rc} "
          f"open={'[dryrun-open]' in out} stderr={err!r}")
    if not ok:
        fails.append("C")
        print(out)

    if fails:
        print(f"[FAIL] variants failed: {','.join(fails)}")
        return 1
    print("[ok] all dry-run variants passed (stderr empty in all)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
