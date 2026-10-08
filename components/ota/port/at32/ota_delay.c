/**
 * @file    ota_delay.c
 * @brief   AT32F421 SysTick 忙等延时（Bootloader 用）
 *
 * SysTick 固定 1ms 时基（AHB=120MHz / 120000）, 由 OtaDelay_Init() 配置。
 * 忙等实现, 仅在 Bootloader 无 RTOS 环境下使用。
 */

#include "ota_delay.h"
#include "at32f421.h"

static volatile uint32_t ota_systick_ms;   /* 毫秒计数器（SysTick 中断累加） */

void SysTick_Handler(void)
{
    ota_systick_ms++;
}

void OtaDelay_Init(void)
{
    crm_clocks_freq_type crm_clocks;
    uint32_t frequency = 0;

    crm_clocks_freq_get(&crm_clocks);
    frequency = crm_clocks.ahb_freq;   /* 120MHz */

    systick_clock_source_config(SYSTICK_CLOCK_SOURCE_AHBCLK_NODIV);
    SysTick->LOAD  = (uint32_t)((frequency / 1000) - 1UL);
    SysTick->VAL   = 0UL;
    /* 坑(踩坑指南 §24): 必须 |= 保留 CLKSOURCE；= 直接赋值会把 CLKSOURCE 清 0,
       SysTick 退化为 HCLK/8(15MHz) 时钟源, LOAD=119999 使中断周期 8ms,
       2s 窗口变 16s、一切 SysTick 时基慢 8 倍。APP 侧 wk_timebase_init 是 |= 正确的。 */
    SysTick->CTRL |= SysTick_CTRL_TICKINT_Msk |
                    SysTick_CTRL_ENABLE_Msk;
}

void OtaDelay_Ms(uint32_t ms)
{
    uint32_t start = ota_systick_ms;
    if (ms < 0xFFFFFFFFU) {
        ms += 1;
    }
    while ((ota_systick_ms - start) < ms) {
    }
}

void OtaDelay_Us(uint32_t us)
{
    /* SysTick 1ms 精度不够微秒, 直接用 SysTick 当前计数值递减 */
    uint32_t ticks = (SystemCoreClock / 1000000UL) * us;
    uint32_t start = SysTick->VAL;
    uint32_t elapsed = 0;

    while (elapsed < ticks) {
        uint32_t now = SysTick->VAL;
        elapsed += (start - now) & (SysTick->LOAD);   /* 处理翻转 */
        start = now;
    }
}
