/**
 * @file    ota_key.c
 * @brief   触发按键（STM32F1 标准库版，提炼自 My_Key.c，行为逐行对应）
 */

#include "ota_key.h"
#include "ota_delay.h"
#include "stm32f10x.h"

void OtaKey_Init(void)
{
    GPIO_InitTypeDef GPIO_InitStruct;

    RCC_APB2PeriphClockCmd(OTA_KEY_RCC, ENABLE);

    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;      /* 内部上拉 */
    GPIO_InitStruct.GPIO_Pin = OTA_KEY_PIN;
    GPIO_Init(OTA_KEY_PORT, &GPIO_InitStruct);
}

uint8_t OtaKey_IsPressed(void)
{
    /* 读取引脚电平，低电平表示按下；20ms 双读消抖（与源工程一致） */
    if (GPIO_ReadInputDataBit(OTA_KEY_PORT, OTA_KEY_PIN) == Bit_RESET) {
        OtaDelay_Ms(20);
        if (GPIO_ReadInputDataBit(OTA_KEY_PORT, OTA_KEY_PIN) == Bit_RESET) {
            return 1;
        }
    }
    return 0;
}
