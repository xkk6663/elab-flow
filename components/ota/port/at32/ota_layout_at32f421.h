#ifndef OTA_LAYOUT_AT32F421_H
#define OTA_LAYOUT_AT32F421_H

/**
 * @file    ota_layout_at32f421.h
 * @brief   AT32F421G8U7 Flash 布局（AT32 工程语义，与 F103 布局逐值一致，1K 扇区）
 *
 *   0x08000000  Bootloader  18KB (0x4800)
 *   0x08004800  APP         44KB (0xB000)
 *   0x0800F800  Offset      1KB  (扇区 62)
 *   0x0800FC00  State       1KB  (扇区 63)
 */

/* ── Flash Layout ───────────────────────────────────
 * ★ 单源化（方案 A/M1）：chips/*.yaml 声明了 ota_layout 节时，构建期生成的
 *   ota_layout_gen.h 会经 -include 先于本文件定义同名宏（生成的值赢）。
 *   本头文件的值退化为【缺省兜底】。AT32 芯片 yaml 暂未声明 ota_layout，
 *   当前实际生效的就是下面这些值 —— 与源工程逐值一致。 */
#ifndef FLASH_BASE_ADDR
#define FLASH_BASE_ADDR         0x08000000
#endif
#ifndef BOOTLOADER_SIZE
#define BOOTLOADER_SIZE         0x4800              /* 18 KB */
#endif
#ifndef APP_START_ADDRESS
#define APP_START_ADDRESS       0x08004800
#endif
#ifndef APP_SIZE
#define APP_SIZE                0x0000B000UL        /* 44 KB */
#endif

#ifndef OFFSET_PAGE_ADDR
#define OFFSET_PAGE_ADDR        0x0800F800
#endif
#ifndef UPGRADE_STATE_ADDR
#define UPGRADE_STATE_ADDR      0x0800FC00
#endif

/* slot 存储：1KB ÷ 4B = 256 槽（与源工程逐值一致） */
#ifndef OTA_STORE_SLOT_COUNT
#define OTA_STORE_SLOT_COUNT    256
#endif

#endif /* OTA_LAYOUT_AT32F421_H */
