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
#include <string.h>

#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "esp_err.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "nvs_flash.h"

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
/* 心跳计数被 esp_timer 回调和 TCP 任务同时读：volatile 足够（单写多读）。 */
static volatile uint32_t s_tick;
static volatile uint32_t s_toggles;

#define NET_GOT_IP_BIT BIT0
static EventGroupHandle_t s_net_eg;

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

/* 500ms 一帧二进制数据（M5 帧协议 / M7 波形演示）：
   AA 55 | seq u8 | status u8 | tick u16 | adc0 u16 | adc1 u8 | vbat u8 | sum8
   校验和覆盖前 10 字节（含帧头）——与 projects/esp32s31_korvo.frames.json 一致。
   串口与 TCP 共用同一份组帧，保证两条链路上的帧字节完全相同。 */
static void build_frame(uint8_t f[11])
{
    uint8_t sum = 0;
    int32_t adc0 = 2048 + ((int32_t)(s_toggles % 200) - 100) * 18;

    f[0] = 0xAA; f[1] = 0x55;
    f[2] = (uint8_t)(s_toggles & 0xFF);
    f[3] = (s_toggles & 1) ? 1 : 0;                  /* 0=IDLE 1=RUN */
    f[4] = (uint8_t)(s_tick & 0xFF);
    f[5] = (uint8_t)((s_tick >> 8) & 0xFF);
    f[6] = (uint8_t)(adc0 & 0xFF);
    f[7] = (uint8_t)((adc0 >> 8) & 0xFF);
    f[8] = (uint8_t)(((s_toggles * 7) % 100) + 20);  /* adc1 0..119 */
    f[9] = (uint8_t)(190 + (s_toggles % 10));        /* vbat ≈ 3.8V */
    for (int i = 0; i < 10; i++) {
        sum = (uint8_t)(sum + f[i]);
    }
    f[10] = sum;
}

/* ── 联网遥测服务（M4 演示）：WiFi STA + 单客户端 TCP 服务 ──────────
 * 板子自己当数据源：串口打印什么，TCP 客户端就能收到什么（文本心跳 + 二进制帧）。
 * 只用于闭环验证，不做多客户端/鉴权；凭据在本地 sdkconfig，不入库。 */
static int net_send_all(int fd, const void *buf, size_t len)
{
    const uint8_t *p = (const uint8_t *)buf;
    while (len > 0) {
        ssize_t n = send(fd, p, len, 0);
        if (n <= 0) {
            return -1;      /* 对端关闭/出错：交给外层 accept 循环收尾 */
        }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

static void tcp_server_task(void *arg)
{
    (void)arg;
    int port = CONFIG_KORVO_TCP_PORT;
    int srv = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in sa;

    if (srv < 0) {
        printf("[net] socket() failed\n");
        vTaskDelete(NULL);
        return;
    }
    int on = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
    memset(&sa, 0, sizeof(sa));
    sa.sin_family = AF_INET;
    sa.sin_addr.s_addr = htonl(INADDR_ANY);
    sa.sin_port = htons((uint16_t)port);
    if (bind(srv, (struct sockaddr *)&sa, sizeof(sa)) != 0 || listen(srv, 1) != 0) {
        printf("[net] bind/listen failed port=%d\n", port);
        close(srv);
        vTaskDelete(NULL);
        return;
    }
    printf("[net] tcp server listening port=%d\n", port);
    fflush(stdout);

    while (1) {
        int fd = accept(srv, NULL, NULL);
        if (fd < 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        printf("[net] client connected\n");
        fflush(stdout);

        char hello[96];
        snprintf(hello, sizeof(hello), "[net] esp32s31_korvo telemetry ready\n");
        net_send_all(fd, hello, strlen(hello));

        uint32_t last_frame = 0;
        uint32_t last_alive = 0;
        bool dead = false;
        while (!dead) {
            uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
            if (now - last_frame >= 500) {
                uint8_t f[11];
                uint8_t nl = '\n';
                last_frame = now;
                build_frame(f);
                if (net_send_all(fd, f, sizeof(f)) != 0 ||
                    net_send_all(fd, &nl, 1) != 0) {
                    dead = true;
                    break;
                }
            }
            if (now - last_alive >= 1000) {
                char line[80];
                last_alive = now;
                snprintf(line, sizeof(line),
                         "[alive] tick=%lu toggles=%lu stage=wifi\n",
                         (unsigned long)s_tick, (unsigned long)s_toggles);
                if (net_send_all(fd, line, strlen(line)) != 0) {
                    dead = true;
                    break;
                }
            }
            /* 对端优雅关闭（recv 返回 0）也要立刻收尾，否则要等下一次 send 报错。 */
            char probe;
            ssize_t r = recv(fd, &probe, 1, MSG_DONTWAIT);
            if (r == 0) {
                dead = true;
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(50));
        }
        printf("[net] client disconnected\n");
        fflush(stdout);
        close(fd);
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = (wifi_event_sta_disconnected_t *)data;
        printf("[wifi] disconnected reason=%d, retrying\n", e->reason);
        fflush(stdout);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        printf("[wifi] got ip=" IPSTR "\n", IP2STR(&e->ip_info.ip));
        fflush(stdout);
        xEventGroupSetBits(s_net_eg, NET_GOT_IP_BIT);
    }
}

static void wifi_start_sta(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    s_net_eg = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    wifi_config_t wc;
    memset(&wc, 0, sizeof(wc));
    strncpy((char *)wc.sta.ssid, CONFIG_KORVO_WIFI_SSID, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, CONFIG_KORVO_WIFI_PASSWORD,
            sizeof(wc.sta.password) - 1);
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;   /* 兼容 WPA2/WPA3 混合热点 */

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    printf("[wifi] connecting ssid=\"%s\"\n", CONFIG_KORVO_WIFI_SSID);
    fflush(stdout);
    ESP_ERROR_CHECK(esp_wifi_start());
}

static void heartbeat_tick(void *arg)
{
    (void)arg;
    s_toggles++;
    /* 1Hz 心跳 + 500ms LED 翻转：同一时基，toggles 每次心跳 +2。 */
    s_pixel[0] = (s_toggles & 1) ? 0x20 : 0x00;     /* 绿色亮 / 灭 */
    led_push();

    {
        uint8_t f[11];
        build_frame(f);
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

    /* 联网遥测：SSID/密码为空时跳过（只跑串口第一关）。 */
    if (strlen(CONFIG_KORVO_WIFI_SSID) == 0) {
        printf("[wifi] skipped (empty SSID)\n");
        fflush(stdout);
        return;
    }
    wifi_start_sta();

    /* 等拿到 IP 再起 TCP 服务（30s 超时也照常起，便于观察连不上时的行为）。 */
    xEventGroupWaitBits(s_net_eg, NET_GOT_IP_BIT, pdTRUE, pdTRUE,
                        pdMS_TO_TICKS(30000));
    xTaskCreate(tcp_server_task, "tcp_telemetry", 4096, NULL, 5, NULL);
}
