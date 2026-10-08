"""elab.flash / elab.debug —— 烧录与调试（openocd + gdb）。

cfg 路径全部来自 ``chips/*.yaml`` 的 ``debug.openocd_target/interface``，
可执行文件来自 ``elab.host.yaml`` 的 ``tools.openocd``，
探针来自 ``projects/*.yaml`` 的 ``debug.probe``。三份数据各管一段，无一处硬编码。
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path

from ._winproc import proc_kwargs
from .config import ElabError, to_fwd
from .plan import Plan, plan_for


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
        argv += ["-c", f"adapter speed {probe.get('speed')}"]
    # commands 支持 str（单条）与 list（多条，各占一个 -c）——
    # 多镜像烧录（C33）需要串联 program 序列，不能拼成一个字符串。
    if commands:
        for c in ([commands] if isinstance(commands, str) else commands):
            argv += ["-c", c]
    return argv


_EVIDENCE = ("**", "device id", "flash size", "wrote", "Verified", "Programming")


# ── C2/C3 组合工程：boot 烧录台账（冻结策略）─────────────────────
def _boot_stamp_path(plan: Plan) -> Path:
    return Path(plan.cfg.root) / ".work" / plan.boot_project / "flash_stamp.json"


def _stamp_load(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def boot_stamp(cfg_root, boot_project: str) -> dict | None:
    """C3 boot 烧录台账的**公共读取口**（驾驶舱 project_cards 投影复用）。
    路径约定单源：与 _boot_stamp_path 同一规则 `<root>/.work/<boot>/flash_stamp.json`。"""
    return _stamp_load(Path(cfg_root) / ".work" / boot_project / "flash_stamp.json")


def _stamp_save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                    encoding="utf-8")


def _fmt_version(version) -> str:
    return ".".join(str(x) for x in version) if version else "?"


def boot_flash_decision(boot_plan: Plan, *, stamp: dict | None = None,
                        force: bool = False) -> dict:
    """★ C2/C3 纯判定（可单测）：boot bin 指纹 vs 烧录台账。

    冻结策略（C3）：boot 产物指纹与上次烧录一致 → 跳过（boot 是回滚资本的
    资本，不被日常 app 烧录触碰）；仅当首次烧录 / boot 版本更新 / --reflash-boot
    时才进烧录会话。

    :return: ``{"action": "skip"|"flash", "md5", "version", "reason", "bin"}``
    :raises ElabError: boot 产物缺失（先 build boot）
    """
    bin_path = boot_plan.bin
    if not bin_path:
        raise ElabError(f"boot 工程 {boot_plan.name} 未声明 artifacts.bin")
    if not Path(bin_path).exists():
        raise ElabError(
            f"boot 产物缺失，请先 `elab build -p {boot_plan.name}`：{bin_path}")
    md5 = hashlib.md5(Path(bin_path).read_bytes()).hexdigest()
    ver = _fmt_version(boot_plan.version)
    if not force and stamp and stamp.get("md5") == md5:
        return {"action": "skip", "md5": md5, "version": ver, "bin": bin_path,
                "reason": f"boot 冻结（v{ver} 指纹一致，上次烧录 "
                          f"{stamp.get('flashed_at', '?')}）"}
    reason = ("--reflash-boot 强制重烧" if force else
              ("无烧录台账（首次/换板/手动擦除过 boot）" if not stamp else
               "boot 产物已更新（指纹不一致）→ 随本次烧录带上"))
    return {"action": "flash", "md5": md5, "version": ver, "bin": bin_path,
            "reason": reason}


def _boot_context(plan: Plan, *, force: bool = False, log=print) -> dict | None:
    """C2 挂点：plan.boot_project 声明时解析 boot 工程并做冻结判定。

    返回 ``{"plan": boot_plan, **decision}`` 或 None（未声明/跳过级联）。
    """
    if not plan.boot_project or not plan.flash_images:
        if plan.boot_project and not plan.flash_images:
            log("[elab] WARN 声明了 ota_layout.boot_project 但未声明 "
                "flash.images → C2 boot 级联跳过（单镜像模式）")
        return None
    boot_plan = plan_for(plan.cfg, plan.boot_project)
    d = boot_flash_decision(boot_plan, stamp=_stamp_load(_boot_stamp_path(plan)),
                            force=force)
    log(f"[elab] C2 boot 决策：{d['action']} —— {d['reason']}")
    return {"plan": boot_plan, **d}


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
          allow_missing_elf: bool = False, reflash_boot: bool = False) -> dict:
    """烧录。

    :param allow_missing_elf: **仅预览用**。默认 ``False``（真烧录时 ELF 不在就必须报错，
        否则 openocd 会去 program 一个不存在的文件，报出来的错离根因很远）。
        预览（``elab run --dry-run`` / ``/api/plan``）要能在**还没 build** 时
        就显示待执行的 openocd 命令行，故允许显式放开这一条 —— 用参数而不是
        "预览自己拼一遍命令"，是为了让命令构造**只有一个来源**。

    :param reflash_boot: ★ C2/C3 组合工程：忽略 boot 烧录台账强制重烧 boot。

    双镜像模式（C33）：项目声明了 ``flash.images`` 时走 :func:`_flash_images`，
    一次 openocd 会话按声明顺序 program 全部镜像，最后统一 ``reset run``。
    ★ C2 组合工程：plan.boot_project 声明时，boot 镜像是否进会话由
    :func:`boot_flash_decision` 的台账判定决定（冻结 = boot 镜像被剔除）。
    """
    boot_ctx = None
    try:
        boot_ctx = _boot_context(plan, force=reflash_boot, log=log)
    except ElabError as e:
        # dry-run 预览时 boot 可能还没 build —— 预览降级为展示声明镜像，
        # 真跑时再 fail-fast（boot bin 缺失在 decision 里必报错）。
        log(f"[elab] WARN C2 boot 决策失败：{e}")

    if plan.flash_images:
        return _flash_images(plan, dry_run=dry_run, verbose=verbose, log=log,
                             allow_missing=allow_missing_elf, boot_ctx=boot_ctx)

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
                          capture_output=True, errors="replace", **proc_kwargs())
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


def _samefile(a: str, b: str) -> bool:
    """路径等价判断（容忍 ${ELAB_ROOT} 与 ${work_dir} 两种写法指向同一文件；
    文件不存在时 resolve() 走非严格模式，照样可比）。"""
    try:
        return Path(a).resolve() == Path(b).resolve()
    except OSError:
        return False


def _flash_images(plan: Plan, *, dry_run: bool, verbose: bool, log,
                  allow_missing: bool, boot_ctx: dict | None = None) -> dict:
    """多镜像烧录（C33）—— **命令构造的唯一来源**（预览与实跑共用本函数）。

    为什么是"一次会话串多个 -c"而不是"每镜像一次 openocd"：
      * Bootloader 与 APP 必须作为一个原子整体落到 Flash —— 分两次会话时，
        第一镜像烧完的复位窗口会把芯片带到半成品状态（boot 在、app 旧/缺）；
      * 少一次 USB/SWD 连接，DAP-Link 复合设备被串口占用的窗口更短（N5）。

    命令形态（M2 教训的落地）：
      - elf 镜像：``program {file} verify`` —— 地址由 elf 自带；
      - bin  镜像：``program {file} {address} verify`` —— **必须显式地址**：
        openocd 对 elf 的 program 会从擦除粒度边界向下对齐起擦，app.elf 的
        LMA 0x08004800 被向下对齐到 0x08004000，覆盖 Bootloader 尾部 2KB
        （业务工程 CMakeLists 注释实测实锤）；bin+显式地址不做向下对齐。
      - 收尾：``reset run`` + ``shutdown`` —— 留运行态（与 debug 同约定）。

    ★ C2/C3 组合工程：``boot_ctx`` 由 :func:`_boot_context` 产出——
      action=flash → boot 镜像（boot 工程 flash.images）进会话头部，
      声明镜像里指向同一 boot bin 的条目去重；action=skip（冻结）→
      从声明镜像中剔除 boot bin 条目，boot 字节在本次会话中零触碰。
    """
    images_src: list[dict] = list(plan.flash_images)
    if boot_ctx:
        boot_bin = boot_ctx["bin"]
        others = [i for i in images_src if not _samefile(i["path"], boot_bin)]
        if boot_ctx["action"] == "flash":
            images_src = list(boot_ctx["plan"].flash_images) + others
        else:
            images_src = others
            log(f"[elab] C3 boot 冻结：本次会话不含 boot 镜像"
                f"（v{boot_ctx.get('version', '?')}，字节级零触碰）")

    imgs: list[dict] = []
    cmds: list[str] = []
    for img in images_src:
        path = to_fwd(img["path"])
        addr = img.get("address") or ""
        exists = Path(path).exists()
        if not exists and not allow_missing:
            raise ElabError(
                f"镜像不存在，请先 `elab build -p {plan.name}`：{path}"
            )
        # ★ 命令构造与存在性检查解耦（C26：预览 = 实跑）——预览时镜像可能
        #   还没 build，但命令行必须原样展示，否则"先看命令再执行"就是误导。
        if img["format"] == "elf" and not addr:
            cmds.append(f"program {{{path}}} verify")
        else:
            # bin 必带地址（plan 校验保证）；elf 显式给了地址则作为 offset 传入
            cmds.append(f"program {{{path}}} {addr} verify")
        imgs.append({"path": path, "format": img["format"], "address": addr,
                     "exists": exists})

    # 收尾：最后一个 program 不带 exit/reset，统一在会话末尾复位并退出。
    cmds.append("reset run")
    cmds.append("shutdown")

    argv = _openocd_argv(plan, cmds)
    primary = next((e["path"] for e in imgs if e["format"] == "elf"), imgs[0]["path"])
    res = {"project": plan.name, "chip": plan.chip.get("id"), "elf": primary,
           "images": imgs, "argv": argv,
           "status": "dry-run" if dry_run else "pending",
           "elf_exists": Path(primary).exists() if primary else False}
    if boot_ctx:
        res["boot"] = {"project": boot_ctx["plan"].name,
                       "action": boot_ctx["action"],
                       "version": boot_ctx.get("version", "?")}
    if dry_run:
        return res

    env = plan.host.build_env()
    proc = subprocess.run(argv, cwd=str(plan.cfg.root), env=env, text=True,
                          capture_output=True, errors="replace", **proc_kwargs())
    combined = (proc.stdout or "") + (proc.stderr or "")
    res["stdout"] = proc.stdout
    res["stderr"] = proc.stderr
    res["evidence"] = _salient(combined)

    if verbose:
        log(combined)

    if proc.returncode == 0:
        res["status"] = "ok"
        names = " + ".join(Path(e["path"]).name for e in imgs)
        log(f"[elab] ✓ 烧录完成：{names} → {plan.chip.get('debug', {}).get('device')}")
        for line in res["evidence"]:
            log(f"       {line}")
        # ★ C2：boot 随本次会话烧成 → 更新台账（下次冻结）
        if boot_ctx and boot_ctx["action"] == "flash":
            _stamp_save(_boot_stamp_path(plan), {
                "md5": boot_ctx["md5"],
                "version": boot_ctx.get("version", "?"),
                "bin": to_fwd(boot_ctx["bin"]),
                "flashed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            })
            log(f"[elab] ✓ boot 烧录台账已更新（v{boot_ctx.get('version', '?')}）")
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
    # ★ C33 镜像模式（flash.images 已声明）跳过 gdb `load`：
    #   load 按 APP elf 的段擦写 Flash，与 program app.ef 有同样的向下擦除风险
    #   （M2：从 0x08004000 起擦，覆盖 Bootloader 尾部）。闭环顺序里 flash 在
    #   debug 之前，固件已在位，这里只 reset halt 断点即可，不重写 Flash。
    load_cmds = [] if plan.flash_images else ["-ex", "load"]
    gdb_cmd = [
        gdb_bin, to_fwd(elf),
        "-ex", "target extended-remote localhost:3333",
        "-ex", "monitor reset halt",
        *load_cmds,
    ]
    if plan.gdb_script:
        gdb_cmd += ["-x", plan.gdb_script]

    res = {"project": plan.name, "openocd": server, "gdb": gdb_cmd, "mode": mode,
           "status": "printed"}
    if mode == "print":
        return res

    env = plan.host.build_env()
    srv = subprocess.Popen(server, cwd=str(plan.cfg.root), env=env,
                           text=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                           **proc_kwargs())
    try:
        # ★ 端口占用事故（实测）：openocd 的 gdb server 绑 3333，而驾驶舱 HTTP
        #   服务默认端口恰好也是 3333 —— 端口被占时 openocd **静默退出**，
        #   若只测"TCP 可连"就会连到占端口的那个 HTTP 服务上，gdb 满屏
        #   "Ignoring packet error / vMustReplyEmpty timeout"，以误导性失败收场。
        #   故必须：① 先确认 openocd 进程还活着（死了 ≈ 绑定失败）；
        #           ② 端口可连后**再**确认 openocd 仍活着（防竞态）。
        if srv.poll() is not None or not _wait_port(3333, 20) or srv.poll() is not None:
            res["status"] = "no-server"
            if srv.poll() is not None:
                log("[elab] ✗ openocd 启动即退出 —— gdb 端口 3333 极可能被占用"
                    "（驾驶舱/残留 openocd）。查占用：`netstat -ano | findstr :3333`")
            else:
                log("[elab] ✗ openocd gdb server 未在 20s 内就绪")
            return res

        if mode == "verify":
            batch = [
                gdb_bin, to_fwd(elf), "-batch", "-q",
                "-ex", "target extended-remote localhost:3333",
                "-ex", "monitor reset halt",
                *load_cmds,
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
                                   timeout=90, **proc_kwargs())
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
        subprocess.run(gdb_cmd, cwd=str(plan.cfg.root), env=env, **proc_kwargs())
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
