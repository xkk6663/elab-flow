"""在**副本**构建目录里做实打实的全量编译，观察 Ninja 流式输出形态。

★ 绝不改业务工程（外骨骼原则）：只用 .work 下的一次性目录。
  步骤：cmake -S examples/AT32F421G8U7 -B .work/_bench_ninja（同 elab 的 configure 参数）
        然后分别用 ninja 默认 / ninja -v 各跑一次全量编译。
"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path.cwd()
bench = ROOT / '.work' / '_bench_ninja'
src = ROOT / 'examples' / 'AT32_TEST'
ninja = 'C:/Users/xiao1/AppData/Local/at32-tools/ninja/V1.11.1/ninja.exe'
cmake = 'cmake'

if bench.exists():
    shutil.rmtree(bench)
bench.mkdir(parents=True)

env = {**os.environ, 'PYTHONUTF8': '1'}

print('>>> configure')
cfg = [
    cmake, '-S', str(src), '-B', str(bench), '-G', 'Ninja',
    f'-DCMAKE_MAKE_PROGRAM={ninja}',
    f'-DCMAKE_TOOLCHAIN_FILE={ROOT / "toolchains" / "gcc.cmake"}',
    f'-DCMAKE_PROJECT_INCLUDE={ROOT / "toolchains" / "inject.cmake"}',
    f'-DELAB_ARM_GCC_ROOT=C:/DevEnv/GNU-tools-for-STM32',
    f'-DELAB_CHIP=at32f421g8',
    f'-DELAB_LD={src / "AT32F421x8_FLASH.ld"}',
    '-DCMAKE_BUILD_TYPE=Debug',
]
r = subprocess.run(cfg, capture_output=True, text=True, encoding='utf-8', errors='replace')
print('configure rc =', r.returncode)
if r.returncode != 0:
    print(r.stdout[-2000:], r.stderr[-2000:])
    sys.exit(1)


def stream(cmd, label):
    print(f'\n=== {label} ===')
    t0 = time.time()
    lines = []
    proc = subprocess.Popen(cmd, cwd=str(bench), stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding='utf-8',
                            errors='replace', bufsize=1, env=env)
    for line in proc.stdout:
        line = line.rstrip('\r\n')
        if not line:
            continue
        lines.append((time.time() - t0, line))
    rc = proc.wait()
    total = time.time() - t0
    print(f'  总行数 {len(lines)}, 耗时 {total:.2f}s, rc={rc}')
    print('  首 3 行:')
    for t, l in lines[:3]:
        print(f'    {t:6.2f}s | {l[:100]}')
    print('  末 3 行:')
    for t, l in lines[-3:]:
        print(f'    {t:6.2f}s | {l[:100]}')
    # 统计形如 [n/m] 的进度行
    prog = [l for _, l in lines if l.strip().startswith('[')]
    print(f'  形如 [n/m] 的进度行: {len(prog)}')
    if prog:
        print(f'    示例: {prog[0][:80]!r} … {prog[-1][:80]!r}')
    return lines


stream([ninja], 'A. ninja（默认，非 tty 管道）')

# 清掉中间产物，跑 -v
for pat in ('*.o', '*.obj'):
    for f in bench.rglob(pat):
        f.unlink()
stream([ninja, '-v'], 'B. ninja -v')
