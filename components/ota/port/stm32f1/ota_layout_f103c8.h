#ifndef OTA_LAYOUT_F103C8_H
#define OTA_LAYOUT_F103C8_H

/**
 * @file    ota_layout_f103c8.h
 * @brief   STM32F103C8 Flash 布局（STM32-OTA-QT 源工程语义，逐值一致）
 *
 *   0x08000000  Bootloader  18KB (0x4800)
 *   0x08004800  APP         44KB (0xB000, 页 18~61)
 *   0x0800F800  Offset      1KB  (页 62)
 *   0x0800FC00  State       1KB  (页 63)
 *
 * 1K 页 × 4B = 256 slot（append-only 磨损均衡，源工程 FLASH_STORE_SLOT_COUNT）。
 */

/* ── Flash Layout ───────────────────────────────────
 * ★ 单源化（方案 A/M1）：chips/*.yaml 声明了 ota_layout 节时，构建期生成的
 *   ota_layout_gen.h 会经 -include 先于本文件定义同名宏（生成的值赢）。
 *   本头文件的值退化为【缺省兜底】。F103 芯片 yaml 暂未声明 ota_layout，
 *   当前实际生效的就是下面这些值 —— 与源工程逐值一致。 */
#ifndef FLASH_BASE_ADDR
#define FLASH_BASE_ADDR         0x08000000
#endif
#ifndef BOOTLOADER_SIZE
#define BOOTLOADER_SIZE         0x4800              /* 18 KB */
#endif
#ifndef APP_START_ADDRESS
#define APP_START_ADDRESS       0x08004800          /* 页 18 起始 */
#endif
#ifndef APP_SIZE
#define APP_SIZE                0x0000B000UL        /* 44 KB */
#endif

#ifndef OFFSET_PAGE_ADDR
#define OFFSET_PAGE_ADDR        0x0800F800          /* 页 62（断电续传偏移记录） */
#endif
#ifndef UPGRADE_STATE_ADDR
#define UPGRADE_STATE_ADDR      0x0800FC00          /* 页 63（升级状态） */
#endif

/* slot 存储：1KB ÷ 4B = 256 槽（与源工程 flash_store.h 逐值一致） */
#ifndef OTA_STORE_SLOT_COUNT
#define OTA_STORE_SLOT_COUNT    256
#endif

#endif /* OTA_LAYOUT_F103C8_H */
