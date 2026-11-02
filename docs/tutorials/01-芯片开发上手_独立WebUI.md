# 芯片开发上手：独立 WebUI 全闭环（STM32F411CEU6 实机实拍）

> 目标读者：第一次用 elab-Flow 的嵌入式开发者。
> 读完你能：启动独立 WebUI → 装芯片包 → 接入工程 → 跑通全闭环 → 看懂证据 → 用串口工作台验证设备输出（含多通道波形）。
>
> **拍摄口径**：全部截图来自同一次实机环境——STM32F411CEU6 + CMSIS-DAP（atlink）+ COM10@115200，深色主题，1600×1000。图中数字与当时服务端记录同源，未做任何修饰。
> 配套阅读：市场装包详见 [插件市场使用](03-插件市场使用_独立WebUI.md)；贡献自己的芯片包见 [市场适配包贡献](02-市场适配包贡献.md)。

---

## 0. 你将得到什么

一次闭环 = **体检 → 编译 → 烧录 → 调试校验 → 串口监视**，五步全部在一个三列界面里完成：

- **左列（工程轨）**：工程卡片 + 芯片事实（内核/存储/OTA/探针/串口），芯片事实来自当前启用的适配包；
- **中列（阶段轨）**：「▶ 跑全闭环」、单步执行、运行选项、构建产物、阶段账本——每一步的用时与结论都记账；
- **右列（证据轨）**：四个工作区（构建 / 烧录 / 串口 / 工具），日志、内存占用、串口波形都在这里。

最终效果预览（本教程第 8 章的实拍照）：agent 发起的 run 带 `agent` 标签全绿收官，右列串口「波形」视图同时渲染两条**相位差半个周期**的正弦曲线（FireWater 双通道）：

![总览：闭环全绿 + 双通道波形](assets/webui/A-14-serial-wave-2ch.png)

---

## 1. 启动独立 WebUI

**为什么**：WebUI 只是内核（`cockpit.server`）的一张脸——所有闭环能力都在内核里，界面与 CLI、agent 共用同一套 HTTP API，所以"界面上看到的"与"脚本跑出来的"永远是同一份事实。

步骤：

1. 在仓库根执行 `cockpit.cmd`（或 `python -m cockpit.server`，需 `PYTHONPATH=services`）；
2. 浏览器打开 `http://127.0.0.1:8333`——端口幂等，重复启动不会起第二个服务；
3. 确认顶栏出现版本号（图中 `v2.1.0`）与「串口后端就绪」。

![A-01 启动后的三列布局](assets/webui/A-01-launch.png)

你应该看到：

| 位置 | 事实（与本图同源） |
|---|---|
| 左列 | 5 个工程卡；`f411` 卡标注 `st/stm32f411ceux` · A 类 · Ninja · OTA 双槽×2 · boot f411_boot v1.0.0 |
| 左下角 | 芯片事实：cortex-m4 · hard，flash 512K · ram 128K，探针 atlink「可上板」，串口 auto「就绪」 |
| 右列顶部 | 四个工作区页签：构建 / 烧录 / 串口 / 工具 |

**常见坑**：探针显示「不可上板」时，先查是否有残留的 `openocd` 进程占着调试口（见第 9 章）。

---

## 2. 装一颗芯片

**为什么**：内核本身不认识任何芯片——芯片参数、厂商指纹、平台坑位全部住在**适配包**里（数据，不是代码）。没有包，工程轨就没有芯片事实可显示。

- **主路径（界面）**：顶栏芯片图标 → 市场搜索 / 已安装 → 启用，完整流程见 [插件市场使用](03-插件市场使用_独立WebUI.md)。本篇实拍的 `st/stm32`（官方内置包）与 `artery/at32`（社区包）都是这样装上的。
- **CLI 兜底**（无市场或离线时）：

```powershell
elab.cmd pkg bootstrap          # 安装内置官方包 st/stm32
elab.cmd pkg search stm32       # 搜市场索引
elab.cmd pkg install st/stm32   # 按名安装（哈希强校验）
elab.cmd pkg activate st/stm32  # 启用（一次只启用一套）
```

**常见坑**：装完包工程卡仍显示「—」，九成是忘了「启用」——安装 ≠ 启用。

---

## 3. 接入你的工程

**为什么**：「＋ 适配」是只读预检再写入的两段式——先探测出证据链给你看，你确认后才落 `projects/*.yaml`。探测本身不改任何文件，可以放心乱点。

步骤：

1. 点左列「＋ 适配」，面板展开后填入厂商工程的**绝对路径**（本例：`C:/Users/xiao1/Desktop/ELAB/dsh-elab-flow/examples/STM32F411CEU6`）；
2. 点「探测」——内核按厂商指纹匹配，给出只读报告；
3. 确认无误后点「写入」，新工程卡出现在左列并自动选中（效果即第 1 章 A-01 中的 `f411` 卡；本仓已随带该工程，故不重复演示写入）。

![A-02 适配面板](assets/webui/A-02-adapt-panel.png)

![A-03 探测报告](assets/webui/A-03-adapt-probe.png)

你应该看到（A-03）：

| 字段 | 值 |
|---|---|
| 结论 | **T1 · 可适配**（直接可用） |
| 置信度 | high |
| 工程指纹 | stm32cubemx |
| 识别芯片 | `st/stm32f411ceux` |
| 证据链 | 逐条列出命中的指纹与来源文件 |

**常见坑**：探测结论是 T3（需人工补全）时别硬写——先看证据链里缺了哪条，多半是工程目录里没有可识别的工程文件。

---

## 4. 跑一次全闭环

**为什么**：「▶ 跑全闭环」把五步串成一次 run：任何一步失败即停，阶段账本留下完整现场。它适合"改完代码想看整体"的时刻；排障则用第 5 章的单步。

步骤：

1. 接好板子与 CMSIS-DAP，确认左下角探针「可上板」、串口「就绪」；
2. 点「▶ 跑全闭环」；
3. 观察中列阶段灯逐个点亮：体检 → 编译 → 烧录 → 调试校验 → 串口闭环；
4. 等右列出现 `ok` 徽标。

下图是 **agent 通过 `POST /api/run` 发起的同一次闭环**（run id `r-e7136090`）——WebUI 与 agent 共用同一个内核，run 带上 `agent` 标签，界面实时同步显示，互不干扰：

![A-05 agent 发起的 run 运行中](assets/webui/A-05-run-agent.png)

你应该看到：

| 事实 | 值 |
|---|---|
| run id | `r-e7136090`，标题旁带 `agent` 标签与 `running` 徽标 |
| 阶段灯 | 体检/编译/烧录已绿，调试校验半亮（进行中） |
| 互斥 | run 进行中「串口」工作区的监视按钮自动置灰（约束 N5：串口独占） |

跑完后的全绿收官（全闭环用时 24.52s）：

![A-08 全闭环 ok + 烧录证据](assets/webui/A-08-flash-ok.png)

**常见坑**：烧录报「镜像不存在，请先 `elab build -p f411_boot`」——f411 是 OTA 双镜像工程（boot@app 两个 bin），全闭环只会构建主工程；boot 镜像需先单独构建一次（本仓实跑时就踩到，run `r-1510aaad` 失败后 `python -m elab build -p f411_boot` 再跑即绿）。

---

## 5. 单步执行与预览

**为什么**：排障的粒度是"步"，不是"闭环"。单步按钮可以只跑编译、只跑烧录、只跑调试校验；「预览」则在按下之前先告诉你**到底会执行什么命令**——`--clean` 会真删目录、烧录会真写板，先看再按。

步骤：

1. 展开中列「运行选项」，点「预览」——只读，不派生任何子进程；
2. 核对 argv 是否符合预期（工作目录、芯片、FPU 等宏）；
3. 点对应单步按钮执行，例如「调试校验」。

![A-06 命令预览](assets/webui/A-06-preview-argv.png)

你应该看到（A-06）：

| 步骤 | 预览内容 |
|---|---|
| 体检 | 「不派生子进程」徽标——纯静态只读检查 |
| 编译 | `$ cmake -S .../examples/STM32F411CEU6 -B .../.work/f411 -G Ninja -DELAB_CPU=cortex-m4 -DELAB_FPU=hard -DELAB_MFPU=fpv4-sp-d16 -DELAB_CHIP=stm32f411ceux ...`，随后 `$ cmake --build .../.work/f411` |

单步「调试校验」的结果（run `r-a7aac10e`，4.58s）：

![A-09 调试校验断到 main](assets/webui/A-09-debug-main.png)

| 证据 | 值 |
|---|---|
| 结论行 | `[elab] ✓ 调试闭环成立：已断到 main` |
| 断点 | `Breakpoint 1, main () at .../Core/Src/main.c:84` |
| 寄存器 | `ELAB_STOP pc=0x8017214`，`#0 main () at main.c:84` |
| 退出 | `✓ 退出步骤 debug_verify 用时 4.58s` |

**常见坑**：单步按钮置灰时把鼠标悬上去——tooltip 会明说理由（缺前置产物 / run 进行中 / 探针不可用），不用猜。

---

## 6. 读懂证据

**为什么**：驾驶舱的原则是"结论必须有证据"——绿勾不是结论，日志里的实数才是。RAM/FLASH 占用、产物清单、烧录校验值，全部来自工具链的原始输出。

![A-07 构建证据](assets/webui/A-07-build-evidence.png)

你应该看到（A-07，与图中 Memory region 表同源）：

| 区域 | 已用 | 容量 | 占比 |
|---|---|---|---|
| RAM | 21352 B | 128 KB | **16.29%** |
| FLASH | 43064 B | 448 KB | **9.39%** |

另有三处值得养成习惯看一眼：

- **构建产物**：`4 个产物 · 守卫未触碰`——零改动守卫确认本次构建没有意外改动受保护文件；
- **阶段账本**：`退出步骤 build 用时 7.46s`——每步用时都记账，方便发现异常变慢；
- **烧录日志**（A-08）：`** Programming Finished **`、`** Verified OK **`、`[elab] ✓ boot 烧录台账已更新 (v1.0.0)`——双镜像（boot@app）都校验通过，OTA 台账同步更新。

**常见坑**：「成功」的判据是日志里出现上述结论行，而不是"按钮没变红"——养成看证据轨的习惯。

---

## 7. 串口工作台

**为什么**：串口是嵌入式开发的"另一半闭环"。工作台的四个视图（行 / 字节 / 终端 / 波形）全部投影自**同一份原始字节**——切视图不重开串口、不丢数据。

步骤：

1. 切到右列「串口」工作区，点「打开监视」（端口 auto 自动选 COM10，115200）；
2. 「行」视图看文本流；「波形」视图选解码器（FireWater）看曲线；
3. 需要发数据时用底部发送面板；需要留档时点「录制」。

![A-10 行视图](assets/webui/A-10-serial-lines.png)

![A-11 波形视图（单通道）](assets/webui/A-11-serial-wave.png)

你应该看到（A-11）：

| 事实 | 值 |
|---|---|
| 解码器 | FireWater（ASCII 逗号分隔浮点，通道数自动推断） |
| 徽标 | `8k+01 帧 · 1 通道`（随固件输出滚动增长） |
| 会话 | 「会话 agent」徽标——本次监视由 agent 打开，WebUI 刷新后自动发现并接管显示 |

发送与录制（A-12）：

![A-12 发送面板与录制](assets/webui/A-12-serial-send-record.png)

| 事实 | 值 |
|---|---|
| 发送 | 输入一行回车即发，支持换行符选择与文件按行发送 |
| 录制 | `● 正在录制 → .work/.cockpit/serial-capture-el-20261102-125708.jsonl`（只存字节、有界 5 MiB） |

**常见坑**：监视开着时跑不了含烧录/调试的闭环（409，约束 N5）——不是 bug，先「关闭监视」释放串口。

---

## 8. 上手任务：给固件加一路反相正弦（多通道波形）

**为什么**：单通道曲线只能证明"通了"。加一路**延迟半个周期**（相位 −π，即反相）的正弦，让面板同时渲染两条曲线——这才是对串口多通道能力的真实验证，也是你改动固件 → 重建 → 烧录 → 验证的完整小循环。

步骤：

1. 打开 [freertos.c](../../examples/STM32F411CEU6/Core/Src/freertos.c)，在 `StartTask02` 的 100 Hz 循环里，把单通道输出改为双通道（CH2 = CH1 延迟半个周期）：

```c
static float wave_phase = 0.0f;
wave_phase += 0.0314159f;                 /* 2π × 0.5 Hz / 100 Hz */
if (wave_phase >= 6.283185f) wave_phase -= 6.283185f;
wave_emit_sine2(sinf(wave_phase), sinf(wave_phase - 3.1415927f));
```

2. `wave_emit_sine2` 按 FireWater 协议输出一行两个逗号分隔的浮点（`"a,b\r\n"`）：

```c
static void wave_emit_sine2(float v1, float v2)
{
  char buf[24];
  int n = 0;
  for (int ch = 0; ch < 2; ch++) {
    int milli = (int)((ch == 0 ? v1 : v2) * 1000.0f);
    uint32_t mag = (uint32_t)(milli < 0 ? -milli : milli);
    if (ch == 1) buf[n++] = ',';          /* 通道分隔 */
    if (milli < 0) buf[n++] = '-';
    buf[n++] = (char)('0' + (mag / 1000u) % 10u);
    buf[n++] = '.';
    buf[n++] = (char)('0' + (mag / 100u) % 10u);
    buf[n++] = (char)('0' + (mag / 10u) % 10u);
    buf[n++] = (char)('0' + mag % 10u);
  }
  buf[n++] = '\r';
  buf[n++] = '\n';
  for (int i = 0; i < n; i++) fputc(buf[i], stdout);
}
```

> 注：本工程任务栈仅 512 B，禁用 `printf` 族（实测会压爆栈进 HardFault）；newlib-nano 也没有 `%f`，所以用 24 B 小缓冲 + `fputc` 逐字节拼装毫单位数值。

3. 点「编译」再点「烧录」（或「▶ 跑全闭环」）；本例由 agent 发起 build+flash（run `r-bd50823d`，编译 7.57s + 烧录 3.54s）；
4. 打开串口监视 →「波形」→ 解码器选 **FireWater**。

![A-14 双通道反相波形](assets/webui/A-14-serial-wave-2ch.png)

你应该看到：

| 事实 | 值（与图同源） |
|---|---|
| 徽标 | `4595 帧 · 2 通道 · 跳过 50`（"跳过"的是 `[alive]` 心跳行，非 FireWater 帧，属预期） |
| 图例 | CH0 / CH1 两条曲线，一条过零上升时另一条过零下降——**严格反相** |
| 数据 | 行视图可见 `-0.729,0.729` → `0.000,0.000` → `1.000,-1.000` 的镜像数值对 |
| 服务端 | `GET /api/serial/monitor/decoded` 返回 `channels: 2`、`decoder_by: "agent"`——面板与 agent 读同一份解码帧 |

**常见坑**：波形区显示「0 通道」时先检查解码器——JustFloat 是二进制小端协议，解不了 FireWater 文本帧；选错协议不会报错，只会"什么都没"。

---

## 9. 常见故障

| 症状 | 原因与修法 |
|---|---|
| 烧录报「镜像不存在，请先 `elab build -p f411_boot`」 | OTA 双镜像工程的 boot bin 未构建；先 `python -m elab build -p f411_boot`（或 WebUI 选中 `f411_boot` 工程单步编译）再跑闭环。本教程实拍时真实踩到（run `r-1510aaad`）。 |
| 发起闭环返回 409 / 监视开不了 | 串口独占（约束 N5）：有 run 在跑时不能开监视，反之亦然。等 run 完或先「关闭监视」。 |
| 探针「不可上板」/ openocd 起不来 | 残留 `openocd` 进程占用调试口：任务管理器结束 `openocd.exe`，或 `Get-Process openocd | Stop-Process`。 |
| monitor「不可用」徽标 | 工程 yaml 没有配置心跳判据（`close_on`），串口闭环步被判不可用——编译/烧录/调试不受影响。 |
| 「＋ 适配」探测后工程漂移 | 工程目录被外部改动（换了芯片/改了工程文件），重新「探测」让证据链刷新即可。 |

---

## 附录：命令速查

| WebUI 按钮 | 等价命令 |
|---|---|
| （启动） | `cockpit.cmd` / `python -m cockpit.server` |
| 体检 | `elab.cmd doctor` |
| 编译 | `elab.cmd build -p f411` |
| 烧录 | `elab.cmd flash -p f411` |
| 调试校验 | `elab.cmd debug -p f411` |
| ▶ 跑全闭环 | `elab.cmd loop -p f411` |
| 三档闭环 | `elab.cmd run -p f411 --steps build,flash,debug_verify` |
| 装包 / 启用 | `elab.cmd pkg install <name>` / `elab.cmd pkg activate <name>` |
| 市场索引重生成 | `elab.cmd pkg index`（改包后必跑） |
| 串口一行 | `elab.cmd serial -p f411 --data "hello"` |

> agent 侧：所有按钮动作都有对应的 loopback HTTP API（`POST /api/run`、`POST /api/serial/monitor`…），WebUI 与 agent 共用同一内核，状态实时同源——这正是本教程多幅截图带 `agent` 标签的原因。
