# components/ota — OTA 升级组件（elab「一切皆组件」）

从 `STM32-OTA-QT`（F103 回归基准）与 AT32 工程提升的**零功能阉割** OTA 中间件。
技术方案：`examples/STM32F411CEU6/doc/OTA_F411_移植技术方案.md`（§3）。

## 分层

```
ota/core/    芯片无关唯一真源（协议帧状态机 / slot 磨损均衡存储 / 断点续传 /
             升级状态机 / CRC32 / Transport 抽象 / boot 场景层 ota_boot_flow /
             组件发现 ota_cap）
ota/port/<platform>/  芯片 HAL 映射（flash_hal / delay / jump / key / printf /
                      app_hook；只准调芯片 SDK 与组件 core）
```

## 接入（业务工程）

```cmake
include(${ELAB_ROOT}/components/components.cmake)

# BOOT 工程：状态机 + 串口实例（依赖自动递归接入）
elab_use_component(${PROJECT_NAME} ota VARIANT boot PLATFORM stm32f4
                   LAYOUT_HEADER ota_layout_f411.h CAP_BITMAP 0x1)

# APP 工程：触发钩子（'!'×5 → 业务停机回调 → READY → 2s → 复位）
elab_use_component(${PROJECT_NAME} ota VARIANT app PLATFORM stm32f4
                   LAYOUT_HEADER ota_layout_f411.h CAP_BITMAP 0x1)
```

## 配置项

| 变量 | 必填 | 说明 |
|---|---|---|
| `OTA_PLATFORM` | ✅ | `stm32f4` / `at32` / `stm32f1` |
| `OTA_VARIANT` | | `boot`（默认）/ `app`，按变体裁剪源文件 |
| `OTA_LAYOUT_HEADER` | ✅ | 布局头名（`ota_layout_f411.h` 等，§3.2 配置面） |
| `OTA_CAP_BITMAP` | | 组件位图（v1.2 发现协议；不传则 `OtaCap_AutoInit()` 报 0） |

## 组件发现（v1.2，可选）

- Boot/APP 固件可应答 `CMD_QUERY_COMPONENTS(0x15)` → `RSP_COMPONENTS(0x24)` 4B 位图 LE。
- 位图**单一数据源**：`components/components.cmake` 注册表 → 本目录 `capabilities.json`
  （configure 生成）→ 上位机动态出 UI。禁止 MCU/host 两端各自硬编码。
- 不编入 `ota_cap.c`（或不调 Init）时 0x15 走既有 NAK 路径 —— 旧固件行为零变化。

## APP 侧业务差异注入（准入规则 #2）

产品停机链**不进组件**。工程注册自己的停机回调：

```c
OtaHook_SetOnUpgradeReady(my_business_safe_stop);  /* 例：BLDC 缓停+关 PWM */
/* F411 工程不注册 = 该环节自然为空 */
```

## 验收契约

- `components/` 单独 configure 通过；core 编译零警告（-Wall -Wextra）。
- AT32 回归：工程 `USE_SHARED_OTA_CORE` 指向本组件 core 后 build + 目标码逐字节对比。
- 准入扫描：`grep -rE '#include "(Sguan|main\.h|KEY\.h|.*ESC.*)"' components/` 命中数为 0。
- boot 产物 ≤ BOOTLOADER_SIZE（F411 = 32K）。
