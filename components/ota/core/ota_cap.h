#ifndef OTA_CAP_H
#define OTA_CAP_H

#include <stdint.h>

/**
 * @file    ota_cap.h
 * @brief   OTA 组件能力发现模块（v1.2 新增，可选编入）
 *
 * 经 OtaProtocol_RegisterExtCmd() 注册 CMD_QUERY_COMPONENTS(0x15) 处理器，
 * 应答 RSP_COMPONENTS(0x24) = 4B 组件位图（LE）。
 * 不编入本模块（或不调 OtaCap_Init）时 0x15 走既有 NAK 路径 —— 旧固件行为零变化。
 *
 * 组件能力位（单一数据源：elab-flow/components/components.cmake 注册表）：
 *   bit0 = ota，bit1 = serial
 */

/* ── 协议扩展命令（v1.2）───────────────────────────────────────── */
#define CMD_QUERY_COMPONENTS    0x15    /* Host → Boot/APP：查询组件位图 */
#define RSP_COMPONENTS          0x24    /* Boot/APP → Host：4B 位图 (LE) */

/* ── 能力位（与 components.cmake / host capabilities.json 一致）── */
#define OTA_CAP_BIT_OTA         (1u << 0)
#define OTA_CAP_BIT_SERIAL      (1u << 1)

/**
 * @brief  注册组件发现应答
 * @param  bitmap 本固件组件位图（未定义 OTA_CAP_BITMAP 时由调用方显式传入）
 * @return 1=注册成功，0=注册失败（表满）
 * @note   编译期宏 OTA_CAP_BITMAP 存在时，OtaCap_AutoInit() 使用之。
 */
uint8_t OtaCap_Init(uint32_t bitmap);

/** 便捷入口：使用编译期 OTA_CAP_BITMAP（CMake 下传）注册；返回同 OtaCap_Init */
uint8_t OtaCap_AutoInit(void);

#endif /* OTA_CAP_H */
