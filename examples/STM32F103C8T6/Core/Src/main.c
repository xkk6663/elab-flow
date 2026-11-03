/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Main program body
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2025 STMicroelectronics.
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
#include "main.h"
#include "dma.h"
#include "usart.h"
#include "gpio.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include <stdio.h>
#include <string.h>
#include <assert.h>
#include "usart.h"
/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */
/* 心跳与 LED 同源：500ms 节拍翻转 LED，每 2 次翻转打一条 1Hz 心跳 */
#define LED_HALF_PERIOD_MS 500u
/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/

/* USER CODE BEGIN PV */
/* ── 初始化阶段标记（串口就绪前无法打印，失败时由 Error_Handler 说明）── */
static const char *g_stage = "HAL_Init";
static int g_uart_ready = 0;

/* ── 串口命令接收（中断逐字节收，主循环解析并回显）──────────────── */
static volatile uint8_t g_rx_byte = 0;
static volatile uint32_t g_rx_bytes = 0;
static volatile uint32_t g_cmds = 0;
static volatile uint32_t g_tick = 0;
static volatile uint32_t g_led_toggles = 0;

static char g_cmd_buf[64];
static volatile size_t g_cmd_len = 0;
static char g_ready_line[64];
static volatile int g_cmd_ready = 0;
/* USER CODE END PV */

/* Private function prototypes -----------------------------------------------*/
void SystemClock_Config(void);
/* USER CODE BEGIN PFP */

/* USER CODE END PFP */

/* Private user code ---------------------------------------------------------*/
/* USER CODE BEGIN 0 */
/**
 * @brief newlib printf 重定向：syscalls.c 里 __io_putchar 只有 weak 声明，
 *        必须在这里给出强定义，否则 printf 会调到地址 0。
 */
int __io_putchar(int ch)
{
  uint8_t byte = (uint8_t)ch;
  (void)HAL_UART_Transmit(&huart1, &byte, 1, 10);
  return ch;
}

static void handle_line(char *line)
{
  size_t n = strlen(line);
  while (n > 0 && (line[n - 1] == '\r' || line[n - 1] == ' ' || line[n - 1] == '\t'))
  {
    line[--n] = '\0';
  }
  while (*line == ' ' || *line == '\t')
  {
    line++;
  }
  if (*line == '\0')
  {
    return;
  }

  g_cmds++;
  if (strcmp(line, "PING") == 0)
  {
    printf("[cmd] PING -> PONG (cmds=%lu)\r\n", (unsigned long)g_cmds);
  }
  else if (strcmp(line, "STAT") == 0)
  {
    printf("[cmd] STAT stage=%s tick=%lu cmds=%lu rx=%luB led_toggles=%lu uptime=%lums\r\n",
           g_stage,
           (unsigned long)g_tick,
           (unsigned long)g_cmds,
           (unsigned long)g_rx_bytes,
           (unsigned long)g_led_toggles,
           (unsigned long)HAL_GetTick());
  }
  else if (strncmp(line, "ECHO ", 5) == 0)
  {
    printf("[cmd] ECHO -> %s\r\n", line + 5);
  }
  else
  {
    printf("[cmd] unknown: %s\r\n", line);
  }
}
/* USER CODE END 0 */

/**
  * @brief  The application entry point.
  * @retval int
  */
int main(void)
{

  /* USER CODE BEGIN 1 */
  g_stage = "HAL_Init";
  /* USER CODE END 1 */

  /* MCU Configuration--------------------------------------------------------*/

  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
  HAL_Init();

  /* USER CODE BEGIN Init */
  g_stage = "SystemClock_Config";
  /* USER CODE END Init */

  /* Configure the system clock */
  SystemClock_Config();

  /* USER CODE BEGIN SysInit */
  g_stage = "peripherals_init";
  /* USER CODE END SysInit */

  /* Initialize all configured peripherals */
  MX_GPIO_Init();
  MX_DMA_Init();
  MX_USART1_UART_Init();
  /* USER CODE BEGIN 2 */
  // PC13 板载 LED 为低电平点亮：初始化写高 = 熄灭，随后 1Hz 翻转
  HAL_GPIO_WritePin(LED_GPIO_Port, LED_Pin, GPIO_PIN_SET);

  /* 串口已就绪：逐条打印外设初始化结果，便于只看串口定位运行阶段 */
  g_uart_ready = 1;
  printf("\r\n[log] ---- init log begin ----\r\n");
  printf("[log] HAL init  : ok\r\n");
  printf("[log] clock     : ok (SYSCLK=%lu Hz, HCLK=%lu Hz, PCLK2=%lu Hz)\r\n",
         (unsigned long)SystemCoreClock,
         (unsigned long)HAL_RCC_GetHCLKFreq(),
         (unsigned long)HAL_RCC_GetPCLK2Freq());
  printf("[log] GPIO      : ok (LED=PC13 active-low, KEY1..4=PA0..3)\r\n");
  printf("[log] DMA       : ok (USART1 RX=DMA1_Ch5, TX=DMA1_Ch4)\r\n");
  printf("[log] UART1     : ok (115200 8N1, TX=PA9, RX=PA10, IRQ=on)\r\n");

  /* 逐字节中断接收：配合 HAL_UART_RxCpltCallback 做命令回显 */
  HAL_UART_Receive_IT(&huart1, (uint8_t *)&g_rx_byte, 1);

  g_stage = "main_loop";
  printf("[log] main loop : enter (PING/STAT/ECHO + 1s heartbeat + LED 1Hz)\r\n");
  /* USER CODE END 2 */

  /* Infinite loop */
  /* USER CODE BEGIN WHILE */
  uint32_t last_tick = 0;
  while (1)
  {
    /* USER CODE END WHILE */

    /* USER CODE BEGIN 3 */
    if (g_cmd_ready)
    {
      g_cmd_ready = 0;
      handle_line(g_ready_line);
    }

    /*
     * 同一个 500ms 时基同时驱动 LED 与心跳：
     *   每次节拍翻转 LED（亮灭周期 1s）；
     *   每 2 次节拍打一条 [alive]（1Hz），所以心跳与 LED 严格同频。
     * 串口是事实源（tick / toggles 可核对），LED 是板上肉眼确认。
     */
    if (HAL_GetTick() - last_tick >= LED_HALF_PERIOD_MS)
    {
      HAL_GPIO_TogglePin(LED_GPIO_Port, LED_Pin);
      g_led_toggles++;

      if ((g_led_toggles & 1u) == 0u)     /* 每 2 次翻转 = 1s = 一次心跳 */
      {
        printf("[alive] test tick=%lu cmds=%lu led=1Hz toggles=%lu stage=%s\r\n",
               (unsigned long)g_tick,
               (unsigned long)g_cmds,
               (unsigned long)g_led_toggles,
               g_stage);
        g_tick++;
      }

      last_tick += LED_HALF_PERIOD_MS;
      if (HAL_GetTick() - last_tick >= LED_HALF_PERIOD_MS)
      {
        last_tick = HAL_GetTick();   /* 长阻塞后重新对齐，不补闪、不补心跳 */
      }
    }
  }
  /* USER CODE END 3 */
}

/**
  * @brief System Clock Configuration
  * @retval None
  */
void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  /** Initializes the RCC Oscillators according to the specified parameters
  * in the RCC_OscInitTypeDef structure.
  */
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSE;
  RCC_OscInitStruct.HSEState = RCC_HSE_ON;
  RCC_OscInitStruct.HSEPredivValue = RCC_HSE_PREDIV_DIV1;
  RCC_OscInitStruct.HSIState = RCC_HSI_ON;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSE;
  RCC_OscInitStruct.PLL.PLLMUL = RCC_PLL_MUL9;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  /** Initializes the CPU, AHB and APB buses clocks
  */
  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK
                              |RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV2;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_2) != HAL_OK)
  {
    Error_Handler();
  }
}

/* USER CODE BEGIN 4 */
/**
 * @brief 逐字节接收完成：缓存到行缓冲，整行交给主循环解析（不在中断里 printf）。
 */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance != USART1)
  {
    return;
  }

  uint8_t ch = g_rx_byte;
  g_rx_bytes++;
  if (ch == '\r' || ch == '\n')
  {
    if (g_cmd_len > 0 && !g_cmd_ready)
    {
      memcpy(g_ready_line, g_cmd_buf, g_cmd_len);
      g_ready_line[g_cmd_len] = '\0';
      g_cmd_ready = 1;
    }
    g_cmd_len = 0;
  }
  else if (ch >= 0x20 && ch < 0x7F)
  {
    if (g_cmd_len < sizeof(g_cmd_buf) - 1)
    {
      g_cmd_buf[g_cmd_len++] = (char)ch;
    }
    else
    {
      g_cmd_len = 0;    /* 超长帧丢弃 */
    }
  }

  (void)HAL_UART_Receive_IT(&huart1, (uint8_t *)&g_rx_byte, 1);
}

/** 溢出/噪声错误后重新挂接收，避免串口静默失联。 */
void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART1)
  {
    (void)HAL_UART_Receive_IT(&huart1, (uint8_t *)&g_rx_byte, 1);
  }
}
/* USER CODE END 4 */

/**
  * @brief  This function is executed in case of error occurrence.
  * @retval None
  */
void Error_Handler(void)
{
  /* USER CODE BEGIN Error_Handler_Debug */
  /* 串口已就绪时先打失败阶段，再停机（便于只看日志定位） */
  if (g_uart_ready)
  {
    printf("\r\n[log] FATAL: init failed at %s, halted\r\n", g_stage);
  }
  __disable_irq();
  while (1)
  {
  }
  /* USER CODE END Error_Handler_Debug */
}
#ifdef USE_FULL_ASSERT
/**
  * @brief  Reports the name of the source file and the source line number
  *         where the assert_param error has occurred.
  * @param  file: pointer to the source file name
  * @param  line: assert_param error line source number
  * @retval None
  */
void assert_failed(uint8_t *file, uint32_t line)
{
  /* USER CODE BEGIN 6 */
  /* User can add his own implementation to report the file name and line number,
     ex: printf("Wrong parameters value: file %s on line %d\r\n", file, line) */
  /* USER CODE END 6 */
}
#endif /* USE_FULL_ASSERT */
