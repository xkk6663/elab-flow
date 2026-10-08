#include "main.h"
#include "KEY.h"

uint8_t B1_state;
uint8_t B1_last_state=1; //注意这个初始化为1


int key_scan(void)
{
    static uint32_t press_tick=0;
    static uint8_t long_sent=0;
    uint32_t current_tick = HAL_GetTick();

	B1_state=HAL_GPIO_ReadPin (KEY_GPIO_Port , KEY_Pin);
	if(B1_state==0&&B1_last_state==1)
	{
		press_tick=current_tick;
		long_sent=0;
	}
	else if(B1_state==0&&B1_last_state==0)
	{
		if(!long_sent && current_tick - press_tick>=1000)
		{
			//长按操作
			uint16_t key_value = 2;
			long_sent=1;
			osMessageQueuePut(myQueue01Handle, &key_value, 0, 0);
        }
	}
	else if(B1_state==1&&B1_last_state==0)
	{
		if(!long_sent && current_tick - press_tick<1000)
		{
			//单击操作
			uint16_t key_value = 1;
			osMessageQueuePut(myQueue01Handle, &key_value, 0, 0);
		}
	}
	B1_last_state=B1_state;
	return 0;
}

