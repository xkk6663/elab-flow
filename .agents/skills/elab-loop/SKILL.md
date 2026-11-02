---
name: elab-loop
description: 用 elab 闭环驾驶舱跑嵌入式开发闭环（体检→编译→烧录→调试校验→串口）：agent 怎么发起/取消/看日志、DSH 面板怎么读、分层边界在哪。触发：用户要编译、烧录、调试、串口、闭环、看 FLASH/RAM 占位、适配新工程，或问 elab / 驾驶舱 / 这个开发工具怎么用。
---

# elab 闭环驾驶舱 —— agent 使用指南

## 它是什么

DSH 里的「ELAB 驾驶舱」面板（右栏 tab / 底部工作台 / 设置节）是一个**开发工具整合器**：
- 给你（agent）一组 `elab_*` 工具和一份 CLI，用来跑嵌入式闭环；
- 给开发者一个实时可视化（阶梯 + 四通道日志尾）。

业务本体是 elab 内核（`services/elab/**` + `cockpit/server.py`），插件只通过
loopback HTTP ICD 与它说话 —— **工具层没有业务逻辑，业务变更改内核**。

## Agent 怎么跑闭环（按优先级）

### ① elab_* 工具（推荐，结构化返回）

| 顺序 | 工具 | 用途 |
|---|---|---|
| 1 | `elab_status` | 查工程列表 + 每步可用性 + 当前 run 归属（**写操作前先调它拿工程名**） |
| 2 | `elab_build` / `elab_triple` / `elab_loop` | 发起：只编译 / 编译+烧录+调试 / 完整闭环（缺什么自动剔除并在返回里说明） |
| 3 | `elab_log` | 读日志尾部 N 行（默认 200，可按步骤过滤）——别让用户去翻终端 |
| 4 | `elab_cancel` | 取消当前 run（无论谁发起的都能取消） |

规则（违反会被结构化拒绝，如实转告用户）：
- **单飞**：同一会话同时最多 1 个 run；人工 run 进行中你发起 → `human-busy`
  （等待结束或请用户点「■ 取消」，不要重试刷屏）。
- **串口互斥**：串口监视会话占用时，含烧录/调试的 run → `serial-busy`
  （先请用户在「串口」通道点「关闭监视」）。
- **串口写 / 适配写盘**：`elab_serial` / `elab_adapt(write=true)` 需要 `allowAgentWrite`
  （默认关）。被拒时告诉用户怎么开，不要绕路。
- 工具返回里有 `run` id —— 后续 `elab_log` / `elab_cancel` 用得上，别丢。

### ② CLI（等价语义）

仓库根：`elab.cmd build -p <工程名>`（Windows）/ `./elab doctor --deep`；
`python -m elab list --json` 列工程。需要 `PYTHONPATH=services`（elab.cmd 已自设）。

## 可视化（告诉用户去哪看）

- DSH 右栏「ELAB 驾驶舱」tab：阶梯（● 待跑 / ◐ 运行中 / ● 成功 / ✕ 失败 / – 未执行）+
  构建/烧录/调试/串口四通道日志尾 + 控制条（编译/三连/闭环/取消/预览/⚙）。
- 你发起 run 后：工程条出现 `agent` 标，阶梯自动点亮，日志尾实时滚动；
  用户随时可以「■ 取消」（人工可抢占 AI）。
- 底部工作台「+」菜单里也有「ELAB 驾驶舱」；设置 → ELAB 驾驶舱 可改
  elabRoot / python / 空闲回收 / 发现参数。

## 分层边界（硬规则）

- 业务代码 → `services/elab/**`（内核）、`projects/**`（适配）；
- 步骤标签 / 加步骤 / 档位定义 → `cockpit/server.py` 的 `STEP_META` / `KERNEL_PLANS`
  （内核自描述，工具层自动跟随）；
- DSH 插件在本仓 `packages/dsh-elab-cockpit`（工具层）：只有修工具 bug 才碰；
  插件市场与 npm 都直接取 `packages/dsh-elab-cockpit`（无镜像仓 / 分发仓）；
- 门禁：`packages/dsh-elab-cockpit/test/boundary.test.mjs`。

## 常见故障 → 处置

| 现象 | 处置 |
|---|---|
| `cockpit 启动超时（15s）… 监听 http://127.0.0.1:0/` | 该检出的 `cockpit/server.py` 过旧（打印请求端口而非绑定端口）：同步含 `bound_port` 修复的版本 |
| 面板提示「内核较旧（无自描述元数据）」 | 同步会话仓库的 `cockpit/server.py`（v2.1.0+，含 capabilities.meta） |
| `serial-busy` | 串口监视占用：先关监视或等它结束 |
| `human-busy` | 用户正在跑：等结束或请用户取消，不要重试 |
| FLASH/RAM 占位缺失 | 本次未 relink（链接器未输出 --print-memory-usage），属正常回退 |
