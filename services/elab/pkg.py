"""elab.pkg —— 芯片适配包（elab-pack）的发现、安装、校验与社区市场索引。

设计原则（与 ``docs/可行性研究_社区插件市场与芯片适配包.md`` 对齐）
------------------------------------------------------------------
- **一切芯片差异皆数据包**：内核只认 ``pack.yaml`` + ``chips/*.yaml``，
  不再直读仓库根目录的 ``chips/``，也不为任何厂商写业务分支。
- **零服务器市场**：市场索引就是一份 ``index.json``（GitHub 仓库 / raw URL /
  本地文件均可）。包内容留在作者自己的仓库，索引只记录
  ``name/version/source/sha256/requires/license``。
- **安装隔离**：包安装在 ``packs/installed/<name>/``，不合并进骨架目录；
  卸载即删目录，一包一版本可 pin（``.installed.json`` 记来源与哈希）。
- **安全边界**：包内**不得**包含可执行/预编译内容（脚本、二进制、py/js 等），
  安装时结构性审计 + 内容哈希强校验；C 端口是源码，由用户工具链现场编译。

用法（CLI 侧见 ``elab pkg``）
------------------------------
    elab pkg search stm32
    elab pkg install st/stm32              # 从市场索引解析
    elab pkg install st/stm32 --from packs/official/st/stm32
    elab pkg list / remove / verify / update
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from contextlib import contextmanager
from pathlib import Path

from . import _yaml
from . import skillgen
from .config import Config, ElabError, to_fwd

#: 内核自描述 API 版本（STEP_META/KERNEL_PLANS 的握手版本）。
#: 包的 ``requires.kernel_api`` 与此比对；不匹配时安装阶段 fail-fast。
KERNEL_API_VERSION = 1

#: ``pack.yaml`` schema 版本（芯片 YAML 格式的兼容层）。
PACK_SCHEMA_VERSION = 1

PACK_FILE = "pack.yaml"
INSTALL_META = ".installed.json"
#: 当前启用的适配包（安装目录内的用户本地状态，不入库）。
#: 语义：**一次只启用一套** —— 内核的 ``Config.chips`` / ``vendor_fingerprints``
#: 只读它；其余已装包仍留在本地，切换只需改这一个文件。
ACTIVE_FILE = "active.json"

#: 远程市场索引的内存缓存（raw URL → (monotonic_ts, data)）。
#: ★ 为什么必须缓存：驾驶舱市场页签是**输入即搜**（每敲一个字就一次
#:   ``GET /api/packs?q=``），而 ``load_market`` 每次都真联网拉 index.json
#:   （timeout 15s）。不缓存 = 把按键速度绑到网络延迟上。
#: 只缓存"真拉到"的结果；回退（缓存文件 / 本仓索引）不进缓存。
_MARKET_CACHE: dict = {}
_MARKET_TTL_S = 300.0

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$")
_SEMVER_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){2}(?:[+-][0-9A-Za-z.+-]+)?$")

#: 适配包**禁止**携带的可执行/预编译/脚本类文件（安全边界，见文档 §7.1）。
#: C 源码（.c/.h）不在其中：它是可审阅源码，由用户工具链现场编译。
_DENY_EXTS = {
    ".exe", ".dll", ".so", ".dylib", ".a", ".lib", ".o", ".obj",
    ".bin", ".hex", ".elf", ".map", ".pyc", ".pyo", ".pyd",
    ".sh", ".bash", ".bat", ".cmd", ".ps1", ".py", ".js", ".mjs",
    ".cjs", ".ts", ".jar", ".class", ".msi", ".apk",
}
_IGNORE_DIRS = {".git", "__pycache__", "node_modules", ".work"}


class PackError(ElabError):
    """适配包相关的可预期错误。"""


# ── 路径与配置 ─────────────────────────────────────────────────────
def _as_list(raw) -> list:
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(x) for x in raw if str(x).strip()]
    return [x.strip() for x in str(raw).replace(",", os.pathsep).split(os.pathsep)
            if x.strip()]


def pack_roots(cfg) -> list[Path]:
    """适配包搜索根。

    优先级：环境变量 ``ELAB_PACK_ROOTS`` > ``elab.host.yaml: packs.roots``
    > 默认 ``<ELAB_ROOT>/packs/installed``。后者是**安装目录**，骨架仓不内置
    任何芯片；官方包位于 ``packs/official/``，需显式安装（``elab pkg bootstrap``）。
    """
    raw = os.environ.get("ELAB_PACK_ROOTS")
    if not raw:
        try:
            raw = ((cfg.host or {}).get("packs") or {}).get("roots")
        except ElabError:
            raw = None
    items = _as_list(raw) or [to_fwd(Path(cfg.root) / "packs" / "installed")]
    out: list[Path] = []
    for item in items:
        p = Path(cfg.resolve(str(item), {"ELAB_ROOT": to_fwd(cfg.root)}))
        if p not in out:
            out.append(p)
    # 内置包源永远作为最后兜底（STM32 等随骨架分发的包开箱可用）；
    # 已安装副本优先（roots 顺序在前），避免重名。
    builtin = Path(cfg.root) / "packs" / "official"
    if builtin.is_dir() and builtin not in out:
        out.append(builtin)
    return out


def install_root(cfg) -> Path:
    """写入目标：第一个 pack root（通常是 ``packs/installed``）。"""
    return pack_roots(cfg)[0]


def official_root(cfg) -> Path:
    """随仓分发的官方包源目录（**不是**安装目录）。"""
    return Path(cfg.root) / "packs" / "official"


# ── 启用状态（一次只启用一套）──────────────────────────────────────
def active_path(cfg) -> Path:
    """启用状态文件的位置（安装目录内，随 ``packs/installed`` 一起不入库）。"""
    return install_root(cfg) / ACTIVE_FILE


def read_active(cfg) -> str:
    """读取当前启用的包名；文件缺失/损坏 → 空串（不抛错）。"""
    try:
        data = json.loads(active_path(cfg).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return str((data or {}).get("name") or "").strip() if isinstance(data, dict) else ""


def active_pack(cfg, packs: dict | None = None) -> dict | None:
    """当前启用的包记录；从未启用时回退到**已装列表的第一个**（排序稳定）。

    ★ 为什么需要回退：``packs/installed`` 可能是"先手工装好、还没有 active.json"
      的老状态。此时把第一个已装包当作启用，行为与"只有一个已装包"完全一致，
      也不会因为缺一个元文件就让内核突然无芯片可用。
    """
    packs = discover(cfg) if packs is None else packs
    name = read_active(cfg)
    rec = packs.get(name)
    if rec is not None and rec.get("installed"):
        return rec
    installed = sorted(n for n, r in packs.items() if r.get("installed"))
    return packs[installed[0]] if installed else None


def set_active(cfg, name: str, *, log=print) -> dict:
    """启用一套已安装的适配包（其他包保留在本地，随时切回）。"""
    name = str(name or "").strip()
    packs = discover(cfg)
    rec = packs.get(name)
    if not rec:
        raise PackError(f"未安装适配包：{name}")
    if not rec.get("installed"):
        raise PackError(
            f"{name} 只在官方源目录（{rec['dir']}），尚未安装；"
            f"先安装再启用（elab pkg install {name} --from {rec['dir']}）")
    path = active_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(
        {"name": name, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S")},
        ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"[elab] ✓ 已启用适配包 {name}（一次只启用一套）")
    return {"active": name, "path": to_fwd(path)}


def clear_active(cfg) -> None:
    try:
        active_path(cfg).unlink()
    except OSError:
        pass


# ── 清单读取 / 校验 ────────────────────────────────────────────────
def read_manifest(pack_dir: Path) -> dict:
    path = Path(pack_dir) / PACK_FILE
    if not path.exists():
        raise PackError(f"不是适配包目录（缺少 {PACK_FILE}）：{pack_dir}")
    try:
        man = _yaml.load_file(path) or {}
    except Exception as exc:                       # noqa: BLE001
        raise PackError(f"适配包清单解析失败：{path}：{exc}") from exc
    if not isinstance(man, dict):
        raise PackError(f"适配包清单必须是映射：{path}")
    man["_path"] = to_fwd(path)
    return man


def chip_files(pack_dir: Path) -> list[Path]:
    root = Path(pack_dir) / "chips"
    if not root.is_dir():
        return []
    return sorted(root.rglob("*.yaml"))


def refs_in_pack(pack_dir: Path) -> list[str]:
    out = []
    for path in chip_files(pack_dir):
        chip = _yaml.load_file(path) or {}
        if chip.get("id"):
            out.append(f"{chip.get('vendor')}/{chip.get('id')}")
    return out


def _version_tuple(s: str) -> tuple[int, ...]:
    return tuple(int(x) for x in s.split("."))


def _cmp_token(version: int, token: str) -> bool:
    token = token.strip()
    if not token:
        return True
    m = re.match(r"^(>=|<=|>|<|==|=|\^|~)?\s*v?([0-9]+(?:\.[0-9]+)*)$", token)
    if not m:
        raise PackError(f"无法解析版本约束：{token!r}")
    op, rhs_s = m.group(1) or "==", m.group(2)
    rhs = _version_tuple(rhs_s)
    v = (int(version),)
    v = v + (0,) * (len(rhs) - len(v)) if len(rhs) > len(v) else v[: len(rhs)]
    if op in ("==", "="):
        return v == rhs
    if op == ">=":
        return v >= rhs
    if op == "<=":
        return v <= rhs
    if op == ">":
        return v > rhs
    if op == "<":
        return v < rhs
    if op == "^":
        return v >= rhs and v[0] == rhs[0]
    if op == "~":
        return v >= rhs and v[:2] == rhs[:2]
    return False


def satisfies(version: int, spec: str) -> bool:
    """``kernel_api`` 约束：支持空格/逗号分隔的多条件，如 ``>=1 <2``。"""
    tokens = [t for t in re.split(r"[, ]+", str(spec or "")) if t]
    return all(_cmp_token(version, t) for t in tokens) if tokens else True


def check_requires(man: dict) -> list[str]:
    """返回 ``requires`` 的兼容性问题（空列表 = 通过）。"""
    problems: list[str] = []
    req = man.get("requires") or {}
    if not isinstance(req, dict):
        return ["requires 必须是映射"]
    want_schema = req.get("schema_version")
    if want_schema is not None and int(want_schema) != PACK_SCHEMA_VERSION:
        problems.append(
            f"包要求芯片 schema v{want_schema}，内核支持 v{PACK_SCHEMA_VERSION}")
    spec = str(req.get("kernel_api") or f">={KERNEL_API_VERSION}")
    try:
        if not satisfies(KERNEL_API_VERSION, spec):
            problems.append(
                f"包要求 kernel_api {spec}，当前内核内自描述 API 为 "
                f"v{KERNEL_API_VERSION}（请升级内核或固定旧包版本）")
    except PackError as exc:
        problems.append(str(exc))
    return problems


def validate_manifest(man: dict, pack_dir: Path | None = None) -> list[str]:
    """结构 / 安全 / 兼容性校验；返回问题列表（空 = 通过）。"""
    problems: list[str] = []
    if man.get("schema_version") != PACK_SCHEMA_VERSION:
        problems.append(
            f"schema_version 必须为 {PACK_SCHEMA_VERSION}："
            f"{man.get('schema_version')!r}")
    for key in ("name", "vendor", "platform", "version", "license"):
        if not str(man.get(key) or "").strip():
            problems.append(f"缺少必填字段 {key}")
    name = str(man.get("name") or "")
    if name and not _NAME_RE.match(name):
        problems.append(f"name 必须为 vendor/platform 形式（小写，如 st/stm32）：{name!r}")
    elif name:
        vendor, platform = name.split("/", 1)
        if str(man.get("vendor") or "") != vendor:
            problems.append(f"vendor={man.get('vendor')!r} 与 name={name!r} 前缀不一致")
        if str(man.get("platform") or "") != platform:
            problems.append(f"platform={man.get('platform')!r} 与 name={name!r} 后缀不一致")
    ver = str(man.get("version") or "")
    if ver and not _SEMVER_RE.match(ver):
        problems.append(f"version 必须是 semver（如 0.1.0）：{ver!r}")
    status = man.get("status")
    if status not in (None, "official", "community"):
        problems.append(f"status 只能是 official / community：{status!r}")

    problems += check_requires(man)

    if pack_dir is not None:
        files = chip_files(pack_dir)
        if not files:
            problems.append("包内没有任何 chips/**/*.yaml —— 适配包至少应声明一颗芯片")
        for path in files:
            try:
                chip = _yaml.load_file(path) or {}
            except Exception as exc:               # noqa: BLE001
                problems.append(f"芯片文件解析失败：{path}：{exc}")
                continue
            if not chip.get("id"):
                problems.append(f"芯片文件缺少 id：{path}")
            if chip.get("vendor") and chip.get("vendor") != man.get("vendor"):
                problems.append(
                    f"芯片 {chip.get('vendor')}/{chip.get('id')} 的 vendor "
                    f"与包 vendor={man.get('vendor')!r} 不一致")
        problems += audit_dir(pack_dir)
    return problems


def audit_dir(pack_dir: Path) -> list[str]:
    """安全审计：拒绝可执行/预编译/脚本、符号链接与路径逃逸。"""
    problems: list[str] = []
    root = Path(pack_dir)
    for path in sorted(root.rglob("*")):
        if not path.is_file() and not path.is_symlink():
            continue
        rel = path.relative_to(root).as_posix()
        if path.is_symlink():
            problems.append(f"包内不允许符号链接：{rel}")
            continue
        if path.suffix.lower() in _DENY_EXTS:
            problems.append(f"包内不允许可执行/预编译/脚本文件：{rel}")
    return problems


# ── 内容哈希（确定性）─────────────────────────────────────────────
def tree_hash(pack_dir: Path) -> str:
    """整包内容哈希：按相对路径排序，忽略安装元数据与临时目录。"""
    h = hashlib.sha256()
    root = Path(pack_dir)
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel == INSTALL_META or any(part in _IGNORE_DIRS for part in Path(rel).parts):
            continue
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(hashlib.sha256(path.read_bytes()).hexdigest().encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()


def read_installed_meta(pack_dir: Path) -> dict:
    path = Path(pack_dir) / INSTALL_META
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


# ── 发现 ──────────────────────────────────────────────────────────
def discover(cfg) -> dict[str, dict]:
    """扫描 pack roots，返回 ``{name: record}``。"""
    out: dict[str, dict] = {}
    for root in pack_roots(cfg):
        if not root.is_dir():
            continue
        for path in sorted(root.rglob(PACK_FILE)):
            pack_dir = path.parent
            man = read_manifest(pack_dir)
            name = str(man.get("name") or "").strip()
            if not name:
                raise PackError(f"适配包缺少 name：{path}")
            if name in out:
                prev = out[name]
                # 内置源与已安装副本同名：已安装优先（不视为重名）
                if prev.get("installed") and not read_installed_meta(pack_dir):
                    continue
                raise PackError(
                    f"适配包重名：{name}（{prev['dir']} 与 {pack_dir}）")
            meta = read_installed_meta(pack_dir)
            out[name] = {
                "name": name,
                "dir": to_fwd(pack_dir),
                "root": to_fwd(root),
                "manifest": man,
                "installed": bool(meta),
                "meta": meta,
                "sha256": meta.get("sha256") or "",
                "status": meta.get("status") or man.get("status") or "community",
                "chips": refs_in_pack(pack_dir),
            }
    return out


def _find_pack_root(path: Path) -> Path:
    """把"用户给的路径"解析成唯一的包根目录。"""
    path = Path(path).resolve()
    if (path / PACK_FILE).exists():
        return path
    found = sorted(path.rglob(PACK_FILE))
    if len(found) == 1:
        return found[0].parent
    if not found:
        raise PackError(f"目录中没有 {PACK_FILE}：{path}")
    raise PackError(
        f"目录包含 {len(found)} 个适配包，请指定具体包目录：{path}")


# ── 来源物化（本地 / git / 压缩包）──────────────────────────────────
@contextmanager
def _materialize(source=None, *, local=None, git=None, ref=None, archive=None,
                 subdir="", sha256: str | None = None):
    """把来源变成临时目录（本地目录直接复用），yield ``(path, origin)``。"""
    if local:
        path = Path(local).expanduser()
        if not path.exists():
            raise PackError(f"本地路径不存在：{path}")
        yield (_find_pack_root(path) if path.is_dir() else path), {"type": "local", "path": to_fwd(path)}
        return
    if git:
        url, frag = str(git).split("#", 1) if "#" in str(git) else (str(git), "")
        subdir = subdir or frag
        with tempfile.TemporaryDirectory(prefix="elab-pack-") as td:
            cmd = ["git", "clone", "--depth", "1"]
            if ref:
                cmd += ["--branch", str(ref)]
            cmd += [url, td]
            try:
                subprocess.run(cmd, check=True, capture_output=True, text=True)
            except FileNotFoundError as exc:
                raise PackError("安装 git 来源需要主机安装 git") from exc
            except subprocess.CalledProcessError as exc:
                raise PackError(f"git clone 失败：{exc.stderr.strip() or exc}") from exc
            base = Path(td) / subdir if subdir else Path(td)
            yield _find_pack_root(base), {"type": "git", "url": url,
                                          "ref": ref or "", "subdir": subdir}
        return

    if archive:
        url = str(archive)
        src_sha = sha256
        with tempfile.TemporaryDirectory(prefix="elab-pack-") as td:
            target = Path(td) / "download"
            try:
                with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310
                    target.write_bytes(resp.read())
            except Exception as exc:               # noqa: BLE001
                raise PackError(f"下载适配包失败：{url}：{exc}") from exc
            got = hashlib.sha256(target.read_bytes()).hexdigest()
            if src_sha and got != src_sha:
                raise PackError(f"压缩包 sha256 不匹配：期望 {src_sha}，实际 {got}")
            out = Path(td) / "extract"
            out.mkdir()
            _extract_archive(target, out)
            yield _find_pack_root(out), {"type": "archive", "url": url,
                                         "sha256": got}
        return

    if not source:
        raise PackError("缺少包来源（市场名 / 本地路径 / git URL / 压缩包 URL）")

    s = str(source)
    if Path(s).expanduser().exists():
        yield from _materialize(local=s)
    elif s.startswith("git+") or s.rstrip("/").endswith(".git"):
        yield from _materialize(git=s.replace("git+", "", 1))
    elif s.startswith(("http://", "https://")):
        yield from _materialize(archive=s, sha256=sha256)
    else:
        raise PackError(
            f"无法识别的来源：{s!r}（用市场名，或 --from <目录> / --git <URL> / "
            f"--archive <URL>）")


def _extract_archive(path: Path, out: Path):
    """安全解压 zip / tar.*（拒绝绝对路径与 ``..``）。"""
    def safe(member: str):
        p = Path(member)
        if p.is_absolute() or ".." in p.parts:
            raise PackError(f"压缩包含非法路径：{member}")
        return out / member

    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                target = safe(info.filename)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(info))
        return
    try:
        with tarfile.open(path) as tf:
            for member in tf.getmembers():
                if member.isdir():
                    continue
                if not member.isfile():
                    raise PackError(f"压缩包含非普通文件：{member.name}")
                target = safe(member.name)
                target.parent.mkdir(parents=True, exist_ok=True)
                data = tf.extractfile(member)
                if data is not None:
                    target.write_bytes(data.read())
        return
    except tarfile.TarError as exc:
        raise PackError(f"不支持的压缩包格式：{path}") from exc


# ── 安装 / 卸载 / 校验 ────────────────────────────────────────────
def install(cfg, source=None, *, local=None, git=None, ref=None, archive=None,
            subdir="", sha256: str | None = None, force: bool = False,
            status: str | None = None, log=print) -> dict:
    """安装一个适配包到 ``packs/installed/<name>/``。"""
    # 安装前先记下"有没有启用包"：没有则装完自动启用（打开即用）。
    # ★ 必须在复制之前读 —— 安装落盘后再判断，新包自己就成了"可回退的第一个"。
    had_active = active_pack(cfg) is not None
    with _materialize(source, local=local, git=git, ref=ref, archive=archive,
                       subdir=subdir, sha256=sha256) as (src, origin):
        man = read_manifest(src)
        problems = validate_manifest(man, src)
        if problems:
            raise PackError("适配包校验失败：\n  - " + "\n  - ".join(problems))
        src_hash = tree_hash(src)
        if sha256 and src_hash != sha256:
            raise PackError(
                f"内容 sha256 不匹配：期望 {sha256}，实际 {src_hash}")

        name = str(man["name"])
        dest = install_root(cfg) / name
        if dest.resolve() == Path(src).resolve():
            raise PackError(f"包已在安装目录：{dest}（无需重复安装）")
        if dest.exists() and not force:
            raise PackError(f"已安装 {name}（{dest}）。升级请加 --force，"
                            f"或先 elab pkg remove {name}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(
            src, dest,
            ignore=shutil.ignore_patterns(".git", INSTALL_META, "__pycache__",
                                          "node_modules", ".work"))
        dest_hash = tree_hash(dest)
        if dest_hash != src_hash:
            shutil.rmtree(dest, ignore_errors=True)
            raise PackError("安装后内容哈希不一致（复制过程被干扰），已回滚")

        rec_status = status or man.get("status") or "community"
        meta = {
            "name": name,
            "version": str(man.get("version")),
            "vendor": str(man.get("vendor")),
            "platform": str(man.get("platform")),
            "license": str(man.get("license")),
            "status": rec_status,
            "sha256": dest_hash,
            "source": origin,
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        (dest / INSTALL_META).write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if not had_active:
            # 第一次装包：自动启用（否则"装了但没芯片"会让人以为安装失败）
            set_active(cfg, name, log=log)
        log(f"[elab] ✓ 已安装适配包 {name}@{meta['version']} → {to_fwd(dest)}")
        return {**meta, "dir": to_fwd(dest), "chips": refs_in_pack(dest)}


def bootstrap(cfg, *, root=None, force=False, log=print) -> list[dict]:
    """安装 ``packs/official`` 下的全部官方包（离线自吃狗粮入口）。"""
    base = Path(root) if root else official_root(cfg)
    found = sorted(base.rglob(PACK_FILE)) if base.is_dir() else []
    if not found:
        raise PackError(f"没有找到官方包：{base}")
    out = []
    for path in found:
        man = read_manifest(path.parent)
        dest = install_root(cfg) / str(man.get("name"))
        if dest.exists() and not force:
            log(f"[elab] — 跳过已安装 {man.get('name')}（{to_fwd(dest)}）")
            continue
        out.append(install(cfg, local=path.parent, force=force,
                           status=man.get("status") or "official", log=log))
    return out


def remove(cfg, name: str, *, force=False, log=print) -> dict:
    packs = discover(cfg)
    rec = packs.get(name)
    if not rec:
        raise PackError(f"未安装适配包：{name}")
    if not rec["installed"]:
        raise PackError(
            f"{name} 不在安装目录（{rec['dir']}），不是 elab pkg 管理的包，"
            f"拒绝删除。若为官方源目录请手工处理。")
    dest = Path(rec["dir"])
    if not force and not str(dest).startswith(str(install_root(cfg))):
        raise PackError(f"拒绝删除非安装目录：{dest}")
    was_active = read_active(cfg) == name
    shutil.rmtree(dest)
    if was_active:
        # 卸载当前启用包 → 顺延到下一个已装包；没有就直接清空启用状态。
        rest = sorted(n for n, r in packs.items()
                      if r.get("installed") and n != name)
        if rest:
            set_active(cfg, rest[0], log=log)
        else:
            clear_active(cfg)
    log(f"[elab] ✓ 已卸载适配包 {name}（{to_fwd(dest)}）")
    return {"name": name, "dir": to_fwd(dest), "active": read_active(cfg)}


def verify(cfg, name: str | None = None) -> list[dict]:
    """校验已装包：清单一完整性/安全 + 内容哈希是否被改动。"""
    packs = discover(cfg)
    names = [name] if name else sorted(packs)
    out = []
    for n in names:
        rec = packs.get(n)
        if not rec:
            out.append({"name": n, "ok": False, "problems": ["未安装"]})
            continue
        problems = validate_manifest(rec["manifest"], Path(rec["dir"]))
        expected = (rec.get("meta") or {}).get("sha256") or ""
        actual = tree_hash(Path(rec["dir"]))
        if expected and actual != expected:
            problems.append(f"内容哈希漂移：期望 {expected}，实际 {actual}")
        out.append({"name": n, "ok": not problems, "sha256": actual,
                    "problems": problems, "dir": rec["dir"]})
    return out


# ── 安装入口（市场名 / 官方源）+ 平台 skill 重生成 ─────────────────
def find_official(cfg, name: str) -> Path | None:
    """在 ``packs/official`` 下按包名找到源目录（离线安装用）。"""
    base = official_root(cfg)
    if not base.is_dir():
        return None
    for path in sorted(base.rglob(PACK_FILE)):
        try:
            man = read_manifest(path.parent)
        except PackError:
            continue
        if str(man.get("name") or "") == name:
            return path.parent
    return None


def install_entry(cfg, name: str, *, official: bool = False,
                  force: bool = False, log=print) -> dict:
    """按**包名**安装：``official=true`` 走本仓官方源，否则走市场索引。

    ★ 只收包名、不收路径/URL/哈希（HTTP 面同款）：来源解析与 sha256 全部由
      内核自己从市场条目里取，前端即使被篡改也指不到任意磁盘路径。
    """
    name = str(name or "").strip()
    if not name:
        raise PackError("缺少包名（如 st/stm32）")
    if official:
        src = find_official(cfg, name)
        if src is None:
            raise PackError(f"官方源里没有适配包：{name}（packs/official）")
        return install(cfg, local=src, force=force, status="official", log=log)
    entry = market_entry(cfg, name)
    if not entry:
        raise PackError(f"市场索引里没有适配包：{name}（可先 elab pkg search）")
    kwargs = entry_source(entry, entry.get("_base", ""))
    return install(cfg, sha256=entry.get("sha256"), force=force,
                   status=entry.get("status"), log=log, **kwargs)


def update(cfg, name: str | None = None, *, force: bool = False,
           log=print) -> list[dict]:
    """按市场索引更新已装包（缺省 = 全部）；CLI 与 HTTP 共用这一份实现。"""
    st = status(cfg, include_market=False)
    names = [name] if name else [r["name"] for r in st["installed"] if r.get("installed")]
    if not names:
        raise PackError("没有可更新的已装包")
    results: list[dict] = []
    for n in names:
        entry = market_entry(cfg, n)
        if not entry:
            log(f"[elab] ! {n} 不在市场索引中，跳过")
            continue
        cur = next((r for r in st["installed"] if r["name"] == n), {})
        if cur.get("version") == entry.get("version") and not force:
            log(f"[elab] — {n} 已是最新 v{entry.get('version')}")
            continue
        kwargs = entry_source(entry, entry.get("_base", ""))
        results.append(install(cfg, sha256=entry.get("sha256"), force=True,
                               status=entry.get("status"), log=log, **kwargs))
    return results


def regenerate_skills(cfg, chip_refs, log=print) -> list[dict]:
    """安装/启用后重生成平台 skill（失败只提示，不回滚安装）。

    ★ 只在**当前启用包**的芯片上生成：一次只启用一套，skill 也应只描述这一套。
    """
    if not chip_refs:
        return []
    cfg2 = Config(cfg.root)          # 重载：新包已落盘
    written: list[dict] = []
    seen: set = set()
    for ref in chip_refs:
        chip = cfg2.chips.get(ref)
        if not chip:
            continue
        key = (chip.get("vendor"), chip.get("platform") or chip.get("id"))
        if key in seen:
            continue
        seen.add(key)
        try:
            written += skillgen.generate(cfg2, chip_ref=ref, log=log)
        except ElabError as exc:
            log(f"[elab] ! 平台 skill 未生成：{exc}")
            break
    return written


def prune_skills(cfg, platforms, log=print) -> list[dict]:
    """卸载包后清理不再被任何已装芯片使用的平台 skill（含 DSH 镜像）。"""
    cfg2 = Config(cfg.root)
    alive = {(c.get("vendor"), c.get("platform") or c.get("id"))
             for c in cfg2.chips.values()}
    removed: list[dict] = []
    for vendor, platform in platforms:
        if (vendor, platform) in alive:
            continue
        for path in (cfg2.root / "skills" / vendor / platform / "SKILL.md",
                     cfg2.root / ".agents" / "skills" / platform / "SKILL.md"):
            try:
                path.unlink()
            except OSError:
                continue
            removed.append({"path": to_fwd(path)})
            log(f"[elab] — 已清理平台 skill：{to_fwd(path)}")
    return removed


# ── 市场索引 ──────────────────────────────────────────────────────
def market_spec(cfg) -> str:
    spec = os.environ.get("ELAB_MARKET_INDEX")
    if not spec:
        try:
            spec = ((cfg.host or {}).get("packs") or {}).get("market")
        except ElabError:
            spec = None
    if not spec:
        local = Path(cfg.root) / "market" / "index.json"
        spec = to_fwd(local) if local.exists() else ""
    if not spec:
        return ""
    spec = cfg.resolve(str(spec), {"ELAB_ROOT": to_fwd(cfg.root)})
    if spec.startswith(("http://", "https://")):
        return spec
    p = Path(spec)
    return to_fwd(p if p.is_absolute() else Path(cfg.root) / p)


def load_market(cfg) -> dict:
    """读取市场索引（本地文件 / HTTP raw URL，带 ``.work`` 缓存回退）。"""
    spec = market_spec(cfg)
    if not spec:
        return {"path": "", "schema_version": PACK_SCHEMA_VERSION,
                "packs": [], "error": "未配置市场索引（elab.host.yaml: packs.market）"}
    p = Path(spec)
    warn = ""
    remote_ok = False
    if spec.startswith(("http://", "https://")):
        hit = _MARKET_CACHE.get(spec)
        if hit is not None and time.monotonic() - hit[0] < _MARKET_TTL_S:
            # 浅拷贝即可：消费方（status/market_entry）只读，不原地改。
            return dict(hit[1])
        cache = Path(cfg.root) / ".work" / "pkg" / "market.json"
        try:
            with urllib.request.urlopen(spec, timeout=15) as resp:  # noqa: S310
                raw = resp.read()
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(raw)
            path = spec
            remote_ok = True
        except Exception as exc:                   # noqa: BLE001
            if cache.exists():
                raw = cache.read_bytes()
                path = to_fwd(cache)
                warn = f"远程市场索引不可达，已用缓存：{exc}"
            else:
                # 零服务器兜底：仓库自带 market/index.json（离线可用）
                local = Path(cfg.root) / "market" / "index.json"
                if not local.exists():
                    return {"path": spec, "schema_version": PACK_SCHEMA_VERSION,
                            "packs": [], "error": f"市场索引不可达：{exc}"}
                raw = local.read_bytes()
                path = to_fwd(local)
                warn = f"远程市场索引不可达，已回退本仓索引：{exc}"
    else:
        try:
            raw = p.read_bytes()
        except OSError as exc:
            return {"path": to_fwd(p), "schema_version": PACK_SCHEMA_VERSION,
                    "packs": [], "error": f"市场索引不可读：{exc}"}
        path = to_fwd(p)
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        return {"path": path, "schema_version": PACK_SCHEMA_VERSION,
                "packs": [], "error": f"市场索引 JSON 解析失败：{exc}"}
    data.setdefault("schema_version", PACK_SCHEMA_VERSION)
    data.setdefault("packs", [])
    data["path"] = path
    if warn:
        data["warning"] = warn
    if path.startswith(("http://", "https://")):
        data["_base"] = path
    elif Path(path).resolve().parent == (Path(cfg.root) / "market").resolve():
        # 仓库内市场索引：source.path 约定相对仓库根（packs/official/...）
        data["_base"] = to_fwd(cfg.root)
    else:
        data["_base"] = to_fwd(Path(path).parent)
    if remote_ok:
        _MARKET_CACHE[spec] = (time.monotonic(), data)
    return data


def entry_source(entry: dict, base: str) -> dict:
    """把市场条目的 ``source`` 解析成 install 参数。"""
    src = entry.get("source") or {}
    typ = str(src.get("type") or "local")
    if typ == "local":
        root = Path(base)
        return {"local": str((root / str(src.get("path") or "")).resolve())}
    if typ == "git":
        return {"git": str(src.get("url") or ""), "ref": src.get("ref") or "",
                "subdir": src.get("subdir") or ""}
    if typ == "archive":
        return {"archive": str(src.get("url") or "")}
    raise PackError(f"未知 source.type：{typ!r}")


def market_entry(cfg, name: str) -> dict | None:
    market = load_market(cfg)
    for entry in market.get("packs") or []:
        if entry.get("name") == name:
            entry = dict(entry)
            entry["_base"] = market.get("_base", to_fwd(cfg.root))
            return entry
    return None


def entry_matches(entry: dict, query: str) -> bool:
    """市场条目是否命中查询（名称 / 厂商 / 平台 / 芯片 / 描述 / license）。"""
    q = (query or "").lower().strip()
    if not q:
        return True
    blob = " ".join(str(entry.get(k) or "") for k in
                    ("name", "vendor", "platform", "description", "license"))
    blob += " " + " ".join(str(x) for x in (entry.get("chips") or []))
    return q in blob.lower()


def search(cfg, query: str = "") -> list[dict]:
    """搜索市场索引（名称 / 厂商 / 平台 / 芯片 / 描述）。"""
    market = load_market(cfg)
    installed = discover(cfg)
    out = []
    for entry in market.get("packs") or []:
        if not entry_matches(entry, query):
            continue
        e = dict(entry)
        e["installed"] = bool((installed.get(entry.get("name")) or {}).get("installed"))
        e["_base"] = market.get("_base", "")
        out.append(e)
    return out


def build_index(root: Path, base: Path, *, status: str | None = None,
                keep: list[dict] | None = None) -> dict:
    """由包目录生成市场索引（确定性：无时间戳，哈希稳定）。

    ``keep`` 是旧索引里的条目：不在本仓的**外置包**（git/archive source）
    会被保留，这样"由官方包重新生成索引"不会把社区/外置包冲掉。
    """
    root, base = Path(root), Path(base)
    entries = []
    local_names: set[str] = set()
    for path in sorted(root.rglob(PACK_FILE)):
        pack_dir = path.parent
        man = read_manifest(pack_dir)
        problems = validate_manifest(man, pack_dir)
        if problems:
            raise PackError(f"生成索引时包校验失败：{pack_dir}\n  - "
                            + "\n  - ".join(problems))
        try:
            rel = pack_dir.resolve().relative_to(base.resolve()).as_posix()
        except ValueError:
            rel = to_fwd(pack_dir)
        local_names.add(str(man["name"]))
        entries.append({
            "name": man["name"],
            "vendor": man["vendor"],
            "platform": man["platform"],
            "version": man["version"],
            "description": man.get("description") or "",
            "status": status or man.get("status") or "official",
            "license": man["license"],
            "requires": man.get("requires") or {},
            "chips": refs_in_pack(pack_dir),
            "source": {"type": "local", "path": rel},
            "sha256": tree_hash(pack_dir),
        })
    for entry in (keep or []):
        name = str(entry.get("name") or "")
        src = entry.get("source") or {}
        if not name or name in local_names:
            continue
        if str(src.get("type") or "local") == "local":
            # 本仓缺失的 local 条目 = 已删除的包，不保留
            continue
        entries.append(dict(entry))
    entries.sort(key=lambda e: str(e.get("name")))
    return {"schema_version": PACK_SCHEMA_VERSION, "packs": entries}


def index_problems(root: Path, base: Path, index_path: Path) -> list[str]:
    """``elab pkg index --check``：本地包与索引是否漂移。

    只对 ``source.type=local`` 的条目做严格比对；git/archive 外置条目
    由各自的仓库负责，不参与本仓校验。
    """
    try:
        actual = json.loads(Path(index_path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [f"索引不可读：{exc}"]
    expected = build_index(root, base)
    problems = []
    a_by = {e.get("name"): e for e in actual.get("packs") or []}
    e_names = [e.get("name") for e in expected.get("packs") or []]
    for e in expected.get("packs") or []:
        cur = a_by.get(e["name"])
        if not cur:
            problems.append(f"索引缺少内置包：{e['name']}")
            continue
        for key in ("version", "sha256", "license", "requires", "chips", "source"):
            if cur.get(key) != e.get(key):
                problems.append(f"{e['name']} 的 {key} 漂移：索引={cur.get(key)!r}，"
                                f"实际={e.get(key)!r}")
    for name, cur in a_by.items():
        src = (cur.get("source") or {}).get("type") or "local"
        if src == "local" and name not in e_names:
            problems.append(f"索引含已删除的内置包：{name}")
    return problems


# ── 驾驶舱投影 ────────────────────────────────────────────────────
def status(cfg, *, include_market=True, query: str = "") -> dict:
    """给 ``/api/packs`` / capabilities 用的只读投影。"""
    packs = discover(cfg)
    roots = pack_roots(cfg)
    active = active_pack(cfg, packs)
    active_name = (active or {}).get("name") or ""
    installed = []
    for rec in packs.values():
        man = rec["manifest"]
        installed.append({
            "name": rec["name"],
            "version": man.get("version"),
            "vendor": man.get("vendor"),
            "platform": man.get("platform"),
            "status": rec["status"],
            "license": man.get("license"),
            "description": man.get("description") or "",
            "dir": rec["dir"],
            "installed": rec["installed"],
            # ★ 一次只启用一套：界面据此画「启用中 / 启用」按钮
            "active": rec["name"] == active_name,
            "sha256": rec["sha256"],
            "chips": rec["chips"],
            "requires": man.get("requires") or {},
            "compatible": {"ok": not check_requires(man), "reasons": check_requires(man)},
        })
    data = {
        "roots": [to_fwd(p) for p in roots],
        "install_root": to_fwd(install_root(cfg)),
        "official_root": to_fwd(official_root(cfg)),
        "active": active_name,
        "installed": installed,
        # 芯片只来自**当前启用包**（与 Config.chips 同一事实源）
        "chips": sorted({c for r in installed if r["active"] for c in r["chips"]}),
        "schema_version": PACK_SCHEMA_VERSION,
        "kernel_api": KERNEL_API_VERSION,
    }
    if include_market:
        market = load_market(cfg)
        installed_names = {r["name"] for r in installed if r["installed"]}
        data["market"] = {
            "path": market.get("path", ""),
            "error": market.get("error"),
            "warning": market.get("warning"),
            "packs": [{**e, "installed": e.get("name") in installed_names,
                       "compatible": {"ok": not check_requires(e), "reasons": check_requires(e)}}
                      for e in market.get("packs") or []
                      if entry_matches(e, query)],
        }
    return data
