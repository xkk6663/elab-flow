/**
 * @file    ota_app_hook.c
 * @brief   APP 侧 OTA 触发挂钩（去业务化通用骨架，STM32F4 变体）
 *
 * 从 AT32 源工程 ota_app_hook.c 去业务化移植（方案 §3.5 准入规则 #1/#2）：
 *   - 移除 SguanESC.h / Sguan.Func_Stop() / tmr_output_enable(TMR1,...)：
 *     BLDC 停机链是产品业务，改由工程经 OtaHook_SetOnUpgradeReady() 注册；
 *     F411 工程不注册 = 该环节自然为空（触发→READY→延时→复位照常）。
 *   - 延时改用 port 的 OtaDelay_Ms()（HAL_GetTick 时基，F4 变体已实现）。
 *
 * 时序（与源工程逐段对应，0 功能阉割）：
 *   ota_trigger_flag == 1
 *     → [可选] 业务停机回调（注册则调）
 *     → UPGRADE_SetState(STATE_UPGRADE_READY)   // 写状态页（slot 磨损均衡）
 *     → 延时 ~2s                                 // 排空串口/让操作者感知
 *     → NVIC_SystemReset()                       // boot 读 READY → 擦 APP → 收固件
 *
 * 触发扫描：
 *   USART1 中断逐字节调用 OtaAppHook_ScanChar()，连续 '!' ≥5 置标志。
 *
 * 组件发现应答（v1.2 可选，同字节流内嵌轻量帧解析）：
 *   OtaHook_EnableDiscovery() 后，ScanChar 同步喂内嵌 FrameParser；
 *   完整命令帧且 CMD==0x15 时，用注册的 write_fn 逐字节回
 *   RSP_COMPONENTS(0x24)=4B 位图（Protocol_EncodeAckWithParam 编码，含 CRC32）。
 *   未使能时零开销（一次分支），与 AT32 源工程行为完全一致。
 */

#include "ota_app_hook.h"
#include "ota_common.h"
#include "ota_upgrade_state.h"
#include "ota_protocol.h"
#include "ota_cap.h"          /* CMD_QUERY_COMPONENTS / RSP_COMPONENTS */
#include "ota_delay.h"
#include "stm32f4xx.h"          /* NVIC_SystemReset（芯片 SDK，port 层允许） */

/* 触发阈值: 连续 '!' 个数（源工程 v1.1: 5 连触发） */
#define OTA_TRIGGER_THRESHOLD   5

/* ── 触发扫描态（中断内, volatile）──────────────────────────── */
static volatile uint8_t  s_bang_count    = 0;
static volatile uint8_t  s_trigger_flag  = 0;

/* ── 业务停机回调（准入规则 #2：产品差异注入点）──────────────── */
static OtaHookBusinessStopFn s_on_upgrade_ready = 0;

/* ── 组件发现应答态（v1.2 可选）─────────────────────────────── */
static OtaHookWriteFn s_write_fn      = 0;   /* 应答字节发送函数（如 HAL_UART_Transmit 轮询包装） */
static uint8_t        s_discovery_en  = 0;   /* 1=ScanChar 同步喂内嵌解析器 */
static uint32_t       s_cap_bitmap    = 0;   /* 本固件组件位图（EnableDiscovery 时存入） */
static FrameParser    s_hook_parser;         /* 仅命令帧用；数据帧静默忽略 */

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
        /* 非 '!' 字符打断连续序列 */
        s_bang_count = 0;
    }

    /* ── v1.2 组件发现：同一字节流内嵌轻量帧解析（未使能零开销）── */
    if (s_discovery_en && s_write_fn) {
        uint8_t result = Protocol_Parser_Feed(&s_hook_parser, (uint8_t)c);

        if (result == FRAME_TYPE_CMD &&
            s_hook_parser.cmd == CMD_QUERY_COMPONENTS) {
            /* RSP_COMPONENTS(0x24) = 4B 组件位图（LE），与 ota_cap.c 同构 */
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
#if defined(OTA_VER_MAJOR)
        else if (result == FRAME_TYPE_CMD &&
                 s_hook_parser.cmd == CMD_QUERY_VERSION) {
            /* ★ RSP_VERSION(0x25) = 7B {maj,min,patch,build LE32}（§9.2）。
               仅当工程声明 version（gen 头注入 OTA_VER_*）时编译本应答；
               未声明 → 不应答（host 超时回落），协议面零变化。 */
#if defined(OTA_VER_BUILD)
            uint32_t build_no = OTA_VER_BUILD;
#else
            uint32_t build_no = 0;
#endif
            uint8_t  param[7];
            uint8_t buf[RSP_FRAME_PARAM_SIZE(7)];
            uint8_t len, i;
            param[0] = OTA_VER_MAJOR;
            param[1] = OTA_VER_MINOR;
            param[2] = OTA_VER_PATCH;
            param[3] = (uint8_t)(build_no & 0xFF);
            param[4] = (uint8_t)((build_no >> 8) & 0xFF);
            param[5] = (uint8_t)((build_no >> 16) & 0xFF);
            param[6] = (uint8_t)((build_no >> 24) & 0xFF);
            len = Protocol_EncodeAckWithParam(buf, RSP_VERSION, param, 7);
            for (i = 0; i < len; i++) {
                s_write_fn(buf[i]);
            }
        }
#endif /* OTA_VER_MAJOR */

        if (result == FRAME_TYPE_DATA || result == FRAME_TYPE_CMD ||
            result == FRAME_CRC_ERROR) {
            /* 帧终结（完成/坏帧）→ 复位解析器，下一帧 SOF 从 IDLE 开始 */
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

    /* 1. 业务停机回调（产品差异注入点；未注册 = 无动作） */
    if (s_on_upgrade_ready) {
        s_on_upgrade_ready();
    }

    /* 2. 写升级状态页 READY（Bootloader 上电据此擦 APP 区进升级） */
    UPGRADE_SetState(STATE_UPGRADE_READY);

    /* 3. 延时 ~2s（与源工程行为一致：排空串口/让操作者感知） */
    OtaDelay_Ms(2000);

    /* 4. 复位: Bootloader 接管（读到 READY → 擦 APP → 等待固件） */
    NVIC_SystemReset();

    /* 复位后 s_trigger_flag 随 RAM 回 0（此处不可达） */
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
