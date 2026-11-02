# 文档索引

本目录按**用途**分四类。文件名保持原样（含日期/主题），便于引用与检索；
新增文档请放到对应目录，并在此登记一行。

## architecture/ —— 架构与仓库拓扑

| 文档 | 内容 |
|---|---|
| [架构分析和项目仓库的依赖关系](architecture/架构分析和项目仓库的依赖关系.md) | 分层总览、源码锚点、仓库拓扑、发版 Playbook、门禁与事实核对（**先读这篇**） |
| [架构对比_ELAB_vs_elab-Flow](architecture/架构对比_ELAB_vs_elab-Flow.md) | ELAB 与 elab-Flow 的定位差异 |
| [架构调研_通用agent架构与驾驶舱映射](architecture/架构调研_通用agent架构与驾驶舱映射.md) | 通用 agent 架构与驾驶舱概念的映射 |

## design/ —— 方案、契约与约束

| 文档 | 内容 |
|---|---|
| [技术方案_dsh-elab-flow插件移植](design/技术方案_dsh-elab-flow插件移植.md) | 工具层分层边界、面板、ICD（§16 是边界规则的原始依据） |
| [技术方案_闭环驾驶舱](design/技术方案_闭环驾驶舱.md) | 驾驶舱方案与实现记录（决策 D、约束 N、串口判据） |
| [技术方案_插件独立上架与安装向导](design/技术方案_插件独立上架与安装向导.md) | 插件独立上架、安装引导与环境包 |
| [技术迁移方案_串口监视与调试可视化](design/技术迁移方案_串口监视与调试可视化.md) | 串口 P1/P2/P3、数据面契约、Agent 工具 |
| [技术分析_侧边栏设置页与芯片插件市场](design/技术分析_侧边栏设置页与芯片插件市场.md) | 设置页与芯片市场交互分析 |
| [技术方案_驾驶舱UI共享层迁移](design/技术方案_驾驶舱UI共享层迁移.md) | WebUI 与 DSH 面板的逻辑层 + 面板共享方案，含未来自研 harness 双宿主规划（待评审，未动代码） |
| [ELAB_跨平台CI工作流架构设计](design/ELAB_跨平台CI工作流架构设计.md) | 跨平台 CI 工作流与矩阵设计 |
| [ICD_cockpit_events](design/ICD_cockpit_events.md) | 事件契约：topic 全集、SSE 帧格式、兼容承诺 |
| [设计约束](design/设计约束.md) | C1–C35 硬约束，每条附「为什么」与事故来源 |

## reports/ —— 验证报告与可行性研究

| 文档 | 内容 |
|---|---|
| [干跑验证报告_AT32接入](reports/干跑验证报告_AT32接入.md) | AT32 接入干跑（B 类） |
| [干跑验证报告_CLI实现](reports/干跑验证报告_CLI实现.md) | CLI 实现干跑 |
| [干跑验证报告_STM32与跨芯片](reports/干跑验证报告_STM32与跨芯片.md) | STM32 + 跨芯片同工具链验证 |
| [干跑验证报告_上板闭环](reports/干跑验证报告_上板闭环.md) | 上板闭环干跑 |
| [可行性研究_社区插件市场与芯片适配包](reports/可行性研究_社区插件市场与芯片适配包.md) | 零服务器社区市场与适配包可行性 |

## requirements/ —— 需求对照

| 文档 | 内容 |
|---|---|
| [需求对照与改进](requirements/需求对照与改进.md) | 驾驶舱 R1–R10 / 插件目标 / 串口 P1–P3.5 / 市场 R1–R4 + backlog |

## 其他

- `assets/serial/`：README「串口工作区」章节引用的截图。
- 实机验证截图在 `packages/dsh-elab-cockpit/docs/screenshots/`（插件 README 使用）。
- 版本变更记录在仓库根 [CHANGELOG.md](../CHANGELOG.md)；工作规则见 [AGENTS.md](../AGENTS.md)。
