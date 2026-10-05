"""手动验收脚本 —— 真机验证「串口写通道」的 HTTP 面（**不进 CI**）。

与 ``tests/test_serialterm.py`` 的分工：那里用**假串口**验逻辑（离线、可跑 CI）；
本脚本用**真设备**验"浏览器实际会发的那几个请求"确实工作 —— 包括**设备真的收到了**
我们写出去的东西（回显里能看到它照常打印，且没有被写入打断）。

**不进 CI**：需要真机 + 可读写的串口，且 openocd 必须已退出（约束 N5）。

用法::

    ELAB_PYTHON="C:/Users/.../python.exe" python tests/manual/probe_serial_write.py [project]

判定：`真机写+收` 一行出现 `ok=True` 且 `written > 0` → 通过（退出码 0）。
"""
from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "services"))

from cockpit import server as srv_mod          # noqa: E402
from elab.config import Config                 # noqa: E402

PORT = 3401
RUN = sys.argv[1] if len(sys.argv) > 1 else "at32f421g8u7"

cfg = Config(str(ROOT))
srv = srv_mod.make_server(cfg, port=PORT, verbose=False, log=lambda *a: None)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.3)

import http.client                              # noqa: E402


def post(path, body):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=30)
    raw = json.dumps(body).encode()
    c.request("POST", path, body=raw,
              headers={"Content-Type": "application/json",
                       "Content-Length": str(len(raw))})
    r = c.getresponse()
    out = r.read().decode()
    c.close()
    return r.status, out


def get(path):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=30)
    c.request("GET", path)
    r = c.getresponse()
    out = r.read().decode()
    c.close()
    return r.status, out


ok = True

st, body = get("/api/capabilities")
caps = json.loads(body)["serial"]
print(f"[probe] caps.serial.write_available = {caps.get('write_available')} "
      f"layer={caps.get('layer')} ports={[p['name'] for p in caps.get('ports', [])]}")
ok &= bool(caps.get("write_available"))

st, body = post("/api/serial", {"project": RUN})
print(f"[probe] 缺 data        → {st} {body.strip()[:70]}")
ok &= st == 400

st, body = post("/api/serial", {"project": RUN, "data": "   "})
print(f"[probe] 空白 data      → {st} {body.strip()[:70]}")
ok &= st == 400

st, body = post("/api/serial", {"project": RUN, "data": "help",
                                "port": "COM99", "read_ms": 100})
print(f"[probe] 不存在的端口   → {st} {json.loads(body).get('error', '')[:60]}")
ok &= st == 200 and not json.loads(body)["ok"]

st, body = post("/api/serial", {"project": RUN, "data": "help", "read_ms": 2000})
j = json.loads(body)
print(f"[probe] 真机写+收      → {st} ok={j.get('ok')} port={j.get('port')} "
      f"baud={j.get('baud')} backend={j.get('backend')} written={j.get('written')} "
      f"bytes_read={j.get('bytes_read')} echoed={j.get('echoed')}")
ok &= st == 200 and bool(j.get("ok")) and j.get("written", 0) > 0

print("\n[probe] 判定：", "✓ 写通道 HTTP 面全通过" if ok else "✗ 有断言未通过")
srv.shutdown()
sys.exit(0 if ok else 1)
