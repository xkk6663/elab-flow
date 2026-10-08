/**
 * @file    ota_printf.c
 * @brief   printf 重定向到 USART1（Bootloader 保留打印, v1.1 决策③）
 *
 * 通过 g_Transport 转发字节, 与协议帧共存 USART1。
 * 复用 _write → __io_putchar 链路（newlib-nano）。
 */

#include "ota_transport.h"
#include <stdint.h>
#include <stdio.h>

int __io_putchar(int ch)
{
    /* 等待发送数据缓冲空 (TDBE), 加超时防串口异常阻塞 */
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
