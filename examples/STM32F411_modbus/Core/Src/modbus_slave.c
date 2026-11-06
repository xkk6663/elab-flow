/**
  ******************************************************************************
  * @file    modbus_slave.c
  * @brief   Modbus RTU 从站：功能码、异常码、寄存器表
  *
 * 这里只处理"一帧已经完整到手"之后的事：校验 → 执行 → 组应答。
 * 收字节与定界在 uart_dma.c（CIRC 循环 DMA + HT/TC + 静默定界），一行都不掺合。
  ******************************************************************************
  */

#include "main.h"
#include "modbus_slave.h"
#include "uart_dma.h"
#include "board.h"
#include "usart.h"
#include <string.h>

/* ── 功能码 ─────────────────────────────────────────────────────── */
#define FC_READ_COILS       0x01u
#define FC_READ_DISCRETE    0x02u
#define FC_READ_HOLDING     0x03u
#define FC_READ_INPUT       0x04u
#define FC_WRITE_COIL       0x05u
#define FC_WRITE_REGISTER   0x06u
#define FC_WRITE_COILS      0x0Fu
#define FC_WRITE_REGISTERS  0x10u

/* ── 异常码 ─────────────────────────────────────────────────────── */
#define EXC_ILLEGAL_FUNC    0x01u
#define EXC_ILLEGAL_ADDR    0x02u
#define EXC_ILLEGAL_VALUE   0x03u

/* ── 寄存器表 ───────────────────────────────────────────────────── */
static uint16_t holding[MB_HOLD_N];
static uint8_t  coils[MB_COIL_N];
static uint16_t led_cmd;              /* 0x0010 的镜像：写 1 = 点亮 */
static uint32_t runtime_ticks;        /* 0x0020/21：每 100ms +1 */
static uint32_t frames_rx;            /* 合法帧计数 */
static uint8_t  stage;                /* 0 = 未就绪，1 = 心跳/收发正常 */
static uint8_t  burst_left;           /* 连发剩余帧数（TX 双缓冲演示） */
static uint8_t  burst_seq;            /* 连发序号 */
static uint32_t last_frame_ms;        /* 最近一次收到**合法帧**的时刻（DI 0x0001 用） */
static uint32_t last_activity_ms;     /* 最近一次总线上有任何字节（心跳避让用） */
static uint8_t  bus_seen;             /* 见过帧 = 主站已上线 → USART1 停止心跳 */
static uint16_t scratch[8];           /* 0x0110–0x0117：随便读写，验收用（16 位，别截断） */

/* 模拟温度表（不引 libm：f32 点只是用来验证字序与缩放的） */
static const float temp_tab[8] = {
    25.0f, 25.5f, 26.0f, 26.5f, 27.0f, 26.5f, 26.0f, 25.5f
};

/* ══════════════════════════════════════════════════════════════════
 *  小工具
 * ══════════════════════════════════════════════════════════════════ */
static uint16_t crc16_modbus(const uint8_t *p, uint16_t n)
{
    uint16_t crc = 0xFFFFu;
    uint16_t i;
    uint8_t b;

    for (i = 0; i < n; i++) {
        crc ^= p[i];
        for (b = 0; b < 8u; b++) {
            if (crc & 1u) {
                crc = (uint16_t)((crc >> 1) ^ 0xA001u);
            } else {
                crc >>= 1;
            }
        }
    }
    return crc;
}

static uint16_t be16(const uint8_t *p)
{
    return (uint16_t)(((uint16_t)p[0] << 8) | p[1]);
}

static void put_be16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)(v & 0xFFu);
}

/** 应答尾部补 CRC（低字节在前） */
static uint16_t finish(uint8_t *buf, uint16_t len)
{
    uint16_t crc = crc16_modbus(buf, len);
    buf[len++] = (uint8_t)(crc & 0xFFu);
    buf[len++] = (uint8_t)(crc >> 8);
    return len;
}

static uint16_t build_exception(uint8_t *out, uint8_t fc, uint8_t code)
{
    out[0] = MB_UNIT_ID;
    out[1] = (uint8_t)(fc | 0x80u);
    out[2] = code;
    return finish(out, 3);
}

/** 写点白名单：不在表里的一律拒绝（02）。
 *  显式列表 > 按地址段猜 —— 读错可以重读，写错会动硬件。 */
static int writable_holding(uint16_t addr)
{
    if (addr == 0x0010u) {
        return 1;                       /* LED */
    }
    if (addr == 0x0011u) {
        return 1;                       /* 连发触发（TX 双缓冲演示） */
    }
    if (addr >= 0x0110u && addr <= 0x0117u) {
        return 1;                       /* 验收用 scratch */
    }
    return 0;
}

static int writable_coil(uint16_t addr)
{
    return addr < 4u;                   /* 线圈 0..3 */
}

/** 把"活的值"刷进寄存器表：面板每读一次，看到的都是此刻的事实 */
static void mb_refresh(void)
{
    const ud_stats_t *s = ud_stats();
    uint32_t t = board_uptime_s();
    uint32_t rt = runtime_ticks;
    float temp = temp_tab[board_tick_s() % 8u];
    union {
        float f;
        uint32_t u;
    } cv;

    holding[0x0000] = 0x0411u;                  /* 设备 ID：STM32F411 */
    holding[0x0001] = 0x0100u;                  /* 固件 v1.0 */
    holding[0x0002] = (uint16_t)(board_tick_s() & 0xFFFFu);
    holding[0x0003] = board_toggles();
    holding[0x0004] = stage;
    holding[0x0005] = (uint16_t)(frames_rx & 0xFFFFu);

    /* u32 大端字序：地址 0x20 放高 16 位，0x21 放低 16 位 */
    holding[0x0020] = (uint16_t)(rt >> 16);
    holding[0x0021] = (uint16_t)(rt & 0xFFFFu);

    /* f32 同样高字在前：面板配 word_order=big + scale=1 */
    cv.f = temp;
    holding[0x0030] = (uint16_t)(cv.u >> 16);
    holding[0x0031] = (uint16_t)(cv.u & 0xFFFFu);

    /* 0x0040/41：开机秒数（u32） */
    holding[0x0040] = (uint16_t)(t >> 16);
    holding[0x0041] = (uint16_t)(t & 0xFFFFu);

    /* 0x0100 段：DMA 双缓冲的诊断计数（教程就是靠这几个数证明双缓冲在工作） */
    holding[0x0100] = (uint16_t)(s->rx_bytes & 0xFFFFu);
    holding[0x0101] = (uint16_t)(s->rx_ht & 0xFFFFu);
    holding[0x0102] = (uint16_t)(s->rx_tc & 0xFFFFu);
    holding[0x0103] = (uint16_t)(s->rx_idle & 0xFFFFu);
    holding[0x0104] = (uint16_t)(s->rx_overrun & 0xFFFFu);
    holding[0x0105] = (uint16_t)(s->rx_drop & 0xFFFFu);
    holding[0x0106] = (uint16_t)(s->tx_bytes & 0xFFFFu);
    holding[0x0107] = (uint16_t)(s->tx_pingpong & 0xFFFFu);
    holding[0x0108] = (uint16_t)(s->tx_busy_drop & 0xFFFFu);
    holding[0x0109] = s->last_frame_len;
    holding[0x010A] = (uint16_t)(s->max_gap_ms & 0xFFFFu);

    /* 0x0010 LED 与 scratch 由写操作维护，这里只做 LED 的物理落地 */
    holding[0x0010] = led_cmd;
    holding[0x0011] = burst_left;               /* 连发剩余，面板可看着它归零 */
    {
        uint8_t i;
        for (i = 0; i < 8u; i++) {
            holding[0x0110u + i] = scratch[i];
        }
    }
}

/* ══════════════════════════════════════════════════════════════════
 *  对外
 * ══════════════════════════════════════════════════════════════════ */
void mb_slave_init(void)
{
    memset(holding, 0, sizeof(holding));
    memset(coils, 0, sizeof(coils));
    memset(scratch, 0, sizeof(scratch));
    led_cmd = 0;
    runtime_ticks = 0;
    frames_rx = 0;
    stage = 1;
    burst_left = 0;
    burst_seq = 0;
    last_frame_ms = 0;
    last_activity_ms = 0;
    bus_seen = 0;
    mb_refresh();
}

uint8_t mb_slave_stage(void)
{
    return stage;
}

uint32_t mb_slave_frames(void)
{
    return frames_rx;
}

uint8_t mb_bus_seen(void)
{
    return bus_seen;
}

uint32_t mb_last_activity_ms(void)
{
    return last_activity_ms;
}

void mb_slave_poll(void)
{
    char line[24];
    char *p = line;
    const char *tag = "[burst] n=";
    uint16_t n;

    if (burst_left == 0u) {
        return;
    }
    /* 先问空位再发：两块都满就下一圈再来 —— 这是"等"，不是"丢"。
     * 直接把等当成丢会让 tx_drop 空转上千次，面板上的丢帧数就失去意义了。 */
    if (ud_tx_room() <= 0) {
        return;
    }
    while (*tag) {
        *p++ = *tag++;
    }
    n = burst_seq + 1u;
    if (n >= 10u) {
        *p++ = (char)('0' + (n / 10u));
    }
    *p++ = (char)('0' + (n % 10u));
    *p++ = '\r';
    *p++ = '\n';

    /* ud_tx 返回 1 = 已进缓冲（可能在发、也可能在排队）；返回 0 = 两块都满，
     * 下一圈主循环再试 —— 不阻塞、不丢帧。 */
    if (ud_tx((const uint8_t *)line, (uint16_t)(p - line))) {
        burst_left--;
        burst_seq++;
    }
}

void mb_slave_handle(const uint8_t *req, uint16_t len)
{
    uint8_t out[UD_TX_MAX];
    uint16_t olen = 0;
    uint8_t fc;
    uint16_t addr, val, cnt, i;
    uint16_t crc_rx;

    if (len < 4u) {
        return;                                  /* 太短，连 CRC 都没有 */
    }
#if MB_DIAG_ECHO
    {
        char dbg[64];
        int n = 0;
        uint16_t k;
        const char *tag = "#rx len=";
        while (*tag && n < 60) {
            dbg[n++] = *tag++;
        }
        if (len >= 100u) {
            dbg[n++] = (char)('0' + (len / 100u));
        }
        if (len >= 10u) {
            dbg[n++] = (char)('0' + ((len / 10u) % 10u));
        }
        dbg[n++] = (char)('0' + (len % 10u));
        dbg[n++] = ' ';
        for (k = 0; k < len && k < 20u && n < 56; k++) {
            uint8_t hi = (uint8_t)(req[k] >> 4), lo = (uint8_t)(req[k] & 0x0Fu);
            dbg[n++] = (char)(hi < 10u ? '0' + hi : 'a' + hi - 10u);
            dbg[n++] = (char)(lo < 10u ? '0' + lo : 'a' + lo - 10u);
            dbg[n++] = ' ';
        }
        dbg[n++] = '\r';
        dbg[n++] = '\n';
        HAL_UART_Transmit(&huart1, (uint8_t *)dbg, (uint16_t)n, 50);
    }
#endif
    /* 只要总线上有帧（哪怕 CRC 坏、哪怕不是给我的），就说明主站上线了：
     * 此刻起 USART1 不许再发任何日志字节。 */
    bus_seen = 1u;
    last_activity_ms = HAL_GetTick();
    crc_rx = (uint16_t)(req[len - 2] | ((uint16_t)req[len - 1] << 8));
    if (crc16_modbus(req, (uint16_t)(len - 2)) != crc_rx) {
        return;                                  /* CRC 错：静默丢弃（规范要求） */
    }
    if (req[0] != MB_UNIT_ID && req[0] != 0u) {
        return;                                  /* 不是给我的 */
    }
    fc = req[1];
    frames_rx++;
    last_frame_ms = HAL_GetTick();

    runtime_ticks = HAL_GetTick() / 100u;
    mb_refresh();

    switch (fc) {
    case FC_READ_HOLDING:
    case FC_READ_INPUT:
        if (len != 8u) {
            olen = build_exception(out, fc, EXC_ILLEGAL_VALUE);
            break;
        }
        addr = be16(&req[2]);
        cnt = be16(&req[4]);
        if (cnt < 1u || cnt > 125u) {
            olen = build_exception(out, fc, EXC_ILLEGAL_VALUE);
            break;
        }
        if ((uint32_t)addr + cnt > MB_HOLD_N) {
            olen = build_exception(out, fc, EXC_ILLEGAL_ADDR);
            break;
        }
        out[0] = MB_UNIT_ID;
        out[1] = fc;
        out[2] = (uint8_t)(cnt * 2u);
        for (i = 0; i < cnt; i++) {
            put_be16(&out[3u + i * 2u], holding[addr + i]);
        }
        olen = finish(out, (uint16_t)(3u + cnt * 2u));
        break;

    case FC_READ_COILS:
    case FC_READ_DISCRETE:
        if (len != 8u) {
            olen = build_exception(out, fc, EXC_ILLEGAL_VALUE);
            break;
        }
        addr = be16(&req[2]);
        cnt = be16(&req[4]);
        if (cnt < 1u || cnt > 2000u) {
            olen = build_exception(out, fc, EXC_ILLEGAL_VALUE);
            break;
        }
        if ((uint32_t)addr + cnt > MB_COIL_N) {
            olen = build_exception(out, fc, EXC_ILLEGAL_ADDR);
            break;
        }
        {
            uint8_t nbytes = (uint8_t)((cnt + 7u) / 8u);
            out[0] = MB_UNIT_ID;
            out[1] = fc;
            out[2] = nbytes;
            memset(&out[3], 0, nbytes);
            for (i = 0; i < cnt; i++) {
                uint8_t bit;
                if (fc == FC_READ_COILS) {
                    bit = coils[addr + i];
                } else if (i == 0u) {
                    bit = board_led_on();          /* DI0：LED 现况 */
                } else if (i == 1u) {
                    /* DI1：最近 2 秒内总线上有过帧 */
                    bit = (HAL_GetTick() - last_frame_ms) < 2000u ? 1u : 0u;
                } else {
                    bit = 0u;
                }
                if (bit) {
                    out[3u + i / 8u] |= (uint8_t)(1u << (i % 8u));
                }
            }
            olen = finish(out, (uint16_t)(3u + nbytes));
        }
        break;

    case FC_WRITE_REGISTER:
        if (len != 8u) {
            olen = build_exception(out, fc, EXC_ILLEGAL_VALUE);
            break;
        }
        addr = be16(&req[2]);
        val = be16(&req[4]);
        if (addr >= MB_HOLD_N) {
            olen = build_exception(out, fc, EXC_ILLEGAL_ADDR);
            break;
        }
        if (!writable_holding(addr)) {
            olen = build_exception(out, fc, EXC_ILLEGAL_ADDR);
            break;
        }
        if (addr == 0x0010u) {
            led_cmd = (uint16_t)(val ? 1u : 0u);
            board_set_led(led_cmd != 0u);
        } else if (addr == 0x0011u) {
            burst_left = (uint8_t)((val > 8u) ? 8u : val);
            burst_seq = 0;
        } else if (addr >= 0x0110u && addr <= 0x0117u) {
            scratch[addr - 0x0110u] = val;
        }
        /* 正应答 = 原样回显 */
        memcpy(out, req, 6);
        olen = finish(out, 6);
        break;

    case FC_WRITE_REGISTERS:
        addr = be16(&req[2]);
        cnt = be16(&req[4]);
        if (len < 9u || cnt < 1u || cnt > 123u || req[6] != cnt * 2u
                || len != (uint16_t)(9u + cnt * 2u)) {
            olen = build_exception(out, fc, EXC_ILLEGAL_VALUE);
            break;
        }
        if ((uint32_t)addr + cnt > MB_HOLD_N) {
            olen = build_exception(out, fc, EXC_ILLEGAL_ADDR);
            break;
        }
        for (i = 0; i < cnt; i++) {
            if (!writable_holding((uint16_t)(addr + i))) {
                olen = build_exception(out, fc, EXC_ILLEGAL_ADDR);
                break;
            }
        }
        if (olen) {
            break;                          /* 有一个不可写就整批拒绝 */
        }
        for (i = 0; i < cnt; i++) {
            uint16_t a = (uint16_t)(addr + i);
            uint16_t v = be16(&req[7u + i * 2u]);
            if (a == 0x0010u) {
                led_cmd = (uint16_t)(v ? 1u : 0u);
                board_set_led(led_cmd != 0u);
            } else if (a == 0x0011u) {
                burst_left = (uint8_t)((v > 8u) ? 8u : v);
                burst_seq = 0;
            } else {
                scratch[a - 0x0110u] = v;
            }
        }
        out[0] = MB_UNIT_ID;
        out[1] = fc;
        put_be16(&out[2], addr);
        put_be16(&out[4], cnt);
        olen = finish(out, 6);
        break;

    case FC_WRITE_COIL:
        if (len != 8u) {
            olen = build_exception(out, fc, EXC_ILLEGAL_VALUE);
            break;
        }
        addr = be16(&req[2]);
        val = be16(&req[4]);
        if (addr >= MB_COIL_N) {
            olen = build_exception(out, fc, EXC_ILLEGAL_ADDR);
            break;
        }
        if (val != 0xFF00u && val != 0x0000u) {
            olen = build_exception(out, fc, EXC_ILLEGAL_VALUE);
            break;
        }
        if (!writable_coil(addr)) {
            olen = build_exception(out, fc, EXC_ILLEGAL_ADDR);
            break;
        }
        coils[addr] = (uint8_t)(val ? 1u : 0u);
        if (addr == 0u) {
            led_cmd = coils[0];
            board_set_led(led_cmd != 0u);
        }
        memcpy(out, req, 6);
        olen = finish(out, 6);
        break;

    case FC_WRITE_COILS:
        addr = be16(&req[2]);
        cnt = be16(&req[4]);
        if (len < 9u || cnt < 1u || cnt > 1968u
                || req[6] != (uint8_t)((cnt + 7u) / 8u)
                || len != (uint16_t)(9u + req[6])) {
            olen = build_exception(out, fc, EXC_ILLEGAL_VALUE);
            break;
        }
        if ((uint32_t)addr + cnt > MB_COIL_N) {
            olen = build_exception(out, fc, EXC_ILLEGAL_ADDR);
            break;
        }
        for (i = 0; i < cnt; i++) {
            uint8_t bit = (uint8_t)((req[7u + i / 8u] >> (i % 8u)) & 1u);
            coils[addr + i] = bit;
        }
        if (addr == 0u) {
            led_cmd = coils[0];
            board_set_led(led_cmd != 0u);
        }
        out[0] = MB_UNIT_ID;
        out[1] = fc;
        put_be16(&out[2], addr);
        put_be16(&out[4], cnt);
        olen = finish(out, 6);
        break;

    default:
        olen = build_exception(out, fc, EXC_ILLEGAL_FUNC);
        break;
    }

    /* 广播（unit 0）：执行但不回答 —— 回一句反而会撞上别的从站 */
    if (req[0] == 0u || olen == 0) {
        return;
    }
    (void)ud_tx(out, olen);
}
