/**
 * @file    ota_jump.c
 * @brief   STM32F4 跳转 APP 实现（elab port/stm32f4）
 *
 * ★ 继承 AT32 ota_jump.c 踩坑 §25：必须用内联汇编"设 MSP + bx"原子完成。
 *   不能先 __set_MSP() 再 C 函数调用 jump_to_app() —— 编译器在函数返回前
 *   会生成 ldmia sp!,{r4-r6,lr} 恢复寄存器，此时 SP 已是 APP 栈顶
 *   （超出 boot 的 RAM 语义），从非法地址读触发 BusFault，APP 永远起不来。
 *
 * 与 AT32 版差异：外设复位用 HAL（HAL_RCC_DeInit + HAL_DeInit），
 * 并显式停 SysTick（防止跳转后 APP 未重配 SysTick 前旧中断触发）。
 */

#include "ota_jump.h"
#include "ota_common.h"
#include "ota_boot_port.h"
#include "stm32f4xx_hal.h"

typedef void (*pFunction)(void);

void OtaJump_ToApp(uint32_t app_addr)   /* ★ 双槽：跳转目标运行时化（方案 §4.2） */
{
    /* 检查 APP 起始地址的栈顶指针是否合法（SRAM 范围）
     * ★ F4 掩码修正（f411 实测坑）：源工程 F103 用 0x2FFE0000（20K RAM 遗产），
     *   会把 128K SRAM 的栈顶上边界 0x20020000（_estack）误判为非法 →
     *   永不跳转静默返回（boot 心跳正常但 tick 持续走）。改用 256K 粒度
     *   掩码，覆盖 F4 全系 SRAM 上边界。 */
    uint32_t app_sp = *(volatile uint32_t *)app_addr;
    if ((app_sp & 0xFFFC0000UL) == 0x20000000UL) {
        __disable_irq();                    /* 关全局中断 */

        /* 复位外设（尽量干净的运行环境给 APP）+ 停 SysTick */
        HAL_RCC_DeInit();
        (void)HAL_DeInit();
        SysTick->CTRL = 0;
        SysTick->VAL  = 0;

        /* 切 VTOR 到 APP 向量表（APP 侧 main 亦会自设，双保险） */
        SCB->VTOR = app_addr;

        /* 取 APP 复位向量 */
        uint32_t jump_addr = *(volatile uint32_t *)(app_addr + 4);

        /* ★ MSP 原子跳转（msr msp 后直接 bx，中间无栈操作） */
        __asm volatile(
            "msr msp, %0\n"
            "bx %1\n"
            : : "r"(app_sp), "r"(jump_addr)
        );
        /* 不会到达这里 */
    }
    /* SP 非法 → 返回（源工程语义：boot 进入 RX 循环等待升级） */
}

/* ------------------------------------------------------------------
 * OtaSystemReset —— NVIC 级复位（M5.3 CRC_FAIL 置位后回 CheckState 分支）
 * STM32F4：CMSIS 核心函数，HAL 已就绪（本文件已 include stm32f4xx_hal.h）。
 * ------------------------------------------------------------------ */
void OtaSystemReset(void)
{
    NVIC_SystemReset();
    while (1) { /* 不可达，防编译器警告 */ }
}
