#ifndef OTA_BOOT_PORT_H
#define OTA_BOOT_PORT_H

/**
 * @file    ota_boot_port.h
 * @brief   boot 场景层（ota_boot_flow.c）依赖的 port 统一接口
 *
 * 各 port/<platform>/ 提供：
 *   ota_jump.c  → OtaJump_ToApp()        芯片相关跳转（MSP 原子跳转等坑已固化）
 *   ota_key.c   → OtaKey_IsPressed()     触发按键（线束由 port 宏配置）
 *   ota_delay.c → OtaDelay_Ms()/OtaDelay_Us()
 *
 * VARIANT=app 不需要本组接口（不编 ota_boot_flow.c）。
 */

#include <stdint.h>

/** 跳转到 APP（校验 SP、复意外设、原子设 MSP+跳转；SP 非法时返回不跳）。
 *  ★ 双槽（方案 §4.2）：目标地址运行时传入（单槽传 APP_START_ADDRESS）。 */
void OtaJump_ToApp(uint32_t app_addr);

/** MCU 复位（NVIC 级）。CRC_FAIL 置位后靠复位回到 CheckState 的
 *  CRC_FAIL 分支（WARNING + 等 '!' 重升，M5.3 异常注入闭环）。 */
void OtaSystemReset(void);

/** 触发按键是否按下（1=按下）；无按键 port 可恒返回 0 */
uint8_t OtaKey_IsPressed(void);

/** 毫秒级忙等（boot 无 RTOS 环境） */
void OtaDelay_Ms(uint32_t ms);

/** 微秒级粗延时（boot 无高精度要求） */
void OtaDelay_Us(uint32_t us);

#endif /* OTA_BOOT_PORT_H */
