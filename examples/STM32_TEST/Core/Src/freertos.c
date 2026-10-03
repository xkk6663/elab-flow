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
#include <stdio.h>
#include <assert.h>
#include "usart.h"
#include "key.h"
#include "queue.h"

/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */
#define BIT0 (1 << 0)
#define BIT1 (1 << 1)
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
/* Definitions for myTask02 */
osThreadId_t myTask02Handle;
const osThreadAttr_t myTask02_attributes = {
  .name = "myTask02",
  .stack_size = 128 * 4,
  .priority = (osPriority_t) osPriorityLow,
};
/* Definitions for myTask03 */
osThreadId_t myTask03Handle;
const osThreadAttr_t myTask03_attributes = {
  .name = "myTask03",
  .stack_size = 128 * 4,
  .priority = (osPriority_t) osPriorityLow,
};
/* Definitions for myQueue01 */
osMessageQueueId_t myQueue01Handle;
const osMessageQueueAttr_t myQueue01_attributes = {
  .name = "myQueue01"
};
/* Definitions for myTimer01 */
osTimerId_t myTimer01Handle;
const osTimerAttr_t myTimer01_attributes = {
  .name = "myTimer01"
};
/* Definitions for myTimer02 */
osTimerId_t myTimer02Handle;
const osTimerAttr_t myTimer02_attributes = {
  .name = "myTimer02"
};
/* Definitions for myMutex01 */
osMutexId_t myMutex01Handle;
const osMutexAttr_t myMutex01_attributes = {
  .name = "myMutex01"
};
/* Definitions for myBinarySem01 */
osSemaphoreId_t myBinarySem01Handle;
const osSemaphoreAttr_t myBinarySem01_attributes = {
  .name = "myBinarySem01"
};
/* Definitions for myCountingSem01 */
osSemaphoreId_t myCountingSem01Handle;
const osSemaphoreAttr_t myCountingSem01_attributes = {
  .name = "myCountingSem01"
};
/* Definitions for myEvent01 */
osEventFlagsId_t myEvent01Handle;
const osEventFlagsAttr_t myEvent01_attributes = {
  .name = "myEvent01"
};
/* Definitions for myEvent02 */
osEventFlagsId_t myEvent02Handle;
const osEventFlagsAttr_t myEvent02_attributes = {
  .name = "myEvent02"
};

/* Private function prototypes -----------------------------------------------*/
/* USER CODE BEGIN FunctionPrototypes */
QueueSetHandle_t xqueueSetHandle;

osMemoryPoolId_t myMemoryPoolHandle;
const osMemoryPoolAttr_t myMemoryPool_attributes = {
  .name = "myMemoryPool"
};

/* USER CODE END FunctionPrototypes */

void StartDefaultTask(void *argument);
void StartTask02(void *argument);
void StartTask03(void *argument);
void Callback01(void *argument);
void Callback02(void *argument);

void MX_FREERTOS_Init(void); /* (MISRA C 2004 rule 8.1) */

/* USER CODE BEGIN PREPOSTSLEEP */
__weak void PreSleepProcessing(uint32_t *ulExpectedIdleTime)
{
  // 进入睡眠模式前的处理：手动关闭外设时钟
  HAL_StatusTypeDef res;
  res=HAL_RCC_ClockConfig(RCC_SYSCLKSOURCE_HSI, RCC_HCLK_DIV1);
  if(res != HAL_OK)
  {
    printf("HAL_RCC_ClockConfig error: %d\n", res);
  }

/* place for user code */
}

__weak void PostSleepProcessing(uint32_t *ulExpectedIdleTime)
{
// 从睡眠模式唤醒后的处理：手动开启外设时钟  
  HAL_StatusTypeDef res;
  res = HAL_RCC_ClockConfig(RCC_SYSCLKSOURCE_HSI, RCC_HCLK_DIV2);
  if(res != HAL_OK)
  {
    printf("HAL_RCC_ClockConfig error: %d\n", res);
  }
/* place for user code */

}
/* USER CODE END PREPOSTSLEEP */

/**
  * @brief  FreeRTOS initialization
  * @param  None
  * @retval None
  */
void MX_FREERTOS_Init(void) {
  /* USER CODE BEGIN Init */
  myMemoryPoolHandle = osMemoryPoolNew(1, sizeof(uint16_t), &myMemoryPool_attributes);
  if(myMemoryPoolHandle == NULL)
  {
    printf("memory pool create failed!\r\n");
  }

  /* USER CODE END Init */
  /* Create the mutex(es) */
  /* creation of myMutex01 */
  myMutex01Handle = osMutexNew(&myMutex01_attributes);

  /* USER CODE BEGIN RTOS_MUTEX */
  /* add mutexes, ... */
  /* USER CODE END RTOS_MUTEX */

  /* Create the semaphores(s) */
  /* creation of myBinarySem01 */
  myBinarySem01Handle = osSemaphoreNew(1, 1, &myBinarySem01_attributes);

  /* creation of myCountingSem01 */
  myCountingSem01Handle = osSemaphoreNew(4, 0, &myCountingSem01_attributes);

  /* USER CODE BEGIN RTOS_SEMAPHORES */
  /* add semaphores, ... */
  /* USER CODE END RTOS_SEMAPHORES */

  /* Create the timer(s) */
  /* creation of myTimer01 */
  myTimer01Handle = osTimerNew(Callback01, osTimerOnce, NULL, &myTimer01_attributes);

  /* creation of myTimer02 */
  myTimer02Handle = osTimerNew(Callback02, osTimerPeriodic, NULL, &myTimer02_attributes);

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

  /* creation of myTask02 */
  myTask02Handle = osThreadNew(StartTask02, NULL, &myTask02_attributes);

  /* creation of myTask03 */
  myTask03Handle = osThreadNew(StartTask03, NULL, &myTask03_attributes);

  /* USER CODE BEGIN RTOS_THREADS */
  /* add threads, ... */
  /* USER CODE END RTOS_THREADS */

  /* creation of myEvent01 */
  myEvent01Handle = osEventFlagsNew(&myEvent01_attributes);

  /* creation of myEvent02 */
  myEvent02Handle = osEventFlagsNew(&myEvent02_attributes);

  /* USER CODE BEGIN RTOS_EVENTS */
  xqueueSetHandle = xQueueCreateSet(3); // 创建一个队列集，大小为3
  // 将队列和信号量添加到队列集中,添加时队列和信号量必须为空，即没有等待的任务
  xQueueAddToSet(myQueue01Handle, xqueueSetHandle); // 将 myQueue01Handle 添加到队列集 xqueueSetHandle 中
  xQueueAddToSet(myBinarySem01Handle, xqueueSetHandle); // 将 myBinarySem01Handle 添加到队列集 xqueueSetHandle 中
  xQueueAddToSet(myCountingSem01Handle, xqueueSetHandle); // 将 myCountingSem01Handle 添加到队列集 xqueueSetHandle 中
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
  uint16_t msg = 0;
  osStatus_t status;
  //uint32_t eventFlags;
  uint32_t rflags;
  uint32_t expectFlags;
  /* Infinite loop */
  for(;;)
  {
    //事件标志组
    // eventFlags = osEventFlagsWait(myEvent01Handle, BIT0 & BIT1, osFlagsWaitAll, osWaitForever); // 等待事件标志BIT0和BIT1都被设置
    // printf("事件标志组接收成功,开始执行下面的任务, eventFlags=%d\r\n",(int)eventFlags); // 打印事件标志的当前状态


    //任务通知 置位的都是对方TCB的任务通知位的[0]第一位，所以接收前后接受后都要清零
    rflags = osThreadFlagsWait(0xFFFFFFFF, osFlagsWaitAll, osWaitForever); // 等待任务通知的位被设置
    //0xFFFFFFFF（全1）表示接收到一个任务通知位后要清零
    if(rflags & BIT0 )
    { 
      printf("BIT0 set:%d\r\n",(int)(rflags & BIT0)); // 打印任务通知的当前状态
      expectFlags |= BIT0;
    }
    if(rflags & BIT1 )
    { 
      printf("BIT1 set:%d\r\n",(int)(rflags & BIT1)); // 打印任务通知的当前状态
      expectFlags |= BIT1;
    }
    if(expectFlags == (BIT0|BIT1))
    {
      printf("任务通知模拟事件标志组接收成功,开始执行里面任务\r\n");
      expectFlags = 0;
    }


    osMutexAcquire(myMutex01Handle, portMAX_DELAY); // 获取互斥锁
    printf("Mutex acquired successfully.\r\n");
    msg++; // 递增消息值
    status = osMessageQueuePut(myQueue01Handle, &msg, 0, 0);// 非阻塞发送消息
    if(status == osOK)
    {
      printf("Message %d sent to queue successfully.\r\n", msg);
    }
    else
    {
      printf("Failed to send message %d to queue.\r\n", msg);
    }
    
    // 翻转LED状态
    HAL_GPIO_TogglePin(LED_GPIO_Port, LED_Pin);
    
    // 延时
    HAL_Delay(3000);
   
    osMutexRelease(myMutex01Handle);
    printf("task released successfully \r\n");
    osDelay(500); // 使用FreeRTOS的延时函数，单位为毫秒
  }
  /* USER CODE END StartDefaultTask */
}

/* USER CODE BEGIN Header_StartTask02 */
/**
* @brief Function implementing the myTask02 thread.
* @param argument: Not used
* @retval None
*/
/* USER CODE END Header_StartTask02 */
void StartTask02(void *argument)
{
  /* USER CODE BEGIN StartTask02 */
  uint16_t msg = 0;
  osStatus_t status_1, status_2, status_3;
  QueueSetMemberHandle_t member;
  /* Infinite loop */
  for(;;)
  {
    member = xQueueSelectFromSet(xqueueSetHandle, portMAX_DELAY);
    if(member == myQueue01Handle)
    {
      status_1 = osMessageQueueGet(myQueue01Handle, &msg, 0,portMAX_DELAY);
      if(status_1 == osOK)  
      {
        printf("Message %d received from queue successfully.\r\n", msg);
      }
    }
    else if(member == myBinarySem01Handle)
    {
      status_2 = osSemaphoreAcquire(myBinarySem01Handle, portMAX_DELAY);
      if(status_2 == osOK)
      {
       printf("二进制信号量的计数值=%d\r\n",(int)osSemaphoreGetCount(myBinarySem01Handle));
      }
    }
    else if(member == myCountingSem01Handle)
    {
      status_3 = osSemaphoreAcquire(myCountingSem01Handle, portMAX_DELAY);
      if(status_3 == osOK)
      {
        printf("计数信号量的计数值=%d\r\n",(int)osSemaphoreGetCount(myCountingSem01Handle));
      }
    }
    else
    {
      printf("Unknown event.\r\n");
    }
       osDelay(1000);
  }
  /* USER CODE END StartTask02 */
}

/* USER CODE BEGIN Header_StartTask03 */
/**
* @brief Function implementing the myTask03 thread.
* @param argument: Not used
* @retval None
*/
/* USER CODE END Header_StartTask03 */
void StartTask03(void *argument)
{
  /* USER CODE BEGIN StartTask03 */
  osStatus_t status_1, status_2;
  uint8_t key = 0;
  osStatus_t res;
  uint32_t rflags;
  void* buff = NULL;
  /* Infinite loop */
  for(;;)
  {
    key = Key_Detect();
    if (key == KEY1_PRESS) {
      status_1 = osSemaphoreRelease(myBinarySem01Handle);
      if (status_1 == osOK) {
        printf("Binary semaphore released successfully.\r\n");
      }

      //软件定时器
      res = osTimerStart(myTimer01Handle, portMAX_DELAY);
      if(res == osOK)
      {
        printf("Timer1单次定时器启动成功.\r\n");
      }
      res = osTimerStart(myTimer02Handle, portMAX_DELAY);
      if(res == osOK)
      {
        printf("Timer2周期性定时器启动成功.\r\n");
      }


    } else if (key == KEY2_PRESS) 
    {
      status_2 = osSemaphoreRelease(myCountingSem01Handle);
      if (status_2 == osOK) {
        printf("Counting semaphore released successfully.\r\n");
      }

      //软件定时器
      res = osTimerStop(myTimer01Handle);
      if(res == osOK)
      {
        printf("Timer1单次定时器停止成功.\r\n");
      }
      res = osTimerStop(myTimer02Handle);
      if(res == osOK)
      {
        printf("Timer2周期性定时器停止成功.\r\n");
      }

    }
    else if(key == KEY3_PRESS)
    {
      // // 设置事件标志，对bit0进行置位操作
      // osEventFlagsSet(myEvent01Handle, BIT0);
      // printf("KEY3_PRESS pressed bit0=%d\r\n",BIT0);

      //任务通知
      rflags = osThreadFlagsSet(defaultTaskHandle, BIT0); // 设置任务通知的位
      if(rflags == osOK)
      {
        printf("KEY3_PRESS pressed bit0=%d\r\n",BIT0);
      }

      // 从内存池释放内存
      res = osMemoryPoolFree(myMemoryPoolHandle, buff);
      if(res == osOK)
      {
        printf("KEY3_PRESS pressed memory pool freed %d.\r\n",(int)osMemoryPoolGetBlockSize(myMemoryPoolHandle));
      }

      // res = osMemoryPoolDelete(myMemoryPoolHandle);
      // if(res == osOK)
      // {
      //   printf("KEY3_PRESS pressed memory pool deleted successfully.\r\n");
      // }


    }
    else if(key == KEY4_PRESS)
    {
      // // 设置事件标志，对bit1进行置位操作
      // osEventFlagsSet(myEvent01Handle, BIT1);
      // printf("KEY4_PRESS pressed bit1=%d\r\n",BIT1);

      //任务通知
      rflags = osThreadFlagsSet(defaultTaskHandle, BIT1); // 设置任务通知的位
      if(rflags == osOK)
      {
        printf("KEY4_PRESS pressed bit1=%d\r\n",BIT1);
      }


      // 内存池分配
      buff = osMemoryPoolAlloc(myMemoryPoolHandle, portMAX_DELAY);
      *(uint16_t *)buff = 0x1234;
      printf("KEY4_PRESS pressed memory pool allocated %d.\r\n",(int)osMemoryPoolGetBlockSize(myMemoryPoolHandle));
      printf("KEY4_PRESS pressed memory pool allocated value=%d.\r\n",*(uint16_t *)buff);



    }

    osDelay(2000);
  }
  /* USER CODE END StartTask03 */
}

/* Callback01 function */
void Callback01(void *argument)
{
  /* USER CODE BEGIN Callback01 */
  // 软件定时器回调函数(一次性的)
  static int count = 0;  // static将count设为静态变量，确保在每次调用时保持不变
  count++;
  printf("Timer1单次定时器超时回调函数执行次数=%d\r\n",count);

  /* USER CODE END Callback01 */
}

/* Callback02 function */
void Callback02(void *argument)
{
  /* USER CODE BEGIN Callback02 */
  // 软件定时器回调函数(周期性的)
  static int count = 0;
  count++;
  printf("Timer2周期性定时器超时回调函数执行次数=%d\r\n",count);



  /* USER CODE END Callback02 */
}

/* Private application code --------------------------------------------------*/
/* USER CODE BEGIN Application */
int fputc(int ch, FILE *f)
{
  HAL_UART_Transmit(&huart1, (uint8_t *)&ch, 1, 0xFFFF);
  return ch;
}
/* USER CODE END Application */

