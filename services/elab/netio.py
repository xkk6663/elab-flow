"""elab.netio —— 网络传输 IO（TCP 客户端 / TCP 服务端 / UDP），M4。

设计约束（方案 §4.8 / 附录 B）
----------------------------
· **默认只绑回环**：不显式 ``allow_remote: true`` 时，非 127.0.0.1/localhost
  一律拒绝 —— 串口监视是本地工具，不该默认把设备数据面暴露到局域网。
· **同一套 IO 契约**：``open/read/write/close`` + ``TransportLost``，与
  ``serialport.SerialIO`` 完全同形 —— 会话（serialmon）与发送（serialterm）
  不需要知道底下是串口还是 socket。
· **read 不阻塞**：200ms 超时 → 返回 ``b""``（与串口读线程同一节拍）。
· **如实报告**：桥接断开 → ``TransportLost``（会话按重连策略恢复），
  UDP 没有对端时 write 返回 0（不假装发出去了）。

TCP 服务端语义：**一次只服务一个客户端**。客户端断开 = 这条链路断了 →
抛 ``TransportLost``，会话重开监听（不做多客户端聚合，那会把"谁的数据"
搅成不可判定）。
"""

from __future__ import annotations

import ipaddress
import socket
import threading

from . import serialport as sp

#: 三类网络传输的默认绑定/目标（端口刻意避开 3333：openocd gdb server 占它）
NET_DEFAULTS = {
    "tcp-client": {"host": "127.0.0.1", "port": 9000},
    "tcp-server": {"bind": "127.0.0.1", "port": 9000},
    "udp": {"bind": "127.0.0.1", "port": 9000},
}
NET_KINDS = tuple(NET_DEFAULTS)
#: 读超时（秒）：与串口监视同一节拍，保证读线程能被 stop 事件及时唤醒
READ_TIMEOUT_S = 0.2
#: TCP 连接超时（秒）：连不上要尽快失败，不能把会话启动拖死
CONNECT_TIMEOUT_S = 3.0


def _is_loopback(host: str) -> bool:
    h = (host or "").strip().lower()
    if h in ("", "localhost"):
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def _port(v) -> int:
    try:
        p = int(v)
    except (TypeError, ValueError):
        return 0
    return p if 0 < p < 65536 else 0


def normalize(kind: str, raw: dict | None) -> tuple[dict, list[str], list[str]]:
    """规范化网络配置 → ``(cfg, errors, warnings)``。

    errors 非空 = 配置不合法（不开户）；warnings 是**允许但需要人知道**的事
    （如 UDP 没有固定对端）。
    """
    kind = str(kind or "").strip().lower()
    out: dict = {"kind": kind, **NET_DEFAULTS.get(kind, {})}
    errors: list[str] = []
    warnings: list[str] = []
    if kind not in NET_KINDS:
        errors.append(f"未知网络传输 {kind!r}（可选 {' / '.join(NET_KINDS)}）")
        return out, errors, warnings

    src = raw if isinstance(raw, dict) else {}
    for key in ("host", "bind", "remote_host"):
        if src.get(key) is not None:
            out[key] = str(src[key]).strip()
    if src.get("port") is not None:
        out["port"] = _port(src["port"])
    if src.get("remote_port") is not None:
        out["remote_port"] = _port(src["remote_port"])
    out["allow_remote"] = bool(src.get("allow_remote", False))
    try:
        out["timeout_s"] = max(0.05, min(float(src.get("timeout_s") or READ_TIMEOUT_S), 5.0))
    except (TypeError, ValueError):
        out["timeout_s"] = READ_TIMEOUT_S

    if kind == "tcp-client":
        if not out.get("host"):
            errors.append("tcp-client 需要 host（目标地址）")
        if not out.get("port"):
            errors.append("tcp-client 需要 port（目标端口，1~65535）")
        remote = out.get("host", "")
    else:
        bind = out.get("bind") or out.get("host") or ""
        out["bind"] = bind
        if not bind:
            errors.append(f"{kind} 需要 bind（绑定地址，默认 127.0.0.1）")
        if not out.get("port"):
            errors.append(f"{kind} 需要 port（监听端口，1~65535）")
        remote = bind
        if kind == "udp" and out.get("remote_host"):
            remote = out["remote_host"]
    if remote and not _is_loopback(remote) and not out["allow_remote"]:
        errors.append(
            f"地址 {remote!r} 不是回环地址：默认只允许 127.0.0.1/localhost。"
            f"确实要跨机连接请显式设 net.allow_remote: true")
    if kind == "udp" and not out.get("remote_port") and not out.get("remote_host"):
        warnings.append("UDP 未配置固定对端：先收到哪个地址的包就回发给它（write 在对端出现前返回 0）")
    return out, errors, warnings


def label_of(cfg: dict) -> str:
    kind = cfg.get("kind", "?")
    if kind == "tcp-client":
        return f"tcp://{cfg.get('host', '?')}:{cfg.get('port', '?')}"
    if kind == "udp":
        return f"udp://{cfg.get('bind', '?')}:{cfg.get('port', '?')}"
    return f"tcp-listen://{cfg.get('bind', '?')}:{cfg.get('port', '?')}"


class NetIO:
    """网络传输 IO（契约与 ``serialport.SerialIO`` 一致）。"""

    def __init__(self, cfg: dict, *, label: str = ""):
        self.cfg = dict(cfg or {})
        self.kind = str(self.cfg.get("kind") or "")
        self.label = label or label_of(self.cfg)
        self.backend = f"net/{self.kind}"
        self._sock: socket.socket | None = None
        self._conn: socket.socket | None = None
        self._peer: tuple[str, int] | None = None
        self._closed = False
        self._lock = threading.Lock()

    # ── 开户 / 收摊 ────────────────────────────────────────────
    def open(self) -> None:
        if self.kind == "tcp-client":
            sock = socket.create_connection(
                (self.cfg["host"], int(self.cfg["port"]),),
                timeout=CONNECT_TIMEOUT_S)
            sock.settimeout(float(self.cfg.get("timeout_s") or READ_TIMEOUT_S))
        elif self.kind == "tcp-server":
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((self.cfg.get("bind") or "127.0.0.1", int(self.cfg["port"])))
            sock.listen(1)
            sock.settimeout(float(self.cfg.get("timeout_s") or READ_TIMEOUT_S))
        elif self.kind == "udp":
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((self.cfg.get("bind") or "127.0.0.1", int(self.cfg["port"])))
            sock.settimeout(float(self.cfg.get("timeout_s") or READ_TIMEOUT_S))
        else:
            raise OSError(f"未知网络传输 {self.kind!r}")
        self._sock = sock
        self._closed = False

    def close(self) -> None:
        self._closed = True
        self._close_conn()
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _close_conn(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    # ── 数据面 ────────────────────────────────────────────────
    def read(self, size: int = 4096) -> bytes:
        sock = self._sock
        if sock is None or self._closed:
            return b""
        try:
            if self.kind == "udp":
                data, peer = sock.recvfrom(size)
                self._peer = peer
                return data
            if self.kind == "tcp-server" and self._conn is None:
                # 懒 accept：会话开着但还没有客户端 → 继续等（不报掉线）
                self._conn, self._peer = sock.accept()
                self._conn.settimeout(float(self.cfg.get("timeout_s") or READ_TIMEOUT_S))
            src = self._conn if self.kind == "tcp-server" else sock
            if src is None:
                return b""
            data = src.recv(size)
            if data == b"":
                # TCP 对端**优雅关闭**（recv 返回空）—— 与 OSError 同一语义：
                # 这是"链路断了"，不是"暂时没有数据"。不抛的话会话会静默空转。
                self._close_conn()
                raise sp.TransportLost(f"{self.backend} 对端已关闭连接")
            return data
        except sp.TransportLost:
            self._close_conn()
            raise
        except socket.timeout:
            return b""
        except OSError as exc:
            # 客户端断开 / socket 被关闭：这是"链路断了"，交给会话重连策略；
            # tcp-server 丢掉旧连接、回到监听态（不把整个会话判死）。
            self._close_conn()
            raise sp.TransportLost(f"{self.backend} 链路断开：{exc}") from exc

    def write(self, data: bytes) -> int:
        if not data:
            return 0
        sock = self._sock
        if sock is None or self._closed:
            return 0
        try:
            if self.kind == "udp":
                target = self._udp_target()
                if target is None:
                    return 0          # 没有对端：如实返回 0，不假装发出去
                sock.sendto(data, target)
                return len(data)
            dst = self._conn if self.kind == "tcp-server" else sock
            if dst is None:
                return 0          # 监听中还没有客户端
            with self._lock:
                dst.sendall(data)
            return len(data)
        except OSError as exc:
            self._close_conn()
            raise sp.TransportLost(f"{self.backend} 写入失败：{exc}") from exc

    def _udp_target(self) -> tuple[str, int] | None:
        host = self.cfg.get("remote_host")
        port = self.cfg.get("remote_port")
        if host and port:
            return (str(host), int(port))
        return self._peer


def open_net(cfg: dict, *, label: str = "") -> NetIO:
    """开一个 NetIO（失败抛 OSError，调用方如实上报）。"""
    io = NetIO(cfg, label=label)
    io.open()
    return io
