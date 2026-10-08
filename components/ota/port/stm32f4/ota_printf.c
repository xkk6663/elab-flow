/**
 * @file    ota_printf.c
 * @brief   boot 侧 printf 重定向到 Transport（HAL 版，与 AT32 版同构）
 *
 * _write → __io_putchar → g_Transport->write，与协议帧共存同一串口。
 * 供 VARIANT=boot 使用；工程亦可自带重定向覆盖（链接期弱符号可被覆盖时）。
 */

#include "ota_transport.h"
#include <stdint.h>
#include <stdio.h>

int __io_putchar(int ch)
{
    /* 等 Transport 就绪（加超时防串口异常阻塞） */
    volatile uint32_t timeout = 100000;
    while (g_Transport == 0 || g_Transport->write == 0) {
        if (--timeout == 0) { return ch; }
    }
    g_Transport->write((uint8_t)ch);
    return ch;
}

int _write(int file, char *ptr, int len)
{
    (void)file;
    for (int i = 0; i < len; i++) {
        __io_putchar(*ptr++);
    }
    return len;
}
