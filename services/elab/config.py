"""elab.config —— 配置加载与变量插值（L0 主机层 / L1 芯片层 / L4 项目层）。

设计要点
--------
- **唯一主机事实源**：所有主机路径只在 ``elab.host.yaml`` 写一次，
  其余层只允许用 ``${...}`` 引用，禁止各自拼绝对路径。
- **变量插值**：``${ELAB_ROOT}`` = 本目录（elab-flow/）；项目作用域内还可用
  ``${root}`` / ``${work_dir}`` / ``${name}`` / ``${project_name}``。
  未命中的 ``${X}`` 回退到环境变量 ``X``；再未命中则原样保留（便于 doctor 报错）。
- 路径一律输出**正斜杠**形式（cmake / ninja / gcc 均接受），
  需要进 PATH 时另用 :func:`to_os_path`。
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from . import _yaml

_VAR_RE = re.compile(r"\$\{([^}]+)\}")


class ElabError(RuntimeError):
    """elab 的可预期错误（用户可修复），CLI 捕获后打印为 human 消息。"""


def to_fwd(p) -> str:
    """统一为正斜杠字符串（cmake 参数用）。"""
    s = str(p)
    return s.replace("\\", "/")


def to_os_path(p) -> str:
    """转为当前系统原生的路径字符串（PATH 用）。"""
    return os.path.normpath(str(p))


class Config:
    """elab-flow 配置树。

    ``root`` 默认取本文件所在包的上一级（= ``elab-flow/``），
    也可由环境变量 ``ELAB_ROOT`` 覆盖（CI 场景）。
    """

    def __init__(self, root=None):
        if root is None:
            root = os.environ.get("ELAB_ROOT")
        if root is None:
            root = Path(__file__).resolve().parents[2]  # services/elab/config.py -> elab-flow
        self.root = Path(root).resolve()
        self._host = None
        self._chips = None
        self._projects = None

    # ── L0 主机层 ────────────────────────────────────────────────
    @property
    def host_path(self) -> Path:
        return Path(os.environ.get("ELAB_HOST") or (self.root / "elab.host.yaml"))

    @property
    def host(self) -> dict:
        if self._host is None:
            if not self.host_path.exists():
                raise ElabError(f"找不到主机配置：{self.host_path}")
            self._host = _yaml.load_file(self.host_path) or {}
            self._host["_path"] = to_fwd(self.host_path)
        return self._host

    # ── L1 芯片层 ────────────────────────────────────────────────
    @property
    def chips(self) -> dict:
        """返回 ``{ref: chip}``，ref 同时支持 ``vendor/id`` 与裸 ``id``。"""
        if self._chips is None:
            out: dict[str, dict] = {}
            chips_dir = self.root / "chips"
            for path in sorted(chips_dir.rglob("*.yaml")):
                chip = _yaml.load_file(path) or {}
                if "id" not in chip:
                    raise ElabError(f"芯片文件缺少 id：{path}")
                chip["_path"] = to_fwd(path)
                ref = f"{chip.get('vendor')}/{chip['id']}"
                out[ref] = chip
                out.setdefault(chip["id"], chip)
            self._chips = out
        return self._chips

    # ── L4 项目层 ────────────────────────────────────────────────
    @property
    def projects(self) -> dict:
        if self._projects is None:
            out: dict[str, dict] = {}
            for path in sorted((self.root / "projects").glob("*.yaml")):
                proj = _yaml.load_file(path) or {}
                if "name" not in proj:
                    raise ElabError(f"项目文件缺少 name：{path}")
                proj["_path"] = to_fwd(path)
                out[proj["name"]] = proj
            self._projects = out
        return self._projects

    # ── 插值 ─────────────────────────────────────────────────────
    def project_ctx(self, proj: dict) -> dict:
        """构造项目作用域插值上下文（已解析的绝对值）。"""
        root = to_fwd(self.resolve(proj["root"], {}))
        build = proj.get("build") or {}
        ctx = {
            "ELAB_ROOT": to_fwd(self.root),
            "root": root,
            "name": proj.get("name", ""),
            "project_name": build.get("project_name", proj.get("name", "")),
        }
        # work_dir 可能自身引用 ${ELAB_ROOT}
        ctx["work_dir"] = to_fwd(self.resolve(build.get("work_dir", ""), ctx))
        return ctx

    def resolve(self, value, ctx: dict | None = None):
        """递归插值 ``${...}``。非字符串原样返回。"""
        if not isinstance(value, str):
            return value
        ctx = ctx or {}

        def sub(m: re.Match) -> str:
            key = m.group(1)
            if key in ctx:
                return str(ctx[key])
            if key == "ELAB_ROOT":
                return to_fwd(self.root)
            if key in os.environ:
                return os.environ[key]
            return m.group(0)

        for _ in range(10):
            new = _VAR_RE.sub(sub, value)
            if new == value:
                break
            value = new
        return value

    def resolve_deep(self, node, ctx: dict | None = None):
        """对整个 dict/list 递归插值。"""
        if isinstance(node, dict):
            return {k: self.resolve_deep(v, ctx) for k, v in node.items()}
        if isinstance(node, list):
            return [self.resolve_deep(v, ctx) for v in node]
        return self.resolve(node, ctx)

    # ── 组合视图 ─────────────────────────────────────────────────
    def resolved_project(self, name: str) -> dict:
        """取项目并完成全部插值（含 host 派生值）。"""
        if name not in self.projects:
            known = ", ".join(sorted(self.projects)) or "(无)"
            raise ElabError(f"未知项目：{name}（可选：{known}）")
        proj = dict(self.projects[name])
        ctx = self.project_ctx(proj)
        proj = self.resolve_deep(proj, ctx)
        proj["_ctx"] = ctx
        return proj

    def chip_of(self, proj: dict) -> dict:
        ref = proj.get("chip")
        if ref not in self.chips:
            raise ElabError(f"项目 {proj.get('name')} 引用了未知芯片：{ref}")
        return self.chips[ref]


class Host:
    """L0 主机层的**已解析视图**：把 elab.host.yaml 变成可直接用的路径。"""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.data = cfg.host
        self.raw = self.data
        self._resolve_env()

    def _resolve_env(self):
        os_name = (self.data.get("host") or {}).get("os", "auto")
        if os_name in (None, "", "auto"):
            if os.name == "nt":
                os_name = "windows"
            else:
                os_name = "macos" if sys.platform == "darwin" else "linux"
        self.os = os_name
        self.is_windows = self.os == "windows"

        ext = (self.data.get("host") or {}).get("exec_ext", "auto")
        if ext in (None, "", "auto"):
            ext = ".exe" if self.is_windows else ""
        self.exec_ext = ext

    # ── 工具链 ───────────────────────────────────────────────────
    def toolchain(self, name: str) -> dict:
        return (self.data.get("toolchains") or {}).get(name) or {}

    @property
    def gcc(self) -> dict:
        return self.toolchain("arm-none-eabi")

    @property
    def gcc_root(self) -> str:
        return to_fwd(self.gcc.get("root", ""))

    @property
    def gcc_bin(self) -> str:
        return f"{self.gcc_root}/bin"

    def _gb(self, tool: str) -> str:
        return f"{self.gcc_bin}/{tool}{self.exec_ext}"

    @property
    def cc(self) -> str:
        return self._gb("arm-none-eabi-gcc")

    @property
    def objcopy(self) -> str:
        return self._gb("arm-none-eabi-objcopy")

    @property
    def size(self) -> str:
        return self._gb("arm-none-eabi-size")

    @property
    def gdb(self) -> str:
        spec = (self.data.get("tools") or {}).get("gdb") or {}
        src = spec.get("from", "arm-none-eabi")
        if src == "arm-none-eabi":
            return self._gb("arm-none-eabi-gdb")
        return spec.get("path", "")

    # ── 主机工具 ─────────────────────────────────────────────────
    @property
    def cmake(self) -> str:
        return ((self.data.get("tools") or {}).get("cmake") or {}).get("path", "auto")

    @property
    def cmake_min(self) -> str:
        return ((self.data.get("tools") or {}).get("cmake") or {}).get("min", "3.15")

    @property
    def ninja(self) -> str:
        return ((self.data.get("tools") or {}).get("ninja") or {}).get("path", "")

    @property
    def openocd(self) -> str:
        return ((self.data.get("tools") or {}).get("openocd") or {}).get("path", "")

    @property
    def openocd_scripts(self) -> str:
        return ((self.data.get("tools") or {}).get("openocd") or {}).get("scripts", "")

    @property
    def probes(self) -> dict:
        return (self.data.get("probes") or {}).get("list") or {}

    def probe(self, name: str) -> dict:
        return self.probes.get(name) or {}

    @property
    def serial(self) -> dict:
        return self.data.get("serial") or {}

    # ── SVD ─────────────────────────────────────────────────────
    @property
    def svd_roots(self) -> list[str]:
        """SVD 搜索根（L0 声明）。chip.yaml 只写文件名，目录在这里。"""
        return [to_fwd(p) for p in (self.data.get("svd_roots") or [])]

    def resolve_svd(self, name):
        """按文件名在 svd_roots 下查找；也接受 chip.yaml 直接给绝对路径。"""
        if not name:
            return None
        p = Path(str(name))
        if p.is_absolute():
            return to_fwd(p) if p.exists() else None
        for root in self.svd_roots:
            cand = Path(root) / str(name)
            if cand.exists():
                return to_fwd(cand)
        return None

    # ── PATH ─────────────────────────────────────────────────────
    def path_prepend(self) -> list[str]:
        """按 D1 决策，返回需要前置进 PATH 的目录（原生路径形式）。"""
        dirs = []
        if self.gcc.get("prepend_path", True) and self.gcc_root:
            dirs.append(self.gcc_bin)
        return dirs

    def build_env(self) -> dict:
        """构造子进程环境：前置工具链 bin，并注入 ELAB_* 事实。"""
        env = dict(os.environ)
        prepend = [to_os_path(d) for d in self.path_prepend() if d]
        if prepend:
            env["PATH"] = os.pathsep.join(prepend + [env.get("PATH", "")])
        env["ELAB_ARM_GCC_ROOT"] = self.gcc_root
        env["ELAB_ROOT"] = to_fwd(self.cfg.root)
        return env
