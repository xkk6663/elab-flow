"""elab.plan —— 把 (项目, 芯片, 主机) 三份数据编译成一份可执行构建计划。

``doctor`` 与 ``build`` **共用**同一份 plan，从根上杜绝"校验的命令 ≠ 执行的命令"。
plan 里没有任何路径是手写的：全部来自 YAML 插值 + L0 主机层派生。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .config import Config, ElabError, Host, to_fwd


@dataclass
class Plan:
    cfg: Config
    host: Host
    proj: dict
    chip: dict
    name: str = ""
    source_dir: str = ""
    work_dir: str = ""
    generator: str = "Ninja"
    toolchain_file: str = ""
    project_include: str = ""
    linker_script: str = ""
    build_type: str = "Debug"
    project_name: str = ""
    cmake_args: list[str] = field(default_factory=list)
    artifacts: dict = field(default_factory=dict)
    probe: str = ""
    gdb_script: str = ""

    # ── 派生路径 ────────────────────────────────────────────────
    @property
    def elf(self) -> str:
        return self.artifacts.get("elf", "")

    @property
    def hex(self) -> str:
        return self.artifacts.get("hex", "")

    @property
    def bin(self) -> str:
        return self.artifacts.get("bin", "")

    @property
    def map_file(self) -> str:
        return self.artifacts.get("map", "")

    def configure_cmd(self) -> list[str]:
        """cmake configure 命令行（与干跑验证报告里的手工命令逐字对应）。"""
        cmake = self.host.cmake
        if cmake in ("", "auto", None):
            cmake = "cmake"
        cmd = [
            cmake,
            "-S",
            self.source_dir,
            "-B",
            self.work_dir,
            "-G",
            self.generator,
        ]
        cmd += self.cmake_args
        return cmd

    def build_cmd(self) -> list[str]:
        cmake = self.host.cmake
        if cmake in ("", "auto", None):
            cmake = "cmake"
        return [cmake, "--build", self.work_dir]

    def shell_preview(self) -> str:
        """给人类/CI 阅读的单行预览。"""
        return " \\\n  ".join(_shell_join(a) for a in [self.configure_cmd()])


def _shell_join(parts: list[str]) -> str:
    out = []
    for p in parts:
        out.append(f'"{p}"' if (" " in p or "(" in p) else p)
    return " ".join(out)


def plan_for(cfg: Config, proj_name: str) -> Plan:
    """构造一个项目的构建计划。"""
    cfg.host  # 触发 L0 加载（缺文件时立刻报错）
    host = Host(cfg)
    proj = cfg.resolved_project(proj_name)
    chip = cfg.chip_of(proj)
    build = proj.get("build") or {}

    if build.get("kind", "cmake") != "cmake":
        raise ElabError(f"暂不支持的构建类型：{build.get('kind')}（目前仅 cmake）")

    p = Plan(cfg=cfg, host=host, proj=proj, chip=chip, name=proj_name)
    p.source_dir = to_fwd(proj.get("root", ""))
    p.work_dir = to_fwd(build.get("work_dir", ""))
    p.generator = build.get("generator", "Ninja")
    p.toolchain_file = to_fwd(build.get("toolchain_file", ""))
    p.project_include = to_fwd(build.get("project_include", ""))
    p.linker_script = to_fwd(build.get("linker_script", ""))
    p.build_type = build.get("build_type", "Debug")
    p.project_name = build.get("project_name", proj_name)
    p.artifacts = proj.get("artifacts") or {}
    p.probe = (proj.get("debug") or {}).get("probe", "")
    p.gdb_script = to_fwd((proj.get("debug") or {}).get("gdb_script", ""))

    core = chip.get("core") or {}
    args: list[str] = []

    # ninja：用 -DCMAKE_MAKE_PROGRAM 注入，不依赖预设
    if p.generator == "Ninja":
        if not host.ninja:
            raise ElabError("generator=Ninja 但 elab.host.yaml 未声明 tools.ninja.path")
        args.append(f"-DCMAKE_MAKE_PROGRAM={to_fwd(host.ninja)}")

    # ★ 两个技术支点：命令行接管工具链 + project() 之后盖章芯片参数
    if p.toolchain_file:
        args.append(f"-DCMAKE_TOOLCHAIN_FILE={p.toolchain_file}")
    if p.project_include:
        args.append(f"-DCMAKE_PROJECT_INCLUDE={p.project_include}")

    # 主机事实（D1：让工具链文件自己也能定位 compiler 目录）
    args.append(f"-DELAB_ARM_GCC_ROOT={host.gcc_root}")
    # 芯片差异 —— 全部的跨芯片差异就浓缩在这 4 个值里
    args.append(f"-DELAB_CPU={core.get('cpu', '')}")
    args.append(f"-DELAB_FPU={core.get('fpu', '')}")
    args.append(f"-DELAB_CHIP={chip.get('id', '')}")
    if p.linker_script:
        args.append(f"-DELAB_LD={p.linker_script}")

    # ★ N6 修复：-Wl,-Map 的落点由 plan 显式下传。
    #   两种工程各丢一次，原因相反，所以不能靠"工程自带的工具链"来留它：
    #     【B 类】AT32 的 CMakeLists 在 project() 之前 include 自带工具链，
    #            其 -Wl,-Map 落在 CMAKE_C_LINK_FLAGS 里，被 inject.cmake 的
    #            unset(CMAKE_C_LINK_FLAGS) 一并清掉（该 unset 是为了消除双份 -T）。
    #     【A 类】STM32 的工具链只挂在 CMakePresets 的 toolchainFile 上，elab 用
    #            -DCMAKE_TOOLCHAIN_FILE 接管后该文件【根本不执行】→ 从未有过 Map。
    #   也不靠 ${CMAKE_PROJECT_NAME} 反推文件名（E6 猜测）：at32_test 就手写了
    #   set(CMAKE_PROJECT_NAME TEST)，一旦与 artifacts.map 的基名漂移就会静默错位。
    map_path = p.artifacts.get("map") or ""
    if map_path:
        args.append(f"-DELAB_MAP_FILE={to_fwd(map_path)}")

    args.append(f"-DCMAKE_BUILD_TYPE={p.build_type}")
    p.cmake_args = args
    return p
