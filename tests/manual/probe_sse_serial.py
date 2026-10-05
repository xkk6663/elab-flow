"""手动验收脚本 —— 真服务 + 真板子，验证 ``serial/*`` 全链路能到达浏览器。

**不进 CI**：需要真机（默认 ``at32f421g8u7``）+ 可读串口 + openocd 已退出
（见 README §11 / N5：openocd 占着 SWD 时 VCP 读不了）。

它补的是单测补不上的那一环：``tests/it_cockpit_server.py`` 用**合成事件**验证
SSE 分帧，本脚本用**真串口事件**验证「monitor 回调 → 事件日志 → _fanout →
SSE 命名帧」这条链在真实设备上确实成立。

用法::

    ELAB_PYTHON="C:/Users/.../python.exe" python tests/manual/probe_sse_serial.py [project]

判定：四个 topic 全部出现在 SSE 流里 → 「✓ 全链路到浏览器」，退出码 0。
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

PORT = 3399
RUN = sys.argv[1] if len(sys.argv) > 1 else "at32f421g8u7"

cfg = Config(str(ROOT))
srv = srv_mod.make_server(cfg, port=PORT, verbose=False, log=lambda *a: None)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.3)

import http.client                              # noqa: E402


def post(path, body):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=60)
    raw = json.dumps(body).encode()
    c.request("POST", path, body=raw,
              headers={"Content-Type": "application/json",
                       "Content-Length": str(len(raw))})
    r = c.getresponse()
    out = r.read().decode()
    c.close()
    return r.status, out


st, body = post("/api/run", {"project": RUN, "steps": ["monitor"], "actor": "human"})
print(f"[probe] POST /api/run → {st} {body.strip()}")
run_id = json.loads(body)["run"]

# 跟 SSE
c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=90)
c.request("GET", f"/api/events?run={run_id}&from=0",
          headers={"Accept": "text/event-stream"})
r = c.getresponse()
print(f"[probe] SSE {r.status} {r.getheader('Content-Type')}")

seen: dict[str, int] = {}
closed_loop: dict = {}
samples: list[str] = []
evt, data, eid = None, None, None
deadline = time.time() + 60
for raw in r:
    if time.time() > deadline:
        break
    line = raw.decode("utf-8").rstrip("\r\n")
    if line.startswith(":"):
        continue
    if line == "":
        if evt:
            seen[evt] = seen.get(evt, 0) + 1
            if evt == "serial/closed-loop":
                closed_loop = json.loads(data or "{}")
            if evt in ("serial/open", "serial/closed-loop", "stream/overrun", "stream/closed"):
                samples.append(f"  event={evt} id={eid} data={data}")
        if evt == "stream/closed":
            break
        evt = data = eid = None
        continue
    if line.startswith("event:"):
        evt = line.split(":", 1)[1].strip()
    elif line.startswith("id:"):
        eid = line.split(":", 1)[1].strip()
    elif line.startswith("data:"):
        data = line.split(":", 1)[1].strip()
c.close()

print("\n[probe] SSE topic 计数（REST/回放都算）：")
for k in sorted(seen):
    print(f"    {k:<24} {seen[k]}")
print("\n[probe] 关键帧原文：")
for s in samples:
    print(s)

need = ["serial/open", "serial/line", "serial/close", "serial/closed-loop"]
missing = [k for k in need if k not in seen]
print("\n[probe] 判定：", "✓ 全链路到浏览器" if not missing else f"✗ 缺 {missing}")
print("[probe] closed-loop verdict =", closed_loop.get("verdict"),
      "| rule =", repr(closed_loop.get("rule")),
      "| evidence =", repr(closed_loop.get("evidence")))
srv.shutdown()
sys.exit(1 if missing else 0)
