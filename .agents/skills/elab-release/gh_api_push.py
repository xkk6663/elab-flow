#!/usr/bin/env python3
"""用 GitHub Git Data API 推送提交——当 `git push` 的两条传输通道都不可用时。

**为什么需要它**：本机常见网络环境下 `github.com:443` 的 git 传输会被中断
（HTTPS 后端无论 schannel 还是 openssl 都报 handshake / unexpected eof；
SSH 走 ssh.github.com:443 报 banner exchange 超时），而 `api.github.com` 仍可达。
此时只能逐提交重放：blob → tree（base_tree 叠加）→ commit → PATCH ref。

**代价与事实**：API 重建的 commit 对象与本地并非逐字节相同（GitHub 会把
author/committer 时间规范成 UTC `Z`，本地是 `+08:00`；即使手工构造也复刻不出
相同 sha），所以推送后**远端 main 的 sha 与本地不同、但 tree 逐字节相同**。
两条历史因此平行，脚本用 tree 相等来自动判断「本地推到哪了」。

用法：
    python .agents/skills/elab-release/gh_api_push.py --dry-run
    python .agents/skills/elab-release/gh_api_push.py
    python .agents/skills/elab-release/gh_api_push.py --base-local <sha>   # 自动推断失败时
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

REPO = "xkk6663/elab-flow"
API = f"https://api.github.com/repos/{REPO}"
PROXY = os.environ.get("ELAB_GH_PROXY", "http://127.0.0.1:7891")
CONCURRENCY = 8


def git(*args: str, binary: bool = False):
    out = subprocess.run(["git", *args], capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: "
                           f"{out.stderr.decode('utf-8', 'replace')[:400]}")
    return out.stdout if binary else out.stdout.decode("utf-8")


def token() -> str:
    """从 git 凭证管理器取 GitHub PAT（本机已存，无需交互）。"""
    out = subprocess.run(
        ["git", "-c", "credential.helper=manager-core", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True, text=True, encoding="utf-8",
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    for line in out.stdout.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("取不到 PAT：检查 Windows 凭据管理器里的 github.com 条目")


TOKEN = token()
_OPENER = None


def _opener():
    global _OPENER
    if _OPENER is None:
        import urllib.request
        _OPENER = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    return _OPENER


def api(method: str, path: str, data=None, retries: int = 4):
    import urllib.error
    import urllib.request
    url = path if path.startswith("http") else API + path
    body = json.dumps(data).encode() if data is not None else None
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "elab-release-api-push",
    }
    if body:
        headers["Content-Type"] = "application/json"
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with _opener().open(req, timeout=120) as r:
                payload = r.read()
                return r.status, (json.loads(payload) if payload else None)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            if e.code in (502, 503, 504) and attempt + 1 < retries:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"{method} {path} -> {e.code} {detail[:400]}")
        except Exception as e:
            if attempt + 1 < retries:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"{method} {path} -> {e}")


def commit_meta(sha: str) -> dict:
    raw = git("log", "-1", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", sha).strip()
    an, ae, ai, cn, ce, ci = raw.split("\x00")
    return {
        "message": git("log", "-1", "--format=%B", sha).rstrip("\n"),
        "author": {"name": an, "email": ae, "date": ai},
        "committer": {"name": cn, "email": ce, "date": ci},
    }


def changes(parent: str, commit: str):
    """[(status, path)]，不识别重命名（= 删除 + 新增，结果等价）。"""
    raw = git("diff-tree", "-r", "--no-commit-id", "--name-status", "--no-renames",
              "-z", parent, commit, binary=True)
    parts = raw.split(b"\x00")
    out, i = [], 0
    while i < len(parts) - 1:
        status = parts[i].decode().strip()
        path = parts[i + 1].decode("utf-8")
        if not status or not path:
            break
        out.append((status[0], path))
        i += 2
    return out


def infer_base_local(remote_tree: str) -> str | None:
    """远端 main 的 tree 在本地对应哪个提交（两条平行历史的锚点）。"""
    for c in git("rev-list", "main").split():
        if git("rev-parse", f"{c}^{{tree}}").strip() == remote_tree:
            return c
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--base-local", help="本地已推送的提交（默认按 tree 自动推断）")
    args = ap.parse_args()

    st, ref = api("GET", "/git/ref/heads/main")
    remote_main = ref["object"]["sha"]
    st, rc = api("GET", f"/git/commits/{remote_main}")
    remote_tree = rc["tree"]["sha"]
    print(f"远端 main  {remote_main[:9]}  tree {remote_tree[:9]}")

    base_local = args.base_local or infer_base_local(remote_tree)
    if not base_local:
        raise SystemExit("无法自动推断本地基线（本地没有与远端 tree 相同的提交）；"
                         "请用 --base-local 指定")
    print(f"本地基线  {base_local[:9]}（tree 与远端一致 → 已推送）")

    commits = git("rev-list", "--reverse", f"{base_local}..main").split()
    if not commits:
        print("没有需要推送的提交")
        return 0

    plan = []
    total = 0
    for c in commits:
        ch = changes(git("rev-parse", f"{c}^").strip(), c)
        size = sum(len(git("cat-file", "blob", f"{c}:{p}", binary=True))
                   for s, p in ch if s != "D")
        total += size
        plan.append((c, ch))
        print(f"  {c[:9]}  {len(ch):3d} 变更  {size / 1024:8.1f} KiB  "
              f"{git('log', '-1', '--format=%s', c).strip()[:50]}")
    print(f"\n合计 {sum(len(c) for _, c in plan)} 变更 / {total / 1024 / 1024:.2f} MiB")
    if args.dry_run:
        print("（dry-run）")
        return 0

    tree_sha, last = remote_tree, remote_main
    t0 = time.time()
    for idx, (c, ch) in enumerate(plan, 1):
        meta = commit_meta(c)
        print(f"\n[{idx}/{len(plan)}] {c[:9]} {meta['message'].splitlines()[0][:56]}")
        entries = []

        def up(item):
            _, path = item
            data = git("cat-file", "blob", f"{c}:{path}", binary=True)
            st, blob = api("POST", "/git/blobs",
                           {"content": base64.b64encode(data).decode(), "encoding": "base64"})
            return path, blob["sha"]

        uploads = [(s, p) for s, p in ch if s != "D"]
        if uploads:
            with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
                for path, sha in pool.map(up, uploads):
                    mode = git("ls-tree", "-z", c, "--", path, binary=True)
                    mode = mode.split(b"\x00")[0].split(b" ")[0].decode() if mode else "100644"
                    entries.append({"path": path, "mode": mode, "type": "blob", "sha": sha})
        entries += [{"path": p, "mode": "100644", "type": "blob", "sha": None}
                    for s, p in ch if s == "D"]

        st, tree = api("POST", "/git/trees", {"base_tree": tree_sha, "tree": entries})
        tree_sha = tree["sha"]
        st, nc = api("POST", "/git/commits", {
            "message": meta["message"], "tree": tree_sha, "parents": [last],
            "author": meta["author"], "committer": meta["committer"]})
        last = nc["sha"]
        print(f"    tree {tree_sha[:9]}  commit {last[:9]}")

    st, res = api("PATCH", "/git/refs/heads/main", {"sha": last, "force": False})
    st, fc = api("GET", f"/git/commits/{last}")
    local_tree = git("rev-parse", "main^{tree}").strip()
    same = fc["tree"]["sha"] == local_tree
    print(f"\n✓ main -> {last[:9]}   ({time.time() - t0:.1f}s)")
    print(f"内容校验：本地 tree {local_tree[:9]} / 远端 {fc['tree']['sha'][:9]} "
          f"→ {'一致' if same else '不一致！'}")
    return 0 if same else 1


if __name__ == "__main__":
    sys.exit(main())
