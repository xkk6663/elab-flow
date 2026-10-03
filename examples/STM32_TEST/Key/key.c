#include "Key.h"

/**
 * @description: 检测按键
 * @return {*} 按下的按键值
 */
uint8_t Key_Detect(void)
{
    uint8_t res = 0;
    if (KEY1 == GPIO_PIN_RESET || KEY2 == GPIO_PIN_RESET || KEY3 == GPIO_PIN_SET || KEY4 == GPIO_PIN_SET )  
    {
        HAL_Delay(10);           /* 去抖动 */
        /* 按这个顺序，如果多个按键同时按，优先级：KEY4>KEY3>KEY2>KEY1 */
        if (KEY1 == GPIO_PIN_RESET)  res = KEY1_PRESS;
        if (KEY2 == GPIO_PIN_RESET)  res = KEY2_PRESS;
        if (KEY3 == GPIO_PIN_SET)  res = KEY3_PRESS;
        if (KEY4 == GPIO_PIN_SET)  res = KEY4_PRESS;
    }
    return res;
}