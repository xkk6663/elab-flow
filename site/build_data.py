"""把仓库里的教程与市场索引打成官网静态快照。

用法：python site/build_data.py
产物：site/data/docs.json、site/data/market.json、site/tut-assets/**

教程清单自动发现：`docs/tutorials/NN-*.md` 按文件名前的两位序号排序入列，
新增教程只要文件名带序号即可，不用改代码。中文简称与一句话描述可在
`site/tutorials.json` 里按文件名覆盖（没有覆盖时：简称取序号后、下划线前的片段，
描述取正文首段）。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DATA = SITE / "data"
DOCS = ROOT / "docs" / "tutorials"
# 教程截图随站点一起托管：此前 docs.json 里的 assets/** 被前端拼到
# raw.githubusercontent.com 上（跨域热链），国内网络下 raw 常被墙 / 限速，
# 于是首页图正常、教程截图时好时坏。改为构建期复制到站内 tut-assets/。
TUT_ASSETS = SITE / "tut-assets"
ASSETS_SRC = DOCS / "assets"
# 可选：文件名 → 中文简称 / 描述 的覆盖表
META_FILE = SITE / "tutorials.json"


def discover() -> list[tuple[str, str, str]]:
    """扫描 docs/tutorials/NN-*.md，返回（文件名, 简称, 描述），按序号排序。"""
    meta: dict = {}
    if META_FILE.is_file():
        meta = json.loads(META_FILE.read_text(encoding="utf-8"))
    out: list[tuple[str, str, str]] = []
    for path in sorted(DOCS.glob("[0-9][0-9]-*.md")):
        fn = path.name
        stem = fn[3:-3]  # 去掉 "NN-" 与 ".md"
        item = meta.get(fn) or {}
        name = item.get("name") or stem.split("_")[0]
        out.append((fn, name, item.get("desc", "")))
    return out


def strip_front(md: str) -> str:
    return md.lstrip("\ufeff")


def pick_desc(md: str) -> str:
    """取第一个非标题非引用段落，压成一行。"""
    body = strip_front(md).splitlines()
    for line in body[1:]:
        s = line.strip()
        if not s or s.startswith(("#", ">", "|", "```", "!", "[", "-", "*")):
            continue
        s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
        s = re.sub(r"[`*_]", "", s)
        if len(s) > 30:
            return s[:120]
    return ""


# alt 文本里允许出现一层配对方括号（如「[alive] 稳定 1Hz」），
# 旧写法 [^\]]* 会在第一个 ] 处截断，导致这类图片既没改写也渲染不出来。
IMG_RE = re.compile(r"(!\[(?:[^\[\]]|\[[^\]]*\])*\]\()(?:\./)?assets/([^)\s]+)(\))")


def stage_images(raw: dict[str, str]) -> tuple[dict[str, str], list[str], int]:
    """把教程引用的截图复制进 site/tut-assets/，并把 md 里的路径改写成站内相对路径。

    返回（改写后的 md、缺失清单、复制字节数）。缺失不清空成空图，而是保留原路径并告警。
    """
    if TUT_ASSETS.exists():
        shutil.rmtree(TUT_ASSETS)
    copied: set[str] = set()
    missing: list[str] = []
    total = 0
    out: dict[str, str] = {}

    for fn, md in raw.items():

        def repl(m: re.Match) -> str:
            nonlocal total
            rel = m.group(2)
            src = ASSETS_SRC / rel
            if not src.is_file():
                missing.append(f"{fn} → assets/{rel}")
                return m.group(0)
            if rel not in copied:
                dst = TUT_ASSETS / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                copied.add(rel)
                total += src.stat().st_size
            return m.group(1) + "tut-assets/" + rel + m.group(3)

        out[fn] = IMG_RE.sub(repl, md)

    (TUT_ASSETS).mkdir(parents=True, exist_ok=True)
    return out, missing, total


def fetch_repo_meta() -> dict:
    """构建期快照：页面在 API 被限流 / 离线时仍能显示 star 与下载地址。"""
    import urllib.request

    meta = {
        "repo": "xkk6663/elab-flow",
        "stars": None,
        "tag": None,
        "download": "https://github.com/xkk6663/elab-flow/releases/latest",
        "release_url": "https://github.com/xkk6663/elab-flow/releases/latest",
        "snapshot_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    hdr = {"User-Agent": "elab-flow-site-builder", "Accept": "application/vnd.github+json"}
    # CI 里带上 GITHUB_TOKEN，避免匿名调用被限流后 star / tag 快照变空
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        hdr["Authorization"] = "Bearer " + token
    try:
        with urllib.request.urlopen(
            urllib.request.Request("https://api.github.com/repos/xkk6663/elab-flow", headers=hdr), timeout=20
        ) as r:
            meta["stars"] = json.load(r).get("stargazers_count")
    except Exception as e:  # noqa: BLE001
        print("star 快照失败:", e)
    try:
        with urllib.request.urlopen(
            urllib.request.Request("https://api.github.com/repos/xkk6663/elab-flow/releases/latest", headers=hdr),
            timeout=20,
        ) as r:
            rel = json.load(r)
        meta["tag"] = rel.get("tag_name")
        meta["release_url"] = rel.get("html_url") or meta["release_url"]
        assets = rel.get("assets") or []
        pick = next((a for a in assets if a["name"].lower().endswith((".zip", ".7z", ".exe"))), None)
        if pick:
            meta["download"] = pick["browser_download_url"]
        elif rel.get("tag_name"):
            meta["download"] = (
                f"https://github.com/xkk6663/elab-flow/archive/refs/tags/{rel['tag_name']}.zip"
            )
        else:
            meta["download"] = rel.get("zipball_url") or meta["download"]
    except Exception as e:  # noqa: BLE001
        print("release 快照失败:", e)
    return meta


def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    order = discover()
    if not order:
        raise SystemExit("docs/tutorials/ 下没有 NN-*.md，检查文件名是否带两位序号")
    raw = {fn: (DOCS / fn).read_text(encoding="utf-8") for fn, _, _ in order}
    staged, missing, asset_bytes = stage_images(raw)
    for m in missing:
        print("缺图:", m)

    docs = []
    for fn, plain, desc in order:
        md = staged[fn]
        title = ""
        for line in md.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        chars = len(re.sub(r"\s", "", md))
        docs.append(
            {
                "num": fn[:2],
                "file": fn,
                "title": title or plain,
                "name": plain,
                "desc": desc or pick_desc(md),
                "minutes": max(3, round(chars / 420)),
                "chars": chars,
                "md": md,
            }
        )
    (DATA / "docs.json").write_text(
        json.dumps({"generated_at": time.strftime("%Y-%m-%d"), "docs": docs}, ensure_ascii=False),
        encoding="utf-8",
    )

    market = json.loads((ROOT / "market" / "index.json").read_text(encoding="utf-8"))
    market["snapshot_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (DATA / "market.json").write_text(json.dumps(market, ensure_ascii=False, indent=2), encoding="utf-8")

    total = (DATA / "docs.json").stat().st_size
    print(f"docs.json  {len(docs)} 篇  {total // 1024} KB")
    print(f"tut-assets  {len(list(TUT_ASSETS.rglob('*')))} 项  {asset_bytes / 1048576:.1f} MB（站内托管，不再热链 raw）")
    print(f"market.json  {len(market.get('packs', []))} packs  {len(market.get('providers', []))} providers")

    repo = fetch_repo_meta()
    (DATA / "repo.json").write_text(json.dumps(repo, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"repo.json  stars={repo['stars']} tag={repo['tag']}")


if __name__ == "__main__":
    main()
