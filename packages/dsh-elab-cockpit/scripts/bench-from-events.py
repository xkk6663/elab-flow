"""从已落盘的事件文件统计一次 run 的规模（比读 SSE 更稳，不受连接重置影响）。

用法：python bench-from-events.py [run_id]
默认取 .work/.cockpit/runs 下最新的 run。
"""
import json
import sys
from pathlib import Path

runs = Path('.work/.cockpit/runs')
if len(sys.argv) > 1:
    run_id = sys.argv[1]
else:
    files = sorted(runs.glob('r-*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        print('没有 run 文件')
        raise SystemExit(1)
    run_id = files[0].stem

state = runs / f'{run_id}.jsonl'
proc = runs / f'{run_id}.proc.jsonl'

topics = {}
lines = 0
peak = 0
frames = 0
first_ts = last_ts = None
end_ts = None
step_durations = {}


def scan(path: Path, is_proc: bool):
    global lines, peak, frames, first_ts, last_ts, end_ts
    if not path.exists():
        print(f'(缺失) {path}')
        return
    size = path.stat().st_size
    with path.open(encoding='utf-8', errors='replace') as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                e = json.loads(raw)
            except Exception:
                continue
            frames += 1
            topic = e.get('topic', '?')
            topics[topic] = topics.get(topic, 0) + 1
            ts = e.get('ts')
            if isinstance(ts, (int, float)):
                first_ts = ts if first_ts is None else min(first_ts, ts)
                last_ts = ts if last_ts is None else max(last_ts, ts)
            if topic == 'proc/stdout-batch':
                n = len(e.get('lines') or [])
                lines += n
                peak = max(peak, n)
            elif topic in ('proc/stdout', 'proc/stderr'):
                lines += 1
                peak = max(peak, 1)
            if topic == 'run/step-exit':
                step_durations[e.get('step', '?')] = e.get('duration_s')
            if topic == 'run/end':
                end_ts = ts
    print(f'{path.name:<28} {size / 1024:>9.1f} KB')


print(f'run: {run_id}')
scan(state, False)
scan(proc, True)

print(f'\n总帧数            : {frames}')
print(f'proc 行数         : {lines}')
print(f'单帧最大批量      : {peak}')
if first_ts and last_ts:
    dur = (end_ts or last_ts) - first_ts
    print(f'时间跨度          : {dur:.2f} s')
    if dur > 0:
        print(f'平均行/秒         : {lines / dur:.0f}')
        print(f'平均帧/秒         : {frames / dur:.1f}')
print('\ntopic 分布:')
for k, v in sorted(topics.items(), key=lambda kv: -kv[1])[:14]:
    print(f'  {k:<24} {v}')
if step_durations:
    print('\n步骤耗时:')
    for k, v in step_durations.items():
        print(f'  {k:<16} {v}s')
