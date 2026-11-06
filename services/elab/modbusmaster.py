"""elab.modbusmaster —— Modbus RTU 主站事务引擎（挂在串口会话上）。

边界
----
只做**事务**：排队、单飞行、匹配、超时重试、轮询组、退避、统计。
PDU 的字节怎么排是 ``modbus`` 的事；口怎么开是 ``serialmon`` 的事。

线程模型（计划 §5.3）
---------------------
- 一个调度线程（``modbus-master``）串行地发一帧、等一帧 —— RTU 是**单飞行**协议，
  总线上同时有两帧就没人分得清哪帧是应答。
- 收字节不另开线程：会话读线程把 RX 交给 :meth:`Engine.feed`（``_Session`` 的
  rx sink），调度线程在里面找自己那一帧。
- 写只走 ``session.write()``，与会话共用同一把写锁 —— 契约不变。
- 引擎自己的异常只落 ``stats``/``last_error``，**绝不外抛到读线程**。

为什么必须"单飞行 + 按请求算长度"
---------------------------------
RTU 没有帧头、没有长度字段、没有事务号。能回答"这一帧到哪结束"的只有
"我刚才发出去的是什么"：请求 fc/数量 → 应答长度。这条链一断，就只剩超时。
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from . import modbus as mb
from .config import Config

MAX_TXNS = 200                 # 事务环容量（面板只看最近这些）
MAX_PENDING = 32               # 手动队列上限（写优先，但不许堆爆）
MIN_TIMEOUT_MS = 20
MAX_TIMEOUT_MS = 5000
MAX_RETRIES = 5
MIN_INTERVAL_MS = 50
DEFAULT_TIMEOUT_MS = 120
DEFAULT_RETRIES = 2
MAX_POINTS = 64
MAX_GROUPS = 8
MAX_RX_BUF = 2048
#: 连续失败后轮询间隔的退避上限（倍数）
MAX_BACKOFF = 8
#: 合并轮询请求时允许跨过的地址空洞（寄存器数）。
#: 2 → 0 和 2 两个点用一条"读 0 起 3 个"的请求覆盖，省一次往返；
#: 但不能无限跨：读得太宽会把别人的地址也拉上来，还可能越界。
MERGE_GAP = 4


# ══════════════════════════════════════════════════════════════════
#  寄存器映射（工程数据）
# ══════════════════════════════════════════════════════════════════
def map_path(cfg: Config, project: str) -> Path:
    """``projects/<name>.modbus.json`` —— 与 ``.frames.json`` 同级的工程数据。"""
    proj = cfg.resolved_project(project)
    raw = str(proj.get("_path") or "")
    if raw:
        p = Path(raw)
        if not p.is_absolute():
            p = Path(cfg.root) / p
        return p.with_name(p.stem + ".modbus.json")
    return Path(cfg.root) / "projects" / f"{project}.modbus.json"


def empty_map() -> dict:
    return {"rev": 0, "unit_id": 1, "timeout_ms": DEFAULT_TIMEOUT_MS,
            "retries": DEFAULT_RETRIES, "groups": [], "points": []}


def normalize_map(raw: dict) -> dict:
    """校验并规整映射。**错误在保存时一次说清**，不留到轮询时才炸。

    规则（计划 §5.2）：
    - ``address`` 是协议偏移（0 基）；40001 的换算在文档里，不进内核；
    - ``f32/u32/s32`` 必须显式 ``word_order``（猜错的数值"离谱但不像 0"，最难查）；
    - 写点必须显式 ``writable: true``；``scale``/``bias`` 只影响展示。
    """
    if not isinstance(raw, dict):
        raise ValueError("映射必须是对象")
    out = empty_map()
    out["rev"] = int(raw.get("rev") or 0)

    unit = raw.get("unit_id", 1)
    try:
        unit = int(unit)
    except (TypeError, ValueError):
        raise ValueError(f"unit_id {unit!r} 不是整数") from None
    if not mb.UNIT_MIN <= unit <= mb.UNIT_MAX:
        raise ValueError(f"unit_id {unit} 超出 1..247（广播 0 不能作从站地址）")
    out["unit_id"] = unit

    tmo = raw.get("timeout_ms", DEFAULT_TIMEOUT_MS)
    try:
        tmo = int(tmo)
    except (TypeError, ValueError):
        raise ValueError(f"timeout_ms {tmo!r} 不是整数") from None
    if not MIN_TIMEOUT_MS <= tmo <= MAX_TIMEOUT_MS:
        raise ValueError(f"timeout_ms {tmo} 超出 {MIN_TIMEOUT_MS}..{MAX_TIMEOUT_MS}")
    out["timeout_ms"] = tmo

    retries = raw.get("retries", DEFAULT_RETRIES)
    try:
        retries = int(retries)
    except (TypeError, ValueError):
        raise ValueError(f"retries {retries!r} 不是整数") from None
    if not 0 <= retries <= MAX_RETRIES:
        raise ValueError(f"retries {retries} 超出 0..{MAX_RETRIES}")
    out["retries"] = retries

    points = raw.get("points") or []
    if not isinstance(points, list):
        raise ValueError("points 必须是数组")
    if len(points) > MAX_POINTS:
        raise ValueError(f"points 最多 {MAX_POINTS} 个（当前 {len(points)}）")
    names: set[str] = set()
    norm_points = []
    for i, p in enumerate(points):
        if not isinstance(p, dict):
            raise ValueError(f"points[{i}] 必须是对象")
        name = str(p.get("name") or "").strip()
        if not name:
            raise ValueError(f"points[{i}] 缺少 name")
        if name in names:
            raise ValueError(f"点 {name} 重名")
        names.add(name)
        try:
            fc = int(p.get("fc", mb.FC_READ_HOLDING))
        except (TypeError, ValueError):
            raise ValueError(f"点 {name} 的 fc {p.get('fc')!r} 不是整数") from None
        if fc not in mb.READ_FCS:
            raise ValueError(f"点 {name} 的 fc {fc} 不是读功能码"
                             f"（可读 {', '.join(str(f) for f in mb.READ_FCS)}）")
        try:
            address = int(p.get("address", 0))
        except (TypeError, ValueError):
            raise ValueError(f"点 {name} 的 address {p.get('address')!r} 不是整数") from None
        type_ = str(p.get("type") or "u16")
        if type_ not in mb.TYPES:
            raise ValueError(f"点 {name} 的类型 {type_!r} 不在 {', '.join(mb.TYPES)}")
        if fc in mb.BIT_FCS and type_ != "bit":
            raise ValueError(f"点 {name}：位功能码必须配 type=bit（当前 {type_}）")
        if fc not in mb.BIT_FCS and type_ == "bit":
            raise ValueError(f"点 {name}：寄存器功能码不能配 type=bit")
        order = str(p.get("word_order") or ("big" if type_ in mb.WORD_ORDER_TYPES else ""))
        if type_ in mb.WORD_ORDER_TYPES and order not in mb.WORD_ORDERS:
            raise ValueError(f"点 {name}：{type_} 必须显式 word_order=big|little")
        words = mb.TYPE_WORDS[type_]
        if address + words - 1 > mb.ADDR_MAX:
            raise ValueError(f"点 {name}：地址 {address}+{words} 越过 65535")
        try:
            scale = float(p.get("scale", 1) or 1)
            bias = float(p.get("bias", 0) or 0)
        except (TypeError, ValueError):
            raise ValueError(f"点 {name}：scale/bias 必须是数字") from None
        norm_points.append({
            "name": name, "fc": fc, "address": address, "type": type_,
            "word_order": order, "scale": scale, "bias": bias,
            "unit": str(p.get("unit") or ""),
            "writable": bool(p.get("writable")),
            "plot": bool(p.get("plot", type_ != "bit")),
            "enum": dict(p.get("enum") or {}),
            "note": str(p.get("note") or ""),
        })
    out["points"] = norm_points

    groups = raw.get("groups") or []
    if not isinstance(groups, list):
        raise ValueError("groups 必须是数组")
    if len(groups) > MAX_GROUPS:
        raise ValueError(f"groups 最多 {MAX_GROUPS} 组")
    gnames: set[str] = set()
    norm_groups = []
    for i, g in enumerate(groups):
        if not isinstance(g, dict):
            raise ValueError(f"groups[{i}] 必须是对象")
        gname = str(g.get("name") or "").strip() or f"g{i}"
        if gname in gnames:
            raise ValueError(f"轮询组 {gname} 重名")
        gnames.add(gname)
        try:
            interval = int(g.get("interval_ms", 500))
        except (TypeError, ValueError):
            raise ValueError(f"组 {gname} 的 interval_ms {g.get('interval_ms')!r} 不是整数") from None
        if interval < MIN_INTERVAL_MS:
            raise ValueError(f"组 {gname} 的 interval_ms {interval} < {MIN_INTERVAL_MS}（会压死总线）")
        sel = g.get("points") or [p["name"] for p in norm_points]
        if not isinstance(sel, list):
            raise ValueError(f"组 {gname} 的 points 必须是数组")
        unknown = [s for s in sel if s not in names]
        if unknown:
            raise ValueError(f"组 {gname} 引用了不存在的点：{', '.join(unknown)}")
        norm_groups.append({"name": gname, "interval_ms": interval,
                            "points": [str(s) for s in sel],
                            "enabled": bool(g.get("enabled", True))})
    out["groups"] = norm_groups
    return out


def load_map(cfg: Config, project: str) -> dict:
    path = map_path(cfg, project)
    if not path.exists():
        return empty_map()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"读取映射失败 {path.name}：{exc}") from exc
    return normalize_map(raw)


def save_map(cfg: Config, project: str, raw: dict, rev: int | None = None) -> dict:
    """原子写 + ``rev`` 乐观锁（与 frames 同语义：并发覆盖必须被挡住）。"""
    cur = load_map(cfg, project)
    if rev is not None and int(rev) != cur["rev"]:
        raise ValueError(f"映射已被改动（当前 rev={cur['rev']}，你基于 rev={rev}）"
                         "—— 请刷新后重试")
    norm = normalize_map(raw)
    norm["rev"] = cur["rev"] + 1
    path = map_path(cfg, project)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(norm, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return norm


# ══════════════════════════════════════════════════════════════════
#  事务
# ══════════════════════════════════════════════════════════════════
@dataclass
class Pending:
    req: mb.Request
    source: str = "manual"          # manual | poll
    point: str = ""                 # 单点请求的点名（合并请求为空）
    group: str = ""
    #: 轮询合并请求的归属：((点名, 在应答 values 里的偏移), ...)
    owners: tuple = ()
    done: threading.Event = field(default_factory=threading.Event)
    result: dict = field(default_factory=dict)


class Engine:
    """一个会话上的一条 Modbus 主站总线。"""

    def __init__(self, session, *, unit_id: int = 1,
                 timeout_ms: int = DEFAULT_TIMEOUT_MS,
                 retries: int = DEFAULT_RETRIES,
                 mapping: dict | None = None):
        self.session = session
        self.unit_id = int(unit_id)
        self.timeout_ms = max(MIN_TIMEOUT_MS, min(MAX_TIMEOUT_MS, int(timeout_ms)))
        self.retries = max(0, min(MAX_RETRIES, int(retries)))
        self.map = normalize_map(mapping or empty_map())
        self.map["unit_id"] = self.unit_id
        self.map["timeout_ms"] = self.timeout_ms
        self.map["retries"] = self.retries

        self._cv = threading.Condition()
        self._manual: deque[Pending] = deque()
        self._poll: deque[Pending] = deque()
        self._rx = bytearray()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._inflight: Pending | None = None
        self._rate_limit_ms = 5          # 帧间静默，给从站留 3.5 字符
        self._last_write = 0.0

        self.started_at = time.time()
        self.seq = 0
        self.txns: deque[dict] = deque(maxlen=MAX_TXNS)
        self.points: dict[str, dict] = {}
        self.stats = {"tx": 0, "rx": 0, "ok": 0, "timeout": 0, "crc": 0,
                      "exception": 0, "malformed": 0, "port": 0, "retry": 0,
                      "noise": 0, "dropped": 0, "last_ok_ts": 0.0,
                      "last_error": None, "last_error_ts": 0.0}
        self.last_error: str = ""
        # 轮询状态
        self.polling = False
        self._poll_groups: list[dict] = []
        self._next_due: dict[str, float] = {}
        self._fails: dict[str, int] = {}
        # ★ 自己挂 RX 观察者：引擎拿不到字节就只剩超时，而"忘了挂"是**静默**故障
        #   （面板上一片 timeout，却看不出是接线错还是没订阅）。挂在这里，
        #   调用方不必记得（`open_engine` 里再挂一次是幂等的）。
        try:
            session.add_rx_sink(self.feed)
        except AttributeError:
            pass

    # ── 生命周期 ────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="modbus-master",
                                        daemon=True)
        self._thread.start()

    def stop(self, reason: str = "关闭会话") -> None:
        self._stop.set()
        with self._cv:
            # 在途/排队的都当场结账，别让调用方干等到超时
            for q in (self._manual, self._poll):
                while q:
                    p = q.popleft()
                    if not p.done.is_set():
                        p.result = self._fail_result(p.req, "port", reason, 0, [])
                        p.done.set()
            if self._inflight and not self._inflight.done.is_set():
                p = self._inflight
                p.result = self._fail_result(p.req, "port", reason, 0, [])
                p.done.set()
            self._cv.notify_all()
        t = self._thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=2)
        self.polling = False

    # ── RX：会话读线程喂进来（不解析，避免在读线程里做协议活）──
    def feed(self, data: bytes) -> None:
        if not data:
            return
        with self._cv:
            self._rx += data
            if len(self._rx) > MAX_RX_BUF:
                # 只保留尾巴：垃圾字节堆满说明总线上有别的东西，别把它当响应
                drop = len(self._rx) - 256
                del self._rx[:drop]
                self.stats["dropped"] += drop
            self._cv.notify_all()

    # ── 调度线程 ────────────────────────────────────────────────
    def _run(self) -> None:
        while not self._stop.is_set():
            p = self._next_pending()
            if p is None:
                with self._cv:
                    self._cv.wait(0.05)
                continue
            try:
                self._execute(p)
            except Exception as exc:                     # noqa: BLE001
                # 引擎异常只落状态，不外抛（外抛会杀死调度线程，面板从此假死）
                self.last_error = f"引擎异常：{exc}"
                self.stats["last_error"] = self.last_error
                self.stats["last_error_ts"] = time.time()
                if not p.done.is_set():
                    p.result = self._fail_result(p.req, "malformed", str(exc), 0, [])
                    p.done.set()

    def _next_pending(self) -> Pending | None:
        with self._cv:
            if self._manual:
                return self._manual.popleft()
            if not self.polling:
                return None
            now = time.monotonic()
            # 到点的组出队；都没到点就按最近的到期时间睡
            best: tuple[float, dict] | None = None
            for g in self._poll_groups:
                due = self._next_due.get(g["name"], 0.0)
                if due <= now:
                    best = (due, g)
                    break
                if best is None or due < best[0]:
                    best = (due, g)
            if best is None:
                return None
            due, g = best
            if due > now:
                # 提前唤醒也是安全的：醒来重新算
                self._cv.wait(min(0.05, due - now))
                return None
            plan = self._plan_group(g)
            interval = g["interval_ms"] / 1000.0
            fails = self._fails.get(g["name"], 0)
            # 连续失败指数退避，上限 MAX_BACKOFF 倍
            backoff = min(MAX_BACKOFF, 2 ** min(fails, 3)) if fails else 1
            self._next_due[g["name"]] = now + interval * backoff
            if plan:
                # 一组的多个事务一次性排队；下一次到期在它们发完之后
                for req, owners in plan:
                    self._poll.append(Pending(
                        req, source="poll", group=g["name"],
                        point=owners[0][0] if len(owners) == 1 else "",
                        owners=tuple(owners)))
                self._next_due[g["name"]] = now + interval * backoff + 0.002 * len(plan)
            return self._poll.popleft() if self._poll else None

    # ── 执行一条事务 ────────────────────────────────────────────
    def _execute(self, p: Pending) -> None:
        req = p.req
        t0 = time.time()
        frames: list[bytes] = []
        last_err: dict | None = None

        if req.broadcast:
            n = self.session.write(req.encode())
            self.stats["tx"] += 1
            self._record(p, ok=True, frames=[req.encode()], elapsed=0,
                         err=None, attempts=1)
            p.result = {"ok": True, "broadcast": True, "tx_bytes": n,
                        "request": req.as_dict(), "response": None,
                        "elapsed_ms": 0, "attempts": 1}
            p.done.set()
            return

        attempts = 0
        for attempt in range(self.retries + 1):
            attempts = attempt + 1
            if attempt:
                self.stats["retry"] += 1
            self._pace()
            with self._cv:
                self._rx.clear()          # 上一轮的残帧不许污染这一轮
            frame = req.encode()
            try:
                n = self.session.write(frame)
            except Exception as exc:                        # noqa: BLE001
                last_err = {"kind": "port", "detail": f"写串口失败：{exc}",
                            "code": 0, "code_name": ""}
                break
            if not n:
                last_err = {"kind": "port", "detail": "写串口返回 0 字节（会话不在 live 态？）",
                            "code": 0, "code_name": ""}
                break
            self.stats["tx"] += 1
            frames.append(frame)

            deadline = time.monotonic() + self.timeout_ms / 1000.0
            adu = self._await(req, deadline)
            if adu is None:
                if self._stop.is_set():
                    last_err = {"kind": "port", "detail": "引擎已停止（会话关闭）",
                                "code": 0, "code_name": ""}
                    break
                last_err = {"kind": "timeout",
                            "detail": f"{self.timeout_ms}ms 内没有完整应答",
                            "code": 0, "code_name": ""}
                self.stats["timeout"] += 1
                continue

            self.stats["rx"] += 1
            frames.append(adu)
            try:
                resp = mb.parse(req, adu)
            except mb.ModbusError as exc:
                self.stats[exc.kind] = self.stats.get(exc.kind, 0) + 1
                last_err = exc.as_dict()
                # 异常应答是**从站的有效回答**：不重试（重试只会再挨一次同样的话）
                if exc.kind == "exception":
                    break
                continue

            elapsed = int((time.time() - t0) * 1000)
            self.stats["ok"] += 1
            self.stats["last_ok_ts"] = time.time()
            self._record(p, ok=True, frames=frames, elapsed=elapsed,
                         err=None, attempts=attempts)
            p.result = {"ok": True, "request": req.as_dict(),
                        "response": resp.as_dict(), "values": resp.values,
                        "elapsed_ms": elapsed, "attempts": attempts}
            self._apply_point(p, resp)
            p.done.set()
            return

        elapsed = int((time.time() - t0) * 1000)
        kind = (last_err or {}).get("kind", "timeout")
        self.last_error = (last_err or {}).get("detail", "未知错误")
        self.stats["last_error"] = self.last_error
        self.stats["last_error_ts"] = time.time()
        self._record(p, ok=False, frames=frames, elapsed=elapsed,
                     err=last_err, attempts=attempts)
        p.result = self._fail_result(req, kind, self.last_error, elapsed,
                                     frames, error=last_err, attempts=attempts)
        p.done.set()
        if p.source == "poll" and p.group:
            self._fails[p.group] = self._fails.get(p.group, 0) + 1
        elif p.source == "poll":
            self._fails[""] = self._fails.get("", 0) + 1

    def _pace(self) -> None:
        """帧间静默：115200 下 3.5 字符≈0.3ms，留 5ms 让从站把状态机复位。"""
        gap = self._rate_limit_ms / 1000.0
        wait = self._last_write + gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last_write = time.monotonic()

    def _await(self, req: mb.Request, deadline: float) -> bytes | None:
        need = mb.response_size(req)
        with self._cv:
            while True:
                frame = self._take_locked(req, need)
                if frame is not None:
                    return frame
                if self._stop.is_set():
                    # 关会话/切端口：立刻放弃等待，别让调用方干等到超时
                    return None
                remain = deadline - time.monotonic()
                if remain <= 0:
                    return None
                self._cv.wait(remain)

    def _take_locked(self, req: mb.Request, need: int) -> bytes | None:
        """从 RX 缓冲里切出**这一条**请求的应答。**调用方持 cv**。"""
        while self._rx:
            if self._rx[0] != req.unit:
                # 不是给我们的（别的从站/本地回显/线上噪声）：丢一个字节再来
                del self._rx[0]
                self.stats["noise"] += 1
                continue
            if len(self._rx) >= 2 and self._rx[1] & 0x80:
                if len(self._rx) < 5:
                    return None
                frame = bytes(self._rx[:5])
                del self._rx[:5]
                return frame
            if len(self._rx) < need:
                return None
            frame = bytes(self._rx[:need])
            del self._rx[:need]
            return frame
        return None

    # ── 对外：一次性读写 ────────────────────────────────────────
    def read(self, fc: int, address: int, count: int, *,
             unit_id: int | None = None, timeout_ms: int | None = None,
             retries: int | None = None) -> dict:
        req = mb.build(fc, address, count=count,
                       unit=unit_id if unit_id is not None else self.unit_id)
        return self.run(req)

    def write(self, fc: int, address: int, values, *,
              unit_id: int | None = None, broadcast: bool = False) -> dict:
        unit = mb.BROADCAST_UNIT if broadcast else (
            unit_id if unit_id is not None else self.unit_id)
        req = mb.build(fc, address, values=values, unit=unit)
        return self.run(req)

    def run(self, req: mb.Request) -> dict:
        """提交一条事务并等结果（手动请求优先于轮询）。"""
        if self._stop.is_set():
            return self._fail_result(req, "port", "引擎已停止", 0, [])
        p = Pending(req, source="manual")
        with self._cv:
            if len(self._manual) >= MAX_PENDING:
                return self._fail_result(req, "port",
                                        f"手动队列已满（{MAX_PENDING}）", 0, [])
            self._manual.append(p)
            self._cv.notify_all()
        budget = (self.timeout_ms * (self.retries + 1)) / 1000.0 + 2.0
        if not p.done.wait(budget):
            with self._cv:
                if p.done.is_set():
                    return p.result
                try:
                    self._manual.remove(p)
                except ValueError:
                    pass
            return self._fail_result(req, "timeout",
                                     f"事务在 {budget:.1f}s 内没有结账", 0, [])
        return p.result

    # ── 轮询组 ──────────────────────────────────────────────────
    def start_polling(self, groups: list[str] | None = None) -> dict:
        self._poll_groups = [g for g in self.map.get("groups") or []
                             if g.get("enabled", True)
                             and (not groups or g["name"] in groups)]
        if not self._poll_groups:
            raise ValueError("没有可启动的轮询组（映射里 groups 为空或全被禁用）")
        now = time.monotonic()
        self._next_due = {g["name"]: now for g in self._poll_groups}
        self._fails.clear()
        self.polling = True
        with self._cv:
            self._cv.notify_all()
        return {"ok": True, "groups": [g["name"] for g in self._poll_groups]}

    def stop_polling(self) -> dict:
        self.polling = False
        with self._cv:
            while self._poll:
                p = self._poll.popleft()
                if not p.done.is_set():
                    p.result = self._fail_result(p.req, "port", "轮询已停止", 0, [])
                    p.done.set()
            self._cv.notify_all()
        return {"ok": True}

    def _plan_group(self, g: dict) -> list[tuple[mb.Request, list[tuple[str, int]]]]:
        """把一组的点合并成尽量少的请求（同 fc、地址相邻、总长 ≤125）。"""
        by_name = {p["name"]: p for p in self.map["points"]}
        pts = [by_name[n] for n in g["points"] if n in by_name]
        pts.sort(key=lambda p: (p["fc"], p["address"]))
        plan: list[tuple[mb.Request, list[tuple[str, int]]]] = []
        cur: dict | None = None
        for p in pts:
            words = mb.TYPE_WORDS[p["type"]]
            if (cur and cur["fc"] == p["fc"]
                    and p["address"] <= cur["addr"] + cur["count"] + MERGE_GAP
                    and max(cur["addr"] + cur["count"], p["address"] + words)
                    - cur["addr"] <= mb.MAX_READ_REGS):
                end = max(cur["addr"] + cur["count"], p["address"] + words)
                cur["count"] = end - cur["addr"]
                cur["owners"].append((p["name"], p["address"] - cur["addr"]))
            else:
                if cur:
                    plan.append(self._mk_req(cur))
                cur = {"fc": p["fc"], "addr": p["address"], "count": words,
                       "owners": [(p["name"], 0)]}
        if cur:
            plan.append(self._mk_req(cur))
        return plan

    def _mk_req(self, cur: dict):
        req = mb.build(cur["fc"], cur["addr"], count=cur["count"], unit=self.unit_id)
        return req, cur["owners"]

    def _apply_point(self, p: Pending, resp: mb.Response) -> None:
        """把一次成功读的结果落到快照。

        合并请求按 ``owners`` 里的偏移切片 —— 一条请求里可能装着三个点，
        少切一个，面板上就少一行会动的数字。
        """
        if p.source != "poll":
            return
        by_name = {x["name"]: x for x in self.map["points"]}
        owners = p.owners or (((p.point, 0),) if p.point else ())
        for name, offset in owners:
            point = by_name.get(name)
            if not point:
                continue
            words = mb.TYPE_WORDS[point["type"]]
            try:
                raw = mb.decode_registers(resp.values[offset:offset + words],
                                          point["type"], point["word_order"])
                value = mb.scaled(raw, scale=point["scale"], bias=point["bias"])
            except mb.ModbusError as exc:
                self.points[name] = {**self.points.get(name, {}), "name": name,
                                     "error": exc.detail, "ts": time.time()}
                continue
            self.points[name] = {"name": name, "raw": raw, "value": value,
                                 "unit": point["unit"], "ts": time.time(),
                                 "error": "", "plot": point["plot"]}

    def sample(self, name: str) -> dict:
        """读一个映射点（用它的 fc/address/type，返回业务值与原始字）。"""
        point = next((x for x in self.map["points"] if x["name"] == name), None)
        if point is None:
            raise ValueError(f"映射里没有点 {name}")
        count = mb.TYPE_WORDS[point["type"]]
        res = self.read(point["fc"], point["address"], count)
        if res.get("ok"):
            raw = mb.decode_registers(res["values"], point["type"], point["word_order"])
            res["point"] = {"name": name, "raw": raw,
                            "value": mb.scaled(raw, scale=point["scale"],
                                               bias=point["bias"]),
                            "unit": point["unit"]}
            self.points[name] = {"name": name, "raw": raw,
                                 "value": res["point"]["value"],
                                 "unit": point["unit"], "ts": time.time(),
                                 "error": "", "plot": point["plot"]}
        else:
            self.points[name] = {**self.points.get(name, {}), "name": name,
                                 "error": res.get("error", {}).get("detail", ""),
                                 "ts": time.time()}
        return res

    # ── 统计 / 日志 ─────────────────────────────────────────────
    def _record(self, p: Pending, *, ok: bool, frames: list[bytes],
                elapsed: int, err: dict | None, attempts: int) -> None:
        self.seq += 1
        req = p.req
        self.txns.append({
            "seq": self.seq, "ts": time.time(),
            "source": p.source, "group": p.group, "point": p.point,
            "unit": req.unit, "fc": req.fc, "label": req.label,
            "address": req.address, "count": req.count,
            "tx_hex": frames[0].hex(" ").upper() if frames else "",
            "rx_hex": frames[-1].hex(" ").upper() if len(frames) > 1 else "",
            "ok": ok, "attempts": attempts, "elapsed_ms": elapsed,
            "error": err,
        })

    @staticmethod
    def _fail_result(req: mb.Request, kind: str, detail: str, elapsed: int,
                     frames: list[bytes], *, error: dict | None = None,
                     attempts: int = 1) -> dict:
        err = error or {"kind": kind, "code": 0, "code_name": "", "detail": detail}
        return {"ok": False, "request": req.as_dict(), "response": None,
                "values": [], "error": err, "elapsed_ms": elapsed,
                "attempts": attempts}

    def transactions(self, after: int = 0, limit: int = 50) -> dict:
        items = [t for t in self.txns if t["seq"] > after]
        if limit and len(items) > limit:
            items = items[-limit:]
        return {"transactions": items, "seq": self.seq,
                "capacity": MAX_TXNS,
                "covered": max(0, self.seq - len(self.txns))}

    def snapshot(self) -> dict:
        now = time.time()
        last_ok = self.stats["last_ok_ts"]
        points = []
        for p in self.map["points"]:
            live = self.points.get(p["name"]) or {}
            points.append({
                "name": p["name"], "def": p,
                "raw": live.get("raw"), "value": live.get("value"),
                "unit": p["unit"], "ts": live.get("ts", 0),
                "error": live.get("error", ""),
            })
        return {
            "active": True,
            "unit_id": self.unit_id,
            "timeout_ms": self.timeout_ms,
            "retries": self.retries,
            "polling": self.polling,
            "groups": [g["name"] for g in self._poll_groups],
            "session": {"project": getattr(self.session, "project", ""),
                        "port": getattr(self.session, "port", ""),
                        "baud": getattr(self.session, "baud", 0),
                        "epoch": getattr(self.session, "epoch", 0)},
            "stats": {**self.stats,
                      "last_ok_ms_ago": int((now - last_ok) * 1000) if last_ok else None},
            "points": points,
            "pending": len(self._manual) + len(self._poll),
            "seq": self.seq,
            "uptime_s": int(now - self.started_at),
            "last_error": self.last_error,
            "map_rev": self.map.get("rev", 0),
        }

    def apply_map(self, mapping: dict) -> dict:
        norm = normalize_map(mapping)
        self.map = norm
        self.unit_id = norm["unit_id"]
        self.timeout_ms = norm["timeout_ms"]
        self.retries = norm["retries"]
        self.points = {k: v for k, v in self.points.items()
                       if any(p["name"] == k for p in norm["points"])}
        if self.polling:
            self.stop_polling()
        return norm


# ══════════════════════════════════════════════════════════════════
#  进程内单例（一个会话一条总线）
# ══════════════════════════════════════════════════════════════════
_LOCK = threading.Lock()
_ENGINE: Engine | None = None


def open_engine(session, *, cfg: Config | None = None, project: str = "",
                unit_id: int | None = None, timeout_ms: int | None = None,
                retries: int | None = None) -> Engine:
    """绑定一个已打开的串口会话。重复打开**同一会话**是幂等的。"""
    global _ENGINE
    with _LOCK:
        if _ENGINE is not None and _ENGINE.session is session:
            if unit_id is not None:
                _ENGINE.unit_id = int(unit_id)
            if timeout_ms is not None:
                _ENGINE.timeout_ms = int(timeout_ms)
            if retries is not None:
                _ENGINE.retries = int(retries)
            _ENGINE.start()
            return _ENGINE
        if _ENGINE is not None:
            _ENGINE.stop("切换到新的会话")
        mapping = None
        if cfg is not None and project:
            try:
                mapping = load_map(cfg, project)
            except ValueError:
                mapping = None
        eng = Engine(session,
                     unit_id=unit_id if unit_id is not None else
                     (mapping or {}).get("unit_id", 1),
                     timeout_ms=timeout_ms if timeout_ms is not None else
                     (mapping or {}).get("timeout_ms", DEFAULT_TIMEOUT_MS),
                     retries=retries if retries is not None else
                     (mapping or {}).get("retries", DEFAULT_RETRIES),
                     mapping=mapping)
        session.add_rx_sink(eng.feed)
        eng.start()
        _ENGINE = eng
        return eng


def current() -> Engine | None:
    return _ENGINE


def close_engine(reason: str = "关闭会话") -> dict:
    """会话关闭 / 切口时调用（``serialmon.close_session`` 已接这一处）。"""
    global _ENGINE
    with _LOCK:
        if _ENGINE is None:
            return {"ok": True, "was_active": False}
        eng, _ENGINE = _ENGINE, None
    eng.stop(reason)
    return {"ok": True, "was_active": True, "reason": reason,
            "stats": dict(eng.stats)}


def detach_session(session) -> bool:
    """只解绑**这个**会话的引擎（别的会话的引擎不动）。"""
    global _ENGINE
    with _LOCK:
        if _ENGINE is None or _ENGINE.session is not session:
            return False
        eng, _ENGINE = _ENGINE, None
    eng.stop("会话已关闭")
    return True
