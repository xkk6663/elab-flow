"""elab.lock —— 工具链可复现锁定（``elab.lock.yaml``）。

设计依据：技术方案 §10.3。要点：

- lock 放在工作区根，与 ``elab.host.yaml`` 同级，**入项目组仓**；
- 内容由安装器/``elab lock`` 回填，不靠人写；
- ``doctor`` 比对实际安装版本，默认 **warn**；``--strict-lock`` 升级为失败。

格式::

    packs:
      espressif/esp32: 0.1.0
    providers:
      espressif/idf: 1.2.0
    host:
      idf_version: "6.1"
"""

from __future__ import annotations

from pathlib import Path

from . import _yaml
from .config import Config, ElabError, Host, to_fwd
from . import provider as provider_mod

LOCK_FILE = "elab.lock.yaml"


def path(cfg: Config) -> Path:
    return Path(cfg.root) / LOCK_FILE


def load(cfg: Config) -> dict:
    p = path(cfg)
    if not p.exists():
        return {}
    try:
        data = _yaml.load_file(p) or {}
    except Exception as exc:                      # noqa: BLE001
        raise ElabError(f"lock 解析失败：{to_fwd(p)}：{exc}") from exc
    return data if isinstance(data, dict) else {}


def _actual(cfg: Config) -> dict:
    """当前工作区实际版本（只认已安装/已启用的东西）。"""
    packs: dict[str, str] = {}
    for name, rec in cfg.packs.items():
        if rec.get("installed"):
            man = rec.get("manifest") or {}
            packs[name] = str(man.get("version") or "")
    providers: dict[str, str] = {}
    try:
        reg = provider_mod.ProviderRegistry(cfg)
        for name, prov in reg.providers.items():
            providers[name] = prov.ref.version
    except ElabError:
        pass
    try:
        host = {"idf_version": str(Host(cfg).idf_version or "")}
    except ElabError:
        host = {}
    return {"packs": packs, "providers": providers, "host": host}


def drift(cfg: Config, *, strict: bool = False) -> list[dict]:
    """比对 lock 与实际版本 → ``[{key, expected, actual, ok}]``。

    lock 不存在 → 返回 ``lock.missing`` 一条；strict 由调用方决定是否升级失败。
    """
    lock = load(cfg)
    if not lock:
        return [{"key": "lock", "expected": LOCK_FILE, "actual": "缺失",
                 "ok": False, "code": "lock.missing"}]
    act = _actual(cfg)
    out: list[dict] = []
    for section, values in (("packs", lock.get("packs") or {}),
                            ("providers", lock.get("providers") or {}),
                            ("host", lock.get("host") or {})):
        if not isinstance(values, dict):
            continue
        for key, expected in values.items():
            got = (act.get(section) or {}).get(str(key), "")
            ok = str(got) == str(expected)
            out.append({"section": section, "key": str(key),
                        "expected": str(expected), "actual": str(got), "ok": ok})
    return out


def render_drift(items: list[dict]) -> str:
    lines = []
    for it in items:
        if it.get("ok"):
            continue
        lines.append(f"  {it.get('section', '')}.{it['key']}: lock={it['expected']} "
                     f"实际={it['actual'] or '(未安装)'}")
    return "\n".join(lines)


_INSTALL_META_FIELD = ("packs", "providers")


def write(cfg: Config, *, log=print) -> dict:
    """按当前实际安装回填 lock（安装器/``elab lock`` 用）。"""
    act = _actual(cfg)
    L: list[str] = ["# elab.lock.yaml —— 由 `elab lock` 回填，请勿手改",
                    "schema_version: 1"]
    for section in _INSTALL_META_FIELD:
        values = act.get(section) or {}
        L.append(f"{section}:")
        if not values:
            L.append("  {}")
        for name, ver in sorted(values.items()):
            L.append(f"  {name}: {ver}")
    L.append("host:")
    for key, ver in sorted((act.get("host") or {}).items()):
        if ver:
            L.append(f'  {key}: "{ver}"')
    text = "\n".join(L) + "\n"
    p = path(cfg)
    p.write_text(text, encoding="utf-8")
    log(f"[elab] ✓ 已写入 {to_fwd(p)}")
    return {"path": to_fwd(p), "content": text}


def check_into(rep, cfg: Config, *, strict: bool = False) -> None:
    """把 lock 漂移写进 doctor 报告（warn / strict→fail）。"""
    items = drift(cfg, strict=strict)
    bad = [i for i in items if not i.get("ok")]
    if not bad:
        if items:
            rep.info("lock.ok", f"{LOCK_FILE} 与已安装版本一致（{len(items)} 项）")
        return
    detail = render_drift(bad)
    if strict:
        rep.fail("lock.drift", f"{LOCK_FILE} 与已安装版本不一致（--strict-lock）：\n{detail}")
    else:
        rep.warn("lock.drift", f"{LOCK_FILE} 与已安装版本不一致（不阻断；"
                                f"用 --strict-lock 升级为失败）：\n{detail}")


__all__ = ["LOCK_FILE", "check_into", "drift", "load", "path",
           "render_drift", "write"]
