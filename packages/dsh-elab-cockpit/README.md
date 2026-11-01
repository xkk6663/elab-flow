# dsh-elab-cockpit

> **只读镜像**：本仓源码的唯一事实源在主仓
> [`xkk6663/elab-flow`](https://github.com/xkk6663/elab-flow) 的 `packages/dsh-elab-cockpit/`。
> 这里的提交由 CI 用 `git subtree split` 自动推送，**请勿在本仓改代码**——改动会随下次镜像被覆盖。
> 开发、提 issue、跑门禁请到主仓（`npm test` / `npm run build` 的 cwd 为 `packages/dsh-elab-cockpit`）。

elab-Flow 闭环驾驶舱的 DSH 插件：右栏窄栏面板（阶梯 + 日志尾），覆盖发现 → 适配 →
构建 → 烧录 → 调试 → 串口闭环。

**插件瘦、依赖可一键补齐**：插件只含工具层（面板 / 进程托管 / `elab_*` agent 工具），
不内置内核源码、芯片数据或工具二进制。首次使用可以由向导一键下载内核归档、一键安装工具链，
只差一个主机 Python。

## 前置条件

| 依赖 | 说明 |
|---|---|
| **elab 内核** | 本机检出（需同时包含 `cockpit/server.py` 与 `services/elab`），或向导里**按版本下载**到 `~/.dsh/elab/kernels/v<ver>/` |
| **Python 3.10+** | 在 PATH 里，或在设置页把「python 路径」填成绝对路径（插件不打包 Python） |
| 可选 `pyserial` | 串口读写；缺失时其它功能不受影响 |
| 工具链 | `arm-none-eabi-gcc` / `cmake` / `ninja` / `openocd`：**可一键安装**到 `~/.dsh/elab/env`（官方上游直链 + sha256，约 400 MB，仅 Windows x64）；已装过自己的则无需重复 |
| DSH | `>= 0.2.0-rc.1` |

内核获取方式三选一：

```bash
git clone --depth 1 https://github.com/xkk6663/elab-flow.git D:\elab-flow
```

或使用已有检出；或在面板向导里选「按版本下载」（拉 `v<ver>` 源码归档，多版本并存）。

仓库内的 `elab.cmd`（Windows）或 `python -m elab` 也可单独使用，
三种入口（CLI / 独立驾驶舱 / DSH 右栏面板）共享同一内核事件流。

## 首次打开：安装向导

面板未找到内核时不再是一行错误，而是四步向导：

1. **环境自检**——只读探测 python / pyserial / git（`GET /elab/env`，不启动内核）；
2. **内核来源**——指定已有目录、浅克隆到空目录，或**按版本下载**源码归档（写盘需二次确认）；
3. **工具链体检**——六项版本灯，缺件只标黄、不阻断；点「**一键安装工具链**」把
   arm-gcc / cmake / ninja / openocd 装进 `~/.dsh/elab/env`（下载 → sha256 校验 →
   解压 → 版本探测，失败即中断，可重复执行）；
4. **工程接入**——内核就绪后用面板里的「＋适配」接入固件目录。

向导只做检测与引导：**不会自动 `pip install`、不会自动 `git pull`**；
下载类动作（装工具链 / 下内核）都要显式确认。
升级内核请手动执行 `git -C <elabRoot> pull --ff-only`。

工具链装好后靠环境变量（`ELAB_ARM_GCC_ROOT` / `ELAB_CMAKE` / `ELAB_NINJA` /
`ELAB_OPENOCD` / `ELAB_OPENOCD_SCRIPTS`）注入内核子进程，**不会改写**你仓库里的
`elab.host.yaml`；你自己已装好的工具链仍然优先生效（清单里装过的目录只是前置进 PATH）。

设置页（DSH 设置 → ELAB 驾驶舱）可改 `elabRoot` / `pythonPath`，保存即热更新并写入
`~/.dsh/dsh-elab-cockpit.config.json`，重启仍生效；同页的「环境」分段复用同一探测结果。

## 已知限制

- 不内置内核、不随包分发工具二进制、不自动克隆（只在向导里做一次显式下载/浅克隆）。
- 环境包当前只覆盖 **Windows x64**；其它平台先用本机工具链（探测仍可正常工作）。
- 环境包清单里的 `sha256` 未核对的条目会按首次下载记录（TOFU）并给出告警。
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

## 安装

本仓即插件包本体（`package.json` 自带 `dsh.bundle` / `dsh.client` 声明），仓库已打
GitHub topic `dsh-plugin` 供 DSH 市场发现。本地开发时把本仓链接进 DSH profile 的
`node_modules` 即可，无需拷贝源码。

> 本仓是**只读镜像**：改代码请到主仓 `xkk6663/elab-flow` 的
> `packages/dsh-elab-cockpit/`，打 `plugin-v*` tag（或手动触发 `publish-plugin`）
> 后由 CI 强推到这里。

## 开发与验证（cwd = 主仓的 `packages/dsh-elab-cockpit`）

```bash
npm install          # devDeps：typescript / esbuild / @types/*
npm test             # 单测（含 boundary / style-rules / envpack 门禁）
npm run build        # Host 半 tsc → lib + Client 半打包 + 契约校验
```

分层纪律：工具层不 import 内核源码，只走 loopback HTTP ICD；门禁见 `test/boundary.test.mjs`。

## License

MIT
