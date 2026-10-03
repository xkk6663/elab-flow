"""elab._yaml —— 极小 YAML 子集读取器（仅标准库）

为什么不用 PyYAML
-----------------
elab-Flow 的第一原则是"不依赖主机"。让它零第三方依赖，
任何装了 python3 的机器/CI 都能直接跑 `elab`，不必先 `pip install pyyaml`。

支持的子集（= elab-flow 全部配置文件实际用到的语法）
----------------------------------------------------
- 缩进块映射 / 块序列
- 流式序列 ``[a, b]`` 与流式映射 ``{k: v, ...}``（可嵌套）
- 标量：裸串 / 单引号 / 双引号；整数（十进制与 0x 十六进制）；
  浮点；布尔 true/false；空 null/~
- 注释：``#`` 整行或行尾（引号内的 ``#`` 不算注释）
- 序列项为映射：``- key: val``，后续同列键自动续行

刻意不支持（保持解析器极小，且本项目的配置永远不会用到）
--------------------------------------------------------
锚点/别名 ``&x`` ``*x``、多行标量 ``|`` ``>``、标签 ``!!``、
复杂键 ``?``、合并键 ``<<``、文档分隔符 ``---``。
"""

from __future__ import annotations

import re

_BOOL_TRUE = {"true", "yes", "on"}
_BOOL_FALSE = {"false", "no", "off"}
_NULL_WORDS = {"null", "~"}

_INT_RE = re.compile(r"^[+-]?\d+$")
_HEX_RE = re.compile(r"^[+-]?0[xX][0-9a-fA-F]+$")
_FLOAT_RE = re.compile(r"^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$")


class YamlError(ValueError):
    """配置文件语法错误。"""


# ── 预处理 ────────────────────────────────────────────────────────
def _strip_comment(line: str) -> str:
    """去掉行尾注释。``#`` 只有在行首或前面是空白、且不在引号内时才是注释。"""
    in_s = in_d = False
    for i, ch in enumerate(line):
        if ch == "'" and not in_d:
            in_s = not in_s
        elif ch == '"' and not in_s:
            in_d = not in_d
        elif ch == "#" and not in_s and not in_d:
            if i == 0 or line[i - 1] in " \t":
                return line[:i]
    return line


def _tokenize(text: str):
    """把文本切成 ``(indent, body)`` 列表，跳过空行与整行注释。"""
    lines = []
    for raw in text.splitlines():
        head = raw[: len(raw) - len(raw.lstrip())]
        if "\t" in head:
            raise YamlError(f"YAML 不支持 tab 缩进：{raw!r}")
        s = _strip_comment(raw).rstrip()
        if not s.strip():
            continue
        indent = len(s) - len(s.lstrip(" "))
        lines.append((indent, s[indent:]))
    return lines


# ── 键值切分 / 流式切分 ───────────────────────────────────────────
def _find_key_colon(s: str) -> int:
    """返回顶层 ``:``（其后是空白或行尾）的下标，找不到返回 -1。"""
    depth = 0
    in_s = in_d = False
    for i, ch in enumerate(s):
        if ch == "'" and not in_d:
            in_s = not in_s
            continue
        if ch == '"' and not in_s:
            in_d = not in_d
            continue
        if in_s or in_d:
            continue
        if ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == ":" and depth == 0:
            nxt = s[i + 1 : i + 2]
            if nxt == "" or nxt == " ":
                return i
    return -1


def _split_kv(s: str):
    """把 ``key: value`` 切成 ``(key, value)``；不是映射项则返回 None。"""
    i = _find_key_colon(s)
    if i < 0:
        return None
    return s[:i].strip(), s[i + 1 :].strip()


def _split_top(s: str, sep: str = ","):
    """按顶层分隔符切分（忽略引号内与 ``[]{}`` 内的分隔符）。"""
    parts, cur = [], []
    depth = 0
    in_s = in_d = False
    for ch in s:
        if ch == "'" and not in_d:
            in_s = not in_s
        elif ch == '"' and not in_s:
            in_d = not in_d
        if not in_s and not in_d:
            if ch in "[{":
                depth += 1
            elif ch in "]}":
                depth -= 1
            elif ch == sep and depth == 0:
                parts.append("".join(cur))
                cur = []
                continue
        cur.append(ch)
    parts.append("".join(cur))
    return parts


# ── 标量 ──────────────────────────────────────────────────────────
def _unescape_double(s: str) -> str:
    out, i = [], 0
    table = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/", "0": "\0"}
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            out.append(table.get(s[i + 1], s[i + 1]))
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _scalar(s: str):
    if s == "":
        return None
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return _unescape_double(s[1:-1])
    if len(s) >= 2 and s[0] == "'" and s[-1] == "'":
        return s[1:-1].replace("''", "'")
    low = s.lower()
    if low in _NULL_WORDS:
        return None
    if low in _BOOL_TRUE:
        return True
    if low in _BOOL_FALSE:
        return False
    if _HEX_RE.match(s):
        return int(s, 16)
    if _INT_RE.match(s):
        return int(s)
    if _FLOAT_RE.match(s):
        try:
            return float(s)
        except ValueError:
            pass
    return s


def _parse_value(s: str):
    """解析一个"值"：流式序列 / 流式映射 / 标量。"""
    s = s.strip()
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        return [] if not inner else [_parse_value(p) for p in _split_top(inner)]
    if s.startswith("{") and s.endswith("}"):
        inner = s[1:-1].strip()
        if not inner:
            return {}
        out = {}
        for part in _split_top(inner):
            kv = _split_kv(part)
            if kv is None:
                raise YamlError(f"流式映射项缺少 ':'：{part!r}")
            out[kv[0]] = _parse_value(kv[1])
        return out
    return _scalar(s)


# ── 块解析 ────────────────────────────────────────────────────────
def _parse_map(lines, i: int, indent: int):
    out = {}
    while i < len(lines):
        ind, body = lines[i]
        if ind < indent:
            break
        if ind > indent:
            raise YamlError(f"意外的缩进：{body!r}（第 {i + 1} 行）")
        if body == "-" or body.startswith("- "):
            break
        kv = _split_kv(body)
        if kv is None:
            break
        key, rest = kv
        if rest == "":
            if i + 1 < len(lines) and lines[i + 1][0] > indent:
                val, i = _parse_block(lines, i + 1)
            else:
                val, i = None, i + 1
        else:
            val, i = _parse_value(rest), i + 1
        out[key] = val
    return out, i


def _parse_seq(lines, i: int, indent: int):
    out = []
    while i < len(lines):
        ind, body = lines[i]
        if ind != indent or not (body == "-" or body.startswith("- ")):
            break
        after = body[1:]
        lead = len(after) - len(after.lstrip(" "))
        content = after.strip()
        content_indent = indent + 1 + lead
        if content == "":
            if i + 1 < len(lines) and lines[i + 1][0] > indent:
                val, i = _parse_block(lines, i + 1)
            else:
                val, i = None, i + 1
        elif _split_kv(content) is not None:
            # 序列项本身是映射：就地改写为映射起始行，交给映射解析器吃掉续行
            lines[i] = (content_indent, content)
            val, i = _parse_map(lines, i, content_indent)
        else:
            val, i = _parse_value(content), i + 1
        out.append(val)
    return out, i


def _parse_block(lines, i: int):
    ind, body = lines[i]
    if body == "-" or body.startswith("- "):
        return _parse_seq(lines, i, ind)
    if _split_kv(body) is not None:
        return _parse_map(lines, i, ind)
    return _parse_value(body), i + 1


# ── 公开接口 ──────────────────────────────────────────────────────
def load(text: str):
    """解析 YAML 子集文本。"""
    lines = _tokenize(text)
    if not lines:
        return None
    val, i = _parse_block(lines, 0)
    if i != len(lines):
        raise YamlError(f"解析在 {lines[i][1]!r}（第 {i + 1} 行）处提前结束")
    return val


def load_file(path):
    """解析 YAML 子集文件。"""
    with open(path, "r", encoding="utf-8") as f:
        return load(f.read())
