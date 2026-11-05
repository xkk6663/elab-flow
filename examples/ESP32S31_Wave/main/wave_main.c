/*
 * examples/ESP32S31_Wave/main/wave_main.c —— 三链路（USB 串口 / TCP / UDP）波形演示
 *
 * 目的：给「串口波形」「网络传输」「帧协议」「日志诊断」做一套**看得见的**真板数据源。
 *
 * 三条链路刻意做成不同的日志前缀，避免看教程的人误以为两条链路是同一份数据：
 *   USB 串口 stdout → 文本 `[usb] ...`（只有本地线能看到）
 *   TCP 9000       → 文本 `[net] ...`（PC 作为客户端连板子）
 *   UDP 9100       → 文本 `[udp] ...`（板子主动发给 PC，PC 监听）
 *
 * 帧协议刻意做小（7 字节，方便手算）：
 *   AA 55 | seq u8 | sine u8 | tri u8 | sq u8 | sum8
 *   sum8 = 前 6 字节相加；三个通道 0..255，形状/频率不同，波形一眼能区分。
 *
 * 约束：主循环不阻塞（esp_timer 20ms 一帧；各任务只做发送），LED 与心跳同一时基。
 */
#include <arpa/inet.h>
#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
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
#define WS2812_T0H    3
#define WS2812_T0L    9
#define WS2812_T1H    9
#define WS2812_T1L    3
#define WS2812_RESET  250

/** 一帧 20ms（50Hz）：波形在 115200 波特率下也足够顺滑。 */
#define FRAME_PERIOD_US 20000
/** 每 50 帧 = 1s 打一条人读日志。 */
#define TEXT_EVERY_FRAMES 50

#define PI_F 3.14159265f

static rmt_channel_handle_t s_chan;
static rmt_encoder_handle_t s_encoder;
static uint8_t s_pixel[3] = {0x00, 0x00, 0x00};   /* WS2812 字节序：G, R, B */

/** 帧序号（单写多读）：波形相位与 seq 一一对应。 */
static volatile uint32_t s_seq;
/** TCP 当前是否有人连（只影响 LED 颜色，不影响数据）。 */
static volatile bool s_tcp_live;

#define NET_GOT_IP_BIT BIT0
static EventGroupHandle_t s_net_eg;

void app_main(void);

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
    (void)rmt_transmit(s_chan, s_encoder, s_pixel, sizeof(s_pixel), &tx_cfg);
}

/* ── 三路波形（0..255）：形状与周期都不同，波形页一眼能区分 ───────── */
static uint8_t sine_of(uint32_t seq)
{
    /* 75 帧 = 1.5s 一个周期 */
    return (uint8_t)(128.0f + 110.0f * sinf(2.0f * PI_F * (float)(seq % 75) / 75.0f));
}

static uint8_t tri_of(uint32_t seq)
{
    /* 150 帧 = 3s 一个周期：30 → 180 → 30 */
    uint32_t t = seq % 150;
    return (uint8_t)(t < 75 ? 30 + 2 * t : 30 + 2 * (150 - t));
}

static uint8_t sq_of(uint32_t seq)
{
    /* 100 帧 = 2s 一个周期：高 1s / 低 1s */
    return (uint8_t)((seq % 100) < 50 ? 230 : 32);
}

/** 组一帧：AA 55 | seq | sine | tri | sq | sum8（与 projects/esp32s31_wave.frames.json 一致） */
static void build_frame(uint32_t seq, uint8_t f[7])
{
    uint8_t sum = 0;
    f[0] = 0xAA;
    f[1] = 0x55;
    f[2] = (uint8_t)(seq & 0xFF);
    f[3] = sine_of(seq);
    f[4] = tri_of(seq);
    f[5] = sq_of(seq);
    for (int i = 0; i < 6; i++) {
        sum = (uint8_t)(sum + f[i]);
    }
    f[6] = sum;
}

/* ── 日志诊断（M6）演示：打印真实的 panic 文本 + 真实函数地址 ─────
 * 不真的崩溃（会断链路）；文本格式与 ESP-IDF 真 panic 一致，
 * 这样面板的 log profile 能识别，addr2line 也能把地址解回函数。 */
static void inject_panic_lines(void (*emit)(const char *line))
{
    char buf[160];
    snprintf(buf, sizeof(buf),
             "\nGuru Meditation Error: Core  0 panic'ed (LoadProhibited). Exception was unhandled.\n");
    emit(buf);
    emit("Injected panic demo (board keeps running)\n");
    snprintf(buf, sizeof(buf), "Backtrace: 0x%08x 0x%08x 0x%08x\n",
             (unsigned)(uintptr_t)&build_frame,
             (unsigned)(uintptr_t)&sine_of,
             (unsigned)(uintptr_t)&app_main);
    emit(buf);
    fflush(stdout);
}

static int g_tcp_fd = -1;

static void emit_tcp(const char *line)
{
    if (g_tcp_fd >= 0) {
        (void)send(g_tcp_fd, line, strlen(line), 0);
    }
}

/* ── TCP 服务（板子监听 9000，PC 主动连入）─────────────────────── */
static int net_send_all(int fd, const void *buf, size_t len)
{
    const uint8_t *p = (const uint8_t *)buf;
    while (len > 0) {
        ssize_t n = send(fd, p, len, 0);
        if (n <= 0) {
            return -1;
        }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

static void tcp_server_task(void *arg)
{
    (void)arg;
    int port = CONFIG_WAVE_TCP_PORT;
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
        g_tcp_fd = fd;
        s_tcp_live = true;
        printf("[net] client connected\n");
        fflush(stdout);

        char hello[128];
        snprintf(hello, sizeof(hello),
                 "[net] esp32s31_wave telemetry ready (frame=7B, 50Hz)\n");
        (void)net_send_all(fd, hello, strlen(hello));

        int64_t last_frame_us = 0;
        int64_t last_text_us = 0;
        char cmd[8];
        int cn = 0;
        bool dead = false;

        while (!dead) {
            int64_t now = esp_timer_get_time();
            if (now - last_frame_us >= FRAME_PERIOD_US) {
                uint8_t f[7];
                last_frame_us = now;
                build_frame(s_seq, f);
                if (net_send_all(fd, f, sizeof(f)) != 0) {
                    dead = true;
                    break;
                }
            }
            if (now - last_text_us >= 1000000) {
                char line[120];
                last_text_us = now;
                snprintf(line, sizeof(line),
                         "[net] seq=%lu sine=%u tri=%u sq=%u fps=50\n",
                         (unsigned long)s_seq, sine_of(s_seq), tri_of(s_seq), sq_of(s_seq));
                if (net_send_all(fd, line, strlen(line)) != 0) {
                    dead = true;
                    break;
                }
            }
            /* 读命令：收到 "boom" 就注入一段 panic 演示（顺便验证 issues 面板） */
            char probe[8];
            errno = 0;
            ssize_t r = recv(fd, probe, sizeof(probe), MSG_DONTWAIT);
            if (r == 0) {
                dead = true;
                break;
            }
            /* 对端 RST：recv 返回 -1（ECONNRESET），不能当成"暂时没数据"，
             * 否则服务端会一直卡在这条死链路上，再也不 accept 新客户端。 */
            if (r < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
                dead = true;
                break;
            }
            for (ssize_t i = 0; i < r; i++) {
                char c = probe[i];
                if (c == '\r' || c == '\n') {
                    cmd[cn] = '\0';
                    if (cn >= 4 && strstr(cmd, "boom") != NULL) {
                        emit_tcp("[net] boom command received\n");
                        inject_panic_lines(emit_tcp);
                    }
                    cn = 0;
                } else if (cn < (int)sizeof(cmd) - 1) {
                    cmd[cn++] = c;
                }
            }
            vTaskDelay(pdMS_TO_TICKS(5));
        }
        g_tcp_fd = -1;
        s_tcp_live = false;
        printf("[net] client disconnected\n");
        fflush(stdout);
        close(fd);
    }
}

/* ── UDP（板子主动发给 PC 的监听端口）─────────────────────────────
 * netio 的 UDP 是「PC 绑定端口，先收到哪个地址的包就回给谁」；
 * 所以这里必须由板子先发，PC 才能学到对端。 */
static void udp_sender_task(void *arg)
{
    (void)arg;
    if (strlen(CONFIG_WAVE_UDP_HOST) == 0) {
        printf("[udp] skipped (empty WAVE_UDP_HOST)\n");
        fflush(stdout);
        vTaskDelete(NULL);
        return;
    }

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        printf("[udp] socket() failed\n");
        vTaskDelete(NULL);
        return;
    }

    struct sockaddr_in dst;
    memset(&dst, 0, sizeof(dst));
    dst.sin_family = AF_INET;
    dst.sin_addr.s_addr = inet_addr(CONFIG_WAVE_UDP_HOST);
    dst.sin_port = htons((uint16_t)CONFIG_WAVE_UDP_PORT);
    printf("[udp] sending to %s:%d\n", CONFIG_WAVE_UDP_HOST, CONFIG_WAVE_UDP_PORT);
    fflush(stdout);

    int64_t last_frame_us = 0;
    int64_t last_text_us = 0;
    while (1) {
        int64_t now = esp_timer_get_time();
        if (now - last_frame_us >= FRAME_PERIOD_US) {
            uint8_t f[7];
            last_frame_us = now;
            build_frame(s_seq, f);
            (void)sendto(sock, f, sizeof(f), 0, (struct sockaddr *)&dst, sizeof(dst));
        }
        if (now - last_text_us >= 1000000) {
            char line[120];
            last_text_us = now;
            snprintf(line, sizeof(line),
                     "[udp] seq=%lu sine=%u tri=%u sq=%u fps=50\n",
                     (unsigned long)s_seq, sine_of(s_seq), tri_of(s_seq), sq_of(s_seq));
            (void)sendto(sock, line, strlen(line), 0, (struct sockaddr *)&dst, sizeof(dst));
        }
        vTaskDelay(pdMS_TO_TICKS(5));
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
    strncpy((char *)wc.sta.ssid, CONFIG_WAVE_WIFI_SSID, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, CONFIG_WAVE_WIFI_PASSWORD,
            sizeof(wc.sta.password) - 1);
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    printf("[wifi] connecting ssid=\"%s\"\n", CONFIG_WAVE_WIFI_SSID);
    fflush(stdout);
    ESP_ERROR_CHECK(esp_wifi_start());
}

/** 20ms 一拍：推进波形相位 + 500ms 翻 LED + 50Hz 往 USB 写二进制帧。 */
static void wave_tick(void *arg)
{
    (void)arg;
    uint32_t seq = ++s_seq;

    if ((seq % 25) == 0) {
        /* 与波形同一时基的 500ms LED 翻转；TCP 有客户端时变蓝，便于肉眼确认链路。 */
        bool on = ((seq / 25) & 1) != 0;
        s_pixel[0] = (!s_tcp_live && on) ? 0x20 : 0x00;   /* G：串口链路·绿 */
        s_pixel[1] = 0x00;                                 /* R：不用 */
        s_pixel[2] = (s_tcp_live && on) ? 0x30 : 0x00;    /* B：TCP 在线·蓝 */
        led_push();
    }

    {
        uint8_t f[7];
        build_frame(seq, f);
        fwrite(f, 1, sizeof(f), stdout);
    }

    if ((seq % TEXT_EVERY_FRAMES) == 0) {
        printf("[usb] seq=%lu sine=%u tri=%u sq=%u fps=50\n",
               (unsigned long)seq, sine_of(seq), tri_of(seq), sq_of(seq));
        fflush(stdout);
    }
}

void app_main(void)
{
    printf("[boot] esp32s31_wave demo start (frame=7B, usb=[usb] net=[net] udp=[udp])\n");
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
    led_push();

    esp_timer_handle_t timer;
    esp_timer_create_args_t timer_args = {
        .callback = wave_tick,
        .arg = NULL,
        .name = "wave",
    };
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer, FRAME_PERIOD_US));

    if (strlen(CONFIG_WAVE_WIFI_SSID) == 0) {
        printf("[wifi] skipped (empty SSID)\n");
        fflush(stdout);
        return;
    }
    wifi_start_sta();

    xEventGroupWaitBits(s_net_eg, NET_GOT_IP_BIT, pdTRUE, pdTRUE,
                        pdMS_TO_TICKS(30000));
    xTaskCreate(tcp_server_task, "tcp_wave", 4096, NULL, 5, NULL);
    xTaskCreate(udp_sender_task, "udp_wave", 4096, NULL, 5, NULL);
}
