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


def decode(data: bytes, decoder: str = "justfloat",
           channels: int | None = None) -> dict:
    """解一段字节。返回可直接 JSON 化的结果（``frames`` 是二维 float 数组）。"""
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
