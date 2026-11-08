"""把仓库里的教程与市场索引打成官网静态快照（发布前跑一次）。

用法：python site/build_data.py
产物：site/data/docs.json、site/data/market.json
"""
from __future__ import annotations

import json
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

# 教程顺序即学习顺序；desc 不给就自动取正文首段
ORDER = [
    ("00-项目全览与架构解读.md", "项目全览与架构", "先读这篇：一句话定位、四层架构、11 组功能与 agent 工具全览"),
    ("01-芯片开发上手_独立WebUI.md", "芯片开发上手", "换新芯片 / 新板，先过心跳第一关，再跑完整闭环"),
    ("02-市场适配包贡献.md", "适配包贡献", "给新厂商做适配包，并把它发布到社区市场"),
    ("03-插件市场使用_独立WebUI.md", "插件市场使用", "零环境装插件，首启向导把工具链一次配齐"),
    ("04-调试面板上手_STM32F103C8T6.md", "调试工作区上手", "断点 / 监视 / 外设 / RTOS 栈，从一次真实 HardFault 收网"),
    ("05-DSH插件上手_STM32F103C8T6.md", "DSH 插件上手", "右栏窄栏闭环 + 调试页签，agent 在跑你在旁边看"),
    ("06-CLI终端闭环上手.md", "CLI 终端闭环", "只想用命令行：一条命令跑完五个阶段"),
    ("07-串口面板使用.md", "串口面板使用", "发送 / 历史 / 定时、四视图、波形游标与帧解码"),
    ("08-串口压力测试报告_STM32F411CEU6.md", "串口压力测试", "高吞吐与丢数判定，真机双向压测报告"),
    ("09-协议上手_Modbus.md", "Modbus 协议上手", "RTU 主站点表轮询、批量读写与硬件串口双缓冲"),
]


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
    raw = {fn: (DOCS / fn).read_text(encoding="utf-8") for fn, _, _ in ORDER}
    staged, missing, asset_bytes = stage_images(raw)
    for m in missing:
        print("缺图:", m)

    docs = []
    for fn, plain, desc in ORDER:
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
