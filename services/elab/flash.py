"""elab.flash / elab.debug —— 烧录与调试（openocd + gdb）。

cfg 路径全部来自 ``chips/*.yaml`` 的 ``debug.openocd_target/interface``，
可执行文件来自 ``elab.host.yaml`` 的 ``tools.openocd``，
探针来自 ``projects/*.yaml`` 的 ``debug.probe``。三份数据各管一段，无一处硬编码。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .config import ElabError, to_fwd
from .plan import Plan


def _openocd_argv(plan: Plan, commands: str) -> list[str]:
    chip = plan.chip
    dbg = chip.get("debug") or {}
    host = plan.host

    if not host.openocd:
        raise ElabError("elab.host.yaml 未声明 tools.openocd.path")
    if not host.openocd_scripts:
        raise ElabError("elab.host.yaml 未声明 tools.openocd.scripts")

    # ★ interface cfg 属于【探针】（L0），target cfg 属于【芯片】（L1）—— 两者正交。
    #   SWD 就是 SWD：同一个 DAP-Link 换 target cfg 就能连不同厂家的芯片。
    #   优先级：probe.interface_cfg → chip.debug.openocd_interface（罕见覆盖）→ 由 backend 推导。
    probe = host.probe(plan.probe) if plan.probe else {}
    interface = probe.get("interface_cfg")
    if not interface:
        interface = dbg.get("openocd_interface")
    if not interface and probe.get("backend"):
        interface = f"interface/{probe['backend']}.cfg"

    target = dbg.get("openocd_target")
    if not interface or not Path(host.openocd_scripts, interface).exists():
        raise ElabError(f"openocd interface cfg 不可用：{interface!r}")
    if not target or not Path(host.openocd_scripts, target).exists():
        raise ElabError(f"openocd target cfg 不可用：{target!r}")

    argv = [to_fwd(host.openocd), "-s", to_fwd(host.openocd_scripts),
            "-f", interface, "-f", target]
    # 探针声明的速率（若有）以命令形式追加，不覆盖 cfg 内的其它设置
    if probe.get("speed"):
        argv += ["-c", f"adapter speed {probe['speed']}"]
    if commands:
        argv += ["-c", commands]
    return argv


_EVIDENCE = ("**", "device id", "flash size", "wrote", "Verified", "Programming")


def _salient(text: str) -> list[str]:
    """从 openocd 输出里挑出"证据行"（编程/校验/芯片 ID），滤掉刷屏噪音。"""
    out = []
    for line in (text or "").splitlines():
        s = line.strip()
        if not s:
            continue
        if any(k in s for k in _EVIDENCE):
            out.append(s)
    return out


def flash(plan: Plan, *, dry_run: bool = False, verbose: bool = False, log=print,
          allow_missing_elf: bool = False) -> dict:
    """烧录。

    :param allow_missing_elf: **仅预览用**。默认 ``False``（真烧录时 ELF 不在就必须报错，
        否则 openocd 会去 program 一个不存在的文件，报出来的错离根因很远）。
        预览（``elab run --dry-run`` / ``/api/plan``）要能在**还没 build** 时
        就显示待执行的 openocd 命令行，故允许显式放开这一条 —— 用参数而不是
        "预览自己拼一遍命令"，是为了让命令构造**只有一个来源**。
    """
    elf = plan.elf
    if not elf or (not allow_missing_elf and not Path(elf).exists()):
        raise ElabError(f"ELF 不存在，请先 `elab build -p {plan.name}`：{elf}")
    if not elf:
        raise ElabError(f"项目未声明产物 artifacts.elf：{plan.name}")

    argv = _openocd_argv(plan, f"program {{{to_fwd(elf)}}} verify reset exit")
    res = {"project": plan.name, "chip": plan.chip.get("id"), "elf": to_fwd(elf),
           "argv": argv, "status": "dry-run" if dry_run else "pending",
           "elf_exists": Path(elf).exists()}
    if dry_run:
        return res

    env = plan.host.build_env()
    proc = subprocess.run(argv, cwd=str(plan.cfg.root), env=env, text=True,
                          capture_output=True, errors="replace")
    combined = (proc.stdout or "") + (proc.stderr or "")
    res["stdout"] = proc.stdout
    res["stderr"] = proc.stderr
    res["evidence"] = _salient(combined)

    if verbose:
        log(combined)

    if proc.returncode == 0:
        res["status"] = "ok"
        log(f"[elab] ✓ 烧录完成：{Path(elf).name} → {plan.chip.get('debug', {}).get('device')}")
        for line in res["evidence"]:
            log(f"       {line}")
    else:
        res["status"] = "failed"
        tail = "\n".join(combined.strip().splitlines()[-12:])
        log("[elab] ✗ 烧录失败：\n" + tail)
    return res


def _wait_port(port: int = 3333, timeout: float = 20.0, host: str = "127.0.0.1") -> bool:
    """等 openocd 的 gdb server 端口可连。"""
    import socket
    import time as _t

    t0 = _t.time()
    while _t.time() - t0 < timeout:
        try:
            with socket.create_connection((host, port), 0.5):
                return True
        except OSError:
            _t.sleep(0.2)
    return False


def debug(plan: Plan, *, mode: str = "print", log=print,
          allow_missing_elf: bool = False) -> dict:
    """调试闭环。

    mode:
      print  —— 只打印 openocd + gdb 命令（不连板）
      run    —— 起 openocd 服务 + 交互式 gdb（人在终端里调试）
      verify —— 非交互自检：断到 main 后打印证据并退出（可被判 PASS/FAIL）

    ``allow_missing_elf`` 语义同 :func:`flash`（仅预览放开）。
    """
    elf = plan.elf
    if not elf or (not allow_missing_elf and not Path(elf).exists()):
        raise ElabError(f"ELF 不存在，请先 `elab build -p {plan.name}`：{elf}")
    if not elf:
        raise ElabError(f"项目未声明产物 artifacts.elf：{plan.name}")

    server = _openocd_argv(plan, "")
    gdb_bin = plan.host.gdb or "arm-none-eabi-gdb"
    gdb_cmd = [
        gdb_bin, to_fwd(elf),
        "-ex", "target extended-remote localhost:3333",
        "-ex", "monitor reset halt",
        "-ex", "load",
    ]
    if plan.gdb_script:
        gdb_cmd += ["-x", plan.gdb_script]

    res = {"project": plan.name, "openocd": server, "gdb": gdb_cmd, "mode": mode,
           "status": "printed"}
    if mode == "print":
        return res

    env = plan.host.build_env()
    srv = subprocess.Popen(server, cwd=str(plan.cfg.root), env=env,
                           text=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        if not _wait_port(3333, 20):
            res["status"] = "no-server"
            log("[elab] ✗ openocd gdb server 未在 20s 内就绪")
            return res

        if mode == "verify":
            batch = [
                gdb_bin, to_fwd(elf), "-batch", "-q",
                "-ex", "target extended-remote localhost:3333",
                "-ex", "monitor reset halt",
                "-ex", "load",
                "-ex", "break main",
                "-ex", "continue",
                "-ex", 'printf "ELAB_STOP pc=%p\\n", $pc',
                "-ex", "info registers pc sp",
                "-ex", "bt",
                # ★ 收尾必须是 reset **run** 而不是 reset halt：
                #   自检结束后若把 MCU 留在暂停态，后续的串口闭环（loop 第⑤步）
                #   会一个字节都收不到 —— 板子根本没在跑。自检不该把板子弄死。
                "-ex", "monitor reset run",
            ]
            try:
                r = subprocess.run(batch, cwd=str(plan.cfg.root), env=env,
                                   capture_output=True, text=True, errors="replace",
                                   timeout=90)
            except subprocess.TimeoutExpired:
                res["status"] = "timeout"
                log("[elab] ✗ gdb 在 90s 内未跑到断点（可能未连上或程序未跑到 main）")
                return res
            out = (r.stdout or "") + (r.stderr or "")
            res["gdb_output"] = out
            hit_bp = "Breakpoint 1," in out and "main" in out
            stopped = "ELAB_STOP" in out
            res["hit_main"] = hit_bp or stopped
            res["evidence"] = [ln.strip() for ln in out.splitlines()
                               if ln.strip() and ("Breakpoint 1," in ln or "ELAB_STOP" in ln
                                                  or ln.strip().startswith("pc ")
                                                  or "#0 " in ln)]
            if res["hit_main"]:
                res["status"] = "ok"
                log("[elab] ✓ 调试闭环成立：已断到 main")
                for line in res["evidence"]:
                    log(f"       {line}")
            else:
                res["status"] = "failed"
                log("[elab] ✗ 未能断到 main，gdb 尾部输出：")
                log("\n".join(out.strip().splitlines()[-12:]))
            return res

        # mode == run：交互式
        log("[elab] 已连上；gdb 退出后 openocd 会被关闭。")
        subprocess.run(gdb_cmd, cwd=str(plan.cfg.root), env=env)
        res["status"] = "ok"
        return res
    finally:
        srv.terminate()
        try:
            srv.wait(5)
        except subprocess.SubprocessError:
            srv.kill()


def _which(name: str):
    return shutil.which(name)
