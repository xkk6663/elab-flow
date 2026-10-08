/**
 * @file    ota_jump.c
 * @brief   AT32F421 跳转 APP 实现
 *
 * AT32F421 为 Cortex-M4（无 SCB->VTOR 由内核提供, 直接写 SCB->VTOR 即可）。
 * APP 侧链接脚本 AT32F421x8_APP.ld 将中断向量表放在 0x08004800,
 * 跳转前将 VTOR 切到 APP 向量表。
 */

#include "ota_jump.h"
#include "ota_common.h"
#include "at32f421.h"

typedef void (*pFunction)(void);

void OtaJump_ToApp(uint32_t app_addr)   /* ★ 双槽：跳转目标运行时化（方案 §4.2） */
{
    /* 检查 APP 起始地址的栈顶指针是否合法（SRAM 0x20000000 范围） */
    uint32_t app_sp = *(volatile uint32_t *)app_addr;
    if ((app_sp & 0x2FFE0000) == 0x20000000) {
        __disable_irq();                    /* 关全局中断 */

        /* 复位外设（尽量干净的运行环境给 APP） */
        crm_reset();

        /* 切 VTOR 到 APP 向量表 */
        SCB->VTOR = app_addr;

        /* 取 APP 复位向量 */
        uint32_t jump_addr = *(volatile uint32_t *)(app_addr + 4);

        /* 坑(踩坑指南 §25): 必须用内联汇编"设MSP+bx"原子完成,
           不能先 __set_MSP() 再 C 函数调用 jump_to_app() ——
           C 编译器在函数返回前会生成 ldmia sp!,{r4-r6,lr} 恢复寄存器,
           此时 SP 已是 APP 栈顶(0x20004000 = SRAM末尾+1, 超出16KB范围),
           从非法地址读触发 BusFault→HardFault, PC=0, APP 永远起不来。
           内联汇编在 msr msp 后直接 bx, 中间无栈操作。 */
        __asm volatile(
            "msr msp, %0\n"
            "bx %1\n"
            : : "r"(app_sp), "r"(jump_addr)
        );
        /* 不会到达这里 */
    }
}

/* ------------------------------------------------------------------
 * OtaSystemReset —— NVIC 级复位（M5.3 CRC_FAIL 置位后回 CheckState 分支）
 * AT32F421：CMSIS 核心函数（at32f421.h 已含）。
 * ------------------------------------------------------------------ */
void OtaSystemReset(void)
{
    NVIC_SystemReset();
    while (1) { /* 不可达，防编译器警告 */ }
}
