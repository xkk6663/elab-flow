/**
 * @file    ota_flash_store.c
 * @brief   Flash slot 式读写抽象层
 *
 * 在一页 Flash (1KB = 256 × 32位槽位) 上实现追加写入 + 槽满擦除。
 * 每次写入找空槽，整页填满才擦除一次，将 Flash 擦写寿命延长约 256 倍。
 * 读取时从页末尾向前扫描，返回最后一个写入的有效值。
 *
 * @note    底层 Flash 操作通过平台无关接口 OtaFlashHal_* 完成，
 *          由 ota/port/<platform>/ota_flash_hal.c 实现，核心库零芯片依赖。
 */

#include "ota_flash_store.h"
#include "ota_flash_hal.h"

uint32_t FlashStore_Read(uint32_t page_addr, uint32_t default_val)
{
    return FlashStore_ReadRange(page_addr, 0, FLASH_STORE_SLOT_COUNT, default_val);
}

void FlashStore_Write(uint32_t page_addr, uint32_t value)
{
    FlashStore_WriteRange(page_addr, 0, FLASH_STORE_SLOT_COUNT, value);
}

uint32_t FlashStore_ReadRange(uint32_t page_addr, uint32_t begin, uint32_t end,
                              uint32_t default_val)
{
    /* 从区尾向前扫描，找最后一个非 0xFFFFFFFF 的值 */
    for (int32_t i = (int32_t)end - 1; i >= (int32_t)begin; i--) {
        uint32_t val = *(const volatile uint32_t *)(page_addr + i * 4);
        if (val != 0xFFFFFFFF) {
            return val;
        }
    }
    return default_val;
}

void FlashStore_WriteRange(uint32_t page_addr, uint32_t begin, uint32_t end,
                           uint32_t value)
{
    /* 从前往后找第一个空槽 */
    for (uint32_t i = begin; i < end; i++) {
        if (*(const volatile uint32_t *)(page_addr + i * 4) == 0xFFFFFFFF) {
            OtaFlashHal_Unlock();
            OtaFlashHal_ProgramWord(page_addr + i * 4, value);
            OtaFlashHal_Lock();
            return;
        }
    }

    /* 区间已满 → 擦除整页，从区间头写入
     * ★ 注意：擦的是整个物理扇区 —— 双槽下 bank 区（上半段）会被一起清，
     *   所以【状态字写路径不允许走到这里】（下半段满之前 Boot 的 bank 区
     *   必然先满并自带恢复逻辑）。 Bank_Set 擦扇区后自行重写两段。 */
    OtaFlashHal_Unlock();
    OtaFlashHal_ClearFlags();
    OtaFlashHal_ErasePage(page_addr);
    OtaFlashHal_ProgramWord(page_addr, value);
    OtaFlashHal_Lock();
}

void FlashStore_Erase(uint32_t page_addr)
{
    OtaFlashHal_Unlock();
    OtaFlashHal_ClearFlags();
    OtaFlashHal_ErasePage(page_addr);
    OtaFlashHal_Lock();
}
