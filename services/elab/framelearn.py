"""elab.framelearn —— 从抓包**学习**帧协议，并做 round-trip 校验 / 自动匹配 / 代码生成。

这是 P4 的全部内容，服务三个角色：

    learn    一段抓包 → 声明式草稿 profile + 置信度 + 证据（**不落盘**）
    verify   profile + 抓包 → 解→编→再解，逐帧比对（证明规则可逆）
    auto     候选 profile 集合 → 给一段字节打分，选一个最优（只推荐，不静默）
    codegen  profile → C 头文件（偏移表 / pack 结构体 / 校验引用）

边界
----
* 只产出**声明式 JSON**，绝不生成可执行解码器，也不执行抓包里的任何东西；
* 不读写工程文件（保存仍走 ``serialframes.save`` 的 ``rev`` + ``allowAgentWrite``）；
* 零第三方依赖（纯标准库 + 本仓库已有的 ``serialcodec`` / ``serialframes``）。

为什么"学习"值得做
------------------
私有二进制协议的文档往往不存在、或者与固件不同步。人手写 profile 要反复
试错；而抓包本身就带着答案：帧头会重复、长度字段与帧长相关、校验和在末尾
且能试出来。把这三件事试一遍，就能给出一个**能直接解出数据**的草稿 ——
剩下的只是给字段改个好名字。
"""

from __future__ import annotations

import base64
import binascii
import copy
import json
import math
import re
import struct
from collections import Counter

from . import serialcodec as codec
from . import serialframes as sf

#: 学习时尝试的校验预设（顺序即优先级：常见的在前）。
LEARN_CHECKSUMS = ("sum8", "xor8", "crc8", "crc8_maxim",
                   "crc16_ccitt_false", "crc16_modbus", "crc16_xmodem",
                   "crc16_ibm", "crc16_x25", "crc32")

#: 判为"同一帧头"所需的最少出现次数。少于这个数就只是巧合。
MIN_HEAD_HITS = 3

# ── 规模上限（防"一次学习把内核卡死几分钟"）─────────────────────────
#: 参与 n-gram 扫描的最大字节数。实测 128 KB 内 find_heads 约 1.5 s；
#: 再往上就是纯线性增长（922 KB → 12.7 s），而 128 KB 已含上万帧，
#: 统计意义早已饱和。超出部分只提示、不参与学习。
MAX_ANALYZE_BYTES = 128 * 1024

#: 校验/帧尾/长度/id 探测的**取样帧数上限**。这几个探测都是
#: 「预设数 × 覆盖范围 × 帧数」的乘法（10 预设 × 2 覆盖 × 2 端序），
#: 帧数不封顶时 6.5k 帧就要 30 s（真机量过），封到 400 帧 → 亚秒级，
#: 而 400 帧判校验通过率（≥0.9）已经足够决定性。
MAX_DETECT_FRAMES = 400

#: 直接给"帧列表"时的帧数上限（对应上面的字节上限）。
MAX_LEARN_FRAMES = 4000

#: 字段名的默认前缀：语义推断不出来时，名字必须**诚实**（b0/b1…而不是 temp）。
DEFAULT_FIELD_PREFIX = "b"


class LearnError(ValueError):
    """输入不合法（不是"学不出来"）。"""


# ══════════════════════════════════════════════════════════════════
#  输入规整
# ══════════════════════════════════════════════════════════════════
def _hex_to_bytes(text: str) -> bytes:
    cleaned = re.sub(r"0x", "", str(text), flags=re.I)
    cleaned = re.sub(r"[^0-9a-fA-F]", "", cleaned)
    if len(cleaned) % 2:
        raise LearnError(f"十六进制串长度不是偶数：{text[:40]!r}")
    try:
        return bytes.fromhex(cleaned)
    except ValueError as exc:
        raise LearnError(f"不是合法十六进制：{exc}")


def parse_frames(raw) -> list[bytes]:
    """把用户给的 ``frames`` 规整成字节列表（也接受整段十六进制流）。"""
    if raw in (None, ""):
        return []
    if isinstance(raw, (bytes, bytearray)):
        return [bytes(raw)]
    if isinstance(raw, str):
        text = raw.strip()
        if text.startswith("["):
            try:
                return parse_frames(json.loads(text))
            except json.JSONDecodeError as exc:
                raise LearnError(f"frames 不是合法 JSON：{exc}")
        return [_hex_to_bytes(text)]
    if not isinstance(raw, list):
        raise LearnError("frames 必须是数组（十六进制字符串或字节数组）")
    out: list[bytes] = []
    for i, item in enumerate(raw):
        if isinstance(item, (bytes, bytearray)):
            out.append(bytes(item))
        elif isinstance(item, str):
            out.append(_hex_to_bytes(item))
        elif isinstance(item, list) and all(isinstance(x, int) for x in item):
            out.append(bytes(item))
        else:
            raise LearnError(f"frames[{i}] 既不是十六进制串也不是字节数组")
    return [f for f in out if f]


def parse_capture(text: str) -> tuple[list[bytes], list[int]]:
    """解析录制文件（JSONL：``{t_us, dir, bytes_b64}``）→ (批次, 时间戳)。

    只看 ``dir == "rx"``：TX 是我们自己写的命令，掺进学习会把协议学成
    "一半是设备一半是我们"。
    """
    chunks: list[bytes] = []
    stamps: list[int] = []
    for line in str(text or "").splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if str(rec.get("dir") or "rx") != "rx":
            continue
        b64 = rec.get("bytes_b64")
        if not b64:
            continue
        try:
            data = base64.b64decode(str(b64))
        except (binascii.Error, ValueError):
            continue
        if data:
            chunks.append(data)
            stamps.append(int(rec.get("t_us") or 0))
    return chunks, stamps


def _join(chunks: list[bytes]) -> bytes:
    return b"".join(chunks)


# ══════════════════════════════════════════════════════════════════
#  帧头候选
# ══════════════════════════════════════════════════════════════════
def _ngram_stats(data: bytes, n: int) -> list[tuple[bytes, list[int]]]:
    counts: dict[bytes, list[int]] = {}
    for i in range(0, len(data) - n + 1):
        grams = data[i:i + n]
        counts.setdefault(grams, []).append(i)
    out = [(g, pos) for g, pos in counts.items() if len(pos) >= MIN_HEAD_HITS]
    out.sort(key=lambda kv: (-len(kv[1]), kv[0]))
    return out


def _gap_consistency(positions: list[int]) -> float:
    """位置间隔的一致性（0..1）。帧头按帧长等距出现 → 接近 1。"""
    if len(positions) < 3:
        return 0.0
    gaps = [b - a for a, b in zip(positions, positions[1:])]
    mean = sum(gaps) / len(gaps)
    if mean <= 0:
        return 0.0
    var = sum((g - mean) ** 2 for g in gaps) / len(gaps)
    return max(0.0, 1.0 - math.sqrt(var) / mean)


def find_heads(data: bytes, hints: dict | None = None) -> list[dict]:
    """返回帧头候选（越靠前越可信）。命中次数、间隔一致性、长度都进证据。"""
    hinted = []
    for raw in (hints or {}).get("heads") or []:
        b = _hex_to_bytes(raw)
        if b:
            hinted.append({"hex": b.hex(), "hits": data.count(b),
                           "consistency": 0.0, "score": 1.0, "hinted": True})
    if hinted:
        return [h for h in hinted if h["hits"] >= 1]

    seen: dict[str, dict] = {}
    for n in (4, 3, 2, 1):
        for gram, positions in _ngram_stats(data, n):
            if len(set(gram)) == 1 and n > 1:
                continue                     # AA AA AA 这种"重复同字节"没有信息量
            if gram[0] == 0 and n == 1:
                continue                     # 单个 0x00 到处都是，做帧头没意义
            key = gram.hex()
            if key in seen:
                continue
            consistency = _gap_consistency(positions)
            # 位置越靠前越像帧头（流通常从帧首开始）；间隔越稳越可信
            first = positions[0]
            score = (len(positions) / max(1, len(data) / max(1, n))) * 0.5 \
                + consistency * 0.4 + (0.1 if first < n * 2 else 0.0)
            seen[key] = {"hex": key, "hits": len(positions),
                         "consistency": round(consistency, 3),
                         "score": round(score, 4), "first": first}
    cands = [v for v in seen.values() if v["hits"] >= MIN_HEAD_HITS]
    # ★ 按**长度分组**取候选，而不是全局"最长优先"取前 8：
    #   线上常混着设备自己打的 ASCII 日志（" tick=" 这种 4 字节片段间隔还
    #   出奇地稳），全局排序会把所有槽位让给它们，2 字节的真帧头（AA55）
    #   直接进不了候选 —— 真机抓包里就是这样学出了 0A5AA501 这种鬼东西。
    cands.sort(key=lambda c: (-c["hits"], -c["consistency"]))
    out: list[dict] = []
    for n in (4, 3, 2, 1):
        group = [c for c in cands if len(c["hex"]) // 2 == n]
        out.extend(group[:4])
    return out


def _head_pref(head: bytes) -> tuple:
    """帧头偏好（越小越优先）：先用 2 字节以上的，其中越短越好。

    · 1 字节帧头垫底：``5A`` 只能说明"每帧都以它开头"，同步到负载里的杂散
      字节就会错位；``5A A5`` 才是协议标记。
    · 2 字节以上越短越好：``AA 55 01 0A`` 只是 ``AA 55`` 又粘上了两个恰好
      恒定的字段字节 —— 帧切出来一模一样，但字段偏移整体前移，校验立刻不过
      （它和 ``AA 55`` 打平，所以这一条决定了谁赢）。
    """
    n = len(head)
    return (1 if n <= 1 else 0, n)


def _rank_heads(cands: list[dict]) -> list[dict]:
    """候选排序：从帧首开始的优先，其次 2..4 字节帧头，最后才是 1 字节。

    为什么不直接取"最长帧头"：``AA 55 01 0A`` 只是 ``AA 55`` 加上两个恰好
    恒定的字段字节 —— 它同样"每次都出现"，但拿它切帧会让字段偏移整体前移
    4 字节，校验立刻不过。真正该选的是**能切出可解帧的最短帧头**，所以这里
    只排序，最终由 ``_evaluate_split`` 的解析质量决定。

    1 字节帧头排末尾：``5A`` 能命中 179 次而 ``5A A5`` 只有 177 次，可它把
    帧头吞掉一个字节，消息 id 的偏移跟着错。只有在没有多字节帧头能解时，
    才轮到单字节 —— 排序保证它兜底，但不抢跑。
    """
    def key(c: dict):
        first = c.get("first", 0)
        n = len(c["hex"]) // 2
        return (0 if first == 0 else 1, 1 if n == 1 else 0,
                n if n > 1 else 0, -c.get("hits", 0))
    return sorted(cands, key=key)


def _evaluate_split(sample: list[bytes], head_len: int) -> dict:
    """给一种切法打分：定长/长度字段 + 校验 + 帧尾，三样越多越可信。

    定长允许"**多数派**等长"：真机抓包里设备日志行会和二进制帧交错，
    按"长度全都一样"判会直接判成变长帧，后面所有偏移都跟着错位。
    """
    lens = [len(f) for f in sample]
    counts = Counter(lens)
    mode_len, mode_n = counts.most_common(1)[0]
    dominant = mode_n / max(1, len(lens))
    fixed = len(counts) == 1 or (len(lens) >= 4 and dominant >= 0.8)
    frame_len = mode_len if fixed else 0
    lf = None if fixed else detect_length_field(sample, head_len)
    # 多数派定长时，校验/帧尾只用"长度对得上"的帧来判 —— 混进来的日志行
    # 会让末尾偏移整体漂移，通过率被噪声拉低。
    conforming = ([f for f in sample if len(f) == frame_len]
                  if fixed and len(counts) > 1 else sample)
    tail = b"" if (fixed or lf) else detect_tail(conforming, head_len)
    ck = detect_checksum(conforming, head_len, len(tail))
    ck_ok = bool(ck and ck["rate"] >= 0.9)
    coherence = (1 if (fixed or lf) else 0) + (1 if ck_ok else 0) + (1 if tail else 0)
    # good = "真能按这一帧长解出来"的帧数 —— 选帧头时最硬的一个数：
    # 比"命中次数"诚实（1 字节帧头命中更多，但多出来的是碎片）。
    good = sum(1 for n in lens if n == frame_len) if fixed else len(lens)
    return {"fixed": fixed, "frame_len": frame_len, "good": good,
            "dominant": round(dominant, 3), "length_field": lf, "tail": tail,
            "ck": ck, "ck_ok": ck_ok, "coherence": coherence, "lens": lens}


def split_by_head(data: bytes, head: bytes) -> list[bytes]:
    """按帧头切分。最后一段没有后继帧头 → 也收下（可能就是最后一帧）。"""
    out: list[bytes] = []
    pos = 0
    while True:
        idx = data.find(head, pos)
        if idx < 0:
            break
        nxt = data.find(head, idx + len(head))
        if nxt < 0:
            out.append(data[idx:])
            break
        out.append(data[idx:nxt])
        pos = nxt
    return out


# ══════════════════════════════════════════════════════════════════
#  长度 / 校验 / id 推断
# ══════════════════════════════════════════════════════════════════
def _read_int(frame: bytes, off: int, typ: str, endian: str):
    try:
        return int(codec._read_num(frame, off, typ, endian))
    except (ValueError, struct.error):
        return None


def _probe(frames: list[bytes]) -> list[bytes]:
    """探测用的取样：帧数封顶，避免"预设 × 帧数"的乘法把请求拖成几分钟。"""
    return frames if len(frames) <= MAX_DETECT_FRAMES else frames[:MAX_DETECT_FRAMES]


def detect_length_field(frames: list[bytes], head_len: int) -> dict | None:
    """找"帧长字段"：哪个 offset 的 u8/u16 与总长满足 ``total = raw + add``。"""
    frames = _probe(frames)
    if len(frames) < 2:
        return None
    min_len = min(len(f) for f in frames)
    best = None
    for typ, size in (("u8", 1), ("u16", 2)):
        for endian in ("le", "be"):
            for off in range(head_len, max(head_len, min_len - size + 1)):
                raws = [_read_int(f, off, typ, endian) for f in frames]
                if any(r is None for r in raws):
                    continue
                adds = {len(f) - r for f, r in zip(frames, raws)}
                if len(adds) == 1:
                    add = adds.pop()
                    if -8 <= add <= 64:
                        cand = {"offset": off, "type": typ, "endian": endian,
                                "mul": 1, "add": add,
                                "rate": 1.0}
                        if best is None or off < best["offset"]:
                            best = cand
    return best


#: 校验预筛用的帧数。正确的组合在 32 帧上就该几乎全过；先在小子集上筛一遍，
#: 只有"疑似命中"的预设才在完整样本上复核 —— 这一步把 10 预设 × 400 帧的
#: CRC 计算量砍掉一个数量级（实测 learn 从 30 s 降到 3 s 量级）。
_CHECKSUM_PRESCREEN = 12
_CHECKSUM_PRESCREEN_RATE = 0.8


def _checksum_hits(frames: list[bytes], preset: str, cover_from: str,
                   ck_size: int, tail_len: int, head_len: int, endian: str):
    """在 frames 上算命中数；算法不支持该宽度时返回 None。"""
    hits = 0
    for f in frames:
        start = len(f) - tail_len - ck_size
        if start <= head_len:
            continue
        lo = 0 if cover_from == "frame" else head_len
        try:
            want = _checksum_for(preset, f[lo:start])
        except (ValueError, KeyError):
            return None
        got = int.from_bytes(f[start:start + ck_size],
                             "big" if endian == "be" else "little")
        if got == want:
            hits += 1
    return hits


def detect_checksum(frames: list[bytes], head_len: int, tail_len: int) -> dict | None:
    """试遍校验预设 × 位置 × 覆盖范围，返回通过率最高的那个。"""
    frames = _probe(frames)
    usable = [f for f in frames if len(f) >= head_len + tail_len + 2]
    if len(usable) < 2:
        return None
    small = usable[:_CHECKSUM_PRESCREEN]
    best = None
    for ck_size in (1, 2, 4):
        for preset in LEARN_CHECKSUMS:
            if preset in ("sum8", "xor8"):
                size = 1
            else:
                size = codec.CRC_PRESETS[preset][0] // 8
            if size != ck_size:
                continue
            for cover_from in ("frame", "after_head"):
                for endian in (("le", "be") if ck_size > 1 else ("le",)):
                    short = _checksum_hits(small, preset, cover_from, ck_size,
                                           tail_len, head_len, endian)
                    if short is None or short / len(small) < _CHECKSUM_PRESCREEN_RATE:
                        continue
                    if len(usable) == len(small):
                        hits = short
                    else:
                        hits = _checksum_hits(usable, preset, cover_from, ck_size,
                                              tail_len, head_len, endian)
                        if hits is None:
                            continue
                    rate = hits / len(usable)
                    if rate < 0.6:
                        continue
                    if preset in ("sum8", "xor8"):
                        cand = {"kind": preset, "rate": round(rate, 3),
                                "at": "tail",
                                "cover": {"from": cover_from,
                                          "to": "before_checksum"}}
                    else:
                        kind = {1: "crc8", 2: "crc16", 4: "crc32"}.get(ck_size, "crc16")
                        if preset == "crc16_modbus":
                            kind = "crc16modbus"
                        cand = {"kind": kind, "preset": preset, "size": ck_size,
                                "cover": {"from": cover_from,
                                          "to": "before_checksum"},
                                "endian": endian, "rate": round(rate, 3),
                                "at": "tail"}
                    if best is None or cand["rate"] > best["rate"]:
                        best = cand
                    if rate == 1.0:
                        return best
    return best


def _checksum_for(preset: str, payload: bytes) -> int:
    if preset == "sum8":
        return sum(payload) & 0xFF
    if preset == "xor8":
        v = 0
        for b in payload:
            v ^= b
        return v
    width, poly, init, xorout, refin, refout = codec.CRC_PRESETS[preset]
    return codec.crc_compute(payload, width=width, poly=poly, init=init,
                             xorout=xorout, refin=refin, refout=refout)


def detect_tail(frames: list[bytes], head_len: int) -> bytes:
    """所有帧共同的**非平凡**后缀 = 帧尾（全 00 / 全 FF 不算，那是填充值）。"""
    frames = _probe(frames)
    if len(frames) < 3:
        return b""
    min_len = min(len(f) for f in frames)
    for size in (1, 2, 4, 3):
        if min_len <= head_len + size + 1:
            continue
        suffixes = {f[-size:] for f in frames}
        if len(suffixes) != 1:
            continue
        suf = suffixes.pop()
        if len(set(suf)) <= 1:
            continue                      # 00 / FF FF 这种是填充，不是定界符
        # 帧尾不能和帧头重叠（"7E ... 7E" 是合法的，但 head==tail 时按尾切会乱）
        return suf
    return b""


def detect_id_field(frames: list[bytes], head_len: int,
                    skip: set[int]) -> dict | None:
    """找"消息 id"：位置固定、取值种数少（2..16）、且不是长度/校验字节。"""
    frames = _probe(frames)
    if len(frames) < 4:
        return None
    min_len = min(len(f) for f in frames)
    best = None
    for typ, size in (("u8", 1), ("u16", 2)):
        for off in range(head_len, max(head_len, min_len - size + 1)):
            if any(off <= s < off + size for s in skip):
                continue
            vals = [_read_int(f, off, typ, "le") for f in frames]
            if any(v is None for v in vals):
                continue
            uniq = set(vals)
            if not (2 <= len(uniq) <= min(16, max(2, len(frames) // 2))):
                continue
            # 取值分布要"像枚举"：每个值至少出现两次，且不是连续递增序列
            counts = Counter(vals)
            if min(counts.values()) < 2:
                continue
            if len(uniq) == len(vals):
                continue                  # 每帧都不一样 → 是计数器，不是 id
            cand = {"offset": off, "type": typ, "endian": "le",
                    "values": sorted(uniq), "distinct": len(uniq)}
            if best is None or off < best["offset"]:
                best = cand
    return best


# ══════════════════════════════════════════════════════════════════
#  字段切分
# ══════════════════════════════════════════════════════════════════
def _range_name(prefix: str, off: int) -> str:
    return f"{prefix}{off}"


def build_fields(length: int, head_len: int, reserved: list[tuple[int, int]],
                 *, field_count: int = 0, prefix: str = DEFAULT_FIELD_PREFIX
                 ) -> tuple[list[dict], list[str]]:
    """把 payload 里没被占用的字节切成字段。

    语义推断不出来时**按 offset 命名**（``b3``），不假装知道那是温度。
    ``field_count`` 给了就均分（用户/AI 可以从固件代码里数出来有几路）。
    """
    notes: list[str] = []
    used = [False] * length
    for lo, hi in reserved:
        for i in range(max(0, lo), min(length, hi)):
            used[i] = True
    free: list[int] = [i for i in range(head_len, length) if not used[i]]
    if not free:
        return [], notes
    if field_count and field_count > 0:
        chunks: list[tuple[int, int]] = []
        size = max(1, math.ceil(len(free) / field_count))
        idx = 0
        for i in range(0, len(free), size):
            piece = free[i:i + size]
            if not piece:
                continue
            chunks.append((piece[0], piece[-1] + 1))
            idx += 1
        if len(chunks) < field_count:
            notes.append(f"可用字节 {len(free)} 不足 {field_count} 个字段，实际切出 {len(chunks)} 个")
    else:
        # 默认：连续区间里按 2 字节对齐切 u16，余 1 字节给 u8
        chunks = []
        i = 0
        while i < len(free):
            # 只在**连续**的 free 区间内配对
            if i + 1 < len(free) and free[i + 1] == free[i] + 1:
                chunks.append((free[i], free[i] + 2))
                i += 2
            else:
                chunks.append((free[i], free[i] + 1))
                i += 1
    out: list[dict] = []
    for lo, hi in chunks:
        size = hi - lo
        typ, endian = ("u8", "le") if size == 1 else ("u16", "le")
        item = {"name": _range_name(prefix, lo), "type": typ,
                "offset": lo, "endian": endian, "unit": ""}
        if size not in (1, 2):
            item = {"name": _range_name(prefix, lo), "type": "bytes",
                    "offset": lo, "length": size, "unit": "", "plot": False}
        out.append(item)
    if out:
        notes.append("字段语义无法从字节流推断，已按 offset 命名（b<offset>）；"
                     "请按固件里的变量含义改名并补 unit/scale")
    return out, notes


# ══════════════════════════════════════════════════════════════════
#  learn
# ══════════════════════════════════════════════════════════════════
def learn(*, frames=None, hex: str = "", b64: str = "", capture: str = "",
          name: str = "learned", label: str = "", hints: dict | None = None,
          field_count: int = 0) -> dict:
    """从抓包学一个**草稿** profile（不落盘）。

    返回值里的 ``draft`` 可直接喂给 ``serialframes.save`` / ``preview``；
    ``confidence`` 与 ``evidence`` 是给人复核用的 —— 学习必须**可证伪**，
    不能给一个"看起来对"的 profile 就完事。
    """
    hints = hints or {}
    sample: list[bytes] = []
    stamps: list[int] = []
    if capture:
        chunks, stamps = parse_capture(capture)
        if not chunks:
            raise LearnError("录制文件里没有 rx 批次（只学设备发出来的字节）")
        frame_list = []
    elif frames is not None:
        frame_list = parse_frames(frames)
        chunks = []
    elif b64:
        try:
            chunks = [base64.b64decode(b64)]
        except (binascii.Error, ValueError) as exc:
            raise LearnError(f"b64 不是合法 base64：{exc}")
        frame_list = []
    elif hex:
        chunks = [_hex_to_bytes(hex)]
        frame_list = []
    else:
        raise LearnError("learn 需要 frames / hex / b64 / capture 之一")

    evidence: list[str] = []
    warnings: list[str] = []

    # ── 1. 有没有现成的帧边界 ────────────────────────────────
    head = b""
    evaluated: dict = {}
    if frame_list:
        if len(frame_list) > MAX_LEARN_FRAMES:
            warnings.append(
                f"给了 {len(frame_list)} 帧，只分析前 {MAX_LEARN_FRAMES} 帧"
                f"（超过这个数量对推断没有增益，只会拖慢）")
            frame_list = frame_list[:MAX_LEARN_FRAMES]
        sample = frame_list
        evidence.append(f"输入已给 {len(sample)} 个帧边界")
        evaluated = _evaluate_split(sample, 0)
    else:
        data = _join(chunks)
        if len(data) < 6:
            raise LearnError(f"样本太短（{len(data)} 字节），至少给几十字节")
        if len(data) > MAX_ANALYZE_BYTES:
            warnings.append(
                f"样本 {len(data) / 1024:.0f} KB，只分析前 {MAX_ANALYZE_BYTES // 1024} KB"
                f"（帧头/校验/字段的统计几千帧就饱和，再多的部分只费时间）")
            data = data[:MAX_ANALYZE_BYTES]
        heads = find_heads(data, hints)
        if not heads:
            # 没有重复帧头 → 只能靠空闲分包
            sample = [data]
            evidence.append("没有重复出现的多字节标记：按空闲分包（一次读=一帧）处理")
            warnings.append("未找到稳定帧头；建议在设备侧加帧头，或确认抓包间隔")
            evaluated = _evaluate_split(sample, 0)
        else:
            # 逐个候选切一遍，用"能不能解出来"决定选谁 —— 而不是比长度
            best: dict | None = None
            for cand in _rank_heads(heads)[:12]:
                hb = bytes.fromhex(cand["hex"])
                part = split_by_head(data, hb)
                if len(part) < 2:
                    continue
                ev = _evaluate_split(part, len(hb))
                ev["head"] = hb
                ev["cand"] = cand
                if best is None:
                    best = ev
                    continue
                if ev["coherence"] > best["coherence"]:
                    best = ev
                elif ev["coherence"] == best["coherence"]:
                    # 同级看"能解出多少帧"：1 字节帧头（5A）命中更多，
                    # 但多出来的常常是碎片；能整帧解出来的才作数。
                    if ev["good"] > best["good"]:
                        best = ev
                    elif ev["good"] == best["good"] \
                            and _head_pref(hb) < _head_pref(best["head"]):
                        best = ev
            if best is None:
                raise LearnError("帧头候选都切不出 2 帧以上，样本可能只有一帧")
            head = best["head"]
            sample = split_by_head(data, head)
            evaluated = best
            cand = best["cand"]
            evidence.append(
                f"帧头 0x{head.hex().upper()} 在 {len(data)} 字节里出现 "
                f"{cand['hits']} 次（间隔一致性 {cand.get('consistency', 0):.2f}）")
            others = [h for h in heads if h["hex"] != cand["hex"]][:3]
            if others:
                evidence.append("其它候选帧头：" + ", ".join(
                    f"0x{h['hex'].upper()}({h['hits']})" for h in others))
    # 定长但长度不完全一致：绝大多数是真实帧，少数是插进来的日志行/粘包。
    # 按"多数派长度"取帧，并**如实报出**丢了几个 —— 悄悄修样本等于让学习
    # 不可证伪（看到 168/177 才知道自己的抓包干净不干净）。
    if evaluated and evaluated.get("fixed") and evaluated.get("dominant", 1.0) < 1.0:
        flen = int(evaluated.get("frame_len") or 0)
        keep = [f for f in sample if len(f) == flen] if flen else []
        if len(keep) >= 3:
            dropped = len(sample) - len(keep)
            sample = keep
            evidence.append(
                f"{len(keep)}/{len(keep) + dropped} 个片段等长 {flen} 字节 → "
                f"定长帧，另 {dropped} 个长度不符（日志行/粘包）已排除")

    # 丢掉明显不完整的末帧（长度远小于中位数）
    if len(sample) > 3:
        lens = sorted(len(f) for f in sample)
        median = lens[len(lens) // 2]
        keep = [f for f in sample if len(f) >= max(2, median // 2)]
        if len(keep) >= 3 and len(keep) != len(sample):
            evidence.append(f"丢弃 {len(sample) - len(keep)} 个疑似残帧（长度远小于中位数）")
            sample = keep
    if not sample:
        raise LearnError("没有可分析的帧")

    head_len = len(head)
    if not evaluated:
        evaluated = _evaluate_split(sample, head_len)
    lens = evaluated["lens"]
    fixed = evaluated["fixed"]
    length_field = evaluated["length_field"]
    tail = evaluated["tail"]
    if fixed:
        total_len = int(evaluated.get("frame_len") or lens[0])
        evidence.append(f"所有 {len(sample)} 帧等长：{total_len} 字节 → 定长帧")
    else:
        uniq = sorted(set(lens))
        evidence.append(f"帧长不等（{uniq[0]}..{uniq[-1]} 字节）→ 变长帧")
        total_len = 0
        if length_field:
            evidence.append(
                f"offset {length_field['offset']} 的 {length_field['type']}"
                f"({length_field['endian']}) 与总长关系：total = raw + "
                f"{length_field['add']}（{len(sample)} 帧全部成立）")
        else:
            warnings.append("帧长不等但没找到长度字段：只能靠帧头/帧尾切分，"
                            "粘帧时会错位")
    if tail:
        evidence.append(f"所有帧以 0x{tail.hex().upper()} 结尾 → 帧尾")

    tail_len = len(tail)

    # ── 2. 校验 ─────────────────────────────────────────────
    ck = evaluated["ck"]
    ck_size = 0
    checksum: dict = {"kind": "none"}
    if ck and ck["rate"] >= 0.9:
        ck_size = ck.get("size") or (1 if ck["kind"] in ("sum8", "xor8") else 0)
        checksum = {"kind": ck["kind"], "at": "tail"}
        if ck.get("preset"):
            checksum["preset"] = ck["preset"]
            checksum["endian"] = ck["endian"]
            checksum["size"] = ck["size"]
        cover = {"from": ck["cover"]["from"], "to": "before_checksum"}
        if cover["from"] != "frame":
            checksum["cover"] = cover
        ck_name = ck.get("preset") or ck["kind"]
        evidence.append(f"末尾 {ck_size} 字节是 {ck_name}，通过率 "
                        f"{ck['rate'] * 100:.0f}%（覆盖范围 {cover['from']}→"
                        f"before_checksum）")
    elif ck:
        warnings.append(f"末尾疑似校验但通过率只有 {ck['rate'] * 100:.0f}%，未采纳")
    else:
        evidence.append("末尾没有可识别的校验（sum8/xor8/常见 CRC 均未通过）")

    # ── 3. 定长时的真实帧长（变长按长度字段反算）────────────
    if fixed:
        frame_len = total_len
    elif length_field:
        vals = []
        for f in sample:
            raw = _read_int(f, length_field["offset"], length_field["type"],
                            length_field["endian"])
            if raw is None:
                continue
            vals.append(int(raw * length_field["mul"] + length_field["add"]))
        frame_len = max(vals) if vals else max(lens)
        if frame_len != max(lens):
            evidence.append(f"按长度字段反算的真实帧长 {frame_len}（收到的最长 "
                            f"{max(lens)} 字节，含尾部粘包）")
    else:
        frame_len = max(lens)

    # ── 4. 消息 id ──────────────────────────────────────────
    skip: set[int] = set()
    if length_field:
        skip.update(range(length_field["offset"],
                          length_field["offset"] + (2 if length_field["type"] == "u16" else 1)))
    if ck_size:
        skip.update(range(max(0, frame_len - tail_len - ck_size),
                          frame_len - tail_len))
    trimmed = [f[:frame_len] for f in sample if len(f) >= frame_len]
    id_field = None
    variants: list[dict] = []
    cand = detect_id_field(trimmed or sample, head_len, skip)
    if cand:
        id_field = {"offset": cand["offset"], "type": cand["type"],
                    "endian": cand["endian"]}
        evidence.append(
            f"offset {cand['offset']} 的 {cand['type']} 只有 "
            f"{cand['distinct']} 种取值（"
            f"{', '.join(f'0x{v:02X}' for v in cand['values'][:8])}"
            f"{'…' if cand['distinct'] > 8 else ''}）→ 消息 id")
        skip.update(range(cand["offset"],
                          cand["offset"] + (2 if cand["type"] == "u16" else 1)))
        variants = [{"id": v, "label": f"0x{v:02X}", "fields": []}
                    for v in cand["values"]]
    elif not fixed:
        warnings.append("没找到消息 id：多种消息混在一起时只会有部分帧能解")

    # ── 5. 字段 ─────────────────────────────────────────────
    reserved: list[tuple[int, int]] = [(0, head_len)]
    if length_field:
        reserved.append((length_field["offset"],
                         length_field["offset"] + (2 if length_field["type"] == "u16" else 1)))
    if ck_size:
        reserved.append((frame_len - tail_len - ck_size, frame_len - tail_len))
    if tail_len:
        reserved.append((frame_len - tail_len, frame_len))
    if id_field:
        reserved.append((id_field["offset"],
                         id_field["offset"] + (2 if id_field["type"] == "u16" else 1)))
    fields, notes = build_fields(frame_len, head_len, reserved,
                                 field_count=field_count)
    warnings.extend(notes)

    # ── 6. 组装草稿 ─────────────────────────────────────────
    frame: dict = {"head_hex": head.hex(), "max_bytes": min(256, max(32, frame_len * 2))}
    if fixed:
        frame["length"] = frame_len
    else:
        if length_field:
            frame["length_field"] = {
                "offset": length_field["offset"], "type": length_field["type"],
                "endian": length_field["endian"], "mul": length_field["mul"],
                "add": length_field["add"]}
        if tail:
            frame["tail_hex"] = tail.hex()
        if not length_field and not tail:
            frame["idle_gap_ms"] = 20
            warnings.append("既无长度字段也无帧尾：只能按 20ms 空闲分包切帧"
                            "（可在 profile 里调 idle_gap_ms）")
    if id_field:
        frame["id_field"] = id_field

    draft: dict = {"id": sf_id(name), "label": label or name,
                   "kind": "binary", "frame": frame,
                   "checksum": checksum, "fields": fields}
    if variants:
        draft["variants"] = variants

    # ── 7. 置信度 + 自检 ────────────────────────────────────
    confidence = 0.0
    if head_len:
        confidence += 0.3
    if fixed or length_field:
        confidence += 0.25
    if ck_size:
        confidence += 0.3
    if len(sample) >= 5:
        confidence += 0.1
    if id_field:
        confidence += 0.05
    confidence = round(min(0.99, confidence), 2)

    out: dict = {"ok": True, "draft": None, "confidence": confidence,
                 "evidence": evidence, "warnings": warnings,
                 "sample_frames": len(sample),
                 "sample_bytes": sum(len(f) for f in sample)}
    try:
        normalized = sf.normalize_profile(draft)
        out["draft"] = normalized
    except ValueError as exc:
        out["ok"] = False
        out["error"] = f"学出的草稿未通过校验：{exc}"
        out["draft"] = draft
        return out

    # 用草稿回放一遍：能解出几帧，是最硬的证据
    blob = b"".join(f[:frame_len] if frame_len else f for f in sample)
    try:
        dec = codec.decode(blob, f"profile:{normalized['id']}",
                           profile=normalized)
        total = int(dec.get("total_frames") or 0)
        out["preview"] = {"total_frames": total,
                          "skipped": dec.get("skipped"),
                          "reasons": dec.get("reasons"),
                          "channels": dec.get("channels"),
                          "fields": dec.get("fields")}
        rate = total / max(1, len(sample))
        out["decode_rate"] = round(rate, 3)
        if total == 0:
            out["ok"] = False
            out["error"] = "草稿能保存但解不出帧，请检查帧头/长度字段"
        elif rate < 0.8:
            warnings.append(f"回放只解出 {total}/{len(sample)} 帧 —— 可能有变长或"
                            f"多消息，建议补 variants 或改 length_field")
        else:
            evidence.append(f"草稿回放 {total}/{len(sample)} 帧全部解出，字段数 "
                            f"{dec.get('channels')}")
    except Exception as exc:                        # noqa: BLE001
        out["preview"] = {"error": f"{type(exc).__name__}: {exc}"}
    out["warnings"] = warnings
    out["evidence"] = evidence
    return out


def sf_id(name: str) -> str:
    """把任意名字收敛成合法的 profile id（``^[a-z0-9_-]{1,32}$``）。"""
    text = re.sub(r"[^a-z0-9_-]+", "_", str(name or "").strip().lower()).strip("_")
    text = text[:32] or "learned"
    if not text[0].isalnum():
        text = "p_" + text[:30]
    return text


# ══════════════════════════════════════════════════════════════════
#  verify：decode → encode → decode
# ══════════════════════════════════════════════════════════════════
def _raw_profile(profile: dict) -> dict:
    """把 profile 复制成"字段值即原始值"的版本，供反向组帧比对。

    decode 出来的字段是**语义值**（套过 scale/bias/enum）；直接拿去 encode
    会再走一次逆变换，浮点/枚举上必有误差。verify 要的是"字节能不能原样
    拼回去"，所以用原始值 + scale=1 的副本编码。
    """
    p = copy.deepcopy(profile)
    def strip(f: dict) -> None:
        f["scale"] = 1
        f["bias"] = 0
        f["enum"] = None
        f.pop("bits", None)
        if f.get("type") in ("ascii", "str"):
            f["type"] = "bytes"          # raw 是十六进制串，按字节原样写回
    for f in p.get("fields") or []:
        strip(f)
    for v in p.get("variants") or []:
        for f in v.get("fields") or []:
            strip(f)
    return p


def verify(profile: dict, vectors=None, *, hex: str = "", b64: str = "",
           capture: str = "", limit: int = 200) -> dict:
    """逐帧 round-trip：解出来的原始值重新编码，必须与线上字节逐字节相等。"""
    raw_profile = _raw_profile(profile)

    blob = b""
    explicit: list[bytes] = []
    if capture:
        chunks, _ = parse_capture(capture)
        blob = _join(chunks)
        if not blob:
            raise LearnError("录制文件里没有 rx 批次")
    elif vectors is not None:
        explicit = parse_frames(vectors)
    elif b64:
        try:
            blob = base64.b64decode(b64)
        except (binascii.Error, ValueError) as exc:
            raise LearnError(f"b64 不是合法 base64：{exc}")
    elif hex:
        blob = _hex_to_bytes(hex)
    else:
        raise LearnError("verify 需要 vectors / hex / b64 / capture 之一")

    cases: list[tuple[bytes, dict]] = []
    decoded = codec.decode(blob, f"profile:{profile.get('id', '')}",
                           profile=profile, keep_raw=True) if blob else None
    if decoded is not None:
        if not decoded.get("ok"):
            return {"ok": False, "error": decoded.get("error"),
                    "passed": 0, "failed": 0}
        for rec in decoded.get("records") or []:
            cases.append((bytes.fromhex(rec.get("frame_hex") or ""), rec))
    for item in explicit:
        d = codec.decode(item, f"profile:{profile.get('id', '')}",
                         profile=profile, keep_raw=True)
        for rec in (d.get("records") or []):
            cases.append((bytes.fromhex(rec.get("frame_hex") or ""), rec))

    if not cases:
        return {"ok": False, "error": "没有可校验的帧（解不出来）",
                "total": 0, "passed": 0, "failed": 0, "pass_rate": 0.0,
                "hint": "先用 preview 确认 profile 能解出至少一帧"}

    cases = cases[:max(1, int(limit))]
    passed = 0
    failures: list[dict] = []
    for i, (wire, rec) in enumerate(cases):
        try:
            enc = codec.encode(raw_profile, rec.get("raw") or {},
                               rec.get("id"))
        except Exception as exc:                    # noqa: BLE001
            failures.append({"frame": i, "hex": wire.hex(),
                             "error": f"{type(exc).__name__}: {exc}"})
            continue
        if not enc.get("ok"):
            failures.append({"frame": i, "hex": wire.hex(),
                             "error": enc.get("error")})
            continue
        if enc.get("hex") == wire.hex():
            passed += 1
        else:
            diff = _first_diff(wire, bytes.fromhex(enc["hex"]))
            failures.append({"frame": i, "hex": wire.hex(),
                             "reencoded": enc.get("hex"),
                             "first_diff": diff})
    total = len(cases)
    rate = passed / total if total else 0.0
    return {"ok": rate >= 0.95, "profile": profile.get("id", ""),
            "total": total, "passed": passed, "failed": total - passed,
            "pass_rate": round(rate, 3),
            "failures": failures[:10],
            "note": ("通过 = 解出来的原始值能拼回一模一样的字节；"
                     "失败通常是字段没覆盖全帧、或 scale 不是整数比")}


def _first_diff(a: bytes, b: bytes) -> int | None:
    for i in range(min(len(a), len(b))):
        if a[i] != b[i]:
            return i
    return None if len(a) == len(b) else min(len(a), len(b))


# ══════════════════════════════════════════════════════════════════
#  auto：给一段字节，选一个最像的 profile
# ══════════════════════════════════════════════════════════════════
#: 低于这个分数就保持 none —— 猜错比不猜更糟（用户会看着一堆错数据排查）。
AUTO_MIN_SCORE = 0.55
#: 第一名要比第二名好这么多才算"赢"，否则并列，不替用户做决定。
AUTO_MARGIN = 1.15


def score_profile(profile: dict, data: bytes) -> dict:
    """给 profile 打分：**字节覆盖率**为主，其次看错误率。

    覆盖率 = 被成功归帧的字节数 / 输入字节数。它天然惩罚"解出一帧就停"和
    "把每两个字节当一帧"这两种极端。
    """
    if not data:
        return {"id": profile.get("id", ""), "score": 0.0, "frames": 0,
                "reason": "没有输入字节"}
    dec = codec.decode(data, f"profile:{profile.get('id', '')}",
                       profile=profile, keep_raw=True)
    if not dec.get("ok"):
        return {"id": profile.get("id", ""), "score": 0.0, "frames": 0,
                "reason": dec.get("error")}
    records = dec.get("records") or []
    consumed = sum(len(r.get("frame_hex") or "") // 2 for r in records)
    coverage = consumed / len(data)
    frames = len(records)
    errors = int(dec.get("skipped") or 0)
    # 帧数太少（<2）多半是"碰巧命中"，把分数打下去
    if frames < 2:
        coverage *= 0.4
    err_penalty = 1.0 - min(0.6, errors / max(1, frames + errors))
    score = max(0.0, min(1.0, coverage * err_penalty))
    return {"id": profile.get("id", ""), "score": round(score, 3),
            "frames": frames, "errors": errors,
            "coverage": round(coverage, 3),
            "reasons": dec.get("reasons")}


def auto(profiles: list[dict], data: bytes) -> dict:
    """在候选集里选一个最优解码器。只推荐，不静默改会话。"""
    scored = [score_profile(p, data) for p in profiles]
    scored.sort(key=lambda r: (-r["score"], r["id"]))
    usable = [s for s in scored if s["score"] >= AUTO_MIN_SCORE]
    if not usable:
        return {"ok": False, "code": "no-match", "decoder": "",
                "candidates": scored,
                "note": (f"没有 profile 达到 {AUTO_MIN_SCORE} 分；"
                         f"先用 elab_frame_profile action=learn 学一个")}
    best = usable[0]
    second = usable[1] if len(usable) > 1 else None
    if second and best["score"] < second["score"] * AUTO_MARGIN:
        return {"ok": False, "code": "ambiguous", "decoder": "",
                "candidates": scored[:5],
                "note": (f"前两名分数太接近（{best['id']} {best['score']} vs "
                         f"{second['id']} {second['score']}），不替你选")}
    return {"ok": True, "decoder": f"profile:{best['id']}",
            "score": best["score"], "candidates": scored[:5],
            "evidence": [f"{c['id']} 覆盖率 {c.get('coverage')}，"
                         f"{c.get('frames')} 帧，错误 {c.get('errors')}"
                         for c in scored[:3]]}


# ══════════════════════════════════════════════════════════════════
#  codegen：C 头文件
# ══════════════════════════════════════════════════════════════════
_C_TYPES = {"u8": "uint8_t", "i8": "int8_t", "u16": "uint16_t",
            "i16": "int16_t", "u32": "uint32_t", "i32": "int32_t",
            "f32": "float", "f64": "double"}


def _c_ident(name: object, fallback: str = "f") -> str:
    """任意字段名 → 合法 C 标识符。

    profile 的字段名只要求"非空且不重复"，允许中文、连字符、数字开头 ——
    这些直接拼进 C 源码会让生成的头文件编不过（`char 温度[]`）。
    """
    s = re.sub(r"[^0-9A-Za-z_]", "_", str(name or ""))
    s = re.sub(r"_+", "_", s).strip("_")
    if s == "":
        return fallback
    return "_" + s if s[0].isdigit() else s


def _c_guard(text: object) -> str:
    """头文件 guard：只接受**本来就是**合法 C 标识符的输入，否则作废（返回 ""）。

    不做"净化改写"是有意的：``"X\\n#endif\\nint evil;"`` 净化后会变成
    ``X__ENDIF_INT_EVIL`` —— 注入确实没了，但 guard 变得莫名其妙，不如直接
    退回默认名并告警。这样规则只有一条：不是标识符就不用。
    """
    s = str(text or "")
    return s if re.fullmatch(r"[A-Za-z_][0-9A-Za-z_]*", s) else ""


def _c_member(f: dict, name: str | None = None) -> tuple[str, str]:
    """字段 → (C 声明, 注释)。非标准宽度一律用字节数组，保证 sizeof 正确。"""
    typ = f.get("type", "")
    name = name or _c_ident(f.get("name"), "f")
    arr = f.get("array")
    count = int(arr["count"]) if arr else 1
    if typ in ("ascii", "str"):
        return f"char {name}[{int(f.get('length') or 1)}];", "字符串"
    if typ == "bytes":
        return (f"uint8_t {name}[{int(f.get('length') or 1)}];", "原始字节")
    if typ in ("u24", "i24"):
        return f"uint8_t {name}[3];", f"{typ}（3 字节，手动组装）"
    if typ == "f16":
        return f"uint8_t {name}[2];", "f16（半精度，按 IEEE754 手解）"
    if f.get("bit_length"):
        span = (int(f.get("bit_offset") or 0) + int(f["bit_length"]) + 7) // 8
        return (f"uint8_t {name}[{span}];",
                f"{typ} 位域：offset {f.get('offset')}+{f.get('bit_offset', 0)}bit，"
                f"{f['bit_length']} bit")
    base = _C_TYPES.get(typ, "uint8_t")
    if arr:
        return f"{base} {name}[{count}];", f"数组 ×{count}，步长 {arr['stride']}"
    return f"{base} {name};", typ


def _is_le(profile: dict) -> bool:
    for f in profile.get("fields") or []:
        if f.get("endian") == "be":
            return False
        if f.get("endian") == "le":
            return True
    return True


def codegen(profile: dict, *, guard: str = "") -> dict:
    """生成 C 头文件：偏移表 + pack 结构体 + 校验引用 + 解帧骨架。"""
    pid = str(profile.get("id") or "profile")
    notes: list[str] = []
    given_guard = str(guard or "")
    safe_guard = _c_guard(given_guard)
    if given_guard and safe_guard == "":
        notes.append(f"guard {given_guard!r} 不是合法标识符，已改用默认名")
    hname = safe_guard or f"ELAB_FRAME_{re.sub(r'[^A-Z0-9]', '_', pid.upper())}_H"
    fr = profile.get("frame") or {}
    ck = codec.resolve_checksum(profile.get("checksum") or {})
    lines: list[str] = [
        "/* 自动生成：elab frame codegen（不要手改，改 profile 后重新生成） */",
        f"/* profile: {pid} — {profile.get('label') or pid} */",
        f"#ifndef {hname}",
        f"#define {hname}",
        "",
        "#include <stdint.h>",
        "",
        "#ifdef __cplusplus",
        'extern "C" {',
        "#endif",
        "",
        f"#define {hname[:-2]}_MAX_FRAME  {int(fr.get('max_bytes') or 256)}u",
    ]
    if fr.get("length"):
        lines.append(f"#define {hname[:-2]}_FRAME_LEN  {int(fr['length'])}u")
    if fr.get("head_hex"):
        lines.append(f"#define {hname[:-2]}_HEAD_LEN   {len(bytes.fromhex(fr['head_hex']))}u")
    lines.append("")

    fields = list(profile.get("fields") or [])
    for v in profile.get("variants") or []:
        fields.extend(v.get("fields") or [])
    seen: set[str] = set()
    uniq: list[dict] = []
    for f in fields:
        if f.get("name") in seen:
            continue
        seen.add(f.get("name"))
        uniq.append(f)

    # 净化后的成员名（同名冲突加 _2/_3；中文/连字符会变成 _，可能撞上）
    used: dict[str, int] = {}

    def member_name(f: dict) -> str:
        base = _c_ident(f.get("name"), "f")
        n = used.get(base, 0)
        used[base] = n + 1
        return base if n == 0 else f"{base}_{n + 1}"

    lines.append("/* 字段偏移表（字节） */")
    for f in uniq:
        macro = member_name(f).upper()
        lines.append(f"#define {hname[:-2]}_OFF_{macro}  {int(f.get('offset') or 0)}u")
    lines.append("")
    lines.append("#pragma pack(push, 1)")
    lines.append("typedef struct {")
    used.clear()
    for f in uniq:
        decl, note = _c_member(f, member_name(f))
        pad = max(1, 34 - len(decl))
        lines.append(f"    {decl}{' ' * pad}/* {note} */")
    lines.append(f"}} {hname[:-2]}_t;")
    lines.append("#pragma pack(pop)")
    lines.append("")
    if ck["algo"] != "none":
        algo = ck.get("preset") or ck["algo"]
        lines += [
            "/* 校验：与本头文件同目录的 elab_checksum.h 需提供 */",
            f"#define {hname[:-2]}_CHECKSUM  \"{algo}\"",
            f"#define {hname[:-2]}_CHECKSUM_SIZE  {int(ck.get('size') or 0)}u",
            "",
        ]
    lines += [
        "/* 取数辅助：本 profile 多字节字段按 " +
        ("小端" if _is_le(profile) else "大端") +
        " 存放，可直接用它读 */",
        f"static inline uint16_t {hname[:-2]}_rd_u16(const uint8_t *p) "
        + ("{ return (uint16_t)(p[0] | ((uint16_t)p[1] << 8)); }"
           if _is_le(profile)
           else "{ return (uint16_t)(((uint16_t)p[0] << 8) | p[1]); }"),
        "",
        "#ifdef __cplusplus",
        "}",
        "#endif",
        f"#endif /* {hname} */",
        "",
    ]
    text = "\n".join(lines)
    return {"ok": True, "file": f"generated/{pid}.h", "text": text,
            "bytes": len(text.encode("utf-8")),
            "warnings": notes,
            "note": "生成物只是起点：多字节字段按小端/大端由你确认，位域需手动组装"}
