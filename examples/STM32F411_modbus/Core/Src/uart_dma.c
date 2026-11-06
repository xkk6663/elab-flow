/**
  ******************************************************************************
  * @file    uart_dma.c
  * @brief   USART1 + DMA2 收发（Modbus RTU 从站字节层）：CIRC 环形收 + 帧级双缓冲 + TX 乒乓
  *
 * ## 为什么 RX 用"循环 DMA + HT/TC"，而不是硬件双缓冲（DBM）
 *
 * 问题的实质不是"慢"，是**窗口**：CPU 正在处理上一批字节的那几微秒里，
 * 新到的字节没人接就会丢（115200 下一字节约 87 µs，Modbus 一次读 125 个
 * 寄存器时线上一连串 300 多字节）。
 *
 * 让 DMA 接手"接字节"是对的，但**收这一侧不能上硬件 DBM**：
 *   - DBM 的 NDTR 是**固定**的，整块传完才切换 M0↔M1。它天生适合定长流
 *     （PWM 波形、I2S 音频、DAC 查表）。
 *   - Modbus RTU 一帧 **8~256 字节不定长**，靠 3.5 字符静默定界。用 DBM 只能
 *     把块定成 256B，于是一帧要等到"攒满 256B 或超时"才切换 —— 短帧被拖长、
 *     长帧被切碎，定界逻辑全废。
 *
 * 所以 RX 走 **CIRC 循环 DMA + HT/TC**：一个 256B 的连续环，DMA 永不停止地
 * 往里写；CPU 在 HT/TC/IDLE/主循环里用 `NDTR` 反推"已经写进去多少"，
 * 把 `[rx_tail, pos)` 这一段搬进帧缓冲。写头和追尾各管一段，互不改写。
 *
 * ## 帧缓冲本身是双缓冲（层次要分清）
 *
 * 字节层用环，**帧层**仍然是两块 `frm_mem[2]`：ISR 往一块里攒，主循环取另一块。
 * 这才是"双缓冲"在本例里的落点 —— 不是 DMA 硬件的 DBM 位。
 *
 * ## HT/TC 只是"提早点交"，定界靠静默
 *
 * HT（半满）和 TC（绕回）都不代表一帧结束，它们的价值是长帧时能更早把数据
 * 交上去，避免 256B 环被写穿。真正切帧由 `ud_poll()` 按静默时长判定。
 *
 * ## 为什么用 IDLE 定界，以及怎么安全地清 IDLE
 *
 * Modbus RTU 没有帧头、没有长度字段，一帧到哪结束只能靠**静默**判断
 * （规范：3.5 个字符时间）。USART 的 IDLE 中断就是硬件给的"线路静了"。
 *
 * ★ 但 IDLE 只当**提示**，不当**判据**：经 USB-CDC 桥（DAPLink）进来的数据
 *   会把 8 字节请求拆成两包，中间线路真的静过一下（实测 8ms 量级），
 *   IDLE 也真的置位，可帧还没完。所以 IDLE 里只做"把已收的搬到帧缓冲并
 *   收掉 RXNE 残字节"，切帧与否交给 ud_poll() 按 UD_FRAME_GAP_MS 判。
 *
 * 坑：清 IDLE 标志要求"先读 SR 再读 DR"，而 DMA 正在读同一个 DR。若此刻
 * RXNE=1，CPU 这一读会把 DMA 该收的字节抢走。所以本实现先关掉 DMA 请求
 * （CR3.DMAR=0），把 RXNE 里的残字节**自己收下**，再恢复 DMA —— 一个
 * 字节都不丢，代价是几微秒。
 *
 * ## TX 为什么是"软件乒乓"
 *
 * 发送是**一次性**的（发完就停），硬件不会替你切下一块，DBM 在这里更无从
 * 谈起。所以 TX 用两块内存 + 每次发完在完成回调里链式启动下一块：CPU 填
 * B 块时，DMA 正在发 A 块。tx_pingpong 计数就是"第二块真的被用上了"的证据。
  ******************************************************************************
  */

#include "main.h"
#include "usart.h"
#include "uart_dma.h"
#include <string.h>

extern DMA_HandleTypeDef hdma_usart1_rx;

/* ── RX：一个循环 DMA 缓冲（DMA 直接写这里，必须 4 字节对齐）────────── */
static uint8_t rx_buf[UD_RX_BUF] __attribute__((aligned(4)));
/*: 已经搬进帧缓冲的读指针（0..UD_RX_BUF-1）。DMA 写头、CPU 追尾。 */
static volatile uint16_t rx_tail;

/* ── 帧级双缓冲：DMA 块 → 一整帧（ISR 写一块，主循环取另一块）──────── */
static uint8_t frm_mem[2][UD_FRAME_MAX];
static volatile uint8_t frm_idx;          /* ISR 正在写的下标；待取 = frm_idx^1 */
static volatile uint16_t frm_len;         /* 当前帧已收字节 */
static volatile uint16_t frm_ready_len;   /* 待取帧长度 */
static volatile uint8_t frm_ready;        /* 1 = frm_idx^1 里有一整帧 */
static volatile uint32_t last_byte_tick;  /* 最近一个字节到达的 HAL tick */

/* ── TX：软件乒乓 ──────────────────────────────────────────────────── */
static uint8_t tx_mem[2][UD_TX_MAX];
static volatile uint16_t tx_len[2];
static volatile uint8_t tx_cur = 0xFF;    /* 正在被 DMA 发送的块（0xFF = 空闲）*/
static volatile uint8_t tx_queued = 0xFF; /* 已排队等发送的块 */

static ud_stats_t st;

/* ══════════════════════════════════════════════════════════════════
 *  帧缓冲（ISR 侧）
 * ══════════════════════════════════════════════════════════════════ */
static void frm_push(const uint8_t *p, uint16_t n)
{
    uint16_t i;

    if (n > 0u) {
        uint32_t now = HAL_GetTick();
        if (frm_len > 0u) {
            uint32_t gap = now - last_byte_tick;
            if (gap > st.max_gap_ms) {
                st.max_gap_ms = gap;    /* 一帧内部的字节间隔，诊断用 */
            }
        }
        last_byte_tick = now;
    }
    for (i = 0; i < n; i++) {
        if (frm_len < UD_FRAME_MAX) {
            frm_mem[frm_idx][frm_len++] = p[i];
        } else {
            /* 超长：只计数、不写（越界写会踩坏别的变量），整帧等 IDLE 丢掉 */
            st.rx_overrun++;
        }
    }
    st.rx_bytes += n;
}

/** 一帧结束：把当前写缓冲标记为"待取"，换另一块继续收。 */
static void frm_end(void)
{
    /* 收帧在主循环里做，但 frm_push 在 ISR 里跑 —— 这一段必须原子，否则
     * 正好在"翻缓冲"的中间来个字节，会写进刚被标成待取的那一块。 */
    __disable_irq();
    if (frm_len == 0) {
        __enable_irq();
        return;
    }
    if (frm_ready) {
        /* 主循环还没取走上一帧 —— 丢新的，不覆盖还没被读走的证据 */
        st.rx_drop++;
        frm_len = 0;
        __enable_irq();
        return;
    }
    st.last_frame_len = frm_len;
    frm_ready_len = frm_len;
    frm_idx ^= 1;                 /* 刚写完的那块 → 待取；新帧写另一块 */
    frm_len = 0;
    frm_ready = 1;
    __enable_irq();
}

/* ══════════════════════════════════════════════════════════════════
 *  RX：把 DMA 里"已经写进去但还没交出去"的段搬走
 * ══════════════════════════════════════════════════════════════════ */
/** 把环里 [rx_tail, pos) 这一段搬进帧缓冲。pos 由 NDTR 反推。
 *  一次搬两段（跨环尾时拆成两截），因为缓冲区是循环的。
 *
 *  ★ 必须**整体原子**：本函数会被三种上下文调用（主循环 ud_poll / DMA ISR /
 *    USART IDLE ISR）。ISR 之间同优先级互不抢占，但**主循环会被任意 ISR 打断**：
 *    主线程刚算完 pos、还没执行 rx_tail = pos，此刻来一次 HT/TC 中断，
 *    中断里用的是旧 rx_tail → 同一段字节被 push 两遍。
 *    实测症状：帧长被撑大 → rx_overrun 缓慢上涨（观测到 8）+ 偶发 CRC 错
 *    （从站按规范静默丢弃）→ 主站表现为"300 次里偶尔丢一帧，重试就好"。
 *    代价只是拷贝期间几十微秒的关中断（≤256B memcpy）。
 */
static void rx_drain(void)
{
    uint32_t primask = __get_PRIMASK();
    uint16_t pos, tail;

    __disable_irq();
    pos  = (uint16_t)(UD_RX_BUF - __HAL_DMA_GET_COUNTER(&hdma_usart1_rx));
    tail = rx_tail;

    if (pos == tail) {                       /* 没有新字节（99% 的调用走这里） */
        rx_tail = pos;
        __set_PRIMASK(primask);
        return;
    }
    if (pos > tail) {
        frm_push(&rx_buf[tail], (uint16_t)(pos - tail));
    } else {
        /* 绕回了：先搬尾巴，再搬头部 */
        frm_push(&rx_buf[tail], (uint16_t)(UD_RX_BUF - tail));
        if (pos > 0u) {
            frm_push(&rx_buf[0], pos);
        }
    }
    rx_tail = pos;
    __set_PRIMASK(primask);
}

void ud_rx_irq(void)
{
    /* HT：DMA 写过了缓冲的一半（前 128B）→ 搬一次，长帧时能早点交上去
     * TC：DMA 写满整个缓冲并绕回 0 → 搬一次，顺便清计数
     * 两个标志可能同时置位（搬得慢了），都处理，顺序无关：rx_drain 幂等。 */
    if (__HAL_DMA_GET_FLAG(&hdma_usart1_rx, DMA_FLAG_HTIF2_6)) {
        __HAL_DMA_CLEAR_FLAG(&hdma_usart1_rx, DMA_FLAG_HTIF2_6);
        st.rx_ht++;
        rx_drain();
    }
    if (__HAL_DMA_GET_FLAG(&hdma_usart1_rx, DMA_FLAG_TCIF2_6)) {
        __HAL_DMA_CLEAR_FLAG(&hdma_usart1_rx, DMA_FLAG_TCIF2_6);
        st.rx_tc++;
        rx_drain();
    }
    /* 错误标志自己清掉：不清的话 HAL_DMA_IRQHandler 会走错误分支把流停掉 */
    __HAL_DMA_CLEAR_FLAG(&hdma_usart1_rx,
                         DMA_FLAG_TEIF2_6 | DMA_FLAG_DMEIF2_6 | DMA_FLAG_FEIF2_6);
}

void ud_on_idle(void)
{
    uint16_t guard;

    /* ① 先暂停 DMA 请求：否则下面读 DR 会和 DMA 抢同一个字节 */
    CLEAR_BIT(huart1.Instance->CR3, USART_CR3_DMAR);

    /* ② 把 DMA 里已经收下的字节交出去（这一步不依赖 IDLE，先做） */
    rx_drain();

    /* ③ 读 SR 再读 DR = 清 IDLE；顺手把 RXNE 里的残字节收进帧缓冲 */
    (void)huart1.Instance->SR;
    (void)huart1.Instance->DR;
    guard = 0;
    while ((huart1.Instance->SR & USART_SR_RXNE) && guard < 8u) {
        uint8_t b = (uint8_t)(huart1.Instance->DR & 0xFFu);
        frm_push(&b, 1);
        guard++;
    }

    /* ④ 恢复 DMA 接收 */
    SET_BIT(huart1.Instance->CR3, USART_CR3_DMAR);

    st.rx_idle++;
    /* ★ 这里**不**收帧：IDLE 只说明"刚才静了一下"，不等于一帧完。
     *   收帧交给 ud_poll() 按静默时长判定（见 uart_dma.h 的说明）。 */
}

void ud_poll(void)
{
    /* ① 每圈把 DMA 新收的字节搬进帧缓冲。这一步是"零等待"的：读一个计数器、
     *    比一下指针，没新字节就直接返回（HT/TC 每 128B 才来一次，等它们
     *    搬会把 8 字节的短帧压到 11ms 之后才见到）。 */
    rx_drain();

    /* ② 有半帧、且线路已经静默够久 → 收帧。用 HAL_GetTick 而不是阻塞等待：
     *    主循环转一圈几微秒，这里只是读一个计数器。 */
    if (frm_len > 0u && (HAL_GetTick() - last_byte_tick) >= UD_FRAME_GAP_MS) {
        frm_end();
    }
}

/* ══════════════════════════════════════════════════════════════════
 *  TX：双缓冲 + 链式启动
 * ══════════════════════════════════════════════════════════════════ */
static void tx_start(uint8_t slot)
{
    if (HAL_UART_Transmit_DMA(&huart1, tx_mem[slot], tx_len[slot]) != HAL_OK) {
        /* 启动失败：把状态退回空闲，下一帧还能发（不要让状态机永久卡死） */
        tx_cur = 0xFF;
        st.tx_busy_drop++;
    }
}

int ud_tx_room(void)
{
    int room = 0;

    __disable_irq();
    if (tx_cur == 0xFF) {
        room = 2;
    } else if (tx_queued == 0xFF) {
        room = 1;
    }
    __enable_irq();
    return room;
}

int ud_tx(const uint8_t *data, uint16_t len)
{
    uint8_t slot;
    uint8_t start_now = 0;

    if (data == NULL || len == 0u || len > UD_TX_MAX) {
        return 0;
    }

    __disable_irq();
    if (tx_cur == 0xFF) {
        slot = 0u;                 /* 空闲：用 0 号块，立即发 */
        tx_cur = slot;
        start_now = 1u;
    } else if (tx_queued == 0xFF) {
        slot = (uint8_t)(tx_cur ^ 1u);   /* 另一块排队，等 TC 回调接力 */
        tx_queued = slot;
    } else {
        __enable_irq();
        st.tx_busy_drop++;
        return 0;                  /* 两块都占着：诚实地拒绝，不排队等 */
    }
    tx_len[slot] = len;
    __enable_irq();

    memcpy(tx_mem[slot], data, len);   /* slot 已独占，锁外拷贝 */
    if (start_now) {
        tx_start(slot);
    }
    return 1;
}

void ud_on_tx_complete(void)
{
    if (tx_cur != 0xFF) {
        st.tx_bytes += tx_len[tx_cur];
    }
    tx_cur = 0xFF;
    if (tx_queued != 0xFF) {
        uint8_t nxt = tx_queued;
        tx_queued = 0xFF;
        tx_cur = nxt;
        st.tx_pingpong++;          /* 每切换一次 +1：面板上能直接看到乒乓在跑 */
        tx_start(nxt);
    }
}

/* ══════════════════════════════════════════════════════════════════
 *  对外
 * ══════════════════════════════════════════════════════════════════ */
int ud_init(void)
{
    memset(&st, 0, sizeof(st));
    rx_tail = 0;
    frm_idx = 0;
    frm_len = 0;
    frm_ready = 0;

    /* 连续收必须 CIRCULAR：缓冲绕回起点继续写，DMA 永远不停。
     * .ioc 与 usart.c 已同步为 CIRCULAR，这里仍**再强制一次** —— 谁在 CubeMX 里
     * 手滑点回 NORMAL，重新生成的代码会把接收悄悄弄死（收满 256B 就停），
     * 而故障现象是"收一会儿就不动了"，极难定位。一行保险换一个不可能犯的错。 */
    hdma_usart1_rx.Init.Mode = DMA_CIRCULAR;
    if (HAL_DMA_Init(&hdma_usart1_rx) != HAL_OK) {
        return -1;
    }
    __HAL_DMA_CLEAR_FLAG(&hdma_usart1_rx,
                         DMA_FLAG_TCIF2_6 | DMA_FLAG_HTIF2_6 | DMA_FLAG_TEIF2_6 |
                         DMA_FLAG_DMEIF2_6 | DMA_FLAG_FEIF2_6);

    memset(rx_buf, 0, UD_RX_BUF);
    /* HAL_DMA_Start_IT = 启动 + **打开 HT/TC 中断**（这是与 DBM 路径最大的区别：
     * 那条路要手工 __HAL_DMA_ENABLE_IT，漏了就是"计数恒为 0、跑几次就丢帧"）。 */
    if (HAL_DMA_Start_IT(&hdma_usart1_rx,
                         (uint32_t)&huart1.Instance->DR,
                         (uint32_t)rx_buf,
                         UD_RX_BUF) != HAL_OK) {
        return -2;
    }

    /* 让 USART 把每个收到的字节直接"DMA 出去"（不经过 CPU 中断） */
    SET_BIT(huart1.Instance->CR3, USART_CR3_DMAR);
    __HAL_UART_CLEAR_IDLEFLAG(&huart1);
    __HAL_UART_ENABLE_IT(&huart1, UART_IT_IDLE);
    return 0;
}

uint16_t ud_frame_get(uint8_t *out, uint16_t maxlen)
{
    uint16_t len;

    if (out == NULL || maxlen == 0u) {
        return 0;
    }
    /* 拷贝期间关中断：否则 ISR 可能正好把"待取"那块翻成写缓冲 */
    __disable_irq();
    if (!frm_ready) {
        __enable_irq();
        return 0;
    }
    len = frm_ready_len;
    if (len > maxlen) {
        len = maxlen;              /* 截断（正常不会发生：调用方给 256） */
    }
    memcpy(out, frm_mem[frm_idx ^ 1u], len);
    frm_ready = 0;
    frm_len = 0;
    __enable_irq();
    return len;
}

const ud_stats_t *ud_stats(void)
{
    return &st;
}
