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
MAX_VARIANTS = 16

PROFILE_ID_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
TYPES = ("u8", "u16", "u24", "u32", "i8", "i16", "i24", "i32",
         "f32", "f64", "ascii", "bytes")
NUMERIC = {"u8", "u16", "u24", "u32", "i8", "i16", "i24", "i32", "f32", "f64"}
INTEGERS = {"u8", "u16", "u24", "u32", "i8", "i16", "i24", "i32"}
ENDIANS = ("le", "be")
CHECKS = ("none", "sum8", "xor8", "crc16modbus")
BIT_ORDERS = ("lsb0", "msb0")
LENGTH_FIELD_TYPES = ("u8", "u16")
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


def _normalize_checksum(raw, key: str = "checksum") -> dict:
    if raw in (None, ""):
        raw = {}
    if isinstance(raw, str):
        raw = {"kind": raw}
    if not isinstance(raw, dict):
        raise ValueError(f"{key} 必须是对象或字符串")
    kind = str(raw.get("kind") or "none").strip().lower()
    if kind not in CHECKS:
        raise ValueError(f"{key}.kind 必须是 {'/'.join(CHECKS)}：{kind!r}")
    at = str(raw.get("at") or "tail").strip().lower()
    if at not in ("tail", "head"):
        raise ValueError(f"{key}.at 必须是 tail/head：{at!r}")
    return {"kind": kind, "at": at}


def _read_spec(raw, key: str, *, max_bytes: int, bits: bool = True) -> dict:
    """规整 ``id_field`` / ``length_field`` 这类"从帧里读一个数"的描述。"""
    if not isinstance(raw, dict):
        raise ValueError(f"{key} 必须是对象")
    typ = str(raw.get("type") or "u8").strip().lower()
    if typ not in INTEGERS:
        raise ValueError(f"{key}.type 必须是整数类型：{typ!r}")
    try:
        offset = int(raw.get("offset"))
    except (TypeError, ValueError):
        raise ValueError(f"{key}.offset 必须是整数：{raw.get('offset')!r}")
    if offset < 0:
        raise ValueError(f"{key}.offset 不能为负")
    endian = str(raw.get("endian") or "le").strip().lower()
    if endian not in ENDIANS:
        raise ValueError(f"{key}.endian 必须是 le/be：{endian!r}")
    out = {"offset": offset, "type": typ, "endian": endian}
    span = TYPE_SIZE[typ]
    if bits:
        try:
            bit_offset = int(raw.get("bit_offset") or 0)
        except (TypeError, ValueError):
            raise ValueError(f"{key}.bit_offset 必须是整数")
        if not (0 <= bit_offset <= 7):
            raise ValueError(f"{key}.bit_offset 必须在 0..7：{bit_offset}")
        bit_length = raw.get("bit_length")
        if bit_length is not None:
            try:
                bit_length = int(bit_length)
            except (TypeError, ValueError):
                raise ValueError(f"{key}.bit_length 必须是整数")
            if not (1 <= bit_length <= 32):
                raise ValueError(f"{key}.bit_length 必须在 1..32：{bit_length}")
            order = str(raw.get("bit_order") or "lsb0").strip().lower()
            if order not in BIT_ORDERS:
                raise ValueError(
                    f"{key}.bit_order 必须是 {'/'.join(BIT_ORDERS)}：{order!r}")
            out.update({"bit_offset": bit_offset, "bit_length": bit_length,
                        "bit_order": order})
            span = (bit_offset + bit_length + 7) // 8
        elif bit_offset:
            raise ValueError(f"{key}.bit_offset 需要同时给 bit_length")
    if offset + span > max_bytes:
        raise ValueError(f"{key} 越过 max_bytes：offset {offset} + {span} > {max_bytes}")
    return out


def _length_field(raw, max_bytes: int) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("frame.length_field 必须是对象")
    typ = str(raw.get("type") or "u8").strip().lower()
    if typ not in LENGTH_FIELD_TYPES:
        raise ValueError(f"frame.length_field.type 只能 {'/'.join(LENGTH_FIELD_TYPES)}：{typ!r}")
    try:
        offset = int(raw.get("offset"))
    except (TypeError, ValueError):
        raise ValueError(f"frame.length_field.offset 必须是整数：{raw.get('offset')!r}")
    if not (0 <= offset):
        raise ValueError("frame.length_field.offset 不能为负")
    endian = str(raw.get("endian") or "le").strip().lower()
    if endian not in ENDIANS:
        raise ValueError(f"frame.length_field.endian 必须是 le/be：{endian!r}")
    try:
        mul = float(raw.get("mul", 1))
        add = float(raw.get("add", 0))
    except (TypeError, ValueError):
        raise ValueError("frame.length_field.mul/add 必须是数字")
    if mul == 0:
        raise ValueError("frame.length_field.mul 不能为 0")
    mul = int(mul) if mul.is_integer() else mul
    add = int(add) if float(add).is_integer() else add
    if offset + TYPE_SIZE[typ] > max_bytes:
        raise ValueError(
            f"frame.length_field 越过 max_bytes：offset {offset} + "
            f"{TYPE_SIZE[typ]} > {max_bytes}")
    return {"offset": offset, "type": typ, "endian": endian,
            "mul": mul, "add": add}


def _normalize_field(f, key: str, *, max_bytes: int,
                     frame_length: int | None) -> dict:
    if not isinstance(f, dict):
        raise ValueError(f"{key} 必须是对象")
    name = str(f.get("name") or "").strip()
    if not name:
        raise ValueError(f"{key} 缺 name")
    typ = str(f.get("type") or "").strip().lower()
    if typ not in TYPES:
        raise ValueError(f"{key}.type 必须是 {'/'.join(TYPES)}：{typ!r}")
    try:
        offset = int(f.get("offset"))
    except (TypeError, ValueError):
        raise ValueError(f"{key}.offset 必须是整数：{f.get('offset')!r}")
    if offset < 0:
        raise ValueError(f"{key}.offset 不能为负")
    endian = str(f.get("endian") or "le").strip().lower()
    if typ in NUMERIC and endian not in ENDIANS:
        raise ValueError(f"{key}.endian 必须是 le/be：{endian!r}")
    bit_length = f.get("bit_length")
    bit_offset = int(f.get("bit_offset") or 0)
    bit_order = str(f.get("bit_order") or "lsb0").strip().lower()
    if bit_length is not None:
        if typ not in INTEGERS:
            raise ValueError(f"{key}.bit_length 只对整型字段有效（当前 {typ}）")
        try:
            bit_length = int(bit_length)
        except (TypeError, ValueError):
            raise ValueError(f"{key}.bit_length 必须是整数")
        if not (1 <= bit_length <= 32):
            raise ValueError(f"{key}.bit_length 必须在 1..32：{bit_length}")
        if not (0 <= bit_offset <= 7):
            raise ValueError(f"{key}.bit_offset 必须在 0..7：{bit_offset}")
        if bit_order not in BIT_ORDERS:
            raise ValueError(
                f"{key}.bit_order 必须是 {'/'.join(BIT_ORDERS)}：{bit_order!r}")
    elif bit_offset:
        raise ValueError(f"{key}.bit_offset 需要同时给 bit_length")

    flen = f.get("length")
    if typ in ("ascii", "bytes"):
        try:
            flen = int(flen)
        except (TypeError, ValueError):
            raise ValueError(f"{key}.length 必须是正整数")
        if not (1 <= flen <= MAX_FRAME):
            raise ValueError(f"{key}.length 必须在 1..{MAX_FRAME}")
        span = flen
    elif bit_length is not None:
        flen = TYPE_SIZE[typ]
        span = (bit_offset + bit_length + 7) // 8
    else:
        flen = TYPE_SIZE[typ]
        span = flen
    try:
        scale = float(f.get("scale", 1))
        bias = float(f.get("bias", 0))
    except (TypeError, ValueError):
        raise ValueError(f"{key}.scale/bias 必须是数字")
    enum = f.get("enum")
    if enum is not None:
        if not isinstance(enum, dict):
            raise ValueError(f"{key}.enum 必须是对象")
        if typ not in INTEGERS:
            raise ValueError(f"{key}.enum 只对整型字段有效")
        enum = {str(k): str(v) for k, v in enum.items()}
    plot = bool(f.get("plot", typ in NUMERIC))
    if typ in ("ascii", "bytes"):
        plot = False
    if enum:
        # 枚举解出的是状态文本（如 RUN），不是数 —— 不能作为波形通道
        plot = False
    if frame_length and offset + span > frame_length:
        raise ValueError(
            f"{key}（{name}）越过帧长：offset {offset} + {span} > "
            f"length {frame_length}")
    if offset + span > max_bytes:
        raise ValueError(
            f"{key}（{name}）越过 max_bytes：offset {offset} + {span} > {max_bytes}")
    out = {"name": name, "unit": str(f.get("unit") or ""),
           "offset": offset, "type": typ,
           "endian": endian, "length": flen,
           "scale": scale, "bias": bias,
           "enum": enum, "plot": bool(plot)}
    if bit_length is not None:
        out.update({"bit_offset": bit_offset, "bit_length": bit_length,
                    "bit_order": bit_order})
    return out


def _normalize_fields(raw, key: str, *, max_bytes: int,
                      frame_length: int | None,
                      limit: int = MAX_FIELDS) -> list[dict]:
    if not isinstance(raw, list):
        raise ValueError(f"{key} 必须是数组")
    if len(raw) > limit:
        raise ValueError(f"{key} 字段数 {len(raw)} 超过上限 {limit}")
    out: list[dict] = []
    names: set[str] = set()
    for i, f in enumerate(raw):
        item = _normalize_field(f, f"{key}[{i}]", max_bytes=max_bytes,
                                frame_length=frame_length)
        if item["name"] in names:
            raise ValueError(f"{key} 字段名重复：{item['name']!r}")
        names.add(item["name"])
        out.append(item)
    return out


def _parse_variant_id(value, key: str) -> int:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"{key}.id 必须是整数或十六进制字符串")
    if isinstance(value, str):
        try:
            return int(value.strip(), 0)
        except ValueError:
            raise ValueError(f"{key}.id 不是合法整数：{value!r}")
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{key}.id 必须是整数或十六进制字符串：{value!r}")


def _faithful(a: dict, b: dict) -> bool:
    """同名跨 variant 的字段语义必须一致（offset 可以不同）。"""
    keys = ("type", "unit", "scale", "bias", "enum", "plot", "length",
            "bit_length", "bit_order", "endian")
    return all(a.get(k) == b.get(k) for k in keys)


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
    length_field = None
    if fr.get("length_field") is not None:
        if length is not None:
            raise ValueError("frame.length 与 frame.length_field 互斥")
        length_field = _length_field(fr.get("length_field"), max_bytes)
    id_field = None
    if fr.get("id_field") is not None:
        id_field = _read_spec(fr.get("id_field"), "frame.id_field",
                              max_bytes=max_bytes, bits=True)
    if not head and not length and not length_field:
        raise ValueError(
            "frame 至少要配置 head_hex 或 length（变长可用 length_field），"
            "否则无法切帧")
    if length and length > max_bytes:
        raise ValueError("frame.length 不能大于 max_bytes")

    ck = _normalize_checksum(raw.get("checksum"), "checksum")
    fields = _normalize_fields(raw.get("fields") or [], "fields",
                               max_bytes=max_bytes, frame_length=length)
    names = {f["name"] for f in fields}

    variants_raw = raw.get("variants") or []
    if not isinstance(variants_raw, list):
        raise ValueError("variants 必须是数组")
    if len(variants_raw) > MAX_VARIANTS:
        raise ValueError(f"variants 数 {len(variants_raw)} 超过上限 {MAX_VARIANTS}")
    variants: list[dict] = []
    seen_ids: set[int] = set()
    seen_fields: dict[str, dict] = {f["name"]: f for f in fields}
    for i, v in enumerate(variants_raw):
        if not isinstance(v, dict):
            raise ValueError(f"variants[{i}] 必须是对象")
        vid = _parse_variant_id(v.get("id"), f"variants[{i}]")
        if vid in seen_ids:
            raise ValueError(f"variants 的 id 重复：{vid}")
        seen_ids.add(vid)
        vlabel = str(v.get("label") or f"0x{vid:02X}").strip()
        vfields = _normalize_fields(v.get("fields") or [],
                                    f"variants[{i}].fields",
                                    max_bytes=max_bytes,
                                    frame_length=length,
                                    limit=MAX_FIELDS - len(fields))
        vck = (_normalize_checksum(v.get("checksum"), f"variants[{i}].checksum")
               if v.get("checksum") is not None else None)
        for f in vfields:
            if f["name"] in seen_fields and not _faithful(seen_fields[f["name"]], f):
                raise ValueError(
                    f"字段 {f['name']!r} 跨 variant 的 type/unit/scale/bias/"
                    f"enum/plot 必须一致")
            seen_fields[f["name"]] = f
        names.update(f["name"] for f in vfields)
        if len(names) > MAX_FIELDS:
            raise ValueError(f"所有字段名并集 {len(names)} 超过上限 {MAX_FIELDS}")
        item = {"id": vid, "label": vlabel, "fields": vfields}
        if vck is not None:
            item["checksum"] = vck
        variants.append(item)

    if variants and not id_field:
        raise ValueError("配置了 variants 就必须同时配置 frame.id_field")

    frame = {"head_hex": head.hex(), "tail_hex": tail.hex(),
             "length": length, "max_bytes": max_bytes}
    if length_field is not None:
        frame["length_field"] = length_field
    if id_field is not None:
        frame["id_field"] = id_field
    out = {"id": pid, "label": label, "kind": kind,
           "frame": frame, "checksum": ck, "fields": fields}
    if variants:
        out["variants"] = variants
    return out


def _warnings(p: dict) -> list[str]:
    out = []
    fr = p["frame"]
    if fr["head_hex"] and not fr["tail_hex"] and not fr["length"] \
            and not fr.get("length_field"):
        out.append(f"{p['id']}：没有 tail/length，按相邻 head 切帧；"
                   f"粘帧残留会算作坏帧")
    if p["checksum"]["kind"] != "none" \
            and not (fr["tail_hex"] or fr["length"] or fr.get("length_field")):
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


# ── 只读模板库（P1）──────────────────────────────────────────────
#: 模板只是**协议数据**，不是可执行代码，也不属于芯片适配包。
TEMPLATE_SUBDIR = Path("templates") / "frames"


def templates_dir(cfg: Config) -> Path:
    return Path(cfg.root) / TEMPLATE_SUBDIR


def list_templates(cfg: Config) -> dict:
    """清单 + 每个模板的**已校验** profile。坏模板不阻塞其余模板。"""
    root = templates_dir(cfg)
    templates: list[dict] = []
    errors: list[str] = []
    if root.is_dir():
        for path in sorted(root.glob("*.json")):
            try:
                if path.stat().st_size > MAX_FILE:
                    raise ValueError(f"模板超过 {MAX_FILE} 字节")
                raw = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):
                    raise ValueError("模板顶层必须是对象")
                prof = normalize_profile(raw)
                templates.append({
                    "id": prof["id"],
                    "label": prof["label"],
                    "desc": str(raw.get("desc") or ""),
                    "file": path.name,
                    "profile": prof,
                })
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                errors.append(f"跳过非法模板 {path.name}：{exc}")
    ids = [t["id"] for t in templates]
    if len(ids) != len(set(ids)):
        errors.append("模板 id 有重复：同一 id 只能出现一次")
    return {"ok": not errors, "templates": templates, "errors": errors,
            "path": str(root)}


def get_template(cfg: Config, tid: str) -> dict | None:
    tid = (tid or "").strip()
    for t in list_templates(cfg).get("templates") or []:
        if t["id"] == tid:
            return t
    return None


def import_template(cfg: Config, project: str, rev: int, tid: str,
                    new_id: str = "") -> dict:
    """按模板导入并保存。导入仍是 ``save`` 语义：带 rev，冲突不覆盖。"""
    t = get_template(cfg, tid)
    if t is None:
        return {"ok": False, "error": f"没有这个模板：{tid!r}"}
    prof = dict(t["profile"])
    if new_id.strip():
        prof["id"] = new_id.strip()
    res = save(cfg, project, rev, prof)
    if res.get("ok"):
        res["template"] = t["id"]
        res["imported"] = prof["id"]
    return res
