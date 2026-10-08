/**
 * @file    ota_key.c
 * @brief   AT32 触发按键桩（源工程 v1.1 纯软件 '!!!!!' 触发，无按键）
 *
 * AT32 工程不存在物理触发按键 → OtaKey_IsPressed() 恒返回 0，
 * ota_boot_flow.c 的 KEY 检测路径自然退化为纯串口触发 —— 与源工程行为一致。
 * 未来 AT32 板卡加键时，仿 port/stm32f4/ota_key.c 实现即可。
 */

#include "ota_boot_port.h"

uint8_t OtaKey_IsPressed(void)
{
    return 0;   /* 无按键板卡：纯软件 '!!!!!' 触发（源工程 v1.1 语义） */
}
