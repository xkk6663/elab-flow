#ifndef OTA_APP_HOOK_H
#define OTA_APP_HOOK_H

#include <stdint.h>

/**
 * @file    ota_app_hook.h
 * @brief   APP 侧 OTA 触发挂钩（去业务化通用骨架，方案 §3.5 准入规则 #2）
 *
 * 时序：'!'×5 置触发标志 → 主循环 HandleTrigger：
 *   业务停机回调（注册则调，未注册为空）→ UPGRADE_SetState(READY)
 *   → 延时 ~2s（排空串口）→ NVIC_SystemReset() → boot 读 READY 擦 APP 收固件。
 *
 * ★ 产品业务（BLDC 停机链等）不进组件：工程经 OtaHook_SetOnUpgradeReady()
 *   注册自己的停机回调；F411 工程不注册 = 该环节自然为空。
 *
 * 组件发现（v1.2 可选）：工程经 OtaHook_SetRespondFn() 注册应答发送函数
 * （如 HAL_UART_Transmit 轮询包装）后，hook 内嵌帧解析器会应答
 * CMD_QUERY_COMPONENTS(0x15)；未注册则不解析应答 —— 能力宣告为可选增强。
 */

/* ── 触发扫描（中断内轻量调用）────────────────────────────────── */
void OtaAppHook_ScanChar(char c);

/* ── 主循环消费触发标志（重量动作不在中断里做）────────────────── */
void OtaAppHook_HandleTrigger(void);

/* ── 查询接口（可观测）────────────────────────────────────────── */
uint8_t OtaAppHook_IsTriggered(void);
uint8_t OtaAppHook_BangCount(void);

/* ── 业务挂钩点（产品差异注入，准入规则 #2）───────────────────── */
typedef void (*OtaHookBusinessStopFn)(void);
/** 注册触发后的业务停机回调（缓停等）；未注册 = 无动作 */
void OtaHook_SetOnUpgradeReady(OtaHookBusinessStopFn fn);

/* ── 组件发现应答（可选；write_fn 收到应答帧的每个字节调用一次）── */
typedef void (*OtaHookWriteFn)(uint8_t byte);
void OtaHook_SetRespondFn(OtaHookWriteFn write_fn);
/** 使能 0x15 应答（内部 OtaCap_Init(OTA_CAP_BITMAP)，app 变体默认位图） */
uint8_t OtaHook_EnableDiscovery(uint32_t cap_bitmap);

#endif /* OTA_APP_HOOK_H */
