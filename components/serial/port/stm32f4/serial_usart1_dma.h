#ifndef SERIAL_USART1_DMA_H
#define SERIAL_USART1_DMA_H

#include <stdint.h>
#include "ota_transport.h"      /* Transport 五函数接口（复用 ota core 抽象） */

/**
 * @file    serial_usart1_dma.h
 * @brief   STM32F4 串口组件实现：USART1 + DMA2_Stream2 循环接收
 *
 * 线束：PA9=TX / PA10=RX（serial_config.h 可调），115200 8N1。
 *
 * 接收：DMA2_Stream2（Channel4）**循环模式** 外设→内存，
 *      软件尾指针追赶 NDTR 读指针 —— **零中断、纯拉取式**
 *      （比 AT32 的 IDLE 搬运少一层 IRQ，天然不与 APP 侧
 *      USART1_IRQHandler 冲突；APP 集成 ota_app_hook 时由工程自己的
 *      USART1 中断喂字节即可，与本组件无关）。
 * 发送：轮询 TXE 阻塞写（与 AT32/F103 版同构）。
 *
 * 无 HAL 依赖：仅 CMSIS 寄存器操作 → BOOT 裸机环境直接可用。
 */
extern const Transport Transport_USART1;

/** @brief 完整初始化 GPIO + USART1 + DMA2_Stream2（供 Transport.init） */
void Serial_USART1_Init(void);

/** @brief 反初始化（供 Transport.deinit） */
void Serial_USART1_Deinit(void);

#endif /* SERIAL_USART1_DMA_H */
