/**
 * @file    ota_delay.c
 * @brief   STM32F4 (HAL) 延时 —— boot 无 RTOS 环境
 *
 * 毫秒时基直接用 HAL_GetTick()（HAL_Init 已配 SysTick 1ms 中断）。
 * ★ 源工程 SysTick CLKSOURCE 覆盖坑（AT32 §24）在 HAL 路径天然规避：
 *   SysTick 完全由 HAL_Init 管理，本文件不再触碰 SysTick->CTRL。
 */

#include "ota_delay.h"
#include "stm32f4xx_hal.h"

void OtaDelay_Init(void)
{
    /* HAL_Init() 已完成 SysTick 1ms 配置，无需动作 */
}

void OtaDelay_Ms(uint32_t ms)
{
    uint32_t start = HAL_GetTick();
    while ((HAL_GetTick() - start) < ms) {
        __NOP();
    }
}

void OtaDelay_Us(uint32_t us)
{
    /* boot 无微秒精度要求：按 96MHz~100MHz 主频粗估 NOP 循环 */
    volatile uint32_t n = us * (SystemCoreClock / 8000000UL);
    while (n--) {
        __NOP();
    }
}
