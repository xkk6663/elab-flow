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
/* 帧协议演示节拍：每 100ms 依次发三帧（位域 / 变长 / 多 ID） */
#define FRAME_PERIOD_MS 100u
/* 演示 4｜"未知协议"突发：给 Agent 自学习用。LEARN 命令触发一段
 * 只发单一私有协议的窗口（其它帧暂停），让抓到的字节里没有第二种协议。 */
#define LEARN_PERIOD_MS 50u
#define LEARN_FRAMES 200u
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

/* ── 串口帧协议演示（P0：位域 / 变长 / 多 ID）────────────────── */
static uint32_t g_frame_seq = 0;
static uint32_t g_last_frame = 0;

/* ── 演示 4：私有协议突发（Agent 自学习样本源）──────────────── */
static volatile uint32_t g_learn_left = 0;      /* 剩余待发帧数（0 = 不在突发） */
static uint32_t g_learn_last = 0;
static uint32_t g_learn_seq = 0;
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

static void uart_send_raw(const uint8_t *buf, size_t len)
{
  (void)HAL_UART_Transmit(&huart1, (uint8_t *)buf, (uint16_t)len, 20);
}

static uint16_t crc16_modbus(const uint8_t *buf, size_t len)
{
  uint16_t crc = 0xFFFFu;
  for (size_t i = 0; i < len; i++)
  {
    crc ^= buf[i];
    for (int b = 0; b < 8; b++)
    {
      crc = (crc & 1u) ? (uint16_t)((crc >> 1) ^ 0xA001u) : (uint16_t)(crc >> 1);
    }
  }
  return crc;
}

/*
 * 演示 1｜位域：AA55 头 + u16 转速 + i16 温度 + mode + flags(bit0..2) + u16 电压
 * 布局与 templates/frames/telemetry_u16.json 完全一致（14 字节，CRC16 + 0D0A 尾）。
 */
static void send_frame_telemetry(uint32_t seq)
{
  uint8_t f[14];
  uint16_t rpm = (uint16_t)(1000u + (seq * 7u) % 400u);
  int16_t temp = (int16_t)(250u + (seq * 3u) % 100u);   /* 25.0 .. 34.9 C */
  uint16_t bat = (uint16_t)(1234u - (seq % 50u));       /* 12.34 .. 11.85 V */
  uint16_t crc;

  f[0] = 0xAA; f[1] = 0x55;
  f[2] = (uint8_t)(rpm & 0xFFu); f[3] = (uint8_t)(rpm >> 8);
  f[4] = (uint8_t)((uint16_t)temp & 0xFFu); f[5] = (uint8_t)((uint16_t)temp >> 8);
  f[6] = 1;      /* mode = RUN */
  f[7] = 1;      /* flags 位域 = READY（bit0..2） */
  f[8] = (uint8_t)(bat & 0xFFu); f[9] = (uint8_t)(bat >> 8);
  crc = crc16_modbus(f, 10);
  f[10] = (uint8_t)(crc & 0xFFu); f[11] = (uint8_t)(crc >> 8);
  f[12] = 0x0D; f[13] = 0x0A;
  uart_send_raw(f, sizeof(f));
}

/*
 * 演示 2｜变长：FE 头 + 帧内长度字段（offset1）+ msgid（offset5）
 * 总长 = len + 8（布局与 templates/frames/mavlink_v1.json 一致）。
 */
static void send_frame_mavlink(uint32_t seq)
{
  uint8_t f[10];
  f[0] = 0xFE;
  f[1] = 2;      /* payload 字节数 */
  f[2] = 1;      /* type */
  f[3] = 1;      /* sysid */
  f[4] = 1;      /* compid */
  f[5] = 30;     /* msgid */
  f[6] = (uint8_t)(seq & 0xFFu);
  f[7] = (uint8_t)((seq >> 8) & 0xFFu);
  f[8] = 0; f[9] = 0;   /* CRC 占位（模板 checksum=none，不校验） */
  uart_send_raw(f, sizeof(f));
}

/*
 * 演示 3｜多 ID：7E7E 头 + id + 4 字节负载（固定 7 字节）
 * id=1 → speed/aux；id=2 → temp/hum。同一 profile 用 variants 分发字段。
 */
static void send_frame_multi(uint32_t seq)
{
  uint8_t f[7];
  f[0] = 0x7E; f[1] = 0x7E;
  if (seq & 1u)
  {
    uint16_t speed = (uint16_t)(1000u + (seq % 500u));
    uint16_t aux = (uint16_t)(seq % 100u);
    f[2] = 1;
    f[3] = (uint8_t)(speed & 0xFFu); f[4] = (uint8_t)(speed >> 8);
    f[5] = (uint8_t)(aux & 0xFFu);   f[6] = (uint8_t)(aux >> 8);
  }
  else
  {
    int16_t temp = (int16_t)(-1000 - (int16_t)(seq % 500u));   /* -10.00 .. -14.99 C */
    uint16_t hum = (uint16_t)(4000u + (seq % 500u));            /* 40.00 .. 44.99 % */
    f[2] = 2;
    f[3] = (uint8_t)((uint16_t)temp & 0xFFu); f[4] = (uint8_t)((uint16_t)temp >> 8);
    f[5] = (uint8_t)(hum & 0xFFu);            f[6] = (uint8_t)(hum >> 8);
  }
  uart_send_raw(f, sizeof(f));
}

static void send_frame_bundle(uint32_t seq)
{
  send_frame_telemetry(seq);
  send_frame_mavlink(seq);
  send_frame_multi(seq);
}

/*
 * 演示 4｜私有协议（故意"没人认识"）：给 Agent 的 learn 当样本。
 *
 *   5A A5 | id | v1(LH) | v2(LH) | seq | flags | crc8
 *   共 10 字节，crc8 = Dallas/Maxim（poly 0x31 反射），覆盖前 9 字节。
 *
 * id=1 → 温度(0.1C) / 湿度(0.1%)；id=2 → 电压(mV) / 电流(mA)。
 * 与上面三个演示刻意不同：帧头顺序反转、无帧尾、单字节 CRC —— 学的不是
 * "我们认得的协议"，而是"线上这堆字节自己长什么样"。
 */
static uint8_t crc8_maxim(const uint8_t *buf, size_t len)
{
  uint8_t crc = 0x00u;
  for (size_t i = 0; i < len; i++)
  {
    crc ^= buf[i];
    for (int b = 0; b < 8; b++)
    {
      crc = (crc & 1u) ? (uint8_t)((crc >> 1) ^ 0x8Cu) : (uint8_t)(crc >> 1);
    }
  }
  return crc;
}

static void send_frame_private(uint32_t seq)
{
  uint8_t f[10];
  f[0] = 0x5A; f[1] = 0xA5;
  if ((seq & 1u) == 0u)
  {
    uint16_t temp = (uint16_t)(200u + (seq * 3u) % 150u);    /* 20.0 .. 34.9 C */
    uint16_t hum = (uint16_t)(450u + (seq * 7u) % 200u);     /* 45.0 .. 64.9 % */
    f[2] = 1;
    f[3] = (uint8_t)(temp & 0xFFu); f[4] = (uint8_t)(temp >> 8);
    f[5] = (uint8_t)(hum & 0xFFu);  f[6] = (uint8_t)(hum >> 8);
  }
  else
  {
    uint16_t mv = (uint16_t)(3300u + (seq % 200u));          /* 3300 .. 3499 mV */
    uint16_t ma = (uint16_t)(120u + (seq * 5u) % 80u);       /* 120 .. 199 mA */
    f[2] = 2;
    f[3] = (uint8_t)(mv & 0xFFu); f[4] = (uint8_t)(mv >> 8);
    f[5] = (uint8_t)(ma & 0xFFu); f[6] = (uint8_t)(ma >> 8);
  }
  f[7] = (uint8_t)(seq & 0xFFu);
  f[8] = (uint8_t)((seq & 1u) ? 0x02u : 0x01u);   /* flags：bit0=DATA bit1=VSYS */
  f[9] = crc8_maxim(f, 9);
  uart_send_raw(f, sizeof(f));
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
  else if (strcmp(line, "LEARN") == 0)
  {
    /* 单协议突发：期间其它演示帧暂停，抓包窗口里只有这一种协议。 */
    g_learn_seq = 0;
    g_learn_last = HAL_GetTick();
    g_learn_left = LEARN_FRAMES;
    printf("[cmd] LEARN -> %lu frames of private proto "
           "(5A A5 id v1 v2 seq flags crc8), others paused\r\n",
           (unsigned long)LEARN_FRAMES);
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
  printf("[log] frames    : telemetry(bitfield) + mavlink(length) + multi(id) @10Hz\r\n");
  printf("[log] LEARN cmd : private proto burst (5A A5 + id + payload + crc8) x%u\r\n",
         (unsigned)LEARN_FRAMES);

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

    /* 演示 4｜私有协议突发（LEARN 命令触发）：期间让出串口，只发这一种。
     * 帧率 20Hz、共 200 帧 ≈ 10s，足够 Agent 抓一段干净样本自学。 */
    if (g_learn_left > 0)
    {
      if (HAL_GetTick() - g_learn_last >= LEARN_PERIOD_MS)
      {
        g_learn_last += LEARN_PERIOD_MS;
        if (HAL_GetTick() - g_learn_last >= LEARN_PERIOD_MS)
        {
          g_learn_last = HAL_GetTick();
        }
        send_frame_private(g_learn_seq++);
        if (--g_learn_left == 0u)
        {
          printf("[cmd] LEARN -> done, %lu frames sent\r\n",
                 (unsigned long)g_learn_seq);
        }
      }
    }
    /* 帧协议演示：100ms 一组，三帧各自演示位域 / 变长 / 多 ID。
     * 私有协议突发期间暂停，保证窗口内只有一种协议。 */
    else if (HAL_GetTick() - g_last_frame >= FRAME_PERIOD_MS)
    {
      g_last_frame += FRAME_PERIOD_MS;
      if (HAL_GetTick() - g_last_frame >= FRAME_PERIOD_MS)
      {
        g_last_frame = HAL_GetTick();
      }
      send_frame_bundle(g_frame_seq++);
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
