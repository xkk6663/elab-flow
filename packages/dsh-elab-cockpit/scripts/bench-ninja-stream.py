"""验证 Ninja 在**流式管道**下输出什么 —— 决定进度条数据来源。

三种模式都试：
  A. 默认（cmake --build）
  B. ninja -v（逐命令）
  C. ninja 的进度行形态：`[3/28] Building C object ...`

★ 关键问题：Ninja 是**行缓冲**还是**直接写终端**？若它检测到非 tty 就静默，
  则"进度条"只能靠 -v 的逐条命令解析，或者干脆自己数。
"""
import os
import subprocess
import sys
import time
from pathlib import Path

work = Path('.work/at32f421g8u7')
ninja = 'C:/Users/xiao1/AppData/Local/at32-tools/ninja/V1.11.1/ninja.exe'


def stream(cmd, label, cwd):
    print(f'\n=== {label} ===')
    print('$', ' '.join(cmd))
    t0 = time.time()
    n = 0
    first = None
    proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding='utf-8',
                            errors='replace', bufsize=1,
                            env={**os.environ, 'PYTHONUTF8': '1'})
    for line in proc.stdout:
        line = line.rstrip('\r\n')
        if not line:
            continue
        n += 1
        if first is None:
            first = time.time() - t0
        if n <= 6:
            print(f'  {time.time() - t0:6.2f}s | {line[:110]}')
    rc = proc.wait()
    print(f'  → {n} 行, 首行 {first or 0:.2f}s, 总 {(time.time() - t0):.2f}s, rc={rc}')
    return n


if not work.exists():
    print('工作目录不存在，先跑一次 build')
    sys.exit(1)

# 强制重新编译若干文件：touch 源文件不行（不许改业务工程），改用一个干净的构建目录
alt = Path('.work/_bench_ninja')
alt.mkdir(parents=True, exist_ok=True)

print('--- 用已经配置好的 build 目录做"再构建"（应 0 行 no work to do）---')
stream([ninja], 'A. ninja 默认（已是最新）', work)
stream([ninja, '-v'], 'B. ninja -v（已是最新）', work)
