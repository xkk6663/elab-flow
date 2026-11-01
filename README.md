# dsh-elab-cockpit

elab-Flow 闭环驾驶舱的 DSH 插件：右栏窄栏面板（阶梯 + 日志尾），覆盖发现 → 适配 →
构建 → 烧录 → 调试 → 串口闭环。

**这不是"装完即用"的包**：插件只含工具层（面板 / 进程托管 / `elab_*` agent 工具），
不含任何内核源码或芯片数据。首次使用需要本机有一份 elab 仓库检出与 Python。

## 前置条件

| 依赖 | 说明 |
|---|---|
| **elab 仓库检出** | 需同时包含 `cockpit/server.py` 与 `services/elab`（本插件不内置） |
| **Python 3.10+** | 在 PATH 里，或在设置页把「python 路径」填成绝对路径 |
| 可选 `pyserial` | 串口读写；缺失时其它功能不受影响 |
| 可选工具链 | `arm-none-eabi-gcc` / `cmake` / `ninja` / `openocd`：只影响编译 / 烧录 / 调试 |
| DSH | `>= 0.2.0-rc.1` |

内核获取方式二选一：

```bash
git clone --depth 1 https://github.com/xkk6663/elab-flow.git D:\elab-flow
```

或使用已有检出。仓库内的 `elab.cmd`（Windows）或 `python -m elab` 也可单独使用，
三种入口（CLI / 独立驾驶舱 / DSH 右栏面板）共享同一内核事件流。

## 首次打开：安装向导

面板未找到内核时不再是一行错误，而是四步向导：

1. **环境自检**——只读探测 python / pyserial / git（`GET /elab/env`，不启动内核）；
2. **内核来源**——指定已有目录，或浅克隆到空目录（写盘需二次确认）；
3. **工具链体检**——六项版本灯，缺件只标黄、不阻断；
4. **工程接入**——内核就绪后用面板里的「＋适配」接入固件目录。

向导只做检测与引导：**不会自动 `pip install`、不会自动 `git pull`**。
升级内核请手动执行 `git -C <elabRoot> pull --ff-only`。

设置页（DSH 设置 → ELAB 驾驶舱）可改 `elabRoot` / `pythonPath`，保存即热更新并写入
`~/.dsh/dsh-elab-cockpit.config.json`，重启仍生效；同页的「环境」分段复用同一探测结果。

## 已知限制

- 不内置内核、不装工具链、不自动克隆（只在向导里做一次显式浅克隆）。
- 芯片支持来自适配包（`packs/official/**` 与社区市场），插件不承载芯片知识。
- 内核版本低于 `2.1.0` 时只提示，不阻断；步骤标签会退回插件内置默认。

## 故障排查

| 现象 | 处理 |
|---|---|
| 向导第 1 步 python 红 | 装 Python 3.10+ 或在设置页填绝对路径 |
| 第 2 步一直找不到内核 | 确认目录同时有 `cockpit/server.py` 与 `services/elab` |
| 面板能开但编译按钮报错 | 看设置页「环境」红灯项；内核 `elab doctor` 给更准确的结论 |
| 串口打不开 | 装 `pyserial`（`pip install pyserial`），并确认没有被其它进程占用 |
| 面板提示"内核旧" | `git -C <elabRoot> pull --ff-only` 后重开面板 |

## 开发与验证

```bash
# 插件单测（仓库根执行）
node --experimental-strip-types --test 'packages/dsh-elab-cockpit/test/*.test.mjs'

# 构建产物（包目录执行）
node ../../cockpit/web/node_modules/typescript/bin/tsc -p tsconfig.host.json --outDir lib
node scripts/build-client.mjs
node scripts/verify-client-contract.mjs
```

分层纪律：工具层不 import 内核源码，只走 loopback HTTP ICD；门禁见 `test/boundary.test.mjs`。

## License

MIT
