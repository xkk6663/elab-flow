"""M4 网络传输（TCP 客户端 / TCP 服务端 / UDP）的门禁测试。

覆盖的是**契约**而不是实现细节：
  · 默认只允许回环（非回环必须显式 allow_remote）
  · 三种传输都能收发（与 SerialIO 同一份 read/write 契约）
  · 对端关闭 = 链路断开（TransportLost），不是"暂时没有数据"
  · UDP 没有对端时 write 返回 0（不假装发出去了）
"""

from __future__ import annotations

import socket
import unittest

from elab import netio
from elab import serialport as sp


def _free_port() -> int:
    """拿一个大概率空闲的端口（绑 0 → 读实际端口 → 关掉）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])
    finally:
        s.close()


class TestNormalize(unittest.TestCase):
    def test_defaults_are_loopback(self) -> None:
        for kind, dft in netio.NET_DEFAULTS.items():
            cfg, errors, _warns = netio.normalize(kind, None)
            self.assertEqual(errors, [], kind)
            host = cfg.get("host") or cfg.get("bind")
            self.assertEqual(host, dft.get("host") or dft.get("bind"))
            self.assertEqual(cfg["port"], dft["port"])
            self.assertFalse(cfg["allow_remote"], "默认不允许非回环")

    def test_remote_requires_allow_remote(self) -> None:
        cfg, errors, _ = netio.normalize("tcp-client", {"host": "192.168.1.10", "port": 9000})
        self.assertFalse(cfg["allow_remote"])
        self.assertTrue(any("allow_remote" in e for e in errors), errors)

        cfg2, errors2, _ = netio.normalize(
            "tcp-client", {"host": "192.168.1.10", "port": 9000, "allow_remote": True})
        self.assertTrue(cfg2["allow_remote"])
        self.assertEqual(errors2, [])

    def test_loopback_localhost_ok(self) -> None:
        for host in ("127.0.0.1", "localhost", "::1"):
            _cfg, errors, _ = netio.normalize("tcp-client", {"host": host, "port": 9000})
            self.assertEqual(errors, [], host)

    def test_bad_port(self) -> None:
        _cfg, errors, _ = netio.normalize("tcp-server", {"port": 0})
        self.assertTrue(any("port" in e for e in errors), errors)
        _cfg, errors, _ = netio.normalize("udp", {"port": 70000})
        self.assertTrue(any("port" in e for e in errors), errors)

    def test_unknown_kind(self) -> None:
        _cfg, errors, _ = netio.normalize("socketcan", None)
        self.assertTrue(errors)

    def test_udp_no_peer_warns(self) -> None:
        _cfg, errors, warns = netio.normalize("udp", None)
        self.assertEqual(errors, [])
        self.assertTrue(warns, "UDP 无固定对端应给出 warning")


class TestTcpServer(unittest.TestCase):
    def test_server_read_write_and_eof(self) -> None:
        port = _free_port()
        srv = netio.open_net({"kind": "tcp-server", "bind": "127.0.0.1",
                              "port": port, "timeout_s": 0.2})
        try:
            client = socket.create_connection(("127.0.0.1", port), timeout=2)
            try:
                client.sendall(b"hello")
                # 懒 accept + 读：第一次 read 会 accept 并取到这条数据
                self.assertEqual(srv.read(), b"hello")
                self.assertEqual(srv.write(b"world"), 5)
                self.assertEqual(client.recv(5), b"world")
            finally:
                client.close()
            # 对端优雅关闭 → 链路断开（不是"没数据"）
            with self.assertRaises(sp.TransportLost):
                srv.read()
        finally:
            srv.close()

    def test_server_write_without_client_is_zero(self) -> None:
        port = _free_port()
        srv = netio.open_net({"kind": "tcp-server", "bind": "127.0.0.1",
                              "port": port, "timeout_s": 0.2})
        try:
            self.assertEqual(srv.write(b"nobody"), 0)
        finally:
            srv.close()

    def test_read_timeout_returns_empty(self) -> None:
        port = _free_port()
        srv = netio.open_net({"kind": "tcp-server", "bind": "127.0.0.1",
                              "port": port, "timeout_s": 0.1})
        try:
            self.assertEqual(srv.read(), b"", "无客户端时应返回空而不是报错")
        finally:
            srv.close()


class TestTcpClient(unittest.TestCase):
    def test_client_roundtrip(self) -> None:
        port = _free_port()
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", port))
        srv.listen(1)
        srv.settimeout(2)
        try:
            cli = netio.open_net({"kind": "tcp-client", "host": "127.0.0.1",
                                  "port": port, "timeout_s": 0.2})
            try:
                conn, _ = srv.accept()
                try:
                    cli.write(b"ping")
                    self.assertEqual(conn.recv(4), b"ping")
                    conn.sendall(b"pong")
                    self.assertEqual(cli.read(), b"pong")
                finally:
                    conn.close()
            finally:
                cli.close()
        finally:
            srv.close()

    def test_client_eof_raises(self) -> None:
        port = _free_port()
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(("127.0.0.1", port))
        srv.listen(1)
        srv.settimeout(2)
        try:
            cli = netio.open_net({"kind": "tcp-client", "host": "127.0.0.1",
                                  "port": port, "timeout_s": 0.2})
            try:
                conn, _ = srv.accept()
                conn.close()
                with self.assertRaises(sp.TransportLost):
                    cli.read()
            finally:
                cli.close()
        finally:
            srv.close()


class TestUdp(unittest.TestCase):
    def test_udp_learns_peer_and_replies(self) -> None:
        port = _free_port()
        io = netio.open_net({"kind": "udp", "bind": "127.0.0.1",
                             "port": port, "timeout_s": 0.2})
        try:
            peer = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            peer.settimeout(2)
            try:
                peer.sendto(b"hi", ("127.0.0.1", port))
                self.assertEqual(io.read(), b"hi")
                # 学到对端后 write 直接回给它
                self.assertEqual(io.write(b"yo"), 2)
                self.assertEqual(peer.recv(2), b"yo")
            finally:
                peer.close()
        finally:
            io.close()

    def test_udp_write_without_peer_is_zero(self) -> None:
        port = _free_port()
        io = netio.open_net({"kind": "udp", "bind": "127.0.0.1",
                             "port": port, "timeout_s": 0.2})
        try:
            self.assertEqual(io.write(b"early"), 0)
        finally:
            io.close()


class TestLabels(unittest.TestCase):
    def test_label_of(self) -> None:
        self.assertEqual(netio.label_of({"kind": "tcp-client", "host": "127.0.0.1", "port": 9000}),
                         "tcp://127.0.0.1:9000")
        self.assertEqual(netio.label_of({"kind": "tcp-server", "bind": "127.0.0.1", "port": 9000}),
                         "tcp-listen://127.0.0.1:9000")
        self.assertEqual(netio.label_of({"kind": "udp", "bind": "127.0.0.1", "port": 9000}),
                         "udp://127.0.0.1:9000")


if __name__ == "__main__":
    unittest.main()
