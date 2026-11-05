"""P3.3 解码性能基准（**不进 CI 门禁**，跑手动）。

    python tests/bench_serialcodec.py            # 默认每档 1.5s
    python tests/bench_serialcodec.py -s 3 -v    # 3s/档 + 每档一行明细

为什么单独一个脚本而不是单测：单测要的是"对不对"，基准要的是"多快"；
把耗时断言塞进 CI，换台机器就红，最后所有人都会去放宽阈值 —— 那还不如没有。

门槛（执行计划 §7.3）：
  · 单批 64 B 解码 p95 < 5 ms；
  · 115200 满速（≈11.5 KB/s）不丢帧 —— 这里用"吞吐 ≥ 50 KB/s 留 4× 余量"表达；
  · 1 KB 大批次不出现持续 gap（由会话层保证，这里只看单批耗时）。
"""

from __future__ import annotations

import argparse
import statistics
import struct
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services"))

from elab import serialcodec as codec      # noqa: E402
from elab import serialframes as sf        # noqa: E402


def _bitfield_profile() -> dict:
    """14B 位域遥测：AA55 + rpm + temp + mode + flags(bit0..2) + bat + CRC16 + 0D0A。"""
    return sf.normalize_profile({
        "id": "bench-bitfield", "kind": "binary",
        "frame": {"head_hex": "AA 55", "tail_hex": "0D 0A", "length": 14},
        "checksum": {"kind": "crc16modbus", "at": "tail"},
        "fields": [
            {"name": "rpm", "offset": 2, "type": "u16", "endian": "le", "scale": 0.1},
            {"name": "temp", "offset": 4, "type": "i16", "endian": "le", "scale": 0.01},
            {"name": "mode", "offset": 6, "type": "u8", "enum": {"0": "IDLE", "1": "RUN"}},
            {"name": "flags", "offset": 7, "type": "u8",
             "bits": {"0": "READY", "1": "FAULT", "2": "CAL"}},
            {"name": "bat", "offset": 8, "type": "u16", "endian": "le", "scale": 0.01},
        ],
    })


def _array_profile() -> dict:
    """18B 数组帧：A5 + 6 × u16（三轴 + 三力矩）+ ms + crc16 + 0D0A。"""
    return sf.normalize_profile({
        "id": "bench-array", "kind": "binary",
        "frame": {"head_hex": "A5", "tail_hex": "0D 0A", "length": 18},
        "checksum": {"kind": "crc16modbus", "at": "tail"},
        "fields": [
            {"name": "ch", "offset": 1, "type": "u16", "endian": "le",
             "array": {"count": 6, "stride": 2}},
            {"name": "ms", "offset": 13, "type": "u8"},
        ],
    })


def _bitfield_frame(i: int) -> bytes:
    body = (b"\xAA\x55" + struct.pack("<H", 1000 + i % 400)
            + struct.pack("<h", 250 + i % 100) + bytes([1]) + bytes([(i % 8)])
            + struct.pack("<H", 1234 - i % 50))
    return body + struct.pack("<H", codec.crc16modbus(body)) + b"\x0D\x0A"


def _array_frame(i: int) -> bytes:
    body = b"\xA5" + b"".join(struct.pack("<H", (i * 7 + k) & 0xFFFF) for k in range(6)) \
        + bytes([i & 0xFF])
    return body + struct.pack("<H", codec.crc16modbus(body)) + b"\x0D\x0A"


CASES = [
    ("bitfield 14B ×1", _bitfield_profile, _bitfield_frame, 1),
    ("bitfield 14B ×4 (56B)", _bitfield_profile, _bitfield_frame, 4),
    ("bitfield 14B ×75 (≈1KB)", _bitfield_profile, _bitfield_frame, 75),
    ("array 18B ×4 (72B)", _array_profile, _array_frame, 4),
]


def run(name: str, prof_fn, frame_fn, count: int, seconds: float) -> dict:
    prof = prof_fn()
    buf = b"".join(frame_fn(i) for i in range(count))
    dec = codec.decode(buf, f"profile:{prof['id']}", profile=prof)
    if dec["total_frames"] != count:      # 基准的样本必须先"能全解"，否则测的是错误路径
        raise SystemExit(f"{name}: 样本只解出 {dec['total_frames']}/{count} 帧")

    lat: list[float] = []
    frames = 0
    t_end = time.perf_counter() + seconds
    while time.perf_counter() < t_end:
        t0 = time.perf_counter()
        r = codec.decode(buf, f"profile:{prof['id']}", profile=prof)
        lat.append((time.perf_counter() - t0) * 1000.0)   # ms
        frames += r["total_frames"]
    elapsed = seconds
    lat.sort()

    def pct(p: float) -> float:
        if not lat:
            return 0.0
        return lat[min(len(lat) - 1, int(p * (len(lat) - 1)))]

    return {
        "case": name, "bytes": len(buf), "calls": len(lat),
        "frames": frames,
        "fps": frames / elapsed,
        "kbps": frames * len(buf) / count / elapsed / 1024.0,
        "p50": pct(0.50), "p95": pct(0.95), "max": lat[-1] if lat else 0.0,
        "mean": statistics.fmean(lat) if lat else 0.0,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-s", "--seconds", type=float, default=1.5)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    print(f"解码基准 · 每档 {args.seconds:g}s · {sys.platform} · "
          f"Python {sys.version.split()[0]}")
    print(f"{'场景':24s}{'单批字节':>9s}{'帧/批':>7s}{'调用次数':>8s}"
          f"{'帧/秒':>9s}{'KB/s':>8s}{'p50':>8s}{'p95':>8s}{'max':>8s}")
    rows = []
    for name, pf, ff, count in CASES:
        r = run(name, pf, ff, count, args.seconds)
        r["count"] = count
        rows.append(r)
        print(f"{r['case']:24s}{r['bytes']:9d}{count:7d}{r['calls']:8d}"
              f"{r['fps']:9.0f}{r['kbps']:8.1f}{r['p50']:8.3f}{r['p95']:8.3f}"
              f"{r['max']:8.3f}")

    ok = True
    gate = next(r for r in rows if r["count"] == 4 and r["case"].startswith("array"))
    if gate["p95"] >= 5.0:
        ok = False
        print(f"\n✗ 64B 档单批 p95 = {gate['p95']:.3f} ms，门槛 5 ms")
    else:
        print(f"\n✓ 64B 档单批 p95 = {gate['p95']:.3f} ms（门槛 5 ms）")
    slowest = min(r["kbps"] for r in rows)
    if slowest < 50.0:
        ok = False
        print(f"✗ 最低吞吐 {slowest:.1f} KB/s，低于 50 KB/s（115200 满速 11.5 KB/s 的 4×）")
    else:
        print(f"✓ 最低吞吐 {slowest:.1f} KB/s ≥ 50 KB/s（115200 满速 ≈11.5 KB/s）")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
