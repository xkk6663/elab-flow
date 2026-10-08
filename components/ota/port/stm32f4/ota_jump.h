#ifndef OTA_JUMP_H
#define OTA_JUMP_H

#include <stdint.h>

/**
 * @brief  跳转到 APP 区执行（Bootloader 专用，STM32F4 HAL 版）
 *
 * 校验 APP 起始地址栈顶合法性（SRAM 范围）后：
 *   关中断 → HAL_RCC_DeInit + HAL_DeInit → 停 SysTick → 重设 VTOR
 *   → 内联汇编原子「设 MSP + bx」（§25 坑：C 函数路径会被编译器插
 *   ldmia sp! 弹栈，MSP 半程切换必 BusFault）
 */
void OtaJump_ToApp(uint32_t app_addr);   /* ★ 双槽：目标地址运行时传入 */

#endif /* OTA_JUMP_H */
