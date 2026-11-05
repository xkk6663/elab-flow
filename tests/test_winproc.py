"""Windows 作业对象兜底：父进程怎么死，子进程都不能留下来（2026-11-05）。

背景（实测坑）：探针被占、或强杀内核之后，openocd 变成孤儿继续握着
CMSIS-DAP，下一次「开始调试」永远 `debug-gdb-missing`，只能手动
`taskkill /IM openocd.exe`。`finally` / `atexit` 在 `TerminateProcess`
下一行都不执行，只能在操作系统层兜 —— 作业对象 + `KILL_ON_JOB_CLOSE`。

这里的用例钉三件事：
· 关掉作业句柄 → 成员进程被终止（对照组不受影响，证明差异来自作业）；
· 父进程被 `taskkill /F` → 它的子进程同样被终止（这就是用户遇到的场景）；
· 作业建不出来 / 进程已退出 / 非 Windows 时，`adopt` 只返回 False，绝不抛。

非 Windows 平台自动跳过（机制本身是 Windows-only；那边走的是 no-op 降级）。
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, "services")

from elab import _winproc as wp  # noqa: E402

WIN = sys.platform == "win32"
NEED_WIN = unittest.skipUnless(WIN, "作业对象是 Windows-only 能力")

_QUERY_LIMITED = 0x1000
_SYNCHRONIZE = 0x00100000
_WAIT_TIMEOUT = 258


def _pid_alive(pid: int) -> bool:
    """进程是否还活着。``WaitForSingleObject`` 需要 SYNCHRONIZE 权限 —— 只用
    QUERY_LIMITED 打开会拿到 WAIT_FAILED(0xFFFFFFFF)，把活进程误判成死的。"""
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = ctypes.c_void_p
    k32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    k32.WaitForSingleObject.restype = ctypes.c_ulong
    k32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    k32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = k32.OpenProcess(_QUERY_LIMITED | _SYNCHRONIZE, 0, pid)
    if not handle:
        return False                      # 打不开 = 进程表里已经没有了
    try:
        return k32.WaitForSingleObject(handle, 0) == _WAIT_TIMEOUT
    finally:
        k32.CloseHandle(handle)


def _wait_dead(pid: int, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.05)
    return not _pid_alive(pid)


def _sleeper(seconds: int = 60) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({seconds})"],
                            **wp.proc_kwargs())


class ProcKwargs(unittest.TestCase):
    """老的「不弹窗」能力不能被这轮改动碰坏。"""

    def test_merges_creationflags_instead_of_overwriting(self):
        # server.py 传的是 CREATE_NEW_PROCESS_GROUP，不能被 CREATE_NO_WINDOW 顶掉
        got = wp.proc_kwargs(creationflags=0x00000200)
        if WIN:
            self.assertEqual(got["creationflags"], 0x00000200 | wp.CREATE_NO_WINDOW)
        else:
            self.assertEqual(got["creationflags"], 0x00000200)

    def test_non_win_is_noop(self):
        if WIN:
            self.skipTest("Windows 上有实际标志位")
        self.assertEqual(wp.proc_kwargs(), {})


class JobObject(unittest.TestCase):
    def test_new_job_available_on_windows(self):
        if not WIN:
            self.skipTest("非 Windows")
        job = wp.new_job()
        self.assertNotEqual(job, 0, "在这台机器上建不出作业对象，兜底能力会静默失效")
        wp.close_job(job)

    @NEED_WIN
    def test_close_kills_members_but_not_outsiders(self):
        job = wp.new_job()
        if not job:
            self.skipTest("建不出作业对象（受限环境）")
        inside = _sleeper()
        outside = _sleeper()
        try:
            self.assertTrue(wp.adopt(inside, job))
            self.assertTrue(_pid_alive(inside.pid))

            wp.close_job(job)

            self.assertTrue(_wait_dead(inside.pid), "作业成员没有随句柄关闭被终止")
            self.assertTrue(_pid_alive(outside.pid), "没进作业的进程也被杀了，属误伤")
        finally:
            for proc in (inside, outside):
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=10)

    @NEED_WIN
    def test_default_job_is_shared(self):
        job = wp.default_job()
        if not job:
            self.skipTest("建不出作业对象（受限环境）")
        self.assertEqual(job, wp.default_job(), "默认作业必须复用同一个句柄")

    @NEED_WIN
    def test_spawn_returns_live_popen(self):
        proc = wp.spawn([sys.executable, "-c", "print('ok')"], stdout=subprocess.PIPE,
                        text=True)
        try:
            out, _ = proc.communicate(timeout=30)
            self.assertEqual(out.strip(), "ok")
            self.assertEqual(proc.returncode, 0)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)


class AdoptDegradesQuietly(unittest.TestCase):
    """兜底能力绝不能把正常流程搞挂。"""

    def test_adopt_none_is_false(self):
        self.assertFalse(wp.adopt(None))

    def test_adopt_dead_process_is_false(self):
        proc = subprocess.Popen([sys.executable, "-c", "pass"], **wp.proc_kwargs())
        proc.wait(timeout=30)
        self.assertFalse(wp.adopt(proc))          # 已退出 → 只要不抛异常就行

    def test_adopt_bad_job_is_false(self):
        proc = _sleeper(30)
        try:
            self.assertFalse(wp.adopt(proc, 0))
        finally:
            proc.kill()
            proc.wait(timeout=10)


@unittest.skipUnless(WIN, "要 taskkill 才能复刻强杀")
class KilledParentTakesChild(unittest.TestCase):
    """端到端：复刻"用户强杀内核"，父进程用 TerminateProcess 杀，不给收尾机会。"""

    def test_child_dies_with_terminated_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            holder = os.path.join(tmp, "holder.py")
            with open(holder, "w", encoding="utf-8") as fp:
                fp.write(
                    "import sys, time\n"
                    "sys.path.insert(0, sys.argv[1])\n"
                    "from elab import _winproc as wp\n"
                    "p = wp.spawn([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
                    "print(p.pid, flush=True)\n"
                    "time.sleep(120)\n")

            parent = subprocess.Popen([sys.executable, holder, os.path.abspath("services")],
                                      stdout=subprocess.PIPE, text=True)
            try:
                child_pid = int(parent.stdout.readline().strip())
                self.assertTrue(_pid_alive(child_pid))

                subprocess.run(["taskkill", "/F", "/PID", str(parent.pid)],
                               capture_output=True, timeout=30)
                parent.wait(timeout=30)

                self.assertTrue(_wait_dead(child_pid),
                                "父进程被 TerminateProcess 后子进程仍在 —— 孤儿 openocd 会重现")
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait(timeout=10)
                if parent.stdout is not None:
                    parent.stdout.close()


if __name__ == "__main__":
    unittest.main()
