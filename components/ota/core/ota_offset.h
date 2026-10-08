#ifndef OTA_OFFSET_H
#define OTA_OFFSET_H

#include <stdint.h>
#include "ota_common.h"

/**
 * @brief  清空偏移记录（新升级开始时调用）
 */
void OFFSET_Init(void);

/**
 * @brief  记录已完成页数（每写完 1024 字节调用一次）
 * @param  page  已完成的页数（从 1 开始)
 */
void OFFSET_Save(uint16_t page);

/**
 * @brief  读取上次记录的页数
 * @return 页数，0 = 无记录
 */
uint16_t OFFSET_Get(void);

/**
 * ★ 双槽（方案 §4.4）：带 bank 标记的记录/恢复。
 *   编码 b31:24=bank；恢复时 bank 不匹配 → 返回 0（宁全量重传不写穿）。
 */
void     OFFSET_SaveAt(uint16_t page, uint8_t bank);
uint16_t OFFSET_GetAt(uint8_t *bank);

#endif /* OTA_OFFSET_H */
