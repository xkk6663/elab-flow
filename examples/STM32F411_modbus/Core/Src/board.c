/**
  ******************************************************************************
  * @file    board.c
  * @brief   板级：LED(PC13) / 心跳日志(USART2) / 时基
  *
  * 三条硬约束（AGENTS.md「芯片闭环第一关」）：
  *   1. 心跳 1Hz，行内带可核对的 tick / toggles / stage；
  *   2. LED 与心跳**同一时基**，500ms 翻转；
  *   3. 主循环不许阻塞延时 —— 心跳用中断发送，LED 用 HAL_GetTick 比较。
  *
  * PC13 是**低电平点亮**（BlackPill / 最小系统板的通用接法），写反了会
  * 出现"灯一直亮着，看起来像死机"的假象。
  ******************************************************************************
  */

#include "main.h"
#include "board.h"
#include "modbus_slave.h"
#include "uart_dma.h"
#include <string.h>

UART_HandleTypeDef huart2;

#define LED_GPIO_PORT   GPIOC
#define LED_PIN         GPIO_PIN_13      /* 低电平点亮 */

static uint8_t  led_manual;              /* 1 = 已被 Modbus 接管 */
static uint8_t  led_on;
static uint32_t next_toggle_ms;
static uint32_t next_beat_ms;
static uint32_t toggles;
static volatile uint8_t hb_busy;
static char hb_line[96];

/* ── 无 libm / 无 printf 的小格式化：心跳路径要可预测，别拉进 newlib ── */
static char *put_str(char *p, const char *s)
{
    while (*s) {
        *p++ = *s++;
    }
    return p;
}

static char *put_u32(char *p, uint32_t v)
{
    char tmp[10];
    int n = 0;

    if (v == 0u) {
        *p++ = '0';
        return p;
    }
    while (v > 0u && n < (int)sizeof(tmp)) {
        tmp[n++] = (char)('0' + (v % 10u));
        v /= 10u;
    }
    while (n > 0) {
        *p++ = tmp[--n];
    }
    return p;
}

static void usart2_init(void)
{
    GPIO_InitTypeDef gpio = {0};

    __HAL_RCC_USART2_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();

    /* PA2 = USART2_TX, PA3 = USART2_RX（AF7） */
    gpio.Pin = GPIO_PIN_2 | GPIO_PIN_3;
    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = GPIO_AF7_USART2;
    HAL_GPIO_Init(GPIOA, &gpio);

    huart2.Instance = USART2;
    huart2.Init.BaudRate = 115200;
    huart2.Init.WordLength = UART_WORDLENGTH_8B;
    huart2.Init.StopBits = UART_STOPBITS_1;
    huart2.Init.Parity = UART_PARITY_NONE;
    huart2.Init.Mode = UART_MODE_TX_RX;
    huart2.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    huart2.Init.OverSampling = UART_OVERSAMPLING_16;
    (void)HAL_UART_Init(&huart2);

    /* 中断发送要开 NVIC（USART2_IRQHandler 在 stm32f4xx_it.c） */
    HAL_NVIC_SetPriority(USART2_IRQn, 1, 0);
    HAL_NVIC_EnableIRQ(USART2_IRQn);
}

void board_init(void)
{
    GPIO_InitTypeDef gpio = {0};

    /* DWT 周期计数器：比 HAL_GetTick(1ms) 细，量帧间隔够用 */
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CYCCNT = 0;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;

    __HAL_RCC_GPIOC_CLK_ENABLE();
    gpio.Pin = LED_PIN;
    gpio.Mode = GPIO_MODE_OUTPUT_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(LED_GPIO_PORT, &gpio);
    HAL_GPIO_WritePin(LED_GPIO_PORT, LED_PIN, GPIO_PIN_SET);   /* 高 = 灭 */

    usart2_init();

    led_manual = 0;
    led_on = 0;
    toggles = 0;
    next_toggle_ms = HAL_GetTick() + 500u;
    next_beat_ms = HAL_GetTick() + 1000u;
    hb_busy = 0;
}

void board_set_led(uint8_t on)
{
    led_manual = 1;
    led_on = on ? 1u : 0u;
    HAL_GPIO_WritePin(LED_GPIO_PORT, LED_PIN,
                      led_on ? GPIO_PIN_RESET : GPIO_PIN_SET);
}

uint8_t board_led_on(void)
{
    return led_on;
}

uint32_t board_uptime_s(void)
{
    return HAL_GetTick() / 1000u;
}

uint16_t board_tick_s(void)
{
    return (uint16_t)((HAL_GetTick() / 1000u) & 0xFFFFu);
}

uint16_t board_toggles(void)
{
    return (uint16_t)(toggles & 0xFFFFu);
}

void board_poll(void)
{
    uint32_t now = HAL_GetTick();

    /* LED：心跳期 500ms 翻转；被 Modbus 接管后不再自动翻 */
    if (!led_manual && (int32_t)(now - next_toggle_ms) >= 0) {
        next_toggle_ms += 500u;
        led_on ^= 1u;
        toggles++;
        HAL_GPIO_WritePin(LED_GPIO_PORT, LED_PIN,
                          led_on ? GPIO_PIN_RESET : GPIO_PIN_SET);
    }

    /* 心跳：1Hz 一行，字段固定顺序，便于机器判定（toggles 严格 +2/次） */
    if ((int32_t)(now - next_beat_ms) >= 0) {
        next_beat_ms += 1000u;
        if (!hb_busy) {
            const ud_stats_t *s = ud_stats();
            char *p = hb_line;
            p = put_str(p, "[alive] tick=");
            p = put_u32(p, now / 1000u);
            p = put_str(p, " toggles=");
            p = put_u32(p, toggles);
            p = put_str(p, " stage=");
            p = put_u32(p, mb_slave_stage());
            p = put_str(p, " frames=");
            p = put_u32(p, mb_slave_frames());
            p = put_str(p, " rxidle=");
            p = put_u32(p, s->rx_idle);
            p = put_str(p, " txpp=");
            p = put_u32(p, s->tx_pingpong);
            p = put_str(p, "\r\n");
            hb_busy = 1;
            if (HAL_UART_Transmit_IT(&huart2, (uint8_t *)hb_line,
                                     (uint16_t)(p - hb_line)) != HAL_OK) {
                hb_busy = 0;
            }
            /* ── 单口方案：首帧之前，USART1 兼做心跳口 ──────────────────
             * 没有第二只 USB-TTL 时，这是"板子活着"唯一能被抓到的证据。
             * 三条保险，缺一条都不行：
             *   ① 见过帧就永久闭嘴（mb_bus_seen）—— 之后总线只跑 Modbus；
             *   ② 最近 300ms 总线上有过字节就跳过 —— 别插进正在收的帧中间；
             *   ③ 走 ud_tx（同一套 TX 双缓冲），不直接抢 huart1 的 DMA 状态。 */
            if (!mb_bus_seen() && (now - mb_last_activity_ms()) > 300u) {
                (void)ud_tx((const uint8_t *)hb_line, (uint16_t)(p - hb_line));
            }
        }
    }
}

void board_on_uart_tx_complete(void)
{
    hb_busy = 0;
}
