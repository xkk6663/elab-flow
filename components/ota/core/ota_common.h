#ifndef OTA_COMMON_H
#define OTA_COMMON_H

#include <stdint.h>

/**
 * @defgroup OTA_Global_Constants OTA 全局常量定义
 *
 * 所有与硬件无关的全局常量集中在此文件。
 * ★ 平台化改造（elab components/ota，2026-10）：Flash 布局常量不再硬编码
 *   F103C8 布局，改由各 port 的布局头提供（CMake 下传 OTA_LAYOUT_HEADER）。
 *   - port/stm32f1/ota_layout_f103c8.h  （18K boot + 44K app + 2×1K 参数页）
 *   - port/at32/  ota_layout_at32f421.h （同 F103 布局，1K 扇区）
 *   - port/stm32f4/ota_layout_f411.h    （32K boot + 16K×2 参数扇区 + 448K app）
 *   语义不变：布局常量名、状态值、传输页（1024B）粒度与源工程一致，
 *   上位机与协议层零感知。其余文件零改动。
 * @{
 */

/* ── Flash 布局（来自 port 布局头）──────────────────────────────── */
#ifndef OTA_LAYOUT_HEADER
#error "OTA_LAYOUT_HEADER 未定义：请在 CMake 中为组件目标下传 -DOTA_LAYOUT_HEADER=\"ota_layout_<chip>.h\""
#endif
#include OTA_LAYOUT_HEADER

/* ── Application Parameters（源工程语义，port 也可覆盖）──────────── */
#ifndef PACKET_SIZE
/** 数据帧最大载荷 / Flash 编程单位 (128 字节) */
#define PACKET_SIZE             128
#endif
#ifndef DMA_RX_BUF_SIZE
/** DMA 接收环形缓冲区大小 (2 的幂) */
#define DMA_RX_BUF_SIZE         1024
#endif

/* ── Upgrade States（与源工程逐值一致）──────────────────────────── */

/**
 * @brief 升级状态类型
 * @note 使用 uint32_t 而非 enum，避免 ARMCC 对有符号 int 范围溢出的警告。
 */
typedef uint32_t UpgradeState;

/** @brief 正常运行，Bootloader 等待 2s 后跳转 APP */
#define STATE_RUNNING           ((UpgradeState)0xA5A5A5A0)
/** @brief APP 请求升级，Bootloader 应擦除 Flash 并接收固件 */
#define STATE_UPGRADE_READY     ((UpgradeState)0xA5A5A5A1)
/** @brief 正在接收固件数据，支持断电续传 */
#define STATE_UPGRADING         ((UpgradeState)0xA5A5A5A2)
/** @brief 固件接收完成但 CRC 校验失败 */
#define STATE_CRC_FAIL          ((UpgradeState)0xA5A5A5A3)
/** @brief 固件校验通过，下次启动可跳转运行 */
#define STATE_UPGRADE_SUCCESS   ((UpgradeState)0xA5A5A5A4)

/** @} */

#endif /* OTA_COMMON_H */
