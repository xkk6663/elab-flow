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


def _profile_fields(profile: dict) -> list[dict]:
    out = []
    for f in profile.get("fields") or []:
        out.append({"name": f.get("name", ""), "unit": f.get("unit", ""),
                    "type": f.get("type", ""), "plot": bool(f.get("plot", True))})
    return out


def _decode_profile(data: bytes, profile: dict) -> dict:
    fr = profile.get("frame") or {}
    head = _hexb(fr.get("head_hex"))
    tail = _hexb(fr.get("tail_hex"))
    length = fr.get("length")
    length = int(length) if length else None
    max_bytes = int(fr.get("max_bytes") or 256)
    ck = profile.get("checksum") or {}
    ck_kind = str(ck.get("kind") or "none")
    ck_at = str(ck.get("at") or "tail")

    frames: list[list[float]] = []
    records: list[dict] = []
    skipped = 0
    checksum_fail = 0
    errors: list[str] = []
    pos = 0
    n = len(data)
    pending = b""
    while pos < n:
        if head:
            idx = data.find(head, pos)
            if idx < 0:
                if n - pos:
                    skipped += 1                   # 找不到帧头 → 这段是垃圾
                break
            pos = idx
            if length:
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
        if ck_kind != "none":
            size = 2 if ck_kind == "crc16modbus" else 1
            # 校验字节**不包含**尾标记（典型帧：head + data + checksum + tail）。
            tail_len = len(tail) if tail and frame.endswith(tail) else 0
            if len(frame) < tail_len + size:
                skipped += 1
                errors.append("帧太短，无法校验")
                pos = end
                continue
            if ck_at == "tail":
                expect = frame[len(frame) - tail_len - size:len(frame) - tail_len]
                payload = frame[:len(frame) - tail_len - size]
            else:
                expect = frame[:size]
                payload = frame[size:]
            if ck_kind == "sum8":
                ok_ck = (sum(payload) & 0xFF) == expect[0]
            elif ck_kind == "xor8":
                calc = 0
                for b in payload:
                    calc ^= b
                ok_ck = calc == expect[0]
            else:
                ok_ck = crc16modbus(payload) == int.from_bytes(expect, "little")
            if not ok_ck:
                checksum_fail += 1
                skipped += 1
                errors.append(f"校验失败（{ck_kind}）")
                pos = end
                continue
        # 字段解析
        values: list[float] = []
        fields_map: dict = {}
        for f in profile.get("fields") or []:
            name = f.get("name", "")
            typ = f.get("type", "")
            off = int(f.get("offset") or 0)
            try:
                if typ in ("ascii", "bytes"):
                    ln = int(f.get("length") or 0)
                    raw = frame[off:off + ln]
                    if len(raw) != ln:
                        raise ValueError("越界")
                    if typ == "ascii":
                        val = raw.decode("utf-8", errors="replace")
                    else:
                        val = raw.hex()
                else:
                    val = _read_num(frame, off, typ, str(f.get("endian") or "le"))
                    if f.get("enum"):
                        val = f["enum"].get(str(val), val)
                    else:
                        val = val * float(f.get("scale", 1)) + float(f.get("bias", 0))
            except (ValueError, IndexError) as exc:
                val = None
                errors.append(f"{name} 解析失败：{exc}")
            fields_map[name] = val
            if f.get("plot", typ not in ("ascii", "bytes")) and isinstance(val, (int, float)):
                values.append(float(val))
        records.append({"fields": fields_map, "values": values})
        frames.append(values)
        pos = end

    fields_meta = _profile_fields(profile)
    return {
        "ok": True, "decoder": f"profile:{profile.get('id', '')}",
        "channels": len(frames[0]) if frames else 0,
        "frames": frames, "records": records,
        "fields": fields_meta,
        "total_frames": len(frames),
        "skipped": skipped, "checksum_fail": checksum_fail,
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
