"""elab.market —— 社区适配包市场的自动维护（发现 → 机器校验 → 生成索引）。

设计原则（与 ``docs/可行性研究_社区插件市场与芯片适配包.md`` 对齐）
------------------------------------------------------------------
- **无人审核**：作者把仓库打上 ``elab-pack`` topic 即自动上架；没有 PR、
  没有人工评审。准入完全由**机器校验**决定（与 ``elab pkg install`` 同一套
  ``validate_manifest`` / ``audit_dir`` / ``tree_hash``）。
- **哈希由 bot 亲自算**：索引里的 ``sha256`` 来自 ``pkg.tree_hash``，
  作者无法自报；安装时内核仍会强校验。
- **跳过而非阻断**：单个仓库校验失败只记入 ``report``，不影响其他包上架；
  只有发现接口本身失败才让整轮失败（避免把好索引写成空的）。
- **确定性输出**：按 ``name`` 排序、无时间戳 —— 同样的仓库内容生成同样的
  ``index.json``，CI 才能用"有变化才提交"。

调度载体在 ``xkk6663/elab-pack-market`` 的 ``.github/workflows/index.yml``
（cron + 手动触发），本模块只负责生成。
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import pkg
from .config import ElabError

GITHUB_API = "https://api.github.com"
#: 作者给自己的仓库打这个 topic 即自动进入市场（无需任何提交/审核）。
DEFAULT_TOPIC = "elab-pack"
#: 市场仓可选的黑名单文件名（紧急刹车：排除恶意包，不属常规审核流程）。
BLOCKLIST_FILE = "blocklist.json"

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_TAG_VER_RE = re.compile(r"^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][0-9A-Za-z.+-]+)?$")


class MarketError(ElabError):
    """市场发现/生成相关的可预期错误。"""


# ── GitHub API ────────────────────────────────────────────────────
def _headers(token: str | None = None) -> dict:
    h = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "elab-market-index",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _get_json(url: str, token: str | None = None, timeout: float = 30.0) -> dict:
    req = urllib.request.Request(url, headers=_headers(token))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:                          # noqa: BLE001
            pass
        hint = ""
        if exc.code in (403, 429):
            hint = "（可能触发了 GitHub API 限流，配置 GITHUB_TOKEN 可提高额度）"
        raise MarketError(f"GitHub API 失败 {exc.code}：{url}{hint} {detail}".strip()) from exc
    except (urllib.error.URLError, ValueError) as exc:
        raise MarketError(f"GitHub API 不可达：{url}：{exc}") from exc


def search_repos(token: str | None = None, *, topic: str = DEFAULT_TOPIC,
                 limit: int = 100) -> list[dict]:
    """发现社区适配包仓库（topic + 仓库名两条查询合并去重）。

    ★ 两条查询都必要：有人会打 topic，也有人只在仓库名里写 ``elab-pack``。
      单靠 topic 会漏掉后者（且 topic 目前几乎没人打）。
    """
    topic = str(topic or DEFAULT_TOPIC).strip() or DEFAULT_TOPIC
    limit = max(1, int(limit))
    per_page = min(100, limit)
    # 第二条用**带引号的短语**：GitHub 的名字搜索是按词模糊匹配的，不引号会把
    # ``eLabRC_AllPackages`` 这类仅含 "elab" 的仓库也搜出来，白白 clone 一遍。
    queries = [f"topic:{topic} fork:false",
               f'"{topic}" in:name fork:false is:public']
    found: dict[str, dict] = {}
    for query in queries:
        page = 1
        got = 0
        while got < limit:
            url = (f"{GITHUB_API}/search/repositories?q={urllib.parse.quote(query)}"
                   f"&per_page={per_page}&page={page}&sort=updated&order=desc")
            data = _get_json(url, token)
            items = data.get("items") or []
            for repo in items:
                full = str(repo.get("full_name") or "")
                if not full or repo.get("fork") or repo.get("private"):
                    continue
                if repo.get("archived") or repo.get("disabled"):
                    continue
                found.setdefault(full.lower(), repo)
            got += len(items)
            if len(items) < per_page:
                break
            page += 1
    return sorted(found.values(), key=lambda r: str(r.get("full_name")).lower())


def list_tags(full_name: str, token: str | None = None, *, limit: int = 100) -> list[str]:
    url = (f"{GITHUB_API}/repos/{full_name}/tags"
           f"?per_page={min(100, max(1, limit))}")
    data = _get_json(url, token)
    if not isinstance(data, list):
        return []
    return [str(t.get("name") or "") for t in data if isinstance(t, dict)]


def default_branch_sha(repo: dict, token: str | None = None) -> str:
    full = str(repo.get("full_name") or "")
    branch = str(repo.get("default_branch") or "main")
    data = _get_json(
        f"{GITHUB_API}/repos/{full}/git/ref/heads/{urllib.parse.quote(branch)}", token)
    sha = str(((data.get("object") or {}) if isinstance(data, dict) else {}).get("sha") or "")
    if not _SHA_RE.match(sha):
        raise MarketError(f"无法解析 {full}@{branch} 的 commit SHA")
    return sha


def _version_key(tag: str) -> tuple[int, int, int] | None:
    m = _TAG_VER_RE.match(str(tag or "").strip())
    return tuple(int(x) for x in m.groups()) if m else None


def pick_ref(repo: dict, tags: list[str], token: str | None = None) -> str:
    """选可复现的 ref：最高 semver tag；没有 tag 就用默认分支的 commit SHA。

    ★ 不用 ``main`` 这类移动引用：索引每小时重生成，但作者两次发版之间的
      "同一索引条目"应当指向同一份字节，否则用户装到的东西不可复现。
    """
    best: tuple[tuple[int, int, int], str] | None = None
    for tag in tags:
        key = _version_key(tag)
        if key is None:
            continue
        if best is None or key > best[0]:
            best = (key, str(tag).strip())
    if best:
        return best[1]
    return default_branch_sha(repo, token)


# ── 包校验（与安装同一套规则）──────────────────────────────────────
def _gitattributes_ok(pack_dir: Path) -> bool:
    path = Path(pack_dir) / ".gitattributes"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return bool(re.search(r"(?m)^\*\s+-text\b", text))


def inspect_pack_dir(pack_dir: Path, *, url: str = "", ref: str = "",
                     status: str = "community") -> tuple[dict | None, list[str]]:
    """对一个已物化的包目录做准入校验，返回 ``(entry, problems)``。

    这里**不联网**、不 clone，纯本地判定 —— 单测可直接喂临时目录。
    """
    try:
        man = pkg.read_manifest(pack_dir)
    except pkg.PackError as exc:
        return None, [str(exc)]
    problems = pkg.validate_manifest(man, pack_dir)
    if not _gitattributes_ok(pack_dir):
        problems.append("缺少 `.gitattributes` 或未声明 `* -text`"
                        "（内容哈希按字节计算，换行转换会让 sha256 对不上）")
    if problems:
        return None, problems
    entry = {
        "name": str(man["name"]),
        "vendor": str(man["vendor"]),
        "platform": str(man["platform"]),
        "version": str(man["version"]),
        "description": str(man.get("description") or ""),
        # ★ 市场发现的包一律 community：official 只能来自随仓分发的
        #   packs/official（否则作者可以自称官方）。
        "status": "community",
        "license": str(man["license"]),
        "requires": man.get("requires") or {},
        "chips": pkg.refs_in_pack(pack_dir),
        "source": {"type": "git", "url": url, "ref": ref},
        "sha256": pkg.tree_hash(pack_dir),
    }
    return entry, []


def _inspect_git(url: str, ref: str) -> tuple[dict | None, list[str]]:
    try:
        with pkg._materialize(git=url, ref=ref) as (pack_dir, _origin):  # noqa: SLF001
            return inspect_pack_dir(pack_dir, url=url, ref=ref)
    except pkg.PackError as exc:
        return None, [str(exc)]
    except Exception as exc:                       # noqa: BLE001
        return None, [f"拉取仓库失败：{exc}"]


# ── 索引装配 ──────────────────────────────────────────────────────
def _ver_key(version: str) -> tuple[int, ...]:
    m = re.match(r"^([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?", str(version or ""))
    return tuple(int(x or 0) for x in m.groups()) if m else (0,)


def dedupe(entries: list[dict]) -> tuple[list[dict], list[dict]]:
    """同名包只留一个（版本高者胜；同版本取 URL 字典序最小，保证确定性）。"""
    winners: dict[str, dict] = {}
    rejected: list[dict] = []
    for entry in entries:
        name = str(entry.get("name") or "")
        cur = winners.get(name)
        if cur is None:
            winners[name] = entry
            continue
        cur_url = str((cur.get("source") or {}).get("url") or "")
        new_url = str((entry.get("source") or {}).get("url") or "")
        new_better = (_ver_key(entry.get("version")) > _ver_key(cur.get("version"))
                      or (_ver_key(entry.get("version")) == _ver_key(cur.get("version"))
                          and new_url < cur_url))
        if new_better:
            rejected.append({"repo": cur_url, "name": name,
                             "reason": f"同名包被 {new_url} 取代（版本更高）"})
            winners[name] = entry
        else:
            rejected.append({"repo": new_url, "name": name,
                             "reason": f"同名包已由 {cur_url} 提供"})
    packs = sorted(winners.values(), key=lambda e: str(e.get("name")))
    return packs, rejected


def payload(entries: list[dict]) -> dict:
    """索引正文（确定性：排序、无时间戳）。"""
    return {"schema_version": pkg.PACK_SCHEMA_VERSION,
            "packs": sorted(entries, key=lambda e: str(e.get("name")))}


def load_blocklist(path: str | Path | None) -> set[str]:
    """读黑名单：支持 ``["url"]`` 或 ``{"repos": ["url", "owner/repo"]}``。"""
    if not path:
        return set()
    p = Path(path)
    if not p.exists():
        return set()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise MarketError(f"黑名单 JSON 解析失败：{p}：{exc}") from exc
    items = data.get("repos") if isinstance(data, dict) else data
    out = set()
    for item in items or []:
        s = str(item or "").strip().lower()
        if s:
            out.add(s.removesuffix(".git"))
    return out


def _is_blocked(repo: dict, blocked: set[str]) -> bool:
    if not blocked:
        return False
    full = str(repo.get("full_name") or "").lower()
    url = str(repo.get("clone_url") or repo.get("html_url") or "").lower()
    url = url.removesuffix(".git")
    html = str(repo.get("html_url") or "").lower()
    return any(k in (full, url, html) or k == url.rsplit("github.com/", 1)[-1]
               for k in blocked)


def build_remote_index(*, token: str | None = None, topic: str = DEFAULT_TOPIC,
                       limit: int = 100, block=None, repos: list[dict] | None = None,
                       inspect=None) -> dict:
    """发现 → 校验 → 生成索引。返回 ``{"index": {...}, "report": {...}}``。

    ``repos`` / ``inspect`` 可注入（单测不联网）；``inspect(url, ref)`` 返回
    ``(entry, problems)``。
    """
    blocked = block if isinstance(block, set) else load_blocklist(block)
    repos = search_repos(token, topic=topic, limit=limit) if repos is None else repos
    inspect = inspect or _inspect_git
    entries: list[dict] = []
    api_failed = 0
    report = {"schema_version": pkg.PACK_SCHEMA_VERSION,
              "topic": topic, "discovered": len(repos),
              "accepted": [], "rejected": []}
    for repo in repos:
        full = str(repo.get("full_name") or "")
        if _is_blocked(repo, blocked):
            report["rejected"].append(
                {"repo": full, "reason": "命中市场仓 blocklist.json（已手动下架）"})
            continue
        url = str(repo.get("clone_url") or repo.get("html_url") or "")
        try:
            tags = list_tags(full, token)
            ref = pick_ref(repo, tags, token)
        except MarketError as exc:
            api_failed += 1
            report["rejected"].append({"repo": full, "kind": "api", "reason": str(exc)})
            continue
        entry, problems = inspect(url, ref)
        if entry is None:
            report["rejected"].append({"repo": full, "ref": ref,
                                       "reason": "；".join(problems) or "校验失败"})
            continue
        report["accepted"].append({"repo": full, "name": entry["name"],
                                   "version": entry["version"], "ref": ref})
        entries.append(entry)
    # ★ 防"清空市场"：如果所有仓库都是因 API 失败（限流/网络）而跳过，这一轮
    #   的结果不可信 —— 宁可让 workflow 失败，也不要提交一份空索引。
    if repos and api_failed == len(repos):
        raise MarketError(
            f"{api_failed} 个仓库全部因 GitHub API 错误跳过（疑似限流/网络故障），"
            "本轮不生成索引（避免清空市场）；配置 GITHUB_TOKEN 提高额度")
    packs, dupes = dedupe(entries)
    report["rejected"] += dupes
    return {"index": payload(packs), "report": report}


def write_index(data: dict, out: str | Path) -> Path:
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    return path


def write_report(report: dict, path: str | Path) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                 encoding="utf-8")
    return p


def report_text(report: dict) -> str:
    lines = [f"[elab] 发现 {report.get('discovered', 0)} 个仓库，"
             f"上架 {len(report.get('accepted') or [])} 个，"
             f"跳过 {len(report.get('rejected') or [])} 个"]
    for item in report.get("accepted") or []:
        lines.append(f"  ✓ {item.get('name')}@{item.get('version')}  {item.get('repo')}")
    for item in report.get("rejected") or []:
        lines.append(f"  - {item.get('repo')}：{item.get('reason')}")
    return "\n".join(lines)


__all__ = [
    "BLOCKLIST_FILE", "DEFAULT_TOPIC", "GITHUB_API", "MarketError",
    "build_remote_index", "dedupe", "inspect_pack_dir", "load_blocklist",
    "payload", "pick_ref", "report_text", "search_repos", "write_index",
    "write_report",
]
