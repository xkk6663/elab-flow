"""SSE 吞吐与背压实测：一次真实 build 的 proc 流有多少行、峰值多高。

做法：起 cockpit（--reload），POST /api/run 跑一次 build，读 SSE 全程计时，
统计事件数 / 行数 / 峰值速率，最后打印 run/end。

★ 这个数字决定窄栏日志尾的批处理阈值与"面板不可见时是否断流"的策略。
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request

s = socket.socket()
s.bind(('127.0.0.1', 0))
port = s.getsockname()[1]
s.close()

env = {**os.environ, 'PYTHONPATH': 'services', 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
p = subprocess.Popen(
    [sys.executable, '-u', '-m', 'cockpit.server', '--port', str(port), '--reload'],
    cwd=os.getcwd(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    env=env, text=True, encoding='utf-8', errors='replace', bufsize=1,
)


def wait_listen(timeout=20.0):
    t0 = time.time()
    for line in p.stdout:
        if '监听' in line:
            return True
        if time.time() - t0 > timeout:
            return False
    return False


def post(path, body):
    req = urllib.request.Request(
        f'http://127.0.0.1:{port}{path}',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    return json.load(urllib.request.urlopen(req))


try:
    if not wait_listen():
        print('TIMEOUT: 未等到监听')
        raise SystemExit(1)

    project = sys.argv[1] if len(sys.argv) > 1 else 'at32_test'
    print(f'>>> POST /api/run project={project} steps=build')
    t_start = time.time()
    res = post('/api/run', {'project': project, 'steps': ['build'], 'actor': 'human'})
    run_id = res['run']
    print('run:', run_id)

    # 读 SSE 全程
    req = urllib.request.Request(f'http://127.0.0.1:{port}/api/events?run={run_id}&from=0')
    events = 0
    lines = 0
    peak = 0
    buckets = {}
    t_first = None
    t_end = None
    closed_reason = None
    with urllib.request.urlopen(req, timeout=600) as resp:
        for raw in resp:
            line = raw.decode('utf-8', 'replace').rstrip('\r\n')
            if line.startswith('event:'):
                events += 1
                topic = line[6:].strip()
                buckets[topic] = buckets.get(topic, 0) + 1
                if t_first is None:
                    t_first = time.time()
                if topic == 'stream/closed':
                    closed_reason = 'closed'
            elif line.startswith('data:'):
                try:
                    payload = json.loads(line[5:])
                except Exception:
                    continue
                if payload.get('topic') == 'proc/stdout-batch':
                    n = len(payload.get('lines') or [])
                    lines += n
                    peak = max(peak, n)
                if payload.get('topic') == 'run/end':
                    t_end = time.time()

    dur = (t_end or time.time()) - t_start
    print(f'\n=== 结果 ===')
    print(f'run 总耗时           : {dur:.2f} s')
    print(f'SSE 事件数           : {events}')
    print(f'proc 累计行数        : {lines}')
    print(f'单帧最大批量行数     : {peak}')
    print(f'平均行/秒            : {lines / dur:.0f}' if dur > 0 else '')
    print(f'首事件延迟           : {((t_first - t_start) * 1000):.0f} ms' if t_first else '')
    print(f'\ntopic 分布:')
    for k, v in sorted(buckets.items(), key=lambda kv: -kv[1])[:12]:
        print(f'  {k:<24} {v}')
finally:
    p.terminate()
    try:
        p.wait(timeout=10)
    except Exception:
        p.kill()
