#ifndef SERIAL_USART1_DMA_H
#define SERIAL_USART1_DMA_H

#include <stdint.h>
#include "ota_transport.h"      /* Transport 五函数接口 */

/**
 * @file    serial_usart1_dma.h
 * @brief   AT32 串口组件实现：USART1 + DMA1_CH3 非循环接收 + IDLE 搬运
 *
 * 提炼自 AT32 工程ota/port/at32/ota_usart_hal.c（行为逐行对应）：
 *   - USART1 @ PB6/PB7, 115200, 8N1, 无流控
 *   - DMA1 CH3 = RX（外设→内存, 非循环, IDLE 中断搬运环形队列）
 *   - DMA1 CH2 = TX（内存→外设, 预留; 发送实际轮询 TDBE）
 *   - dma_reset() 坑已规避（只重置计数与地址绑定）
 *
 * ★ USART1_IRQHandler 由本文件定义（BOOT target 独占；APP 集成时
 *   由工程自己的中断处理喂 ota_app_hook，勿链接本文件的 boot 实例）。
 */
extern const Transport Transport_USART1;

/** @brief 完整初始化 GPIO + USART1 + DMA（供 Transport.init 调用） */
void Serial_USART1_Init(void);

/** @brief 关闭 USART1/DMA1 时钟（供 Transport.deinit 调用） */
void Serial_USART1_Deinit(void);

/** @brief 从软件环形队列读一个字节（0=空, 1=成功） */
uint8_t Serial_RX_Read(uint8_t *byte);

/** @brief 环形队列中待读字节数 */
uint16_t Serial_RX_Available(void);

/** @brief USART1 IDLE 中断处理（由 USART1_IRQHandler 调用） */
void Serial_USART1_OnIdle(void);

#endif /* SERIAL_USART1_DMA_H */
