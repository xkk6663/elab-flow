"""手动验收脚本 —— 真机验证「串口写通道 + 落盘」的 HTTP 面（**不进 CI**）。

与 ``tests/test_serialterm.py`` 的分工：那里用**假串口**验逻辑（离线、可跑 CI）；
本脚本用**真设备**验"浏览器实际会发的那几个请求"确实工作 —— 包括**设备真的收到了**
我们写出去的东西（回显里能看到它照常打印，且没有被写入打断）。

覆盖两件事：
  1. M3-b  写通道本身（400 校验 / 409 互斥由集成测试覆盖 / 真机写+收）
  2. M3-b2 **落盘**：刚发生的操作能不能从 ``GET /api/serial/console`` 读回来；
     失败的那一次**也**必须留痕（否则"我敲过这一行"会因为失败而消失）

**不进 CI**：需要真机 + 可读写的串口，且 openocd 必须已退出（约束 N5）。
⚠️ 本脚本会往**真的** console 留档里写几条记录（这正是它的验收对象）。

用法::

    ELAB_PYTHON="C:/Users/.../python.exe" python tests/manual/probe_serial_write.py [project]

判定：全部断言通过 → 退出码 0。
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

# ★ 落盘（M3-b2）也要在这里证：**写一条之后，从 HTTP 能不能读回来**。
#   只证明"CLI 能读回来"是不够的 —— 浏览器走的是 `/api/serial/console` 这条道。
con = caps.get("console") or {}
print(f"[probe] caps.serial.console    = count={con.get('count')} "
      f"max={con.get('max_records')} path={con.get('path')}")
ok &= isinstance(con.get("count"), int) and con.get("error") is None
before = int(con.get("count") or 0)

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

# ── 把刚才那些操作从留档里读回来（M3-b2 的端到端判据）───────────────
st, body = get("/api/serial/console?limit=50")
con = json.loads(body)
added = con["records"][-(con["count"] - before):] if con["count"] > before else []
print(f"[probe] 留档读回       → {st} count {before} → {con['count']}，新增 {len(added)} 条")
for r in added:
    mark = "TX →" if r["dir"] == "tx" else "  ←"
    flag = "" if r.get("ok", True) else f"  (failed: {str(r.get('error'))[:28]})"
    print(f"          {r['t'][11:]} {mark} {r['text']}  [{r.get('project')}]{flag}")

tx_all = [r for r in added if r["dir"] == "tx"]
tx_bad = [r for r in tx_all if not r.get("ok")]
tx_ok = [r for r in tx_all if r.get("ok")]
rx_all = [r for r in added if r["dir"] == "rx"]
# ① 失败的那次**也**必须留痕（"我敲过这一行"不能因为失败就从历史上消失）
ok &= len(tx_bad) == 1 and "COM99" in str(tx_bad[0].get("error"))
# ② 成功的那次带全字段
ok &= len(tx_ok) == 1 and tx_ok[0]["text"] == "help" and tx_ok[0]["port"] == "COM10"
# ③ 回显逐行落成 rx
ok &= len(rx_all) == len(j.get("echoed") or [])
# ④ 每条都带 project —— 界面按工程过滤历史全靠它
ok &= all(r.get("project") == RUN for r in added)

print("\n[probe] 判定：", "✓ 写通道 HTTP 面 + 落盘读回 全通过" if ok else "✗ 有断言未通过")
srv.shutdown()
sys.exit(0 if ok else 1)
