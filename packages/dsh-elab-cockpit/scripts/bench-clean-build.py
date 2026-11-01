"""跑一次真实 build（带 --clean），只等落盘，不读 SSE —— 避开连接重置问题。

用法：python bench-clean-build.py [project]
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

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


def wait_listen(timeout=25.0):
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
        print('TIMEOUT')
        raise SystemExit(1)
    project = sys.argv[1] if len(sys.argv) > 1 else 'at32_test'
    print(f'>>> clean build project={project}')
    t0 = time.time()
    res = post('/api/run', {'project': project, 'steps': ['build'], 'clean': True, 'actor': 'human'})
    run_id = res['run']
    print('run:', run_id)

    state = Path('.work/.cockpit/runs') / f'{run_id}.jsonl'
    deadline = time.time() + 300
    while time.time() < deadline:
        done = False
        if state.exists():
            for raw in state.read_text(encoding='utf-8', errors='replace').splitlines():
                if '"run/end"' in raw:
                    done = True
                    break
        if done:
            break
        time.sleep(0.3)
    print(f'run 完成，墙钟耗时 {time.time() - t0:.1f}s')
    print('RUN_ID=' + run_id)
finally:
    p.terminate()
    try:
        p.wait(timeout=10)
    except Exception:
        p.kill()
