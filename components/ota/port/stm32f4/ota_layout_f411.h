#ifndef OTA_LAYOUT_F411_H
#define OTA_LAYOUT_F411_H

/**
 * @file    ota_layout_f411.h
 * @brief   STM32F411CEU6 Flash 布局（方案 §2）
 *
 *   0x08000000  Bootloader  32KB  (S0+S1: 16K×2)
 *   0x08008000  Upgrade State 16KB (S2, 4096 slot)
 *   0x0800C000  Offset Record 16KB (S3, 4096 slot)
 *   0x08010000  APP 448KB          (S4=64K + S5~S7=128K×3)
 *
 * 传输页粒度保持 1024B / 帧 128B（协议层 PAGES 字段语义不变 → 上位机零改动）。
 */

/* ── Flash Layout ───────────────────────────────────
 * ★ 单源化（方案 A/M1）：chips/*.yaml 声明了 ota_layout 节时，构建期生成的
 *   ota_layout_gen.h 会经 -include 先于本文件定义同名宏（生成的值赢）。
 *   本头文件的值退化为【缺省兜底】——保证无 inject / 老工程场景独立可用。 */
#ifndef FLASH_BASE_ADDR
#define FLASH_BASE_ADDR         0x08000000
#endif
#ifndef BOOTLOADER_SIZE
#define BOOTLOADER_SIZE         0x8000              /* 32 KB */
#endif
#ifndef APP_START_ADDRESS
#define APP_START_ADDRESS       0x08010000          /* S4 起始 */
#endif
#ifndef APP_SIZE
#define APP_SIZE                0x00070000UL        /* 448 KB（S4..S7） */
#endif

#ifndef UPGRADE_STATE_ADDR
#define UPGRADE_STATE_ADDR      0x08008000          /* S2（独立扇区，防互擦） */
#endif
#ifndef OFFSET_PAGE_ADDR
#define OFFSET_PAGE_ADDR        0x0800C000          /* S3（独立扇区） */
#endif

/* slot 存储：16KB ÷ 4B = 4096 槽（append-only 磨损均衡，擦除频率较 F1 再降 16 倍） */
#ifndef OTA_STORE_SLOT_COUNT
#define OTA_STORE_SLOT_COUNT    4096
#endif

#endif /* OTA_LAYOUT_F411_H */
