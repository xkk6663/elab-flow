"""验证流式构建：`[n/m]` 进度行是否逐行到达 log() 回调。

断言三件事：
  1. 进度行出现且是逐行（不是最后一次性给出）；
  2. 摘要行（configure ✓ / build ✓ / 守卫）仍在；
  3. 依赖 `out` 的后处理（Linking 行、内存数字）没有被流式化搞丢。
"""
import sys
import time

sys.path.insert(0, 'services')
sys.path.insert(0, '.')

from elab.config import Config
from elab import builder, plan as plan_mod

cfg = Config('.')
plan = plan_mod.plan_for(cfg, 'at32f421g8u7')

t0 = time.time()
records = []


def sink(s: str) -> None:
    records.append((time.time() - t0, s))


res = builder.build_project(plan, clean=True, verbose=False, log=sink)

print(f'=== 共 {len(records)} 条 log 回调，耗时 {time.time() - t0:.2f}s ===')
prog = [(t, s) for t, s in records if s.strip().startswith('[') and '/' in s.strip()[:12]]
print(f'形如 [n/m] 的进度行: {len(prog)}')
for t, s in prog[:4]:
    print(f'  {t:6.2f}s | {s[:88]}')
print('  ...')
for t, s in prog[-2:]:
    print(f'  {t:6.2f}s | {s[:88]}')

print('\n=== 摘要行 ===')
for t, s in records:
    if s.startswith('[elab]'):
        print(f'  {t:6.2f}s | {s[:100]}')

print('\n=== 依赖累积 out 的后处理是否存活 ===')
print('  status :', res.get('status'))
print('  memory :', res.get('memory'))
arts = res.get('artifacts') or {}
print('  artifacts keys:', sorted(arts))
print('  guard.untouched:', (res.get('guard') or {}).get('untouched'))

# 逐行性判定：首条进度与末条进度的时间差应显著 > 0（而非同一时刻成堆出现）
if len(prog) >= 2:
    span = prog[-1][0] - prog[0][0]
    print(f'\n  进度行时间跨度: {span:.2f}s（>0 说明是流式，不是一次性）')
