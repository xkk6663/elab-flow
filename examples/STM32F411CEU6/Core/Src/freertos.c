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
#include <string.h>         /* strncmp / memcmp —— echo 任务里仅头部比较 */
/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */
/* elab 串口波形演示：以 FireWater 文本协议输出双通道正弦值（实现见文件末尾）。
   CH1 = 基准正弦，CH2 = 延迟半个周期（相位 -π，与 CH1 反相）。 */
static void wave_emit_sine2(float v1, float v2);

/* elab echo 任务：从 USART1 IRQ 喂入的环形缓冲消费 RX 字节，按 \r\n 切帧，
   识别 PING / STATS? / ECHO_ENABLE 命令并回显；用于双向吞吐与 RTT 压测。
   栈仅 512 B —— 同 myUSART 任务压过栈爆坑，故只用 fputc 逐字节发，不走 printf */
extern void echo_ring_push(uint8_t c);
extern uint8_t echo_ring_pull(void);
static void echo_emit(const char *s);   /* fputc 小包装，同 wave_emit_sine2 策略 */
static void StartTask03_Echo(void *argument);
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
  /* creation of echoTask —— elab 串口压测 / 双向回显任务
     栈 512 B（同 myUSART，不走 printf；fputc 逐字节安全），
     priority Normal：与 myUSART 同级，按时间片轮换，避免波形 100Hz 持续输出
     把 echo 任务饿死导致 PING 丢包（修复前 BelowNormal 丢包 ~9%） */
  osThreadId_t echoTaskHandle;
  const osThreadAttr_t echoTask_attributes = {
    .name = "echoTask",
    .stack_size = 128 * 4,
    .priority = (osPriority_t) osPriorityNormal,
  };
  echoTaskHandle = osThreadNew(StartTask03_Echo, NULL, &echoTask_attributes);
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

    /* elab 波形演示：100 Hz 采样、0.5 Hz 正弦（FireWater 协议 "a,b\r\n"）。
       CH1 基准、CH2 延迟半个周期（相位 -π = 反相）——面板「串口 → 波形」
       选 FireWater 即可看到两条反相曲线；[alive] 行由 defaultTask 每秒发一次。 */
    {
      static float wave_phase = 0.0f;
      wave_phase += 0.0314159f;                 /* 2π × 0.5 Hz / 100 Hz */
      if (wave_phase >= 6.283185f) wave_phase -= 6.283185f;
      wave_emit_sine2(sinf(wave_phase), sinf(wave_phase - 3.1415927f));
    }

    osDelay(10);
  }
  /* USER CODE END StartTask02 */
}

/* Private application code --------------------------------------------------*/
/* USER CODE BEGIN Application */
/* ── echo 任务辅助（小缓冲逐字节，不走 printf） ── */
static void echo_emit(const char *s) {
  while (*s) fputc((unsigned char)*s++, stdout);
}
static void echo_emit_u32(uint32_t n) {
  char buf[12]; int i = 0;
  if (n == 0) { buf[i++] = '0'; }
  while (n) { buf[i++] = (char)('0' + n % 10U); n /= 10U; }
  while (i) fputc((unsigned char)buf[--i], stdout);
}

/* StartTask03_Echo —— USART1 RX 消费 + PING/STATS 回显（双向压测固件端）
   帧格式：\r\n 分隔；命令帧开头 = PING: / STATS? / ECHO_ENABLE 0|1
   自上报：每 50 次 echo 输出 [echo] total=N bytes=N 一行 */
static void StartTask03_Echo(void *argument)
{
  char  frame[64];        /* 当前帧（不存 \r\n，零尾部当作"无内容"丢弃） */
  int   fn = 0;           /* 帧内字符数 */
  uint32_t total_echo = 0, total_bytes = 0, report_div = 0;
  uint32_t echo_on = 1;   /* 可被 ECHO_ENABLE 关 */
  uint8_t  c;

  for (;;) {
    while ((c = echo_ring_pull()) != 0) {   /* 0 = 空（未接收到），合法数据 > 0 */
      if (c == '\r' || c == '\n') {
        if (fn == 0) { continue; }          /* 空行丢掉（echo_ring 满时可能残留零头） */
        frame[fn] = '\0';

        /* ── 命令识别 ── */
        if (echo_on && fn >= 5 && strncmp(frame, "PING:", 5) == 0) {
          echo_emit("PONG:");
          echo_emit(frame + 5);             /* payload 原样（不含 PING: 前缀） */
          fputc('\r', stdout); fputc('\n', stdout);
          total_echo++; total_bytes += (uint32_t)fn;
          report_div++;
        } else if (echo_on && fn >= 5 && strncmp(frame, "PONG:", 5) == 0) {
          /* 自己发出的回显又被 echo 回显了 —— 必须忽略，否则无限递归 */
        } else if (fn == 6 && strncmp(frame, "STATS?", 6) == 0) {
          echo_emit("[echo] total="); echo_emit_u32(total_echo);
          echo_emit(" bytes=");       echo_emit_u32(total_bytes);
          echo_emit(" enable=");      echo_emit_u32(echo_on);
          fputc('\r', stdout); fputc('\n', stdout);
        } else if (fn >= 12 && strncmp(frame, "ECHO_ENABLE ", 12) == 0) {
          uint32_t v = (uint32_t)(frame[12] - '0');
          echo_on = (v == 1) ? 1U : 0U;
          echo_emit("[echo] enable="); echo_emit_u32(echo_on);
          fputc('\r', stdout); fputc('\n', stdout);
        }

        /* ── 自上报（每 50 次 echo） ── */
        if (report_div >= 50U) {
          report_div = 0U;
          echo_emit("[echo] total="); echo_emit_u32(total_echo);
          echo_emit(" bytes=");       echo_emit_u32(total_bytes);
          fputc('\r', stdout); fputc('\n', stdout);
        }
        fn = 0;
      } else if (fn < 63) {
        frame[fn++] = (char)c;
      }
      /* fn == 63 满时静默丢整帧 —— echo 命令帧不可能那么长，极端防御 */
    }
    /* ring 空了，释放 CPU 给波形输出 & 心跳，1ms 后再拉 */
    osDelay(1);
  }
}

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
  * @brief elab 串口波形演示：把两个 [-1,1] 的浮点值按 FireWater 协议打成一行
  *        （``0.707,-0.707\r\n``），逗号分隔 = 两个通道。
  *        ★ 不用 printf：myUSART 任务栈只有 512 B，newlib 的 printf 会把这栈
  *          压爆（实测 2026-11-01：100 Hz 输出跑几秒后 HardFault）。这里用
  *          24 B 小缓冲 + fputc 逐字节发；fputc 自带互斥，与 defaultTask 的
  *          ``[alive]`` 打印安全交错。整数值用毫单位拼装 —— newlib-nano 未开
  *          ``-u _printf_float``，``%f`` 也打不出小数。
  */
static void wave_emit_sine2(float v1, float v2)
{
  char buf[24];
  int n = 0;
  for (int ch = 0; ch < 2; ch++) {
    int milli = (int)((ch == 0 ? v1 : v2) * 1000.0f);  /* [-1000, 1000] */
    uint32_t mag = (uint32_t)(milli < 0 ? -milli : milli);
    if (ch == 1) buf[n++] = ',';                       /* 通道分隔 */
    if (milli < 0) buf[n++] = '-';
    buf[n++] = (char)('0' + (mag / 1000u) % 10u);      /* 整数位（0 或 1） */
    buf[n++] = '.';
    buf[n++] = (char)('0' + (mag / 100u) % 10u);
    buf[n++] = (char)('0' + (mag / 10u) % 10u);
    buf[n++] = (char)('0' + mag % 10u);
  }
  buf[n++] = '\r';
  buf[n++] = '\n';
  for (int i = 0; i < n; i++) {
    fputc(buf[i], stdout);
  }
}
/* USER CODE END Application */

