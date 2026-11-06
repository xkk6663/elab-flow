/**
  ******************************************************************************
  * @file    board.h
  * @brief   板级：LED / 心跳日志（USART2）/ 时基
  *
  * 心跳走 **USART2**，与 Modbus 的 USART1 物理隔离 —— 日志字节混进总线
  * 会被从站当成帧的一部分，整帧 CRC 就废了（计划 D6）。
  ******************************************************************************
  */
#ifndef __BOARD_H__
#define __BOARD_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"          /* UART_HandleTypeDef / stdint 都从这里来 */

/** 心跳口（PA2/PA3，115200 8N1）：给 stm32f4xx_it.c 的 USART2_IRQHandler 用 */
extern UART_HandleTypeDef huart2;

/** LED(PC13) + DWT 时基 + USART2(PA2/PA3) 心跳口 */
void board_init(void);

/** 主循环里调用：500ms 翻转 LED、1Hz 发心跳（都不阻塞） */
void board_poll(void);

/** HAL_UART_TxCpltCallback 转进来（心跳口用中断发送，避免 5ms 忙等） */
void board_on_uart_tx_complete(void);

uint32_t board_uptime_s(void);
uint16_t board_tick_s(void);
uint16_t board_toggles(void);
uint8_t  board_led_on(void);

/** Modbus 写 0x0010 / 线圈 0 时调用：接管 LED（停止心跳闪烁，避免"谁在控制"说不清） */
void board_set_led(uint8_t on);

#ifdef __cplusplus
}
#endif

#endif /* __BOARD_H__ */
