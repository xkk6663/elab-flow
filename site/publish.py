"""把 site/ 发布到 gh-pages 孤立分支（不改动 main 工作区、不产生 main 提交）。

用法：python site/publish.py
原理：临时 index + hash-object/write-tree/commit-tree，绕开工作区切换。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
BRANCH = "gh-pages"


def run(args: list[str], env: dict | None = None, check: bool = True) -> subprocess.CompletedProcess:
    p = subprocess.run(args, cwd=str(ROOT), env=env, capture_output=True, text=True, encoding="utf-8")
    if check and p.returncode != 0:
        sys.stderr.write(p.stdout + p.stderr)
        raise SystemExit(f"命令失败: {' '.join(args)}")
    return p


def main() -> None:
    files: list[str] = []
    for p in sorted(SITE.rglob("*")):
        if p.is_dir():
            continue
        rel = p.relative_to(SITE).as_posix()
        if rel.startswith(".shots/") or rel in {"build_data.py", "publish.py", ".gitignore"}:
            continue
        files.append(rel)

    index = Path(os.environ.get("TEMP", "/tmp")) / "elab-ghp.index"
    if index.exists():
        index.unlink()
    env = dict(os.environ, GIT_INDEX_FILE=str(index))

    run(["git", "read-tree", "--empty"], env=env)
    for rel in files:
        blob = run(["git", "hash-object", "-w", str(SITE / rel)]).stdout.strip()
        run(["git", "update-index", "--add", "--cacheinfo", f"100644,{blob},{rel}"], env=env)
    tree = run(["git", "write-tree"], env=env).stdout.strip()

    # .nojekyll 必须存在，否则 GitHub Pages 会走 Jekyll
    if ".nojekyll" not in files:
        blob = run(["git", "hash-object", "-w", "--stdin"], env=env).stdout.strip() if False else ""
        print("警告：缺少 .nojekyll")

    msg = "site: ELAB-Flow 官网（首页 / 文档 / 芯片包市场）"

    # 以现有 gh-pages 为父提交，保证可以 fast-forward（避免每次都是孤立根提交）
    parent = ""
    cur = run(["git", "rev-parse", "--verify", "-q", f"refs/heads/{BRANCH}"], check=False)
    if cur.returncode == 0:
        parent = cur.stdout.strip()
    if not parent:
        remote = run(["git", "ls-remote", "origin", f"refs/heads/{BRANCH}"], check=False)
        if remote.returncode == 0 and remote.stdout.strip():
            parent = remote.stdout.split()[0]

    cmd = ["git", "commit-tree", tree]
    if parent:
        cmd += ["-p", parent]
    commit = run(cmd + ["-m", msg]).stdout.strip()
    run(["git", "update-ref", f"refs/heads/{BRANCH}", commit])
    print(f"tree {tree[:8]} commit {commit[:8]} parent {(parent[:8] or '-')} · {len(files)} files")
    push = run(["git", "push", "origin", f"{BRANCH}:{BRANCH}"], check=False)
    print(push.stdout.strip() or push.stderr.strip())


if __name__ == "__main__":
    main()
