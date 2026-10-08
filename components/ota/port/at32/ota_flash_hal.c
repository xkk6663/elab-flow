/**
 * @file    ota_flash_hal.c
 * @brief   AT32F421 Flash HAL 移植层
 *
 * 将 ota/core 的平台无关 Flash 接口映射到 AT32 标准库原语。
 * AT32F421x8: 64KB Flash, 扇区 1KB（与 STM32F103 页粒度一致，
 * 0x0800F800 = 扇区 62, 0x0800FC00 = 扇区 63，直接映射无需逻辑页）。
 */

#include "ota_flash_hal.h"
#include "at32f421.h"

void OtaFlashHal_Unlock(void)
{
    flash_unlock();
}

void OtaFlashHal_Lock(void)
{
    flash_lock();
}

void OtaFlashHal_ClearFlags(void)
{
    /* 对应 STM32 的 EOP|PGERR|WRPRTERR：操作完成/编程错误/擦写保护错误 */
    flash_flag_clear(FLASH_ODF_FLAG | FLASH_PRGMERR_FLAG | FLASH_EPPERR_FLAG);
}

void OtaFlashHal_ErasePage(uint32_t page_addr)
{
    /* AT32F421 扇区擦除：按地址擦一个 1KB 扇区 */
    flash_sector_erase(page_addr);
}

void OtaFlashHal_ProgramWord(uint32_t addr, uint32_t data)
{
    flash_word_program(addr, data);
}

/* ── 区间擦除（1KB 页粒度；语义见 ota_flash_hal.h）────────────────── */

void OtaFlashHal_EraseRange(uint32_t start, uint32_t end)
{
    if (end <= start) {
        return;
    }
    /* 续传语义：start 向上对齐——所在页已写前段不可破坏 */
    uint32_t first = (start % 1024u == 0u) ? start : ((start + 1023u) & ~0x3FFu);
    OtaFlashHal_Unlock();
    OtaFlashHal_ClearFlags();
    for (uint32_t addr = first; addr < end; addr += 1024u) {
        flash_sector_erase(addr);
    }
    OtaFlashHal_Lock();
}

void OtaFlashHal_EraseRangeFull(uint32_t start, uint32_t end)
{
    if (end <= start) {
        return;
    }
    /* 整片语义：start 向下对齐——所在页一并擦除（Boot_EraseAppAndReset 用） */
    OtaFlashHal_Unlock();
    OtaFlashHal_ClearFlags();
    for (uint32_t addr = start & ~0x3FFu; addr < end; addr += 1024u) {
        flash_sector_erase(addr);
    }
    OtaFlashHal_Lock();
}
