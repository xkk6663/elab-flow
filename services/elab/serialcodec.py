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
           "i32": "i", "f32": "f", "f64": "d"}[typ]
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
    """解一个字段；返回 (value, is_numeric_plot)。"""
    name = f.get("name", "")
    typ = f.get("type", "")
    off = int(f.get("offset") or 0)
    if typ in ("ascii", "bytes"):
        ln = int(f.get("length") or 0)
        raw = frame[off:off + ln]
        if len(raw) != ln:
            raise ValueError("越界")
        return (raw.decode("utf-8", errors="replace") if typ == "ascii"
                else raw.hex()), False
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


def _profile_fields(profile: dict) -> list[dict]:
    out = []
    for f in _union_fields(profile):
        item = {"name": f.get("name", ""), "unit": f.get("unit", ""),
                "type": f.get("type", ""), "plot": bool(f.get("plot", True))}
        if f.get("bit_length"):
            item.update({"bit_offset": int(f.get("bit_offset") or 0),
                         "bit_length": int(f["bit_length"]),
                         "bit_order": str(f.get("bit_order") or "lsb0")})
        out.append(item)
    return out


def _decode_profile(data: bytes, profile: dict) -> dict:
    fr = profile.get("frame") or {}
    head = _hexb(fr.get("head_hex"))
    tail = _hexb(fr.get("tail_hex"))
    length = fr.get("length")
    length = int(length) if length else None
    lf = fr.get("length_field") or None
    id_field = fr.get("id_field") or None
    max_bytes = int(fr.get("max_bytes") or 256)
    ck = profile.get("checksum") or {}
    ck_kind = str(ck.get("kind") or "none")
    ck_at = str(ck.get("at") or "tail")
    variants = profile.get("variants") or []
    dispatch = bool(variants) or id_field is not None
    channel_fields = [f for f in _union_fields(profile) if f.get("plot")]

    frames: list[list] = []
    records: list[dict] = []
    skipped = 0
    checksum_fail = 0
    unknown_id = 0
    errors: list[str] = []
    pos = 0
    n = len(data)
    pending = b""

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

    while pos < n:
        if head:
            idx = data.find(head, pos)
            if idx < 0:
                if n - pos:
                    skipped += 1                   # 找不到帧头 → 这段是垃圾
                break
            pos = idx
            if lf:
                got = frame_total(pos)
                if got == "pending":
                    pending = data[pos:]
                    break
                if got == "bad":
                    skipped += 1
                    errors.append(f"长度字段非法（profile {profile.get('id', '')}）")
                    pos += 1                   # 重新同步到下一个 head
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
                tidx = data.find(tail, pos + len(head))
                if tidx < 0:
                    if n - pos > max_bytes:
                        skipped += 1           # 超长仍找不到尾 → 重新同步
                        pos += 1
                        continue
                    pending = data[pos:]
                    break
                end = tidx + len(tail)
            else:
                nxt = data.find(head, pos + len(head))
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
                    skipped += 1
                    errors.append(f"长度字段非法（profile {profile.get('id', '')}）")
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
            skipped += 1
            errors.append("帧尾标记不匹配")
            pos = end
            continue

        # ── 多 ID：先选 variant（校验和可能被 variant 覆盖）─────────
        variant = None
        vid = None
        active = profile.get("fields") or []
        ck_use = ck
        if id_field is not None:
            try:
                vid = _read_spec_value(frame, id_field)
            except (ValueError, IndexError) as exc:
                skipped += 1
                errors.append(f"消息 id 读取失败：{exc}")
                pos = end
                continue
            variant = next((v for v in variants if int(v.get("id", -1)) == vid), None)
            if variant is not None:
                active = variant.get("fields") or []
                ck_use = variant.get("checksum") or ck
            elif not active:
                unknown_id += 1
                skipped += 1
                errors.append(f"未知消息 id {vid}（profile {profile.get('id', '')}）")
                pos = end
                continue

        ck_kind_use = str(ck_use.get("kind") or "none")
        ck_at_use = str(ck_use.get("at") or "tail")
        tag = profile.get("id", "") + (f"/{variant.get('label')}" if variant else "")
        if ck_kind_use != "none":
            size = 2 if ck_kind_use == "crc16modbus" else 1
            # 校验字节**不包含**尾标记（典型帧：head + data + checksum + tail）。
            tail_len = len(tail) if tail and frame.endswith(tail) else 0
            if len(frame) < tail_len + size:
                skipped += 1
                errors.append(f"帧太短，无法校验（{tag}）")
                pos = end
                continue
            if ck_at_use == "tail":
                expect = frame[len(frame) - tail_len - size:len(frame) - tail_len]
                payload = frame[:len(frame) - tail_len - size]
            else:
                expect = frame[:size]
                payload = frame[size:]
            if ck_kind_use == "sum8":
                ok_ck = (sum(payload) & 0xFF) == expect[0]
            elif ck_kind_use == "xor8":
                calc = 0
                for b in payload:
                    calc ^= b
                ok_ck = calc == expect[0]
            else:
                ok_ck = crc16modbus(payload) == int.from_bytes(expect, "little")
            if not ok_ck:
                checksum_fail += 1
                skipped += 1
                errors.append(f"校验失败（{ck_kind_use}，{tag}）")
                pos = end
                continue

        # ── 字段解析（variant 命中时只解该 variant 的字段）────────
        fields_map: dict = {}
        for f in active:
            name = f.get("name", "")
            try:
                val, _numeric = _read_field(frame, f)
            except (ValueError, IndexError, struct.error) as exc:
                val = None
                errors.append(f"{name} 解析失败：{exc}")
            fields_map[name] = val
        values: list = []
        for cf in channel_fields:
            val = fields_map.get(cf["name"])
            values.append(float(val) if isinstance(val, (int, float))
                          and not isinstance(val, bool) else None)
        rec = {"fields": fields_map, "values": values}
        if dispatch:
            rec["id"] = vid
            rec["variant"] = variant.get("label") if variant else None
        records.append(rec)
        frames.append(values)
        pos = end

    fields_meta = _profile_fields(profile)
    return {
        "ok": True, "decoder": f"profile:{profile.get('id', '')}",
        "channels": len(channel_fields),
        "frames": frames, "records": records,
        "fields": fields_meta,
        "total_frames": len(frames),
        "skipped": skipped, "checksum_fail": checksum_fail,
        "unknown_id": unknown_id,
        "errors": errors[-20:],
        "pending_bytes": len(pending), "pending_b64": _b64(pending),
        "input_bytes": len(data),
    }


def decode(data: bytes, decoder: str = "justfloat",
           channels: int | None = None, profile: dict | None = None) -> dict:
    """解一段字节。返回可直接 JSON 化的结果（``frames`` 是二维 float 数组）。

    ``decoder`` 为 ``"profile"`` 或 ``"profile:<id>"`` 时使用 ``profile`` 字典
    （由 ``serialframes`` 装载/校验）。内置两种解码器行为不变。
    """
    if decoder == "profile" or decoder.startswith("profile:"):
        if not isinstance(profile, dict):
            return {"ok": False, "error": "profile 解码需要 profile 配置",
                    "decoder": decoder, "frames": [], "channels": 0}
        return _decode_profile(data, profile)
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
              "i24": 3, "i32": 4, "f32": 4, "f64": 8}
_INT_BITS = {"u8": 8, "u16": 16, "u24": 24, "u32": 32,
             "i8": 8, "i16": 16, "i24": 24, "i32": 32}
_INT_FMT = {"u8": "B", "u16": "H", "u32": "I", "i8": "b", "i16": "h",
            "i32": "i", "f32": "f", "f64": "d"}


def _field_span(f: dict) -> int:
    typ = f.get("type", "")
    if typ in ("ascii", "bytes"):
        return int(f.get("length") or 0)
    if f.get("bit_length"):
        return (int(f.get("bit_offset") or 0) + int(f["bit_length"]) + 7) // 8
    return _TYPE_SIZE[typ]


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
    if typ in ("ascii", "bytes"):
        ln = int(f.get("length") or 0)
        if typ == "ascii":
            raw = b"" if value in (None, "") else str(value).encode("utf-8")
        elif isinstance(value, (bytes, bytearray)):
            raw = bytes(value)
        else:
            raw = _hexb(value)
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
    ck_kind = str(ck.get("kind") or "none")
    ck_at = str(ck.get("at") or "tail")
    ck_size = 0 if ck_kind == "none" else (2 if ck_kind == "crc16modbus" else 1)
    if ck_at == "head" and head:
        raise ValueError("checksum.at=head 不能与 head_hex 同时使用")

    need = len(head)
    for f in fields:
        need = max(need, int(f.get("offset") or 0) + _field_span(f))
    if idf is not None and variant is not None:
        need = max(need, int(idf.get("offset") or 0) + _spec_span(idf))
    if lf:
        need = max(need, int(lf.get("offset") or 0)
                   + (2 if str(lf.get("type")) == "u16" else 1))

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
    if ck_kind != "none":
        if ck_at == "tail":
            start = total - len(tail) - ck_size
            payload = bytes(buf[:start])
            ck_val = _checksum_value(ck_kind, payload)
            if ck_size == 2:
                buf[start:start + 2] = ck_val.to_bytes(2, "little")
            else:
                buf[start] = ck_val & 0xFF
        else:
            payload = bytes(buf[ck_size:])
            ck_val = _checksum_value(ck_kind, payload)
            if ck_size == 2:
                buf[:2] = ck_val.to_bytes(2, "little")
            else:
                buf[0] = ck_val & 0xFF

    out = {
        "ok": True,
        "id": profile.get("id", ""),
        "variant": variant.get("label") if variant else None,
        "hex": bytes(buf).hex(),
        "bytes": total,
        "length_field": raw_len,
        "checksum": (f"0x{ck_val:04X}" if ck_size == 2
                     else f"0x{ck_val:02X}") if ck_val is not None else None,
    }
    if variant is not None:
        out["variant_id"] = int(variant["id"])
    return out
