/**
 * @file    serial_usart1_dma.c
 * @brief   STM32F1 串口组件实现（提炼自 My_Usart.c，行为逐行对应）
 *
 * DMA 循环缓冲区 — DMA 写，主循环读；写指针 = SIZE - NDTR。
 * fputc 重定向不在本组件（ota 的 ota_printf.c / 工程自带均按需挂接）。
 */

#include "serial_usart1_dma.h"
#include "../core/serial_config.h"
#include "stm32f10x.h"

/* DMA 循环缓冲区 — DMA 写，主循环读 */
static uint8_t  s_dma_rx_buf[SERIAL_RX_BUF_SIZE] __attribute__((aligned(4)));
static volatile uint16_t s_rx_read_idx;

void Serial_USART1_Init(void)
{
    /* 开启时钟 */
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1, ENABLE);

    /* GPIO 初始化：TX=PA9, RX=PA10 */
    GPIO_InitTypeDef GPIO_InitStructure;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStructure.GPIO_Pin = SERIAL_TX_PIN;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
    GPIO_Init(SERIAL_TX_PORT, &GPIO_InitStructure);

    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_InitStructure.GPIO_Pin = SERIAL_RX_PIN;
    GPIO_Init(SERIAL_RX_PORT, &GPIO_InitStructure);

    /* USART 配置：115200, 8N1 */
    USART_InitTypeDef USART_InitStructure;
    USART_InitStructure.USART_BaudRate = SERIAL_BAUDRATE;
    USART_InitStructure.USART_HardwareFlowControl = USART_HardwareFlowControl_None;
    USART_InitStructure.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    USART_InitStructure.USART_Parity = USART_Parity_No;
    USART_InitStructure.USART_StopBits = USART_StopBits_1;
    USART_InitStructure.USART_WordLength = USART_WordLength_8b;
    USART_Init(USART1, &USART_InitStructure);

    /* DMA1 通道 5：USART1_RX → 环形缓冲（循环模式） */
    DMA_InitTypeDef DMA_InitStruct;
    DMA_InitStruct.DMA_PeripheralBaseAddr = (uint32_t)&USART1->DR;
    DMA_InitStruct.DMA_MemoryBaseAddr     = (uint32_t)s_dma_rx_buf;
    DMA_InitStruct.DMA_DIR                = DMA_DIR_PeripheralSRC;
    DMA_InitStruct.DMA_BufferSize         = SERIAL_RX_BUF_SIZE;
    DMA_InitStruct.DMA_PeripheralInc      = DMA_PeripheralInc_Disable;
    DMA_InitStruct.DMA_MemoryInc          = DMA_MemoryInc_Enable;
    DMA_InitStruct.DMA_PeripheralDataSize = DMA_PeripheralDataSize_Byte;
    DMA_InitStruct.DMA_MemoryDataSize     = DMA_MemoryDataSize_Byte;
    DMA_InitStruct.DMA_Mode               = DMA_Mode_Circular;
    DMA_InitStruct.DMA_Priority           = DMA_Priority_High;
    DMA_InitStruct.DMA_M2M                = DMA_M2M_Disable;
    DMA_Init(DMA1_Channel5, &DMA_InitStruct);

    USART_DMACmd(USART1, USART_DMAReq_Rx, ENABLE);

    USART_Cmd(USART1, ENABLE);
    DMA_Cmd(DMA1_Channel5, ENABLE);

    s_rx_read_idx = 0;
}

void Serial_USART1_Deinit(void)
{
    DMA_Cmd(DMA1_Channel5, DISABLE);
    USART_Cmd(USART1, DISABLE);
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, DISABLE);
}

/* 环形缓冲区还没读取的字节数 */
static uint16_t serial_rx_available(void)
{
    uint16_t writeIdx = SERIAL_RX_BUF_SIZE - DMA_GetCurrDataCounter(DMA1_Channel5);
    return (writeIdx - s_rx_read_idx) & (SERIAL_RX_BUF_SIZE - 1);
}

/* 从环形缓冲区中读取字节 */
static uint8_t serial_rx_read(uint8_t *pData)
{
    uint16_t writeIdx = SERIAL_RX_BUF_SIZE - DMA_GetCurrDataCounter(DMA1_Channel5);
    if (writeIdx == s_rx_read_idx) {
        return 0;
    }
    *pData = s_dma_rx_buf[s_rx_read_idx];
    s_rx_read_idx = (s_rx_read_idx + 1) & (SERIAL_RX_BUF_SIZE - 1);
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
    volatile uint32_t timeout = 100000;
    while (USART_GetFlagStatus(USART1, USART_FLAG_TXE) == RESET) {
        if (--timeout == 0) { return; }
    }
    USART_SendData(USART1, (uint8_t)byte);
}

const Transport Transport_USART1 = {
    .init       = usart1_init,
    .deinit     = usart1_deinit,
    .read       = usart1_read,
    .write      = usart1_write,
    .available  = usart1_available,
};
