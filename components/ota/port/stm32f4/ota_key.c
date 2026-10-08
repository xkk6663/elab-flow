/**
 * @file    ota_key.c
 * @brief   STM32F4 触发按键（boot 侧）—— PC13，低电平有效（板上按键接地）
 *
 * 线束在宏里可调（OTA_KEY_GPIO_CLK / OTA_KEY_PORT / OTA_KEY_PIN）。
 * 轮询读 + 两次采样一致判定（软件消抖，无中断依赖）。
 */

#include "ota_key.h"
#include "stm32f4xx_hal.h"

#ifndef OTA_KEY_GPIO_CLK
#define OTA_KEY_GPIO_CLK  __HAL_RCC_GPIOC_CLK_ENABLE()
#endif
#ifndef OTA_KEY_PORT
#define OTA_KEY_PORT      GPIOC
#endif
#ifndef OTA_KEY_PIN
#define OTA_KEY_PIN       GPIO_PIN_13
#endif

static uint8_t s_key_inited = 0;

static void ota_key_init_once(void)
{
    if (!s_key_inited) {
        GPIO_InitTypeDef g = {0};
        OTA_KEY_GPIO_CLK;
        g.Pin  = OTA_KEY_PIN;
        g.Mode = GPIO_MODE_INPUT;
        g.Pull = GPIO_PULLUP;
        HAL_GPIO_Init(OTA_KEY_PORT, &g);
        s_key_inited = 1;
    }
}

uint8_t OtaKey_IsPressed(void)
{
    ota_key_init_once();
    /* 低电平有效 + 二次采样消抖 */
    if (HAL_GPIO_ReadPin(OTA_KEY_PORT, OTA_KEY_PIN) == GPIO_PIN_RESET) {
        for (volatile uint32_t i = 0; i < 2000; i++) { __NOP(); }
        return (HAL_GPIO_ReadPin(OTA_KEY_PORT, OTA_KEY_PIN) == GPIO_PIN_RESET) ? 1u : 0u;
    }
    return 0;
}
