"""cockpit —— L7 闭环驾驶舱（技术方案见 ``docs/技术方案_闭环驾驶舱.md``）。

    后端：``server.py``      零依赖 HTTP + SSE（stdlib）
    前端：``web/``           独立 Vite+TS+React 工程，产物 ``web/dist/`` 已入仓
    装配：``profiles/*.yaml`` 插件清单（有序层，可 patch）

运行（**只要 Python，不需要 Node**）：

    python -m cockpit.server            # → http://127.0.0.1:3333/

设计与事件契约分别见 ``docs/技术方案_闭环驾驶舱.md``、``docs/ICD_cockpit_events.md``。
"""
