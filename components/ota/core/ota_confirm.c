/**
 * @file    ota_confirm.c
 * @brief   app 侧试运行确认（OTA_双槽回滚技术方案 §4.3，实现见头文件注释）
 *
 * 幂等：pending==0xFF（无试运行/已确认）时直接返回，不写 flash。
 * 判据同源：F411 工程在心跳第 3 次 [alive] 打印后调用（与 monitor 闭环判据一致）。
 */

#include <stdio.h>
#include "ota_confirm.h"
#include "ota_bank.h"
#include "ota_upgrade_state.h"

void OTA_Confirm(void)
{
#if OTA_SLOT_COUNT > 1
    OtaBankRecord rec;
    Bank_Get(&rec);
    if (rec.pending == OTA_BANK_PENDING_NONE) {
        return;                     /* 无试运行：幂等空操作 */
    }
    /* active 不变（完成时已翻转到新槽），清试运行标记 → 新固件转正 */
    rec.pending = OTA_BANK_PENDING_NONE;
    rec.trial = 0;
    Bank_Set(&rec, STATE_RUNNING);
    printf("[ota] CONFIRMED: bank%u promoted\r\n", rec.active);
#else
    /* 单槽：无试运行语义，空操作（零回归） */
#endif
}
