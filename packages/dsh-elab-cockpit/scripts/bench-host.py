"""冷启动与 API 延迟实测。

★ 两个已踩到的坑写在这里，别重复：
  1. 子进程必须 `-u`（否则 stdout 走管道时完全缓冲，永远等不到"监听"那一行 → 挂死）；
  2. 读子进程 stdout 必须显式 `encoding='utf-8'`，否则 Windows GBK 代码页
     解不了输出里的中文/✓ 字符，直接 UnicodeDecodeError。
"""
import subprocess
import sys
import time
import socket
import os
import json
import urllib.request

s = socket.socket()
s.bind(('127.0.0.1', 0))
port = s.getsockname()[1]
s.close()

env = {
    **os.environ,
    'PYTHONPATH': 'services',
    'PYTHONUTF8': '1',
    'PYTHONIOENCODING': 'utf-8',
}
t0 = time.time()
p = subprocess.Popen(
    [sys.executable, '-u', '-m', 'cockpit.server', '--port', str(port), '--reload'],
    cwd=os.getcwd(),
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    env=env,
    text=True,
    encoding='utf-8',
    errors='replace',
    bufsize=1,
)
try:
    ready = None
    for line in p.stdout:
        if '监听' in line:
            ready = time.time() - t0
            print('LISTEN LINE:', line.strip())
            break
        if time.time() - t0 > 20:
            break
    print(f'cold start to listening: {ready * 1000:.0f} ms' if ready else 'TIMEOUT')
    if ready:
        t1 = time.time()
        d = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/api/capabilities'))
        print(f'/api/capabilities: {(time.time() - t1) * 1000:.0f} ms; schema={d.get("schema_version")}')
        t2 = time.time()
        d2 = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/api/projects'))
        n = len(d2.get('projects') or d2.get('cards') or [])
        print(f'/api/projects: {(time.time() - t2) * 1000:.0f} ms; n={n}')
finally:
    p.terminate()
    try:
        p.wait(timeout=10)
    except Exception:
        p.kill()
