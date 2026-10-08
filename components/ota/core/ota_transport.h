#ifndef OTA_TRANSPORT_H
#define OTA_TRANSPORT_H

#include <stdint.h>

/**
 * @brief  传输层抽象接口
 *
 * 所有与硬件相关的数据收发通过此接口完成。更换通信方式
 * （USARTx / CAN / SPI / I2C）只需注册不同的 Transport 实例。
 *
 * 使用方式:
 *   1. 按 transport_xxx.h 的声明包含具体传输层头文件
 *   2. 在 main 中设置 g_Transport = &Transport_XXX
 *   3. 调用 g_Transport->init()
 *
 * 接入新的通信方式:
 *   1. 实现 Transport 结构体中的四个函数
 *   2. 在 transport_xxx.h 中 extern 声明 Transport_XXX 实例
 *   3. 在 transport_xxx.c 中定义 Transport_XXX = { ... }
 */
typedef struct {
    /** @brief 初始化硬件（时钟、GPIO、中断、DMA 等） */
    void    (*init)(void);

    /**
     * @brief  反初始化硬件（关闭时钟、禁用外设等）
     *         不需要时可设为 NULL
     */
    void    (*deinit)(void);

    /**
     * @brief  读取一个字节
     * @param  byte: 输出缓冲区
     * @return 1=读取成功，0=无数据
     */
    uint8_t (*read)(uint8_t *byte);

    /** @brief 写入一个字节（阻塞直到发送完成） */
    void    (*write)(uint8_t byte);

    /**
     * @brief  查询可读字节数
     * @return 缓冲区中待读取的字节数
     */
    uint16_t (*available)(void);
} Transport;

/** 全局传输层接口指针（由 Transport_Attach 设置） */
extern const Transport *g_Transport;

/**
 * @brief  注册当前使用的传输层
 * @param  t: 传输层实例指针（如 &Transport_USART1）
 */
void Transport_Attach(const Transport *t);

/**
 * @brief  注销当前传输层
 */
void Transport_Detach(void);

/**
 * @brief  获取当前传输层实例指针
 * @return 当前 Transport 指针，未注册时返回 NULL
 */
const Transport *Transport_GetCurrent(void);

/**
 * @brief  初始化当前传输层
 */
void Transport_Init(void);

/**
 * @brief  反初始化当前传输层并注销
 */
void Transport_Deinit(void);

#endif /* OTA_TRANSPORT_H */
