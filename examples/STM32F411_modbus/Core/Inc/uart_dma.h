/**
  ******************************************************************************
  * @file    uart_dma.h
  * @brief   USART1 + DMA2 收发（Modbus RTU 从站的字节层）
  *
  * 这一层只做三件事，别的什么都不做：
  *   1. RX：**CIRC 循环 DMA + HT/TC（软件乒乓）**，一个够大的连续缓冲；
  *   2. 定界：IDLE 空闲中断做"线路静了"的提示，真正切帧按静默时长判定；
  *   3. TX：两块内存乒乓 + DMA 链式启动（CPU 填 B 块时，DMA 正在发 A 块）。
  *
  * ★ 为什么 RX **不用**硬件双缓冲模式（DBM）：DBM 的 NDTR 是固定的，
  *   整块传完才切 buffer —— 它天生适合定长流（PWM/I2S/音频），而 Modbus RTU
  *   一帧 8~256 字节不定长、靠静默定界。用 CIRC + HT/TC 反而更贴合：
  *   缓冲一直转，CPU 只在 HT/TC/IDLE/主循环里"把已收到的那段搬走"，
  *   既不停止接收，也不用关心寄存器里的 CT 位。
  *
  * 它不认识 Modbus：字节怎么解释是 modbus_slave.c 的事。
  * 这一层可以被任何"帧靠静默定界"的协议复用。
  ******************************************************************************
  */
#ifndef __UART_DMA_H__
#define __UART_DMA_H__

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

/** 循环 DMA 的接收缓冲字节数（必须 ≥ 一帧上限 + 主循环一轮的处理量）。
 *  256B 的取法：Modbus RTU 整帧上限就是 256B，缓冲装得下一整帧最坏情况；
 *  115200 下填满 256B 需要 22ms，主循环（几微秒一圈）有充足时间取走。 */
#define UD_RX_BUF       256u
/** 一帧上限：Modbus RTU 整帧 ≤ 256B（协议硬限制） */
#define UD_FRAME_MAX    256u
/** 收帧判据：线路静默这么久才算"这一帧完了"。
 *
 *  Modbus 规范：>19200 波特用固定 1.75ms。**本板不能用 1.75ms**：
 *  实测经 DAPLink 的 CDC 桥，8 字节请求会被拆成两包，中间静默 >2ms
 *  （见诊断寄存器 0x010A max_gap）。所以取 20ms —— 仍远小于主站的
 *  200ms 超时，且请求-应答式主站在等回复期间不会发下一帧，合帧风险为 0。
 *
 *  ★ 为什么不能"IDLE 一到就收帧"：经 USB-CDC 桥（DAPLink）进来的数据，
 *    8 字节的写有可能被拆成两个 USB 包，中间隔 ~1ms —— 线路真的静了，
 *    IDLE 也真的会置位，但帧还没完。按 IDLE 立刻切帧会把一帧切成 2+6，
 *    两半 CRC 都错，表现就是"偶尔丢一帧、重试才好"。 */
#define UD_FRAME_GAP_MS 20u
/** TX 乒乓缓冲块大小：单次发送上限 */
#define UD_TX_MAX       256u

/** 计数（全部给 Modbus 诊断寄存器 0x0100 段用，面板上能看见双缓冲在动） */
typedef struct {
    uint32_t rx_bytes;      /* DMA 交给帧缓冲的总字节 */
    uint32_t rx_ht;         /* 半满中断（HT）命中次数 —— 前半个缓冲在用了 */
    uint32_t rx_tc;         /* 全满中断（TC）命中次数 —— 后半个缓冲在用了 */
    uint32_t rx_idle;       /* IDLE 定界次数（≈ 收到的帧数，含坏帧） */
    uint32_t rx_overrun;    /* 单帧超过 UD_FRAME_MAX 的字节数 */
    uint32_t rx_drop;       /* 主循环没取走、被新帧挤掉的帧数 */
    uint32_t tx_bytes;      /* DMA 发出去的总字节 */
    uint32_t tx_pingpong;   /* 乒乓切换次数（>0 说明第二块缓冲真的用上了） */
    uint32_t tx_busy_drop;  /* 两块都占着时被拒的发送请求 */
    uint16_t last_frame_len;/* 最近一帧长度 */
    uint32_t max_gap_ms;    /* 一帧内部观察到的**最大字节间隔**（ms）
                             * 用来说明"为什么阈值是 20ms 而不是 2ms"：
                             * 经 USB-CDC 桥进来的数据会被拆包，字节之间
                             * 可能有几十毫秒的空隙，线路是真的静了。 */
} ud_stats_t;

/** 初始化：把 CubeMX 生成的 DMA_NORMAL 改成 CIRCULAR，启动 HT/TC 中断并开 IDLE。
 *  @retval 0 成功；<0 失败（-1 DMA 初始化，-2 循环 DMA 启动） */
int ud_init(void);

/** USART1 IDLE 中断里调用：把 DMA 里已收到的段搬走，并收掉 RXNE 里的残字节。
 *  **必须在 HAL_UART_IRQHandler 之前调用**（见 it.c）。
 *  注意：这里只记"线路刚静过一下"，**不切帧** —— 切帧由 ud_poll 按静默时长判。 */
void ud_on_idle(void);

/** DMA2_Stream2 中断里调用：HT/TC 到点，把已收到的那一段搬进帧缓冲
 *  （自己清标志，HAL 随后无活可干）。 */
void ud_rx_irq(void);

/** 主循环每次都要调：搬走 DMA 新收的字节 + 静默超时 → 收帧。
 *  **不要在中断里收帧**（帧缓冲的翻页需要主循环的节奏）。 */
void ud_poll(void);

/** 取一帧（拷贝出去）。返回 0 = 暂时没有完整帧。 */
uint16_t ud_frame_get(uint8_t *out, uint16_t maxlen);

/** TX 双缓冲发送：拷贝进空闲缓冲并启动/排队。返回 1 已受理，0 丢弃（两块都忙）。 */
int ud_tx(const uint8_t *data, uint16_t len);

/** 还能立刻受理几帧（0/1/2）。**故意"先问后发"**：
 *  连发这类"可以下一圈再来"的发送方先问空位，就能把 ud_tx 的 drop 计数
 *  留给真正丢了的帧（例如应答）。否则主循环空转重试会把 drop 刷成天文数字，
 *  面板上那个数就再也没人信了。 */
int ud_tx_room(void);

/** 只读计数 */
const ud_stats_t *ud_stats(void);

/** TX 完成回调（由 HAL_UART_TxCpltCallback 转进来，见 board.c） */
void ud_on_tx_complete(void);

#ifdef __cplusplus
}
#endif

#endif /* __UART_DMA_H__ */
