/**
 * @file    ota_flash_hal_stm32.c
 * @brief   STM32F10x Flash HAL 移植层（M0 回归用）
 *
 * 将 ota/core 的平台无关 Flash 接口映射到 STM32 标准外设库原语，
 * 行为与原始 flash_store.c 完全一致（回归基准）。
 * 仅用于 STM32-OTA-QT 老工程 USE_SHARED_OTA_CORE 回归验证。
 */

#include "ota_flash_hal.h"
#include "stm32f10x.h"

void OtaFlashHal_Unlock(void)
{
    FLASH_Unlock();
}

void OtaFlashHal_Lock(void)
{
    FLASH_Lock();
}

void OtaFlashHal_ClearFlags(void)
{
    FLASH_ClearFlag(FLASH_FLAG_EOP | FLASH_FLAG_PGERR | FLASH_FLAG_WRPRTERR);
}

void OtaFlashHal_ErasePage(uint32_t page_addr)
{
    FLASH_ErasePage(page_addr);
}

void OtaFlashHal_ProgramWord(uint32_t addr, uint32_t data)
{
    FLASH_ProgramWord(addr, data);
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
        FLASH_ErasePage(addr);
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
        FLASH_ErasePage(addr);
    }
    OtaFlashHal_Lock();
}
