"""elab.serialconsole —— 手写通道的**独立** console 日志（M3-b2）。

为什么不能写进 run 的 `.jsonl`（ICD §3.5）
----------------------------------------
写通道不属于任何 run：它与 `monitor` **天然互斥**（串口独占，约束 N5），既没有可挂的
run 上下文，也满足不了 run 事件流的前提 ——「每条事件带 `run`，且落在该 run 的 `seq`
序列内」。更要紧的是**单写者**（约束 C17：只有 `elab run --emit-events` 写事件流）：
让驾驶舱的 HTTP 线程去写 run 文件会同时破坏这两条。所以另起一份**独立的** JSONL。

与 run 事件流的关键差别（刻意，别把它当 state 用）
------------------------------------------------
    run 事件流      state 的唯一真相；只追加、**永不改写**；丢一条就是丢了
    console 日志    会话记录（人敲的命令 + 设备回话）；**有上限、会滚动**

滚动是这里的必要之恶：手敲的命令量不大，但留一个"永不清理"的文件不是好习惯。
超过 `max_bytes` 时**重写文件只保留尾部 `max_records` 条**（写临时文件 + `os.replace`
原子替换）—— 代价是极端情况下丢最旧的记录，换来的是文件有界。
★ 正因为会改写，界面渲染的只是"**最近**的历史"，不是完整历史。

跨进程
------
CLI（`elab serial`）与驾驶舱（`POST /api/serial`）会写**同一个**文件，所以滚动只按
**文件大小**触发（`stat()` 是 O(1)），绝不每次 append 去数行数。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

#: 滚动阈值与保留条数。按每行 150~250 B 估，2000 条约 400 KB。
MAX_BYTES = 512 * 1024
MAX_RECORDS = 2000
#: `tail()` 的默认条数（界面只需最近的一段）。
DEFAULT_TAIL = 200


def console_path_for(cfg) -> Path:
    """console 日志路径 —— 与 run 产物目录**同级**（同属 `.work/.cockpit/`）。

    跟随 `elab.host.yaml` 的 `cockpit.runs_dir` 覆盖：把它放到同级目录里，
    保持"一份运行产物集中在一个地方"。
    """
    from .run import runs_dir_for          # 局部 import：避免库层不必要的重依赖
    return runs_dir_for(cfg).parent / "serial-console.jsonl"


class ConsoleLog:
    """只追加的 JSONL；超过上限时滚动到尾部 N 条。线程内安全。"""

    def __init__(self, path, *, max_bytes: int = MAX_BYTES,
                 max_records: int = MAX_RECORDS):
        self.path = Path(path)
        self.max_bytes = max_bytes
        self.max_records = max_records
        self._lock = threading.Lock()

    # ── 写 ──────────────────────────────────────────────────────
    def append(self, rec: dict) -> dict:
        """追加一条记录（自动补 `ts`/`t`），返回写下去的那条。"""
        row = {"ts": round(time.time(), 3),
               "t": time.strftime("%Y-%m-%dT%H:%M:%S"), **rec}
        line = json.dumps(row, ensure_ascii=False)
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
            try:
                if self.path.stat().st_size > self.max_bytes:
                    self._roll_locked()
            except OSError:
                pass
        return row

    def _roll_locked(self) -> None:
        """保留尾部 `max_records` 条并**原子替换**。调用方须持锁。"""
        keep = self._read_lines()[-self.max_records:]
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text("".join(ln + "\n" for ln in keep), encoding="utf-8")
        os.replace(tmp, self.path)

    # ── 读 ──────────────────────────────────────────────────────
    def _read_lines(self) -> list[str]:
        try:
            text = self.path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return []
        return [ln for ln in text.splitlines() if ln.strip()]

    def tail(self, limit: int = DEFAULT_TAIL) -> list[dict]:
        """最近的 `limit` 条。

        ★ **坏行跳过**：这个文件可能被外部截断/写坏（它不是 state），
          一行读不出来不该让整段历史不可读 —— 但也不静默：跳过的行数由调用方
          通过 `count()` 与返回长度之差感知（不在这里额外造字段）。
        """
        n = max(0, int(limit or 0))
        if n == 0:
            return []
        out: list[dict] = []
        for ln in self._read_lines()[-n:]:
            try:
                obj = json.loads(ln)
            except ValueError:
                continue
            if isinstance(obj, dict):
                out.append(obj)
        return out

    def count(self) -> int:
        return len(self._read_lines())

    def clear(self) -> int:
        """清空并返回被清掉的条数（界面将来若要"清服务端历史"就用它）。"""
        with self._lock:
            n = len(self._read_lines())
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
            return n


def journal_for(cfg, *, project: str = ""):
    """返回 `rec -> None` 的落盘回调，供 `serialterm.roundtrip(journal=…)` 用。

    ★ 闭包捕获 `project`：让每条记录自带"这条命令是发给哪个工程的" ——
      将来按工程过滤历史时才不丢信息（端口可能复用，工程不会）。
    """
    log = ConsoleLog(console_path_for(cfg))

    def _j(rec: dict) -> None:
        log.append({**rec, "project": project})

    return _j
