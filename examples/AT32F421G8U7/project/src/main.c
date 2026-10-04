/* add user code begin Header */
/**
  **************************************************************************
  * @file     main.c
  * @brief    main program
  **************************************************************************
  * Copyright (c) 2025, Artery Technology, All rights reserved.
  *
  * The software Board Support Package (BSP) that is made available to
  * download from Artery official website is the copyrighted work of Artery.
  * Artery authorizes customers to use, copy, and distribute the BSP
  * software and its related documentation for the purpose of design and
  * development in conjunction with Artery microcontrollers. Use of the
  * software is governed by this copyright notice and the following disclaimer.
  *
  * THIS SOFTWARE IS PROVIDED ON "AS IS" BASIS WITHOUT WARRANTIES,
  * GUARANTEES OR REPRESENTATIONS OF ANY KIND. ARTERY EXPRESSLY DISCLAIMS,
  * TO THE FULLEST EXTENT PERMITTED BY LAW, ALL EXPRESS, IMPLIED OR
  * STATUTORY OR OTHER WARRANTIES, GUARANTEES OR REPRESENTATIONS,
  * INCLUDING BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY,
  * FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT.
  *
  **************************************************************************
  */
/* add user code end Header */

/* Includes ------------------------------------------------------------------*/
#include "at32f421_wk_config.h"
#include "wk_usart.h"
#include "wk_dma.h"
#include "wk_system.h"

/* private includes ----------------------------------------------------------*/
/* add user code begin private includes */

/* add user code end private includes */

/* private typedef -----------------------------------------------------------*/
/* add user code begin private typedef */

/* add user code end private typedef */

/* private define ------------------------------------------------------------*/
/* add user code begin private define */

/* add user code end private define */

/* private macro -------------------------------------------------------------*/
/* add user code begin private macro */

/* add user code end private macro */

/* private variables ---------------------------------------------------------*/
/* add user code begin private variables */

/* 心跳计数：供 elab 闭环判据观察主循环是否还在推进 */
static volatile uint32_t g_tick = 0;

/* add user code end private variables */

/* private function prototypes --------------------------------------------*/
/* add user code begin function prototypes */

/* add user code end function prototypes */

/* private user code ---------------------------------------------------------*/
/* add user code begin 0 */

/**
  * @brief  printf 重定向到 USART1（裸机轮询发送）
  * @param  ch  待发送字符
  * @retval ch
  * @note   syscalls.c 对 __io_putchar 只做了 __attribute__((weak)) 的**声明**、
  *         全工程并无定义 —— 所以 _write() 一旦被 printf 调到就会跳到地址 0。
  *         这里给出**强定义**把它真正接上，newlib 的 _write() 才有出口。
  *         USART1 已在 wk_usart1_init() 里 115200/8N1 使能 TX（PB6 / MUX_0）。
  *         加 guard 递减是防呆：万一在 USART 就绪前被调用，也不至于死等。
  */
int __io_putchar(int ch)
{
  uint32_t guard = 2000000u;
  while(usart_flag_get(USART1, USART_TDBE_FLAG) == RESET && guard--)
  {
  }
  usart_data_transmit(USART1, (uint16_t)ch);
  return ch;
}

/* add user code end 0 */

/**
  * @brief main function.
  * @param  none
  * @retval none
  */
int main(void)
{
  /* add user code begin 1 */

  /* add user code end 1 */

  /* system clock config. */
  wk_system_clock_config();

  /* config periph clock. */
  wk_periph_clock_config();

  /* nvic config. */
  wk_nvic_config();

  /* timebase config for
     void wk_delay_us(uint32_t delay);
     void wk_delay_ms(uint32_t delay); */
  wk_timebase_init();

  /* init dma1 channel2 */
  wk_dma1_channel2_init();
  /* config dma channel transfer parameter */
  /* user need to modify define values DMAx_CHANNELy_XXX_BASE_ADDR 
     and DMAx_CHANNELy_BUFFER_SIZE in at32xxx_wk_config.h */
  wk_dma_channel_config(DMA1_CHANNEL2, 
                        (uint32_t)&USART1->dt, 
                        DMA1_CHANNEL2_MEMORY_BASE_ADDR, 
                        DMA1_CHANNEL2_BUFFER_SIZE);
  dma_channel_enable(DMA1_CHANNEL2, TRUE);

  /* init dma1 channel3 */
  wk_dma1_channel3_init();
  /* config dma channel transfer parameter */
  /* user need to modify define values DMAx_CHANNELy_XXX_BASE_ADDR 
     and DMAx_CHANNELy_BUFFER_SIZE in at32xxx_wk_config.h */
  wk_dma_channel_config(DMA1_CHANNEL3, 
                        (uint32_t)&USART1->dt, 
                        DMA1_CHANNEL3_MEMORY_BASE_ADDR, 
                        DMA1_CHANNEL3_BUFFER_SIZE);
  dma_channel_enable(DMA1_CHANNEL3, TRUE);

  /* init usart1 function. */
  wk_usart1_init();

  /* add user code begin 2 */

  /* 启动横幅：证明「复位 → 时钟 → USART1 → printf → 线」整条链路通 */
  printf("\r\n[boot] at32f421g8u7 ok, sysclk=%lu Hz\r\n",
         (unsigned long)system_core_clock);

  /* add user code end 2 */

  while(1)
  {
    /* add user code begin 3 */

    /* 心跳：闭环判据必须能「随时接入」，一次性横幅会错过；
       带 tick 计数还可反推主循环是否卡死。 */
    printf("[alive] tick=%lu\r\n", (unsigned long)++g_tick);
    wk_delay_ms(1000);

    /* add user code end 3 */
  }
}

  /* add user code begin 4 */

  /* add user code end 4 */
