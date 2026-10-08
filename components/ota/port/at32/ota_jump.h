#ifndef OTA_JUMP_H
#define OTA_JUMP_H

#include <stdint.h>

/**
 * @brief  跳转到 APP 区执行（Bootloader 专用）
 *
 * 校验 APP 起始地址栈顶合法性（SRAM 范围）后：
 *   关中断 → 重置 VTOR → 取 APP 复位向量 → 设置 MSP → 跳转
 */
void OtaJump_ToApp(uint32_t app_addr);   /* ★ 双槽：目标地址运行时传入 */

#endif /* OTA_JUMP_H */
