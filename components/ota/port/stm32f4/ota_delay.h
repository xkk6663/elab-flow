#ifndef OTA_DELAY_H
#define OTA_DELAY_H

#include <stdint.h>

/**
 * @brief  毫秒级延时（基于 SysTick, 忙等）
 * @param  ms 延时毫秒数
 */
void OtaDelay_Ms(uint32_t ms);

/**
 * @brief  微秒级延时（基于 SysTick 当前值, 忙等）
 * @param  us 延时微秒数
 */
void OtaDelay_Us(uint32_t us);

/** @brief 初始化 SysTick（1ms 时基, 供延时使用） */
void OtaDelay_Init(void);

#endif /* OTA_DELAY_H */
