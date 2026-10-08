# OTA 双槽回滚（A/B Bank）技术方案 —— F411CEU6 执行稿

> 工程：`examples/STM32F411CEU6`（APP）＋ `examples/F411CEU6_BOOT`（Bootloader）
> 组件：`components/ota`（core 芯片无关 / port 平台层）
> 前置：**OTA_F411_移植技术方案 M0~M5 已全闭环**；分区表单源化（`ota_layout:` 节 →
> `ota_layout_gen.h` → doctor 三方对账）已落地（技术方案_闭环驾驶舱 §22）
> 状态：**方案评审稿**（M0 未动工；触发条件见 §1.2）
> 姊妹篇：`OTA_F411_移植技术方案.md`（单槽移植，本文的全部基线）

---

## 1. 动机与范围

### 1.1 缺口分析（单槽已覆盖 vs 双槽补什么）

| 故障类型 | 现有防线 | 实弹证据 | 双槽是否需要 |
|---|---|---|---|
| 传输坏帧 | 停等协议 NAK 重传 | M5.1 PASS 24.9s | 否 |
| 传输中拔电 | offset 断点续传 | M5.2 `offset=14336` 续传 PASS | 否（需 bank 标记，§4.4） |
| 固件 CRC 不匹配 | 设备侧 CRC_FAIL 判定 → 拒绝升级 | M5.3 PASS 32.3s | 否 |
| 升级失败无固件 | boot 2s 窗口 + `'!'` 永远可重升（boot 独立存活） | 单槽天然 | 否 |
| **CRC 合法但功能坏**（挂死/跑飞/外设初始化失败） | **无** | —— | **是（本文唯一目标）** |

单槽升级是"先擦后写"——新固件直接覆盖 ACTIVE 区，CRC 校验只能保证
"传输正确"，不能保证"固件能用"。CRC 合法但启动即挂死的固件一旦写入，
设备只能靠人工插探针重烧。双槽 = 新固件落 INACTIVE 槽试运行，
**自检不过自动回滚老固件**，这是唯一能封死该缺口的形态。

### 1.2 触发条件（何时应开工）

- **值得开工**：设备进入无人值守远程升级阶段（部署后摸不到板子、无法插探针）。
- **暂缓**：开发期人在板边（现状）——现有 M5 防线 + 手工重烧已覆盖全部实际路径。
- 双槽的代价：APP 可用区 448K → 192K/256K（现固件 38K，无实际影响）、
  boot 代码复杂度 +约 200 行、app 侧 1 处 `OTA_Confirm()` 侵入（见 §4.5，不可避免）。

### 1.3 非目标

- 不改停等协议帧格式与上位机传输逻辑（host 传输路径**零改动**）；
- 不做差分升级/压缩传输（后续独立议题）；
- 不做外部 flash 槽位（F411 无 QSPI，片内扇区已够）。

---

## 2. 架构友好性盘点（为何改造量可控）

| # | 事实 | 证据 | 对双槽的意义 |
|---|---|---|---|
| 1 | `APP_START_ADDRESS` 全工程仅 `ota_boot_flow.c` 7 处使用 | `grep -rn APP_START_ADDRESS components/ota/core/` | 跳转目标"宏 → 运行时函数"是纯局部重构 |
| 2 | boot 全程负责擦写，APP 从不碰 flash | `ota_boot_flow.c:53,121,251,287`（唯一 Program/Erase 调用面） | 写 INACTIVE 槽时执行的是 boot 代码（S0+S1），与两槽零冲突，无需 F4 "写 flash 停转"绕行 |
| 3 | 状态页 append-only slot 机制成熟 | `ota_flash_store.c`（4096 槽磨损均衡） | bank 记录复用同一机制，只是新记录类型 |
| 4 | 分区表单源化管道已铺好 | chips yaml `ota_layout:` → gen 头 → doctor 对账（§22） | 槽地址加进 yaml 即全链路生效 |
| 5 | 升级流程六步 probe→trigger→transfer→verify→reset→listen 不变 | M0~M5 事件流 | host / cockpit 工具页零改动 |

---

## 3. Flash 布局（F411 扇区边界硬约束）

512K 总量、扇区几何 16K×4 + 64K + 128K×3，槽边界**必须对齐扇区**：

| 区域 | 扇区 | 地址 | 大小 | 说明 |
|---|---|---|---|---|
| Bootloader | S0+S1 | 0x08000000 | 32K | 不动 |
| Upgrade State | S2 | 0x08008000 | 16K | 不动，记录类型扩展 |
| Offset Record | S3 | 0x0800C000 | 16K | 不动，加 bank 标记 |
| **槽 A** | S4+S5 | **0x08010000** | **192K**（0x30000） | 出厂固件 / 默认 ACTIVE |
| **槽 B** | S6+S7 | **0x08040000** | **256K**（0x40000） | INACTIVE，升级目标 |

- 不对称（192/256）是扇区几何决定：S4=64K 不可与 S5 拆分。固件 38K，余量 5~6 倍，无实际影响。
- 双槽与单槽**互斥声明**：chips yaml `ota_layout:` 写了 `slot_b:` → 双槽模式；
  只写 `app:` → 单槽（现行为，AT32/F103 零回归）。

### 3.1 yaml 单源扩展（照 §22 管道）

```yaml
# chips/st/stm32f411ceux.yaml 的 ota_layout: 节追加
ota_layout:
  boot:   { addr: 0x08000000, size: 0x8000 }
  state:  { addr: 0x08008000, size: 0x4000 }
  offset: { addr: 0x0800C000, size: 0x4000 }
  app:    { addr: 0x08010000, size: 0x70000 }    # 单槽语义保留（= 槽A+槽B 合并视图）
  slots:                                        # ★ 声明即双槽模式
    - { addr: 0x08010000, size: 0x30000 }       # 槽 A（出厂 ACTIVE）
    - { addr: 0x08040000, size: 0x40000 }       # 槽 B
```

gen 头新增宏（`ota_layout.py` 渲染器扩展，未声明 `slots:` 不产出 → 单槽零变化）：

```c
#define OTA_SLOT_COUNT        2
#define OTA_SLOT0_ADDR        0x08010000UL
#define OTA_SLOT0_SIZE        0x00030000UL
#define OTA_SLOT1_ADDR        0x08040000UL
#define OTA_SLOT1_SIZE        0x00040000UL
```

doctor 对账扩展：`slots:` 声明后，校验 ① 槽间互斥且 ⊆ 物理 flash；
② 槽地址与 `app.addr` 区域连续覆盖（防"声明了槽却留洞"）；
③ `flash.images` 的 app 镜像地址命中槽 A 起点（出厂镜像永远烧槽 A）。

---

## 4. 核心设计

### 4.1 bank 记录（复用 append-only slot 存储）

状态页现有记录 = 4B 状态字（`0xA5A5A5Ax`）。新增 **20B（5×32位词）bank 记录**，
append-only 追加、"读最后一条合法记录"语义不变（M2 落地格式，含 §9 版本字段）：

```
词   字段
W0   magic = 0xA5A5A5B0（与状态字 0xA5A5A5Ax 系列区分）
W1   active(b7:0) | pending(b15:8, 0xFF=无试运行) | trial(b31:16, LE16)
W2   槽0 版本 {major, minor, patch, 0}（§9.2 防回滚判据源）
W3   槽1 版本 {major, minor, patch, 0}
W4   crc32（W0..W3 前 16 字节，防记录本身损坏）
```

写侧：bank 区内找连续 5 个空槽写入；找不到 → 擦整个状态扇区 → 先补写
状态字（restore_state，下半段槽 0）→ 再从头写记录。
读侧规则（**防变砖的底线**）：magic 或 CRC32 不合法 → 视同"无记录"，
回落 `active=0`（槽 A）单槽行为。**boot 永远不能因为 bank 记录损坏而无法启动**——
这是回滚路径自身的可用性要求，优先级高于一切优化。

### 4.2 boot 决策流（每次上电）

```
CheckState()
  ├─ 读 bank 记录（不合法 → 默认单槽语义，见 §4.1）
  ├─ STATE_UPGRADE_READY / UPGRADING / CRC_FAIL → 现有流程不变
  │    （★ 升级目标槽 = INACTIVE(active_bank)，由 boot 自选，协议零改动）
  ├─ STATE_UPGRADE_SUCCESS → 现有"清状态→RUNNING"扩展为：
  │    写 bank 记录{active=另一槽, pending=该槽, trial=3} → 复位
  ├─ pending_bank != 0xFF：
  │    ├─ 本槽启动前 trial -= 1 并落盘（★ 先减后跳，掉电安全）
  │    ├─ trial 耗尽 → 写回滚记录{active=原槽, pending=0xFF}
  │    │   打印 === ROLLBACK: bank<pending> failed trial, back to bank<active> ===
  │    │   → 跳原槽（自动回滚完成）
  │    └─ trial > 0 → 跳 pending 槽（试运行）
  └─ 否则 → 跳 active 槽（现行为）
```

**trial 落盘时机**：必须**先递减落盘、再跳转**。若先跳后记，新固件挂死
在早期时计数器永远不减 → 死循环在坏固件里 = 变砖。这是本方案最重要的时序约束。

### 4.3 确认路径（OTA_Confirm）

```
app 自检通过（F411 判据 = 心跳任务第 3 次 [alive] 打印成立，与 monitor 闭环判据同源）
  → OTA_Confirm()：写 bank 记录{active 不变, pending=0xFF} → boot 下次上电走普通路径
```

- `OTA_Confirm()` 收进 `components/ota`（新 `core/ota_confirm.c`，port 复用
  flash_store），app 只需一行调用——**试运行语义本质要求固件自证活性，
  这 1 处侵入无法避免，也不该隐藏**。
- Confirm 过晚的容忍：trial=3 只约束"能到达心跳"，不约束时长；
  若固件 3 次上电内都能活到心跳（哪怕每次 30s），不会误回滚。

### 4.4 offset 记录加 bank 标记

现有 offset 记录 `0xA5A5A5B0` 系列语义不变，payload 高位加 1B bank
（INACTIVE 槽续传时恢复"擦剩余区"的基地址用）。**不引入会出现：在槽 B
传到一半拔电、复电后 boot 用槽 A 基地址续传 = 写穿**。这是双槽化最容易埋的雷，
M2 必须有对应单测。

### 4.5 协议与上位机

- **协议帧格式零改动**；CMD_SET 可选加 `CMD_QUERY_BANK(0x16)`（查 active/pending/trial，
  应答 4B）——列为可选件，M4 验收可只靠日志关键字。
- host `cli_flash.py` **零改动**（boot 自选槽）；cockpit `f411.yaml` tools 节
  可选加 `ota-query`（调 `--query-bank`）。
- 出厂烧录 `flash.images` 不变（boot@0x08000000 + app@0x08010000=槽 A）。

---

## 5. 逐文件改造清单

| 文件 | 改动 | 量 |
|---|---|---|
| `chips/st/stm32f411ceux.yaml` | `ota_layout:` 加 `slots:` | 3 行 |
| `services/elab/ota_layout.py` | 渲染器 + 归一化支持 `slots:`（未声明不产出宏） | +40 行 |
| `services/elab/doctor.py` | `ota_layout_drift` 加槽校验（§3.1） | +30 行 |
| `components/ota/core/ota_common.h` | bank 记录格式 / `OTA_BANK_*` 常量 | +30 行 |
| `components/ota/core/ota_flash_store.c/.h` | `BANK_Get()/BANK_Set()`（复用 slot 机制，12B 记录） | +80 行 |
| `components/ota/core/ota_boot_flow.c` | 7 处宏 → `ota_app_start()`；SUCCESS/PENDING/ROLLBACK 决策流 | +120 行 |
| `components/ota/core/ota_boot_port.h` + `port/*/ota_jump.c` | 跳转接口加目标地址参数（现读宏） | +10 行 |
| `components/ota/core/ota_confirm.c/.h`（新） | app 侧确认 API（写 pending=0xFF） | +40 行 |
| `components/ota/core/ota_offset.c` | 记录 payload 加 bank 字节（§4.4） | +20 行 |
| `examples/STM32F411CEU6`（app） | 心跳判据后 1 行 `OTA_Confirm()` | 1 行 |
| `tests/test_ota_layout.py` 等 | 槽归一化/对账/bank 记录/决策流单测 | +20 例 |

**红线**：AT32/F103 芯片 yaml 不声明 `slots:` → gen 头无槽宏 → bank 代码
全部 `#if OTA_SLOT_COUNT > 1` 条件编译 → 单槽零回归（照 `expected_crc` profile 门控先例）。

---

## 6. 里程碑（每步带验收判据）

### M0 设计冻结（本文档评审通过）
状态记录格式 / trial 时序（先减后跳）/ 确认判据三项拍板，不动代码。

### M1 yaml + gen 头 + doctor（纯框架侧，无固件）
- `slots:` 归一化/对账单测绿；未声明 `slots:` 的芯片 gen 头无槽宏（diff 验证）。
- 验收：`python -m unittest discover -s tests` 全绿；`doctor -p f411 --deep` 含槽校验 OK。

### M2 boot 核心（真编译 + 离线决策流自测）
- `ota_app_start()` 运行时化；bank 记录 Get/Set；SUCCESS→PENDING→ROLLBACK 决策流。
- offset bank 标记 + 单测（含 §4.4 写穿反例）。
- 验收：boot 双槽编译产物 ELF 含 `"ROLLBACK"` 字符串；单槽编译（去掉 slots）不含；
  全量单测绿。

### M3 app 接入 Confirm
- f411 app 心跳第 3 次后调 `OTA_Confirm()`；编译 + guard untouched。

### M4 实弹验收（插板，四件套，全部 tool: 走 cockpit 工具页）

| # | 注入 | 判据（可 grep） | PASS 标准 |
|---|---|---|---|
| ① | 正常双槽升级 | `[result] PASS` → 复位 → `bank=1 trial=2` → `CONFIRMED` | 新槽试运行后确认，PENDING 清 |
| ② | **坏固件回滚**（核心） | 烧"CRC 合法但启动即挂死"测试固件 → 3 次复位 → `=== ROLLBACK: bank1 failed trial, back to bank0 ===` → 心跳恢复 | 老固件自动回来，全程无探针 |
| ③ | 回滚后再升级 | 重复① | 槽位交替（A→B→A），旧槽擦除不误伤 |
| ④ | INACTIVE 槽传输中拔电 | `--throttle` → 拔电 → 重插 → `[go] bank=1 offset=…` 续传 | bank 标记生效，不写穿 ACTIVE 槽 |

②的坏固件来源：`cli_flash.py` 加 `--hijack-vector`（把入口向量替换为死循环、
CRC 按篡改后数据计算——测试固件必须"合法地坏"）。

### M4 实弹验收记录（2026-10-08，F411CEU6 真机全绿）

| # | 实弹 | 结果 | 关键证据（串口/flash 原文） |
|---|---|---|---|
| ① | `elab flash`（boot+app 双镜像 + C2 台账） | PASS | `✓ 烧录完成：f411_boot.bin + 411.bin`；`✓ boot 烧录台账已更新（v1.0.0）` |
| ② | `tool:ota` 正常双槽升级 | PASS | `[boot] === Upgrade complete ===` → `[ota] CONFIRMED: bankN promoted` |
| ③ | `tool:ota-badfw` 坏固件回滚 | PASS | 周期1 `Trial boot 累计 2 次, 心跳 0`（挂死）；周期2 `=== ROLLBACK: bank1 failed trial, back to bank0 ===` + `Rolling back, jumping to bank0...` + `[alive] tick=0` 心跳重起步 |
| ④ | `tool:ota-check` 0x17 版本决策 | PASS | `[ver] 设备版本 0.2.0 build 5` → `[skip] 已是最新` |
| ⑤ | 槽位交替（openocd 直读 bank 记录） | PASS | R22`{active=0}`→R27`{active=1}`→R32`{active=0}`；pending 目标随交替翻转（0x01→0x00），ver 双槽同步记账 |

④'（`--throttle` 传输中拔电续传）列为可选项，需人工拔电配合，判据不变。

**实弹抓出的两个潜伏缺陷（均已修复回归）：**

1. **★ EraseRange 双语义误用（固件侧，严重）**：`Boot_EraseAppAndReset`
   误用向上对齐的 `OtaFlashHal_EraseRange`（续传语义，start 所在扇区不动）——
   F411 S4=64K 含 APP 首地址 0x08010000，整片擦除时 S4 被跳过 → 旧 Reset 向量
   残留，后续编程 0xFFFFFFFF 劫持字=按位与空操作 → "坏固件"实际是好的 →
   试运行成功 + Confirm，永不回滚（首测 FAIL 的根因，openocd mdw/dump_image
   取证：槽A==槽B==好固件 + R10 Confirm 签名坐实）。修复：新增
   `OtaFlashHal_EraseRangeFull`（start 向下对齐，所在扇区一并擦），
   `Boot_EraseAppAndReset`（单/双槽路径）切换之；三 port（f4/at32/f1）补齐。
   **教训：向上/向下对齐两个 API 名字必须显式区分语义，续传路径仍用 EraseRange。**

2. **★ 复位窗口打印采集（host 侧）**：`_openocd_reset` 阻塞数秒期间设备打印的
   `Trial boot`/`=== ROLLBACK ===` 堆在串口驱动缓冲，二测时 `_listen_text`
   的 `reset_input_buffer()` 把它们连同残留一起冲掉 → Trial 计 0、心跳却正常
   （tick 从 5006ms 起跳暴露"监听晚了 5 秒"）。修复：清残留提前到复位【前】，
   复位后监听 `clear=False` 续接驱动缓冲（三测 Trial 计 2 + ROLLBACK 全捕获）。
   **教训：清缓冲的时机必须绑定"复位前"，而不是"监听前"；心跳 tick 绝对值是
   判断监听窗口迟到的免费探针。**

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| bank 记录本身损坏 → 启动异常 | §4.1 底线：读不合法一律回落单槽默认；CRC32 保护 + slot append-only |
| trial 时序写反（先跳后记）→ 死循环变砖 | §4.2 时序约束为 M2 强制评审项 + 专项单测 |
| offset 无 bank 标记 → 跨槽写穿 | §4.4 专项单测 + M4-④ 实弹 |
| 单槽芯片误编译 bank 代码 | `#if OTA_SLOT_COUNT > 1` 全量包裹 + at32/f103 回归构建 |
| Confirm 判据过严 → 好固件被误回滚 | 判据=心跳成立（与闭环 monitor 同源）；trial=3 容忍 3 次上电 |
| 双槽下 doctor 对账漏槽 | M1 把槽校验做进 `ota_layout_drift`，编译前拦截 |

## 8. 工作量估算

M1 ≈ 0.5 天 · M2 ≈ 1~1.5 天 · M3 ≈ 0.5 天 · M4（插板四件套）≈ 0.5 天。
合计一个完整 M 级任务；M1/M2 可在无板环境先行，M4 需要用户插板配合。

---

## 9. 版本自迭代机制（无人值守升级的决策依据）

> 独立价值：**不依赖双槽即可先行落地**（单槽下 host 照样需要"该不该升"的判据）。
> 与双槽的耦合点只有一处：回滚后版本自动回落，host 决策必须能接受（§9.4）。

### 9.1 版本三层模型

| 层 | 载体 | 谁控制 | 语义 |
|---|---|---|---|
| **声明层**（semver） | `projects/*.yaml` 的 `version: 1.2.3` | 人控 major/minor；patch 由 release 命令自动 bump | "功能代际"——升级判据的唯一依据 |
| **自动层**（build 号） | `.work/versions.json`（elab 维护，单调整数） | elab 每次成功 build +1 | "产物代数"——仅追溯用，**不参与升级决策**（同源码重编也 +1，比较它没有意义） |
| **嵌入层** | gen 头宏 + bin 内嵌 `.version` 段 + 运行时查询 | 构建时从上两层生成 | 设备/产物各自报版本，比对即决策 |

组合工程（§10）下版本**唯一事实源挂在主 app 的 yaml**，boot 继承同版本号
（boot 极少迭代，版本冻结策略见 §10.3）。

### 9.2 固件内嵌与查询（双通道）

**bin 内嵌**（离线识别，无需设备在线）：`.version` 固定结构段——

```c
typedef struct {           /* 放 .version 段，链接脚本固定位置（bin 尾部对齐 4B） */
    uint32_t magic;        /* 0x56455231 'VER1' */
    uint8_t  ver[3];       /* semver major/minor/patch */
    uint32_t build;        /* LE */
    uint32_t crc32;        /* 前 11B */
} OtaVersionTag;           /* host 从 bin 读取 → 无需解析 ELF */
```

**运行时查询**：`CMD_QUERY_VERSION(0x17)` → 应答 `{semver 3B, build 4B LE}`（8B）。
boot 与 app 各自应答自己的版本（boot 版本独立冻结，见 §10.3）。

gen 头扩展（照 §22 管道，同一 `elab_gen/`）：`OTA_VER_MAJOR/MINOR/PATCH/BUILD` 四宏，
app 的 version tag 结构体直接引用——**版本注入与分区表同一条下传管道**。

### 9.3 metadata 帧扩展（type 0x02：带版本的升级）

现有 metadata 帧（M5.3）：`seq=0xFF, payload=[0x01][CRC32 4B]`，boot 判别
`len==5 && data[0]==0x01`（`ota_boot_flow.c:224`）。扩展：

```
seq=0xFF, payload=[0x02][CRC32 4B][semver 3B][build 4B]   （len=12）
```

- 新 boot：认 0x01 与 0x02（0x02 额外存 `s_IncomingVersion` 供 §9.4 防回滚比对）；
- **旧 boot 兼容已验证**：`data[0]==0x02` 不满足 224 行判别 → `meta_ok=0` → NAK →
  host 回落不带版本的 0x01 握手（profile 门控 `send_version: true/false`）。
  type 字节就是为这种演进而留的，扩展点干净。

### 9.4 升级决策与防回滚（关键边界）

**host 侧决策**（`elab ota --check` / release 流程内置）：

| device semver vs artifact semver | 动作 |
|---|---|
| device < artifact | 升级 |
| device == artifact | skip（打印 up-to-date；`--force` 才重传） |
| device > artifact | 告警并拒升（`--force` 才允许降级） |

**boot 侧防回滚**（收到 type 0x02 时）：新镜像 version **>= ACTIVE 槽版本**才接收，
低于 → NAK 带版本错误码。

> ★ 边界必须写死：防回滚**只约束"新写入的镜像"**，**绝不约束 boot 落回旧 ACTIVE 槽**
> ——回滚本来就是往旧版本跑。若把防回滚做成"设备版本只能前进"，§4 的回滚机制自废。
> 一句话：**防回滚防的是"写坏的方向"，不是"跑的方向"**。

回滚后的自然表现：QUERY_VERSION 回到老版本 → host 下一轮决策视为"待升级"，
正好重新触发修复后的升级——无人值守闭环自洽。

### 9.5 `elab release`：一条命令的无人值守闭环

```
elab release -p f411 [--bump patch|minor|major] [--deploy]
  ① bump：patch 默认自动 +1（写回 projects yaml，diff 可审）；major/minor 显式指定
  ② build：按 §10 组合顺序构建（boot 缓存命中则秒过）→ 产物 fw_<semver>+b<build>.bin
  ③ 留档：.work/releases/<semver>+b<build>/ 产物 + RELEASES.md 自动追加一行
     （版本 / 时间 / git describe / 上游 run id）
  ④ --deploy：接探针时直接跑 tool:ota 六步（QUERY_VERSION → 决策 → 传输 → 判定）；
     无探针则产物留档，交远程 agent 拉取（无人值守形态）
```

幂等性：同 semver 重复 release → build 号不同、升级决策照常比对 semver → skip，
不会把同一版本反复刷进设备。

### 9.6 改造清单（叠加在 §5 之上）

| 文件 | 改动 |
|---|---|
| `services/elab/version.py`（新） | 版本读写/build 号/`elab release` 命令（约 150 行） |
| `services/elab/ota_layout.py` | gen 头加版本四宏（读 projects yaml version + build 号） |
| `projects/*.yaml` | `version: 0.1.0` 声明 |
| `components/ota/core/ota_protocol.c` | `CMD_QUERY_VERSION(0x17)` 应答（boot/app 各自注册） |
| `components/ota/core/ota_boot_flow.c` | metadata type 0x02 解析 + 防回滚比对（约 +40 行） |
| `iap_host_tool/` | `--check`/`--force` + release 流程调用 |
| Cockpit | 工程卡片显示版本号（`version` 已在 ProjectCard 可加字段） |

工作量：+0.5~1 天（M1 可并入 gen 头扩展；0x17/0x02 并入 M2；release 命令独立小步）。

---

## 10. boot 与 app 同仓组合工程（OTA 入舱平台化）

### 10.1 现状成本（为什么"每次新建一个工程"是痛点）

- boot/app 两个独立工程 → 两条 build 命令、两张 cockpit 卡片、两份 yaml；
- 换芯片 = 又要新建一个 boot 工程（实际 boot 代码 95% 与芯片平台绑定，与业务无关）；
- `tool:ota` 只挂在 app 工程的 tools: 节，boot 变更后忘记重编 boot 是真实风险。

### 10.2 设计（已落地 2026-10-08）：**chips yaml 单字段声明，不做源码合并**

`chips/<平台>/<芯片>.yaml` 的 `ota_layout:` 节追加一个字段：

```yaml
ota_layout:
  boot:   { addr: 0x08000000, size: 0x8000 }
  ...
  boot_project: f411_boot     # ★ C1：build app 自动级联、flash 按台账带 boot
```

比早期的 `compose:` 工程级声明更简：boot 与 app 共用同一份 chips yaml，
布局与 boot 工程名天然同源；自引用（boot 工程自己也读到 `boot_project:
f411_boot`）被 `resolve_boot_project` 判定为"我就是 boot"→ 返回空，
boot 自身不再级联、不参与冻结台账——防递归与语义统一为一条规则。

- **C1 build 级联**（`builder.build_with_boot`）：`elab build -p f411` 成功后
  自动构建 `f411_boot`，boot 结果**独立**追加进构建报告（CI 产物收集
  C22/C23 直接兼容）；`--all` 场景 seen 集合去重；
- **C2 flash 台账**（`flash.boot_flash_decision`）：boot bin 的 **md5 指纹**
  vs `.work/<boot工程>/flash_stamp.json`——一致 → 本次 openocd 会话
  **剔除 boot 镜像**（`_samefile` 识别 `${ELAB_ROOT}` 与 `${work_dir}` 两种
  写法指向同一文件）；不一致/无台账 → boot 镜像进会话头部（去重），烧成后
  更新台账；`elab flash --reflash-boot` 强制重烧；
- **C3 冻结语义**：判据是**产物指纹**而非版本号（boot build 号每次构建递增，
  只是追溯层；指纹不变 = boot 字节没变）；boot 是回滚资本的资本，
  日常 app 迭代对 boot 字节级零触碰。

**为什么不做"boot 塞进 app 工程源码树"**：两条链接脚本、两套向量表、
CubeMX 工程结构互斥、HAL 版本该解耦（boot 越小越稳，变砖面越小）——
组合声明保持"一切皆组件、业务工程零侵入"（C 系列哲学），合并反而制造耦合。

### 10.3 boot 复用与缓存：迭代的是 app，boot 冻结

- build 侧：Ninja 增量构建天然幂等——boot 源码未变时级联构建秒过（只重跑
  configure 探测 + no-op build）；内容寻址缓存（hash 源码树跳过 configure）
  列为后续优化，非必需；
- flash 侧：C2 台账即冻结——这是**安全阀**而非性能优化：无人值守自迭代
  （§9.3 `--check` 跳过同版）+ boot 冻结，保证自动流程永远碰不到 boot；
- 换芯片"新建工程"退化为：platform skill 出 composite 模板（boot 工程 +
  app 工程 + 一份含 ota_layout/slots/boot_project/version 的 chips yaml），
  实例化一次后所有迭代只动 app 源码 + bump 版本。

### 10.4 落地状态（2026-10-08 全部完成）

| 步 | 内容 | 状态 |
|---|---|---|
| C1 | chips yaml `boot_project` + `resolve_boot_project` + `build_with_boot`（seen 去重、报告聚合） | ✅ f411 实测：一条命令 app+boot 双构建 |
| C2 | `boot_flash_decision` md5 台账 + 会话镜像过滤 + `--reflash-boot` | ✅ 干跑三态实测（flash/skip/force） |
| C3 | 冻结语义（指纹判据、boot 字节零触碰） | ✅ 并入 C2 |
| C4 | 驾驶舱 OTA 投影：`project_cards` 每卡派生 `ota`（boot_project/slots/boot 台账）与 `boot_owner`（交叉引用归属）；UI 端 boot 子工程嵌在宿主卡正下方缩进渲染（`↳ BOOT 子工程·f411` 标签 + 左缘连接线），OTA 行显示"双槽×2 · boot v1.0.0 · 冻结 时间" | ✅ 2026-10-08（dist 已重建，209 测试回归 OK） |
| cockpit 单卡片分段日志 | boot 构建结果经 C1 已进报告，UI 分段渲染为后续增强 | ⏳ 未做（不阻塞） |

C4 实现要点（遵守 §6 卡片纪律"100% yaml + 派生文件位"）：
`ota` 全部派生自 chips yaml `ota_layout` + `flash.boot_stamp()` 读台账文件，
`boot_owner` 由卡间交叉引用推导（自引用除外），**不新增任何元数据**；
前端零推导，只按字段分组渲染。

### 10.5 与双槽里程碑的合并

§6 里程碑相应并入：**M1 = yaml/gen 头/doctor（含版本四宏与槽扩展）·
M2 = boot 核心（含 metadata 0x02 + 0x17 + 防回滚）· M3 = app Confirm ·
M4 = 实弹四件套**；§9.5 release 命令与 §10 组合工程（C1~C3）为并行独立线，
不阻塞双槽主线。总工作量：双槽主线约 3 天 + 版本线约 1 天 + 组合线约 1.5 天。
