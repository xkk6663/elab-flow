/**
 * @file    ota_cap.c
 * @brief   OTA 组件能力发现（v1.2 新增，可选编入）
 *
 * 零芯片依赖：只经 ota_protocol 的扩展命令注册表与 Transport 发送应答。
 * 既有命令路径（0x12/0x13/0x14）不经过本文件 —— 回归基准行为零变化。
 */

#include "ota_cap.h"
#include "ota_protocol.h"

static uint32_t s_cap_bitmap = 0;

static void OtaCap_HandleQueryComponents(const Transport *t, const FrameParser *p)
{
    (void)p;    /* 查询命令无参数 */
    uint8_t param[4] = {
        (uint8_t)((s_cap_bitmap >> 0) & 0xFF),
        (uint8_t)((s_cap_bitmap >> 8) & 0xFF),
        (uint8_t)((s_cap_bitmap >> 16) & 0xFF),
        (uint8_t)((s_cap_bitmap >> 24) & 0xFF),
    };
    Protocol_SendAck(t, RSP_COMPONENTS, param, 4);
}

uint8_t OtaCap_Init(uint32_t bitmap)
{
    s_cap_bitmap = bitmap;
    return OtaProtocol_RegisterExtCmd(CMD_QUERY_COMPONENTS, OtaCap_HandleQueryComponents);
}

uint8_t OtaCap_AutoInit(void)
{
#ifdef OTA_CAP_BITMAP
    return OtaCap_Init(OTA_CAP_BITMAP);
#else
    return OtaCap_Init(0);
#endif
}
