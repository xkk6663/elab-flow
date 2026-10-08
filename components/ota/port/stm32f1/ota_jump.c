/**
 * @file    ota_jump.c
 * @brief   STM32F1 跳转 APP 实现 —— 提炼自 STM32-OTA-QT jump_to_app_demo
 *
 * F103 无 AT32 §25 坑的强约束（源工程 __set_MSP + C 调用实测可用），
 * 但为统一防御姿态，同样用内联汇编原子完成 MSP 切换 + 跳转，
 * 行为与源工程逐段对应（RCC_DeInit → VTOR → MSP → 跳转）。
 */

#include "ota_jump.h"
#include "ota_common.h"
#include "stm32f10x.h"

typedef void (*pFunction)(void);

void OtaJump_ToApp(uint32_t app_addr)   /* ★ 双槽：跳转目标运行时化（方案 §4.2） */
{
    /* 检查栈顶地址是否合法（是否在 SRAM 范围内）—— 与源工程同判据 */
    uint32_t app_sp = *(__IO uint32_t *)app_addr;
    if ((app_sp & 0x2FFE0000UL) == 0x20000000UL) {

        __disable_irq();                    /* 关全局中断 */
        RCC_DeInit();                       /* 关闭外设时钟 */

        /* 重设向量表到 APP（源工程 APP 侧 system_stm32f10x 亦会设置，双保险） */
        SCB->VTOR = app_addr;

        uint32_t jump_addr = *(__IO uint32_t *)(app_addr + 4);

        /* 原子：设 MSP + 跳转（不接受编译器在中间插栈操作） */
        __asm volatile (
            "msr msp, %0\n"
            "bx   %1\n"
            : : "r" (app_sp), "r" (jump_addr) : );

        (void)0;    /* 不可达 */
    }
    /* 非法栈顶：返回由调用方处理（源工程打印 ERROR 后停机） */
}
