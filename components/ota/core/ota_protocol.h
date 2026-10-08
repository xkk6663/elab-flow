#ifndef OTA_PROTOCOL_H
#define OTA_PROTOCOL_H

#include <stdint.h>
#include "ota_transport.h"

/* ============================================================
 * 简单帧协议 — 数据/命令统一帧格式
 *
 * 帧头: 0xAA
 * 帧尾: 0x55
 *
 * ── 数据帧（Host → Bootloader） ──
 * | 0xAA | TYPE_DATA(0x01) | SEQ(1B) | LEN(1B) | DATA[0~128] | CRC32(4B) | 0x55 |
 *   CRC32 = CRC32(TYPE + SEQ + LEN + DATA, 1+1+1+LEN)
 *   SEQ：帧序号（0~255），每帧递增，用于重传确认
 *   LEN=0 用作升级结束标记（零长度数据帧，SEQ=0）
 *   解析器按 LEN 读取，不会与 0x55 冲突 ✓
 *
 * ── 命令帧（Host → Bootloader，无参数） ──
 * | 0xAA | TYPE_CMD(0x02) | CMD(1B) | CRC32(4B) | 0x55 |
 *   CRC32 = CRC32(TYPE + CMD, 1+1)
 *   解析器严格按 4 字节收 CRC，不会与 0x55 冲突 ✓
 *
 * ── 应答帧（Bootloader → Host） ──
 * | 0xAA | TYPE_CMD(0x02) | CMD | 0x03 | STATUS(1B) | SEQ(1B) | PAGES(1B) | CRC32(4B) | 0x55 |
 *   CRC32 = CRC32(TYPE + CMD + 0x03 + STATUS + SEQ + PAGES, 1+1+1+3)
 *   STATUS：0=CRC_OK，1=CRC_ERR（触发重传）
 *   SEQ：对应数据帧的序号
 *   PAGES：已写入的 1024 字节页数（用于续传）
 * ============================================================ */

/* ------------------------------------------------------------------
 * 帧常量
 * ------------------------------------------------------------------ */
#define FRAME_SOF           0xAA
#define FRAME_EOF           0x55

#define FRAME_TYPE_DATA     0x01        /* 数据帧 */
#define FRAME_TYPE_CMD      0x02        /* 命令帧 / 应答帧 */
#define FRAME_CRC_ERROR     0xFF        /* 帧 CRC 校验失败（由 Protocol_Parser_Feed 返回） */

/* 数据帧最大载荷 */
#define FRAME_MAX_DATA_LEN  128

/* ------------------------------------------------------------------
 * 命令定义
 * ------------------------------------------------------------------ */
/* Host → Bootloader */
#define CMD_QUERY_OFFSET    0x12        /* 查询续传偏移 */
#define CMD_RESET_UPGRADE   0x13        /* 重置升级：清空偏移，从头开始接收 */
#define CMD_QUERY_STATE     0x14        /* 查询当前升级状态 */
#define CMD_QUERY_VERSION   0x17        /* ★ 双槽方案 §9.2：查询固件版本 */

/* Bootloader → Host */
#define RSP_ACK             0x20        /* 操作成功 */
#define RSP_NAK             0x21        /* 操作失败 */
#define RSP_OFFSET          0x22        /* 续传偏移（参数=2字节，页数） */
#define RSP_STATE           0x23        /* 升级状态（参数=4字节，uint32 LE） */
#define RSP_COMPONENTS      0x24        /* v1.2 组件发现（参数=4B 位图，ota_cap） */
#define RSP_VERSION         0x25        /* ★ 版本应答（参数=7B：maj/min/patch + build LE32） */

/* ------------------------------------------------------------------
 * 协议相关工具宏
 * ------------------------------------------------------------------ */

//* 数据帧总长 = 1(SOF) + 1(TYPE) + 1(SEQ) + 1(LEN) + LEN + 4(CRC32) + 1(EOF) */
#define DATA_FRAME_SIZE(len)    ((len) + 9)

/* 应答帧总长 = 1(SOF) + 1(TYPE) + 1(CMD) + 1(LEN) + 4(CRC32) + 1(EOF) */
#define RSP_FRAME_SIZE          9

/* 带参数应答帧总长 = 1(SOF) + 1(TYPE) + 1(CMD) + 1(LEN) + PARAM_LEN + 4(CRC32) + 1(EOF) */
#define RSP_FRAME_PARAM_SIZE(param_len) ((param_len) + 9)

/* 命令帧总长（Host→Bootloader，无 PARAM_LEN 字段） = 1(SOF) + 1(TYPE) + 1(CMD) + 4(CRC32) + 1(EOF) */
#define CMD_FRAME_SIZE          8

/* ------------------------------------------------------------------
 * 帧解析器状态机
 * ------------------------------------------------------------------ */

enum {
    PARSER_IDLE,
    PARSER_TYPE,
    PARSER_SEQ,      /* 数据帧序号 */
    PARSER_LEN,
    PARSER_DATA,
    PARSER_CMD,
    PARSER_CRC,
    PARSER_EOF,
};

typedef struct {
    uint8_t  state;                         /* 当前状态 */
    uint8_t  type;                          /* FRAME_TYPE_DATA / FRAME_TYPE_CMD */
    uint8_t  cmd;                           /* 命令字节（命令帧） */
    uint8_t  seq;                           /* 数据帧序号 */
    uint8_t  len;                           /* 数据长度（数据帧） */
    uint8_t  data[FRAME_MAX_DATA_LEN];      /* 数据载荷（数据帧） */
    uint8_t  data_idx;                      /* 已收数据字节数 */
    uint8_t  crc_bytes;                     /* 已收 CRC 字节数 */
    uint32_t crc;                           /* 收到的 CRC32 值 */
    uint32_t crc_calc;                      /* 累积计算 CRC */
} FrameParser;

/* ------------------------------------------------------------------
 * 函数声明
 * ------------------------------------------------------------------ */

/* ACK/NAK 应答帧编码（含 PARAM_LEN 字段） */
uint8_t Protocol_EncodeAck(uint8_t *buf, uint8_t cmd);
uint8_t Protocol_EncodeAckWithParam(uint8_t *buf, uint8_t cmd,
                                    const uint8_t *param, uint8_t param_len);

/* 编码 + 发送应答帧（传入传输层接口） */
void Protocol_SendAck(const Transport *t, uint8_t cmd,
                      const uint8_t *param, uint8_t param_len);

/* 帧解析（解码） */
void    Protocol_Parser_Init(FrameParser *p);
uint8_t Protocol_Parser_Feed(FrameParser *p, uint8_t byte);

/* ------------------------------------------------------------------
 * ★ 扩展命令注册（v1.2 组件发现，改造 #4 —— 平台化新增，既有命令路径不变）
 *
 * 内置命令（0x12/0x13/0x14）的分发仍在场景层（ota_boot_flow.c），
 * 未命中内置表后调 OtaProtocol_DispatchExt() 查本注册表；
 * 组件发现等新命令由 ota_cap.c 注册（CMD_QUERY_COMPONENTS 0x15）。
 * 未注册任何处理器时 DispatchExt 返回 0，调用方按源工程语义回 NAK ——
 * 行为与回归基准完全一致。
 * ------------------------------------------------------------------ */
typedef void (*OtaExtCmdHandler)(const Transport *t, const FrameParser *p);

/** 注册扩展命令处理器（同 cmd 重复注册以最后一次为准；返回 0=表满） */
uint8_t OtaProtocol_RegisterExtCmd(uint8_t cmd, OtaExtCmdHandler handler);

/** 查注册表并分发；返回 1=已处理，0=无此命令的注册 */
uint8_t OtaProtocol_DispatchExt(const Transport *t, const FrameParser *p);

#endif /* OTA_PROTOCOL_H */
