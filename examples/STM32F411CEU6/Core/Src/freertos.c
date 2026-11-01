/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * File Name          : freertos.c
  * Description        : Code for freertos applications
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2026 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */

/* Includes ------------------------------------------------------------------*/
#include "FreeRTOS.h"
#include "task.h"
#include "main.h"
#include "cmsis_os.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include "ota_app_hook.h"   /* OTA 触发消费（elab components/ota）*/
#include "ota_confirm.h"    /* ★ 双槽试运行确认（单槽芯片=空操作） */
#include "stdio.h"
#include "main.h"
#include "usart.h"
#include "KEY.h"
#include "math.h"           /* elab 波形演示：sinf 产生正弦（FireWater 输出） */

/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */
/* elab 串口波形演示：以 FireWater 文本协议输出单通道正弦值（实现见文件末尾） */
static void wave_emit_sine(float v);

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */

/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/
/* USER CODE BEGIN Variables */

/* USER CODE END Variables */
/* Definitions for defaultTask */
osThreadId_t defaultTaskHandle;
const osThreadAttr_t defaultTask_attributes = {
  .name = "defaultTask",
  .stack_size = 128 * 4,
  .priority = (osPriority_t) osPriorityNormal,
};
/* Definitions for myUSART */
osThreadId_t myUSARTHandle;
const osThreadAttr_t myUSART_attributes = {
  .name = "myUSART",
  .stack_size = 128 * 4,
  .priority = (osPriority_t) osPriorityNormal,
};
/* Definitions for myQueue01 */
osMessageQueueId_t myQueue01Handle;
const osMessageQueueAttr_t myQueue01_attributes = {
  .name = "myQueue01"
};
/* Definitions for myUASRT */
osMutexId_t myUASRTHandle;
const osMutexAttr_t myUASRT_attributes = {
  .name = "myUASRT"
};

/* Private function prototypes -----------------------------------------------*/
/* USER CODE BEGIN FunctionPrototypes */
extern osMutexId_t myUASRTHandle;

/* USER CODE END FunctionPrototypes */

void StartDefaultTask(void *argument);
void StartTask02(void *argument);

void MX_FREERTOS_Init(void); /* (MISRA C 2004 rule 8.1) */

/**
  * @brief  FreeRTOS initialization
  * @param  None
  * @retval None
  */
void MX_FREERTOS_Init(void) {
  /* USER CODE BEGIN Init */

  /* USER CODE END Init */
  /* Create the mutex(es) */
  /* creation of myUASRT */
  myUASRTHandle = osMutexNew(&myUASRT_attributes);

  /* USER CODE BEGIN RTOS_MUTEX */
  /* add mutexes, ... */
  /* USER CODE END RTOS_MUTEX */

  /* USER CODE BEGIN RTOS_SEMAPHORES */
  /* add semaphores, ... */
  /* USER CODE END RTOS_SEMAPHORES */

  /* USER CODE BEGIN RTOS_TIMERS */
  /* start timers, add new ones, ... */
  /* USER CODE END RTOS_TIMERS */

  /* Create the queue(s) */
  /* creation of myQueue01 */
  myQueue01Handle = osMessageQueueNew (16, sizeof(uint16_t), &myQueue01_attributes);

  /* USER CODE BEGIN RTOS_QUEUES */
  /* add queues, ... */
  /* USER CODE END RTOS_QUEUES */

  /* Create the thread(s) */
  /* creation of defaultTask */
  defaultTaskHandle = osThreadNew(StartDefaultTask, NULL, &defaultTask_attributes);

  /* creation of myUSART */
  myUSARTHandle = osThreadNew(StartTask02, NULL, &myUSART_attributes);

  /* USER CODE BEGIN RTOS_THREADS */
  /* add threads, ... */
  /* USER CODE END RTOS_THREADS */

  /* USER CODE BEGIN RTOS_EVENTS */
  /* add events, ... */
  /* USER CODE END RTOS_EVENTS */

}

/* USER CODE BEGIN Header_StartDefaultTask */
/**
  * @brief  Function implementing the defaultTask thread.
  * @param  argument: Not used
  * @retval None
  */
/* USER CODE END Header_StartDefaultTask */
void StartDefaultTask(void *argument)
{
  /* USER CODE BEGIN StartDefaultTask */
  uint32_t alive_ticks = 0;
  /* Infinite loop */
  for(;;)
  {
    /* OTA 触发标志消费：'!'×5 → 业务停机回调(未注册=空) → READY → 2s → 复位 */
    OtaAppHook_HandleTrigger();

	HAL_GPIO_TogglePin(LED_GPIO_Port, LED_Pin);
	//printf("LEDTogglePin\r\n");
	/* elab monitor 存活判据：^\[(boot|alive)\]（projects/f411.yaml monitor.close_on） */
	printf("[alive] tick=%lu\r\n", (unsigned long)HAL_GetTick());
    /* ★ 双槽回滚方案 §4.3：心跳第 3 次成立 = 自检通过 → 确认试运行
       （与 monitor 闭环判据同源；单槽芯片 OTA_Confirm 为空操作） */
    if (++alive_ticks == 3) {
        OTA_Confirm();
    }
    osDelay(1000);
  }
  /* USER CODE END StartDefaultTask */
}

/* USER CODE BEGIN Header_StartTask02 */
/**
* @brief Function implementing the myUSART thread.
* @param argument: Not used
* @retval None
*/
/* USER CODE END Header_StartTask02 */
void StartTask02(void *argument)
{
  /* USER CODE BEGIN StartTask02 */
  uint16_t key_value;

  /* Infinite loop */
  for(;;)
  {
    key_scan();
    if (osMessageQueueGet(myQueue01Handle, &key_value, NULL, 0) == osOK)
  {
      printf("KEY:%u\r\n", key_value);
  }

    /* elab 波形演示：100 Hz 采样、0.5 Hz 正弦（FireWater 协议 "amp\r\n"）。
       面板「串口 → 波形」选 FireWater 即可看到曲线；[alive] 行由 defaultTask 每秒发一次。 */
    {
      static float wave_phase = 0.0f;
      wave_phase += 0.0314159f;                 /* 2π × 0.5 Hz / 100 Hz */
      if (wave_phase >= 6.283185f) wave_phase -= 6.283185f;
      wave_emit_sine(sinf(wave_phase));
    }

    osDelay(10);
  }
  /* USER CODE END StartTask02 */
}

/* Private application code --------------------------------------------------*/
/* USER CODE BEGIN Application */
int fputc(int ch, FILE *stream)
{
  osMutexAcquire(myUASRTHandle,portMAX_DELAY);
  static uint8_t buf;
  buf = (uint8_t)ch;
  while(HAL_UART_GetState(&huart1) != HAL_UART_STATE_READY);
  HAL_UART_Transmit_DMA(&huart1, &buf, 1);
  osMutexRelease(myUASRTHandle);
  return ch;
}

/**
  * @brief newlib retarget：printf → _write()（syscalls.c）→ __io_putchar。
  *        ★ syscalls.c 里 __io_putchar 只有 weak 声明，无定义时 _write 会调到
  *          地址 0（跳飞/HardFault）。这里带函数体定义并复用上方 fputc 的
  *          DMA 通道 + 互斥锁，与本工程已有串口输出走同一条路。
  *        ★ elab adapt 探测「有输出能力」依据的正是本定义 + printf 调用。
  */
int __io_putchar(int ch)
{
  fputc(ch, stdout);
  return ch;
}

/**
  * @brief elab 串口波形演示：把 [-1,1] 的浮点值按 FireWater 协议打成一行
  *        （``0.707\r\n``）。
  *        ★ 不用 printf：myUSART 任务栈只有 512 B，newlib 的 printf 会把这栈
  *          压爆（实测 2026-11-01：100 Hz 输出跑几秒后 HardFault）。这里用
  *          16 B 小缓冲 + fputc 逐字节发；fputc 自带互斥，与 defaultTask 的
  *          ``[alive]`` 打印安全交错。整数值用毫单位拼装 —— newlib-nano 未开
  *          ``-u _printf_float``，``%f`` 也打不出小数。
  */
static void wave_emit_sine(float v)
{
  int milli = (int)(v * 1000.0f);                  /* [-1000, 1000] */
  uint32_t mag = (uint32_t)(milli < 0 ? -milli : milli);
  char buf[16];
  int n = 0;
  if (milli < 0) buf[n++] = '-';
  buf[n++] = (char)('0' + (mag / 1000u) % 10u);    /* 整数位（0 或 1） */
  buf[n++] = '.';
  buf[n++] = (char)('0' + (mag / 100u) % 10u);
  buf[n++] = (char)('0' + (mag / 10u) % 10u);
  buf[n++] = (char)('0' + mag % 10u);
  buf[n++] = '\r';
  buf[n++] = '\n';
  for (int i = 0; i < n; i++) {
    fputc(buf[i], stdout);
  }
}
/* USER CODE END Application */

