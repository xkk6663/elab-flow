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
| [技术方案_串口自定义发送组件](design/技术方案_串口自定义发送组件.md) | 参数化发送组件（模板 + 类型化参数 + send/delay/wait 序列）、存储与 ICD；面板 UI 已下线，端点与 `elab_serial_widget` 保留给 agent |
| [技术分析_侧边栏设置页与芯片插件市场](design/技术分析_侧边栏设置页与芯片插件市场.md) | 设置页与芯片市场交互分析 |
| [技术方案_驾驶舱UI共享层迁移](design/技术方案_驾驶舱UI共享层迁移.md) | WebUI 与 DSH 面板的逻辑层 + 面板共享方案，含未来自研 harness 双宿主规划（待评审，未动代码） |
| [ELAB_跨平台CI工作流架构设计](design/ELAB_跨平台CI工作流架构设计.md) | 跨平台 CI 工作流与矩阵设计 |
| [ICD_cockpit_events](design/ICD_cockpit_events.md) | 事件契约：topic 全集、SSE 帧格式、兼容承诺 |
| [设计约束](design/设计约束.md) | C1–C36 硬约束，每条附「为什么」与事故来源 |
| [技术方案_ESP32接入与工具链解耦](design/技术方案_ESP32接入与工具链解耦.md) | ESP32/ESP-IDF 首次接入记录（A 方案内联 `tools:`）；当前主路径已迁移到 Provider，内联写法仅作 `--no-provider` 兜底 |
| [技术方案_Provider工具链架构](design/技术方案_Provider工具链架构.md) | 默认链/外带链同构的 Provider 架构契约：manifest、绑定优先级、缺步骤不回退、市场分发、`ctx.provide()` 边界（P1/P2 已实现，ESP32 实机闭环通过；P3 外带 GDB 搁置） |
| [技术方案_调试面板复刻cortex-debug](design/技术方案_调试面板复刻cortex-debug.md) | 调试工作区 P0–P3：断点/单步、调用栈、变量、寄存器、内存、外设、RTOS 栈水位与审计 |
| [执行计划_调试P3_源码单步与多会话与寄存器组](design/执行计划_调试P3_源码单步与多会话与寄存器组.md) | 调试 P3 落地：源码单步、多会话、寄存器组编辑、反汇编（已实现，F103 实机） |
| [执行计划_帧协议P0P1与Agent编辑](design/执行计划_帧协议P0P1与Agent编辑.md) | 串口帧协议 P0/P1：位域、变长、多 ID、反向组帧、模板库与 `elab_frame` / `elab_frame_learn`（已实现，F103 实机） |
| [执行计划_串口存量优化_帧协议补强与Agent能力](design/执行计划_串口存量优化_帧协议补强与Agent能力.md) | 串口存量打磨：通用帧协议补强（校验声明化 / 转义 / 空闲分包 / 字段模型）、Agent 生产力（learn / verify / auto / codegen）、观测与性能（帧级统计 / 触发录制 / 基准）；旧 profile 逐字兼容（**已实现，F103 实机，见教程 5.7 与附录 D**） |
| [执行计划_Modbus学习计划_RTU主站_F103从站_实机教程](design/执行计划_Modbus学习计划_RTU主站_F103从站_实机教程.md) | Modbus 学习计划：RTU 主站（PDU/事务/轮询/寄存器映射）、F103 教学从站（FC03/06/10 + 异常 + 3.5 字符 + 双 UART 心跳）、实机教程与截图 |
| [执行计划_拓展协议学习计划_CAN基础与蓝牙SPP](design/执行计划_拓展协议学习计划_CAN基础与蓝牙SPP.md) | 拓展协议：CAN 2.0A/B 基础（C1，SLCAN 500 kbit/s + 虚拟总线前置 + F103 教学工程）、蓝牙 Classic SPP（叠加 `ESP32S31_Wave`，默认不参与 auto）；CANopen/BLE/CAN FD 不做 |

## reports/ —— 验证报告与可行性研究

| 文档 | 内容 |
|---|---|
| [干跑验证报告_AT32接入](reports/干跑验证报告_AT32接入.md) | AT32 接入干跑（B 类） |
| [干跑验证报告_CLI实现](reports/干跑验证报告_CLI实现.md) | CLI 实现干跑 |
| [干跑验证报告_STM32与跨芯片](reports/干跑验证报告_STM32与跨芯片.md) | STM32 + 跨芯片同工具链验证 |
| [干跑验证报告_上板闭环](reports/干跑验证报告_上板闭环.md) | 上板闭环干跑 |
| [可行性研究_社区插件市场与芯片适配包](reports/可行性研究_社区插件市场与芯片适配包.md) | 零服务器社区市场与芯片适配包可行性 |
| [性能基准_串口帧解码_2026-11-05](reports/性能基准_串口帧解码_2026-11-05.md) | P3.3 解码基准：64B 档 p95 0.6 ms、吞吐 ≥192 KB/s；含门槛对照与后续优化顺序 |
| [健壮性盘点_2026-11-05](reports/健壮性盘点_2026-11-05.md) | 收尾前全仓健壮性盘点：11 条问题分级 + 实测取证（P0 `list_runs` 全量重放等）；全部条目已处置，含逐条结果 |

## releases/ —— GitHub Release 发布说明

| 文档 | 内容 |
|---|---|
| [v4.0.0 发布说明](releases/v4.0.0.md) | tag `v4.0.0` 的 GitHub Release 正文（发版时直接贴/上传）；含帧协议补强、Agent 自学习协议、Provider 工具链、插件 1.0.0 工具门面化、安装与升级注意、验证状态 |

## tutorials/ —— 上手与贡献教程

| 文档 | 内容 |
|---|---|
| [01-芯片开发上手_独立WebUI](tutorials/01-芯片开发上手_独立WebUI.md) | A 篇（已实拍）：启动 → 装包 → 适配 → 全闭环 → 证据 → 串口工作台 → 双通道波形上手任务；STM32F411CEU6 实机截图 |
| [02-市场适配包贡献](tutorials/02-市场适配包贡献.md) | B 篇（命令均本机实跑）：包结构 → 市场链路 → 探测填事实 → 本地跑通 → 上架 → 准入 7 条 → 自查清单；无需硬件 |
| [03-插件市场使用_独立WebUI](tutorials/03-插件市场使用_独立WebUI.md) | C 篇（已实拍）：市场浏览/搜索 → 安装 → 已安装管理 → 启用切换 → 回闭环；含限流兜底实拍 |
| [04-调试面板上手_STM32F103C8T6](tutorials/04-调试面板上手_STM32F103C8T6.md) | **调试工作区**（已实拍）：真实 HardFault 排错主线 —— 断点 → 调用栈 → 寄存器 → 监视 → 内存 → 外设（P2）→ RTOS 栈水位（P3）→ 审计 → 修复重烧 → 串口恢复 |
| [05-DSH插件上手_STM32F103C8T6](tutorials/05-DSH插件上手_STM32F103C8T6.md) | D 篇（已实拍）：DSH 右侧栏四块 → 自动只读探测接入 → 三连 → 串口心跳判活/关闭监视 → 调试工作区（单步/断点/变量/寄存器/关闭恢复）；STM32F103C8T6 实机截图 |
| [06-CLI终端闭环上手](tutorials/06-CLI终端闭环上手.md) | **终端闭环上手**（实机 F411）：一条 `elab loop` 跑完 5 阶段，终端按输出类型分色，含 doctor/build/flash/debug/monitor 逐步截图 |
| [07-串口面板使用](tutorials/07-串口面板使用.md) | **串口面板上手**（实机 F103 + ESP32）：发送/历史/定时 → 四视图 → 波形多面板 → 断线重连 / 日志诊断 / 帧协议 / TCP-UDP；§5.6 为帧协议 P0/P1（位域/变长/多 ID/模板/组帧）实机演示；§5.7.9 为 **Agent 自学按钮实操**（粘样本 → 学习 → 复核 → 直播解码，实拍截图） |
| [08-串口压力测试报告_STM32F411CEU6](tutorials/08-串口压力测试报告_STM32F411CEU6.md) | **串口压力测试报告**（实机 F411）：高压收发下的丢包/挤出/时序统计与结论 |

## requirements/ —— 需求对照

| 文档 | 内容 |
|---|---|
| [需求对照与改进](requirements/需求对照与改进.md) | 驾驶舱 R1–R10 / 插件目标 / 串口 P1–P3.5 / 市场 R1–R4 + backlog |

## 其他

- `tutorials/assets/`：实机教程的截图（`debug-panel/` 调试工作区 P1/P2/P3、`cli-terminal/` 终端闭环、`wave-panel/` 串口与波形面板、`serial-2/` 串口 M2/M4–M7（独立 WebUI）、`serial-frames/` 帧协议 P0/P1（位域/变长/多 ID/组帧）、`wave/` 同一批能力在 DSH 右栏的实拍、`dsh/` DSH 右侧栏、`webui/` 芯片上手）；
  README 首屏与调试/串口章节也直接引用其真机截图。
- 实机验证截图在 `packages/dsh-elab-cockpit/docs/screenshots/`（插件 README 使用）。
- 版本变更记录在仓库根 [CHANGELOG.md](../CHANGELOG.md)；工作规则见 [AGENTS.md](../AGENTS.md)。
