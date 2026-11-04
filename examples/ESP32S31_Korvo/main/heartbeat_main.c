/*
 * examples/ESP32S31_Korvo/main/main.c —— 芯片闭环第一关（heartbeat bring-up）
 *
 * 判据（docs/design/设计约束.md C36）：
 *   1) 串口 1Hz `[alive] tick=N toggles=M stage=boot`，相邻间隔 ≈1.000s，
 *      每次心跳 toggles 严格 +2（agent 用串口抓包判定）。
 *   2) 板载 WS2812 RGB（GPIO37）每 500ms 翻转一次（亮灭周期 1s），
 *      必须由**用户肉眼确认**。
 *
 * 约束：主循环不阻塞、不 HAL_Delay；心跳与 LED 同一时基（esp_timer 500ms）。
 */
#include <stdio.h>
#include <stdbool.h>
#include <stdint.h>

#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "esp_err.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define LED_GPIO_NUM    37          /* ESP32-S31-Korvo-1 板载 WS2812 数据脚 */
#define RMT_RESOLUTION_HZ 10000000  /* 10MHz → 1 tick = 0.1us */
#define WS2812_T0H    3             /* 0.3us */
#define WS2812_T0L    9             /* 0.9us */
#define WS2812_T1H    9             /* 0.9us */
#define WS2812_T1L    3             /* 0.3us */
#define WS2812_RESET  250           /* 25us + 25us = 50us 低电平（锁存） */

static rmt_channel_handle_t s_chan;
static rmt_encoder_handle_t s_encoder;
static uint8_t s_pixel[3] = {0x00, 0x00, 0x00};   /* WS2812 字节序：G, R, B */
static uint32_t s_tick;
static uint32_t s_toggles;

static size_t ws2812_encode(const void *data, size_t data_size,
                            size_t symbols_written, size_t symbols_free,
                            rmt_symbol_word_t *symbols, bool *done, void *arg)
{
    const uint8_t *bytes = (const uint8_t *)data;
    size_t emitted = 0;

    while (emitted < symbols_free && (symbols_written / 8) < data_size) {
        size_t bit = (symbols_written + emitted) % 8;
        bool one = bytes[(symbols_written + emitted) / 8] & (0x80 >> bit);
        symbols[emitted].level0 = 1;
        symbols[emitted].duration0 = one ? WS2812_T1H : WS2812_T0H;
        symbols[emitted].level1 = 0;
        symbols[emitted].duration1 = one ? WS2812_T1L : WS2812_T0L;
        emitted++;
    }

    if ((symbols_written + emitted) / 8 >= data_size && emitted < symbols_free) {
        symbols[emitted].level0 = 0;
        symbols[emitted].duration0 = WS2812_RESET;
        symbols[emitted].level1 = 0;
        symbols[emitted].duration1 = WS2812_RESET;
        emitted++;
        *done = true;
    }
    return emitted;
}

static void led_push(void)
{
    rmt_transmit_config_t tx_cfg = {.loop_count = 0};
    /* 失败（上一次仍在发送）不致命：下一拍重试即可。 */
    (void)rmt_transmit(s_chan, s_encoder, s_pixel, sizeof(s_pixel), &tx_cfg);
}

static void heartbeat_tick(void *arg)
{
    (void)arg;
    s_toggles++;
    /* 1Hz 心跳 + 500ms LED 翻转：同一时基，toggles 每次心跳 +2。 */
    s_pixel[0] = (s_toggles & 1) ? 0x20 : 0x00;     /* 绿色亮 / 灭 */
    led_push();

    /* 500ms 一帧二进制数据（M5 帧协议 / M7 波形演示）：
       AA 55 | seq u8 | status u8 | tick u16 | adc0 u16 | adc1 u8 | vbat u8 | sum8
       校验和覆盖前 10 字节（含帧头）——与 projects/esp32s31_korvo.frames.json 一致。 */
    {
        uint8_t f[11];
        uint8_t sum = 0;
        f[0] = 0xAA; f[1] = 0x55;
        f[2] = (uint8_t)(s_toggles & 0xFF);
        f[3] = (s_toggles & 1) ? 1 : 0;                  /* 0=IDLE 1=RUN */
        f[4] = (uint8_t)(s_tick & 0xFF);
        f[5] = (uint8_t)((s_tick >> 8) & 0xFF);
        f[6] = (uint8_t)((2048 + ((int32_t)(s_toggles % 200) - 100) * 18) & 0xFF);
        f[7] = (uint8_t)((2048 + ((int32_t)(s_toggles % 200) - 100) * 18) >> 8);
        f[8] = (uint8_t)(((s_toggles * 7) % 100) + 20);  /* adc1 0..119 */
        f[9] = (uint8_t)(190 + (s_toggles % 10));        /* vbat ≈ 3.8V */
        for (int i = 0; i < 10; i++) {
            sum = (uint8_t)(sum + f[i]);
        }
        f[10] = sum;
        fwrite(f, 1, sizeof(f), stdout);
        fputc('\n', stdout);
    }

    if ((s_toggles & 1) == 0) {
        s_tick++;
        printf("[alive] tick=%lu toggles=%lu stage=boot\n",
               (unsigned long)s_tick, (unsigned long)s_toggles);
        fflush(stdout);
    }
}

void app_main(void)
{
    printf("[boot] esp32s31_korvo heartbeat stage=boot\n");
    fflush(stdout);

    rmt_tx_channel_config_t tx_cfg = {
        .gpio_num = LED_GPIO_NUM,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = RMT_RESOLUTION_HZ,
        .mem_block_symbols = 64,
        .trans_queue_depth = 4,
    };
    ESP_ERROR_CHECK(rmt_new_tx_channel(&tx_cfg, &s_chan));

    rmt_simple_encoder_config_t enc_cfg = {
        .callback = ws2812_encode,
        .arg = NULL,
        .min_chunk_size = 8,
    };
    ESP_ERROR_CHECK(rmt_new_simple_encoder(&enc_cfg, &s_encoder));
    ESP_ERROR_CHECK(rmt_enable(s_chan));

    led_push();     /* 先熄灭，避免上电瞬间残留颜色 */

    esp_timer_handle_t timer;
    esp_timer_create_args_t timer_args = {
        .callback = heartbeat_tick,
        .arg = NULL,
        .name = "heartbeat",
    };
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer, 500000));   /* 500ms */
}
