#ifndef OTA_UPGRADE_STATE_H
#define OTA_UPGRADE_STATE_H

#include "ota_common.h"

/**
 * @brief  读取当前升级状态
 * @return UpgradeState 枚举值
 */
UpgradeState UPGRADE_GetState(void);

/**
 * @brief  写入升级状态（自动处理 Flash 擦写）
 * @param  state 目标状态
 */
void UPGRADE_SetState(UpgradeState state);

/**
 * @brief  检查当前是否为指定状态
 * @param  state 要检查的状态
 * @return 1=是, 0=否
 */
uint8_t UPGRADE_IsState(UpgradeState state);

#endif /* OTA_UPGRADE_STATE_H */
