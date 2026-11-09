"""把 site/ 发布到 gh-pages 孤立分支（不改动 main 工作区、不产生 main 提交）。

用法：python site/publish.py
原理：临时 index + hash-object/write-tree/commit-tree，绕开工作区切换。

平时不用手跑：.github/workflows/site.yml 在 docs/tutorials/** 或 site/** 变更时
会自动 build_data + publish；本机手动发布时 push 需带代理
（如 http_proxy=http://127.0.0.1:7890），否则连不上 github.com:443。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
BRANCH = "gh-pages"

# 这些目录被 .gitignore 排除、不入仓库，CI 检出时本地不存在。
# 发布又是“以本地 site/ 全量重建树”，于是父提交里有、本地没有的文件会被静默删掉
# （2026-11 宣传片就是这样从 gh-pages 消失、线上变 404 的）。
# 所以父提交里存在、本地缺失的媒体要原样搬回来。
CARGO_PREFIXES = ("assets/video/",)


def run(args: list[str], env: dict | None = None, check: bool = True) -> subprocess.CompletedProcess:
    p = subprocess.run(args, cwd=str(ROOT), env=env, capture_output=True, text=True, encoding="utf-8")
    if check and p.returncode != 0:
        sys.stderr.write(p.stdout + p.stderr)
        raise SystemExit(f"命令失败: {' '.join(args)}")
    return p


def resolve_parent() -> str:
    """当前 gh-pages 头（本地先、远端后），作为新提交的父提交与搬运来源。"""
    cur = run(["git", "rev-parse", "--verify", "-q", f"refs/heads/{BRANCH}"], check=False)
    if cur.returncode == 0 and cur.stdout.strip():
        return cur.stdout.strip()
    remote = run(["git", "ls-remote", "origin", f"refs/heads/{BRANCH}"], check=False)
    if remote.returncode == 0 and remote.stdout.strip():
        return remote.stdout.split()[0]
    return ""


def carry_over(env: dict, parent: str) -> list[str]:
    """把父提交里 CARGO_PREFIXES 下、本地不存在的 blob 原样塞回新树。"""
    if not parent:
        return []
    out = run(["git", "ls-tree", "-r", parent], check=False)
    if out.returncode != 0:
        return []
    kept: list[str] = []
    for line in out.stdout.splitlines():
        meta, _, path = line.partition("\t")
        parts = meta.split()
        if len(parts) != 3:
            continue
        mode, typ, blob = parts
        if typ != "blob" or not path.startswith(CARGO_PREFIXES):
            continue
        if (SITE / path).exists():
            continue
        run(["git", "update-index", "--add", "--cacheinfo", f"{mode},{blob},{path}"], env=env)
        kept.append(path)
    return kept


def main() -> None:
    # 父提交要先取：既用于 commit-tree -p，也是“本地缺失媒体”的搬运来源
    parent = resolve_parent()

    files: list[str] = []
    for p in sorted(SITE.rglob("*")):
        if p.is_dir():
            continue
        rel = p.relative_to(SITE).as_posix()
        if rel.startswith(".shots/") or rel in {"build_data.py", "publish.py", "tutorials.json", ".gitignore"}:
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
    carried = carry_over(env, parent)
    tree = run(["git", "write-tree"], env=env).stdout.strip()

    # .nojekyll 必须存在，否则 GitHub Pages 会走 Jekyll
    if ".nojekyll" not in files:
        print("警告：缺少 .nojekyll")

    msg = "site: ELAB-Flow 官网（首页 / 文档 / 芯片包市场）"

    cmd = ["git", "commit-tree", tree]
    if parent:
        cmd += ["-p", parent]
    commit = run(cmd + ["-m", msg]).stdout.strip()
    run(["git", "update-ref", f"refs/heads/{BRANCH}", commit])
    note = f" · 搬运 {len(carried)} 个媒体" if carried else ""
    print(f"tree {tree[:8]} commit {commit[:8]} parent {(parent[:8] or '-')} · {len(files)} files{note}")
    push = run(["git", "push", "origin", f"{BRANCH}:{BRANCH}"], check=False)
    print(push.stdout.strip() or push.stderr.strip())


if __name__ == "__main__":
    main()
