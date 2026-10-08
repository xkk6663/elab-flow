#ifndef OTA_KEY_H
#define OTA_KEY_H

#include <stdint.h>

/**
 * @file    ota_key.h
 * @brief   触发按键（STM32F1 标准库版，提炼自 My_Key.c）
 *
 * 线束：PB11 内部上拉，低电平 = 按下（与源工程一致）。
 * 改线束：改本文件宏后重编（组件内配置，不污染工程）。
 */

/** 按键 GPIO 时钟使能宏（默认 APB2 GPIOB） */
#ifndef OTA_KEY_RCC
#define OTA_KEY_RCC             RCC_APB2Periph_GPIOB
#endif
/** 按键 GPIO 端口 */
#ifndef OTA_KEY_PORT
#define OTA_KEY_PORT            GPIOB
#endif
/** 按键引脚 */
#ifndef OTA_KEY_PIN
#define OTA_KEY_PIN             GPIO_Pin_11
#endif

void OtaKey_Init(void);
uint8_t OtaKey_IsPressed(void);

#endif /* OTA_KEY_H */
