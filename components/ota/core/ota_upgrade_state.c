#include "ota_upgrade_state.h"
#include "ota_flash_store.h"

UpgradeState UPGRADE_GetState(void)
{
    /* ★ 双槽：状态字钳位在状态扇区下半段（上半段归 bank 记录，ota_bank.c） */
    return (UpgradeState)FlashStore_ReadRange(UPGRADE_STATE_ADDR, 0,
                                               FLASH_STORE_STATE_END, STATE_RUNNING);
}

void UPGRADE_SetState(UpgradeState state)
{
    FlashStore_WriteRange(UPGRADE_STATE_ADDR, 0, FLASH_STORE_STATE_END,
                          (uint32_t)state);
}

uint8_t UPGRADE_IsState(UpgradeState state)
{
    return (UPGRADE_GetState() == state) ? 1 : 0;
}
