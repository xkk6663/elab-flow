#ifndef OTA_FLASH_STORE_H
#define OTA_FLASH_STORE_H

#include <stdint.h>
#include "ota_common.h"

/**
 * @brief  每存储页的 32 位槽位数
 *
 * ★ 平台化改造：源工程硬编码 256（1KB 页 ÷ 4B）。现由 port 布局头提供
 *   OTA_STORE_SLOT_COUNT（F103/AT32 = 256，STM32F411 = 4096，16KB 扇区）。
 *   算法（append-only + 槽满擦除）零改动。
 */
#ifndef FLASH_STORE_SLOT_COUNT
#define FLASH_STORE_SLOT_COUNT  OTA_STORE_SLOT_COUNT
#endif

/**
 * ★ 双槽（方案 §4.1）：状态扇区按半区划分 —— 下半段归 4B 状态字，
 *   上半段归 20B bank 记录（ota_bank.c）。单槽芯片（OTA_SLOT_COUNT==1）
 *   无此划分，整页都是状态字（旧行为逐值一致）。
 */
#ifndef OTA_SLOT_COUNT
#define OTA_SLOT_COUNT 1
#endif

#if OTA_SLOT_COUNT > 1
#define FLASH_STORE_STATE_END   (FLASH_STORE_SLOT_COUNT / 2)
#else
#define FLASH_STORE_STATE_END   FLASH_STORE_SLOT_COUNT
#endif

/**
 * @brief  读取页内最后一个有效值
 * @param  page_addr   页起始地址（必须按页对齐）
 * @param  default_val 整页为空时返回的默认值
 * @return 最后一个写入的非 0xFFFFFFFF 值，无值时返回 default_val
 */
uint32_t FlashStore_Read(uint32_t page_addr, uint32_t default_val);

/**
 * ★ 双槽：范围限定的读/写（状态字钳位在下半段，防溢进 bank 记录区）。
 *   begin/end 为槽索引 [begin, end)。单槽走原函数（全范围）即可。
 */
uint32_t FlashStore_ReadRange(uint32_t page_addr, uint32_t begin, uint32_t end,
                              uint32_t default_val);
void     FlashStore_WriteRange(uint32_t page_addr, uint32_t begin, uint32_t end,
                               uint32_t value);

/**
 * @brief  找空槽写入值（自动处理页满擦除）
 * @param  page_addr  页起始地址
 * @param  value      要写入的 32 位值
 */
void FlashStore_Write(uint32_t page_addr, uint32_t value);

/**
 * @brief  擦除整页（页内所有槽归零为 0xFFFFFFFF）
 * @param  page_addr  页起始地址
 */
void FlashStore_Erase(uint32_t page_addr);

#endif
