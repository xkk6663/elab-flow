/**
 * @file    serial_usart1_dma.c
 * @brief   STM32F4 串口组件实现：USART1 + DMA2_Stream2 循环接收（零中断）
 *
 * 与 F103 源工程（My_Usart.c 循环 DMA + 尾指针追赶）同构，寄存器级实现：
 *   读指针 = 软件维护的 tail（主循环推进）
 *   写指针 = SERIAL_RX_BUF_SIZE - DMA2_Stream2->NDTR（硬件实时给出）
 *   available = (write - tail) & (SIZE-1) —— 无溢出窗口（循环模式 NDTR 自动回卷）
 *
 * BRR 运行时按 PCLK2 计算（读 RCC->CFGR APB2 预分频），不依赖具体主频。
 */

#include "serial_usart1_dma.h"
#include "../core/serial_config.h"
#include "stm32f4xx.h"

/* ── DMA 接收环形缓冲（DMA 目的地, 循环模式）────────────────── */
static uint8_t s_dma_rx_buf[SERIAL_RX_BUF_SIZE] __attribute__((aligned(4)));
static volatile uint16_t s_rx_tail = 0;         /* 软件读指针（主循环推进） */

/* ════════════════════════════════════════════════════════════
 * 硬件初始化（GPIO + USART1 + DMA2_Stream2）
 * ════════════════════════════════════════════════════════════ */

/* GPIOA 复用配置需要的寄存器级辅助 */
static void serial_gpio_init(void)
{
    /* PA9=AF7(USART1_TX), PA10=AF7(USART1_RX)：引脚号直接索引 AFRH[...] */
    GPIOA->AFR[1] &= ~((0xFUL << ((SERIAL_TX_PIN - 8) * 4)) |
                       (0xFUL << ((SERIAL_RX_PIN - 8) * 4)));
    GPIOA->AFR[1] |=  ((7UL << ((SERIAL_TX_PIN - 8) * 4)) |
                       (7UL << ((SERIAL_RX_PIN - 8) * 4)));

    /* MODER = 复用(10)，OSPEEDR = 很高速(11)，PUPDR = 上拉(01, RX 抗噪) */
    GPIOA->MODER   &= ~((3UL << (SERIAL_TX_PIN * 2)) | (3UL << (SERIAL_RX_PIN * 2)));
    GPIOA->MODER   |=  ((2UL << (SERIAL_TX_PIN * 2)) | (2UL << (SERIAL_RX_PIN * 2)));
    GPIOA->OSPEEDR |=  ((3UL << (SERIAL_TX_PIN * 2)) | (3UL << (SERIAL_RX_PIN * 2)));
    GPIOA->PUPDR   &= ~((3UL << (SERIAL_TX_PIN * 2)) | (3UL << (SERIAL_RX_PIN * 2)));
    GPIOA->PUPDR   |=  ((0UL << (SERIAL_TX_PIN * 2)) | (1UL << (SERIAL_RX_PIN * 2)));
}

/* APB2 时钟频率（USART1 挂 APB2）：读 RCC->CFGR PPRE2 换算 */
static uint32_t serial_pclk2_hz(void)
{
    uint32_t ppre2 = (RCC->CFGR & RCC_CFGR_PPRE2) >> RCC_CFGR_PPRE2_Pos;
    if (ppre2 & 0x4UL) {                        /* 分频生效 */
        return SystemCoreClock >> (1 + (ppre2 & 0x3UL));
    }
    return SystemCoreClock;                     /* 不分频 */
}

void Serial_USART1_Init(void)
{
    /* 外设时钟（兜底使能，工程已开则幂等） */
    RCC->AHB1ENR  |= RCC_AHB1ENR_DMA2EN | RCC_AHB1ENR_GPIOAEN;
    RCC->APB2ENR  |= RCC_APB2ENR_USART1EN;
    (void)RCC->AHB1ENR;                         /* 时钟使能后短延迟（读回） */

    serial_gpio_init();

    /* DMA2_Stream2（USART1_RX, Channel4）：循环模式，外设→内存，字节，MINC */
    DMA_Stream_TypeDef *d = DMA2_Stream2;
    d->CR &= ~DMA_SxCR_EN;                      /* 先关流 */
    while (d->CR & DMA_SxCR_EN) { }             /* 等待关闭（RM0383 建议） */
    d->PAR  = (uint32_t)&USART1->DR;
    d->M0AR = (uint32_t)s_dma_rx_buf;
    d->NDTR = SERIAL_RX_BUF_SIZE;
    d->CR   = (4UL << DMA_SxCR_CHSEL_Pos)       /* Channel4 = USART1_RX */
            | (0UL << DMA_SxCR_DIR_Pos)         /* 外设→内存 */
            | DMA_SxCR_CIRC                     /* 循环模式 ★ */
            | DMA_SxCR_MINC                     /* 内存递增 */
            | DMA_SxCR_PL_1;                    /* 高优先级 */
    d->CR |= DMA_SxCR_EN;

    /* USART1：115200 8N1，无流控，无中断（纯拉取式） */
    USART1->CR1 = 0;                            /* 先关（UE=0 才能写 BRR） */
    USART1->BRR = (serial_pclk2_hz() + SERIAL_BAUDRATE / 2) / SERIAL_BAUDRATE;
    USART1->CR2 = 0;                            /* 1 停止位 */
    USART1->CR3 = USART_CR3_DMAR;               /* ★ RX DMA 请求使能（漏置则
                                                   DMA 空转、NDTR 不走、RX 全静默
                                                   —— f411 实测坑）；TX 走轮询不需要 DMAT */
    USART1->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;

    s_rx_tail = 0;
}

void Serial_USART1_Deinit(void)
{
    USART1->CR1 = 0;
    DMA2_Stream2->CR &= ~DMA_SxCR_EN;
    RCC->APB2ENR &= ~RCC_APB2ENR_USART1EN;
}

/* ════════════════════════════════════════════════════════════
 * 环形缓冲读接口（主循环/协议层调用，纯拉取式零中断）
 * ════════════════════════════════════════════════════════════ */

static uint16_t serial_rx_available(void)
{
    uint16_t write = (uint16_t)(SERIAL_RX_BUF_SIZE - DMA2_Stream2->NDTR);
    return (uint16_t)((write - s_rx_tail) & (SERIAL_RX_BUF_SIZE - 1));
}

static uint8_t serial_rx_read(uint8_t *byte)
{
    if (serial_rx_available() == 0) {           /* 与 available 同公式判空
                                                   （write==tail 直比在 NDTR 回卷
                                                   边界会误判非空） */
        return 0;
    }
    *byte = s_dma_rx_buf[s_rx_tail];
    s_rx_tail = (uint16_t)((s_rx_tail + 1) & (SERIAL_RX_BUF_SIZE - 1));
    return 1;
}

/* ════════════════════════════════════════════════════════════
 * Transport 实例
 * ════════════════════════════════════════════════════════════ */

static void     usart1_init(void)        { Serial_USART1_Init(); }
static void     usart1_deinit(void)      { Serial_USART1_Deinit(); }
static uint8_t  usart1_read(uint8_t *b)  { return serial_rx_read(b); }
static uint16_t usart1_available(void)   { return serial_rx_available(); }

static void usart1_write(uint8_t byte)
{
    /* 等待发送数据寄存器空 (TXE)，加超时防串口异常阻塞 */
    volatile uint32_t timeout = 100000;
    while (!(USART1->SR & USART_SR_TXE)) {
        if (--timeout == 0) { return; }
    }
    USART1->DR = (uint8_t)byte;
}

const Transport Transport_USART1 = {
    .init       = usart1_init,
    .deinit     = usart1_deinit,
    .read       = usart1_read,
    .write      = usart1_write,
    .available  = usart1_available,
};
