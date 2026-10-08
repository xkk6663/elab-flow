#include "ota_protocol.h"
#include "ota_crc32.h"
#include "ota_transport.h"

/* ============================================================
 * 帧构建（编码）
 * ============================================================ */

/**
 * @brief  编码无参数应答帧
 * @param  buf: 输出缓冲区（至少 9 字节）
 * @param  cmd: RSP_ACK 或 RSP_NAK
 * @return 帧总长
 *
 * 帧格式: AA 02 CMD 00 CRC32(4B) 55
 *                 ^^ PARAM_LEN = 0
 */
uint8_t Protocol_EncodeAck(uint8_t *buf, uint8_t cmd)
{
    uint8_t idx = 0;

    buf[idx++] = FRAME_SOF;         /* AA */
    buf[idx++] = FRAME_TYPE_CMD;    /* 02 */
    buf[idx++] = cmd;               /* CMD */
    buf[idx++] = 0;                 /* PARAM_LEN = 0 */

    /* CRC = CRC32(TYPE + CMD + PARAM_LEN) */
    uint32_t crc = Software_CRC32(buf + 1, 3);
    buf[idx++] = (uint8_t)(crc >> 0);
    buf[idx++] = (uint8_t)(crc >> 8);
    buf[idx++] = (uint8_t)(crc >> 16);
    buf[idx++] = (uint8_t)(crc >> 24);
    buf[idx++] = FRAME_EOF;         /* 55 */

    return idx;  /* 9 bytes */
}

/**
 * @brief  编码带参数的应答帧
 * @param  buf: 输出缓冲区（至少 9 + param_len 字节）
 * @param  cmd: 应答命令字
 * @param  param: 参数数据
 * @param  param_len: 参数长度
 * @return 帧总长
 *
 * 帧格式: AA 02 CMD LEN [PARAM...] CRC32(4B) 55
 *                    ^^^ PARAM_LEN
 */
uint8_t Protocol_EncodeAckWithParam(uint8_t *buf, uint8_t cmd,
                                    const uint8_t *param, uint8_t param_len)
{
    uint8_t idx = 0;

    buf[idx++] = FRAME_SOF;         /* AA */
    buf[idx++] = FRAME_TYPE_CMD;    /* 02 */
    buf[idx++] = cmd;               /* CMD */
    buf[idx++] = param_len;         /* PARAM_LEN */

    for (uint8_t i = 0; i < param_len; i++) {
        buf[idx++] = param[i];      /* PARAM... */
    }

    /* CRC = CRC32(TYPE + CMD + PARAM_LEN + PARAM) */
    uint32_t crc = Software_CRC32(buf + 1, 3 + param_len);
    buf[idx++] = (uint8_t)(crc >> 0);
    buf[idx++] = (uint8_t)(crc >> 8);
    buf[idx++] = (uint8_t)(crc >> 16);
    buf[idx++] = (uint8_t)(crc >> 24);
    buf[idx++] = FRAME_EOF;         /* 55 */

    return idx;  /* 9 + param_len */
}

/* ============================================================
 * 帧解析（解码 — 状态机）
 *
 * 注意：状态机只解析 数据帧 和 命令帧（Host→Bootloader），
 * 这两种帧均不含 PARAM_LEN 字段。
 * ============================================================ */

void Protocol_Parser_Init(FrameParser *p)
{
    p->state      = PARSER_IDLE;
    p->type       = 0;
    p->cmd        = 0;
    p->seq        = 0;
    p->len        = 0;
    p->data_idx   = 0;
    p->crc_bytes  = 0;
    p->crc        = 0;
    p->crc_calc   = CRC32_Start();
}

/**
 * @brief  向解析器喂一个字节
 * @param  p: 解析器状态
 * @param  byte: 收到的字节
 * @return 帧类型（0=未完成/无效，FRAME_TYPE_DATA=数据帧完成，FRAME_TYPE_CMD=命令帧完成）
 */
uint8_t Protocol_Parser_Feed(FrameParser *p, uint8_t byte)
{
    switch (p->state) {

    case PARSER_IDLE:
        if (byte == FRAME_SOF) {
            p->state = PARSER_TYPE;
            p->crc_calc = CRC32_Start();       /* 开始累积 CRC */
        }
        break;

    case PARSER_TYPE:
        if (byte == FRAME_TYPE_DATA) {
            p->type = FRAME_TYPE_DATA;
            p->crc_calc = CRC32_Update(p->crc_calc, &byte, 1);
            p->state = PARSER_SEQ;   /* 先收 SEQ 序号 */
        } else if (byte == FRAME_TYPE_CMD) {
            p->type = FRAME_TYPE_CMD;
            p->crc_calc = CRC32_Update(p->crc_calc, &byte, 1);
            p->state = PARSER_CMD;
        } else {
            p->state = PARSER_IDLE;             /* 非法类型，重新同步 */
        }
        break;

    case PARSER_SEQ:                            /* 数据帧序号 */
        p->seq = byte;
        p->crc_calc = CRC32_Update(p->crc_calc, &byte, 1);
        p->state = PARSER_LEN;
        break;

    case PARSER_LEN:                            /* 数据帧：收 LEN */
        p->len = byte;
        p->data_idx = 0;
        p->crc_calc = CRC32_Update(p->crc_calc, &byte, 1);
        if (p->len == 0) {
            /* LEN=0 → 零长度帧（升级结束标记），直接收 CRC */
            p->state = PARSER_CRC;
            p->crc_bytes = 0;
            p->crc = 0;
        } else if (p->len > FRAME_MAX_DATA_LEN) {
            p->state = PARSER_IDLE;             /* 非法长度 */
        } else {
            p->state = PARSER_DATA;
        }
        break;

    case PARSER_DATA:                           /* 数据帧：收 DATA */
        p->data[p->data_idx++] = byte;
        if (p->data_idx >= p->len) {
            p->crc_calc = CRC32_Update(p->crc_calc, p->data, p->len);
            p->state = PARSER_CRC;
            p->crc_bytes = 0;
            p->crc = 0;
        }
        break;

    case PARSER_CMD:                            /* 命令帧：收 CMD */
        p->cmd = byte;
        p->crc_calc = CRC32_Update(p->crc_calc, &byte, 1);
        p->state = PARSER_CRC;
        p->crc_bytes = 0;
        p->crc = 0;
        break;

    case PARSER_CRC:                            /* 收 CRC32 (4字节，小端) */
        ((uint8_t *)&p->crc)[p->crc_bytes++] = byte;
        if (p->crc_bytes >= 4) {
            p->state = PARSER_EOF;
        }
        break;

    case PARSER_EOF:                            /* 收 EOF */
        if (byte == FRAME_EOF) {
            uint32_t final_crc = CRC32_Finish(p->crc_calc);
            if (final_crc == p->crc) {
                return p->type;                 /* 返回帧类型，由调用方读完字段后复位 */
            }
        }
        /* CRC 校验失败 → 返回错误码，调用方读取 seq 后重传 */
        return FRAME_CRC_ERROR;
    }

    return 0;   /* 帧还未完成或无效 */
}

/* ============================================================
 * 应答发送（编码 + 串口输出）
 * ============================================================ */

void Protocol_SendAck(const Transport *t, uint8_t cmd,
                      const uint8_t *param, uint8_t param_len)
{
    uint8_t buf[32];
    uint8_t len;

    if (param && param_len > 0)
        len = Protocol_EncodeAckWithParam(buf, cmd, param, param_len);
    else
        len = Protocol_EncodeAck(buf, cmd);

    for (uint8_t i = 0; i < len; i++) {
        t->write(buf[i]);
    }
}

/* ============================================================
 * ★ 扩展命令注册表（v1.2 —— 平台化新增）
 *    仅在场景层显式调 OtaProtocol_DispatchExt() 时参与分发，
 *    既有命令路径不经过此表 → 回归基准行为零变化。
 * ============================================================ */

#ifndef OTA_EXT_CMD_MAX
#define OTA_EXT_CMD_MAX  4
#endif

typedef struct {
    uint8_t           cmd;
    OtaExtCmdHandler  handler;
} OtaExtCmdEntry;

static OtaExtCmdEntry s_ExtCmdTable[OTA_EXT_CMD_MAX];
static uint8_t s_ExtCmdCount = 0;

uint8_t OtaProtocol_RegisterExtCmd(uint8_t cmd, OtaExtCmdHandler handler)
{
    uint8_t i;
    if (handler == 0) {
        return 0;
    }
    for (i = 0; i < s_ExtCmdCount; i++) {
        if (s_ExtCmdTable[i].cmd == cmd) {
            s_ExtCmdTable[i].handler = handler;   /* 覆盖式重注册 */
            return 1;
        }
    }
    if (s_ExtCmdCount >= OTA_EXT_CMD_MAX) {
        return 0;
    }
    s_ExtCmdTable[s_ExtCmdCount].cmd = cmd;
    s_ExtCmdTable[s_ExtCmdCount].handler = handler;
    s_ExtCmdCount++;
    return 1;
}

uint8_t OtaProtocol_DispatchExt(const Transport *t, const FrameParser *p)
{
    uint8_t i;
    for (i = 0; i < s_ExtCmdCount; i++) {
        if (s_ExtCmdTable[i].cmd == p->cmd) {
            s_ExtCmdTable[i].handler(t, p);
            return 1;
        }
    }
    return 0;
}
