#ifndef OTA_CONFIRM_H
#define OTA_CONFIRM_H

/**
 * @file    ota_confirm.h
 * @brief   app 侧试运行确认（双槽 A/B Bank 方案 §4.3）
 *
 * app 自检通过后调用一次：写 bank 记录 {active 不变, pending=0xFF, trial=0}
 * → boot 下次上电走普通路径（跳 active 槽 = 新固件转正）。
 *
 * ★ 单槽芯片（OTA_SLOT_COUNT == 1）：无试运行语义，本函数编译为空操作，
 *   工程侧调用点无需条件编译。
 */
#include "ota_common.h"

void OTA_Confirm(void);

#endif /* OTA_CONFIRM_H */
