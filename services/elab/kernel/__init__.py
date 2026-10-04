"""elab.kernel —— 最小内核（照 Cordis 的形态，不抄代码）。

M1 只落两件事：
  ``events.py``   只追加事件日志 + 内存环形缓冲 + 跟读/重放
  ``ctx.py``      provide/get/mount/effect/emit/on（M4 插件化收敛时才真正吃紧）

**事件契约见 ``docs/ICD_cockpit_events.md``，那是事实源。**
本包只负责实现它，不得自行发明字段。
"""

from .events import (  # noqa: F401
    EVENT_SCHEMA_VERSION,
    EventLog,
    RingBuffer,
    allocate_run_id,
    append_event,
    channel_of,
    follow,
    is_activity,
    is_persisted,
    list_runs,
    read_run,
    replay,
    run_paths,
)

__all__ = [
    "EVENT_SCHEMA_VERSION",
    "EventLog",
    "RingBuffer",
    "allocate_run_id",
    "append_event",
    "channel_of",
    "follow",
    "is_activity",
    "is_persisted",
    "list_runs",
    "read_run",
    "replay",
    "run_paths",
]
