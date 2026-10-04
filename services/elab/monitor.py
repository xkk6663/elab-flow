"""elab.monitor —— 串口闭环判据引擎（M3，详设见 docs/技术方案_闭环驾驶舱.md §16）。

职责边界（"探测器取证"原则）
-------------------------
本模块只做两件事：**收行** 与 **判定**。判定是纯函数 ``judge()``，
可脱离硬件用合成事件流单测；IO 部分集中在 ``run()``。

三态语义（★ 关键：缺证据 ≠ 失败）
--------------------------------
    ok            命中 ``close_on`` 任意一条 → 有**正面证据**证明板子活到了某一步
    failed        命中 ``fail_on``（优先于 close_on），或已收到行但静默超 ``idle_timeout_s``
                  → 有**正面证据**证明它坏了
    inconclusive  两者都没有：没输出、没配判据、串口不可用、超时而关键字未出现
                  → **不假装成功，也不冤枉它失败**

"没有证据"必须与"有失败证据"分开 —— 否则"固件没写 printf"会被误报成"固件崩了"。

两条易踩的语义坑（均由单测抓出后才固化）
------------------------------------
1. **fail_on 必须对整个缓冲区绝对优先**。若按"谁先命中谁赢"逐行判，
   ``[alive]`` 之后 0.6s 才 HardFault 的场景会被前面那行的 ok **早退掩盖成假通过**。
2. **ok 之后不立刻收工**，再观察 ``settle_s``（默认 1.5s，可配 ``monitor.settle_s``）——
   否则"刚报活就崩"同样漏判。代价是每次判定多花 ~1.5s，换来的是不假通过。

判据来源（单一真相）
------------------
``projects/*.yaml``::

    serial:  { port: auto, baud: 115200 }
    monitor:
      close_on:
        - { kind: regex, pattern: "^\\\\[(boot|alive)\\\\]", within_s: 10 }
      fail_on:
        - { kind: regex, pattern: "HardFault|assert|PANIC" }
      idle_timeout_s: 30

``kind`` ∈ regex | contains | exact；``within_s`` 是相对**开读时刻**的截止秒数。
命中行会**原文**带进 verdict.evidence（延伸约束：证据必须可复核）。

★ 与 openocd 互斥（约束 N5）：DAP-Link 是复合 USB 设备，openocd 占着 SWD 时
其虚拟串口打不开（``ERROR_ACCESS_DENIED``）。所以本步骤必须排在 flash/debug **之后**，
``elab loop`` 的阶段顺序已经保证了这一点。
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from . import serialport as sp
from .config import Config, ElabError

# 未声明 within_s 时的兜底观察窗口
DEFAULT_WINDOW_S = 15.0
# 命中 close_on 之后再观察多久，用来抓「刚起来就崩」（可被 monitor.settle_s 覆盖）
DEFAULT_SETTLE_S = 1.5

_OK, _FAILED, _INCONCL = "ok", "failed", "inconclusive"


@dataclass
class Rule:
    kind: str
    pattern: str = ""
    within_s: float = 0.0
    n: int = 0                     # 仅 line_count 用

    def match(self, line: str) -> bool:
        k = (self.kind or "regex").lower()
        if k == "regex":
            try:
                return re.search(self.pattern, line) is not None
            except re.error:
                return False
        if k == "contains":
            return self.pattern in line
        if k == "exact":
            return line == self.pattern
        return False                     # line_count 是聚合判据，不走逐行

    def render(self) -> str:
        if (self.kind or "").lower() == "line_count":
            return f"line_count>={self.n} within_s={self.within_s:g}"
        w = f" within_s={self.within_s:g}" if self.within_s else ""
        return f"{self.kind}:{self.pattern}{w}"


@dataclass
class Verdict:
    status: str = _INCONCL
    reason: str = ""
    evidence: list[dict] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)
    bytes_seen: int = 0
    port: str = ""
    backend: str = ""
    layer: str = ""
    elapsed_s: float = 0.0

    @property
    def ok(self) -> bool:
        return self.status == _OK

    def to_dict(self) -> dict:
        return {
            "status": self.status, "reason": self.reason,
            "evidence": self.evidence, "bytes": self.bytes_seen,
            "lines": len(self.lines), "port": self.port, "backend": self.backend,
            "layer": self.layer, "elapsed_s": round(self.elapsed_s, 2),
        }


def parse_rules(spec, *, what: str, log=print) -> list[Rule]:
    """把 YAML 里的规则列表解析成 Rule[]，坏规则**跳过并告警**（不静默吞）。"""
    out: list[Rule] = []
    for i, item in enumerate(spec or []):
        if not isinstance(item, dict):
            log(f"[monitor] ⚠ 忽略 {what}[{i}]：不是映射（{item!r}）")
            continue
        kind = str(item.get("kind", "regex")).lower()
        try:
            w = float(item.get("within_s") or 0)
        except (TypeError, ValueError):
            w = 0.0

        if kind == "line_count":
            try:
                n = int(item.get("n") or 0)
            except (TypeError, ValueError):
                n = 0
            if n <= 0:
                log(f"[monitor] ⚠ 忽略 {what}[{i}]：line_count 需要正的 n")
                continue
            if w <= 0:
                log(f"[monitor] ⚠ 忽略 {what}[{i}]：line_count 需要 within_s（约束 N4）")
                continue
            out.append(Rule(kind="line_count", within_s=w, n=n))
            continue

        # contains/exact 文档写的是 value:，regex 写的是 pattern: —— 两个键都收
        pat = item.get("pattern", item.get("value"))
        if pat is None:
            log(f"[monitor] ⚠ 忽略 {what}[{i}]：缺 pattern/value")
            continue
        pat = str(pat)
        r = Rule(kind=kind, pattern=pat, within_s=w)

        if kind == "regex":
            try:
                re.compile(pat)
            except re.error as exc:
                log(f"[monitor] ⚠ 忽略 {what}[{i}]：正则非法（{exc}）")
                continue
            if re.search(pat, "") is not None or len(pat) < 3:
                log(f"[monitor] ⚠ {what}[{i}] 判据过宽（能匹配空串或长度<3）："
                    f"{pat!r} —— 容易假通过，建议收紧")
        out.append(r)
    return out


def judge(lines: list[tuple[float, str]], close_on: list[Rule],
          fail_on: list[Rule], *, idle_timeout_s: float = 0.0,
          elapsed_s: float = 0.0) -> tuple[str, str, list[dict]]:
    """纯判定：给 (相对时刻, 行) 序列 → (status, reason, evidence)。

    fail_on 优先于 close_on：同一行同时命中两者时判 failed。
    """
    ev: list[dict] = []

    # ⓪ line_count 型聚合判据先算：「within_s 内收到 ≥ n 行」即视为在跑。
    #    它不关心关键字是什么 —— 对「关键字未知的第三方固件」是唯一可用判据。
    for r in close_on:
        if (r.kind or "").lower() != "line_count":
            continue
        got = [t for t, _ in lines if not r.within_s or t <= r.within_s]
        if len(got) >= r.n:
            ev.append({"t": round(got[r.n - 1], 3), "rule": r.render(),
                       "line": next(ln for t, ln in lines if t == got[r.n - 1]),
                       "verdict": "ok"})
            return _OK, f"命中 close_on（{r.render()}，已收到 {len(got)} 行）", ev

    # ① fail_on 对**整个缓冲区**绝对优先：先全扫一遍，再谈 ok。
    #    ★ 不能逐行"谁先命中谁赢"：否则 `[alive]` 之后 0.6s 才 HardFault 的场景，
    #      会被前面那行的 ok 早退掩盖成**假通过**（实测由单测用例②抓出）。
    for t, line in lines:
        for r in fail_on:
            if r.match(line):
                ev.append({"t": round(t, 3), "rule": r.render(), "line": line,
                           "verdict": "failed"})
                return _FAILED, f"命中 fail_on（{r.render()}）", ev

    # ② close_on：按时间顺序，且每条必须在自己的 within_s 之内
    for t, line in lines:
        for r in close_on:
            if (r.kind or "").lower() == "line_count":
                continue
            if r.within_s and t > r.within_s:
                continue                      # 该条已过期
            if r.match(line):
                ev.append({"t": round(t, 3), "rule": r.render(), "line": line,
                           "verdict": "ok"})
                return _OK, f"命中 close_on（{r.render()}）", ev

    # ── 没命中任何判据 ──────────────────────────────────────────
    if not close_on and not fail_on:
        return _INCONCL, "工程未声明任何 monitor 判据（close_on/fail_on 都为空）", ev

    if lines and idle_timeout_s:
        last = lines[-1][0]
        if elapsed_s - last > idle_timeout_s:
            ev.append({"t": round(last, 3), "rule": f"idle_timeout_s={idle_timeout_s:g}",
                       "line": lines[-1][1], "verdict": "failed"})
            return _FAILED, (f"收到过输出，但已静默 {elapsed_s - last:.1f}s "
                             f"> idle_timeout_s={idle_timeout_s:g}（疑似挂死）"), ev

    if not lines:
        return _INCONCL, "整个观察窗口内一个字节都没收到（固件无输出？接线/波特率？）", ev
    return _INCONCL, (f"收到 {len(lines)} 行，但没有任何一行命中 close_on "
                      f"（板子会说话，只是没说出约定的关键字）"), ev


def _window(close_on: list[Rule], idle_timeout_s: float, override: float) -> float:
    if override > 0:
        return override
    ws = [r.within_s for r in close_on if r.within_s]
    if ws:
        return max(ws)
    return idle_timeout_s if idle_timeout_s > 0 else DEFAULT_WINDOW_S


def run(cfg: Config, name: str, *, port: str = "", seconds: float = 0.0,
        echo: bool = True, reset_port: bool = False, log=print) -> Verdict:
    """开串口 → 收行 → 判定。返回值可直接 JSON 化。"""
    proj = cfg.resolved_project(name)
    ser = proj.get("serial") or {}
    mon = proj.get("monitor") or {}
    host_ser = cfg.host.get("serial") or {}

    spec = port or ser.get("port") or host_ser.get("default") or "auto"
    try:
        baud = int(ser.get("baud") or host_ser.get("baud") or 115200)
    except (TypeError, ValueError):
        baud = 115200

    close_on = parse_rules(mon.get("close_on"), what="monitor.close_on", log=log)
    fail_on = parse_rules(mon.get("fail_on"), what="monitor.fail_on", log=log)
    idle = float(mon.get("idle_timeout_s") or 0)
    settle = float(mon.get("settle_s") or DEFAULT_SETTLE_S)

    # ── 能力协商（§18 三层降级）────────────────────────────────
    caps = sp.capabilities()
    v = Verdict(layer=caps["layer"])
    if not caps["available"]:
        v.reason = f"串口后端不可用（layer={caps['layer']}）：{caps.get('hint')}"
        log(f"[monitor] — {v.reason}")
        return v

    ports, backend = sp.list_ports()
    v.backend = backend
    chosen, why, _cands = sp.select_port(spec, ports)
    v.port = chosen
    log(f"[monitor] 端口：{why}")
    if not chosen:
        v.reason = why
        log(f"[monitor] — {v.reason}")
        return v

    win = _window(close_on, idle, seconds)
    log(f"[monitor] 判据：close_on={[r.render() for r in close_on] or '无'} "
        f"fail_on={[r.render() for r in fail_on] or '无'} 窗口={win:g}s")

    if reset_port:
        ok, msg = sp.restart_device(chosen, log=log)
        log(f"[monitor] {'✓' if ok else '—'} 软复位：{msg}")
        if ok:
            time.sleep(2.5)          # 等设备重新枚举、驱动重新绑定

    try:
        with sp.SerialIO(chosen, baud) as s:
            log(f"[monitor] 已打开 {chosen}@{baud}（backend={s.backend}），开始收行…")
            t0 = time.time()
            lines: list[tuple[float, str]] = []
            buf = b""
            ok_at = None
            while True:
                now = time.time() - t0
                # ★ ok 之后不立刻收工：再观察 settle_s，让「启动后马上崩」仍能翻盘成 failed
                if ok_at is not None and now - ok_at >= settle:
                    break
                if now > win:
                    break
                chunk = s.read(4096)
                now = time.time() - t0
                if not chunk:
                    time.sleep(0.02)
                    continue
                v.bytes_seen += len(chunk)
                buf += chunk
                while b"\n" in buf:
                    raw_line, buf = buf.split(b"\n", 1)
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\r")
                    lines.append((now, line))
                    if echo:
                        log(f"[serial] +{now:6.2f}s  {line}")
                st, why2, ev = judge(lines, close_on, fail_on,
                                     idle_timeout_s=idle, elapsed_s=now)
                v.status, v.reason, v.evidence = st, why2, ev
                if st == _FAILED:
                    v.lines = [ln for _t, ln in lines]
                    v.elapsed_s = now
                    return v
                if st == _OK and ok_at is None:
                    ok_at = now

            v.elapsed_s = time.time() - t0
            v.lines = [ln for _t, ln in lines]
            st, why2, ev = judge(lines, close_on, fail_on,
                                 idle_timeout_s=idle, elapsed_s=v.elapsed_s)
            v.status, v.reason, v.evidence = st, why2, ev
            return v
    except OSError as exc:
        v.status = _INCONCL
        v.reason = f"打开串口失败：{exc}"
        log(f"[monitor] — {v.reason}")
        return v


def render(v: Verdict) -> str:
    mark = {_OK: "✓", _FAILED: "✗", _INCONCL: "—"}[v.status]
    L = [f"[monitor] {mark} 串口闭环：{v.status.upper()}",
         f"          端口 {v.port or '(未选到)'} / backend={v.backend} / layer={v.layer}",
         f"          收到 {v.bytes_seen} B，{len(v.lines)} 行，{v.elapsed_s:.1f}s",
         f"          理由：{v.reason}"]
    for e in v.evidence:
        L.append(f"          +{e['t']:.2f}s  [{e['verdict']}] {e['line']}")
    return "\n".join(L)


def exit_code(v: Verdict) -> int:
    """0=ok，1=failed，2=inconclusive（★ 三态各有码，CI 才能区分"没证据"与"失败"）。"""
    return {_OK: 0, _FAILED: 1, _INCONCL: 2}[v.status]
