"""cockpit.server —— L7 驾驶舱后端：零依赖 HTTP + SSE。

设计依据：``docs/技术方案_闭环驾驶舱.md`` §5.5/§5.6/§17、``docs/ICD_cockpit_events.md``。

**为什么必须零第三方依赖**（§5.6 / N3）：
"clone 下来只装 Python 也能跑"是 README 的卖点。驾驶舱不能把它吃掉，
所以 HTTP 用 ``http.server``、推送用 SSE、JSON 用 ``json``。
前端另有一份 ``dist/``（构建产物已入仓），**运行时**同样不需要 Node。

**第一硬约束（§5.1，K1）**：长任务绝不能在本进程里跑。
``builder._run()`` 是 ``subprocess.run(capture_output=True)``，塞进服务端线程会把
HTTP 服务拖死、SSE 推不出去（``flash.debug`` 起 openocd 时还要阻塞 20s 等端口）。
故：**spawn 一个 ``elab run --emit-events`` 子进程，本进程只做"跟读只追加文件 + 转发 SSE + 取消"**。
"""

from __future__ import annotations

import json
import base64
import mimetypes
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
if str(_ROOT / "services") not in sys.path:
    sys.path.insert(0, str(_ROOT / "services"))

from elab import adapt as adapt_mod                      # noqa: E402
from elab import project_admin as project_admin_mod      # noqa: E402
from elab import flash as flash_mod                      # noqa: E402
from elab import debugsession as dbgsess_mod           # noqa: E402
from elab.plan import plan_for                          # noqa: E402
from elab import run as run_mod                      # noqa: E402
from elab._winproc import adopt as adopt_proc        # noqa: E402
from elab import provider as provider_mod            # noqa: E402
from elab import serialcodec as serialcodec_mod      # noqa: E402
from elab import serialconsole as serialconsole_mod  # noqa: E402
from elab import serialcontrol as serialcontrol_mod  # noqa: E402
from elab import logdecode as ld                      # noqa: E402
from elab import serialframes as sf                   # noqa: E402
from elab import framelearn as framelearn_mod         # noqa: E402
from elab import serialmon as serialmon_mod          # noqa: E402
from elab import serialport as serialport_mod        # noqa: E402
from elab import serialtransport as serialtransport_mod  # noqa: E402
from elab import serialterm as serialterm_mod        # noqa: E402
from elab import serialwidgets as serialwidgets_mod  # noqa: E402
from elab.config import Config, ElabError, Host, to_fwd     # noqa: E402
from elab.kernel import events as ev_mod              # noqa: E402
from elab import pkg as pkg_mod                       # noqa: E402
from elab import setup as setup_mod                   # noqa: E402
from elab import _yaml as yaml_mod                    # noqa: E402

HOST = "127.0.0.1"            # ★ 只监听本地（§5.6：本地工具，不做远程暴露）
#: ★ C34：默认端口**刻意避开 3333** —— openocd 的 gdb server 固定绑 3333，
#:   驾驶舱若占住它，闭环 debug 步骤的 openocd 会静默退出（绑定失败），
#:   症状是 debug_verify 误导性失败（实测事故 2026-10-06）。换端口用 --port。
DEFAULT_PORT = 8333
SSE_HEARTBEAT_S = 15.0        # §17.3
PROC_BATCH_S = 0.10           # §17.3：proc 行 100ms 合并，事件数降 1~2 个数量级
QUEUE_MAX = 2000              # §17.3：每连接有界队列
#: ★ 16（盘点 #3，原 8）：App 1 条 run 流 + 串口 1 条 + 调试壳层/pane 各 1 条，
#:   两个会话双列时调试就吃 3 条 —— 3 个标签页就能撞满 8。
#:   503 对 EventSource 是"直接关闭"，前端只会看到连接失败，所以满员的代价比
#:   想象的大：静默停更。名额放宽 + 前端按需建流（无会话不建壳层）双管齐下。
MAX_SSE_CONNS = 16
DIST_DIR = _HERE / "web" / "dist"

# ★ 内核自描述（§16 分层解耦）：业务词汇的唯一事实源。
#   工具层（DSH 插件 / CLI 帮助）只渲染这里的定义，不自带业务名词 ——
#   内核改名/加步骤/调档位，工具层无需改代码。
STEP_META = {
    "doctor":       {"label": "体检",     "channel": "build"},
    "doctor_deep":  {"label": "深度体检", "channel": "build"},
    "build":        {"label": "编译",     "channel": "build"},
    "flash":        {"label": "烧录",     "channel": "flash"},
    "debug_verify": {"label": "调试校验", "channel": "debug"},
    "monitor":      {"label": "串口闭环", "channel": "serial"},
}
KERNEL_PLANS = [
    {"id": "basic",  "title": "编译", "steps": ["build"],
     "requires_hardware": False},
    {"id": "triple", "title": "三连", "steps": ["build", "flash", "debug_verify"],
     "requires_hardware": True},
    {"id": "loop",   "title": "闭环", "steps": ["doctor", "build", "flash", "debug_verify", "monitor"],
     "requires_hardware": False},
]

#: 串口词汇表（内核自描述，§16 / §4.4）：视图、表示、编码、行尾、解码器。
#: 工具层与前端**只渲染**这里的清单；新增能力只改内核，别在工具层写死业务名词。
SERIAL_META = {
    "views": ["lines", "bytes", "terminal", "wave"],
    # 「自动」不是一个编码，而是「让内核替你选」—— 但它确实能被
    # resolve_payload 接受，所以作为可选项一起自描述，前端不用写死。
    "formats": [*serialterm_mod.SEND_FORMATS, serialterm_mod.AUTO_FORMAT],
    "encodings": ["utf-8", "gbk"],
    "eols": list(serialterm_mod.EOLS.keys()),
    "directions": ["all", "rx", "tx"],
    "decoders": [*serialcodec_mod.DECODERS,
                 {"id": "profile", "label": "项目帧协议",
                  "channels": "fields",
                  "desc": "按 projects/<name>.frames.json 的字段表解码"}],
    # 帧协议配置（M5）：限制与校验目标由内核给出，面板不写死
    "frames": {"max_profiles": sf.MAX_PROFILES, "max_fields": sf.MAX_FIELDS,
               "max_frame_bytes": sf.MAX_FRAME, "max_file_bytes": sf.MAX_FILE,
               "max_variants": sf.MAX_VARIANTS,
               "types": list(sf.TYPES), "endians": list(sf.ENDIANS),
               "checksums": list(sf.CHECKS),
               "crc_presets": list(serialcodec_mod.CRC_PRESETS),
               "cover_anchors": list(serialcodec_mod.COVER_ANCHORS),
               "encodings": list(sf.ENCODINGS),
               "escape_applies": list(sf.ESCAPE_APPLIES),
               "max_array": sf.MAX_ARRAY,
               "bit_orders": list(sf.BIT_ORDERS),
               "length_field_types": list(sf.LENGTH_FIELD_TYPES),
               # 声明式 schema：Agent/前端按此自行构造 profile，不猜字段
               "schema": {
                   "profile": {
                       "id": "[a-z0-9_-]{1,32}",
                       "label": "string",
                       "kind": "binary",
                       "frame": "frame（见下）",
                       "checksum": ("{kind: none|sum8|xor8|crc8|crc16|crc32|"
                                    "crc16modbus, at: tail|head, "
                                    "preset?, poly?, init?, xorout?, refin?, "
                                    "refout?, size?, endian?, offset?, "
                                    "cover?: {from,to}}"),
                       "escape": "{escape_byte, xor, targets[], applies}（可选）",
                       "fields": "[field]（可选，variant 未命中时的兜底）",
                       "variants": "[variant]（可选，最多 max_variants）",
                       "allow_overlap": "bool=false（字段区间重叠必须显式允许）",
                   },
                   "frame": {
                       "head_hex": "hex（可选；与 heads 互斥）",
                       "heads": "[hex]（可选，1..4 个帧头，最长匹配优先）",
                       "tail_hex": "hex（可选）",
                       "length": "int|null（固定帧长，与 length_field 互斥）",
                       "idle_gap_ms": "int（可选，1..5000；按空闲间隔切帧）",
                       "max_bytes": "int（默认 256）",
                       "length_field": {
                           "offset": "int（从帧首字节算）",
                           "type": "u8|u16",
                           "endian": "le|be",
                           "mul": "number=1（总长 = raw * mul + add）",
                           "add": "number=0（可为负）",
                       },
                       "id_field": {
                           "offset": "int",
                           "type": "整数类型",
                           "endian": "le|be",
                           "bit_offset": "0..7（可选）",
                           "bit_length": "1..32（可选）",
                           "bit_order": "lsb0|msb0（可选）",
                       },
                   },
                   "escape": {
                       "escape_byte": "0x 字节",
                       "xor": "0x 字节（转义后与原字节异或）",
                       "targets": "[0x 字节]（需要转义的字节，含 escape_byte 自身）",
                       "applies": "payload（默认，校验字节不转义）|body",
                   },
                   "field": {
                       "name": "string（profile 内唯一）",
                       "type": "u8|u16|u24|u32|i8|i16|i24|i32|f16|f32|f64|ascii|str|bytes",
                       "offset": "int",
                       "endian": "le|be",
                       "length": "ascii/str/bytes 必填",
                       "encoding": "utf-8|gbk|ascii|latin-1（ascii/str）",
                       "scale": "number=1",
                       "bias": "number=0",
                       "unit": "string",
                       "enum": "{raw: label}（可选；有 enum 时不做波形通道）",
                       "bits": "{bit: label}（可选，位标志；原始值仍保留）",
                       "array": "{count: int, stride: int}（重复块，展开为 name[i]）",
                       "plot": "bool",
                       "bit_offset": "0..7（可选，需同时给 bit_length）",
                       "bit_length": "1..32（可选；只对整型）",
                       "bit_order": "lsb0|msb0（默认 lsb0）",
                   },
                   "variant": {
                       "id": "int 或 0x 十六进制字符串",
                       "label": "string",
                       "fields": "[field]",
                       "checksum": "可选；不写则用 profile.checksum",
                   },
               },
               "templates": {"path": str(sf.TEMPLATE_SUBDIR),
                             "list": "/api/serial/frames/templates",
                             "import": "/api/serial/frames/templates/import"},
               "endpoints": {"load": "/api/serial/frames",
                             "save": "/api/serial/frames",
                             "preview": "/api/serial/frames/preview",
                             "encode": "/api/serial/frames/encode",
                             "learn": "/api/serial/frames/learn",
                             "verify": "/api/serial/frames/verify",
                             "auto": "/api/serial/frames/auto",
                             "codegen": "/api/serial/frames/codegen",
                             "templates": "/api/serial/frames/templates",
                             "template_import":
                                 "/api/serial/frames/templates/import"},
               "learn": {"min_head_hits": framelearn_mod.MIN_HEAD_HITS,
                         "auto_min_score": framelearn_mod.AUTO_MIN_SCORE,
                         "auto_margin": framelearn_mod.AUTO_MARGIN,
                         "checksum_probes": list(framelearn_mod.LEARN_CHECKSUMS),
                         "note": ("learn 只产草稿（不落盘）：保存仍走 save 的 "
                                  "rev 乐观锁；草稿可直接喂 preview/verify")}},
    "features": ["hex", "search", "clear", "pause", "epoch", "lease",
                 "capture", "capture_export", "waveform",
                 # 通用发送面板（P1）：自动格式识别 + 服务端字节预览
                 "auto_format", "send_preview",
                 # 会话级共享解码：agent 选的 decoder 与面板同图（P3.5）
                 "decoder_share", "decoded_frames",
                 # 自定义发送组件（M1）：chips / 参数 / 预览 / 单条发送
                 "send_widgets", "widget_dry_run", "widget_jobs",
                 # 序列 / 周期（M2）：send+delay+wait、固定节拍、暂停/取消
                 "widget_sequence", "widget_wait", "widget_repeat", "widget_pause",
                 # 发送框的瞬态周期任务（不落盘，与组件同一引擎）
                 "raw_loop",
                 # 线参数（M1）：7E1/2 停止位/流控 —— 打开时生效
                 "line_config",
                 # DTR/RTS 原始控制 + 包内数据驱动的复位/下载序列（M1）
                 "dtr_rts", "reset_presets",
                 # 会话韧性（M2）：掉线自动重连 + 闭环让位/回归 + 速率统计
                 "reconnect", "conn_state", "run_yield", "rate_stats",
                 # 日志诊断（M6）：结构化 panic + 地址符号化
                 "log_profiles", "panic_issues", "symbolize",
                 # 帧协议（M5）：配置读写 + 无硬件预览 + 实时字段表
                 "frame_profiles", "frame_preview", "frame_fields",
                 # 帧协议增强（P0/P1）：位域 / 变长 / 多 ID / 反向组帧 / 模板
                 "frame_bitfields", "frame_length_field", "frame_variants",
                 "frame_encode", "frame_templates", "agent_frame_edit",
                 # 帧协议补强（P2.2）：校验预设/覆盖范围、转义、多帧头、
                 # 空闲分包、数组/字符串/f16/位标志、重叠校验、错误分类
                 "frame_checksum_presets", "frame_escape", "frame_multi_head",
                 "frame_idle_gap", "frame_arrays", "frame_strings",
                 "frame_half_float", "frame_flag_bits", "frame_overlap_check",
                 "frame_error_reasons",
                 # Agent 生产力（P4）：抓包学习 / round-trip / 自动匹配 / C 头
                 "frame_learn", "frame_verify", "frame_auto", "frame_codegen",
                 # 观测（P3）：帧级健康度 + 触发式录制
                 "frame_stats", "capture_trigger",
                 # 网络传输（M4）：TCP 客户端/服务端 + UDP，默认只绑回环
                 "net_transport", "udp", "allow_remote"],
    # 传输种类（M4，内核自描述）：面板按此渲染「连接方式」，不写死业务名词
    "transports": {
        "kinds": ["serial", *serialtransport_mod.NET_KINDS],
        "default": "serial",
        "net": {
            "defaults": serialtransport_mod.netio.NET_DEFAULTS,
            "loopback_only": True,
            "note": ("默认只允许 127.0.0.1 / localhost；跨机连接需显式 "
                     "allow_remote（面板首次放开要弹警告）。TCP 服务端一次"
                     "只服务一个客户端，客户端断开视为链路断开并触发重连。"),
        },
    },
    # 组件词汇与限制（内核自描述；工具层/前端只渲染，不写死）
    "widget": serialwidgets_mod.meta(),
    # 线参数（M1）：面板只渲染这些枚举；默认 8N1 = 旧行为
    "line": {
        "data_bits": [5, 6, 7, 8],
        "parity": list(serialport_mod.PARITIES),
        "stop_bits": list(serialport_mod.STOP_BITS),
        "flow": list(serialport_mod.FLOWS),
        "default": serialport_mod.LineConfig().as_dict(),
        "text_forms": ["8N1", "7E1", "8O2", "5N1.5"],
        "note": "线参数是打开时属性 —— 改后需重开监视/发送才生效",
    },
    # 重连（M2）：默认开、200ms→5s 无限退避（附录 B）
    "reconnect": {
        "default": dict(serialmon_mod.RECONNECT_DEFAULT),
        "backoff_ms": [200, 400, 800, 1600, 3200, 5000],
        "states": ["live", "reconnecting", "suspended", "closed"],
    },
    # 缓冲上限（M2 统计）：面板只渲染，不写死数字
    "buffer": serialmon_mod.limits(),
    # 日志诊断（M6）：profile 来自包/工程数据；内核只有通用解释器
    "log_profiles": {"source": "/api/serial/log-profiles",
                     "issues": "/api/serial/monitor/issues",
                     "symbolize": "/api/serial/symbolize",
                     "kinds": ["panic", "assert", "hardfault", "reset"],
                     "session_scoped": True},
    # 闭环前后监视的处理：open（默认）/ restore / off
    "run_yield": {"resume_after_run": ["open", "restore", "off"],
                  "default": "open",
                  "note": "闭环占用串口时监视自动让位；run 结束按此策略回归"},
    # 定时发送的限制（不写死在面板里）：间隔下限、单任务最长时长、count 语义
    "loop": {
        "min_interval_ms": serialwidgets_mod.MIN_REPEAT_MS,
        "max_duration_s": serialwidgets_mod.MAX_REPEAT_S,
        "count_zero_means": "until_stop",
        "interleaving": "exclusive",
    },
}

def _frame_profile_of(cfg, body: dict) -> dict:
    """从请求体取 profile：优先**未保存草稿**，否则 project+id 装载。

    Agent 的用法是"先学一个草稿 → preview/verify 验 → 再 save"，所以每个
    帧协议端点都必须接受草稿，不然学习结果没法在落盘前验证。
    """
    draft = body.get("profile")
    if isinstance(draft, dict):
        try:
            return sf.normalize_profile(draft)
        except ValueError as exc:
            raise ElabError(str(exc))
    project = str(body.get("project") or "")
    pid = str(body.get("id") or "")
    if not project or not pid:
        raise ElabError("需要 project+id，或 profile 草稿")
    prof = sf.get(cfg, project, pid)
    if prof is None:
        raise ElabError(f"未找到帧协议 profile：{pid!r}")
    return prof


#: 录制文件读入上限：学/校验只用开头几万字节，几 MB 的文件纯属浪费内存。
MAX_CAPTURE_FILE_BYTES = 16 * 1024 * 1024

#: 请求体上限：正常配置/样本都远小于它；这条只挡"把几十 MB 字节塞进 body"的误用。
MAX_BODY_BYTES = 8 * 1024 * 1024

#: 拒收时最多读掉多少字节（读了才能把错误回给客户端，见 ``_drain_body``）。
MAX_DRAIN_BYTES = 64 * 1024 * 1024


def _capture_text(cfg: Config, raw) -> str:
    """``capture`` 参数：既接受 JSONL **文本**，也接受录制文件**路径**。

    agent 手里通常只有文件名（录制是它刚用 capture 端点起的），让它把几 KB
    JSONL 塞进请求体不现实；而"按路径读文件"是个危险入口 —— 所以路径必须
    落在本工程的 ``.work/.cockpit`` 里且是 ``.jsonl``，别处一律拒绝（源码、
    配置、密钥都在别处）。
    """
    s = str(raw or "")
    if not s.strip() or s.lstrip().startswith("{"):
        return s                              # 已经是内容（或空）：原样交下去
    p = Path(s)
    if not p.is_absolute():
        p = Path(cfg.root) / p
    try:
        p = p.resolve()
    except OSError as exc:
        raise ElabError(f"capture 路径无法解析：{s}（{exc}）")
    cap_dir = (Path(cfg.root) / ".work" / ".cockpit").resolve()
    if p.suffix.lower() != ".jsonl" or cap_dir not in p.parents:
        raise ElabError(f"capture 只接受 {cap_dir} 下的 .jsonl 录制文件：{s}")
    if not p.exists():
        raise ElabError(f"录制文件不存在：{s}")
    try:
        size = p.stat().st_size
    except OSError as exc:
        raise ElabError(f"读不到录制文件大小：{exc}")
    if size > MAX_CAPTURE_FILE_BYTES:
        raise ElabError(
            f"录制文件 {size / 1048576:.1f} MB 太大（上限 "
            f"{MAX_CAPTURE_FILE_BYTES // 1048576} MB）："
            f"学习只需开头几万字节，请截一段再学，或重录一段更短的")
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise ElabError(f"读取录制文件失败：{exc}")


def _frame_bytes_of(body: dict, cfg: Config) -> bytes:
    """请求体里的样本字节：b64 / hex / capture(JSONL 文本或录制路径) 三选一。"""
    if body.get("capture"):
        chunks, _ = framelearn_mod.parse_capture(_capture_text(cfg, body.get("capture")))
        return b"".join(chunks)
    if body.get("b64"):
        try:
            return base64.b64decode(str(body["b64"]))
        except Exception as exc:                       # noqa: BLE001
            raise ElabError(f"b64 不是合法 base64：{exc}")
    if body.get("hex"):
        try:
            return bytes.fromhex("".join(str(body["hex"]).split()))
        except ValueError as exc:
            raise ElabError(f"hex 不是合法十六进制：{exc}")
    return b""


COCKPIT_VERSION = "3.1.0"


def _sync_serial_decoder(cfg, project: str, pid: str, deleted: bool) -> None:
    """profile 保存/删除后热更新会话解码器（只动正在用该 profile 的会话）。"""
    snap = serialmon_mod.status()
    if not snap.get("active"):
        return
    cur = str(snap.get("decoder") or "")
    if not (cur == "profile" or cur.startswith("profile:")):
        return
    cur_id = cur.split(":", 1)[1].strip() if ":" in cur else ""
    if cur_id != pid:
        return
    if deleted:
        serialmon_mod.set_decoder("", actor="profile-sync", cfg=cfg,
                                  project=project)
    else:
        serialmon_mod.set_decoder(cur, actor="profile-sync", cfg=cfg,
                                  project=project)

DEBUG_LEASE_DEFAULT_S = 600
DEBUG_LEASE_MIN_S = 60
DEBUG_LEASE_MAX_S = 1800
DEBUG_AUDIT_MAX = 500

#: 调试能力自描述（§16 内核自描述）：工具层按此渲染，不写死业务名词。
#: ★ 内核过旧（缺 ``meta.debug``）时插件隐藏调试入口 —— 不在工具层写兼容分支。
DEBUG_META = {
    "available": True,
    "max_sessions": 2,
    "features": ["session", "control", "stack", "variables", "registers",
                 "breakpoints", "memory", "disasm", "watch", "source",
                 "svd", "rtos"],
    "actions": ["continue", "pause", "step_over", "step_in", "step_out",
                "stepi", "reset", "restart", "run_to", "run_to_line"],
    "stop_at": ["main", "reset", "none"],
    "breakpoint_kinds": ["func", "addr", "source"],
    "registers_group": ["core", "fpu", "all"],
    "formats": ["natural", "hex"],
    "watch_formats": ["natural", "hex", "binary"],
    "svd": {"tree_path": "PERIPH 或 PERIPH.REG", "read": True},
    "rtos": {"available_via": "elf symbols (FreeRTOS pxCurrentTCB)", "granularity": "task"},
    "lease": {"default_s": DEBUG_LEASE_DEFAULT_S, "min_s": DEBUG_LEASE_MIN_S,
              "max_s": DEBUG_LEASE_MAX_S},
    "limits": {"memory_read_max": 4096, "disasm_max": 128,
               "variables_depth": 8, "audit_records": DEBUG_AUDIT_MAX,
               "watch_max": 32, "source_lines_max": 400,
               "source_bytes_max": 512 * 1024, "register_batch_max": 16},
    "error_codes": ["debug-unavailable", "debug-busy", "debug-no-session",
                    "debug-elf-missing", "debug-gdb-missing", "debug-openocd-dead",
                    "debug-port-hijacked", "debug-timeout", "debug-target-running",
                    "debug-bad-request", "debug-write-denied", "debug-limit",
                    "debug-rev-conflict", "debug-svd-missing",
                    "debug-rtos-unavailable", "debug-error",
                    "debug-target-busy", "debug-session-limit",
                    "debug-session-required", "debug-source-unavailable"],
    # 互斥语义（面板据此显示人话）
    "exclusive_with": ["run(flash/debug_verify/monitor)", "serial-monitor"],
    "on_close": {"resume": True, "method": "monitor reset run"},
}

#: 调试页签的**项目级**收敛：全局 ``DEBUG_META.features`` 是内核能力上限，
#: 实际显示按「项目（芯片）→ 会话（snapshot.features）」逐级收敛。
_DEBUG_BASE_FEATURES = ["session", "control", "stack", "variables", "registers",
                        "breakpoints", "memory", "disasm", "watch", "source"]


def _debug_meta(cfg: Config) -> dict:
    """``capabilities.meta.debug`` —— 会话上限取 L0（``debug.max_sessions``）。"""
    meta = dict(DEBUG_META)
    try:
        raw = int(((cfg.host or {}).get("debug") or {}).get("max_sessions", 2))
    except (TypeError, ValueError):
        raw = 2
    meta["max_sessions"] = max(1, min(raw, 4))
    return meta


def _debug_features(chip: dict) -> list[str]:
    """芯片声明的调试能力（如 ESP32 无 SVD → 不出现「外设」页签）。"""
    dbg = chip.get("debug") or {}
    feats = list(_DEBUG_BASE_FEATURES)
    if dbg.get("svd"):
        feats.append("svd")
    # RTOS 是固件能力：会话打开后才探测符号；项目级沿用乐观声明（与 debugsession 一致）
    if dbg.get("rtos") is not False:
        feats.append("rtos")
    return feats


#: 服务端可能通过 SSE 发出的**命名事件**全集（跨端契约的镜像）。
#:
#: ★ 为什么必须在这里再列一遍（而不是"从代码里自然得到"）：
#:   SSE 用的是**命名事件**，`EventSource.onmessage` 只接收**没有** `event:`
#:   字段的帧，所以前端必须为每个 topic 显式 `addEventListener`。漏一个，
#:   该 topic 的全部事件在浏览器里**静默消失** —— 不报错、`onerror` 不触发、
#:   服务端日志也一切正常（ICD §6.1）。
#:   实测事故：前端白名单漏了 `proc/stdout-batch`，于是 **run 跑起来之后所有
#:   实时编译日志都不可见**；而同一个 run 结束后再看（走按 seq 重放分支、
#:   逐条 `proc/stdout`）却是全的 —— 这个"历史有、实时没有"的不对称极难归因。
#:
#: 谁在守它：
#:   ① `_sse_warn_unknown()` —— 真发出未登记 topic 时打一条 WARN（把静默变有声）；
#:   ② `tests/it_cockpit_server.py::test_known_topics_covers_server_emitted`
#:      —— 与前端 `KNOWN_TOPICS` 做集合比对，CI 层拦截。
SSE_TOPICS = frozenset({
    "run/start", "run/step-enter", "run/step-exit", "run/end", "run/cancel",
    "proc/stdout", "proc/stderr", "proc/stdout-batch", "proc/exit",
    "serial/open", "serial/line", "serial/close", "serial/error",
    "serial/closed-loop",
    # 调试会话（独立信封，不复用 run 信封）
    "debug/opened", "debug/state", "debug/stop", "debug/breakpoint",
    "debug/output", "debug/error", "debug/closed",
    "stream/overrun", "stream/closed",
})


#: 服务端**合成**（不写事件日志）的 topic。它们不在 ``kernel.events`` 里，
#: 因为它们是"父进程对这条流的观察"，不是 run 自己的事实。
SYNTHETIC_TOPICS = frozenset({"stream/closed", "stream/overrun"})

#: 其中**绝不可丢**的那一个。
#:
#: ★ ``stream/closed`` 的 ``is_activity()`` 是 **True**（它前缀是 ``stream/``，
#:   非 ``run/``），于是队列一满它就会被当成"可丢的活动事件"丢掉 ——
#:   而它恰恰是浏览器**唯一**的"run 结束了、可以收尾了"信号
#:   （``sse.ts`` 收到它才 ``es.close()`` + 回调 ``onClosed``）。
#:   丢掉它的后果：``markStreamClosed`` 永不触发，界面**永远显示"运行中"**、
#:   取消按钮永远亮着，而进程早就没了。
#:   唯一的兜底是心跳分支（``heartbeats > 8`` ≈ 2 分钟）后断开连接，
#:   让浏览器重连走"已结束 run 的重放分支" —— 也就是说：
#:   **恢复要两分钟，且表现为"卡住"而不是"报错"**。
#:   故把它明确划进"不可丢"（与 ``run/*`` 同级）。
CONTROL_TOPICS = frozenset({"stream/closed"})


# ══════════════════════════════════════════════════════════════════
#  Run 管理：spawn / 跟读 / 取消（§5.1）
# ══════════════════════════════════════════════════════════════════
@dataclass
class ActiveRun:
    #: 以下四个是**临时占位**：``run/start`` 一落盘就以日志为准（见 ``list_active``）。
    #: 留着它们只是为了覆盖"子进程刚 spawn、首行还没刷出来"的那几百毫秒窗口。
    run_id: str
    project: str
    steps: list[str]
    actor: str
    #: 以下三个只有进程内拿得到 —— 日志里没有也不该有，故**必须**留在内存。
    proc: subprocess.Popen
    started_at: float
    subscribers: set = field(default_factory=set)
    lock: threading.Lock = field(default_factory=threading.Lock)
    #: 背压统计：给 UI 显示"日志已截断"用（§17.3）。
    #: ★ 这是**run 级**计数（跨订阅者累加），`/api/runs.active` 直接读它。
    dropped: int = 0
    last_seq: int = 0
    #: 每个订阅者队列的溢出状态：``id(q) -> {"armed": bool, "marker": dict|None}``。
    #: 键用 ``id(q)`` 是安全的 —— q 在整个订阅期都被 ``subscribers`` 持有，
    #: 期间地址不会变也不会被回收（``unsubscribe`` 会同步清掉这条）。
    sub_state: dict = field(default_factory=dict)
    #: 终态回调（M2 让位/回归）：run 进程退出、stream/closed 扇出后调用。
    on_finish: "callable | None" = None

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None


class RunManager:
    """run 登记簿 + 事件扇出。

    登记簿（``_active``）记的是**本进程起过的 run**；子进程退出、follower 收尾后
    会把自己摘掉，故它长期看只包含"在跑的"。对外报"活动 run"的是
    :meth:`list_active`，它还会再过滤一次 ``alive``（见该方法的说明）。

    一个 run 一个 follower 线程：它用 ``kernel.events.follow`` 跟读
    ``<id>.jsonl`` + ``<id>.proc.jsonl``（**按 seq 归并**），再推给所有订阅者。
    子进程退出后，follower 补发一条 ``stream/closed`` 让浏览器**主动断开**
    （否则 EventSource 会不停重连一个已结束的 run）。

    ★ 登记簿**不是**真相：真相是事件日志（契约 §5.3）。``_active`` 里除
      ``proc``/``alive``/``last_seq`` 这几个"只有进程内才有"的句柄之外，
      其余元数据都在 ``run/start`` 里逐字存在，且以那份为准（见 :meth:`list_active`）。
      这条纪律是 N9 换来的：两份真相迟早会分叉。
    """

    def __init__(self, cfg: Config, *, log=print):
        self.cfg = cfg
        self.runs_dir = run_mod.runs_dir_for(cfg)
        self.log = log
        self._active: dict[str, ActiveRun] = {}
        self._lock = threading.Lock()

    # ── 查询 ────────────────────────────────────────────────────
    def active(self, run_id: str) -> ActiveRun | None:
        with self._lock:
            return self._active.get(run_id)

    def list_active(self) -> list[dict]:
        """**只在跑的** run，按 ``started_at`` 倒序（最新在前）。

        ★ 为什么必须过滤 ``alive``（实测踩过的缺陷）：
          ``_active`` 的语义不是"活动 run 列表"，而是"本进程起过的 run 的登记簿" ——
          子进程退出后条目仍要在（SSE 靠它判定"已结束 → 重放完就收尾"）。
          早先把登记簿**原样**当成活动列表返回，于是 ``/api/runs.active``
          ①永远不为空、②无界增长，而且前端 ``active.find(project)`` 取到的是
          **最早**那条已结束的 run。真实症状：新起一个 build-only run，
          界面却显示上一条 ``doctor+build`` 的 36 行日志，
          并且 300ms 内就"跑完了"（那其实是旧 run 的重放）。
          过滤之后 ``active`` 才配得上它的名字，前端也因此能正确回退到
          "没有在跑的 → 显示最近一次的留档"。

        ★ **元数据以事件日志为准**（契约 §5.3）。``project``/``steps``/``actor``/
          ``started_at`` 在 ``run/start`` 里**逐字都有**，而 ``_active`` 里那份是
          ``spawn()`` 按自己的理解记下的 —— 两份真相必然有一天对不上
          （实测 N9：取消/重跑之后界面显示的步骤序列与日志里的不一致）。
          故这里一律**回读 ``run/start``**，内存那份退化为"子进程还没把首行刷出来"
          那几百毫秒的**临时占位**，并用 ``meta_source`` 把这件事**标出来**，
          而不是让人以为它同样权威。
          剩下的 ``pid``/``alive`` 只存在于进程内、日志里没有也不该有 —— 那才是
          ``_active`` 该独占的东西。
        """
        with self._lock:
            live = [a for a in self._active.values() if a.alive]
        out = []
        for a in live:
            st = self._start_event(a.run_id)
            if st is not None:
                meta = {
                    "project": st.get("project") or a.project,
                    "steps": list(st.get("steps") or a.steps),
                    "actor": st.get("actor") or a.actor,
                    "started_at": st.get("ts") or a.started_at,
                    "meta_source": "event-log",
                }
            else:
                meta = {"project": a.project, "steps": list(a.steps),
                        "actor": a.actor, "started_at": a.started_at,
                        "meta_source": "provisional"}
            out.append({
                "run": a.run_id, **meta,
                # 下面两个是**进程内**的事实，日志里没有也不该有：
                "pid": a.proc.pid, "alive": True,
                "dropped": a.dropped, "last_seq": a.last_seq,
            })
        out.sort(key=lambda x: x["started_at"], reverse=True)
        return out

    def _start_event(self, run_id: str) -> dict | None:
        """回读该 run 的**首条** ``run/start``（``seq`` 恒为 1，也就是文件第一行）。

        只 peek 一次、**不缓存**：事件文件是只追加的，首行永不改变，
        故"每次重读"与"缓存一份"结果必然相同 —— 那就不必再引入第二个
        需要保持同步的东西（本文件反复在为"少一个同步点"付代价）。
        """
        state = self.runs_dir / f"{run_id}.jsonl"
        try:
            for e in ev_mod.replay(state, 0):
                return e if e.get("topic") == ev_mod.RUN_START else None
        except OSError:
            return None
        return None

    # ── spawn ───────────────────────────────────────────────────
    def spawn(self, *, project: str, steps: list[str] | None = None,
              clean: bool = False, jobs: int | None = None, verbose: bool = False,
              actor: str = "human", on_finish=None) -> dict:
        """起一个 ``elab run --emit-events`` 子进程，并立刻开始跟读。

        ★ run id **由父进程分配**并显式传给子进程（``--run-id``）：
          否则父进程无法在"文件还没出现"时就知道该跟读哪个文件 —— 那是一个必然的竞态。
        """
        steps = list(steps or run_mod.DEFAULT_STEPS)
        # 与 run.parse_steps 同规则：tool:<name> 放行（<name> 是否声明由子进程
        # _resolve_tool 校验 —— 项目 YAML 在那一侧才读得到）
        bad = [s for s in steps
               if s not in run_mod.ALL_STEPS
               and not (s.startswith(run_mod.TOOL_PREFIX)
                        and len(s) > len(run_mod.TOOL_PREFIX))]
        if bad:
            raise ElabError(f"未知步骤：{', '.join(bad)}")

        self.runs_dir.mkdir(parents=True, exist_ok=True)
        run_id = ev_mod.allocate_run_id(self.runs_dir)

        argv = [sys.executable, "-m", "elab", "run",
                "-p", project, "--steps", ",".join(steps),
                "--emit-events", "--run-id", run_id,
                "--events-dir", to_fwd(self.runs_dir),
                "--actor", actor, "-q"]
        if clean:
            argv.append("--clean")
        if jobs:
            argv += ["-j", str(jobs)]
        if verbose:
            argv.append("-v")

        env = dict(os.environ)
        # 让子进程能 import elab（与 ./elab 启动器同一手法）
        env["PYTHONPATH"] = str(_ROOT / "services") + os.pathsep + env.get("PYTHONPATH", "")
        env["PYTHONUNBUFFERED"] = "1"

        # ★ 独立进程组：cmake→ninja→gcc 是一棵树，取消时要整棵杀掉（K10）
        # ★ CREATE_NO_WINDOW：服务已 pythonw 化（无控制台可继承），不挂这个
        #   标志则每个子进程（python/cmake/openocd…）都会新弹一个黑色控制台
        #   窗口——用户实测"一手动按命令就弹命令行框框"。隐藏控制台会被
        #   孙进程继承，全树无窗口。
        kwargs: dict = {"cwd": str(_ROOT), "env": env,
                        "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if os.name == "nt":
            kwargs["creationflags"] = (subprocess.CREATE_NEW_PROCESS_GROUP
                                       | 0x08000000)  # CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True

        proc = subprocess.Popen(argv, **kwargs)
        # 进「句柄关闭即终止」作业：内核被强杀时，这条 run 进程树（含用户固件
        # 程序，它会占串口）跟着一起走 —— 否则下次连串口会先遇到"端口被占用"。
        adopt_proc(proc)
        ar = ActiveRun(run_id=run_id, project=project, steps=steps, actor=actor,
                       proc=proc, started_at=time.time(), on_finish=on_finish)
        with self._lock:
            self._active[run_id] = ar

        threading.Thread(target=self._follow_loop, args=(ar,),
                         name=f"follow-{run_id}", daemon=True).start()
        self.log(f"[cockpit] ▶ run {run_id} project={project} steps={','.join(steps)} pid={proc.pid}")
        return {"run": run_id, "project": project, "steps": steps,
                "pid": proc.pid, "actor": actor}

    # ── 跟读 + 扇出 ─────────────────────────────────────────────
    def _follow_loop(self, ar: ActiveRun) -> None:
        paths = ev_mod.run_paths(self.runs_dir, ar.run_id)
        rc = None
        try:
            for e in ev_mod.follow(paths, 0,
                                   stop=lambda: ar.proc.poll() is not None,
                                   poll=0.05, max_idle_s=60 * 30,
                                   drain_after_stop=0.4):
                ar.last_seq = e.get("seq", ar.last_seq)
                self._fanout(ar, e)
            rc = ar.proc.wait()
        except Exception as exc:                      # noqa: BLE001 —— 后台线程不能炸掉服务
            self.log(f"[cockpit] follower 异常（{ar.run_id}）：{exc}")
        finally:
            try:
                rc = ar.proc.wait(timeout=5)
            except Exception:                          # noqa: BLE001
                pass
            self._fanout(ar, {"run": ar.run_id, "topic": "stream/closed",
                              "seq": ar.last_seq, "ts": time.time(),
                              "actor": "agent", "reason": "run-finished", "rc": rc})
            self.log(f"[cockpit] ■ run {ar.run_id} 结束 rc={rc}")
            # ★ 收尾后把自己从登记簿摘掉（否则跑一夜就是几百个僵尸条目）。
            #   注意顺序：必须**先** fanout `stream/closed` 再 pop —— 已经挂在
            #   `ar.subscribers` 上的 SSE 连接是靠那条事件收尾的，与登记簿无关。
            #   摘掉之后 `active(run_id)` 变 None，而 SSE 对"未知/已结束 run"的
            #   处理本来就是同一条重放分支（`ar is None or not ar.alive`），
            #   所以行为不变、只是内存有界。
            with self._lock:
                self._active.pop(ar.run_id, None)
            # M2 §4.3.6：run 结束 → 让位过的串口监视回归（失败不影响 run 收尾）
            if ar.on_finish is not None:
                try:
                    ar.on_finish(ar, rc)
                except Exception as exc:             # noqa: BLE001
                    self.log(f"[cockpit] on_finish 异常（{ar.run_id}）：{exc}")

    def _fanout(self, ar: ActiveRun, ev: dict) -> None:
        """把一条事件推给所有 SSE 订阅者；**队列满时按契约丢弃并留痕**。

        丢谁（ICD §3.2）：``proc/*`` 等 activity 类可丢，``run/*`` 绝不丢
        （``run/*`` 是界面状态的唯一真相，丢了界面就再也回不到正确状态）。

        ★ 旧实现只 ``ar.dropped += 1`` 然后 continue —— 于是"丢了多少"只有
          服务端自己知道，界面上什么都没有。这正是本仓库反复出现的
          **静默丢事件**形态：服务端全对、HTTP 全 200、日志无一行报错，
          只有那块 UI 少了内容。修法就是契约 §17.3 早就写好的那句
          "并发 `stream/overrun` 让 UI 提示'日志已截断'"。
        """
        with ar.lock:
            subs = list(ar.subscribers)
        topic = ev.get("topic", "")
        # `stream/closed` 虽属 activity 通道，却是控制帧 → 与 run/* 同级不可丢
        droppable = ev_mod.is_activity(topic) and topic not in CONTROL_TOPICS
        for q in subs:
            try:
                q.put_nowait(ev)
                # 队列不再满 → 结束了一个溢出 episode，下一轮可以再报一次
                ar.sub_state.pop(id(q), None)
                continue
            except queue.Full:
                pass

            if droppable:
                ar.dropped += 1
                self._signal_overrun(ar, q, scope="proc/*")
                continue

            # ── run/* 不可丢 → 挤掉队首（队首多半是最老的 activity 行）──
            evicted = None
            try:
                evicted = q.get_nowait()
            except queue.Empty:
                pass
            if evicted is not None:
                ar.dropped += 1          # 无论它是哪一类，订阅者都收不到了
            try:
                q.put_nowait(ev)
            except queue.Full:
                # 挤了还是满（队列里全是 run/*）→ 这一次的 run/* 只能丢，
                # 但**必须留痕**：界面据此知道"状态可能不完整，需要重载"。
                self._signal_overrun(ar, q, scope="run/*")
                continue
            if evicted is not None:
                self._signal_overrun(ar, q, scope="proc/*")

    def _signal_overrun(self, ar: ActiveRun, q: queue.Queue, *, scope: str) -> None:
        """把一个**合成的** ``stream/overrun`` 塞进该订阅者队列（同一 episode 只塞一个）。

        为什么是合成事件而不是 ``emit()`` —— 这条很关键：

        - ``stream/overrun`` 描述的是**这一条 SSE 流**丢了多少，不是 run 自己的事实。
          写进 ``<id>.proc.jsonl`` 会同时破两件事：① 单写者模型（父进程去写子进程的
          日志文件）；②"删掉 ``.proc.jsonl`` 只损失日志、不影响状态重建"的通道判据。
        - 真相**一条没少**地躺在文件里，浏览器断线重连即可按 ``seq`` 补齐
          （``_sse`` 的重放分支就是干这个的）。这条事件的作用只是把
          "你此刻看到的不是全部"**当场说出来**，而不是等用户自己发现日志断了。
        - 于是它对 DSH 那条硬约束是**不违逆**的：可观测性、重建都仍从日志派生；
          这里交付的是一个关于"传输"的瞬时事实，丢失它不影响任何状态重建。

        ★ 同一个溢出 episode 只报一次：队列满时若每条丢的事件都塞一个标记，
          队列里会全是标记、把真实内容彻底挤出去，UI 反而更瞎。
          标记里的 ``dropped`` 是**同一个 dict 对象**，后续每次丢弃都就地更新，
          故 SSE 真正读到它时拿到的是最新数字，而不是"标记诞生那一刻"的旧值。
        """
        st = ar.sub_state.setdefault(id(q), {"armed": False, "marker": None})
        if st["armed"] and st["marker"] is not None:
            st["marker"]["dropped"] = ar.dropped
            st["marker"]["ts"] = time.time()
            return
        marker = {
            "ts": time.time(), "run": ar.run_id, "topic": "stream/overrun",
            # 不带新 seq：它不是 run 的事实，不该消耗 run 的计数器。
            # 用"当前已推进到的 seq"当定位锚点；SSE 侧也不会把它写进 Last-Event-ID。
            "seq": ar.last_seq, "actor": "agent",
            # ★ 与 `/api/runs.active[].dropped` **同一个数**（run 级）。
            #   刻意不做 per-connection 计数：两个都叫 dropped 的数字含义不同，
            #   迟早会有人在界面上把它们并列显示，然后对不上。
            "dropped": ar.dropped, "topic_scope": scope,
            "reason": "sse-queue-full",
        }
        st["marker"] = marker
        try:
            q.put_nowait(marker)
            st["armed"] = True
        except queue.Full:
            # 满到连标记都放不下 → 让队首一条活动行让位（性质不变：仍是丢活动事件）
            try:
                q.get_nowait()
                q.put_nowait(marker)
                st["armed"] = True
            except (queue.Empty, queue.Full):
                pass

    # ── 订阅（SSE 用）───────────────────────────────────────────
    def subscribe(self, run_id: str) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=QUEUE_MAX)
        ar = self.active(run_id)
        if ar is not None:
            with ar.lock:
                ar.subscribers.add(q)
        return q

    def unsubscribe(self, run_id: str, q: queue.Queue) -> None:
        ar = self.active(run_id)
        if ar is not None:
            with ar.lock:
                ar.subscribers.discard(q)
            # ★ 必须一起清：sub_state 用 id(q) 当键，留着就是"地址将被复用"的隐患
            #   （新队列可能落到同一地址，于是它一上来就被判成"已报过溢出"，
            #    真正的溢出反而报不出来 —— 又是一次静默丢事件）。
            ar.sub_state.pop(id(q), None)

    # ── 取消 ────────────────────────────────────────────────────
    def cancel(self, run_id: str, *, reason: str = "用户取消") -> dict:
        """杀掉整棵进程树，然后**由父进程补一条 ``run/cancel``**。

        ★ 这是契约"单写者"的**唯一豁免**（ICD §5.4）：子进程是被 ``taskkill /F``
          硬杀的，没有机会自己写收尾事件。补写的**前置条件是写者已死**（我们
          ``wait()`` 过），故不存在并发写。
        """
        ar = self.active(run_id)
        if ar is None:
            return {"ok": False, "error": f"没有活动的 run：{run_id}"}
        if not ar.alive:
            return {"ok": False, "error": f"run 已结束：{run_id}"}

        pid = ar.proc.pid
        if os.name == "nt":
            # /T 连带子树（cmake → ninja → gcc），/F 强制。
            # ★ 必须 errors="replace"：中文 Windows 上 taskkill 输出的是 GBK
            #   （"成功: 已终止 PID …"），按 UTF-8 解码会在 subprocess 的读线程里
            #   抛 UnicodeDecodeError —— 取消反而刷一屏假栈，掩盖真正的取消结果。
            #   本仓库其余的 subprocess 调用都带这个参数，这里不能例外。
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, text=True, errors="replace", check=False)
        else:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except OSError:
                pass
            try:
                ar.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except OSError:
                    pass

        try:
            rc = ar.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            rc = None

        appended = ev_mod.append_event(
            self.runs_dir, run_id, "run/cancel", actor="human",
            project=ar.project, by="human", reason=reason,
        )
        if appended is not None:
            ar.last_seq = appended["seq"]
            self._fanout(ar, appended)
        self.log(f"[cockpit] ■ 已取消 {run_id}（rc={rc}）")
        return {"ok": True, "run": run_id, "rc": rc, "pid": pid}


# ══════════════════════════════════════════════════════════════════
#  数据投影：projects / capabilities
# ══════════════════════════════════════════════════════════════════
def project_cards(cfg: Config) -> dict:
    """工程卡片数据。

    ★ 要求（§6 / M1.6）：**100% 来自 `projects/*.yaml`，不新增任何元数据**。
      下面所有字段要么是 YAML 原值，要么是它 + ``chips/*.yaml`` 的直读，
      要么是由"文件是否存在"推导出来的状态位（明确标注）。
    """
    host = cfg.host or {}
    probes = ((host.get("probes") or {}).get("list") or {})
    caps = serialport_mod.capabilities()

    def _delegated(proj: dict, step: str) -> bool:
        """该步骤是否委托给项目声明的 tools.<name>。"""
        spec = (proj.get("steps") or {}).get(step)
        return isinstance(spec, str) and spec.startswith(run_mod.TOOL_PREFIX)

    cards = []
    for name, raw in sorted(cfg.projects.items()):
        proj = cfg.resolved_project(name)          # 完成 ${...} 插值
        chip_ref = proj.get("chip", "")
        try:
            chip = cfg.chip_of(proj)               # 支持项目级 pack 固定
        except ElabError:
            chip = {}
        # ── 工具链 provider（内核解析，工具层只读投影；不 import 任何 provider 代码）──
        try:
            tc = provider_mod.resolve(cfg, name)
            prov_avail = provider_mod.evaluate(cfg, name, tc)
        except ElabError as exc:
            tc = None
            prov_avail = {"available": False, "reasons": [{
                "code": "provider.error", "key": "", "message": str(exc), "hint": ""}]}
        build = proj.get("build") or {}
        work_dir = build.get("work_dir", "")
        art = proj.get("artifacts") or {}

        # 派生状态位（**非**新元数据，只是"文件在不在"）
        elf = art.get("elf", "")
        built = bool(elf) and Path(elf).exists()

        probe = (proj.get("debug") or {}).get("probe", "")
        monitor = proj.get("monitor") or {}
        has_rules = bool(monitor.get("close_on") or [])

        avail: dict[str, dict] = {s: {"ok": True, "reason": ""} for s in run_mod.ALL_STEPS}
        if not (probe and probe in probes):
            reason = (f"未声明可用探针（debug.probe={probe or '空'}）"
                      if not probe else f"探针 {probe!r} 不在 elab.host.yaml: probes.list 中")
            # ★ 委托步骤不需要探针：烧录/校验由项目自带工具（如 esptool）执行。
            if not _delegated(proj, "flash"):
                avail["flash"] = {"ok": False, "reason": reason}
            if not _delegated(proj, "debug_verify"):
                avail["debug_verify"] = {"ok": False, "reason": reason}
        if not has_rules:
            avail["monitor"] = {"ok": False,
                                "reason": "未声明 monitor.close_on → 只能判 inconclusive"}
        elif not caps.get("available"):
            avail["monitor"] = {"ok": False,
                                "reason": f"串口后端不可用（layer={caps.get('layer')}）"}

        # ── 每步 kind/source/available（全部来自内核 ResolvedToolchain；只读投影）──
        steps_view: dict[str, dict] = {}
        for step in run_mod.ALL_STEPS:
            decl = tc.steps.get(step) if tc else None
            if decl is None:
                steps_view[step] = {**avail[step], "kind": "native",
                                    "source": "elab/native", "tool": ""}
                continue
            if decl.kind == "unavailable":
                steps_view[step] = {"ok": False, "reason": decl.reason,
                                    "kind": "unavailable", "source": decl.provider,
                                    "tool": ""}
                continue
            if decl.kind == "external":
                reasons = list((prov_avail or {}).get("reasons") or [])
                if decl.provider == "project":
                    reasons = []
                elif not any("${serial_port}" in str(a) for a in decl.cmd):
                    reasons = [r for r in reasons
                               if r.get("code") != "serial.unavailable"]
                steps_view[step] = {
                    "ok": not reasons,
                    "reason": "；".join(str(r.get("message") or r) for r in reasons),
                    "kind": "external",
                    "source": (decl.provider if decl.provider == "project"
                               else f"{tc.provider.name}@{tc.provider.version}"),
                    "tool": decl.tool_name,
                }
                continue
            steps_view[step] = {**avail[step], "kind": "native",
                                "source": "elab/native", "tool": ""}

        # ── OTA 投影（C1/C3，全部派生：chips yaml ota_layout + boot 台账文件）──
        #   ota=None = 该芯片未声明 ota_layout（普通单镜像工程，UI 不渲染 OTA 行）
        ota_layout = chip.get("ota_layout") or {}
        ota = None
        if ota_layout:
            boot_proj = ota_layout.get("boot_project", "")
            ota = {"boot_project": boot_proj, "slots": len(ota_layout.get("slots") or []),
                   "boot_stamp": None}
            if boot_proj:
                # boot 台账 = C3 冻结策略的落盘状态（version/md5/flashed_at）
                ota["boot_stamp"] = flash_mod.boot_stamp(cfg.root, boot_proj)

        cards.append({
            "name": name,
            "chip": chip_ref,
            "archetype": proj.get("archetype", ""),
            "root": proj.get("root", ""),
            "work_dir": work_dir,
            "project_name": build.get("project_name", name),
            "generator": build.get("generator", ""),
            "build_type": build.get("build_type", ""),
            "linker_script": build.get("linker_script", ""),
            "artifacts": {k: v for k, v in art.items()},
            "probe": probe,
            # 调试后端：provider.debug.backend > 芯片声明（如 esp-idf）。
            # 非空时驾驶舱「调试」页签不因 probe 为空而置灰。
            "debug_backend": str(
                ((tc.debug if tc else {}) or {}).get("backend")
                or (chip.get("debug") or {}).get("backend") or ""),
            # 调试页签白名单：项目 debug_features ?? provider.debug.features ?? 芯片收敛
            "debug_features": (list(proj.get("debug_features") or [])
                               or list(((tc.debug if tc else {}) or {}).get("features") or [])
                               or _debug_features(chip)),
            # 工具链 provider 投影（available/reasons 来自内核 requires 求值）
            "provider": ({"name": tc.provider.name, "version": tc.provider.version,
                          "source": tc.provider.source, "path": tc.provider.path,
                          "available": bool(prov_avail.get("available")),
                          "reasons": list(prov_avail.get("reasons") or [])}
                         if tc and tc.provider.source != "builtin" else None),
            "serial": proj.get("serial") or {},
            "monitor": {"close_on": len(monitor.get("close_on") or []),
                        "fail_on": len(monitor.get("fail_on") or []),
                        "idle_timeout_s": monitor.get("idle_timeout_s")},
            "provenance": proj.get("provenance") or {},
            # 项目声明工具（通用机制）：驾驶舱据此渲染"工具"按钮
            "tools": [{"name": k, "label": ((v or {}).get("label") or k)}
                      for k, v in sorted((proj.get("tools") or {}).items())],
            # 步骤是否由外部工具执行（项目内联 tool: 或 provider）
            "delegated": {s: (_delegated(proj, s)
                              or steps_view[s].get("kind") == "external")
                          for s in run_mod.ALL_STEPS},
            # 项目级文案覆盖（可选）：label(step) = step_labels[step] ?? STEP_META.label
            "step_labels": dict(proj.get("step_labels") or {}),
            # OTA 投影（None=无 ota_layout；boot_owner 在下方第二遍填充）
            "ota": ota,
            "boot_owner": "",
            # ↓ 以下为派生状态位，不是新元数据
            "derived": {"built": built, "work_dir_exists": bool(work_dir) and Path(work_dir).is_dir()},
            "steps": steps_view,
            "chip_info": {
                "id": chip.get("id", ""), "vendor": chip.get("vendor", ""),
                "family": chip.get("family", ""), "part": chip.get("part", ""),
                "package": chip.get("package", ""), "frequency": chip.get("frequency", ""),
                "core": chip.get("core") or {}, "memory": chip.get("memory") or {},
                "debug": chip.get("debug") or {},
                # ★ 芯片来自哪个适配包（骨架本身不含芯片；空 = 未安装适配包）
                "pack": chip.get("_pack", ""),
            },
        })

    # 第二遍：boot 子工程归属（C1 交叉引用派生——被谁的 ota_layout.boot_project
    # 指到，谁就是"boot 子工程"；自引用除外：boot 工程自己就是 boot）。
    owners = {}
    for c in cards:
        bp = (c.get("ota") or {}).get("boot_project") or ""
        if bp and bp != c["name"]:
            owners[bp] = c["name"]
    for c in cards:
        c["boot_owner"] = owners.get(c["name"], "")

    return {
        "projects": cards,
        "steps": {
            "all": list(run_mod.ALL_STEPS),
            "default": list(run_mod.DEFAULT_STEPS),
            "onhw": sorted(run_mod.ONHW_STEPS),
        },
    }


def _packs_summary(cfg: Config) -> dict:
    """适配包最小投影（capabilities 用；市场索引走 ``/api/packs``）。"""
    try:
        return pkg_mod.status(cfg, include_market=False)
    except Exception as exc:                          # noqa: BLE001
        return {"roots": [], "install_root": "", "installed": [],
                "chips": [], "error": str(exc)}


def _profile_summary(cfg: Config) -> dict | None:
    """读出驾驶舱 profile（R7 / P1-4 的最小装配）。

    文件位置：``<ELAB_ROOT>/cockpit/profiles/*.yaml``。激活顺序：
    ``elab.host.yaml: profile`` 指定名 → ``web.yaml`` → 排序第一份；
    都没有时返回 None（前端回退到内置工作区集合）。

    只装配两件事 —— **右列工作区顺序**与**项目工具启停**：
    ``workspaces`` 为空 = 全部（内置三件套 + 工具页）；``tools.include``
    非空 = 只启用列出的工具，``tools.exclude`` 优先剔除。
    """
    d = Path(cfg.root) / "cockpit" / "profiles"
    if not d.is_dir():
        return None
    files = sorted(d.glob("*.yaml"))
    if not files:
        return None
    try:
        wanted = str(((cfg.host or {}).get("profile") or "")).strip()
    except ElabError:
        wanted = ""
    chosen = next((p for p in files if p.stem == wanted), None) if wanted else None
    if chosen is None:
        chosen = next((p for p in files if p.stem == "web"), files[0])
    try:
        data = yaml_mod.load_file(chosen) or {}
    except Exception:                                 # noqa: BLE001
        return None
    tools = data.get("tools") or {}
    return {
        "name": str(data.get("profile") or chosen.stem),
        "path": to_fwd(chosen),
        "available": [p.stem for p in files],
        "workspaces": [str(x) for x in (data.get("workspaces") or []) if str(x)],
        "tools": {"include": [str(x) for x in (tools.get("include") or []) if str(x)],
                  "exclude": [str(x) for x in (tools.get("exclude") or []) if str(x)]},
    }


def capabilities(cfg: Config, mgr: RunManager) -> dict:
    caps = serialport_mod.capabilities()
    ports, backend = ("[]", "")
    try:
        plist, backend = serialport_mod.list_ports()
        ports = [{"name": p.name, "kind": p.kind, "device": p.device, "desc": p.desc}
                 for p in plist]
    except Exception as exc:                          # noqa: BLE001
        ports = []
        backend = f"枚举失败：{exc}"
    host = cfg.host or {}
    return {
        "cockpit": {"version": COCKPIT_VERSION, "dist": to_fwd(DIST_DIR),
                    "dist_ready": (DIST_DIR / "index.html").exists(),
                    "sse_heartbeat_s": SSE_HEARTBEAT_S,
                    "proc_batch_s": PROC_BATCH_S},
        "schema_version": ev_mod.EVENT_SCHEMA_VERSION,
        "python": {"version": sys.version.split()[0], "executable": sys.executable},
        "root": to_fwd(cfg.root),
        "runs_dir": to_fwd(mgr.runs_dir),
        # ★ 适配包投影（骨架无芯片：此处为空即"通用工具链"形态）
        "packs": _packs_summary(cfg),
        "serial": {**caps, "backend": backend, "ports": ports,
                   "host_default": (host.get("serial") or {}).get("default", "auto"),
                   "host_baud": (host.get("serial") or {}).get("baud", 115200),
                   # 宿主/工程没写 line 时的默认（面板按此渲染"跟随配置"）
                   "host_line": serialport_mod.LineConfig().as_dict(),
                   # 写能力与读能力同后端（ctypes L1 也已支持写，见 SerialIO.for_write）。
                   # 单列一个字段是因为前端要据此决定输入框是否可写 —— 不该让它去
                   # 猜"available 是不是也包括写"。
                   "write_available": bool(caps["available"]),
                   # 常驻监视会话快照（active/port/baud）—— 界面据此画「打开/关闭监视」
                   "monitor": serialmon_mod.status(),
                   # TX/RX 的 console 日志（M3-b2）—— 界面据此提示"服务端存有 N 条历史"
                   "console": _console_info(cfg)},
        "active_runs": mgr.list_active(),
        "steps": {"all": list(run_mod.ALL_STEPS),
                  "default": list(run_mod.DEFAULT_STEPS),
                  "onhw": sorted(run_mod.ONHW_STEPS)},
        # 工具层自描述（§16）：标签/通道/档位由内核声明
        "meta": {"steps": STEP_META, "plans": KERNEL_PLANS,
                 "channels": ["build", "flash", "debug", "serial"],
                 "serial": SERIAL_META,
                 "debug": _debug_meta(cfg),
                 # 探针清单：面板据此渲染下拉（available = interface cfg 是否落地）
                 "probes": _probes_summary(cfg),
                 # R7 / P1-4：profile 决定右列工作区与启用工具（缺省 = 内置集合）
                 "profile": _profile_summary(cfg)},
    }


def _probes_summary(cfg: Config) -> dict:
    """``capabilities.meta.probes`` —— 本机可用探针的唯一事实源。

    ★ 只读 L0（`elab.host.yaml: probes.list`）；interface cfg 是否存在决定 available。
      面板不该自己猜「某个探针能不能上板」。
    """
    host = Host(cfg)
    scripts = host.openocd_scripts
    items = []
    for name, raw in (host.probes or {}).items():
        info = raw or {}
        icfg = str(info.get("interface_cfg") or "")
        available = True
        if icfg and scripts:
            available = (Path(scripts) / icfg).is_file()
        items.append({"name": name,
                      "backend": str(info.get("backend") or ""),
                      "interface_cfg": icfg,
                      "speed": info.get("speed"),
                      "available": available})
    return {"default": host.default_probe, "list": items}


def _console_info(cfg: Config) -> dict:
    """手写通道 console 日志的位置与条数。

    ★ 为什么值得进 capabilities：那里是界面判断"要不要提示/提示什么"的唯一来源。
      没有它，前端只能猜"服务端到底存了多少历史"。
    """
    try:
        clog = serialconsole_mod.ConsoleLog(serialconsole_mod.console_path_for(cfg))
        return {"path": to_fwd(clog.path), "count": clog.count(),
                "max_records": clog.max_records, "error": None}
    except Exception as exc:                          # noqa: BLE001
        return {"path": "", "count": 0, "max_records": 0, "error": str(exc)}


def _plan_preview(cfg: Config, qs: dict) -> dict:
    """``GET /api/plan`` —— 只读命令预览（M2「先看命令再执行」，§14.4）。

    ★ 为什么是 **GET** 而不是 POST：它**没有副作用**（不 spawn、不写盘、
      不发射事件），语义上是一个纯查询。做成 GET 的收益是可 `curl` 直接验、
      可被浏览器/代理按幂等处理；做成 POST 则会让人以为"点了就动手了"。

    ★ 命令**不在这里拼**：整份预览来自 ``run.preview()``，而它复用各模块
      自己的 dry-run/print 分支。服务端只负责把 query 参数翻译过去 ——
      任何"在这里顺手拼一条命令"都是给未来埋分叉。
    """
    project = (qs.get("project") or [""])[0]
    if not project:
        raise ElabError("缺少 project")
    steps = (qs.get("steps") or [None])[0]
    clean = (qs.get("clean") or ["0"])[0].lower() in ("1", "true", "yes", "on")
    jobs_raw = (qs.get("jobs") or [""])[0]
    jobs = int(jobs_raw) if jobs_raw.strip().isdigit() else None
    return run_mod.preview(cfg, project, steps=steps, clean=clean, jobs=jobs)


#: 会占用串口 / SWD 的步骤 —— 它们运行期间，手写通道必须让路。
#:   flash/debug_verify 起 openocd（占 SWD → N5 会连带锁住 VCP）；
#:   monitor 自己就握着串口。
_SERIAL_STEPS = frozenset({"flash", "debug_verify", "monitor"})


def _serial_blocker(mgr: "RunManager") -> dict | None:
    """有没有「会用到串口的闭环」正在跑？有就返回它，否则 None。

    ★ 为什么**提前**拦，而不是让写入自己失败：openocd 占着 SWD 时，VCP 会以
      ``ERROR_ACCESS_DENIED`` 打不开，用户只看到"端口被拒"，却不知道是自己刚点的
      闭环占着 —— 于是去拔插、去杀进程。在这里拦下就能**指名道姓**地说清楚。
    """
    for a in mgr.list_active():
        if not a.get("alive"):
            continue
        if set(a.get("steps") or []) & _SERIAL_STEPS:
            return a
    return None


# ── 闭环与监视：让位 / 回归（M2 §4.3.6）──────────────────────────
#: 引用计数：并行的 serial 相关 run 全部结束才回归一次（不重复开）。
_YIELD_LOCK = threading.Lock()
_YIELD = {"count": 0, "armed": False, "preexisting": False,
          "project": "", "policy": "open", "suspended": False}


def _resume_policy(cfg: Config, project: str, override=None) -> str:
    """回归策略：请求 > 项目 ``serial.resume_after_run`` > 默认 ``open``。"""
    pol = str(override or "")
    if not pol:
        proj = cfg.resolved_project(project) if project else {}
        ser = (proj.get("serial") or {}) if isinstance(proj, dict) else {}
        pol = str(ser.get("resume_after_run") or "open")
    return pol if pol in ("open", "restore", "off") else "open"


def _serial_yield_begin(cfg: Config, project: str, *, policy: str) -> None:
    """run 要串口：把正在开的监视挂起（保留环与 epoch），并记下回归策略。"""
    with _YIELD_LOCK:
        _YIELD["count"] += 1
        if _YIELD["armed"]:
            return
        mon = serialmon_mod.status()
        preexist = bool(mon.get("active"))
        _YIELD.update({"armed": True, "preexisting": preexist,
                       "project": project, "policy": policy, "suspended": False})
    if not preexist:
        return
    # ★ suspend 在锁外执行：它要 join 读线程（最多 2s），不能让别人等锁。
    res = serialmon_mod.suspend("闭环占用串口，监视已暂停", by_run=True)
    with _YIELD_LOCK:
        _YIELD["suspended"] = bool(res.get("ok"))


def _serial_yield_end(cfg: Config, log=print) -> None:
    """run 结束：引用计数归零时按策略回归（原无会话则新开）。"""
    with _YIELD_LOCK:
        if _YIELD["count"] > 0:
            _YIELD["count"] -= 1
        if _YIELD["count"] > 0 or not _YIELD["armed"]:
            return
        state = dict(_YIELD)
        _YIELD.update({"armed": False, "preexisting": False,
                       "project": "", "policy": "open", "suspended": False})
    if state["policy"] == "off":
        # 回到旧行为：结束即关（把让位中的会话真正关掉，不留 suspended）。
        if state["preexisting"] and state["suspended"]:
            serialmon_mod.close_session()
        return
    if state["preexisting"]:
        if state["suspended"]:
            res = serialmon_mod.resume()
            log(f"[cockpit] 串口监视回归：{'ok' if res.get('ok') else res.get('error')}")
        return
    if state["policy"] == "open" and state["project"]:
        res = serialmon_mod.open_session(cfg, state["project"], opened_by="auto")
        if not res.get("ok"):
            log(f"[cockpit] 自动重开监视失败：{res.get('error')}")


def _bool_or_none(value):
    """JSON body 里的三态布尔：``True`` / ``False`` / ``None``（未给）。"""
    if value is None:
        return None
    return bool(value)


def _qs_int(qs: dict, key: str, default: int | None = 0) -> int | None:
    raw = (qs.get(key) or [""])[0]
    if raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise ElabError(f"{key} 必须是整数：{raw!r}")


def _qs_dsess(qs: dict) -> str:
    """调试会话 id（**不是**聊天 sessionId；命名冲突见 §3.4）。"""
    return (qs.get("debug_session") or [""])[0]


# ══════════════════════════════════════════════════════════════════
#  调试会话管理（单会话 + 租约 + 互斥 + 审计）§7.7
# ══════════════════════════════════════════════════════════════════
def _debug_audit_path(cfg: Config) -> Path:
    return Path(cfg.root) / ".work" / "debug-audit.jsonl"


def _debug_audit_tail(cfg: Config, limit: int = 100) -> dict:
    """审计尾读（``?limit=``）；坏行跳过，只回最近 N 条。"""
    path = _debug_audit_path(cfg)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    out = []
    for line in lines[-limit:]:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return {"records": out, "count": len(out), "requested": limit,
            "path": to_fwd(path)}


def _debug_audit(cfg: Config, rec: dict) -> None:
    """审计留档（独立文件；**绝不**写进 state.json —— C14/C15/C28）。"""
    try:
        path = _debug_audit_path(cfg)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": time.time(), **rec}, ensure_ascii=False) + "\n")
        # 只保留最近 DEBUG_AUDIT_MAX 行（调试会话不是 run 归档，不无界增长）
        lines = path.read_text(encoding="utf-8").splitlines()
        if len(lines) > DEBUG_AUDIT_MAX:
            path.write_text("\n".join(lines[-DEBUG_AUDIT_MAX:]) + "\n", encoding="utf-8")
    except OSError:
        pass


class DebugManager:
    """调试会话登记簿 + 事件扇出（多会话，``debug.max_sessions`` 钳制 1–4）。

    语义（见执行计划_调试P3 §6）：
      - **一个目标一条会话**：同工程第二条直接 ``409 debug-target-busy``；
      - 租约只对 ``owner=agent`` 生效（到期自动关闭并**恢复运行**）；
      - 关闭必须恢复目标运行（C36 延伸）；
      - 与「会用到串口的闭环」「串口监视」互斥（N5，**全局**，不因多会话放松）；
      - ``debug_session`` 缺省时走**唯一**会话；多会话下缺省即 ``debug-session-required``。
    """

    def __init__(self, cfg: Config, runs: RunManager, *, log=print):
        self.cfg = cfg
        self.runs = runs
        self.log = log
        self._lock = threading.Lock()
        self._sessions: dict[str, dbgsess_mod.DebugSession] = {}
        self._allow_write: dict[str, bool] = {}
        self._open_seq = 0
        self._seq = 0
        self._subs: dict[queue.Queue, str] = {}      # queue -> 过滤用 debug_session（""=全量）
        self._lease_thread = threading.Thread(target=self._lease_loop, daemon=True,
                                              name="elab-debug-lease")
        self._lease_thread.start()

    # ── 查询 ────────────────────────────────────────────────────
    @property
    def max_sessions(self) -> int:
        """``elab.host.yaml: debug.max_sessions``（缺省 2，钳制 1–4）。"""
        try:
            raw = int(((self.cfg.host or {}).get("debug") or {}).get("max_sessions", 2))
        except (TypeError, ValueError):
            raw = 2
        return max(1, min(raw, 4))

    def list(self) -> list[dbgsess_mod.DebugSession]:
        with self._lock:
            return [s for s in self._sessions.values()
                    if s.state not in ("closed", "error")]

    def get(self, debug_session: str = "") -> dbgsess_mod.DebugSession | None:
        """按 id 取会话；``debug_session`` 为空时返回**唯一**会话（多会话时 None）。"""
        with self._lock:
            if debug_session:
                return self._sessions.get(debug_session)
            alive = [s for s in self._sessions.values() if s.state not in ("closed", "error")]
            return alive[0] if len(alive) == 1 else None

    def snapshot(self, debug_session: str = "") -> dict:
        """``{sessions:[摘要…], session: <默认会话快照|null>, session_id, max_sessions}``。

        顶层 ``session`` 保持 P2 的形态（单会话旧前端零改动）。
        """
        alive = self.list()
        rows = [s.snapshot() for s in alive]
        cur = self.get(debug_session) if debug_session else (alive[0] if alive else None)
        return {
            "sessions": rows,
            "session": cur.snapshot() if cur is not None else None,
            "session_id": cur.session_id if cur is not None else "",
            "max_sessions": self.max_sessions,
            "allow_write": (self._allow_write.get(cur.session_id, False)
                            if cur is not None else False),
        }

    def require(self, debug_session: str = "") -> dbgsess_mod.DebugSession:
        alive = self.list()
        if debug_session:
            sess = self.get(debug_session)
            if sess is None or sess.state in ("closed", "error"):
                raise dbgsess_mod.DebugError(
                    "debug-no-session", f"调试会话不存在或已结束：{debug_session}",
                    "重新 elab_debug_open 或读取 GET /api/debug/session 的 sessions 列表")
            return sess
        if not alive:
            raise dbgsess_mod.DebugError("debug-no-session", "当前没有调试会话",
                                         "先 elab_debug_open / 面板点「开始调试」")
        if len(alive) > 1:
            raise dbgsess_mod.DebugError(
                "debug-session-required",
                f"当前有 {len(alive)} 个调试会话，必须显式指定 debug_session",
                "从 GET /api/debug/session 的 sessions[].id 里选一个")
        return alive[0]

    # ── 事件 ────────────────────────────────────────────────────
    def subscribe(self, debug_session: str = "") -> queue.Queue:
        """订阅调试事件；带 ``debug_session`` 时只收该会话的事件（D7）。"""
        q: queue.Queue = queue.Queue(maxsize=500)
        with self._lock:
            self._subs[q] = str(debug_session or "")
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subs.pop(q, None)

    def _emit_for(self, session_id: str, topic: str, data: dict) -> None:
        with self._lock:
            self._seq += 1
            envelope = {
                "topic": topic,
                "seq": self._seq,
                "ts": time.time(),
                "session": session_id,
                "data": data,
            }
            subs = list(self._subs.items())
        for q, want in subs:
            if want and want != session_id:
                continue
            try:
                if q.full():
                    q.get_nowait()                 # 丢最旧（与 RunManager 同款有界背压）
                q.put_nowait(envelope)
            except (queue.Empty, queue.Full):
                pass

    def _emit(self, topic: str, data: dict) -> None:
        """兼容 P2 的 manager 级 emit：绑定到当前唯一会话（多会话时留空）。"""
        sess = self.get()
        self._emit_for(sess.session_id if sess else "", topic, data)

    # ── 互斥 ────────────────────────────────────────────────────
    def _blocker(self) -> dict | None:
        for a in self.runs.list_active():
            if not a.get("alive"):
                continue
            if set(a.get("steps") or []) & _SERIAL_STEPS:
                return {"code": "debug-busy",
                        "message": (f"闭环 {a.get('project')} 正在占用 SWD/串口"
                                    f"（steps={'/'.join(a.get('steps') or [])}）"),
                        "hint": "等闭环结束或先取消"}
        mon = serialmon_mod.status()
        if mon.get("active"):
            return {"code": "serial-monitor-active",
                    "message": f"串口监视正在占用 {mon.get('port')}",
                    "hint": "先在串口页签关闭监视"}
        return None

    # ── 打开 / 关闭 ──────────────────────────────────────────────
    def open(self, *, project: str, actor: str = "human", options: dict | None = None,
             lease_s: int = 0, allow_write: bool = False) -> dict:
        blocker = self._blocker()
        if blocker:
            raise dbgsess_mod.DebugError(blocker["code"], blocker["message"], blocker["hint"])
        with self._lock:
            alive = [s for s in self._sessions.values()
                     if s.state not in ("closed", "error")]
            # 同一工程 = 同一目标：一个 SWD 目标只能被一个 GDB 附着（D3）
            dup = next((s for s in alive if s.plan.name == project), None)
            if dup is not None:
                raise dbgsess_mod.DebugError(
                    "debug-target-busy",
                    f"目标 {project} 已有调试会话（{dup.session_id}，owner={dup.owner}）",
                    "同一块板/同一工程不能开第二会话；先关闭它，或选另一个工程")
            if len(alive) >= self.max_sessions:
                raise dbgsess_mod.DebugError(
                    "debug-session-limit",
                    f"已达会话上限（{self.max_sessions}，见 elab.host.yaml: debug.max_sessions）",
                    "关闭一个会话后再开")
            self._open_seq += 1
            open_seq = self._open_seq
            lease = (0 if actor != "agent" else
                     max(DEBUG_LEASE_MIN_S, min(int(lease_s or DEBUG_LEASE_DEFAULT_S),
                                                DEBUG_LEASE_MAX_S)))
            try:
                plan = plan_for(self.cfg, project)
            except Exception as exc:                   # noqa: BLE001
                raise dbgsess_mod.DebugError("debug-bad-request",
                                             f"工程不可用：{project!r}（{exc}）")
            sess = dbgsess_mod.DebugSession(
                plan, actor=actor, lease_s=lease, options=options or {},
                open_seq=open_seq, emit=self._emit, log=self.log)
            self._sessions[sess.session_id] = sess
            self._allow_write[sess.session_id] = bool(allow_write) and actor == "human"
        sid = sess.session_id
        sess.bind_emit(lambda topic, data, _sid=sid: self._emit_for(_sid, topic, data))
        _debug_audit(self.cfg, {"action": "open", "session": sid,
                                "project": project, "actor": actor,
                                "options": options or {}, "lease_s": lease})
        try:
            snap = sess.open()
        except dbgsess_mod.DebugError as exc:
            with self._lock:
                self._sessions.pop(sid, None)
                self._allow_write.pop(sid, None)
            sess.error = exc.as_dict()
            _debug_audit(self.cfg, {"action": "open-failed", "session": sid,
                                    "project": project, "code": exc.code,
                                    "message": exc.message})
            # 已有别的会话 + 探针类失败 → 明确告诉用户是**同一个探针**被占了，
            # 而不是让 openocd 的随机报错糊在脸上（D3）
            if self.list() and exc.code in ("debug-openocd-dead", "debug-timeout"):
                raise dbgsess_mod.DebugError(
                    "debug-port-hijacked",
                    f"探针被占用：{exc.message}",
                    "一个 CMSIS-DAP 探针同一时刻只能附着一颗芯片；换探针或先关另一会话")
            raise
        self.log(f"[debug] 会话 {sid} 打开：{project} ({actor})")
        return {"session": snap, "session_id": sid, "sessions": self.snapshot()["sessions"]}

    def close(self, *, debug_session: str = "", reason: str = "user-closed",
              resume: bool = True, actor: str = "human", force: bool = False) -> dict:
        try:
            sess = self.require(debug_session)
        except dbgsess_mod.DebugError:
            return {"closed": False, "reason": "no-session"}
        with self._lock:
            self._sessions.pop(sess.session_id, None)
            self._allow_write.pop(sess.session_id, None)
        res = sess.close(resume=resume, reason=reason)
        self.log(f"[debug] 会话 {sess.session_id} 关闭：{reason}（resumed={res['resumed']}）")
        _debug_audit(self.cfg, {"action": "close", "session": sess.session_id,
                                "reason": reason, "actor": actor, "resumed": res["resumed"]})
        return {**res, "session": sess.session_id}

    def drop(self, sess: dbgsess_mod.DebugSession) -> None:
        with self._lock:
            self._sessions.pop(sess.session_id, None)
            self._allow_write.pop(sess.session_id, None)

    # ── 写权限（按会话）──────────────────────────────────────────
    def require_write(self, *, confirm: bool, debug_session: str = "") -> None:
        sess = self.require(debug_session)
        if not self._allow_write.get(sess.session_id, False):
            raise dbgsess_mod.DebugError(
                "debug-write-denied", "会话未开启写权限",
                "以人类身份重开会话并传 allow_write=true")
        if not confirm:
            raise dbgsess_mod.DebugError("debug-bad-request", "写操作需要 confirm=true")

    def allow_write(self, debug_session: str = "") -> bool:
        sess = self.get(debug_session)
        return bool(self._allow_write.get(sess.session_id, False)) if sess else False

    # ── 租约回收 ────────────────────────────────────────────────
    def _lease_loop(self) -> None:
        while True:
            time.sleep(2.0)
            for sess in self.list():
                if sess.owner != "agent" or sess.lease_s <= 0:
                    continue
                idle = time.time() - sess.last_active
                if idle < sess.lease_s:
                    continue
                # 最后 30s 先发一条告警（面板显示"租约即将到期"）
                if idle >= sess.lease_s - 30 and not getattr(sess, "_lease_warned", False):
                    sess._lease_warned = True
                    self._emit_for(sess.session_id, "debug/output",
                                   {"stream": "log",
                                    "text": "租约将在 30s 后到期（agent 无活动）"})
                if idle >= sess.lease_s:
                    try:
                        self.close(debug_session=sess.session_id, reason="lease-expired",
                                   resume=True, actor="system")
                    except Exception as exc:             # noqa: BLE001
                        self.log(f"[debug] 租约回收失败：{exc!r}")


# ══════════════════════════════════════════════════════════════════
#  适配包操作（安装 / 卸载 / 校验 / 更新 / 启用）
# ══════════════════════════════════════════════════════════════════
class PkgJobManager:
    """包操作任务簿：**同一时间最多一个**包操作（全局一把锁）。

    ★ 为什么必须异步（202 + 轮询）：
      ``pkg.install()`` 里含 ``git clone``（无超时）/ 整树哈希 / 复制校验，
      同步塞进一条 HTTP 请求里，工具层代理的 ``fetch`` 没有超时，UI 就会
      "转圈到天荒地老"。异步 job 把长任务挪到独立线程，HTTP 立刻返回 202，
      前端 500ms 轮询 ``/api/pkg/job``。

    ★ 为什么"全局一个"：安装/卸载会改 ``packs/installed`` 与 ``active.json``，
      两个并发操作会让 discover 看到半成品目录。串行是最便宜的正确答案。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._job: dict | None = None
        self._thread: threading.Thread | None = None
        self._reload = None

    def bind(self, reload_cb) -> None:
        """注入"操作完成后重建 Config"的回调（make_server 里接线）。"""
        self._reload = reload_cb

    def busy(self) -> bool:
        with self._lock:
            return self._job is not None and self._job.get("state") in ("queued", "running")

    def current(self) -> dict | None:
        with self._lock:
            return dict(self._job) if self._job else None

    def snapshot(self, job_id: str = "") -> dict | None:
        with self._lock:
            if not self._job:
                return None
            if job_id and job_id != self._job["id"]:
                return None
            return dict(self._job)

    def start(self, action: str, name: str, work) -> dict:
        """登记并启动一个包操作；已有在跑 → 抛 ElabError（路由回 409）。"""
        with self._lock:
            if self._job is not None and self._job.get("state") in ("queued", "running"):
                raise ElabError(
                    f"已有包操作进行中（{self._job['action']} {self._job['name']}）—— 等它完成")
            job = {
                "id": time.strftime("%Y%m%d%H%M%S") + f"-{action}",
                "action": action,
                "name": name,
                "state": "queued",
                "stage": "排队",
                "log": [],
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "finished_at": None,
                "result": None,
                "error": None,
            }
            self._job = job
            t = threading.Thread(target=self._run, args=(job, work), daemon=True,
                                 name=f"elab-pkg-{action}")
            t.start()
            self._thread = t
            return dict(job)

    def _run(self, job: dict, work) -> None:
        def log(msg) -> None:
            with self._lock:
                lines = job["log"]
                lines.append(str(msg))
                if len(lines) > 200:
                    del lines[: len(lines) - 200]

        def stage(text: str) -> None:
            with self._lock:
                job["stage"] = str(text)

        try:
            with self._lock:
                job["state"] = "running"
            result = work(log, stage)
            with self._lock:
                job.update(state="ok", stage="完成", result=result,
                           finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"))
            if self._reload is not None:
                self._reload()
        except Exception as exc:                   # noqa: BLE001
            with self._lock:
                job.update(state="failed", stage="失败", error=str(exc),
                           finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"))


# ══════════════════════════════════════════════════════════════════
#  HTTP
# ══════════════════════════════════════════════════════════════════
class CockpitHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"elab-cockpit/{COCKPIT_VERSION}"

    # 由 make_server 注入
    cfg: Config
    mgr: RunManager
    dbg: DebugManager
    pkg_jobs: PkgJobManager
    dist: Path
    sse_sem: threading.Semaphore

    # ── 小工具 ──────────────────────────────────────────────────
    #: 已经写出过响应头。★ 必须有它：SSE 是"边写边推"的，一旦中途出错
    #: （客户端断开最常见），再去 send_response 会写第二份响应头，
    #: 抛出的次生异常会盖掉真正的根因（实测踩过：WinError 10053 被
    #: 一层 `end_headers()` 的 ConnectionAbortedError 覆盖，日志里看不出真正原因）。
    _sent_headers = False

    def handle_one_request(self):                      # noqa: N802
        """★ 每条请求都必须重置 ``_sent_headers``（keep-alive 下的命门）。

        一个 handler **实例**服务的是一整条**连接**，不是一条请求。HTTP/1.1
        默认 keep-alive，浏览器会在同一条连接上连发
        ``/`` → ``/assets/index.css`` → ``/assets/index.js``。

        ``_sent_headers`` 原来只在 ``_send()`` 里置 True、从不重置，于是**从第二条
        请求起** ``_send()`` 直接 return —— **一个字节都不写**。客户端既拿不到响应，
        也收不到错误，只能挂到超时。实测症状极具迷惑性：

        - `GET /` 200、`index.css` 200，唯独 `index.js` 永远 pending；
        - 页面 ``readyState`` 卡在 ``interactive``，``#root`` 永远 0 个子节点；
        - **控制台一个报错都没有**（因为根本没有 JS 执行过）；
        - 而 `curl`（每次新进程=新连接）与服务端日志**一切正常**。

        为什么测试没抓到：``_Client`` 与 curl 都是"一请求一连接"，从未复用连接。
        回归用例见 ``test_keep_alive_same_connection``。
        """
        self._sent_headers = False
        super().handle_one_request()

    def log_message(self, fmt, *args):                 # 静音默认 access log
        if self.server.verbose:                        # type: ignore[attr-defined]
            sys.stderr.write("[cockpit] " + (fmt % args) + "\n")

    def _send(self, code: int, body: bytes, ctype: str, *, extra: dict | None = None):
        if self._sent_headers:
            return
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self._sent_headers = True
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _err(self, code: int, msg: str):
        self._json({"error": msg}, code)

    _DEBUG_STATUS = {
        "debug-busy": 409, "debug-no-session": 409, "debug-target-running": 409,
        "debug-write-denied": 403, "debug-limit": 400, "debug-bad-request": 400,
        "debug-unavailable": 503, "debug-timeout": 504,
        "debug-rev-conflict": 409, "debug-svd-missing": 404,
        "debug-rtos-unavailable": 503, "debug-elf-missing": 409,
        "debug-gdb-missing": 503, "debug-openocd-dead": 500,
        "debug-port-hijacked": 409,
        # P3 多会话 / 源码页（执行计划 §6.1 / §5.2）
        "debug-target-busy": 409, "debug-session-limit": 409,
        "debug-session-required": 409, "debug-source-unavailable": 404,
    }

    def _debug_err(self, exc: dbgsess_mod.DebugError):
        self._json({"error": exc.message, **exc.as_dict()},
                   self._DEBUG_STATUS.get(exc.code, 500))

    def _fail(self, exc: Exception):
        """统一的失败出口。

        ``ConnectionError`` 家族（``BrokenPipeError`` / ``ConnectionResetError`` /
        ``ConnectionAbortedError``）**全部**是"客户端走了"，属于正常事件，
        不该记成服务端错误 —— 尤其是 ``--noproxy`` 的 curl + ``head`` 这种用法
        会在读够行数后直接关连接。只有真正的异常才回 500，且仅当响应头尚未发出。
        """
        if isinstance(exc, ConnectionError):
            return
        if self._sent_headers:
            sys.stderr.write(f"[cockpit] 响应已开始后出错（无法回错）：{exc!r}\n")
            return
        self._err(500, f"{type(exc).__name__}: {exc}")

    def _drain_body(self, n: int) -> None:
        """读掉 n 字节并丢弃（最多 ``MAX_DRAIN_BYTES``）。

        拒收大请求体时**必须先读掉**：客户端还在上传，服务端直接回错并关连接
        会让对端收到 RST，看到的是 ``ConnectionAbortedError`` 而不是那条
        "请求体太大"的说明 —— 用户永远不知道自己做错了什么。
        超过丢弃上限就不读了（这种量级已经不该出现在客户端代码里），直接关连接。
        """
        if n > MAX_DRAIN_BYTES:
            self.close_connection = True
            return
        left = n
        try:
            while left > 0:
                chunk = self.rfile.read(min(65536, left))
                if not chunk:
                    break
                left -= len(chunk)
        except OSError:
            self.close_connection = True

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        if n > MAX_BODY_BYTES:
            self._drain_body(n)
            self.close_connection = True
            raise ElabError(
                f"请求体 {n / 1048576:.1f} MB 超过上限 "
                f"{MAX_BODY_BYTES // 1048576} MB：大样本请用 capture 指向录制文件，"
                f"别把整段字节塞进请求体")
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ElabError("请求体不是合法 JSON")

    # ── 路由 ────────────────────────────────────────────────────
    def do_GET(self):                                  # noqa: N802
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)
        try:
            if path == "/api/capabilities":
                return self._json(capabilities(self.cfg, self.mgr))
            if path == "/api/projects":
                return self._json(project_cards(self.cfg))
            if path == "/api/packs":
                # 适配包 / 社区市场投影（内核事实源；工具层只渲染）。
                # ?market=0 可跳过市场索引读取（离线/慢网络）；?q= 只返回命中的市场条目。
                with_market = (qs.get("market") or ["1"])[0].lower() not in ("0", "false", "no")
                q = (qs.get("q") or [""])[0]
                return self._json(pkg_mod.status(self.cfg, include_market=with_market,
                                                 query=q))
            if path == "/api/pkg/job":
                # 包操作任务快照（202 后前端 500ms 轮询这里）。
                job_id = (qs.get("job") or [""])[0]
                snap = self.pkg_jobs.snapshot(job_id)
                if snap is None:
                    return self._err(404, "没有这个包操作任务（或已结束很久）")
                return self._json(snap)
            if path == "/api/runs":
                return self._json({"runs": ev_mod.list_runs(self.mgr.runs_dir),
                                   "active": self.mgr.list_active()})
            if path == "/api/runs/active":
                # ★ 轻量端点：**不扫盘**，只读进程内登记簿（+ 首行回读 run/start）。
                #   给「agent 在别的工程起跑了吗」这种 2s 轮询用。
                #   历史 run 的全量扫描（含 proc 文件尺寸）留给 /api/runs，
                #   那条只在切工程时调一次 —— 否则轮询开销随历史条数线性增长
                #   （实测 800 条 2 s > 2 s 轮询周期，会自己把自己拖满）。
                return self._json({"active": self.mgr.list_active()})
            if path == "/api/plan":
                return self._json(_plan_preview(self.cfg, qs))
            if path == "/api/debug/session":
                return self._json(self.dbg.snapshot(_qs_dsess(qs)))
            if path == "/api/debug/events":
                return self._sse_debug(_qs_dsess(qs))
            if path == "/api/debug/stack":
                thread = _qs_int(qs, "thread", None)
                return self._json(self.dbg.require(_qs_dsess(qs)).stack(thread=thread))
            if path == "/api/debug/variables":
                frame = _qs_int(qs, "frame", 0) or 0
                scope = (qs.get("scope") or ["locals"])[0]
                var = (qs.get("var") or [""])[0]
                return self._json(self.dbg.require(_qs_dsess(qs)).variables(
                    frame=frame, scope=scope, var=var))
            if path == "/api/debug/registers":
                group = (qs.get("group") or ["core"])[0]
                fmt = (qs.get("format") or ["natural"])[0]
                return self._json(self.dbg.require(
                    (qs.get("debug_session") or [""])[0]).registers(group=group, fmt=fmt))
            if path == "/api/debug/source":
                # 源码页签（P3-A）：路径受 plan.source_dir 沙箱约束
                file = (qs.get("file") or [""])[0]
                start = _qs_int(qs, "start", 1) or 1
                count = _qs_int(qs, "count", 120) or 120
                return self._json(self.dbg.require(
                    (qs.get("debug_session") or [""])[0]).source(
                        file=file, start=start, count=count))
            if path == "/api/debug/breakpoints":
                sess = self.dbg.require(_qs_dsess(qs))
                return self._json({"breakpoints": sess.breakpoints(),
                                   "rev": sess.store_rev(),
                                   "allow_write": self.dbg.allow_write(_qs_dsess(qs))})
            if path == "/api/debug/watch":
                return self._json(self.dbg.require(_qs_dsess(qs)).watch())
            if path == "/api/debug/audit":
                limit = _qs_int(qs, "limit", 100) or 100
                limit = max(1, min(limit, DEBUG_AUDIT_MAX))
                return self._json(_debug_audit_tail(self.cfg, limit))
            if path == "/api/debug/peripherals":
                p = (qs.get("path") or [""])[0]
                read = (qs.get("read") or ["0"])[0] in ("1", "true", "yes")
                return self._json(self.dbg.require(_qs_dsess(qs)).peripherals(path=p, read=read))
            if path == "/api/debug/rtos":
                return self._json(self.dbg.require(_qs_dsess(qs)).rtos())
            if path == "/api/debug/memory":
                addr = (qs.get("addr") or [""])[0]
                count = _qs_int(qs, "count", 256) or 256
                return self._json(self.dbg.require(_qs_dsess(qs)).memory(addr=addr, count=count))
            if path == "/api/debug/disasm":
                addr = (qs.get("addr") or [""])[0]
                count = _qs_int(qs, "count", 32) or 32
                mode = _qs_int(qs, "mode", 2) or 2
                return self._json(self.dbg.require(_qs_dsess(qs)).disasm(
                    addr=addr, count=count, mode=mode))
            if path == "/api/events":
                return self._sse(qs)
            if path == "/api/run-events":
                run_id = (qs.get("run") or [""])[0]
                after = int((qs.get("from") or ["0"])[0])
                return self._json({"events": ev_mod.read_run(self.mgr.runs_dir, run_id, after_seq=after)})
            if path == "/api/serial/console":
                # 手写通道的 TX/RX 历史（M3-b2）。**独立的** console 日志，
                # 不是 run 事件流（写通道不属于任何 run，见 ICD §3.5）。
                raw = (qs.get("limit") or [""])[0]
                try:
                    limit = int(raw) if raw else serialconsole_mod.DEFAULT_TAIL
                except ValueError:
                    raise ElabError(f"limit 必须是整数：{raw!r}")
                limit = max(1, min(limit, serialconsole_mod.MAX_RECORDS))
                clog = serialconsole_mod.ConsoleLog(serialconsole_mod.console_path_for(self.cfg))
                recs = clog.tail(limit)
                return self._json({"records": recs, "count": clog.count(),
                                   "requested": limit, "path": to_fwd(clog.path)})
            if path == "/api/serial/widgets":
                # 工程级发送组件（M1）：只读投影（rev / widgets / warnings）。
                # 坏文件不阻塞串口功能：文件级错误在 error，单组件问题在 warnings。
                project = (qs.get("project") or [""])[0]
                if not project:
                    raise ElabError("缺少 project")
                return self._json(serialwidgets_mod.load(self.cfg, project))
            if path == "/api/serial/widget/job":
                # 不带 id = 当前未结束的任务（面板刷新/agent 找回在跑的那一个）。
                job_id = (qs.get("id") or [""])[0]
                snap = serialwidgets_mod.job_status(job_id)
                if snap is None:
                    return self._err(404, ("没有正在进行的组件任务" if not job_id
                                           else f"没有这个组件任务（或已过期）：{job_id!r}"))
                return self._json(snap)
            if path == "/api/serial/monitor/bytes":
                # P1 字节真值：带方向/时间/序号的原始批次（data_b64）。
                # ?after=批次序号 &dir=all|rx|tx &limit=最多返回几个批次
                raw = (qs.get("after") or ["0"])[0]
                try:
                    after = int(raw)
                except ValueError:
                    raise ElabError(f"after 必须是整数：{raw!r}")
                direction = (qs.get("dir") or ["all"])[0]
                if direction not in ("all", "rx", "tx"):
                    raise ElabError(f"dir 必须是 all/rx/tx：{direction!r}")
                raw_lim = (qs.get("limit") or ["0"])[0]
                try:
                    limit = int(raw_lim) if raw_lim else 0
                except ValueError:
                    raise ElabError(f"limit 必须是整数：{raw_lim!r}")
                return self._json(serialmon_mod.tail_bytes(
                    after, direction=direction, limit=limit))
            if path == "/api/serial/monitor/decoded":
                # 会话级共享解码帧（P3.5）：agent 与面板波页读**同一份**。
                # 解码本身在读线程里增量完成（RX 批次入环时），这里只做增量读回。
                raw = (qs.get("after") or ["0"])[0]
                try:
                    after = int(raw)
                except ValueError:
                    raise ElabError(f"after 必须是整数：{raw!r}")
                return self._json(serialmon_mod.tail_decoded(after))
            if path == "/api/serial/control":
                # 复位预设清单 + 当前 DTR/RTS 已知状态 + 序列进度（M1）。
                project = (qs.get("project") or [""])[0]
                return self._json(serialcontrol_mod.state(self.cfg, project))
            if path == "/api/serial/log-profiles":
                # 可用日志 profile 清单（包 + 工程覆盖；M6）。空列表不是错误：
                # 说明这颗芯片/工程还没人提供诊断数据。
                project = (qs.get("project") or [""])[0]
                try:
                    profiles = ld.load_profiles(self.cfg, project)
                except ValueError as exc:
                    raise ElabError(str(exc))
                return self._json({"profiles": profiles})
            if path == "/api/serial/frames":
                # 帧协议配置（M5）：读全部 profile + rev + warnings。
                project = (qs.get("project") or [""])[0]
                if not project:
                    raise ElabError("frames 需要 project 参数")
                return self._json(sf.load(self.cfg, project))
            if path == "/api/serial/frames/templates":
                # 只读模板库（P1）：协议数据，不是可执行代码。
                return self._json(sf.list_templates(self.cfg))
            if path == "/api/serial/monitor/stats":
                # P3.1 帧级健康度：帧率 / 到达间隔 / 错误分类 / 每 variant 计数。
                raw_w = (qs.get("window_s") or ["10"])[0]
                try:
                    window_s = float(raw_w)
                except ValueError:
                    raise ElabError(f"window_s 必须是数字：{raw_w!r}")
                return self._json(serialmon_mod.frame_stats(window_s))
            if path == "/api/serial/monitor/issues":
                # 结构化 issue 增量读回（panic / hardfault / 复位；M6）。
                raw = (qs.get("after") or ["0"])[0]
                try:
                    after = int(raw)
                except ValueError:
                    raise ElabError(f"after 必须是整数：{raw!r}")
                return self._json(serialmon_mod.tail_issues(after))
            if path == "/api/serial/monitor/poll":
                # 盘点 #4：串口轮询合并端点 —— 一次带回四路增量
                # （行 tail + 字节批次 + 结构化 issue + 共享解码帧）。
                # ★ 动机：前端每 500ms 并发 2~4 个请求，HTTP/1.1 同域只有
                #   6 个连接，稳态就占掉 2~4 个；合并后 1 个，且四路数据
                #   天然同拍（同一时刻的快照），前端不再需要自己拼时序。
                #   每路游标独立传（line/byte/issue/dec），缺省 0 = 从头追。
                def _cur(name: str) -> int:
                    raw = (qs.get(name) or [""])[0]
                    if not raw:
                        return 0
                    try:
                        return int(raw)
                    except ValueError:
                        raise ElabError(f"{name} 必须是整数：{raw!r}")
                direction = (qs.get("dir") or ["all"])[0]
                if direction not in ("all", "rx", "tx"):
                    raise ElabError(f"dir 必须是 all/rx/tx：{direction!r}")
                lt = serialmon_mod.tail(_cur("line"))
                out: dict = {"line": lt,
                             "bytes": serialmon_mod.tail_bytes(
                                 _cur("byte"), direction=direction, limit=0)}
                # 与旧前端逻辑同规则：profile / decoder 开着才拉对应增量
                if (lt.get("issues") or {}).get("profile"):
                    out["issues"] = serialmon_mod.tail_issues(_cur("issue"))
                decoder = (lt.get("decode") or {}).get("decoder") or ""
                if decoder:
                    out["decoded"] = serialmon_mod.tail_decoded(_cur("dec"))
                return self._json(out)
            if path == "/api/serial/monitor":
                # 常驻监视会话的增量读回（tail）。「after」= 浏览器已收到的最大 seq。
                raw = (qs.get("after") or ["0"])[0]
                try:
                    after = int(raw)
                except ValueError:
                    raise ElabError(f"after 必须是整数：{raw!r}")
                return self._json(serialmon_mod.tail(after))
            if path.startswith("/api/"):
                return self._err(404, f"未知 API：{path}")
            return self._static(path)
        except dbgsess_mod.DebugError as exc:
            return self._debug_err(exc)
        except ElabError as exc:
            return self._err(400, str(exc))
        except Exception as exc:                       # noqa: BLE001
            return self._fail(exc)

    def do_HEAD(self):                                 # noqa: N802
        return self.do_GET()

    def do_POST(self):                                 # noqa: N802
        u = urlparse(self.path)
        try:
            if u.path == "/api/debug/session":
                body = self._body()
                return self._json(self.dbg.open(
                    project=str(body.get("project") or ""),
                    actor=str(body.get("actor") or "human"),
                    options=body.get("options") or {},
                    lease_s=int(body.get("lease_s") or 0),
                    allow_write=bool(body.get("allow_write")),
                ))
            if u.path == "/api/debug/control":
                body = self._body()
                return self._json(self.dbg.require(
                    str(body.get("debug_session") or "")).control(
                    str(body.get("action") or ""),
                    addr=str(body.get("addr") or ""),
                    confirm=bool(body.get("confirm")),
                    file=str(body.get("file") or ""),
                    line=int(body.get("line") or 0),
                ))
            if u.path == "/api/debug/registers":
                # 按组批量写（§7.2）：整批校验 → 逐项 set → 一条审计
                body = self._body()
                dsid = str(body.get("debug_session") or "")
                self.dbg.require_write(confirm=bool(body.get("confirm")), debug_session=dsid)
                sess = self.dbg.require(dsid)
                out = sess.write_registers(items=body.get("items") or [])
                _debug_audit(self.cfg, {"action": "write", "target": "register-group",
                                        "session": sess.session_id,
                                        "project": sess.plan.name,
                                        "actor": sess.owner,
                                        "items": [{"name": a["name"], "before": a["before"],
                                                   "after": a["after"]}
                                                  for a in out.get("applied") or []],
                                        "failed": out.get("failed")})
                return self._json(out)
            if u.path == "/api/debug/breakpoints":
                body = self._body()
                op = str(body.get("op") or "list")
                dsid = str(body.get("debug_session") or "")
                sess = self.dbg.require(dsid)
                rev = (None if body.get("rev") is None else int(body.get("rev")))
                if op == "add":
                    out = sess.breakpoint_add(
                        kind=str(body.get("kind") or "func"),
                        location=str(body.get("location") or ""),
                        condition=str(body.get("condition") or ""),
                        hardware=bool(body.get("hardware")),
                        temporary=bool(body.get("temporary")),
                        rev=rev,
                    )
                    _debug_audit(self.cfg, {"action": "breakpoint-add",
                                            "session": sess.session_id,
                                            "project": sess.plan.name,
                                            "actor": sess.owner,
                                            "location": body.get("location") or ""})
                    return self._json(out)
                if op == "update":
                    out = sess.breakpoint_update(
                        bp_id=str(body.get("id") or ""),
                        condition=(None if "condition" not in body
                                   else str(body.get("condition") or "")),
                        enabled=(None if "enabled" not in body else bool(body.get("enabled"))),
                        rev=rev,
                    )
                    return self._json(out)
                if op == "toggle":
                    return self._json(sess.breakpoint_toggle(
                        bp_id=str(body.get("id") or ""), rev=rev))
                if op == "remove":
                    out = sess.breakpoint_remove(bp_id=str(body.get("id") or ""), rev=rev)
                    _debug_audit(self.cfg, {"action": "breakpoint-remove",
                                            "session": sess.session_id,
                                            "project": sess.plan.name,
                                            "actor": sess.owner,
                                            "id": body.get("id") or ""})
                    return self._json(out)
                if op == "list":
                    return self._json({"breakpoints": sess.breakpoints(),
                                       "rev": sess.store_rev(),
                                       "allow_write": self.dbg.allow_write(dsid)})
                raise ElabError(f"未知断点操作：{op!r}")
            if u.path == "/api/debug/watch":
                body = self._body()
                op = str(body.get("op") or "list")
                sess = self.dbg.require(str(body.get("debug_session") or ""))
                rev = (None if body.get("rev") is None else int(body.get("rev")))
                if op == "add":
                    return self._json(sess.watch_add(
                        expr=str(body.get("expr") or ""),
                        fmt=str(body.get("format") or "natural"), rev=rev))
                if op == "update":
                    return self._json(sess.watch_update(
                        wid=str(body.get("id") or ""),
                        expr=(None if "expr" not in body else str(body.get("expr") or "")),
                        fmt=(None if "format" not in body else str(body.get("format") or "")),
                        rev=rev))
                if op == "remove":
                    return self._json(sess.watch_remove(
                        wid=str(body.get("id") or ""), rev=rev))
                if op == "list":
                    return self._json(sess.watch())
                raise ElabError(f"未知监视操作：{op!r}")
            if u.path == "/api/debug/evaluate":
                body = self._body()
                return self._json(self.dbg.require(
                    str(body.get("debug_session") or "")).evaluate(
                    expr=str(body.get("expr") or ""),
                    frame=(None if body.get("frame") is None else int(body.get("frame"))),
                ))
            if u.path == "/api/debug/write":
                body = self._body()
                target = str(body.get("target") or "")
                dsid = str(body.get("debug_session") or "")
                self.dbg.require_write(confirm=bool(body.get("confirm")), debug_session=dsid)
                sess = self.dbg.require(dsid)
                if target == "memory":
                    out = sess.write_memory(
                        addr=str(body.get("addr") or ""),
                        value=str(body.get("value") or ""))
                    _debug_audit(self.cfg, {"action": "write", "target": "memory",
                                            "session": sess.session_id,
                                            "project": sess.plan.name,
                                            "actor": sess.owner,
                                            "addr": body.get("addr") or "",
                                            "value": body.get("value") or ""})
                    return self._json(out)
                if target == "register":
                    out = sess.write_register(
                        name=str(body.get("name") or ""),
                        value=str(body.get("value") or ""))
                    _debug_audit(self.cfg, {"action": "write", "target": "register",
                                            "session": sess.session_id,
                                            "project": sess.plan.name,
                                            "actor": sess.owner,
                                            "name": body.get("name") or "",
                                            "value": body.get("value") or ""})
                    return self._json(out)
                raise ElabError(f"未知写目标：{target!r}")
            if u.path == "/api/runs/prune":
                # 盘点 #11：历史 run 清理入口（CLI `elab runs prune` 同一份实现）。
                # ★ 与 CLI 同源（ev_mod.prune_runs），不存在"面板删的和 CLI 删的
                #   规则不一样"。running 的 run 永不删（函数内保护）。
                body = self._body()
                # 缺省与 CLI 一致（keep=50 / days=30）；显式 days=0 关时间闸
                keep = 50 if body.get("keep") is None else int(body["keep"])
                days = 30.0 if body.get("days") is None else float(body["days"])
                return self._json(ev_mod.prune_runs(
                    self.mgr.runs_dir, keep=keep, days=days,
                    dry_run=bool(body.get("dry_run"))), 200)
            if u.path == "/api/run":
                body = self._body()
                project = body.get("project") or ""
                if not project:
                    return self._err(400, "缺少 project")
                # ★ 安装/卸载适配包期间**冻结闭环**：包操作会改芯片数据与启用状态，
                #   此刻起 run 会读到半成品配置。与包操作里的反向守卫成对出现。
                busy_job = self.pkg_jobs.current()
                if (busy_job is not None
                        and busy_job.get("state") in ("queued", "running")
                        # 市场遍历只写 .work 缓存，不改芯片数据 → 不冻结闭环
                        and busy_job.get("action") != "market"):
                    return self._err(409, (
                        f"适配包操作进行中（{busy_job.get('action')} {busy_job.get('name')}，"
                        f"阶段：{busy_job.get('stage')}）—— 闭环已冻结，等它完成后重试"
                        f"（约束：安装期间冻结闭环）"))
                # ★ 监视会话 ↔ 闭环（N5 的驾驶舱侧）：不再让用户手动关监视 ——
                #   改为**自动让位 + run 结束回归**（M2 §4.3.6）。互斥仍然成立：
                #   会话先挂起并释放 IO，run 拿到口；结束后按策略恢复。
                want_steps = set(body.get("steps") or run_mod.DEFAULT_STEPS)
                yielded = bool(want_steps & _SERIAL_STEPS)
                if yielded:
                    policy = _resume_policy(self.cfg, project,
                                            body.get("resume_after_run"))
                    _serial_yield_begin(self.cfg, project, policy=policy)
                try:
                    res = self.mgr.spawn(
                        project=project,
                        steps=body.get("steps"),
                        clean=bool(body.get("clean")),
                        jobs=body.get("jobs"),
                        verbose=bool(body.get("verbose")),
                        actor=body.get("actor") or "human",
                        on_finish=((lambda ar, rc: _serial_yield_end(self.cfg))
                                   if yielded else None),
                    )
                except Exception:
                    if yielded:
                        _serial_yield_end(self.cfg)   # 起不来就立刻回归
                    raise
                if yielded:
                    res["serial_yielded"] = True
                return self._json(res, 202)
            if u.path == "/api/cancel":
                body = self._body()
                run_id = body.get("run") or ""
                if not run_id:
                    return self._err(400, "缺少 run")
                res = self.mgr.cancel(run_id, reason=body.get("reason") or "用户取消")
                return self._json(res, 200 if res.get("ok") else 409)
            if u.path.startswith("/api/pkg/"):
                # 适配包写动作：install / remove / verify / update / activate。
                # ★ 只收**包名**（不收路径/URL/哈希）：来源与 sha256 由内核自己解析。
                action = u.path[len("/api/pkg/"):]
                if action not in ("install", "remove", "verify", "update",
                                  "activate", "market"):
                    return self._err(404, f"未知包操作：{action}")
                return self._pkg(action, self._body())
            if u.path == "/api/serial/widgets":
                # 组件增删（M1）：与 agent/人共用一套 rev 乐观锁。
                # ★ 人的修改永远优先：rev 不匹配 → 409 + 最新内容，写者必须重读。
                body = self._body()
                action = str(body.get("action") or "")
                project = str(body.get("project") or "")
                if not project:
                    return self._err(400, "缺少 project")
                if action not in ("save", "delete"):
                    return self._err(400, f"action 必须是 save/delete：{action!r}")
                try:
                    rev = int(body.get("rev"))
                except (TypeError, ValueError):
                    return self._err(400, f"rev 必须是整数：{body.get('rev')!r}")
                if action == "save":
                    widget = body.get("widget")
                    if not isinstance(widget, dict):
                        return self._err(400, "save 需要 widget 对象")
                    res = serialwidgets_mod.save(self.cfg, project, widget, rev)
                else:
                    wid = str(body.get("id") or "")
                    if not wid:
                        return self._err(400, "delete 需要 id")
                    res = serialwidgets_mod.delete(self.cfg, project, wid, rev)
                return self._json(res, 409 if res.get("conflict") else 200)
            if u.path == "/api/serial/widget/run":
                # 执行一个组件：dry_run 只渲染（不占口），否则走现有写穿/往返通道。
                body = self._body()
                project = str(body.get("project") or "")
                wid = str(body.get("id") or "")
                if not project or not wid:
                    return self._err(400, "缺少 project 或 id")
                dry = bool(body.get("dry_run"))
                if not dry:
                    busy = _serial_blocker(self.mgr)
                    if busy:
                        return self._err(409, (
                            f"有闭环正在跑（run={busy.get('run')}，"
                            f"步骤 {'/'.join(busy.get('steps') or [])}）—— "
                            f"它要用串口/SWD（约束 N5）。等它跑完，或先取消它。"))
                res = serialwidgets_mod.run(
                    self.cfg, project, wid, body.get("params"),
                    dry_run=dry, repeat=bool(body.get("repeat")),
                    confirm=bool(body.get("confirm")),
                    actor=str(body.get("actor") or "human"),
                    journal=serialconsole_mod.journal_for(self.cfg, project=project))
                if res.get("stage") == "busy":
                    return self._err(409, res.get("error") or "已有组件任务在跑")
                if res.get("stage") == "validate":
                    return self._err(400, res.get("error") or "组件请求不合法")
                # "执行了但写失败"沿用 200 + ok:false（与 POST /api/serial 同一条纪律）
                return self._json(res, 200)
            if u.path == "/api/serial/widget/cancel":
                body = self._body()
                job_id = str(body.get("id") or "")
                if not job_id:
                    return self._err(400, "缺少 id")
                res = serialwidgets_mod.cancel(job_id)
                return self._json(res, 200 if res.get("ok") else 404)
            if u.path == "/api/serial/widget/pause":
                # 暂停/恢复（M2）：只改标志位。人的暂停优先于 agent ——
                # agent 的周期任务被人按停后，必须人再按恢复（不自动续跑）。
                body = self._body()
                job_id = str(body.get("id") or "")
                if not job_id:
                    return self._err(400, "缺少 id")
                paused = bool(body.get("paused", True))
                res = serialwidgets_mod.set_paused(job_id, paused)
                return self._json(res, 200 if res.get("ok") else 404)
            if u.path == "/api/serial/loop":
                # 发送框的「定时发送」：自由帧 → 内核瞬态任务（不落盘）。
                # ★ 与组件周期共用同一个任务引擎/单任务锁：两条发送入口
                #   不允许出现两套周期语义（固定节拍、skipped、暂停/取消、10min 上限）。
                body = self._body()
                project = str(body.get("project") or "")
                data = body.get("data")
                if not isinstance(data, str) or not data.strip():
                    return self._err(400, "缺少 data（要发送的内容）")
                dry = bool(body.get("dry_run"))
                if not dry:
                    busy = _serial_blocker(self.mgr)
                    if busy:
                        return self._err(409, (
                            f"有闭环正在跑（run={busy.get('run')}，"
                            f"步骤 {'/'.join(busy.get('steps') or [])}）—— "
                            f"它要用串口/SWD（约束 N5）。等它跑完，或先取消它。"))
                res = serialwidgets_mod.run_raw(
                    self.cfg, project, data,
                    newline=bool(body.get("newline", True)),
                    hex_=bool(body.get("hex")), format=body.get("format"),
                    eol=body.get("eol"), encoding=body.get("encoding"),
                    interval_ms=body.get("interval_ms"),
                    count=body.get("count") or 0,
                    actor=str(body.get("actor") or "human"),
                    journal=serialconsole_mod.journal_for(self.cfg, project=project),
                    dry_run=dry)
                if res.get("stage") == "busy":
                    return self._err(409, res.get("error") or "已有周期任务在跑")
                if res.get("stage") == "validate":
                    return self._err(400, res.get("error") or "定时发送请求不合法")
                return self._json(res, 200)
            if u.path == "/api/serial":
                # 手写通道（M3-b）：写一条出去、收一小段回显，一次请求内闭环。
                # ★ 返回 **200 + ok:false**（而不是 5xx）承载"执行了但没成功"：
                #   前端要渲染的字段在两种结果下完全一样（port/baud/error），
                #   用 5xx 只会让它走异常分支、丢掉这些结构化信息。
                #   400 只留给"请求本身不合法"，409 留给"串口正被闭环占着"。
                body = self._body()
                data = body.get("data")
                if not isinstance(data, str) or not data.strip():
                    return self._err(400, "缺少 data（要发送的内容）")
                project = body.get("project") or ""
                fmt = body.get("format")
                eol = body.get("eol")
                encoding = body.get("encoding")
                # ★ 预览与发送共用 resolve_payload：前端只看结果，不在客户端
                #   自己编码 —— 否则"预览的字节"和"真发出去的字节"会漂移。
                #   预览必须在 blocker 之前：它不碰串口，闭环跑着也能先编辑。
                payload, rfmt, reol, perr = serialterm_mod.resolve_payload(
                    data, newline=bool(body.get("newline", True)),
                    hex_=bool(body.get("hex")), format=fmt, eol=eol,
                    encoding=encoding)
                if body.get("dry_run"):
                    if perr:
                        return self._json({"ok": False, "dry_run": True,
                                           "error": perr, "format": rfmt,
                                           "bytes": 0, "preview_hex": ""}, 200)
                    return self._json({
                        "ok": True, "dry_run": True, "bytes": len(payload),
                        "preview_hex": payload.hex(" ").upper(),
                        "format": rfmt, "eol_key": reol,
                        "eol": serialterm_mod.EOLS.get(reol, b"").decode("ascii"),
                    }, 200)
                busy = _serial_blocker(self.mgr)
                if busy:
                    return self._err(409, (
                        f"有闭环正在跑（run={busy.get('run')}，"
                        f"步骤 {'/'.join(busy.get('steps') or [])}）—— 它要用串口/SWD，"
                        f"手写通道已在让路（约束 N5）。等它跑完，或先取消它。"))
                # ★ 监视会话开着 → 写通道路由**进会话**（同一个口直接 write，
                #   不重开口 —— 不破坏 N5）。回显不再由本请求带回：读线程会把它
                #   送进实时流。TX 照旧落 console 留档（"我敲过这一行"不因失败消失）。
                if perr:
                    return self._json({"ok": False, "error": perr, "port": "",
                                       "baud": 0, "written": 0, "echoed": [],
                                       "via": "monitor"}, 200)
                n = serialmon_mod.write_through(payload)
                if n is not None:
                    via_res = {"ok": n == len(payload), "via": "monitor",
                               "written": n, "payload_bytes": len(payload),
                               "format": rfmt,
                               "eol": serialterm_mod.EOLS.get(
                                   reol, b"").decode("ascii"),
                               "echoed": [], "error": None if n == len(payload)
                               else "只写出部分字节（口可能已失效，试试关闭重开监视）"}
                    st_ok = serialmon_mod.status()
                    via_res.update({"port": st_ok.get("port") or "",
                                    "baud": st_ok.get("baud") or 0,
                                    "line_text": st_ok.get("line_text") or "",
                                    "line": st_ok.get("line")})
                    try:
                        # TX 照旧落 console 留档（同一条 journal_for 路径，带 project）
                        serialconsole_mod.journal_for(self.cfg, project=project)({
                            "dir": "tx", "text": data, "ok": via_res["ok"],
                            "written": n, "payload_bytes": len(payload),
                            "via": "monitor", "format": rfmt,
                            "port": via_res["port"], "baud": via_res["baud"],
                            "error": via_res["error"]})
                    except Exception as exc:               # noqa: BLE001
                        self.log_message("serialmon journal: %s", exc)
                    return self._json(via_res, 200)
                res = serialterm_mod.roundtrip(
                    self.cfg,
                    project,
                    data=data,
                    port=body.get("port") or "",
                    baud=body.get("baud") or 0,
                    read_ms=body.get("read_ms") or serialterm_mod.DEFAULT_READ_MS,
                    newline=bool(body.get("newline", True)),
                    hex_=bool(body.get("hex")),
                    format=fmt, eol=eol, encoding=encoding,
                    line=body.get("line"),
                    transport=str(body.get("transport") or ""),
                    net=body.get("net"),
                    # ★ 落盘：写通道**不属于任何 run**，所以落到独立的 console 日志，
                    #   绝不写进 run 的 .jsonl（那会破坏单写者模型，约束 C17）。
                    journal=serialconsole_mod.journal_for(self.cfg, project=project),
                )
                return self._json(res, 200)
            if u.path == "/api/serial/control":
                # DTR/RTS：{dtr?, rts?} 立即生效；{preset} 跑 pack.yaml 里的序列；
                # {cancel: true} 取消序列。物理线路动作 —— 不进字节环、不算 TX。
                body = self._body()
                if body.get("cancel"):
                    return self._json(serialcontrol_mod.cancel(), 200)
                # 动线会打断烧录/调试时序（尤其 RTS/DTR 参与 BOOT 同步）—— 先拦。
                busy = _serial_blocker(self.mgr)
                if busy:
                    return self._err(409, (
                        f"有闭环正在跑（run={busy.get('run')}）—— "
                        f"复位/动 DTR/RTS 会打断烧录或调试，等它跑完或先取消它。"))
                if body.get("preset"):
                    res = serialcontrol_mod.run_preset(
                        self.cfg, str(body.get("project") or ""),
                        str(body["preset"]), port=str(body.get("port") or ""),
                        line=body.get("line"),
                        actor=str(body.get("actor") or "human"))
                    return self._json(res, 200 if res.get("ok") else 400)
                res = serialcontrol_mod.apply(
                    self.cfg, str(body.get("project") or ""),
                    dtr=_bool_or_none(body.get("dtr")),
                    rts=_bool_or_none(body.get("rts")),
                    port=str(body.get("port") or ""), line=body.get("line"),
                    actor=str(body.get("actor") or "human"))
                return self._json(res, 200 if res.get("ok") else 400)
            if u.path == "/api/serial/monitor":
                # 常驻串口监视（「打开监视 / 关闭监视 / 清空 / 暂停」）。
                # open 前先查闭环占用：与手写通道同款 409 指名道姓 ——
                # 不让用户对着 ERROR_ACCESS_DENIED 拔插。
                body = self._body()
                action = body.get("action") or ""
                if action == "open":
                    busy = _serial_blocker(self.mgr)
                    if busy:
                        return self._err(409, (
                            f"有闭环正在跑（run={busy.get('run')}，"
                            f"步骤 {'/'.join(busy.get('steps') or [])}）—— "
                            f"它要用串口/SWD（约束 N5）。等它跑完，或先取消它。"))
                    try:
                        lease_s = float(body.get("lease_s") or 0)
                    except (TypeError, ValueError):
                        raise ElabError(f"lease_s 必须是数字：{body.get('lease_s')!r}")
                    res = serialmon_mod.open_session(
                        self.cfg, body.get("project") or "",
                        port=body.get("port") or "",
                        baud=body.get("baud") or 0,
                        opened_by=str(body.get("actor") or "human"),
                        lease_s=lease_s,
                        allow_agent_write=bool(body.get("allow_agent_write")),
                        decoder=str(body.get("decoder") or ""),
                        line=body.get("line"),
                        reconnect=body.get("reconnect"),
                        log_profile=str(body.get("log_profile") or ""),
                        transport=str(body.get("transport") or ""),
                        net=body.get("net"))
                    return self._json(res, 200)
                if action == "close":
                    return self._json(serialmon_mod.close_session(), 200)
                if action == "decoder":
                    # 会话级解码器（P3.5）：agent 选定 → 人面板波页自动同图。
                    # '' = 关闭共享解码（面板回退到本地无状态解码）。
                    snap = serialmon_mod.status()
                    res = serialmon_mod.set_decoder(
                        str(body.get("decoder") or ""),
                        actor=str(body.get("actor") or "human"),
                        cfg=self.cfg,
                        project=str(body.get("project") or snap.get("project") or ""))
                    return self._json(res, 200 if res.get("ok") else 400)
                if action == "clear":
                    return self._json(serialmon_mod.clear(), 200)
                if action == "pause":
                    return self._json(serialmon_mod.set_paused(True), 200)
                if action == "resume":
                    return self._json(serialmon_mod.set_paused(False), 200)
                if action == "restore":
                    # M2：闭环让位后手动「立即恢复」（不必等 run 结束/自动回归）
                    return self._json(serialmon_mod.resume(), 200)
                if action == "log_profile":
                    # M6：会话级日志诊断 profile（'' = 关闭诊断）。
                    snap = serialmon_mod.status()
                    res = serialmon_mod.set_log_profile(
                        self.cfg, str(body.get("project") or snap.get("project") or ""),
                        str(body.get("profile") or ""))
                    return self._json(res, 200 if res.get("ok") else 400)
                raise ElabError(
                    f"action 必须是 open/close/decoder/clear/pause/resume/restore/"
                    f"log_profile：{action!r}")
            if u.path == "/api/serial/frames":
                # 保存 / 删除一个 profile。rev 不匹配 → 409（不覆盖别人的改动）。
                body = self._body()
                project = str(body.get("project") or "")
                if not project:
                    raise ElabError("frames 需要 project")
                try:
                    rev = int(body.get("rev") or 0)
                except (TypeError, ValueError):
                    raise ElabError("rev 必须是整数")
                action = str(body.get("action") or "save").strip().lower()
                if action == "save":
                    res = sf.save(self.cfg, project, rev, body.get("profile") or {})
                elif action == "delete":
                    res = sf.delete(self.cfg, project, rev,
                                    str(body.get("id") or ""))
                else:
                    raise ElabError("action 必须是 save/delete")
                if res.get("conflict"):
                    return self._json(res, 409)
                if res.get("ok"):
                    pid = (str(body.get("id") or "") if action == "delete"
                           else str((body.get("profile") or {}).get("id") or ""))
                    if pid:
                        _sync_serial_decoder(self.cfg, project, pid,
                                             action == "delete")
                return self._json(res, 200 if res.get("ok") else 400)
            if u.path == "/api/serial/frames/templates/import":
                # 模板 → 工程 profile（仍走 save：rev 乐观锁，不覆盖冲突）。
                body = self._body()
                project = str(body.get("project") or "")
                if not project:
                    raise ElabError("模板导入需要 project")
                try:
                    rev = int(body.get("rev") or 0)
                except (TypeError, ValueError):
                    raise ElabError("rev 必须是整数")
                res = sf.import_template(
                    self.cfg, project, rev,
                    str(body.get("template") or ""),
                    str(body.get("new_id") or ""))
                if res.get("conflict"):
                    return self._json(res, 409)
                return self._json(res, 200 if res.get("ok") else 400)
            if u.path == "/api/serial/frames/encode":
                # 反向组帧（P1）：字段值 → 字节；支持未保存草稿。
                body = self._body()
                prof = None
                if isinstance(body.get("profile"), dict):
                    try:
                        prof = sf.normalize_profile(body["profile"])
                    except ValueError as exc:
                        raise ElabError(str(exc))
                else:
                    project = str(body.get("project") or "")
                    pid = str(body.get("id") or "")
                    if not project or not pid:
                        raise ElabError("encode 需要 project+id 或 profile 草稿")
                    prof = sf.get(self.cfg, project, pid)
                    if prof is None:
                        raise ElabError(f"未找到帧协议 profile：{pid!r}")
                res = serialcodec_mod.encode(
                    prof, body.get("values") or {}, body.get("variant"),
                    body.get("length_value"))
                return self._json(res, 200 if res.get("ok") else 400)
            if u.path == "/api/serial/frames/learn":
                # P4.1：从抓包学一个**草稿** profile（不落盘）。
                # 保存仍走 /api/serial/frames 的 rev 乐观锁 —— 学习不会偷偷改配置。
                body = self._body()
                hints = body.get("hints") or {}
                if not isinstance(hints, dict):
                    raise ElabError("hints 必须是对象")
                try:
                    fc = int(body.get("field_count") or 0)
                except (TypeError, ValueError):
                    raise ElabError("field_count 必须是整数")
                try:
                    res = framelearn_mod.learn(
                        frames=body.get("frames"),
                        hex=str(body.get("hex") or ""),
                        b64=str(body.get("b64") or ""),
                        capture=_capture_text(self.cfg, body.get("capture")),
                        name=str(body.get("name") or "learned"),
                        label=str(body.get("label") or ""),
                        hints=hints, field_count=fc)
                except ValueError as exc:
                    raise ElabError(str(exc))
                return self._json(res, 200 if res.get("ok") else 400)
            if u.path == "/api/serial/frames/verify":
                # P4.2：解 → 编 → 再解，逐帧比对（证明规则可逆）。
                body = self._body()
                prof = _frame_profile_of(self.cfg, body)
                try:
                    res = framelearn_mod.verify(
                        prof, body.get("vectors"),
                        hex=str(body.get("hex") or ""),
                        b64=str(body.get("b64") or ""),
                        capture=_capture_text(self.cfg, body.get("capture")))
                except ValueError as exc:
                    raise ElabError(str(exc))
                return self._json(res, 200 if res.get("ok") else 400)
            if u.path == "/api/serial/frames/auto":
                # P4.3：给一段字节，在工程 profile 里选一个最像的（只推荐）。
                body = self._body()
                data = _frame_bytes_of(body, self.cfg)
                if not data:
                    raise ElabError("auto 需要 hex / b64 / capture 之一")
                explicit = body.get("profiles")
                if isinstance(explicit, list) and explicit:
                    profiles = []
                    for i, raw in enumerate(explicit):
                        try:
                            profiles.append(sf.normalize_profile(raw))
                        except ValueError as exc:
                            raise ElabError(f"profiles[{i}]：{exc}")
                else:
                    project = str(body.get("project") or "")
                    if not project:
                        raise ElabError("auto 需要 project，或直接传 profiles")
                    profiles = sf.load(self.cfg, project).get("profiles") or []
                    if not profiles:
                        raise ElabError(f"工程 {project} 还没有帧协议 profile")
                res = framelearn_mod.auto(profiles, data)
                if res.get("ok") and body.get("apply"):
                    pid = res["decoder"].split(":", 1)[1]
                    applied = serialmon_mod.set_decoder(
                        res["decoder"], actor="agent", cfg=self.cfg,
                        project=str(body.get("project") or ""))
                    res["applied"] = applied.get("ok", False)
                    if not applied.get("ok"):
                        res["apply_error"] = applied.get("error")
                    del pid
                return self._json(res, 200 if res.get("ok") else 409)
            if u.path == "/api/serial/frames/codegen":
                # P4.4：profile → C 头文件。默认只返回文本，写盘需 write=true。
                body = self._body()
                prof = _frame_profile_of(self.cfg, body)
                res = framelearn_mod.codegen(prof, guard=str(body.get("guard") or ""))
                if body.get("write"):
                    target = Path(self.cfg.root) / "generated" / f"{prof['id']}.h"
                    if target.exists() and not body.get("overwrite"):
                        res["ok"] = False
                        res["error"] = f"{target} 已存在；确需覆盖请带 overwrite=true"
                        return self._json(res, 409)
                    try:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text(res["text"], encoding="utf-8")
                    except OSError as exc:
                        raise ElabError(f"写文件失败：{exc}")
                    res["written"] = str(target)
                return self._json(res)
            if u.path == "/api/serial/frames/preview":
                # 帧解析预览（M5）：不需要开串口/会话，改配置立即验证。
                body = self._body()
                project = str(body.get("project") or "")
                pid = str(body.get("id") or "")
                if isinstance(body.get("profile"), dict):
                    # 未保存草稿：校验后直接预览（Agent 先验证再落盘）
                    try:
                        prof = sf.normalize_profile(body["profile"])
                    except ValueError as exc:
                        raise ElabError(str(exc))
                    pid = prof["id"]
                else:
                    prof = sf.get(self.cfg, project, pid) if pid else None
                if prof is None:
                    raise ElabError(f"未找到帧协议 profile：{pid!r}")
                if body.get("b64") or body.get("data_b64"):
                    import base64 as _b64mod
                    try:
                        data = _b64mod.b64decode(
                            str(body.get("b64") or body.get("data_b64")))
                    except Exception as exc:               # noqa: BLE001
                        raise ElabError(f"b64 不是合法 base64：{exc}")
                elif body.get("hex"):
                    try:
                        data = bytes.fromhex("".join(str(body["hex"]).split()))
                    except ValueError as exc:
                        raise ElabError(f"hex 不是合法十六进制：{exc}")
                else:
                    data = b""
                res = serialcodec_mod.decode(data, f"profile:{pid}",
                                             profile=prof)
                return self._json(res, 200 if res.get("ok") else 400)
            if u.path == "/api/serial/symbolize":
                # M6：地址 → 函数/文件:行（addr2line）。失败如实返回，不编造。
                body = self._body()
                project = str(body.get("project") or "")
                addrs = body.get("addrs") or []
                if not isinstance(addrs, list):
                    raise ElabError("addrs 必须是数组")
                pid = str(body.get("profile") or "")
                prof = ld.get_profile(self.cfg, project, pid) if pid else None
                res = ld.symbolize(self.cfg, project, addrs, prof)
                return self._json(res, 200 if res.get("ok") else 400)
            if u.path == "/api/serial/capture":
                # K5 显式录制：把**字节**录成有界 JSONL（不录文本投影，可回放）。
                # start/stop 幂等；status 走 capabilities.serial.monitor.capture。
                body = self._body()
                action = body.get("action") or "start"
                if action == "start":
                    raw_mb = body.get("max_bytes")
                    try:
                        max_bytes = int(raw_mb or 0)
                    except (TypeError, ValueError):
                        raise ElabError(f"max_bytes 必须是整数：{raw_mb!r}")
                    try:
                        pre_bytes = int(body.get("pre_bytes") or 0)
                    except (TypeError, ValueError):
                        raise ElabError("pre_bytes 必须是整数")
                    trigger = body.get("trigger")
                    if trigger is not None and not isinstance(trigger, dict):
                        raise ElabError("trigger 必须是对象")
                    res = serialmon_mod.capture_start(
                        self.cfg, project=body.get("project") or "",
                        max_bytes=max_bytes, trigger=trigger,
                        pre_bytes=pre_bytes)
                    return self._json(res, 200 if res.get("ok") else 400)
                if action == "stop":
                    return self._json(serialmon_mod.capture_stop(), 200)
                if action == "status":
                    return self._json({"ok": True,
                                       **serialmon_mod.status()}, 200)
                raise ElabError(f"action 必须是 start/stop/status：{action!r}")
            if u.path == "/api/serial/decode":
                # P3 无状态协议解码：给一段字节（hex 或 base64），返回通道帧。
                # ★ 不解码"会话状态"：半帧由调用方拼下一批（pending 原样带回）。
                body = self._body()
                decoder = str(body.get("decoder") or "justfloat")
                if body.get("data_b64"):
                    try:
                        data = base64.b64decode(str(body.get("data_b64")))
                    except Exception as exc:               # noqa: BLE001
                        raise ElabError(f"data_b64 不是合法 base64：{exc}")
                elif body.get("hex"):
                    try:
                        data = bytes.fromhex(
                            "".join(str(body.get("hex")).split()))
                    except ValueError as exc:
                        raise ElabError(f"hex 不是合法十六进制：{exc}")
                else:
                    data = b""
                prof = None
                pid = str(body.get("profile") or "")
                if decoder == "profile" or decoder.startswith("profile:"):
                    if isinstance(body.get("profile"), dict):
                        # 草稿 profile（Agent 不落盘也能解码）
                        try:
                            prof = sf.normalize_profile(body["profile"])
                        except ValueError as exc:
                            raise ElabError(str(exc))
                        pid = prof["id"]
                    else:
                        if not pid and ":" in decoder:
                            pid = decoder.split(":", 1)[1]
                        prof = sf.get(self.cfg, str(body.get("project") or ""), pid) \
                            if pid else None
                res = serialcodec_mod.decode(data, decoder,
                                             channels=body.get("channels"),
                                             profile=prof)
                return self._json(res, 200 if res.get("ok") else 400)
            if u.path == "/api/adapt":
                # 一键适配（M5.6）：probe 只读在前，write 显式第二段。
                return self._adapt(self._body())
            if u.path == "/api/pick-folder":
                # 原生「选择文件夹」对话框：浏览器沙箱拿不到本地绝对路径，
                # 由同机运行的内核代开系统目录选择框（适配路径的唯一入口）。
                return self._pick_folder(self._body())
            if u.path == "/api/project":
                # 工程接入文件的命名与移除（左侧工程轨的「⋯」菜单）。
                return self._project_admin(self._body())
            return self._err(404, f"未知 API：{u.path}")
        except dbgsess_mod.DebugError as exc:
            return self._debug_err(exc)
        except ElabError as exc:
            return self._err(400, str(exc))
        except Exception as exc:                       # noqa: BLE001
            return self._fail(exc)

    def do_DELETE(self):                               # noqa: N802
        """``DELETE /api/debug/session`` —— 关闭会话并恢复运行（D8/C36）。"""
        u = urlparse(self.path)
        try:
            if u.path != "/api/debug/session":
                return self._err(404, f"未知 API：{u.path}")
            body = self._body()
            resume = bool(body.get("resume", True))
            return self._json(self.dbg.close(
                debug_session=str(body.get("debug_session") or ""),
                reason=str(body.get("reason") or "user-closed"),
                resume=resume, actor=str(body.get("actor") or "human"),
            ))
        except dbgsess_mod.DebugError as exc:
            return self._debug_err(exc)
        except ElabError as exc:
            return self._err(400, str(exc))
        except Exception as exc:                       # noqa: BLE001
            return self._fail(exc)

    # ── 适配包写动作（安装 / 卸载 / 校验 / 更新 / 启用）──────────────
    def _pkg(self, action: str, body: dict):
        """``POST /api/pkg/*`` —— 包操作的唯一入口。

        语义与 CLI ``elab pkg`` 同源（都调 ``elab.pkg`` 的同名函数）：

            install   202 + job（异步：git clone / 哈希 / 复制可能很久）
            remove    202 + job（卸载 + 清理平台 skill）
            update    202 + job（按市场索引升级，缺省全部）
            verify    200（只读、快，同步返回逐包结果）
            activate  200（启用一套已装包 + 重生成平台 skill + 重载 Config）
            market    202 + job（现场遍历 GitHub 上的 elab-pack 仓库，写本机市场缓存）

        ★ 运行约束：有闭环在跑 → 包操作 409；有包操作在跑 → 新包操作 409。
          两者与 ``/api/run`` 的冻结守卫成对（"安装期间冻结闭环"）。
        ★ 只收包名：来源、sha256 都由内核从市场条目解析，前端无从篡改。
        """
        name = str(body.get("name") or "").strip()
        if action == "verify":
            return self._json({"ok": True,
                               "results": pkg_mod.verify(self.cfg, name or None)})
        if action == "market":
            # ★ 首屏遍历：把 GitHub 上现有 elab-pack 仓库现场发现一遍（异步 job，
            #   结果落 .work/pkg/market-live.json，15 分钟内复用）。不改芯片数据，
            #   所以**不**参与闭环冻结守卫。
            def work(log, stage):
                cfg = type(self).cfg
                stage("遍历 GitHub 上的 elab-pack 仓库")
                res = pkg_mod.refresh_market(cfg, log=log)
                stage("生成市场索引")
                return res
            return self._json(self.pkg_jobs.start("market", "", work), 202)
        active_run = self.mgr.list_active()
        if active_run:
            return self._err(409, (
                f"有闭环正在跑（run={active_run[0].get('run')}，"
                f"步骤 {'/'.join(active_run[0].get('steps') or [])}）—— "
                f"等它结束再做包操作（安装/卸载会改芯片数据）"))
        if self.pkg_jobs.busy():
            return self._err(409, "已有包操作进行中 —— 等它完成")
        if not name and action not in ("update", "market"):
            return self._err(400, "缺少 name（适配包名，如 st/stm32）")

        if action == "activate":
            rec = pkg_mod.set_active(self.cfg, name, log=lambda *a: None)
            cfg2 = Config(self.cfg.root)
            type(self).cfg = cfg2          # 与 /api/adapt 写盘后重载同源
            self.mgr.cfg = cfg2
            skills = pkg_mod.regenerate_skills(
                cfg2, (pkg_mod.discover(cfg2).get(name) or {}).get("chips") or [],
                log=lambda *a: None)
            return self._json({**rec, "skills": skills,
                               "setup": setup_mod.pack_report(cfg2, pack=name),
                               "packs": pkg_mod.status(cfg2, include_market=False)}, 200)

        if action == "install":
            official = bool(body.get("official"))
            force = bool(body.get("force"))

            def work(log, stage):
                cfg = type(self).cfg
                stage("安装：校验清单与来源")
                rec = pkg_mod.install_entry(cfg, name, official=official,
                                            force=force, log=log)
                stage("生成平台 skill")
                skills = pkg_mod.regenerate_skills(cfg, rec.get("chips"), log)
                stage("环境自检")
                report = setup_mod.pack_report(cfg, pack=rec.get("name") or name)
                for item in report["items"]:
                    if item["level"] in ("error", "warn"):
                        log(f"[setup] {item['code']}: {item['message']}")
                        if item.get("action"):
                            log(f"[setup]   → {item['action']}")
                return {**rec, "skills": skills, "setup": report}
            return self._json(self.pkg_jobs.start("install", name, work), 202)

        if action == "remove":
            def work(log, stage):
                cfg = type(self).cfg
                man = (pkg_mod.discover(cfg).get(name) or {}).get("manifest") or {}
                platforms = {(man.get("vendor"), man.get("platform"))} if man else set()
                stage("卸载")
                rec = pkg_mod.remove(cfg, name, log=log)
                stage("清理平台 skill")
                pruned = pkg_mod.prune_skills(cfg, platforms, log)
                return {**rec, "skills_removed": pruned}
            return self._json(self.pkg_jobs.start("remove", name, work), 202)

        # update（name 可缺省 = 全部已装包）
        force = bool(body.get("force"))

        def work(log, stage):
            cfg = type(self).cfg
            stage("按市场索引更新")
            recs = pkg_mod.update(cfg, name or None, force=force, log=log)
            stage("生成平台 skill")
            skills = pkg_mod.regenerate_skills(
                cfg, [c for r in recs for c in r.get("chips") or []], log)
            stage("环境自检")
            reports = [setup_mod.pack_report(cfg, pack=r.get("name") or "")
                       for r in recs]
            for report in reports:
                for item in report["items"]:
                    if item["level"] in ("error", "warn"):
                        log(f"[setup] {item['code']}: {item['message']}")
            return {"updated": recs, "skills": skills, "setup": reports}
        return self._json(self.pkg_jobs.start("update", name, work), 202)

    # ── 一键适配（M5.6）────────────────────────────────────────
    def _adapt(self, body: dict):
        """``POST /api/adapt`` —— 把图形配置器导出的工程接进 elab（M5.6）。

        **两段式，probe 永远在前**（"先看清楚再动手"，与只读预览 C26 同一精神）：

            action=probe   只读：把"会生成什么样的接入文件"摆出来，不落任何盘
            action=write   写入 ``projects/<name>.yaml``
            action=check   只读复探测：与已写入文件比对，报 missing/identical/drift

        write 的三类拒绝**原样**沿用 ``adapt.write`` 的实现（只有一份实现，CLI 与
        这里行为必然一致）：未决项 → 拒（force 可越）、芯片未匹配 → 拒、
        人工接管（generated-by 标记缺失）→ 拒。ElabError → 400。

        ★ **刻意不做**三绿灯 verify：那是 build 级长任务（真跑 configure + 编译，
          十几秒起步），同步做会把服务线程钉死（§5.1 K1 的反面教材）。
          故返回 ``next`` 引导前端走**现有** run 通道跑 ``doctor_deep + build`` ——
          三绿灯的判据（doctor_deep 全绿 / 出 elf / guard.untouched）一个不少，
          且进度走 SSE、结果落事件流，与"跑全闭环"完全同一套观测设施。
        """
        action = body.get("action") or "probe"
        if action not in ("probe", "write", "check"):
            raise ElabError(f"action 必须是 probe / write / check：{action!r}")
        raw = (body.get("path") or "").strip()
        if not raw:
            raise ElabError("缺少 path（要适配的工程根目录）")
        p = Path(raw).expanduser()
        # ★ 绝对路径硬性要求：相对路径会让"适配到哪了"取决于服务进程的 cwd ——
        #   那种"在我机器上能用"的坑没有观测手段，必须在入口就拒掉。
        if not p.is_absolute():
            raise ElabError(f"path 必须是绝对路径：{raw!r}")
        if not p.is_dir():
            raise ElabError(f"目录不存在：{p}")

        force = bool(body.get("force"))
        name = (body.get("name") or "").strip()
        probe = adapt_mod.probe_project(self.cfg, str(p))
        out = {"action": action, "probe": probe.to_dict(), "tier": probe.tier,
               "confidence": probe.confidence,
               "name": name or adapt_mod.default_name(probe)}
        if action == "write":
            out["result"] = adapt_mod.write(self.cfg, probe, name=out["name"],
                                            force=force, log=lambda *a: None)
            # ★ 真写出了新的 projects/<name>.yaml → **必须重载 Config**，否则新工程
            #   对驾驶舱不可见（/api/projects 没有它的卡片、/api/run 也起不了它）。
            #   与 CLI `_adapt_verify` 的做法同源（"新增接入文件后重载"）。
            #   赋值是原子的；在途请求仍握着旧引用跑完 —— 旧配置对旧工程依然自洽。
            if out["result"].get("written"):
                cfg2 = Config(self.cfg.root)
                type(self).cfg = cfg2
                self.mgr.cfg = cfg2
        elif action == "check":
            # 复探测（不改盘）：重新探测后与已写入的 projects/<name>.yaml 逐字节比对。
            # status ∈ missing / identical / drift —— 与 CLI `elab adapt --check` 同源。
            out["result"] = adapt_mod.write(self.cfg, probe, name=out["name"],
                                            check=True, log=lambda *a: None)
        out["next"] = {
            "steps": ["doctor_deep", "build"],
            "hint": ("写入后跑「体检 + 编译」即三绿灯自证：doctor_deep 全绿"
                     "+ build 出 elf + 零改动守卫 untouched=true"),
        }
        return self._json(out, 200)

    def _pick_folder(self, body: dict):
        """``POST /api/pick-folder`` —— 打开**系统原生**「选择文件夹」对话框。

        为什么必须由内核代开：浏览器安全沙箱下 ``<input>`` 拿不到本地目录的
        绝对路径，而 ``/api/adapt`` 硬性要求绝对路径（相对路径会让"适配到哪"
        取决于服务进程的 cwd）。内核与用户在同一台机器上，是最合适的中介。

        返回 ``{"path": "C:/..."}`` 或 ``{"cancelled": true}``；tkinter 不可用
        （精简版 Python / 无桌面会话）时抛 ElabError，前端回落到手工输入。
        """
        try:
            import tkinter as tk
            from tkinter import filedialog
        except Exception as exc:                           # noqa: BLE001
            raise ElabError(
                f"当前 Python 环境没有可用的 tkinter，无法打开目录选择框"
                f"（{exc}）—— 请手工输入工程绝对路径") from exc
        initial = str(body.get("initial") or "").strip()
        # Tk 必须在创建窗口的线程里使用；HTTP 处理器线程即可（单次、独占）。
        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:                                  # noqa: BLE001
            pass
        try:
            picked = filedialog.askdirectory(
                parent=root,
                title="选择工程根目录（含 CMakeLists.txt）",
                initialdir=initial or None,
                mustexist=True,
            )
        finally:
            try:
                root.destroy()
            except Exception:                              # noqa: BLE001
                pass
        if not picked:
            return self._json({"cancelled": True}, 200)
        return self._json({"path": Path(picked).as_posix()}, 200)

    # ── 工程管理（重命名 / 移除 / 切换探针）──────────────────────────
    def _project_admin(self, body: dict):
        """``POST /api/project`` —— 左侧工程轨的「⋯」菜单。

            action=rename     {name, new_name}  改 projects/<name>.yaml 的基名与 name 行
            action=remove     {name}            先留 .bak 再删接入文件
            action=set_probe  {name, probe}      只改 debug.probe（保留注释）

        ★ 只动接入层（`projects/*.yaml`），业务工程零改动（guard 快照不受影响）。
        ★ 成功后**必须**重载 Config —— 否则工程轨仍显示旧卡片（C29 同一教训）。
        ★ 有闭环在跑 → 409：改名/删除会让在途 run 的 project 键失效。
        ★ 调试会话打开 → 409：避免面板显示新探针、当前会话仍用旧探针。
        """
        action = str(body.get("action") or "").strip()
        name = str(body.get("name") or "").strip()
        if action not in ("rename", "remove", "set_probe"):
            raise ElabError(f"action 必须是 rename / remove / set_probe：{action!r}")
        if not name:
            raise ElabError("缺少 name")
        active = self.mgr.list_active()
        if active:
            raise ElabError(
                f"有闭环正在跑（run={active[0].get('run')}）—— 等它结束再改名/移除/切换探针")

        if action == "rename":
            res = project_admin_mod.rename(self.cfg, name, str(body.get("new_name") or ""))
        elif action == "remove":
            res = project_admin_mod.remove(self.cfg, name)
        else:
            sess = self.dbg.get()
            if sess is not None and sess.state not in ("closed", "error"):
                raise dbgsess_mod.DebugError(
                    "debug-busy", f"调试会话打开中（项目 {sess.plan.name}）—— 先关闭会话再切换探针",
                    "点调试工作区「关闭」，或 DELETE /api/debug/session")
            res = project_admin_mod.set_probe(
                self.cfg, name, str(body.get("probe") or ""))

        cfg2 = Config(self.cfg.root)
        type(self).cfg = cfg2
        self.mgr.cfg = cfg2
        return self._json({**res, "action": action})

    # ── 静态 ────────────────────────────────────────────────────
    def _static(self, path: str):
        if not (self.dist / "index.html").exists():
            return self._send(200, _NO_DIST_HTML.encode("utf-8"),
                              "text/html; charset=utf-8")
        rel = path.lstrip("/") or "index.html"
        target = (self.dist / rel).resolve()
        # 目录穿越防护：解析后必须仍在 dist 内
        try:
            target.relative_to(self.dist.resolve())
        except ValueError:
            return self._err(403, "路径越界")
        if not target.is_file():
            # SPA 回退：无扩展名 → index.html（前端用 history 路由）
            if "." not in Path(rel).name:
                target = self.dist / "index.html"
            else:
                return self._err(404, f"找不到：{rel}")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",
                                                  "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    # ── SSE ─────────────────────────────────────────────────────
    def _sse_debug(self, debug_session: str = ""):
        """调试事件流（独立信封 §6.4）。

        ★ 与 run SSE 分开：``ElabEvent`` 的 ``run`` 字段是必填的，硬塞会把
          "调试会话"伪装成"某个 run"，工具层与前端都得靠猜。
        ★ 多会话：``?debug_session=<id>`` 只推该会话的事件（信封 ``session`` 双保险）。
        """
        if not self.sse_sem.acquire(blocking=False):
            return self._err(503, f"SSE 连接数已达上限（{MAX_SSE_CONNS}）")
        q = self.dbg.subscribe(debug_session)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self._sent_headers = True
            last_beat = time.time()
            while True:
                try:
                    e = q.get(timeout=PROC_BATCH_S)
                except queue.Empty:
                    if (time.time() - last_beat) >= SSE_HEARTBEAT_S:
                        self._chunk(": ping\n\n")
                        last_beat = time.time()
                    continue
                self._sse_write(e)
                last_beat = time.time()
        except ConnectionError:
            return
        except Exception as exc:                       # noqa: BLE001
            sys.stderr.write(f"[cockpit] 调试 SSE 异常：{exc!r}\n")
        finally:
            self.dbg.unsubscribe(q)
            self.sse_sem.release()

    def _sse(self, qs: dict):
        run_id = (qs.get("run") or [""])[0]
        after = int((qs.get("from") or ["0"])[0])
        # 断线续传：浏览器重连会自动带 Last-Event-ID（§17.2）
        leid = self.headers.get("Last-Event-ID")
        if leid:
            try:
                after = max(after, int(leid))
            except ValueError:
                pass
        if not run_id:
            return self._err(400, "缺少 run")

        if not self.sse_sem.acquire(blocking=False):
            return self._err(503, f"SSE 连接数已达上限（{MAX_SSE_CONNS}）")

        ar = self.mgr.active(run_id)
        sub = self.mgr.subscribe(run_id)          # 非活动 run 也能拿（subscribe 会返回空队列）
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            # ★ 用 chunked 而不是"靠关连接断句"：HTTP/1.1 下没有 Content-Length
            #   就必须显式分块，否则浏览器会一直等自己的缓冲，日志"不动"。
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self._sent_headers = True

            last_sent = after
            last_beat = time.time()
            pending: list[str] = []
            pending_step = ""
            last_flush = time.time()

            def chunk(data: str) -> None:
                self._chunk(data)

            def flush_proc() -> None:
                nonlocal pending, last_flush
                if pending:
                    self._sse_frame("proc/stdout-batch",
                                    {"topic": "proc/stdout-batch", "run": run_id,
                                     "seq": last_sent, "ts": time.time(),
                                     "actor": "agent", "step": pending_step,
                                     "lines": pending},
                                    eid=last_sent)
                    pending = []
                last_flush = time.time()

            # ① 先把 after_seq 之后的存量重放掉（覆盖"断线期间"与"run 已结束"两种情况）
            for e in ev_mod.read_run(self.mgr.runs_dir, run_id, after_seq=after):
                if e.get("seq", 0) <= last_sent:
                    continue
                self._sse_write(e)
                last_sent = e.get("seq", last_sent)

            # ② 已结束（或未知）的 run：重放完就收尾。
            #    ★ 无论哪种情况都**必须**发出 stream/closed + chunked 终止块：
            #      否则客户端只看到"连接被关"，分不清"run 结束了"和"服务端出错"，
            #      而 EventSource 还会傻傻地不停重连。
            if ar is None or not ar.alive:
                flush_proc()
                if ar is None and not self._run_exists(run_id):
                    self._sse_frame("stream/closed",
                                    {"run": run_id, "reason": "unknown-run"})
                else:
                    self._sse_frame("stream/closed",
                                    {"run": run_id, "reason": "run-finished"})
                chunk("0\r\n\r\n")
                return

            # ③ 活动 run：跟读队列
            heartbeats = 0
            while True:
                try:
                    e = sub.get(timeout=PROC_BATCH_S)
                except queue.Empty:
                    now = time.time()
                    if pending and (now - last_flush) >= PROC_BATCH_S:
                        flush_proc()
                    if (now - last_beat) >= SSE_HEARTBEAT_S:
                        chunk(": ping\n\n")             # §17.3 注释行心跳
                        last_beat = now
                        heartbeats += 1
                        if heartbeats > 8 and not self.mgr.active(run_id):
                            break
                    continue

                topic = e.get("topic", "")
                if topic == "stream/closed":
                    flush_proc()
                    self._sse_frame("stream/closed",
                                    {"run": run_id, "reason": e.get("reason", ""),
                                     "rc": e.get("rc")})
                    break

                # ★ `stream/overrun` 必须在**去重之前**处理，理由有两条：
                #   ① 它的 topic 前缀是 `stream/`（非 `run/`）→ `is_activity()` 为真，
                #      会落进下面的 activity 分支被当成"一行普通输出"。而它没有
                #      `line` 字段 → 界面收到一个**空字符串行**，什么提示都没有。
                #      契约里"补一条 stream/overrun 让 UI 提示日志已截断"就是被这里吞掉的。
                #   ② 它带的是 `ar.last_seq`（**定位锚点**，不是新序号），
                #      必然 `<= last_sent` → 走下面的去重就会被当成"与重放重叠"丢掉。
                #      即"刚发出的告警被自己的去重逻辑吃掉"，是最隐蔽的那种丢法。
                if topic == "stream/overrun":
                    flush_proc()
                    self._sse_frame(
                        "stream/overrun",
                        {"run": run_id, "topic": "stream/overrun",
                         "seq": e.get("seq", 0), "ts": e.get("ts") or time.time(),
                         "actor": e.get("actor") or "agent",
                         "dropped": e.get("dropped", 0),
                         "topic_scope": e.get("topic_scope", ""),
                         "reason": e.get("reason", "")},
                        eid=None)     # ★ 刻意不带 id：它是"传输"的事实，不是 run 的序号；
                                      #   写进 Last-Event-ID 会让重连游标越过它自己
                    last_beat = time.time()
                    continue

                seq = e.get("seq", 0)
                if seq and seq <= last_sent:
                    continue                            # 与重放重叠 → 去重
                if ev_mod.is_batched(topic):
                    # 100ms 合并（§17.3）；**只有进程输出**进这里 ——
                    # 见 `events.is_batched()`：`serial/*` 曾被 `is_activity()`
                    # 误判进合并，于是 serial/closed-loop 变成一行空文本、
                    # 「串口闭环」UI 永远是死的，且只在**实时**路径上复现。
                    step = e.get("step", "")
                    if pending and step != pending_step:
                        flush_proc()
                    pending_step = step
                    pending.append(str(e.get("line", "")))
                    last_sent = max(last_sent, seq)
                    if (time.time() - last_flush) >= PROC_BATCH_S:
                        flush_proc()
                    continue
                flush_proc()
                self._sse_write(e)
                last_sent = max(last_sent, seq)
                last_beat = time.time()

            flush_proc()
            chunk("0\r\n\r\n")                          # chunked 终止块
        except ConnectionError:
            return                                      # 客户端走了（head / 关标签页），常态
        except Exception as exc:                        # noqa: BLE001
            sys.stderr.write(f"[cockpit] SSE 异常（{run_id}）：{exc!r}\n")
            return
        finally:
            self.mgr.unsubscribe(run_id, sub)
            self.sse_sem.release()

    def _run_exists(self, run_id: str) -> bool:
        return (self.mgr.runs_dir / f"{run_id}.jsonl").exists()

    # ── SSE 写帧 ────────────────────────────────────────────────
    #: 已经告警过的越界 topic（进程级共享）。只提示一次，避免日志被刷爆。
    _warned_topics: set[str] = set()

    def _sse_warn_unknown(self, topic: str) -> None:
        """发出的 topic 不在 ``SSE_TOPICS`` 登记表里 → 打一条 WARN。

        ★ 为什么值得单独做这件事：这个缺陷是**完全静默**的 —— 服务端 HTTP 200、
        帧格式正确、日志正常；浏览器不报错也不触发 `onerror`，只是那块 UI 永远
        不更新。没有这行 WARN，"新增了 topic 但忘了同步前端白名单"只能靠人肉发现。
        """
        if topic in SSE_TOPICS or topic in CockpitHandler._warned_topics:
            return
        CockpitHandler._warned_topics.add(topic)
        self.mgr.log(
            f"[cockpit] ⚠ SSE topic 未登记：{topic!r} —— 若前端 `KNOWN_TOPICS`"
            f" 也没同步，浏览器会**静默丢弃**该 topic 的全部事件（ICD §6.1）。"
            f" 两端都要改：cockpit/server.py 的 SSE_TOPICS + web 的 KNOWN_TOPICS。")

    # ★ 这三处**必须**统一走 chunk 分块。教训：曾把状态帧用裸 write 直接写出去，
    #   而响应头声明了 `Transfer-Encoding: chunked` → 客户端把 `id: 1` 当成
    #   chunk-size 行去解析（`id:` 不是十六进制）→ **立刻判定流结束**。
    #   症状极具迷惑性：状态码 200、Content-Type/Transfer-Encoding 全对、
    #   服务端日志一切正常，但客户端**一行都收不到**。
    def _chunk(self, data: str) -> None:
        raw = data.encode("utf-8")
        self.wfile.write(f"{len(raw):X}\r\n".encode("ascii") + raw + b"\r\n")
        self.wfile.flush()

    def _sse_frame(self, event: str, data: dict, eid: int | None = None) -> None:
        """命名事件帧。``eid`` 为 None 时**不**写 ``id:``。

        ★ 为什么 ``proc/stdout-batch`` 也必须带 ``id``（实测发现的缺陷）：
          浏览器只用 ``id:`` 维护 ``Last-Event-ID``。合并帧若不带 ``id``，
          客户端记录的游标会停在**上一个 run\\* 事件**上，于是重连时服务端从
          那个旧游标重放 —— 已经通过合并帧交付过的日志行**会再发一遍**，
          证据轨里出现重复行（且只在"断过线"时才复现，极难归因）。
          合并帧里的事件 seq 天然连续（非活动事件写入前必先冲刷 pending），
          故用其最大 seq 当 ``id`` 是精确且单调的。
        """
        self._sse_warn_unknown(event)
        head = f"id: {eid}\n" if eid is not None else ""
        self._chunk(f"{head}event: {event}\ndata: "
                    + json.dumps(data, ensure_ascii=False) + "\n\n")

    def _sse_write(self, e: dict) -> None:
        """一条事件 → 一个 SSE 帧。``id:`` 即 ``seq``，浏览器重连时自动回传。"""
        topic = e.get("topic", "message")
        self._sse_warn_unknown(topic)
        self._chunk(f"id: {e.get('seq', 0)}\n"
                    f"event: {topic}\n"
                    "data: " + json.dumps(e, ensure_ascii=False) + "\n\n")


_NO_DIST_HTML = """<!doctype html><meta charset="utf-8">
<title>elab cockpit · 前端未构建</title>
<style>body{font:15px/1.7 system-ui;max-width:46rem;margin:3rem auto;padding:0 1.2rem;color:#1a1a1a}
code{background:#f1efe8;padding:.15rem .4rem;border-radius:4px}pre{background:#f8f7f4;padding:1rem;border-radius:8px;overflow:auto}</style>
<h1>驾驶舱后端已在运行，但前端产物缺失</h1>
<p>后端是零依赖的（HTTP + SSE 都是 stdlib），但界面本身需要一份构建产物
<code>cockpit/web/dist/</code>。它**已随仓库提交**，所以正常 clone 下来不该看到本页。</p>
<p>若你确实处在"还没构建前端"的状态，执行：</p>
<pre>npm --prefix cockpit/web install
npm --prefix cockpit/web run build</pre>
<p>构建一次之后刷新本页即可。<b>最终用户不需要装 Node</b> —— 只需要这份 <code>dist/</code>。</p>
<p>此刻可以先用 API 验证后端：</p>
<pre>curl -s http://127.0.0.1:8333/api/capabilities
curl -s http://127.0.0.1:8333/api/projects</pre>
"""


class CockpitServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    verbose = False

    def handle_error(self, request, client_address):
        """客户端断开**不是**服务端错误，别打一堆吓人的栈。

        典型的无害场景：``http.client`` 用完后直接关连接，而服务端还在
        keep-alive 地等同一个连接上的下一个请求 → ``ConnectionAbortedError``。
        本地单用户工具里这几乎是常态，掩盖真实错误才是代价。
        """
        exc = sys.exc_info()[1]
        if isinstance(exc, ConnectionError):
            return
        super().handle_error(request, client_address)


def make_server(cfg: Config, *, host: str = HOST, port: int = DEFAULT_PORT,
                dist: Path | None = None, verbose: bool = False,
                log=print) -> CockpitServer:
    mgr = RunManager(cfg, log=log)
    dbg = DebugManager(cfg, mgr, log=log)
    pkg_jobs = PkgJobManager()
    handler = type("BoundCockpitHandler", (CockpitHandler,), {})
    handler.cfg = cfg
    handler.mgr = mgr
    handler.dbg = dbg
    handler.pkg_jobs = pkg_jobs
    handler.dist = Path(dist) if dist else DIST_DIR
    handler.sse_sem = threading.Semaphore(MAX_SSE_CONNS)
    # 包操作完成后**重建 Config**（芯片/工程对运行中的驾驶舱立即生效）。
    # 与 /api/adapt 写盘后的重载同源：原子替换类属性，在途请求握旧引用跑完。
    def _reload_pack_cfg():
        new_cfg = Config(cfg.root)
        handler.cfg = new_cfg
        mgr.cfg = new_cfg
    pkg_jobs.bind(_reload_pack_cfg)
    # ★ 开箱即用：全新环境（packs/installed 为空）时自动装内置官方包（st/stm32），
    #   让「已安装」页签首屏就有内容。已有任何已装包时不动（不覆盖用户卸载）。
    try:
        installed = pkg_mod.ensure_bootstrap(cfg, log=log)
        if installed:
            log(f"[cockpit] 已自动安装内置适配包："
                f"{'、'.join(r['name'] for r in installed)}")
            handler.cfg = Config(cfg.root)
            mgr.cfg = handler.cfg
    except Exception as exc:                       # noqa: BLE001
        log(f"[cockpit] 内置适配包自动安装失败：{exc}")
    srv = CockpitServer((host, port), handler)
    srv.verbose = verbose                                # type: ignore[attr-defined]
    srv.run_manager = mgr                                # type: ignore[attr-defined]
    return srv


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="cockpit.server",
                                 description="elab-Flow 闭环驾驶舱后端（零依赖 HTTP + SSE）")
    ap.add_argument("--root", help="覆盖 ELAB_ROOT")
    ap.add_argument("--host", default=HOST, help=f"监听地址（默认 {HOST}，只监听本地）")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"端口（默认 {DEFAULT_PORT}）")
    ap.add_argument("--dist", help="覆盖前端产物目录（默认 cockpit/web/dist）")
    ap.add_argument("--reload", action="store_true", help="不使用 dist/，仅提供 API")
    ap.add_argument("--logfile", help="stdout/stderr 重定向到文件（pythonw 无窗口部署用；"
                                      "行缓冲，替代'最小化控制台'的日志能力）")
    ap.add_argument("-v", "--verbose", action="store_true", help="打印访问日志")
    args = ap.parse_args(argv)

    if args.logfile:
        # C32 教训：重定向 stdout 在 GBK 代码页下会因 ✓ 字符崩服务 —— 显式 utf-8。
        _lf = open(args.logfile, "a", encoding="utf-8")
        sys.stdout = _lf
        sys.stderr = _lf
        try:
            sys.stdout.reconfigure(line_buffering=True)
        except Exception:
            pass

    cfg = Config(args.root)
    dist = None if args.reload else (Path(args.dist) if args.dist else None)
    srv = make_server(cfg, host=args.host, port=args.port, dist=dist,
                      verbose=args.verbose)
    ready = (Path(dist) if dist else DIST_DIR) / "index.html"
    # ★ 打印**实际绑定**的端口，而不是请求值：`--port 0` 时由 OS 分配，
    #   请求值恒为 0（打印 0 会让调用方无法据此连接 —— DSH 插件托管正是这种用法）。
    #   `--port 8333` 等显式端口下两者相同，行为不变。
    bound_port = srv.server_address[1]
    print(f"[cockpit] ELAB_ROOT = {cfg.root}")
    print(f"[cockpit] 监听 http://{args.host}:{bound_port}/")
    print(f"[cockpit] 前端产物 {'✓ ' + to_fwd(ready) if ready.exists() else '✗ 缺失（见页面提示）'}")
    print(f"[cockpit] 运行产物 {to_fwd(srv.run_manager.runs_dir)}")
    print("[cockpit] Ctrl-C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[cockpit] 退出中…")
    finally:
        srv.shutdown()
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
