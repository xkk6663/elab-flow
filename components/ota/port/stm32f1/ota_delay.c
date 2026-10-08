/**
 * @file    ota_delay.c
 * @brief   STM32F1 (标准库) 延时 —— 提炼自 STM32-OTA-QT System/Delay.c
 *
 * SysTick 忙等实现，与源工程 Delay_us/Delay_ms 逐行同构（72MHz HCLK）。
 * ★ 源工程 SysTick CLKSOURCE 覆盖坑（AT32 §24）：本文件用完即关
 *   （CTRL=0x00000004），不残留配置。
 */

#include "ota_delay.h"
#include "stm32f10x.h"

void OtaDelay_Init(void)
{
    /* 每次延时自管 SysTick，无需初始化动作（与源工程一致） */
}

void OtaDelay_Us(uint32_t us)
{
    SysTick->LOAD = 72 * us;                /* 设置定时器重装值 */
    SysTick->VAL  = 0x00;                   /* 清空当前计数值 */
    SysTick->CTRL = 0x00000005;             /* 时钟源 HCLK，启动 */
    while (!(SysTick->CTRL & 0x00010000));  /* 等待计数到 0 */
    SysTick->CTRL = 0x00000004;             /* 关闭定时器 */
}

void OtaDelay_Ms(uint32_t ms)
{
    while (ms--) {
        OtaDelay_Us(1000);
    }
}
