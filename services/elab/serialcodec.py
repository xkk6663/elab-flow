"""elab.serialcodec —— 串口协议**无状态**解码（JustFloat / FireWater）。

只做一件事：把一段原始字节解成"每帧若干通道的浮点值"。不碰串口、不落盘、
不认识 run —— 因此 web 与 agent 都能安全地反复调用（同一份实现，同一套结果）。

算法来源（按算法重写，非整文件移植）
----------------------------------
Lissio（Apache-2.0，commit edf17b5）的
``Lissio-Core/crates/protocol/protocol_float/src/justfloat.rs`` 与 FireWater 实现。
本文件只保留其**帧格式语义**：

    JustFloat   N×4 字节小端 float + 尾 ``00 00 80 7F``（+∞ 的小端形态）
    FireWater   ASCII 逗号分隔 float + ``\\n``

上游用"尾标记自动推断通道数"，本实现沿用；半帧（尾标记之前不完整 / 最后一行
没有换行）**不丢**，以 ``pending`` 原样返回，由调用方拼进下一批。
"""

from __future__ import annotations

import struct

PROFILE_TYPES = ("u8", "u16", "u24", "u32", "i8", "i16", "i24", "i32",
                 "f32", "f64", "ascii", "bytes")

#: JustFloat 的帧尾：float(+inf) 的小端字节序。
JUSTFLOAT_TAIL = b"\x00\x00\x80\x7f"

DECODERS = (
    {"id": "justfloat", "label": "JustFloat", "channels": "auto",
     "desc": "N×4 小端 float + 尾 00 00 80 7F"},
    {"id": "firewater", "label": "FireWater", "channels": "auto",
     "desc": "ASCII 逗号分隔 float + \\n"},
)


def _frames_justfloat(data: bytes, channels: int | None) -> tuple[list[list[float]], bytes, int]:
    frames: list[list[float]] = []
    pos = 0
    n = len(data)
    deduced = channels
    skipped = 0
    while pos < n:
        idx = data.find(JUSTFLOAT_TAIL, pos)
        if idx < 0:
            break                         # 尾标记之前剩余 = 半帧，留给下一批
        payload = data[pos:idx]
        count = len(payload) // 4
        # 字节数必须是 4 的倍数；且通道数一旦确定，后续帧必须一致。
        if len(payload) % 4 != 0 or count == 0 or \
                (deduced is not None and count != deduced):
            skipped += 1
            pos = idx + 4                 # 跳过这个候选尾，继续找下一个
            continue
        if deduced is None:
            deduced = count
        try:
            vals = list(struct.unpack("<%df" % count, payload))
        except struct.error:
            skipped += 1
            pos = idx + 4
            continue
        frames.append(vals)
        pos = idx + 4
    return frames, data[pos:], skipped


def _frames_firewater(data: bytes, channels: int | None) -> tuple[list[list[float]], bytes, int]:
    frames: list[list[float]] = []
    text = data.decode("utf-8", errors="replace")
    # 最后一行没有换行 → 半帧（可能只写了一部分数字）
    lines = text.split("\n")
    pending_text = lines.pop() if lines else text
    deduced = channels
    skipped = 0
    for line in lines:
        line = line.strip().rstrip("\r")
        if not line:
            continue
        parts = [p for p in line.split(",") if p.strip() != ""]
        if not parts:
            continue
        try:
            vals = [float(p) for p in parts]
        except ValueError:
            skipped += 1
            continue
        if deduced is None:
            deduced = len(vals)
        if len(vals) != deduced:
            skipped += 1
            continue
        frames.append(vals)
    return frames, pending_text.encode("utf-8"), skipped


def crc16modbus(data: bytes) -> int:
    """CRC16-Modbus（通用算法，不依赖第三方库）。"""
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if (crc & 1) else (crc >> 1)
    return crc & 0xFFFF


# ── 通用 CRC 引擎（P2.2-A）──────────────────────────────────────
#: 预设表：``(width, poly, init, xorout, refin, refout)``。
#: 只用参数化实现，不为每种算法各写一份 —— 解码与编码共用同一处，
#: 避免"解的时候对一个算法、编的时候对另一个算法"这种最难查的错。
CRC_PRESETS = {
    "crc8":             (8, 0x07, 0x00, 0x00000000, False, False),
    "crc8_maxim":       (8, 0x31, 0x00, 0x00000000, True, True),
    "crc8_j1850":       (8, 0x1D, 0xFF, 0x000000FF, False, False),
    "crc16_ccitt_false": (16, 0x1021, 0xFFFF, 0x0000, False, False),
    "crc16_xmodem":     (16, 0x1021, 0x0000, 0x0000, False, False),
    "crc16_x25":        (16, 0x1021, 0xFFFF, 0xFFFF, True, True),
    "crc16_modbus":     (16, 0x8005, 0xFFFF, 0x0000, True, True),
    "crc16_ibm":        (16, 0x8005, 0x0000, 0x0000, True, True),
    "crc32":            (32, 0x04C11DB7, 0xFFFFFFFF, 0xFFFFFFFF, True, True),
}

#: 老写法 → 预设名（``crc16modbus`` 是 P0 就有的快捷写法，必须一直认）。
CHECK_ALIASES = {"crc16modbus": "crc16_modbus"}

#: ``cover`` 里的锚点（相对帧的语义位置）。
COVER_ANCHORS = ("frame", "after_head", "before_checksum", "before_tail", "payload")


def _reflect(value: int, bits: int) -> int:
    out = 0
    for i in range(bits):
        if value & (1 << i):
            out |= 1 << (bits - 1 - i)
    return out


def crc_compute(data: bytes, *, width: int, poly: int, init: int,
                xorout: int, refin: bool, refout: bool) -> int:
    """参数化 CRC（Rocksoft 模型）。覆盖 CCITT / XMODEM / MODBUS / CRC32 等。"""
    mask = (1 << width) - 1
    top = 1 << (width - 1)
    crc = init & mask
    for b in data:
        if refin:
            b = _reflect(b, 8)          # 反射输入：按 MSB-first 引擎跑
        crc ^= b << (width - 8)
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & mask if crc & top else (crc << 1) & mask
    if refout:
        crc = _reflect(crc, width)
    return (crc ^ xorout) & mask


def resolve_checksum(ck: dict) -> dict:
    """把 profile 里的 ``checksum`` 声明解析成"能算"的完整参数。

    老写法 ``{"kind":"crc16modbus"}`` 与 ``{"kind":"crc16","preset":...}``
    走同一条路 —— 解析结果里一定有 ``func`` 名字与 ``size``，调用方不再
    自己 if/else 猜字节宽度（P0 时代那种"按 kind 猜 size"就是漂移来源）。
    """
    kind = str(ck.get("kind") or "none").strip().lower()
    at = str(ck.get("at") or "tail").strip().lower()
    offset = ck.get("offset")
    offset = int(offset) if offset not in (None, "") else None
    cover = ck.get("cover") or {"from": "frame", "to": "before_checksum"}
    out = {"kind": kind, "at": at, "offset": offset, "cover": cover,
           "size": 0, "endian": str(ck.get("endian") or "le"),
           "algo": "none", "params": None}
    if kind == "none":
        return out
    if kind == "sum8":
        out.update({"algo": "sum8", "size": 1, "endian": "le"})
        return out
    if kind == "xor8":
        out.update({"algo": "xor8", "size": 1, "endian": "le"})
        return out
    preset = str(ck.get("preset") or CHECK_ALIASES.get(kind) or "").strip().lower()
    if preset in CHECK_ALIASES:
        preset = CHECK_ALIASES[preset]
    if kind in CHECK_ALIASES:
        preset = preset or CHECK_ALIASES[kind]
    base = CRC_PRESETS.get(preset)
    if base is None:
        raise ValueError(f"未知 CRC 预设：{preset!r}")
    width, poly, init, xorout, refin, refout = base
    # 显式参数覆盖预设（只覆盖给了的）
    if ck.get("poly") is not None:
        poly = int(ck["poly"])
    if ck.get("init") is not None:
        init = int(ck["init"])
    if ck.get("xorout") is not None:
        xorout = int(ck["xorout"])
    if ck.get("refin") is not None:
        refin = bool(ck["refin"])
    if ck.get("refout") is not None:
        refout = bool(ck["refout"])
    size = int(ck.get("size") or (width // 8))
    out.update({"algo": "crc", "size": size, "preset": preset,
                "endian": str(ck.get("endian") or "le"),
                "params": {"width": width, "poly": poly, "init": init,
                           "xorout": xorout, "refin": refin, "refout": refout}})
    return out


def checksum_value(spec: dict, payload: bytes) -> int:
    algo = spec.get("algo") or "none"
    if algo == "sum8":
        return sum(payload) & 0xFF
    if algo == "xor8":
        val = 0
        for b in payload:
            val ^= b
        return val
    if algo == "crc":
        return crc_compute(payload, **spec["params"])
    return 0


def _anchor_offset(name, *, frame_len: int, head_len: int, ck_start: int,
                   tail_len: int) -> int:
    if isinstance(name, int):
        return name
    key = str(name or "frame").strip().lower()
    if key == "frame":
        return 0
    if key == "after_head":
        return head_len
    if key == "before_checksum":
        return ck_start
    if key == "before_tail":
        return frame_len - tail_len
    if key == "payload":
        return head_len
    raise ValueError(f"未知 cover 锚点：{name!r}")


def checksum_span(frame: bytes, spec: dict, *, head_len: int = 0,
                  tail_len: int = 0) -> tuple[int, bytes] | None:
    """算出「哪几个字节是校验」和「校验覆盖哪段」。

    返回 ``(start, expect_bytes)``；帧太短返回 ``None``。
    """
    size = int(spec.get("size") or 0)
    if size <= 0:
        return None
    n = len(frame)
    if spec.get("offset") is not None:
        start = int(spec["offset"])
    elif spec.get("at") == "head":
        start = 0
    else:
        start = n - tail_len - size
    if start < 0 or start + size > n:
        return None
    ck_start = start
    cover = spec.get("cover") or {"from": "frame", "to": "before_checksum"}
    lo = _anchor_offset(cover.get("from", "frame"), frame_len=n,
                        head_len=head_len, ck_start=ck_start, tail_len=tail_len)
    hi = _anchor_offset(cover.get("to", "before_checksum"), frame_len=n,
                        head_len=head_len, ck_start=ck_start, tail_len=tail_len)
    lo = max(0, min(lo, n))
    hi = max(lo, min(hi, n))
    return start, frame[lo:hi]


# ── 转义 / 字节填充（P2.2-B）──────────────────────────────────
def _esc_spec(profile: dict) -> dict | None:
    esc = profile.get("escape")
    if not isinstance(esc, dict):
        return None
    byte = esc.get("escape_byte")
    if byte in (None, ""):
        return None
    try:
        esc_byte = int(str(byte), 0) if isinstance(byte, str) else int(byte)
        xor = int(str(esc.get("xor") or 0), 0)
    except (TypeError, ValueError):
        return None
    targets = []
    for t in esc.get("targets") or []:
        try:
            targets.append(int(str(t), 0) if isinstance(t, str) else int(t))
        except (TypeError, ValueError):
            continue
    if not targets:
        targets = [esc_byte]
    if esc_byte not in targets:
        targets.append(esc_byte)
    return {"escape_byte": esc_byte & 0xFF, "xor": xor & 0xFF,
            "targets": sorted({t & 0xFF for t in targets}),
            "applies": str(esc.get("applies") or "payload").strip().lower()}


def _unescape(buf: bytes, esc: dict) -> bytes:
    out = bytearray()
    eb = esc["escape_byte"]
    xor = esc["xor"]
    i = 0
    n = len(buf)
    while i < n:
        b = buf[i]
        if b == eb and i + 1 < n:
            out.append(buf[i + 1] ^ xor)
            i += 2
            continue
        out.append(b)
        i += 1
    return bytes(out)


def _escape(buf: bytes, esc: dict) -> bytes:
    out = bytearray()
    eb = esc["escape_byte"]
    xor = esc["xor"]
    for b in buf:
        if b in esc["targets"]:
            out.append(eb)
            out.append(b ^ xor)
        else:
            out.append(b)
    return bytes(out)


def _maybe_unescape(frame: bytes, esc: dict, head_len: int,
                    tail_len: int, ck_size: int) -> bytes:
    """反转义帧体。**帧头/帧尾永远不转义**（否则协议就没法分帧了）。

    与计划书 "先反转义再切帧" 的差别是刻意的：转义的目标字节里通常就含
    帧定界符（0x7D/0x7E 家族），先反转义会把定界符还原进负载、随即切错帧。
    正确顺序只能是**先按定界符切、再反转义帧体**。
    """
    body_start = head_len
    body_end = len(frame) - tail_len
    if esc["applies"] == "payload":
        body_end -= ck_size          # 校验字节不参与转义
    if body_end <= body_start:
        return frame
    return (frame[:body_start]
            + _unescape(frame[body_start:body_end], esc)
            + frame[body_end:])


def _hexb(value) -> bytes:
    text = "".join(str(value or "").split())
    if not text:
        return b""
    return bytes.fromhex(text)


def _read_num(frame: bytes, offset: int, typ: str, endian: str):
    if typ == "u24":
        b = frame[offset:offset + 3]
        if len(b) != 3:
            raise ValueError("u24 越界")
        v = int.from_bytes(b, "big" if endian == "be" else "little", signed=False)
        return v
    if typ == "i24":
        b = frame[offset:offset + 3]
        if len(b) != 3:
            raise ValueError("i24 越界")
        v = int.from_bytes(b, "big" if endian == "be" else "little", signed=True)
        return v
    fmt = {"u8": "B", "u16": "H", "u32": "I", "i8": "b", "i16": "h",
           "i32": "i", "f32": "f", "f64": "d", "f16": "e"}[typ]
    size = struct.calcsize(fmt)
    b = frame[offset:offset + size]
    if len(b) != size:
        raise ValueError(f"{typ} 越界")
    return struct.unpack(("<" if endian == "le" else ">") + fmt, b)[0]


def _read_bits(frame: bytes, offset: int, bit_offset: int, bit_length: int,
               bit_order: str, signed: bool = False) -> int:
    """按位域读一个整数。

    ``lsb0``：从 ``offset`` 字节的最低位数起（跨字节继续）；
    ``msb0``：从帧首字节的 MSB 起按线性位流计数（本期语义，非 DBC Motorola）。
    """
    start = offset * 8 + bit_offset
    val = 0
    if bit_order == "msb0":
        for i in range(bit_length):
            p = start + i
            if p // 8 >= len(frame):
                raise ValueError("位域越界")
            bit = (frame[p // 8] >> (7 - (p % 8))) & 1
            val = (val << 1) | bit
    else:
        for i in range(bit_length):
            p = start + i
            if p // 8 >= len(frame):
                raise ValueError("位域越界")
            val |= ((frame[p // 8] >> (p % 8)) & 1) << i
    if signed and val & (1 << (bit_length - 1)):
        val -= 1 << bit_length
    return val


def _read_spec_value(frame: bytes, spec: dict) -> int:
    """读 ``id_field`` 这种"帧内单值"描述（支持位域）。"""
    off = int(spec.get("offset") or 0)
    if spec.get("bit_length"):
        return _read_bits(frame, off, int(spec.get("bit_offset") or 0),
                          int(spec["bit_length"]),
                          str(spec.get("bit_order") or "lsb0"),
                          signed=str(spec.get("type") or "").startswith("i"))
    return int(_read_num(frame, off, str(spec.get("type") or "u8"),
                         str(spec.get("endian") or "le")))


def _read_field(frame: bytes, f: dict):
    """解一个字段；返回 (value, is_numeric_plot)。

    ``array`` 的展开在记录层做（这里只解单个元素）。
    """
    name = f.get("name", "")
    typ = f.get("type", "")
    off = int(f.get("offset") or 0)
    if typ in ("ascii", "bytes", "str"):
        ln = int(f.get("length") or 0)
        raw = frame[off:off + ln]
        if len(raw) != ln:
            raise ValueError("越界")
        if typ == "bytes":
            return raw.hex(), False
        enc = str(f.get("encoding") or "utf-8")
        try:
            text = raw.decode(enc, errors="replace")
        except LookupError:
            text = raw.decode("utf-8", errors="replace")
        return text, False
    if f.get("bit_length"):
        val = _read_bits(frame, off, int(f.get("bit_offset") or 0),
                         int(f["bit_length"]),
                         str(f.get("bit_order") or "lsb0"),
                         signed=typ.startswith("i"))
    else:
        val = _read_num(frame, off, typ, str(f.get("endian") or "le"))
    if f.get("enum"):
        val = f["enum"].get(str(val), val)
        return val, False
    return val * float(f.get("scale", 1)) + float(f.get("bias", 0)), True


def _read_raw(frame: bytes, f: dict):
    """解一个字段的**原始**数值（不套 scale/bias/enum）—— verify 用。"""
    typ = f.get("type", "")
    off = int(f.get("offset") or 0)
    if typ in ("ascii", "bytes", "str"):
        return frame[off:off + int(f.get("length") or 0)].hex()
    if f.get("bit_length"):
        return _read_bits(frame, off, int(f.get("bit_offset") or 0),
                          int(f["bit_length"]),
                          str(f.get("bit_order") or "lsb0"),
                          signed=typ.startswith("i"))
    return _read_num(frame, off, typ, str(f.get("endian") or "le"))


def _flag_labels(f: dict, raw) -> list[str]:
    """位标志 → 命中的标签列表（原始值仍保留在 ``fields`` 里）。"""
    bits = f.get("bits") or {}
    if not bits or isinstance(raw, str):
        return []
    try:
        iv = int(raw)
    except (TypeError, ValueError):
        return []
    out = [label for k, label in sorted(bits.items(), key=lambda kv: int(kv[0]))
           if iv & (1 << int(k))]
    return out


def _heads_of(fr: dict) -> list[bytes]:
    heads = [_hexb(h) for h in (fr.get("heads") or [])]
    heads = [h for h in heads if h]
    if not heads:
        single = _hexb(fr.get("head_hex"))
        if single:
            heads = [single]
    heads.sort(key=len, reverse=True)     # 最长匹配优先
    return heads


def _find_head(data: bytes, pos: int, heads: list[bytes]) -> int:
    best = -1
    for h in heads:
        idx = data.find(h, pos)
        if idx < 0:
            continue
        if best < 0 or idx < best:
            best = idx
    return best


def _union_fields(profile: dict) -> list[dict]:
    """顶层字段 + 所有 variant 字段名的并集（按声明顺序，去重）。"""
    out: list[dict] = []
    seen: set[str] = set()

    def take(items):
        for f in items or []:
            name = f.get("name", "")
            if name and name not in seen:
                seen.add(name)
                out.append(f)

    take(profile.get("fields") or [])
    for v in profile.get("variants") or []:
        take(v.get("fields") or [])
    return out


def _channel_fields(profile: dict) -> list[dict]:
    """波形通道清单：数组字段按元素展开成 ``name[0..n-1]``。"""
    out: list[dict] = []
    for f in _union_fields(profile):
        arr = f.get("array")
        if arr and f.get("plot"):
            for i in range(int(arr.get("count") or 0)):
                out.append({"name": f"{f.get('name', '')}[{i}]",
                            "src": f.get("name", ""), "idx": i})
        elif f.get("plot"):
            out.append({"name": f.get("name", ""),
                        "src": f.get("name", ""), "idx": None})
    return out


def _profile_fields(profile: dict) -> list[dict]:
    """字段元数据（**全部**字段，含不作波形的）—— 面板按此渲染字段表。"""
    out = []
    for f in _union_fields(profile):
        base = {"unit": f.get("unit", ""), "type": f.get("type", ""),
                "plot": bool(f.get("plot", True))}
        if f.get("bit_length"):
            base.update({"bit_offset": int(f.get("bit_offset") or 0),
                         "bit_length": int(f["bit_length"]),
                         "bit_order": str(f.get("bit_order") or "lsb0")})
        if f.get("bits"):
            base["bits"] = dict(f["bits"])
        arr = f.get("array")
        if arr:
            for i in range(int(arr.get("count") or 0)):
                out.append({"name": f"{f.get('name', '')}[{i}]",
                            "src": f.get("name", ""), "index": i, **base})
        else:
            out.append({"name": f.get("name", ""), **base})
    return out


#: 解码失败分类（P2.2-C）。老 ``skipped`` 仍然保留 = 这些计数之和，
#: 但界面/Agent 该看的是"到底为什么没解出来"。
ERROR_KINDS = ("no_head", "bad_length", "short", "tail_mismatch",
               "checksum", "unknown_id", "bad_id", "field")


def _decode_profile(data: bytes, profile: dict, *, keep_raw: bool = False) -> dict:
    fr = profile.get("frame") or {}
    heads = _heads_of(fr)
    head = heads[0] if heads else b""
    tail = _hexb(fr.get("tail_hex"))
    length = fr.get("length")
    length = int(length) if length else None
    lf = fr.get("length_field") or None
    id_field = fr.get("id_field") or None
    max_bytes = int(fr.get("max_bytes") or 256)
    idle_only = bool(not heads and not lf and not length and not tail)
    ck = profile.get("checksum") or {}
    esc = _esc_spec(profile)
    variants = profile.get("variants") or []
    dispatch = bool(variants) or id_field is not None
    channels = _channel_fields(profile)

    frames: list[list] = []
    records: list[dict] = []
    reasons = {k: 0 for k in ERROR_KINDS}
    errors: list[str] = []
    pos = 0
    n = len(data)
    pending = b""

    def fail(kind: str, msg: str = "") -> None:
        reasons[kind] = reasons.get(kind, 0) + 1
        if msg and len(errors) < 40:
            errors.append(msg)

    def frame_total(start: int):
        """按 length_field 从帧首算总长；返回 ("ok", total) / "pending" / "bad"。"""
        off = int(lf.get("offset") or 0)
        need = off + (2 if str(lf.get("type")) == "u16" else 1)
        if n - start < need:
            return "pending"
        try:
            raw = _read_num(data, start + off, str(lf.get("type") or "u8"),
                            str(lf.get("endian") or "le"))
        except ValueError:
            return "pending"
        total = raw * float(lf.get("mul", 1)) + float(lf.get("add", 0))
        if not float(total).is_integer():
            return "bad"
        total = int(total)
        if total < 1 or total > max_bytes:
            return "bad"
        return "ok", total

    if idle_only:
        # 空闲分包型：这批字节就是**一帧**（切分由 serialmon 按时间戳做）。
        if data:
            frame = data[:max_bytes]
            if len(data) > max_bytes:
                fail("bad_length", "空闲分包帧超过 max_bytes，已截断")
            rec = _record_for(frame, profile, variants, id_field, ck, esc,
                              head_len=0, tail=tail, dispatch=dispatch,
                              channels=channels, fail=fail,
                              keep_raw=keep_raw, frame_hex=frame.hex())
            if rec is not None:
                records.append(rec)
                frames.append(rec["values"])
        return _result(profile, frames, records, reasons, errors, pending,
                       channels, len(data))

    while pos < n:
        head_len = 0
        if heads:
            idx = _find_head(data, pos, heads)
            if idx < 0:
                if n - pos:
                    fail("no_head", "找不到帧头（尾部字节无法归帧）")
                break
            pos = idx
            head_len = next((len(h) for h in heads if data.startswith(h, pos)),
                            len(head))
            if lf:
                got = frame_total(pos)
                if got == "pending":
                    pending = data[pos:]
                    break
                if got == "bad":
                    fail("bad_length", f"长度字段非法（{profile.get('id', '')}）")
                    pos += 1
                    continue
                end = pos + got[1]
                if end > n:
                    pending = data[pos:]
                    break
            elif length:
                end = pos + length
                if end > n:
                    pending = data[pos:]
                    break
            elif tail:
                tidx = data.find(tail, pos + head_len)
                if tidx < 0:
                    if n - pos > max_bytes:
                        fail("short", "超长仍找不到帧尾 → 重新同步")
                        pos += 1
                        continue
                    pending = data[pos:]
                    break
                end = tidx + len(tail)
            else:
                nxt = _find_head(data, pos + head_len, heads)
                if nxt < 0:
                    pending = data[pos:]
                    break
                end = nxt
        else:
            if lf:
                got = frame_total(pos)
                if got == "pending":
                    pending = data[pos:]
                    break
                if got == "bad":
                    fail("bad_length", f"长度字段非法（{profile.get('id', '')}）")
                    pos += 1
                    continue
                end = pos + got[1]
                if end > n:
                    pending = data[pos:]
                    break
            else:
                end = pos + (length or max_bytes)
                if end > n:
                    pending = data[pos:]
                    break
        frame = data[pos:end]
        if tail and length and not frame.endswith(tail):
            fail("tail_mismatch", "帧尾标记不匹配")
            pos = end
            continue
        rec = _record_for(frame, profile, variants, id_field, ck, esc,
                          head_len=head_len, tail=tail, dispatch=dispatch,
                          channels=channels, fail=fail,
                          keep_raw=keep_raw, frame_hex=frame.hex())
        if rec is not None:
            records.append(rec)
            frames.append(rec["values"])
        pos = end

    return _result(profile, frames, records, reasons, errors, pending,
                   channels, len(data))


def _record_for(frame: bytes, profile: dict, variants: list, id_field,
                ck: dict, esc: dict | None, *, head_len: int, tail: bytes,
                dispatch: bool, channels: list[dict], fail,
                keep_raw: bool, frame_hex: str) -> dict | None:
    """校验 + 解字段，产出一条记录。``None`` = 这帧该丢（原因已记进 fail）。"""
    tag = profile.get("id", "")
    body = frame
    tail_len = len(tail) if tail and frame.endswith(tail) else 0

    # ── 多 ID：先选 variant（校验和可能被 variant 覆盖）─────────
    variant = None
    vid = None
    active = profile.get("fields") or []
    ck_use = ck
    if id_field is not None:
        try:
            vid = _read_spec_value(body, id_field)
        except (ValueError, IndexError) as exc:
            fail("bad_id", f"消息 id 读取失败：{exc}")
            return None
        variant = next((v for v in variants if int(v.get("id", -1)) == vid), None)
        if variant is not None:
            active = variant.get("fields") or []
            ck_use = variant.get("checksum") or ck
        elif not active:
            fail("unknown_id", f"未知消息 id {vid}（profile {tag}）")
            return None

    spec = resolve_checksum(ck_use)
    ck_size = int(spec.get("size") or 0)

    # ── 反转义（先切帧再反转义：定界符不参与转义）──────────────
    if esc:
        body = _maybe_unescape(body, esc, head_len, tail_len, ck_size)
        if len(body) != len(frame):
            tail_len = len(tail) if tail and body.endswith(tail) else 0

    if spec["algo"] != "none":
        span = checksum_span(body, spec, head_len=head_len, tail_len=tail_len)
        if span is None:
            fail("short", f"帧太短，无法校验（{tag}）")
            return None
        start, payload = span
        got = int.from_bytes(body[start:start + ck_size],
                            "big" if spec.get("endian") == "be" else "little")
        want = checksum_value(spec, payload)
        if got != want:
            name = spec.get("preset") or spec["algo"]
            fail("checksum", f"校验失败（{name}，{tag}）")
            return None

    # ── 字段解析 ──────────────────────────────────────────────
    fields_map: dict = {}
    raw_map: dict = {}
    flags: dict = {}
    for f in active:
        name = f.get("name", "")
        arr = f.get("array")
        try:
            if arr:
                vals = []
                for i in range(int(arr.get("count") or 0)):
                    sub = dict(f)
                    sub["offset"] = int(f.get("offset") or 0) + i * int(arr["stride"])
                    vals.append(_read_field(body, sub)[0])
                fields_map[name] = vals
                if keep_raw:
                    raw_map[name] = [v for v in vals]
            else:
                val, _numeric = _read_field(body, f)
                fields_map[name] = val
                if f.get("bits"):
                    labels = _flag_labels(f, val)
                    if labels:
                        flags[name] = labels
                if keep_raw:
                    raw_map[name] = _read_raw(body, f)
        except (ValueError, IndexError, struct.error) as exc:
            fields_map[name] = None
            fail("field", f"{name} 解析失败：{exc}")

    values: list = []
    for ch in channels:
        val = fields_map.get(ch["src"])
        if ch["idx"] is not None:
            val = val[ch["idx"]] if isinstance(val, list) and \
                ch["idx"] < len(val) else None
        values.append(float(val) if isinstance(val, (int, float))
                      and not isinstance(val, bool) else None)

    rec: dict = {"fields": fields_map, "values": values}
    if flags:
        rec["flags"] = flags
    if dispatch:
        rec["id"] = vid
        rec["variant"] = variant.get("label") if variant else None
    if keep_raw:
        rec["raw"] = raw_map
        rec["frame_hex"] = frame_hex
    return rec


def _result(profile: dict, frames, records, reasons, errors, pending,
            channels, input_bytes) -> dict:
    skipped = sum(reasons.values())
    return {
        "ok": True, "decoder": f"profile:{profile.get('id', '')}",
        "channels": len(channels),
        "frames": frames, "records": records,
        "fields": _profile_fields(profile),
        "total_frames": len(frames),
        "skipped": skipped,
        "checksum_fail": reasons.get("checksum", 0),
        "unknown_id": reasons.get("unknown_id", 0),
        "reasons": dict(reasons),
        "errors": errors[-20:],
        "pending_bytes": len(pending), "pending_b64": _b64(pending),
        "input_bytes": input_bytes,
    }


def decode(data: bytes, decoder: str = "justfloat",
           channels: int | None = None, profile: dict | None = None,
           keep_raw: bool = False) -> dict:
    """解一段字节。返回可直接 JSON 化的结果（``frames`` 是二维 float 数组）。

    ``decoder`` 为 ``"profile"`` 或 ``"profile:<id>"`` 时使用 ``profile`` 字典
    （由 ``serialframes`` 装载/校验）。内置两种解码器行为不变。
    ``keep_raw`` 额外带上每个字段的原始数值与线上帧字节 —— 只给 ``verify`` 用，
    正常解码不带（那是给"证明这条规则真的可逆"的，不是给界面的）。
    """
    if decoder == "profile" or decoder.startswith("profile:"):
        if not isinstance(profile, dict):
            return {"ok": False, "error": "profile 解码需要 profile 配置",
                    "decoder": decoder, "frames": [], "channels": 0}
        return _decode_profile(data, profile, keep_raw=keep_raw)
    if decoder not in ("justfloat", "firewater"):
        return {"ok": False, "error": f"未知解码器：{decoder!r}",
                "decoder": decoder, "frames": [], "channels": 0}
    if channels is not None:
        try:
            channels = int(channels)
            if channels <= 0:
                channels = None
        except (TypeError, ValueError):
            channels = None
    if decoder == "justfloat":
        frames, pending, skipped = _frames_justfloat(data, channels)
        deduced = channels or (len(frames[0]) if frames else 0)
    else:
        frames, pending, skipped = _frames_firewater(data, channels)
        deduced = channels or (len(frames[0]) if frames else 0)
    return {
        "ok": True,
        "decoder": decoder,
        "channels": deduced,
        "frames": frames,
        "total_frames": len(frames),
        "skipped": skipped,
        "pending_bytes": len(pending),
        "pending_b64": _b64(pending),
        "input_bytes": len(data),
    }


def _b64(data: bytes) -> str:
    import base64
    return base64.b64encode(data).decode("ascii")


# ── 反向组帧（P1）：字段 → 字节 ──────────────────────────────────
_TYPE_SIZE = {"u8": 1, "u16": 2, "u24": 3, "u32": 4, "i8": 1, "i16": 2,
              "i24": 3, "i32": 4, "f32": 4, "f64": 8, "f16": 2}
_INT_BITS = {"u8": 8, "u16": 16, "u24": 24, "u32": 32,
             "i8": 8, "i16": 16, "i24": 24, "i32": 32}
_INT_FMT = {"u8": "B", "u16": "H", "u32": "I", "i8": "b", "i16": "h",
            "i32": "i", "f32": "f", "f64": "d", "f16": "e"}


def _field_span(f: dict) -> int:
    typ = f.get("type", "")
    if typ in ("ascii", "bytes", "str"):
        span = int(f.get("length") or 0)
    elif f.get("bit_length"):
        span = (int(f.get("bit_offset") or 0) + int(f["bit_length"]) + 7) // 8
    else:
        span = _TYPE_SIZE[typ]
    arr = f.get("array")
    if arr:
        return int(arr["stride"]) * (int(arr["count"]) - 1) + span
    return span


def _spec_span(spec: dict) -> int:
    if spec.get("bit_length"):
        return (int(spec.get("bit_offset") or 0)
                + int(spec["bit_length"]) + 7) // 8
    return _TYPE_SIZE[str(spec.get("type") or "u8")]


def _to_number(text: str) -> float:
    try:
        return float(text)
    except ValueError:
        return float(int(text.strip(), 0))


def _resolve_raw(f: dict, value) -> int | float:
    """字段值 → 原始值（逆 scale/bias、枚举 label → key）。"""
    enum = f.get("enum") or {}
    if isinstance(value, str):
        hit = next((k for k, v in enum.items() if v == value), None)
        if hit is not None:
            value = hit
        else:
            value = _to_number(value)
    try:
        num = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{f.get('name')} 不是数值：{value!r}")
    scale = float(f.get("scale", 1))
    bias = float(f.get("bias", 0))
    if scale == 0:
        raise ValueError(f"{f.get('name')} 的 scale 不能为 0")
    raw = (num - bias) / scale
    typ = f.get("type", "")
    if typ in _INT_BITS:
        raw = int(round(raw))
    return raw


def _write_num(buf: bytearray, offset: int, typ: str, endian: str, value) -> None:
    if typ == "u24":
        buf[offset:offset + 3] = (int(value) & 0xFFFFFF).to_bytes(
            3, "big" if endian == "be" else "little")
        return
    if typ == "i24":
        buf[offset:offset + 3] = (int(value) & 0xFFFFFF).to_bytes(
            3, "big" if endian == "be" else "little")
        return
    fmt = _INT_FMT[typ]
    size = struct.calcsize(fmt)
    buf[offset:offset + size] = struct.pack(
        ("<" if endian == "le" else ">") + fmt, value)


def _write_bits(buf: bytearray, offset: int, bit_offset: int,
                bit_length: int, bit_order: str, value: int) -> None:
    mask = (1 << bit_length) - 1
    val = int(value) & mask
    start = offset * 8 + bit_offset
    if bit_order == "msb0":
        for i in range(bit_length):
            p = start + i
            bit = (val >> (bit_length - 1 - i)) & 1
            buf[p // 8] |= bit << (7 - (p % 8))
    else:
        for i in range(bit_length):
            p = start + i
            buf[p // 8] |= ((val >> i) & 1) << (p % 8)


def _write_spec(buf: bytearray, spec: dict, value: int) -> None:
    off = int(spec.get("offset") or 0)
    if spec.get("bit_length"):
        _write_bits(buf, off, int(spec.get("bit_offset") or 0),
                    int(spec["bit_length"]),
                    str(spec.get("bit_order") or "lsb0"), value)
    else:
        _write_num(buf, off, str(spec.get("type") or "u8"),
                   str(spec.get("endian") or "le"), value)


def _encode_field(buf: bytearray, f: dict, value) -> None:
    name = f.get("name", "")
    typ = f.get("type", "")
    off = int(f.get("offset") or 0)
    arr = f.get("array")
    if arr:
        if not isinstance(value, (list, tuple)):
            raise ValueError(f"{name} 是数组字段，值必须是数组（{arr['count']} 项）")
        if len(value) != int(arr["count"]):
            raise ValueError(
                f"{name} 需要 {arr['count']} 项，收到 {len(value)} 项")
        for i, item in enumerate(value):
            sub = dict(f)
            sub.pop("array", None)
            sub["offset"] = off + i * int(arr["stride"])
            _encode_field(buf, sub, item)
        return
    if typ in ("ascii", "bytes", "str"):
        ln = int(f.get("length") or 0)
        if typ == "bytes":
            raw = bytes(value) if isinstance(value, (bytes, bytearray)) \
                else _hexb(value)
        else:
            enc = str(f.get("encoding") or "utf-8")
            try:
                raw = b"" if value in (None, "") else str(value).encode(enc)
            except LookupError:
                raw = str(value).encode("utf-8")
        if len(raw) > ln:
            raise ValueError(f"{name} 超过字段长度 {ln}：{len(raw)} 字节")
        buf[off:off + len(raw)] = raw
        return
    raw = _resolve_raw(f, value)
    if f.get("bit_length"):
        bits = int(f["bit_length"])
        iv = int(raw)
        if typ.startswith("i") and iv < 0:
            iv += 1 << bits
        if not (0 <= iv < (1 << bits)):
            raise ValueError(f"{name} 超出 {bits} bit 范围：{value!r}")
        _write_bits(buf, off, int(f.get("bit_offset") or 0), bits,
                    str(f.get("bit_order") or "lsb0"), iv)
        return
    if typ in _INT_BITS:
        iv = int(raw)
        bits = _INT_BITS[typ]
        if typ.startswith("i"):
            if not (-(1 << (bits - 1)) <= iv < (1 << (bits - 1))):
                raise ValueError(f"{name} 超出 {typ} 范围：{value!r}")
        elif not (0 <= iv < (1 << bits)):
            raise ValueError(f"{name} 超出 {typ} 范围：{value!r}")
        raw = iv
    _write_num(buf, off, typ, str(f.get("endian") or "le"), raw)


def _checksum_value(kind: str, payload: bytes) -> int:
    if kind == "sum8":
        return sum(payload) & 0xFF
    if kind == "xor8":
        val = 0
        for b in payload:
            val ^= b
        return val
    return crc16modbus(payload)


def encode(profile: dict, values=None, variant_id=None,
           length_value=None) -> dict:
    """按 profile 反向组帧（字段值 → 字节）。失败返回 ``ok=False`` + 原因。"""
    try:
        return _encode(profile, values or {}, variant_id, length_value)
    except (ValueError, TypeError, struct.error, KeyError) as exc:
        return {"ok": False, "error": str(exc)}


def _encode(profile: dict, values: dict, variant_id, length_value) -> dict:
    fr = profile.get("frame") or {}
    head = _hexb(fr.get("head_hex"))
    tail = _hexb(fr.get("tail_hex"))
    length = int(fr["length"]) if fr.get("length") else None
    lf = fr.get("length_field") or None
    idf = fr.get("id_field") or None
    variants = profile.get("variants") or []
    if not isinstance(values, dict):
        raise ValueError("values 必须是对象（字段名 → 值）")

    variant = None
    if variants:
        if variant_id in (None, ""):
            raise ValueError("多 variant profile 必须给 variant")
        try:
            vid = int(variant_id, 0) if isinstance(variant_id, str) else int(variant_id)
        except (TypeError, ValueError):
            raise ValueError(f"variant 必须是整数或 0x 字符串：{variant_id!r}")
        variant = next((v for v in variants if int(v.get("id", -1)) == vid), None)
        if variant is None:
            raise ValueError(f"没有这个 variant：{variant_id!r}")
        fields = variant.get("fields") or []
        ck = variant.get("checksum") or profile.get("checksum") or {}
        vid_value = vid
    else:
        fields = profile.get("fields") or []
        ck = profile.get("checksum") or {}
        vid_value = None
    spec = resolve_checksum(ck)
    esc = _esc_spec(profile)
    ck_size = int(spec.get("size") or 0)
    if spec["at"] == "head" and head and spec.get("offset") is None:
        raise ValueError("checksum.at=head 不能与 head_hex 同时使用"
                         "（校验不在帧首请用 checksum.offset）")

    need = len(head)
    for f in fields:
        need = max(need, int(f.get("offset") or 0) + _field_span(f))
    if idf is not None and variant is not None:
        need = max(need, int(idf.get("offset") or 0) + _spec_span(idf))
    if lf:
        need = max(need, int(lf.get("offset") or 0)
                   + (2 if str(lf.get("type")) == "u16" else 1))

    ck_at = str(spec.get("at") or "tail")
    if length is not None:
        total = length
        if total > int(fr.get("max_bytes") or 256):
            raise ValueError("frame.length 大于 max_bytes")
        limit = total - len(tail) - (ck_size if ck_at == "tail" else 0)
        if need > limit:
            raise ValueError(f"字段未完整描述帧：需要 {need} 字节，帧内可用 {limit}")
    else:
        if ck_at == "tail":
            base = need + ck_size + len(tail)
        else:
            base = max(need, ck_size) + len(tail)
        if lf:
            # 总长必须能由 length_field 反算成整数（raw >= 0）
            import math
            mul = float(lf.get("mul", 1))
            add = float(lf.get("add", 0))
            if mul <= 0:
                raise ValueError("length_field.mul 必须为正数")
            k = max(0, math.ceil((base - add) / mul))
            total = k * mul + add
            if total < base:
                total += mul
            total = int(total)
        else:
            total = base
    if total > int(fr.get("max_bytes") or 256):
        raise ValueError(f"组帧后 {total} 字节超过 max_bytes")
    if total < 1:
        raise ValueError("组帧后帧长为 0")

    buf = bytearray(total)
    buf[0:len(head)] = head
    for f in fields:
        name = f.get("name", "")
        _encode_field(buf, f, values.get(name, 0))
    if idf is not None:
        if variant is not None:
            _write_spec(buf, idf, int(vid_value))
        else:
            raw_id = values.get("id", values.get("msgid"))
            if raw_id is not None:
                _write_spec(buf, idf, int(raw_id))

    raw_len = None
    if lf:
        mul = float(lf.get("mul", 1))
        add = float(lf.get("add", 0))
        if length_value is None:
            raw = (total - add) / mul
            if not float(raw).is_integer():
                raise ValueError(
                    f"帧长 {total} 无法由 length_field 的 mul/add 反算")
            raw_len = int(raw)
        else:
            raw_len = int(length_value)
            if raw_len * mul + add != total:
                raise ValueError(
                    f"length_value {raw_len} 与组帧长度 {total} 不一致")
        typ = str(lf.get("type") or "u8")
        if not (0 <= raw_len < (1 << _INT_BITS[typ])):
            raise ValueError(f"length_field 值 {raw_len} 超出 {typ}")
        _write_spec(buf, {**lf, "type": typ}, raw_len)

    if tail:
        buf[total - len(tail):] = tail
    ck_val = None
    if spec["algo"] != "none":
        span = checksum_span(bytes(buf), spec, head_len=len(head),
                             tail_len=len(tail) if tail else 0)
        if span is None:
            raise ValueError("校验字节位置超出帧范围（检查 checksum.offset）")
        start, payload = span
        ck_val = checksum_value(spec, payload)
        endian = "big" if spec.get("endian") == "be" else "little"
        buf[start:start + ck_size] = ck_val.to_bytes(ck_size, endian)

    # 转义（P2.2-B）：只在**校验算完之后**做，且帧头/帧尾不转义。
    wire = bytes(buf)
    if esc:
        body_start = len(head)
        body_end = len(wire) - (len(tail) if tail else 0)
        if esc["applies"] == "payload":
            body_end -= ck_size
        if body_end > body_start:
            wire = (wire[:body_start] + _escape(wire[body_start:body_end], esc)
                    + wire[body_end:])

    out = {
        "ok": True,
        "id": profile.get("id", ""),
        "variant": variant.get("label") if variant else None,
        "hex": wire.hex(),
        "bytes": len(wire),
        "frame_bytes": total,
        "escaped": bool(esc),
        "length_field": raw_len,
        "checksum": (f"0x{ck_val:0{ck_size * 2}X}" if ck_val is not None
                     else None),
    }
    if variant is not None:
        out["variant_id"] = int(variant["id"])
    return out
