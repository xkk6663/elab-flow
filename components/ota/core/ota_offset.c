/**
 * @file    ota_offset.c
 * @brief   断电续传偏移记录管理
 *
 * 使用 FlashStore 的 slot 式磨损均衡机制，将已写入的页数
 * 存储在专用 Flash 页 (0x0800F800)，支持断电恢复。
 */

#include "ota_offset.h"
#include "ota_flash_store.h"

void OFFSET_Init(void)
{
    /* 如果页内已有有效值，先擦除整页重新开始 */
    if (FlashStore_Read(OFFSET_PAGE_ADDR, 0xFFFFFFFF) != 0xFFFFFFFF) {
        FlashStore_Erase(OFFSET_PAGE_ADDR);
    }
}

void OFFSET_Save(uint16_t page)
{
    FlashStore_Write(OFFSET_PAGE_ADDR, page);
}

uint16_t OFFSET_Get(void)
{
    uint32_t val = FlashStore_Read(OFFSET_PAGE_ADDR, 0);
    return (val <= 0xFFFF) ? (uint16_t)val : 0;
}

/* ── ★ 双槽（方案 §4.4）：记录带 bank 标记 ──────────────────────
 * 编码：b31:24 = bank（0/1），b15:0 = 页号。
 * 恢复时 bank 不匹配（上次传的是槽 B、这次目标换了）→ 视为无有效断点，
 * 宁可全量重传也不按错误基地址续传（写穿 ACTIVE 槽 = 变砖）。 */

void OFFSET_SaveAt(uint16_t page, uint8_t bank)
{
#if OTA_SLOT_COUNT > 1
    FlashStore_Write(OFFSET_PAGE_ADDR, ((uint32_t)(bank & 0xFF) << 24) | page);
#else
    (void)bank;
    OFFSET_Save(page);
#endif
}

uint16_t OFFSET_GetAt(uint8_t *bank)
{
    uint32_t val = FlashStore_Read(OFFSET_PAGE_ADDR, 0);
    if (val <= 0xFFFF) {
        if (bank) *bank = 0;        /* legacy 记录（无 bank 标记）→ 槽 0 */
        return (uint16_t)val;
    }
    if (bank) *bank = (uint8_t)((val >> 24) & 0xFF);
    return (uint16_t)(val & 0xFFFF);
}
