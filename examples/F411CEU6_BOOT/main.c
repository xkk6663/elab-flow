/**
 * @file    main.c
 * @brief   F411 Bootloader —— 薄入口（方案 §3.5 裁决：业务工程只剩十余行）
 *
 * 全部升级流程在 components/ota 的场景层 OtaBootFlow_Run：
 *   CheckState（打印 === Bootloader Start === / 按 state 分支）
 *   → ProcessRX（协议解帧 → 写 Flash → ACK）
 *
 * 组件接线（M1）：
 *   serial 组件  → Transport_USART1（DMA2_Stream2 循环收 + 轮询发）
 *   ota 组件     → OtaBootFlow_*（boot 变体；依赖 serial 自动递归接入）
 *   ota_cap      → OtaCap_AutoInit()：应答 CMD_QUERY_COMPONENTS(0x15)，
 *                  位图来自 CMake 下传的 OTA_CAP_BITMAP（ota+serial = 0x3）
 */

#include "stm32f4xx_hal.h"
#include "ota_transport.h"
#include "ota_boot_flow.h"
#include "ota_cap.h"
#include "serial_usart1_dma.h"

/* ── 时钟：与 APP 逐段一致（HSI→PLL 100MHz），保证波特率与跳转后一致 ── */
static void SystemClock_Config(void)
{
    RCC_OscInitTypeDef RCC_OscInitStruct = {0};
    RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

    __HAL_RCC_PWR_CLK_ENABLE();
    __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);

    RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
    RCC_OscInitStruct.HSIState = RCC_HSI_ON;
    RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
    RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
    RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSI;
    RCC_OscInitStruct.PLL.PLLM = 8;
    RCC_OscInitStruct.PLL.PLLN = 100;
    RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV2;
    RCC_OscInitStruct.PLL.PLLQ = 4;
    if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK) {
        Error_Handler();
    }

    RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK
                                | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
    RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
    RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV2;
    RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;
    if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_3) != HAL_OK) {
        Error_Handler();
    }
}

void Error_Handler(void)
{
    __disable_irq();
    while (1) {
        /* BOOT 事故停机（可观测：断点/调试器查看） */
    }
}

/* ── SysTick：HAL 时基（APP 用 FreeRTOS 接管，BOOT 裸机自管）────────
 * ★ 无此 Handler 时首个 SysTick 中断会落进 startup 的弱 Default_Handler
 *   死循环（实测：PC=0x08000780，串口 0 字节）*/
void SysTick_Handler(void)
{
    HAL_IncTick();
}

/* ── 最小堆桥（newlib printf 内部 malloc 需要 _sbrk；BOOT 无动态内存业务）── */
#include <sys/reent.h>
extern char _end;                       /* ld: PROVIDE(end/_end) */
extern char _estack;                    /* ld: 栈顶 */
void *_sbrk(ptrdiff_t incr)
{
    static char *heap_end = 0;
    if (heap_end == 0) { heap_end = &_end; }
    char *prev = heap_end;
    if (heap_end + incr > &_estack) { return (void *)-1; }  /* 越栈判失败 */
    heap_end += incr;
    return (void *)prev;
}

int main(void)
{
    HAL_Init();
    SystemClock_Config();

    Transport_Attach(&Transport_USART1);   /* serial 组件：挂 Transport 实例 */
    Transport_Init();                      /* ★ 实际执行 GPIO+USART1+DMA 初始化 */
    (void)OtaCap_AutoInit();               /* v1.2 组件发现应答（位图 = OTA_CAP_BITMAP） */

    OtaBootFlow_Init();
    OtaBootFlow_CheckState();

    /* 主循环：收包 + elab 约定存活心跳（^\[(boot|alive)\]，纯可观测性，不动协议时序）
     * ★ f411 实测坑：停等协议（PC 发一帧→等 ACK）下每帧处理完缓冲必空，
     *   任何无条件/判空式 HAL_Delay(1000) 都会把吞吐钉死在 1 帧/秒（37KB≈5分钟）。
     *   改为 HAL_GetTick 节拍：1s 最多一条心跳，且仅空闲时打印，绝不阻塞收包。 */
    uint32_t tick = 0;
    uint32_t last_hb = 0;
    while (1) {
        OtaBootFlow_ProcessRX();
        if (g_Transport->available() == 0 &&
            HAL_GetTick() - last_hb >= 1000) {
            printf("[alive] boot tick=%lu\r\n", (unsigned long)tick++);
            last_hb = HAL_GetTick();
        }
    }

    return 0;   /* 不可达 */
}
