# AGENTS.md — elab-Flow 仓库工作规则（给本仓工作的 agent）

本仓库 = **业务层（elab 内核）+ 工具层（DSH 插件）**。分层边界见
`docs/技术方案_dsh-elab-flow插件移植.md` §16。

## 层与归属

| 层 | 路径 | 说明 |
|---|---|---|
| **业务层** | `services/elab/**` | elab 内核：闭环编排、烧录、串口、OTA（改功能/修缺陷写这里） |
| **业务层** | `cockpit/server.py` | 内核 HTTP 面 + **内核自描述**（`STEP_META` / `KERNEL_PLANS`：步骤标签、通道、三档定义的唯一事实源） |
| **业务层** | `projects/**`、`examples/**` | 工程适配与示例 |
| **工具层** | `packages/dsh-elab-cockpit/**` | DSH 插件（开发工具整合器）：面板可视化、进程托管、`elab_*` agent 工具 |
| **工具层** | `packages/dsh-elab-iframe/**` | 历史探针包（已退役，仅存档） |

## Agent 边界规则（硬）

1. **业务代码只写业务层**：改闭环行为/步骤/档位/串口 → `services/elab/**`；
   改步骤标签、加步骤、调三档定义 → `cockpit/server.py` 的 `STEP_META` / `KERNEL_PLANS`（内核自描述，工具层自动跟随，**不要**去改插件的内置默认——那只是内核过旧时的兑底）。
2. **`packages/dsh-elab-cockpit` 是工具层**：仅当修工具本身的 bug / 加工具能力时才动；
   业务逻辑写进工具层 = 分层违规。
3. **唯一合法缝隙是 loopback HTTP ICD**：工具层与内核之间不 import 源码、不共享文件；
   门禁测试 `packages/dsh-elab-cockpit/test/boundary.test.mjs` 会拦。
4. 插件内的内核版本探测：`capabilities.meta` 缺失 = 内核过旧（面板会提示同步），不要在工具层为新业务字段写死兼容分支——先把内核同步了。

## 验证

- 插件：`node --experimental-strip-types --test 'packages/dsh-elab-cockpit/test/*.test.mjs'`（cwd = 仓库根）
- 内核：`elab.cmd doctor`（或 `python -m elab doctor`，需 `PYTHONPATH=services`）
- 改 `cockpit/server.py` 后**两个检出都要同步**（本仓 + 用户的 elab 工作检出）
