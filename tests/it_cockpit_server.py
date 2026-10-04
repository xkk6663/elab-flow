"""驾驶舱后端集成测试（真起服务、真 spawn run、真读 SSE）。

        python tests/it_cockpit_server.py

与 `test_*.py` 的区别：这些用例**会真的调 cmake/ninja**（约 6~10s），
故不放进 `unittest discover` 的默认集合，单独跑。

覆盖 M1.3 的验收点：
  * ``/api/capabilities`` / ``/api/projects`` 的形状与 YAML 来源
  * ``POST /api/run`` → 子进程 → 事件文件 → **SSE 实时推送**全链路
  * ``Last-Event-ID`` 断线续传（§17.2）
  * ``POST /api/cancel`` 杀掉进程树并补写 ``run/cancel``（契约唯一豁免）
"""

from __future__ import annotations

import http.client
import json
import re
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "services"))

from cockpit import server as srv_mod          # noqa: E402
from elab.config import Config                 # noqa: E402

PROJECT = "at32_test"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _Client:
    def __init__(self, port: int):
        self.port = port

    def _conn(self):
        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=90)

    def get(self, path: str, *, headers: dict | None = None):
        c = self._conn()
        c.request("GET", path, headers=headers or {})
        return c, c.getresponse()

    def get_json(self, path: str) -> dict:
        c, r = self.get(path)
        try:
            return json.loads(r.read().decode("utf-8"))
        finally:
            c.close()

    def post(self, path: str, body: dict):
        c = self._conn()
        raw = json.dumps(body).encode("utf-8")
        c.request("POST", path, body=raw,
                  headers={"Content-Type": "application/json",
                           "Content-Length": str(len(raw))})
        return c, c.getresponse()


def _read_sse(client: _Client, run_id: str, *, after: int = 0,
              timeout_s: float = 90.0) -> list[dict]:
    """读 SSE 直到 ``stream/closed``（或超时）。返回事件列表（按到达顺序）。"""
    headers = {"Accept": "text/event-stream"}
    if after:
        headers["Last-Event-ID"] = str(after)
    c, r = client.get(f"/api/events?run={run_id}&from={after}", headers=headers)
    assert r.status == 200, f"SSE 状态码 {r.status}"
    assert "text/event-stream" in (r.getheader("Content-Type") or ""), r.getheader("Content-Type")

    events: list[dict] = []
    cur_event, cur_data, cur_id = None, None, None
    deadline = time.time() + timeout_s
    try:
        for raw in r:
            if time.time() > deadline:
                raise AssertionError("SSE 超时：等不到 stream/closed")
            line = raw.decode("utf-8").rstrip("\r\n")
            if line.startswith(":"):
                continue                                   # 心跳注释
            if line == "":
                if cur_event == "stream/closed":
                    events.append({"topic": "stream/closed",
                                   "data": json.loads(cur_data or "{}")})
                    break
                if cur_data is not None:
                    ev = json.loads(cur_data)
                    ev["_sse_event"] = cur_event
                    # ★ 记下 id: —— 它是浏览器 Last-Event-ID 的唯一来源，
                    #   必须能被断言（只有 id 单调前进，断线续传才不丢不重）
                    ev["_sse_id"] = int(cur_id) if cur_id and cur_id.isdigit() else None
                    events.append(ev)
                cur_event, cur_data, cur_id = None, None, None
                continue
            if line.startswith("event:"):
                cur_event = line.split(":", 1)[1].strip()
            elif line.startswith("id:"):
                cur_id = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                cur_data = line.split(":", 1)[1].strip()
        else:
            raise AssertionError("SSE 连接在 stream/closed 之前被关闭")
    finally:
        c.close()
    return events


class CockpitIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        cls.cfg = Config(str(ROOT))
        cls.server = srv_mod.make_server(cls.cfg, port=cls.port, verbose=False,
                                         log=lambda *a: None)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.client = _Client(cls.port)
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    # ── 只读 API ────────────────────────────────────────────────
    def test_capabilities(self):
        c = self.client.get_json("/api/capabilities")
        self.assertEqual(c["schema_version"], 1, "事件契约版本必须与 ICD 一致")
        self.assertIn("serial", c)
        self.assertIn("available", c["serial"])
        self.assertEqual(c["steps"]["default"], ["doctor", "build"])
        self.assertTrue(c["runs_dir"])

    def test_projects_are_yaml_sourced(self):
        d = self.client.get_json("/api/projects")
        names = {p["name"] for p in d["projects"]}
        self.assertIn(PROJECT, names)
        p = next(x for x in d["projects"] if x["name"] == PROJECT)
        # 逐字段核对来源 = projects/at32_test.yaml
        self.assertEqual(p["archetype"], "B")
        self.assertEqual(p["chip"], "artery/at32f421g8")
        self.assertEqual(p["project_name"], "TEST")
        self.assertTrue(p["root"].endswith("examples/AT32_TEST"))
        self.assertEqual(p["chip_info"]["core"]["cpu"], "cortex-m4")
        # 派生状态位（非新元数据）
        self.assertIn("built", p["derived"])
        # 未声明 close_on 的工程，monitor 必须被标成不可用 —— 这是"点之前就知道会 inconclusive"
        self.assertFalse(p["steps"]["monitor"]["ok"])
        self.assertIn("close_on", p["steps"]["monitor"]["reason"])

    def test_unknown_api_is_404(self):
        c, r = self.client.get("/api/nope")
        try:
            self.assertEqual(r.status, 404)
        finally:
            c.close()

    # ── 全链路：spawn → 事件 → SSE ──────────────────────────────
    def test_run_and_stream_sse(self):
        c, r = self.client.post("/api/run", {"project": PROJECT, "steps": ["doctor", "build"]})
        body = r.read().decode("utf-8")          # ★ 只能读一次：r.read() 之后流就空了
        self.assertEqual(r.status, 202, body)
        spawned = json.loads(body)
        c.close()
        run_id = spawned["run"]
        self.assertRegex(run_id, r"^r-[0-9a-f]{8}$")

        evs = _read_sse(self.client, run_id)
        topics = [e.get("topic") for e in evs]
        state = [e for e in evs if e.get("topic", "").startswith("run/")]

        # ① 必须按契约出现的关键事件
        self.assertEqual(state[0]["topic"], "run/start")
        self.assertEqual(state[0]["steps"], ["doctor", "build"])
        self.assertEqual(state[0]["actor"], "human", "POST /api/run 的 actor 应为 human")
        entered = [e for e in state if e["topic"] == "run/step-enter"]
        self.assertEqual([e["step"] for e in entered], ["doctor", "build"])
        exited = [e for e in state if e["topic"] == "run/step-exit"]
        self.assertEqual([(e["step"], e["ok"]) for e in exited],
                         [("doctor", True), ("build", True)])
        self.assertEqual(state[-1]["topic"], "run/end")
        self.assertTrue(state[-1]["ok"])
        self.assertEqual(topics[-1], "stream/closed")

        # ② 编译日志必须真的流过来（100ms 合并成批）
        batches = [e for e in evs if e.get("topic") == "proc/stdout-batch"]
        self.assertTrue(batches, "没有收到任何 proc/stdout-batch")
        self.assertGreater(sum(len(b["lines"]) for b in batches), 0)

        # ③ 内存占位/产物必须带在 step-exit 里（UI 的表盘数据源）
        build_exit = next(e for e in exited if e["step"] == "build")
        self.assertIn("FLASH", build_exit["memory"])
        self.assertEqual(build_exit["memory"]["FLASH"]["used"], 4840)
        self.assertIn("artifacts", build_exit)
        self.assertIn("map", build_exit["artifacts"], "map 必须产出（N6）")

        # ④ seq 必须严格递增（否则断线续传会错）
        seqs = [e["seq"] for e in evs if "seq" in e]
        self.assertEqual(seqs, sorted(seqs), "seq 不是升序")
        self.assertEqual(len(set(seqs)), len(seqs), "seq 有重复")

    def test_last_event_id_resume(self):
        """§17.2：带 Last-Event-ID 重连，不得重复推送已收到的事件。"""
        c, r = self.client.post("/api/run", {"project": PROJECT, "steps": ["build"]})
        run_id = json.loads(r.read().decode("utf-8"))["run"]
        c.close()
        first = _read_sse(self.client, run_id)
        last = max(e["seq"] for e in first if "seq" in e)

        again = _read_sse(self.client, run_id, after=last)
        # 已结束的 run：重连应当直接收到 stream/closed，中间没有任何新事件
        self.assertEqual([e["topic"] for e in again], ["stream/closed"])

    def test_keep_alive_same_connection(self):
        """★ 回归：**同一条连接**上的连续请求都必须得到响应。

        缺陷原状：``_sent_headers`` 置 True 后从不重置，而一个 handler 实例服务的
        是一整条**连接**（HTTP/1.1 keep-alive）。于是从第二条请求起 ``_send()``
        直接 return，**一个字节都不写** —— 客户端既拿不到响应也不会收到错误，
        只能挂到超时。

        真实表现（浏览器）：`GET /` 200、`index.css` 200，唯独 `index.js`
        永远 pending → 页面 ``readyState`` 卡在 ``interactive``、``#root`` 空、
        控制台**一条报错都没有**。而 curl 每次都是新连接，完全看不出来。

        故本用例**刻意复用同一个 HTTPConnection** 发三次请求 —— 这是它与
        其余用例的关键差别，也是当初漏掉它的原因。
        """
        c = self.client._conn()
        try:
            for path, expect_min in (("/", 900), ("/assets/index.css", 1000),
                                     ("/assets/index.js", 10000)):
                c.request("GET", path)
                r = c.getresponse()
                body = r.read()
                self.assertEqual(r.status, 200, f"{path} 状态码 {r.status}（同连接第 N 条请求）")
                self.assertGreaterEqual(len(body), expect_min,
                                        f"{path} 体积异常：{len(body)}（疑似空响应）")
                # Content-Length 必须与实际字节一致，否则客户端仍会挂
                self.assertEqual(int(r.getheader("Content-Length")), len(body), path)
        finally:
            c.close()

    def test_sse_ids_advance_across_batches(self):
        """★ 回归：`proc/stdout-batch` 必须带 `id:`。

        缺陷原状：合并帧只写 `event:` / `data:`，不写 `id:`。而浏览器**只用
        `id:` 维护 `Last-Event-ID`** —— 游标因此停在最后一个 `run/*` 事件上，
        重连时服务端从那个旧游标重放，**已经通过合并帧交付过的日志行会再发一遍**。
        症状只在"断过线"时出现（证据轨出现重复行），是最难归因的一类 bug。
        """
        c, r = self.client.post("/api/run", {"project": PROJECT, "steps": ["build"]})
        run_id = json.loads(r.read().decode("utf-8"))["run"]
        c.close()
        evs = _read_sse(self.client, run_id)

        batches = [e for e in evs if e.get("topic") == "proc/stdout-batch"]
        self.assertTrue(batches, "没有收到任何 proc/stdout-batch，本用例无法验证")
        for b in batches:
            self.assertIsNotNone(b["_sse_id"], "合并帧缺少 id: → 断线续传会重复日志")

        ids = [e["_sse_id"] for e in evs if e.get("_sse_id") is not None]
        self.assertEqual(ids, sorted(ids), "SSE id 不是升序")
        self.assertEqual(len(set(ids)), len(ids), "SSE id 有重复")

        # 游标必须至少推进到"最后一条已交付事件"的 seq —— 否则重连必然重放
        delivered = max(e["seq"] for e in evs if "seq" in e)
        self.assertGreaterEqual(ids[-1], delivered,
                                "最后一个 SSE id 落后于已交付事件 → 重连会重复推送")

        # 直接验证：拿"最后看到的 id"重连，不得再收到任何 proc/*
        again = _read_sse(self.client, run_id, after=ids[-1])
        self.assertEqual([e["topic"] for e in again], ["stream/closed"],
                         "用最后 id 重连后仍有重放 → 断线续传在重复推送")

    def test_run_appears_in_runs_list(self):
        c, r = self.client.post("/api/run", {"project": PROJECT, "steps": ["build"]})
        run_id = json.loads(r.read().decode("utf-8"))["run"]
        c.close()
        _read_sse(self.client, run_id)
        listing = self.client.get_json("/api/runs")
        ids = [x["run"] for x in listing["runs"]]
        self.assertIn(run_id, ids)
        # ★ 不能出现 `r-xxxx.proc` 这类幻影 run（list_runs 曾把 .proc.jsonl 也当 run）
        self.assertFalse([i for i in ids if i.endswith(".proc")], f"幻影 run：{ids}")
        meta = next(x for x in listing["runs"] if x["run"] == run_id)
        self.assertEqual(meta["project"], PROJECT)
        self.assertEqual(meta["status"], "ok")

    def test_known_topics_covers_server_emitted(self):
        """★ 守卫：前端 `KNOWN_TOPICS` 必须覆盖服务端会发出的**每一个** topic。

        SSE 用的是**命名事件**：`EventSource.onmessage` 只接收**没有** `event:`
        字段的帧，所以前端必须为每个 topic 显式 `addEventListener`。漏一个，
        该 topic 的全部事件在浏览器里**静默消失** —— 不报错、`onerror` 不触发、
        服务端 HTTP 也是 200（ICD §6.1）。

        实测事故：白名单漏了 `proc/stdout-batch`。而 run **跑起来之后**所有编译
        日志都以合并帧形式下发 → **实时日志 100% 不可见**；同一个 run 结束后再看
        （服务端走"按 seq 重放"分支、发的是逐条 `proc/stdout`）却一切正常。
        这个"历史有、实时没有"的不对称，是本次排查里最费时的一环。
        """
        ts = (ROOT / "cockpit" / "web" / "src" / "api" / "types.ts").read_text(encoding="utf-8")
        m = re.search(r"export const KNOWN_TOPICS\s*=\s*\[(.*?)\]\s*as const", ts, re.S)
        self.assertIsNotNone(
            m, "解析不到 KNOWN_TOPICS —— types.ts 的形状变了，请同步本用例的解析方式")
        frontend = set(re.findall(r'"([^"]+)"', m.group(1)))

        missing = sorted(srv_mod.SSE_TOPICS - frontend)
        self.assertFalse(
            missing,
            f"服务端会发出这些 topic，但前端没订阅（事件会在浏览器里静默消失）：{missing}")
        # 合并帧这条单独点名：它是"实时日志"的唯一通道，漏了就等于没有实时日志
        self.assertIn("proc/stdout-batch", frontend,
                      "proc/stdout-batch 必须在前端白名单里（实时编译日志全靠它）")

    def test_runs_active_excludes_finished(self):
        """★ 回归：``/api/runs.active`` 只能是**在跑的** run，且登记簿要摘干净。

        缺陷原状：``RunManager._active`` 是本进程"起过的 run"的**登记簿**（子进程
        退出后条目仍要在，SSE 靠它判"已结束 → 重放完收尾"），而 ``list_active()``
        把登记簿**原样**返回 —— 于是 ``active`` 永远非空、无界增长（实测一次会话
        就攒了 41 条）。前端 ``active.find(project)`` 因此取到**最早**那条已结束的
        run，症状是"新起一个 build-only，界面却显示上一条 doctor+build 的 36 行
        日志，而且 300ms 就'跑完'"（那其实是旧 run 的重放，不是本次的运行）。
        """
        c, r = self.client.post("/api/run", {"project": PROJECT, "steps": ["build"]})
        run_id = json.loads(r.read().decode("utf-8"))["run"]
        c.close()

        # ① 在跑期间：必须出现在 active 里，且 alive=True。
        #    POST 是 spawn 完就返回（不等编译），所以这里不会与 run 结束竞争。
        mid = self.client.get_json("/api/runs")["active"]
        mine = [a for a in mid if a["run"] == run_id]
        self.assertEqual(len(mine), 1, f"在跑的 run 未出现在 active：{mid}")
        self.assertTrue(mine[0]["alive"], f"在跑的 run 被标成 dead：{mine[0]}")

        # ② 收尾后：不得再出现在 active 里，且 active 里不得有死进程。
        _read_sse(self.client, run_id)              # 读到 stream/closed = 已收尾
        time.sleep(0.4)                             # 等 follower 走完 finally
        after = self.client.get_json("/api/runs")["active"]
        self.assertFalse([a for a in after if a["run"] == run_id],
                         f"已结束的 run 仍被报成 active：{after}")
        self.assertTrue(all(a["alive"] for a in after),
                        f"active 里混进了死进程：{after}")

        # ③ 白盒：登记簿自身也要被摘干净，否则跑一夜就是几百个僵尸条目。
        mgr = self.server.run_manager
        with mgr._lock:                             # noqa: SLF001 —— 就是要盯住这条不变式
            self.assertNotIn(run_id, mgr._active,
                             "follower 收尾后没有把自己从登记簿摘掉")

    def test_cancel_kills_run_and_marks_it(self):
        """取消：杀进程树 + 补写 run/cancel（契约 §5.4 的唯一豁免）。"""
        c, r = self.client.post("/api/run",
                                {"project": PROJECT, "steps": ["doctor_deep", "build"]})
        run_id = json.loads(r.read().decode("utf-8"))["run"]
        c.close()
        time.sleep(0.8)                              # 让它真跑起来再取消

        c2, r2 = self.client.post("/api/cancel", {"run": run_id})
        res = json.loads(r2.read().decode("utf-8"))
        c2.close()
        self.assertEqual(r2.status, 200, res)
        self.assertTrue(res["ok"], res)

        # run/cancel 必须落到 state 文件里（否则界面永远显示"进行中"）
        state = (self.server.run_manager.runs_dir / f"{run_id}.jsonl").read_text(encoding="utf-8")
        events = [json.loads(l) for l in state.splitlines() if l.strip()]
        self.assertEqual(events[-1]["topic"], "run/cancel")
        self.assertEqual(events[-1]["actor"], "human")
        self.assertIn("reason", events[-1])

        # 列表里应显示为 cancelled
        listing = self.client.get_json("/api/runs")
        meta = next(x for x in listing["runs"] if x["run"] == run_id)
        self.assertEqual(meta["status"], "cancelled")

    def test_cancel_unknown_run_is_409(self):
        c, r = self.client.post("/api/cancel", {"run": "r-deadbeef"})
        try:
            self.assertEqual(r.status, 409)
        finally:
            c.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
