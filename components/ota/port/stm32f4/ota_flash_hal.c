/**
 * @file    ota_flash_hal.c
 * @brief   STM32F4 (HAL) Flash 移植层 —— elab components/ota port/stm32f4
 *
 * 实现 ota_flash_hal.h 六接口。F411 单 bank 非均匀扇区：
 *   S0~S3=16KB, S4=64KB, S5~S7=128KB（扇区表驱动，见 ota_f411_sectors[]）。
 *
 * 关键语义（方案 §3.3）：
 *   - ErasePage(addr)        擦 addr 所在扇区（供 FlashStore 磨损均衡整擦）
 *   - EraseRange(start,end)  start 向上对齐到擦除单元边界后逐扇区擦
 *                            （断点续传时 done_bytes 所在扇区不动）
 *   - 编程粒度 32bit（PSIZE=WORD，VDD≥2.7V ✓ 3.3V）
 */

#include "ota_flash_hal.h"
#include "stm32f4xx_hal.h"

/* F411 扇区表：{起始地址, 大小}，共 8 个扇区覆盖 512KB */
typedef struct { uint32_t base; uint32_t size; } OtaSector;
static const OtaSector ota_f411_sectors[] = {
    { 0x08000000UL, 16 * 1024 },    /* S0 */
    { 0x08004000UL, 16 * 1024 },    /* S1 */
    { 0x08008000UL, 16 * 1024 },    /* S2 */
    { 0x0800C000UL, 16 * 1024 },    /* S3 */
    { 0x08010000UL, 64 * 1024 },    /* S4 */
    { 0x08020000UL, 128 * 1024 },   /* S5 */
    { 0x08040000UL, 128 * 1024 },   /* S6 */
    { 0x08060000UL, 128 * 1024 },   /* S7 */
};
#define OTA_SECTOR_NUM  (sizeof(ota_f411_sectors) / sizeof(ota_f411_sectors[0]))

static uint8_t ota_sector_of(uint32_t addr)
{
    for (int8_t i = (int8_t)OTA_SECTOR_NUM - 1; i >= 0; i--) {
        if (addr >= ota_f411_sectors[i].base) {
            return (uint8_t)i;
        }
    }
    return 0;
}

/** start 向上对齐到所在/下一擦除单元边界（断点续传防擦已写扇区的关键） */
static uint32_t ota_align_erase_up(uint32_t addr)
{
    uint8_t idx = ota_sector_of(addr);
    const OtaSector *s = &ota_f411_sectors[idx];
    uint32_t end = s->base + s->size;
    return (addr < end) ? end : (addr + s->size);
}

void OtaFlashHal_Unlock(void)
{
    HAL_FLASH_Unlock();
}

void OtaFlashHal_Lock(void)
{
    HAL_FLASH_Lock();
}

void OtaFlashHal_ClearFlags(void)
{
    /* F4 HAL 在每次操作前自清错误标志（__HAL_FLASH_CLEAR_FLAG 由驱动内部处理）；
       显式清一次历史错误，防 WRPERR/OPERR 残留导致后续操作被拒 */
    __HAL_FLASH_CLEAR_FLAG(FLASH_FLAG_EOP | FLASH_FLAG_OPERR | FLASH_FLAG_WRPERR |
                           FLASH_FLAG_PGAERR | FLASH_FLAG_PGPERR | FLASH_FLAG_PGSERR);
}

void OtaFlashHal_ErasePage(uint32_t page_addr)
{
    /* 擦 addr 所在扇区（FlashStore 磨损均衡的整擦路径） */
    FLASH_EraseInitTypeDef ei;
    uint32_t err = 0;
    uint8_t idx = ota_sector_of(page_addr);

    HAL_FLASH_Unlock();
    OtaFlashHal_ClearFlags();
    ei.TypeErase    = FLASH_TYPEERASE_SECTORS;
    ei.Sector       = idx;
    ei.NbSectors    = 1;
    ei.VoltageRange = FLASH_VOLTAGE_RANGE_3;    /* 2.7~3.6V → 允许字编程 */
    (void)HAL_FLASHEx_Erase(&ei, &err);
    HAL_FLASH_Lock();
}

void OtaFlashHal_ProgramWord(uint32_t addr, uint32_t data)
{
    HAL_FLASH_Unlock();
    (void)HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD, addr, (uint64_t)data);
    HAL_FLASH_Lock();
}

void OtaFlashHal_EraseRange(uint32_t start, uint32_t end)
{
    if (end <= start) {
        return;
    }
    /* start 向上对齐：所在扇区已写前段不可破坏（续传语义） */
    uint32_t erase_from = ota_align_erase_up(start);
    if (erase_from >= end) {
        return;     /* start 所在扇区即为最后一个单元且已越过 end —— 无需擦 */
    }

    uint8_t first = ota_sector_of(erase_from);
    uint8_t last  = ota_sector_of(end - 1);     /* end 落在扇区中部时该扇区也算 */

    FLASH_EraseInitTypeDef ei;
    uint32_t err = 0;

    HAL_FLASH_Unlock();
    OtaFlashHal_ClearFlags();
    ei.TypeErase    = FLASH_TYPEERASE_SECTORS;
    ei.Sector       = first;
    ei.NbSectors    = (uint32_t)(last - first + 1);
    ei.VoltageRange = FLASH_VOLTAGE_RANGE_3;
    (void)HAL_FLASHEx_Erase(&ei, &err);
    HAL_FLASH_Lock();
}

void OtaFlashHal_EraseRangeFull(uint32_t start, uint32_t end)
{
    if (end <= start) {
        return;
    }
    /* ★ 整片语义：start 向下对齐——start 所在扇区一并擦除。
       （2026-10-08 实弹教训：Boot_EraseAppAndReset 若走向上对齐，目标槽
       第一个扇区（S4，含 Reset 向量）永不擦除 → 0xFFFFFFFF 劫持编程成
       按位与空操作 → 坏固件"复活"。详见 ota_flash_hal.h 注释。） */
    uint8_t first = ota_sector_of(start);
    uint8_t last  = ota_sector_of(end - 1);

    FLASH_EraseInitTypeDef ei;
    uint32_t err = 0;

    HAL_FLASH_Unlock();
    OtaFlashHal_ClearFlags();
    ei.TypeErase    = FLASH_TYPEERASE_SECTORS;
    ei.Sector       = first;
    ei.NbSectors    = (uint32_t)(last - first + 1);
    ei.VoltageRange = FLASH_VOLTAGE_RANGE_3;
    (void)HAL_FLASHEx_Erase(&ei, &err);
    HAL_FLASH_Lock();
}

void OtaFlashHal_WritePacket(uint32_t addr, const uint32_t *data, uint32_t words)
{
    HAL_FLASH_Unlock();
    for (uint32_t i = 0; i < words; i++) {
        (void)HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD,
                                addr + i * 4, (uint64_t)data[i]);
    }
    HAL_FLASH_Lock();
}
