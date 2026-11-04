"""elab.serialframes —— 自定义帧协议 profile（M5）。

存储：``projects/<name>.frames.json``（原子写 + ``rev`` 乐观锁）。
校验：**配置错误在保存时一次说清**（哪个字段、哪条规则），而不是等解码时才炸。

边界
----
只做"配置"的读写与规整；切帧/字段解释在 ``serialcodec``（通用解释器）；
面板只渲染 ``fields`` 与预览结果，不写死任何厂商协议。
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

from .config import Config

MAX_PROFILES = 32
MAX_FIELDS = 64
MAX_FRAME = 256
MAX_FILE = 64 << 10

PROFILE_ID_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
TYPES = ("u8", "u16", "u24", "u32", "i8", "i16", "i24", "i32",
         "f32", "f64", "ascii", "bytes")
NUMERIC = {"u8", "u16", "u24", "u32", "i8", "i16", "i24", "i32", "f32", "f64"}
ENDIANS = ("le", "be")
CHECKS = ("none", "sum8", "xor8", "crc16modbus")
TYPE_SIZE = {"u8": 1, "u16": 2, "u24": 3, "u32": 4, "i8": 1, "i16": 2,
             "i24": 3, "i32": 4, "f32": 4, "f64": 8}


# ── 路径 ─────────────────────────────────────────────────────────
def frames_path(cfg: Config, project: str) -> Path:
    proj = cfg.resolved_project(project)
    raw = str(proj.get("_path") or "")
    if raw:
        p = Path(raw)
        if not p.is_absolute():
            p = Path(cfg.root) / p
        return p.with_name(p.stem + ".frames.json")
    return Path(cfg.root) / "projects" / f"{project}.frames.json"


def _empty() -> dict:
    return {"version": 1, "rev": 0, "profiles": []}


def _read(path: Path) -> dict:
    if not path.exists():
        return _empty()
    if path.stat().st_size > MAX_FILE:
        raise ValueError(f"frames 文件超过 {MAX_FILE} 字节：{path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"frames 文件不是合法 JSON：{exc}")
    if not isinstance(raw, dict):
        raise ValueError("frames 文件顶层必须是对象")
    raw.setdefault("version", 1)
    raw.setdefault("rev", 0)
    raw.setdefault("profiles", [])
    if not isinstance(raw["profiles"], list):
        raise ValueError("profiles 必须是数组")
    return raw


def _atomic_write(path: Path, doc: dict) -> None:
    text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    if len(text.encode("utf-8")) > MAX_FILE:
        raise ValueError(f"保存后超过 {MAX_FILE} 字节，请减少 profile/字段")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp",
                               dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


# ── 校验 / 规整 ──────────────────────────────────────────────────
def _hex_bytes(value, key: str) -> bytes:
    if value in (None, ""):
        return b""
    text = "".join(str(value).split())
    if len(text) % 2:
        raise ValueError(f"{key} 必须是偶数个十六进制字符：{value!r}")
    try:
        return bytes.fromhex(text)
    except ValueError as exc:
        raise ValueError(f"{key} 不是合法十六进制：{exc}")


def normalize_profile(raw: dict) -> dict:
    """校验并补默认值。任何配置错误抛 ``ValueError``（一次说清）。"""
    if not isinstance(raw, dict):
        raise ValueError("profile 必须是对象")
    pid = str(raw.get("id") or "").strip()
    if not PROFILE_ID_RE.match(pid):
        raise ValueError(f"id 必须是 [a-z0-9_-]{{1,32}}：{pid!r}")
    label = str(raw.get("label") or pid).strip() or pid
    kind = str(raw.get("kind") or "binary").strip().lower()
    if kind != "binary":
        raise ValueError(f"kind 目前只支持 binary：{kind!r}")

    fr = raw.get("frame") or {}
    if not isinstance(fr, dict):
        raise ValueError("frame 必须是对象")
    head = _hex_bytes(fr.get("head_hex"), "frame.head_hex")
    tail = _hex_bytes(fr.get("tail_hex"), "frame.tail_hex")
    length = fr.get("length")
    if length is not None:
        try:
            length = int(length)
        except (TypeError, ValueError):
            raise ValueError(f"frame.length 必须是整数或 null：{length!r}")
        if not (1 <= length <= MAX_FRAME):
            raise ValueError(f"frame.length 必须在 1..{MAX_FRAME}：{length}")
    max_bytes = fr.get("max_bytes", MAX_FRAME)
    try:
        max_bytes = int(max_bytes)
    except (TypeError, ValueError):
        raise ValueError(f"frame.max_bytes 必须是整数：{max_bytes!r}")
    max_bytes = min(MAX_FRAME, max(1, max_bytes))
    if not head and not length:
        raise ValueError("frame 至少要配置 head_hex 或 length（否则无法切帧）")
    if length and length > max_bytes:
        raise ValueError("frame.length 不能大于 max_bytes")

    ck = raw.get("checksum") or {}
    if isinstance(ck, str):
        ck = {"kind": ck}
    if not isinstance(ck, dict):
        raise ValueError("checksum 必须是对象或字符串")
    ck_kind = str(ck.get("kind") or "none").strip().lower()
    if ck_kind not in CHECKS:
        raise ValueError(f"checksum.kind 必须是 {'/'.join(CHECKS)}：{ck_kind!r}")
    ck_at = str(ck.get("at") or "tail").strip().lower()
    if ck_at not in ("tail", "head"):
        raise ValueError(f"checksum.at 必须是 tail/head：{ck_at!r}")

    fields = raw.get("fields") or []
    if not isinstance(fields, list):
        raise ValueError("fields 必须是数组")
    if len(fields) > MAX_FIELDS:
        raise ValueError(f"字段数 {len(fields)} 超过上限 {MAX_FIELDS}")
    out_fields = []
    names = set()
    for i, f in enumerate(fields):
        if not isinstance(f, dict):
            raise ValueError(f"fields[{i}] 必须是对象")
        name = str(f.get("name") or "").strip()
        if not name:
            raise ValueError(f"fields[{i}] 缺 name")
        if name in names:
            raise ValueError(f"字段名重复：{name!r}")
        names.add(name)
        typ = str(f.get("type") or "").strip().lower()
        if typ not in TYPES:
            raise ValueError(f"{name}.type 必须是 {'/'.join(TYPES)}：{typ!r}")
        try:
            offset = int(f.get("offset"))
        except (TypeError, ValueError):
            raise ValueError(f"{name}.offset 必须是整数：{f.get('offset')!r}")
        if offset < 0:
            raise ValueError(f"{name}.offset 不能为负")
        endian = str(f.get("endian") or "le").strip().lower()
        if typ in NUMERIC and endian not in ENDIANS:
            raise ValueError(f"{name}.endian 必须是 le/be：{endian!r}")
        flen = f.get("length")
        if typ in ("ascii", "bytes"):
            try:
                flen = int(flen)
            except (TypeError, ValueError):
                raise ValueError(f"{name}.length 必须是正整数")
            if not (1 <= flen <= MAX_FRAME):
                raise ValueError(f"{name}.length 必须在 1..{MAX_FRAME}")
        else:
            flen = TYPE_SIZE[typ]
        try:
            scale = float(f.get("scale", 1))
            bias = float(f.get("bias", 0))
        except (TypeError, ValueError):
            raise ValueError(f"{name}.scale/bias 必须是数字")
        enum = f.get("enum")
        if enum is not None:
            if not isinstance(enum, dict):
                raise ValueError(f"{name}.enum 必须是对象")
            if typ not in ("u8", "u16", "u24", "u32", "i8", "i16", "i24", "i32"):
                raise ValueError(f"{name}.enum 只对整型字段有效")
            enum = {str(k): str(v) for k, v in enum.items()}
        plot = bool(f.get("plot", typ in NUMERIC))
        if typ in ("ascii", "bytes"):
            plot = False
        if enum:
            # 枚举解出的是状态文本（如 RUN），不是数 —— 不能作为波形通道
            plot = False
        if length and offset + flen > length:
            raise ValueError(
                f"{name} 越过帧长：offset {offset} + {flen} > length {length}")
        if offset + flen > max_bytes:
            raise ValueError(
                f"{name} 越过 max_bytes：offset {offset} + {flen} > {max_bytes}")
        out_fields.append({"name": name, "unit": str(f.get("unit") or ""),
                           "offset": offset, "type": typ,
                           "endian": endian, "length": flen,
                           "scale": scale, "bias": bias,
                           "enum": enum, "plot": bool(plot)})

    return {
        "id": pid, "label": label, "kind": kind,
        "frame": {"head_hex": head.hex(), "tail_hex": tail.hex(),
                  "length": length, "max_bytes": max_bytes},
        "checksum": {"kind": ck_kind, "at": ck_at},
        "fields": out_fields,
    }


def _warnings(p: dict) -> list[str]:
    out = []
    fr = p["frame"]
    if fr["head_hex"] and not fr["tail_hex"] and not fr["length"]:
        out.append(f"{p['id']}：没有 tail/length，按相邻 head 切帧；"
                   f"粘帧残留会算作坏帧")
    if p["checksum"]["kind"] != "none" and not (fr["tail_hex"] or fr["length"]):
        out.append(f"{p['id']}：校验和需要 tail 或 length 才能定位帧尾")
    return out


# ── 对外 API ─────────────────────────────────────────────────────
def load(cfg: Config, project: str) -> dict:
    """读全部 profile（含 rev 与 warnings）。文件不存在 = rev 0 + 空表。"""
    path = frames_path(cfg, project)
    try:
        doc = _read(path)
    except ValueError as exc:
        return {"ok": False, "error": str(exc), "rev": 0, "profiles": [],
                "warnings": [], "path": str(path)}
    warnings: list[str] = []
    profiles = []
    for raw in doc["profiles"]:
        try:
            p = normalize_profile(raw)
        except ValueError as exc:
            warnings.append(f"跳过非法 profile：{exc}")
            continue
        warnings.extend(_warnings(p))
        profiles.append(p)
    return {"ok": True, "rev": int(doc.get("rev") or 0),
            "profiles": profiles, "warnings": warnings, "path": str(path)}


def get(cfg: Config, project: str, pid: str) -> dict | None:
    pid = (pid or "").strip()
    for p in load(cfg, project).get("profiles") or []:
        if p["id"] == pid:
            return p
    return None


def save(cfg: Config, project: str, rev: int, profile: dict) -> dict:
    """新增或覆盖一个 profile。``rev`` 不匹配返回 conflict（不覆盖别人改动）。"""
    path = frames_path(cfg, project)
    try:
        doc = _read(path)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    current = int(doc.get("rev") or 0)
    if int(rev) != current:
        return {"ok": False, "conflict": True, "rev": current,
                "error": f"配置已被别处修改（rev {rev} → {current}），请刷新后重试"}
    try:
        p = normalize_profile(profile)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    items = list(doc["profiles"])
    hit = next((i for i, x in enumerate(items)
                if isinstance(x, dict) and x.get("id") == p["id"]), None)
    if hit is None:
        if len(items) >= MAX_PROFILES:
            return {"ok": False, "error": f"profile 数已达上限 {MAX_PROFILES}"}
        items.append(p)
    else:
        items[hit] = p
    doc = {"version": 1, "rev": current + 1, "profiles": items}
    try:
        _atomic_write(path, doc)
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": f"保存失败：{exc}"}
    return {"ok": True, "rev": current + 1, "profiles": load(cfg, project)["profiles"]}


def delete(cfg: Config, project: str, rev: int, pid: str) -> dict:
    path = frames_path(cfg, project)
    try:
        doc = _read(path)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    current = int(doc.get("rev") or 0)
    if int(rev) != current:
        return {"ok": False, "conflict": True, "rev": current,
                "error": f"配置已被别处修改（rev {rev} → {current}），请刷新后重试"}
    items = [x for x in doc["profiles"]
             if not (isinstance(x, dict) and x.get("id") == pid)]
    if len(items) == len(doc["profiles"]):
        return {"ok": False, "error": f"没有这个 profile：{pid!r}"}
    doc = {"version": 1, "rev": current + 1, "profiles": items}
    try:
        _atomic_write(path, doc)
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": f"保存失败：{exc}"}
    return {"ok": True, "rev": current + 1, "profiles": load(cfg, project)["profiles"]}
