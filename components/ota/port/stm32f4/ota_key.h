#ifndef OTA_KEY_H
#define OTA_KEY_H

#include <stdint.h>

/** 触发按键是否按下（1=按下，二次采样消抖） */
uint8_t OtaKey_IsPressed(void);

#endif /* OTA_KEY_H */
