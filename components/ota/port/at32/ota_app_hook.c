/**
 * @file    ota_app_hook.c
 * @brief   APP 侧 OTA 触发挂钩（去业务化通用骨架，AT32 变体）
 *
 * ★ 去业务化（elab components/ota，方案 §3.5 准入规则 #1/#2）：
 *   源工程（AT32F421G8U7_WorkBench）本文件带 BLDC 产品头文件引用 +
 *   Sguan.Func_Stop() + tmr_output_enable(TMR1,...)
 *   —— BLDC 停机链/关 PWM 是产品业务，不进组件。改由工程经
 *   OtaHook_SetOnUpgradeReady() 注册停机回调（业务工程在回调内做
 *   Func_Stop + 关 TMR1 输出）；不注册 = 该环节为空。
 *
 * 时序（与源工程逐段对应，0 功能阉割）：
 *   ota_trigger_flag == 1
 *     → [可选] 业务停机回调（注册则调）
 *     → UPGRADE_SetState(STATE_UPGRADE_READY)   // 写状态页（slot 磨损均衡）
 *     → 延时 ~2s                                 // 与 F103 行为一致
 *     → NVIC_SystemReset()                       // boot 读 READY → 擦 APP → 收固件
 *
 * 触发扫描：
 *   USART1 IDLE 中断逐字节调用 OtaAppHook_ScanChar()，连续 '!' ≥5 置标志。
 *   '!' 不在电机遥测协议字符集内（AO=xx? 等），与遥测解析互不干扰。
 *
 * 组件发现应答（v1.2 可选）：与 stm32f4 变体同构（内嵌轻量帧解析，
 * 收到 CMD_QUERY_COMPONENTS(0x15) 时经注册 write_fn 回 RSP_COMPONENTS）。
 */

#include "ota_app_hook.h"
#include "ota_common.h"
#include "ota_upgrade_state.h"
#include "ota_protocol.h"
#include "ota_cap.h"          /* CMD_QUERY_COMPONENTS / RSP_COMPONENTS */
#include "ota_delay.h"
#include "at32f421.h"           /* NVIC_SystemReset（芯片 SDK，port 层允许） */

/* 触发阈值: 连续 '!' 个数（源工程 v1.1: 5 连触发） */
#define OTA_TRIGGER_THRESHOLD   5

/* ── 触发扫描态（中断内, volatile）──────────────────────────── */
static volatile uint8_t  s_bang_count    = 0;
static volatile uint8_t  s_trigger_flag  = 0;

/* ── 业务停机回调（准入规则 #2：产品差异注入点）──────────────── */
static OtaHookBusinessStopFn s_on_upgrade_ready = 0;

/* ── 组件发现应答态（v1.2 可选）─────────────────────────────── */
static OtaHookWriteFn s_write_fn      = 0;
static uint8_t        s_discovery_en  = 0;
static uint32_t       s_cap_bitmap    = 0;
static FrameParser    s_hook_parser;

/* ============================================================
 * 触发扫描（中断内轻量调用）
 * ============================================================ */

void OtaAppHook_ScanChar(char c)
{
    if (c == '!') {
        s_bang_count++;
        if (s_bang_count >= OTA_TRIGGER_THRESHOLD) {
            s_trigger_flag = 1;
            /* 保持置位; 计数封顶避免溢出 */
            s_bang_count = OTA_TRIGGER_THRESHOLD;
        }
    } else {
        /* 非 '!' 字符打断连续序列（遥测协议帧数据不会误触发） */
        s_bang_count = 0;
    }

    /* ── v1.2 组件发现：同一字节流内嵌轻量帧解析（未使能零开销）── */
    if (s_discovery_en && s_write_fn) {
        uint8_t result = Protocol_Parser_Feed(&s_hook_parser, (uint8_t)c);

        if (result == FRAME_TYPE_CMD &&
            s_hook_parser.cmd == CMD_QUERY_COMPONENTS) {
            uint8_t  param[4] = {
                (uint8_t)((s_cap_bitmap >> 0)  & 0xFF),
                (uint8_t)((s_cap_bitmap >> 8)  & 0xFF),
                (uint8_t)((s_cap_bitmap >> 16) & 0xFF),
                (uint8_t)((s_cap_bitmap >> 24) & 0xFF),
            };
            uint8_t buf[RSP_FRAME_PARAM_SIZE(4)];
            uint8_t len = Protocol_EncodeAckWithParam(buf, RSP_COMPONENTS,
                                                      param, 4);
            uint8_t i;
            for (i = 0; i < len; i++) {
                s_write_fn(buf[i]);
            }
        }

        if (result == FRAME_TYPE_DATA || result == FRAME_TYPE_CMD ||
            result == FRAME_CRC_ERROR) {
            Protocol_Parser_Init(&s_hook_parser);
        }
    }
}

/* ============================================================
 * 查询接口（可观测）
 * ============================================================ */

uint8_t OtaAppHook_IsTriggered(void)
{
    return (uint8_t)s_trigger_flag;
}

uint8_t OtaAppHook_BangCount(void)
{
    return (uint8_t)s_bang_count;
}

/* ============================================================
 * 主循环消费触发标志（重量动作不在中断里做）
 * ============================================================ */

void OtaAppHook_HandleTrigger(void)
{
    if (!s_trigger_flag) {
        return;
    }

    /* 1. 业务停机回调（BLDC 工程在回调内做 Func_Stop + 关 TMR1 输出） */
    if (s_on_upgrade_ready) {
        s_on_upgrade_ready();
    }

    /* 2. 写升级状态页 READY（Bootloader 上电据此擦 APP 区进升级） */
    UPGRADE_SetState(STATE_UPGRADE_READY);

    /* 3. 延时 ~2s（与 F103 行为一致；port 的 OtaDelay_Ms 提供） */
    OtaDelay_Ms(2000);

    /* 4. 复位: Bootloader 接管（读到 READY → 擦 APP → 等待固件） */
    NVIC_SystemReset();
}

/* ============================================================
 * 挂钩点注册（准入规则 #2）
 * ============================================================ */

void OtaHook_SetOnUpgradeReady(OtaHookBusinessStopFn fn)
{
    s_on_upgrade_ready = fn;
}

void OtaHook_SetRespondFn(OtaHookWriteFn write_fn)
{
    s_write_fn = write_fn;
}

uint8_t OtaHook_EnableDiscovery(uint32_t cap_bitmap)
{
    s_cap_bitmap = cap_bitmap;
    s_discovery_en = 1;
    Protocol_Parser_Init(&s_hook_parser);
    return 1;
}
