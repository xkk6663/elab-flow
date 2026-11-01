# AGENTS.md — elab-Flow 仓库工作规则（给本仓工作的 agent）

本仓库 = **业务层（elab 内核）+ 工具层（DSH 插件）**。分层边界见
`docs/技术方案_dsh-elab-flow插件移植.md` §16。

## 层与归属

| 层 | 路径 | 说明 |
|---|---|---|
| **业务层** | `services/elab/**` | elab 内核：闭环编排、烧录、串口、OTA（改功能/修缺陷写这里） |
| **业务层** | `cockpit/server.py` | 内核 HTTP 面 + **内核自描述**（`STEP_META` / `KERNEL_PLANS`：步骤标签、通道、三档定义的唯一事实源） |
| **业务层** | `projects/**`、`examples/**` | 工程适配与示例 |
| **数据层（适配包）** | `packs/official/**`、`packs/installed/**` | 芯片参数 / 厂商指纹 / 平台坑位 —— **芯片知识的唯一宿主**；骨架仓不内置任何芯片 |
| **数据层（市场）** | `market/index.json` | 零服务器社区市场索引（包内容留在作者仓库，索引只记 name/version/source/sha256/requires/license） |
| **工具层（独立仓）** | [`xkk6663/dsh-elab-cockpit`](https://github.com/xkk6663/dsh-elab-cockpit) | DSH 插件（开发工具整合器）：面板可视化、进程托管、`elab_*` agent 工具。**不在本仓** |
| **工具层** | `packages/dsh-elab-iframe/**` | 历史探针包（已退役，仅存档） |

## Agent 边界规则（硬）

1. **业务代码只写业务层**：改闭环行为/步骤/档位/串口 → `services/elab/**`；
   改步骤标签、加步骤、调三档定义 → `cockpit/server.py` 的 `STEP_META` / `KERNEL_PLANS`（内核自描述，工具层自动跟随，**不要**去改插件的内置默认——那只是内核过旧时的兑底）。
2. **DSH 插件已拆为独立仓** `xkk6663/dsh-elab-cockpit`：改面板/工具/进程托管去那个仓，
   不要把插件代码加回本仓；业务逻辑写进工具层 = 分层违规。
3. **唯一合法缝隙是 loopback HTTP ICD**：工具层与内核之间不 import 源码、不共享文件；
   门禁测试在插件仓的 `test/boundary.test.mjs` 会拦。
4. 插件内的内核版本探测：`capabilities.meta` 缺失 = 内核过旧（面板会提示同步），不要在工具层为新业务字段写死兼容分支——先把内核同步了。
5. **芯片知识只写适配包**：新增/修改厂商支持（芯片 YAML、`vendor_fingerprints`、
   平台坑位）一律落在 `packs/**`，**不得**写进 `services/elab/**` 或 `cockpit/**`；
   内核只认 `pack.yaml` 协议（`elab.pkg`），不 import 任何包内文件、不为某厂商开分支。
6. **适配包相互独立**：包不得 `import` / 依赖另一个包；跨包共享能力走内核
   `pack.yaml` 协议或市场索引。改包后必须重生成 `market/index.json`
   （`elab pkg index`），CI 用 `elab pkg index --check` 拦漂移。
7. **`packs/installed/` 不入库**：它是用户按需安装的落点（见 `.gitignore`）；
   随仓只提交 `packs/official/**` 与 `market/index.json`。
8. **内置 vs 外置**：`st/stm32` 是内置包（`packs/official/st/stm32`，`elab pkg bootstrap` 安装）；
   其它厂商包（如 `artery/at32`）必须是**外置 GitHub 仓库**，只通过市场索引登记，
   **不得**放进 `packs/official/**`。市场索引仓：`xkk6663/elab-pack-market`；
   外置包示例仓：`xkk6663/elab-pack-artery-at32`。
9. **外置包仓库必须带 `.gitattributes`（`* -text`）**：内容哈希按字节计算，
   换行转换会导致 `sha256` 校验失败。

## 验证

- 插件（独立仓内）：`npm test` / `npm run build`（cwd = 插件仓根）
- 内核：`elab.cmd doctor`（或 `python -m elab doctor`，需 `PYTHONPATH=services`）
- 改 `cockpit/server.py` 后**两个检出都要同步**（本仓 + 用户的 elab 工作检出）
