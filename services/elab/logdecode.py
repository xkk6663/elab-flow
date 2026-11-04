"""elab.logdecode —— 串口日志诊断的**通用解释器**（M6）。

分层纪律（AGENTS.md 规则 5）
---------------------------
内核不认识 ESP-IDF / STM32，只认识 ``serial.log_profiles`` 这组**数据键**：

    panic_lines    命中即开一条 panic issue（正则列表）
    hardfault_lines 命中即开 hardfault（STM32 用）
    core_pattern   从行内抽 core（可选，一个捕获组）
    reason_pattern 从行内抽原因（可选，一个捕获组）
    backtrace_line 回溯行（可选，一个捕获组 = 地址串）
    addr_pattern   地址形态（默认 0x + 8 位十六进制）
    reset_lines    复位行（可选）→ kind=reset，并给后续 issue 标 after_reset
    symbolize      {tool_key, args}：tool_key 指向 elab.host.yaml / 项目 tools

规则来自工程 ``serial.log_profiles`` 或适配包 ``pack.yaml`` 的同名键；
内核代码里**没有** ``if esp32``。加一颗新芯片 = 加一份数据，不发内核版。

符号化
------
``symbolize()`` 调外部 ``addr2line``，10s 超时 + LRU 缓存；
工具不存在就如实返回 ``ok:false`` 与安装提示，不猜路径。ROM 地址按
profile 的 ``rom_prefixes`` 标记"无法符号化"，不编造函数名。
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from collections import OrderedDict
from pathlib import Path

from . import pkg
from .config import Config

#: issue 环上限（有界，避免长时间跑把内存吃光）。
MAX_ISSUES = 64

#: 符号化缓存：key=(elf 实际路径, mtime, addr) → 结果；LRU 512。
_SYM_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_SYM_CACHE_MAX = 512

_DEFAULT_ADDR = r"0x[0-9a-fA-F]{8}"
_DEFAULT_ROM_PREFIXES = ("0x400",)


# ── profile 装载 ─────────────────────────────────────────────────
def _norm_regex(raw) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(x) for x in raw if str(x)]
    return [str(raw)] if str(raw) else []


def normalize_profile(raw: dict) -> dict:
    """把一个 YAML/JSON profile 规整成内核只认的形状（缺省值补齐）。"""
    raw = raw or {}
    return {
        "id": str(raw.get("id") or "").strip(),
        "label": str(raw.get("label") or raw.get("id") or "").strip(),
        "panic_lines": _norm_regex(raw.get("panic_lines")),
        "hardfault_lines": _norm_regex(raw.get("hardfault_lines")),
        "reset_lines": _norm_regex(raw.get("reset_lines")),
        "core_pattern": str(raw.get("core_pattern") or ""),
        "reason_pattern": str(raw.get("reason_pattern") or ""),
        "backtrace_line": str(raw.get("backtrace_line") or ""),
        "addr_pattern": str(raw.get("addr_pattern") or _DEFAULT_ADDR),
        "rom_prefixes": [str(x) for x in (raw.get("rom_prefixes") or [])],
        "symbolize": dict(raw.get("symbolize") or {}),
    }


def _profile_errors(p: dict) -> list[str]:
    errs = []
    if not p["id"]:
        errs.append("log_profile 缺 id")
    for key in ("panic_lines", "hardfault_lines", "reset_lines"):
        for pat in p[key]:
            try:
                re.compile(pat)
            except re.error as exc:
                errs.append(f"{key} 正则非法 {pat!r}：{exc}")
    for key in ("core_pattern", "reason_pattern", "backtrace_line"):
        if p[key]:
            try:
                re.compile(p[key])
            except re.error as exc:
                errs.append(f"{key} 正则非法：{exc}")
    try:
        re.compile(p["addr_pattern"])
    except re.error as exc:
        errs.append(f"addr_pattern 正则非法：{exc}")
    return errs


def _pack_manifest(cfg: Config, project: str) -> dict:
    """按项目 ``pack`` 名取适配包 manifest；取不到返回空（不抛错）。"""
    try:
        proj = cfg.resolved_project(project) if project else {}
    except Exception:                                # noqa: BLE001
        return {}
    pack_name = str((proj or {}).get("pack") or "").strip()
    if not pack_name:
        return {}
    try:
        packs = pkg.discover(cfg)
    except Exception:                                # noqa: BLE001
        return {}
    rec = packs.get(pack_name)
    if rec is None:
        # 允许写 platform 键（如 espressif/esp32）而包名不同
        for name, r in packs.items():
            man = r.get("manifest") or {}
            if pack_name in (name, str(man.get("platform") or "")):
                rec = r
                break
    return (rec or {}).get("manifest") or {}


def load_profiles(cfg: Config, project: str = "") -> list[dict]:
    """包内 profile + 工程覆盖（同 id 工程优先）。返回规整后的列表。"""
    merged: dict[str, dict] = {}
    order: list[str] = []

    def _add(raws):
        for raw in raws or []:
            p = normalize_profile(raw if isinstance(raw, dict) else {})
            errs = _profile_errors(p)
            if errs:
                raise ValueError(f"log_profile 配置错误：{'；'.join(errs)}")
            if p["id"] not in merged:
                order.append(p["id"])
            merged[p["id"]] = p

    try:
        proj = cfg.resolved_project(project) if project else {}
    except Exception:                                # noqa: BLE001
        proj = {}
    manifest = _pack_manifest(cfg, project)
    _add((((manifest.get("serial") or {}) if isinstance(manifest, dict) else {})
          .get("log_profiles")))
    _add(((proj.get("serial") or {}) if isinstance(proj, dict) else {})
         .get("log_profiles"))
    return [merged[i] for i in order]


def get_profile(cfg: Config, project: str, pid: str) -> dict | None:
    pid = (pid or "").strip()
    if not pid:
        return None
    for p in load_profiles(cfg, project):
        if p["id"] == pid:
            return p
    return None


# ── 行解析（纯函数，单测直接喂文本）──────────────────────────────
def _search(pattern: str, text: str) -> re.Match | None:
    return re.search(pattern, text) if pattern else None


def parse_line(line: str, profile: dict, *, after_reset: bool = False) -> dict | None:
    """解析一行日志。返回：

        {"kind":"reset", "line":...}
        {"kind":"panic|assert|hardfault", "core":..., "reason":..., "line":..., "backtrace":[...]}
        {"kind":"backtrace", "addrs":[...]}      # 只追加到上一条 issue
        None                                     # 无关行（零开销）

    ``after_reset`` 由调用方维护：刚出现 reset 行后的第一条 issue 会带上它。
    """
    if not line or not profile:
        return None
    text = line.strip()

    for pat in profile.get("reset_lines") or []:
        if _search(pat, text):
            return {"kind": "reset", "line": text}

    kind = ""
    for pat in profile.get("hardfault_lines") or []:
        if _search(pat, text):
            kind = "hardfault"
            break
    if not kind:
        for pat in profile.get("panic_lines") or []:
            if _search(pat, text):
                kind = "assert" if "assert" in pat.lower() else "panic"
                break
    if kind:
        core = None
        m = _search(profile.get("core_pattern") or "", text)
        if m:
            core = m.group(1) if m.groups() else m.group(0)
        reason = None
        m = _search(profile.get("reason_pattern") or "", text)
        if m:
            reason = m.group(1) if m.groups() else m.group(0)
        addrs = _addrs_in(text, profile)
        return {"kind": kind, "core": core, "reason": reason,
                "line": text, "backtrace": addrs,
                "after_reset": bool(after_reset)}

    m = _search(profile.get("backtrace_line") or "", text)
    if m:
        raw = m.group(1) if m.groups() else text
        addrs = _addrs_in(raw, profile)
        if addrs:
            return {"kind": "backtrace", "addrs": addrs}
    return None


def _addrs_in(text: str, profile: dict) -> list[str]:
    pat = profile.get("addr_pattern") or _DEFAULT_ADDR
    return [a.lower() for a in re.findall(pat, text)]


# ── 符号化 ───────────────────────────────────────────────────────
def _tool_spec(cfg: Config, project: str, key: str) -> tuple[dict, dict]:
    try:
        proj = cfg.resolved_project(project) if project else {}
    except Exception:                                # noqa: BLE001
        proj = {}
    tool = ((proj.get("tools") or {}).get(key)
            or ((cfg.host or {}).get("tools") or {}).get(key))
    return tool or {}, proj


def _tool_argv(cfg: Config, project: str, key: str, elf: str,
               args: list[str], addrs: list[str]) -> tuple[list[str], str]:
    tool, _proj = _tool_spec(cfg, project, key)
    if not tool:
        raise FileNotFoundError(f"工具 {key} 未配置（elab.host.yaml: tools.{key}）")
    argv: list[str] = []
    if tool.get("cmd"):
        cmd = tool["cmd"]
        argv = [cmd] if isinstance(cmd, str) else [str(x) for x in cmd]
    elif tool.get("path"):
        path = str(tool["path"])
        if path.strip().lower() == "auto":
            path = key
        argv = [path]
    elif tool.get("exe"):
        argv = [str(tool["exe"])]
    else:
        raise FileNotFoundError(f"工具 {key} 缺 cmd/path")
    extra = [a.replace("{elf}", elf) for a in args]
    if elf and not any("{elf}" in a for a in args):
        extra = ["-e", elf] + extra
    return argv + extra + list(addrs), str(tool.get("cwd") or "")


def _rom_note(addr: str, profile: dict | None) -> str | None:
    prefixes = (profile or {}).get("rom_prefixes") or []
    if not prefixes:
        prefixes = list(_DEFAULT_ROM_PREFIXES)
    for p in prefixes:
        if addr.lower().startswith(str(p).lower()):
            # ★ 只是"可能"：ESP32-S31（RISC-V）的 IRAM 也在 0x4000xxxx，
            #   所以文案不能断言「这就是 ROM」。
            return "无法符号化（ROM 地址或 ELF 无该地址调试信息）"
    return None


def _canon_addr(a: str) -> str:
    """地址规范化：``0x40001234`` 与 ``0x0000000040001234`` 是同一个地址。

    ★ addr2line 常把地址按位宽补零回显；不归一化就会「明明解出来了却取不到」。
    """
    s = str(a).strip().lower()
    try:
        return hex(int(s, 16))
    except ValueError:
        return s


def _parse_sym_content(content: str) -> dict:
    """解析 addr2line 的「内容段」：``func at file:line`` / ``file:line`` / ``func``。"""
    c = (content or "").strip()
    if not c or c.startswith("??"):
        return {"func": None, "file": None, "line": None}
    m = re.match(r"(.+?) at (.+):(\d+)$", c)
    if m:
        return {"func": m.group(1), "file": m.group(2), "line": int(m.group(3))}
    m2 = re.match(r"(.+):(\d+)$", c)
    if m2:
        return {"func": None, "file": m2.group(1), "line": int(m2.group(2))}
    return {"func": c, "file": None, "line": None}


def _parse_addr2line(out: str) -> dict[str, dict]:
    """把 addr2line 输出解析成 ``{归一化地址: {func,file,line}}``。

    要同时吃两种形态（同一次调用只会有一种，但 profile 的 args 由数据决定）：

        # 带 -a：地址单独一行
        0x0000000040001234
        app_main at /path/file.c:42

        # 不带 -a（如 -pfiaC）：地址与内容同一行
        0x4000d066: app_main at /path/file.c:89

    ★ 只认 -a 形态的解析器会让 `-pfiaC` 的 profile「全部解不出来」——
      实机就是这么发现的（ESP32-S31，2026-11-04）。
    """
    res: dict[str, dict] = {}
    cur: str | None = None
    for raw in out.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"0x([0-9a-fA-F]+):\s*(.*)$", line)
        if m:
            # 单行形态：地址与内容同处一行，解析完即结束
            addr = _canon_addr("0x" + m.group(1))
            if addr not in res:
                res[addr] = _parse_sym_content(m.group(2))
            cur = None
            continue
        if re.fullmatch(r"0x[0-9a-fA-F]+", line):
            cur = _canon_addr(line)
            continue
        if cur is None:
            continue
        if cur not in res:
            res[cur] = _parse_sym_content(line)
    return res


def symbolize(cfg: Config, project: str, addrs: list[str],
              profile: dict | None = None, *, timeout_s: float = 10.0) -> dict:
    """批量符号化。任何失败都**如实返回**，绝不编造函数名。"""
    addrs = [str(a).strip().lower() for a in addrs if str(a).strip()]
    if not addrs:
        return {"ok": False, "error": "addrs 为空", "symbols": []}
    for a in addrs:
        if not re.fullmatch(r"0x[0-9a-fA-F]+", a):
            return {"ok": False, "error": f"地址非法：{a!r}", "symbols": []}

    try:
        proj = cfg.resolved_project(project) if project else {}
    except Exception as exc:                          # noqa: BLE001
        return {"ok": False, "error": f"未知工程：{exc}", "symbols": []}
    elf = str(((proj.get("artifacts") or {}).get("elf") or "")).strip()
    if not elf:
        return {"ok": False, "error": "工程没有 artifacts.elf —— 先 build",
                "symbols": []}
    if not Path(elf).exists():
        return {"ok": False, "error": f"ELF 不存在：{elf}（先 build）",
                "symbols": []}
    try:
        mtime = os.path.getmtime(elf)
    except OSError:
        mtime = 0.0

    sym = dict((profile or {}).get("symbolize") or {})
    tool_key = str(sym.get("tool_key") or "addr2line")
    args = [str(a) for a in (sym.get("args") or ["-pfiaC"])]

    symbols: list[dict] = []
    pending: list[str] = []
    for a in addrs:
        # ★ 不再按地址前缀预先判定 ROM：ESP32-S31（RISC-V）的 IRAM 就在 0x4000xxxx，
        #   前缀猜会把**板上真实函数**误标成"ROM 地址"。addr2line 才是权威 ——
        #   解不出来时再回落到 ROM 前缀说明（见下方 note）。
        key = (os.path.abspath(elf), mtime, a)
        hit = _SYM_CACHE.get(key)
        if hit is not None:
            _SYM_CACHE.move_to_end(key)
            symbols.append(dict(hit))
            continue
        pending.append(a)

    if pending:
        try:
            argv, cwd = _tool_argv(cfg, project, tool_key, elf, args, pending)
        except FileNotFoundError as exc:
            return {"ok": False,
                    "error": f"{exc}；请安装地址解析工具或改用可用的 tool_key",
                    "symbols": symbols}
        try:
            proc = subprocess.run(argv, cwd=cwd or None, capture_output=True,
                                  text=True, timeout=timeout_s,
                                  encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return {"ok": False, "error": f"工具不存在：{argv[0]}",
                    "symbols": symbols}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"addr2line 超时（>{timeout_s}s）",
                    "symbols": symbols}
        if proc.returncode != 0:
            return {"ok": False,
                    "error": f"addr2line 失败（rc={proc.returncode}）："
                             f"{(proc.stderr or '').strip()[:400]}",
                    "symbols": symbols}
        parsed = _parse_addr2line(proc.stdout)
        for a in pending:
            rec = dict(parsed.get(_canon_addr(a)) or {"func": None, "file": None, "line": None})
            if str(rec.get("func") or "").strip() in ("", "??"):
                rec["func"] = None
            if str(rec.get("file") or "").strip() in ("", "??"):
                rec["file"] = None
            if rec["func"] is None and rec["file"] is None:
                # 解不出来才解释原因：ROM 前缀是"可能"，其余是"ELF 没这个地址"。
                rec["note"] = _rom_note(a, profile) or "ELF 中没有该地址的调试信息"
            rec = {"addr": a, **rec}
            key = (os.path.abspath(elf), mtime, a)
            _SYM_CACHE[key] = dict(rec)
            _SYM_CACHE.move_to_end(key)
            symbols.append(rec)
            while len(_SYM_CACHE) > _SYM_CACHE_MAX:
                _SYM_CACHE.popitem(last=False)

    # 保持调用方顺序
    order = {a: i for i, a in enumerate(addrs)}
    symbols.sort(key=lambda r: order.get(r["addr"], 999))
    ok = all(s.get("func") or s.get("note") for s in symbols)
    return {"ok": ok, "elf": elf, "tool": tool_key,
            "symbols": symbols,
            "error": None if ok else "部分地址无法解析（ROM 或调试信息缺失）"}
