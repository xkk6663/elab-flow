#ifndef SERIAL_USART1_DMA_H
#define SERIAL_USART1_DMA_H

#include <stdint.h>
#include "ota_transport.h"      /* Transport 五函数接口 */

/**
 * @file    serial_usart1_dma.h
 * @brief   STM32F1 串口组件实现：USART1 + DMA1_CH5 循环接收（零中断）
 *
 * 提炼自 STM32-OTA-QT IAP-Bootloader/Hardware/My_Usart.c（行为逐行对应）：
 *   - USART1 @ PA9/PA10, 115200, 8N1（standard library）
 *   - DMA1 CH5 循环模式外设→内存，软件尾指针追赶 NDTR
 *   - 无中断，纯拉取式
 */
extern const Transport Transport_USART1;

/** @brief 完整初始化 GPIO + USART1 + DMA1_CH5（供 Transport.init 调用） */
void Serial_USART1_Init(void);

/** @brief 反初始化（供 Transport.deinit 调用） */
void Serial_USART1_Deinit(void);

#endif /* SERIAL_USART1_DMA_H */
