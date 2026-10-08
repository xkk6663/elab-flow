#ifndef SERIAL_CONFIG_H
#define SERIAL_CONFIG_H

/**
 * @file    serial_config.h
 * @brief   串口组件配置骨架（一切皆组件：serial 独立成件，方案 §3.1）
 *
 * 线束/波特率/缓冲大小集中在此，port 实现引用这些宏。
 * 平台差异线束在各 port 头文件内给默认值，工程可 -D 覆盖。
 *
 * ★ 组件准入规则（§3.5）：本文件只含配置常量，不含任何芯片 SDK include。
 */

/* ── 缓冲大小 ─────────────────────────────────────── */
#ifndef SERIAL_RX_BUF_SIZE
/** DMA 接收环形缓冲区大小（2 的幂；与 ota 的 DMA_RX_BUF_SIZE 语义一致） */
#define SERIAL_RX_BUF_SIZE      1024
#endif

/* ── 波特率 ───────────────────────────────────────── */
#ifndef SERIAL_BAUDRATE
#define SERIAL_BAUDRATE         115200
#endif

/* ── 平台默认线束（port 头文件可覆盖）─────────────── */
#if defined(SERIAL_PLAT_STM32F4)
/* F411：USART1 @ PA9(TX)/PA10(RX)，DMA2 Stream2（RX 循环） */
#ifndef SERIAL_TX_PORT
#define SERIAL_TX_PORT          GPIOA
#endif
#ifndef SERIAL_RX_PORT
#define SERIAL_RX_PORT          GPIOA
#endif
#ifndef SERIAL_TX_PIN
#define SERIAL_TX_PIN           9
#endif
#ifndef SERIAL_RX_PIN
#define SERIAL_RX_PIN           10
#endif

#elif defined(SERIAL_PLAT_AT32)
/* AT32F421：USART1 @ PB6(TX)/PB7(RX)，DMA1 CH3（RX，IDLE 搬运） */
#define SERIAL_TX_PORT          GPIOB
#define SERIAL_TX_PIN           GPIO_PINS_6
#define SERIAL_RX_PORT          GPIOB
#define SERIAL_RX_PIN           GPIO_PINS_7

#elif defined(SERIAL_PLAT_STM32F1)
/* F103：USART1 @ PA9(TX)/PA10(RX)，DMA1 CH5（RX 循环） */
#define SERIAL_TX_PORT          GPIOA
#define SERIAL_TX_PIN           GPIO_Pin_9
#define SERIAL_RX_PORT          GPIOA
#define SERIAL_RX_PIN           GPIO_Pin_10
#endif

#endif /* SERIAL_CONFIG_H */
