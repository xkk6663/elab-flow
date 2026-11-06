"""elab.modbus —— Modbus RTU 的 PDU 编解码（协议层，不做 IO）。

边界
----
只做三件事：**请求 → 线上字节**、**线上字节 → 响应**、**寄存器字 → 业务值**。
功能码、异常码、CRC16-RTU、类型/字序转换、数量与地址边界都在这里收敛。

不做什么
--------
- 不打开串口、不认识 ``serialmon._Session`` —— 事务调度在 ``modbusmaster``；
- 不保存寄存器映射（工程数据，见 ``projects/<name>.modbus.json``）；
- 不猜厂商地址基准：``address`` **永远是协议偏移（0 基）**，
  手册上的 40001/30001 只在文档里换算，不进内核。

线上形状（RTU ADU，8N1）
------------------------
``[unit 1B][fc 1B][body nB][crc_lo 1B][crc_hi 1B]``
CRC 是标准 CRC16/MODBUS（poly 0xA001 反射写、init 0xFFFF、无最终异或），
**低字节在前**。这一条错一次，从站会静默丢掉所有帧。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

# ── 功能码 ───────────────────────────────────────────────────────
FC_READ_COILS = 0x01
FC_READ_DISCRETE = 0x02
FC_READ_HOLDING = 0x03
FC_READ_INPUT = 0x04
FC_WRITE_COIL = 0x05
FC_WRITE_REGISTER = 0x06
FC_WRITE_COILS = 0x0F
FC_WRITE_REGISTERS = 0x10

FCS = (FC_READ_COILS, FC_READ_DISCRETE, FC_READ_HOLDING, FC_READ_INPUT,
       FC_WRITE_COIL, FC_WRITE_REGISTER, FC_WRITE_COILS, FC_WRITE_REGISTERS)

#: 功能码 → 人类可读名（面板与 Agent 共用，不各自造词）
FC_LABELS = {
    FC_READ_COILS: "读线圈",
    FC_READ_DISCRETE: "读离散输入",
    FC_READ_HOLDING: "读保持寄存器",
    FC_READ_INPUT: "读输入寄存器",
    FC_WRITE_COIL: "写单个线圈",
    FC_WRITE_REGISTER: "写单个寄存器",
    FC_WRITE_COILS: "写多个线圈",
    FC_WRITE_REGISTERS: "写多个寄存器",
}

#: 读位：返回的是 0/1 序列，不是寄存器字
BIT_FCS = (FC_READ_COILS, FC_READ_DISCRETE)
READ_FCS = (FC_READ_COILS, FC_READ_DISCRETE, FC_READ_HOLDING, FC_READ_INPUT)

# ── 异常码（从站应答的 fc|0x80 帧里的那一个字节）─────────────────
EXCEPTIONS = {
    0x01: ("illegal_function", "不支持的功能码"),
    0x02: ("illegal_address", "地址越界"),
    0x03: ("illegal_value", "数量或值非法"),
    0x04: ("device_failure", "从站内部故障"),
    0x05: ("acknowledge", "已受理，需轮询结果"),
    0x06: ("busy", "从站忙"),
    0x08: ("memory_parity", "存储校验错"),
    0x0A: ("gateway_path", "网关路径不可用"),
    0x0B: ("gateway_target", "网关目标无应答"),
}

# ── 协议限制（超了不是"报错"，是**根本不该发出**）────────────────
MAX_FRAME = 256
UNIT_MIN, UNIT_MAX = 1, 247
ADDR_MAX = 0xFFFF
MAX_READ_BITS = 2000
MAX_READ_REGS = 125
MAX_WRITE_REGS = 123
MAX_WRITE_BITS = 1968
BROADCAST_UNIT = 0

#: 点类型 → 占用的 16 位字数
TYPES = ("bit", "u16", "s16", "u32", "s32", "f32")
TYPE_WORDS = {"bit": 1, "u16": 1, "s16": 1, "u32": 2, "s32": 2, "f32": 2}
#: 需要显式字序的类型（跨两个寄存器的 32 位值）
WORD_ORDER_TYPES = ("u32", "s32", "f32")
WORD_ORDERS = ("big", "little")
#: 32 位类型的 struct 格式（显式表 > 用元组下标算术）
_STRUCT32 = {"u32": ">I", "s32": ">i", "f32": ">f"}

#: 错误分类（计划 §5.4）。timeout/port 由事务层产生，其余在这一层判定。
ERROR_KINDS = ("timeout", "crc", "exception", "malformed", "port")


class ModbusError(Exception):
    """带分类的协议错误。

    ``kind``  ∈ :data:`ERROR_KINDS`
    ``code``  异常码（仅 kind == "exception" 时非 0）
    """

    def __init__(self, kind: str, detail: str, *, code: int = 0):
        super().__init__(detail)
        self.kind = kind
        self.code = code
        self.detail = detail

    def as_dict(self) -> dict:
        return {"kind": self.kind, "code": self.code,
                "code_name": EXCEPTIONS.get(self.code, ("", ""))[0] if self.code else "",
                "detail": self.detail}


# ── CRC ──────────────────────────────────────────────────────────
def crc16_modbus(data: bytes) -> int:
    """标准 CRC16/MODBUS：poly 0xA001（反射）、init 0xFFFF、无 xorout。"""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF


def crc_bytes(data: bytes) -> bytes:
    """线上字节序：**低字节在前**（与 CRC 数值的高低位相反，最容易写错的一处）。"""
    c = crc16_modbus(data)
    return bytes((c & 0xFF, (c >> 8) & 0xFF))


def check_crc(adu: bytes) -> None:
    if len(adu) < 4:
        raise ModbusError("crc", f"帧太短（{len(adu)}B），无法校验")
    body, tail = adu[:-2], adu[-2:]
    if crc_bytes(body) != tail:
        raise ModbusError(
            "crc", f"CRC 不符：算出 {crc_bytes(body).hex(' ')}，帧里是 {tail.hex(' ')}")


# ── 请求 ─────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Request:
    """一条**已规范化**的请求。构造走 :func:`build`，它会做全部边界校验。"""

    unit: int
    fc: int
    address: int
    count: int = 0
    #: 写线圈：tuple[int]（每项 0/1）；写寄存器：tuple[int]（16 位字）
    values: tuple = ()
    #: 单写功能码（05/06）的原始值，保留 0xFF00 / 原字，便于回显比对
    raw_value: int = 0

    @property
    def broadcast(self) -> bool:
        return self.unit == BROADCAST_UNIT

    @property
    def is_read(self) -> bool:
        return self.fc in READ_FCS

    @property
    def label(self) -> str:
        return FC_LABELS.get(self.fc, f"FC{self.fc:02X}")

    @property
    def body(self) -> bytes:
        """PDU 除功能码外的部分。"""
        if self.fc in READ_FCS:
            return struct.pack(">HH", self.address, self.count)
        if self.fc == FC_WRITE_COIL:
            return struct.pack(">HH", self.address, self.raw_value)
        if self.fc == FC_WRITE_REGISTER:
            # ★ 用 raw_value 而不是 count：count 是"写了几个"，这里要的是"写了什么"
            return struct.pack(">HH", self.address, self.raw_value & 0xFFFF)
        if self.fc == FC_WRITE_COILS:
            packed = _pack_bits(self.values)
            return (struct.pack(">HHB", self.address, self.count, len(packed))
                    + packed)
        if self.fc == FC_WRITE_REGISTERS:
            words = b"".join(struct.pack(">H", v & 0xFFFF) for v in self.values)
            return struct.pack(">HHB", self.address, self.count, len(words)) + words
        raise ModbusError("malformed", f"不支持的功能码 {self.fc}")

    def encode(self) -> bytes:
        """整帧 RTU：unit + fc + body + CRC(lo,hi)。"""
        head = bytes((self.unit & 0xFF, self.fc & 0xFF)) + self.body
        return head + crc_bytes(head)

    def as_dict(self) -> dict:
        return {"unit": self.unit, "fc": self.fc, "label": self.label,
                "address": self.address, "count": self.count,
                "values": list(self.values),
                # 线的两端都留着：事务日志要能原文回放
                "hex": self.encode().hex(" ").upper()}


def _pack_bits(bits) -> bytes:
    out = bytearray((len(bits) + 7) // 8)
    for i, b in enumerate(bits):
        if b:
            out[i // 8] |= 1 << (i % 8)
    return bytes(out)


def _unpack_bits(data: bytes, count: int) -> list[int]:
    return [(data[i // 8] >> (i % 8)) & 1 for i in range(count)]


def build(fc: int, address: int, *, count: int = 0, values=None,
          unit: int = 1) -> Request:
    """构造请求并**当场**做完边界校验。

    宁可在这里抛错，也不要把一帧非法请求发到总线上 —— 从站只会回一个
    异常码，而人看到的却是"设备不听话"。
    """
    if fc not in FCS:
        raise ModbusError("malformed", f"不支持的功能码 0x{fc:02X}（可写/可读见 FC_LABELS）")
    if not isinstance(unit, int) or (unit != BROADCAST_UNIT
                                     and not UNIT_MIN <= unit <= UNIT_MAX):
        raise ModbusError("malformed", f"从站地址 {unit} 超出 0（广播）或 1..247")
    if not isinstance(address, int) or not 0 <= address <= ADDR_MAX:
        raise ModbusError("malformed", f"寄存器地址 {address} 超出 0..65535")

    if fc in READ_FCS:
        limit = MAX_READ_BITS if fc in BIT_FCS else MAX_READ_REGS
        if not 1 <= count <= limit:
            raise ModbusError("malformed", f"{FC_LABELS[fc]}数量 {count} 超出 1..{limit}")
        if address + count - 1 > ADDR_MAX:
            raise ModbusError("malformed", f"起始地址 {address} + 数量 {count} 越过 65535")
        return Request(unit=unit, fc=fc, address=address, count=count)

    if fc == FC_WRITE_COIL:
        if values is None:
            values = (count,)
        v = 1 if (values[0] if values else 0) else 0
        return Request(unit=unit, fc=fc, address=address, count=1,
                       values=(v,), raw_value=0xFF00 if v else 0x0000)

    if fc == FC_WRITE_REGISTER:
        if values is None:
            values = (count,)
        if len(values) != 1:
            raise ModbusError("malformed", "FC06 只能写一个寄存器")
        v = int(values[0])
        if not 0 <= v <= 0xFFFF:
            raise ModbusError("malformed", f"寄存器值 {v} 超出 0..65535")
        return Request(unit=unit, fc=fc, address=address, count=1,
                       values=(v,), raw_value=v)

    # 0F / 10：批量写
    vals = tuple(int(x) for x in (values or ()))
    if fc == FC_WRITE_COILS:
        vals = tuple(1 if v else 0 for v in vals)
        limit = MAX_WRITE_BITS
    else:
        vals = tuple(v & 0xFFFF for v in vals)
        limit = MAX_WRITE_REGS
        for v in (values or ()):
            if not 0 <= int(v) <= 0xFFFF:
                raise ModbusError("malformed", f"寄存器值 {v} 超出 0..65535")
    if not 1 <= len(vals) <= limit:
        raise ModbusError("malformed",
                          f"{FC_LABELS[fc]}数量 {len(vals)} 超出 1..{limit}")
    if address + len(vals) - 1 > ADDR_MAX:
        raise ModbusError("malformed", f"起始地址 {address} + 数量 {len(vals)} 越过 65535")
    return Request(unit=unit, fc=fc, address=address, count=len(vals), values=vals)


def response_size(req: Request) -> int:
    """这条请求**期望**的应答总字节数（不含异常帧的 5B 兜底）。

    事务层用它判定"收齐了没有"—— RTU 没有帧头也没有长度字段，
    长度来自"我发出去的是什么"。
    """
    if req.fc in BIT_FCS:
        return 5 + (req.count + 7) // 8
    if req.fc in (FC_READ_HOLDING, FC_READ_INPUT):
        return 5 + 2 * req.count
    if req.fc in (FC_WRITE_COIL, FC_WRITE_REGISTER,
                  FC_WRITE_COILS, FC_WRITE_REGISTERS):
        return 8
    raise ModbusError("malformed", f"不支持的功能码 {req.fc}")


# ── 响应 ─────────────────────────────────────────────────────────
@dataclass
class Response:
    unit: int
    fc: int
    #: 位读：0/1 列表；寄存器读：16 位字列表；写：回显（地址/值）
    values: list = field(default_factory=list)
    #: 写应答的回显地址（05/06/0F/10 才有）
    echo_address: int | None = None
    echo_value: int | None = None
    raw: bytes = b""

    def as_dict(self) -> dict:
        out = {"unit": self.unit, "fc": self.fc,
               "label": FC_LABELS.get(self.fc, f"FC{self.fc:02X}"),
               "values": list(self.values),
               "hex": self.raw.hex(" ").upper(),
               "bytes": len(self.raw)}
        if self.echo_address is not None:
            out["echo_address"] = self.echo_address
        if self.echo_value is not None:
            out["echo_value"] = self.echo_value
        return out


def parse(req: Request, adu: bytes) -> Response:
    """按请求解释应答；任何不对都在这里归到 5 类错误之一。"""
    adu = bytes(adu)
    if not adu:
        raise ModbusError("timeout", "没有收到任何字节")
    if len(adu) < 5:
        raise ModbusError("malformed", f"应答只有 {len(adu)}B，短于最短 RTU 帧 5B")
    check_crc(adu)

    unit, fc = adu[0], adu[1]
    if unit != req.unit:
        raise ModbusError("malformed", f"从站地址不符：期望 {req.unit}，收到 {unit}")

    # 异常应答：功能码最高位为 1，数据段只有 1 字节异常码
    if fc & 0x80:
        if len(adu) != 5:
            raise ModbusError("malformed", f"异常帧长度 {len(adu)}B ≠ 5B")
        code = adu[2]
        name, label = EXCEPTIONS.get(code, ("unknown", "未知异常码"))
        # ★ 括号不能省：`fc & 0x7F != req.fc` 在 Python 里是 `fc & (0x7F != req.fc)`
        if (fc & 0x7F) != req.fc:
            raise ModbusError("malformed",
                             f"异常帧功能码 0x{fc & 0x7F:02X} 与请求 0x{req.fc:02X} 不符")
        raise ModbusError("exception", f"从站异常 {code:02X} {label}（{name}）", code=code)

    if fc != req.fc:
        raise ModbusError("malformed",
                         f"功能码回显不符：请求 0x{req.fc:02X}，应答 0x{fc:02X}")

    want = response_size(req)
    if len(adu) != want:
        raise ModbusError("malformed",
                         f"应答长度 {len(adu)}B，按请求应为 {want}B")

    if req.fc in BIT_FCS:
        bc = adu[2]
        body = adu[3:-2]
        if bc != len(body) or bc != (req.count + 7) // 8:
            raise ModbusError("malformed",
                             f"字节数不符：报 {bc}，实收 {len(body)}，应为 {(req.count + 7) // 8}")
        return Response(unit=unit, fc=fc, values=_unpack_bits(body, req.count), raw=adu)

    if req.fc in (FC_READ_HOLDING, FC_READ_INPUT):
        bc = adu[2]
        body = adu[3:-2]
        if bc % 2 or bc != 2 * req.count:
            raise ModbusError("malformed",
                             f"寄存器字节数不符：报 {bc}，应为 {2 * req.count}")
        words = list(struct.unpack(">" + "H" * req.count, body))
        return Response(unit=unit, fc=fc, values=words, raw=adu)

    # 05/06/0F/10：正应答是请求的回显（地址 + 值/数量）
    addr, val = struct.unpack(">HH", adu[2:6])
    if req.fc in (FC_WRITE_COIL, FC_WRITE_REGISTER):
        if addr != req.address or val != (req.raw_value & 0xFFFF):
            raise ModbusError("malformed",
                             f"写回显不符：期望 {req.address}/{req.raw_value:#06x}，"
                             f"收到 {addr}/{val:#06x}")
        return Response(unit=unit, fc=fc, values=[val], echo_address=addr,
                        echo_value=val, raw=adu)
    if addr != req.address or val != req.count:
        raise ModbusError("malformed",
                         f"批量写回显不符：期望 地址 {req.address} 数量 {req.count}，"
                         f"收到 {addr}/{val}")
    return Response(unit=unit, fc=fc, values=list(req.values),
                    echo_address=addr, echo_value=val, raw=adu)


# ── 寄存器字 ↔ 业务值 ────────────────────────────────────────────
def decode_registers(words, type_: str = "u16", word_order: str = "big"):
    """把 1~2 个 16 位寄存器解释成业务值。

    ``word_order`` 只对 32 位类型有意义：``big`` = 高字在前（Modbus 惯例），
    ``little`` = 低字在前（部分电表/变频器）。这一项**必须显式**，
    猜错的后果是数值看起来"离谱但不像 0"，比全 0 更难查。
    """
    if type_ not in TYPES:
        raise ModbusError("malformed", f"未知点类型 {type_!r}（可选 {', '.join(TYPES)}）")
    words = list(words)
    if type_ == "bit":
        return 1 if words and words[0] else 0
    if type_ in ("u16", "s16"):
        if not words:
            raise ModbusError("malformed", "u16/s16 需要 1 个寄存器")
        return struct.unpack(">h" if type_ == "s16" else ">H", struct.pack(">H", words[0] & 0xFFFF))[0]
    if len(words) < 2:
        raise ModbusError("malformed", f"{type_} 需要 2 个寄存器（收到 {len(words)}）")
    if word_order not in WORD_ORDERS:
        raise ModbusError("malformed", f"字序 {word_order!r} 非法（big|little）")
    hi, lo = (words[0], words[1]) if word_order == "big" else (words[1], words[0])
    raw = struct.pack(">HH", hi & 0xFFFF, lo & 0xFFFF)
    return struct.unpack(_STRUCT32[type_], raw)[0]


def encode_registers(value, type_: str = "u16", word_order: str = "big") -> list[int]:
    """业务值 → 寄存器字列表（写点用）。"""
    if type_ not in TYPES:
        raise ModbusError("malformed", f"未知点类型 {type_!r}")
    if type_ == "bit":
        return [1 if value else 0]
    if type_ in ("u16", "s16"):
        fmt = ">h" if type_ == "s16" else ">H"
        try:
            return list(struct.unpack(">H", struct.pack(fmt, int(value))))
        except struct.error as exc:
            raise ModbusError("malformed", f"{value} 放不进 {type_}：{exc}") from exc
    if word_order not in WORD_ORDERS:
        raise ModbusError("malformed", f"字序 {word_order!r} 非法（big|little）")
    try:
        hi, lo = struct.unpack(">HH", struct.pack(_STRUCT32[type_], value))
    except struct.error as exc:
        raise ModbusError("malformed", f"{value} 放不进 {type_}：{exc}") from exc
    return [hi, lo] if word_order == "big" else [lo, hi]


def scaled(raw, *, scale: float = 1.0, bias: float = 0.0):
    """展示值。**只影响显示与波形，不改变线上原始值。**"""
    try:
        return round(float(raw) * float(scale) + float(bias), 6)
    except (TypeError, ValueError):
        return raw


def describe(frame: bytes) -> dict:
    """把一段裸字节**尽力**解释成请求/应答（事务日志、面板提示用）。

    只用于展示：不校验会话状态，不保证语义正确。CRC 坏了会照实标出来。
    """
    frame = bytes(frame)
    out = {"bytes": len(frame), "hex": frame.hex(" ").upper()}
    if len(frame) < 4:
        out["kind"] = "unknown"
        return out
    out["crc_ok"] = crc_bytes(frame[:-2]) == frame[-2:]
    out["unit"] = frame[0]
    fc = frame[1]
    if fc & 0x80:
        out["kind"] = "exception"
        out["fc"] = fc & 0x7F
        out["exception_code"] = frame[2] if len(frame) > 2 else 0
        out["exception_name"] = EXCEPTIONS.get(out["exception_code"], ("未知", ""))[0]
        return out
    out["kind"] = "frame"
    out["fc"] = fc
    out["fc_label"] = FC_LABELS.get(fc, f"FC{fc:02X}")
    return out


def limits() -> dict:
    """把边界暴露给面板/Agent —— 它们不该自己记数字。"""
    return {"max_frame": MAX_FRAME, "unit_min": UNIT_MIN,
            "unit_max": UNIT_MAX, "broadcast": BROADCAST_UNIT,
            "max_read_bits": MAX_READ_BITS, "max_read_regs": MAX_READ_REGS,
            "max_write_regs": MAX_WRITE_REGS, "max_write_bits": MAX_WRITE_BITS,
            "types": list(TYPES), "word_orders": list(WORD_ORDERS),
            "fc": [{"code": fc, "label": FC_LABELS[fc],
                    "read": fc in READ_FCS, "bits": fc in BIT_FCS}
                   for fc in FCS],
            "exceptions": [{"code": c, "name": n, "label": lb}
                           for c, (n, lb) in sorted(EXCEPTIONS.items())],
            "error_kinds": list(ERROR_KINDS)}
