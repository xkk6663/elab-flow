/**
 * @file    ota_printf.c
 * @brief   boot 侧 printf 重定向到 Transport（STM32F1 标准库版）
 *
 * fputc → g_Transport->write，与 AT32/HAL 版同构。
 * 供 VARIANT=boot 使用；工程亦可自带重定向覆盖。
 */

#include "ota_transport.h"
#include <stdint.h>
#include <stdio.h>

int fputc(int ch, FILE *f)
{
    (void)f;
    /* 等 Transport 就绪（加超时防串口异常阻塞） */
    volatile uint32_t timeout = 100000;
    while (g_Transport == 0 || g_Transport->write == 0) {
        if (--timeout == 0) { return ch; }
    }
    g_Transport->write((uint8_t)ch);
    return ch;
}
