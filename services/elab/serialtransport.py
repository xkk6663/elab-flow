"""elab.serialtransport —— 传输抽象（串口 / 网络）。

为什么要有这一层
----------------
今天"开一条串口"这件事在三个地方各写一遍：``serialterm.resolve_target``、
``monitor.run()``、``serialmon.open_session``。它们的优先级曾经漂移过
（预览说 COM10、监视却开了 auto）—— 每多一处实现就多一处漂移机会。

本模块是**唯一的解析与开户入口**：

    resolve()  ：「发给谁」+「用什么线参数」+「为什么选它」（纯解析，不开关口）
    open()     ：按解析结果开 IO（串口现在可用；网络传输在 M4 落地）

分层纪律：本模块不认识 run / 事件 / 面板，只依赖 ``serialport`` 与 ``Config``。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import netio
from . import serialport as sp
from .config import Config

#: 传输种类。serial = 物理串口；其余三种走网络（M4）。
NET_KINDS = netio.NET_KINDS
KINDS = ("serial", *NET_KINDS)


@dataclass(frozen=True)
class Target:
    """解析结果（``label`` 为空 = 没选出来，理由在 ``reason``，**不猜**）。"""

    kind: str
    label: str
    port_spec: str
    baud: int
    line: sp.LineConfig
    net: dict = field(default_factory=dict)
    reason: str = ""
    errors: tuple[str, ...] = ()
    # 串口枚举出的候选（面板要用；网络传输为空）
    ports: tuple = ()
    backend: str = ""

    def as_dict(self) -> dict:
        return {
            "kind": self.kind, "label": self.label, "spec": self.port_spec,
            "baud": self.baud, "line": self.line.as_dict(),
            "line_text": self.line.text, "net": dict(self.net),
            "reason": self.reason, "backend": self.backend,
            "errors": list(self.errors),
        }


def resolve(cfg: Config, project: str = "", *, port: str = "", baud: int = 0,
            transport: str = "", net: dict | None = None,
            line=None) -> Target:
    """解析「发给谁」。优先级：显式参数 → 工程 ``serial.*`` → 宿主 ``serial.*`` → 默认。

    ★ 与旧 ``serialterm.resolve_target`` 的顺序**逐字一致**，只是把线参数与
      传输种类也纳入同一份解析 —— 否则"监视 7E1、闭环判定 8N1"会分叉。
    """
    proj = cfg.resolved_project(project) if project else {}
    ser = (proj.get("serial") or {}) if isinstance(proj, dict) else {}
    host_ser = (cfg.host or {}).get("serial") or {}

    spec = port or ser.get("port") or host_ser.get("default") or "auto"
    try:
        b = int(baud or ser.get("baud") or host_ser.get("baud") or 115200)
    except (TypeError, ValueError):
        b = 115200

    kind = str(transport or ser.get("transport") or host_ser.get("transport")
               or "serial").strip().lower()
    raw_line = line if line is not None else (ser.get("line") or host_ser.get("line"))
    line_cfg, line_errors = sp.line_config(raw_line)
    errors = list(line_errors)
    net_cfg = dict(net if net is not None else
                   (ser.get("net") or host_ser.get("net") or {}))

    if kind == "serial":
        ports, backend = sp.list_ports()
        chosen, why, _cands = sp.select_port(spec, ports)
        return Target(kind="serial", label=chosen, port_spec=spec, baud=b,
                      line=line_cfg, reason=why, errors=tuple(errors),
                      ports=tuple(ports), backend=backend)

    if kind not in KINDS:
        errors.append(f"未知传输 {kind!r}（可选 {' / '.join(KINDS)}）")
        return Target(kind=kind, label="", port_spec=spec, baud=b,
                      line=line_cfg, net=net_cfg, errors=tuple(errors))

    # 网络传输（M4）：与串口同一份解析，默认只允许回环地址。
    net_norm, net_errors, _net_warns = netio.normalize(kind, net_cfg)
    errors.extend(net_errors)
    label = netio.label_of(net_norm)
    return Target(kind=kind, label=label, port_spec=spec, baud=b,
                  line=line_cfg, net=net_norm, reason="",
                  errors=tuple(errors), backend=f"net/{kind}")


def open(target: Target, *, for_write: bool = False) -> "sp.SerialIO":
    """按解析结果开一个 IO。失败抛 ``OSError``（调用方如实上报）。"""
    if target.errors:
        raise OSError("传输配置不合法：" + "；".join(target.errors))
    if target.kind != "serial":
        if not target.label:
            raise OSError(target.reason or "网络传输地址为空")
        return netio.open_net(target.net, label=target.label)      # type: ignore[return-value]
    if not target.label:
        raise OSError(target.reason or "端口名为空 —— 请先解析 serial.port")
    return sp.SerialIO(target.label, target.baud, for_write=for_write,
                       line=target.line)
