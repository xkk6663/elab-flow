/**
  ******************************************************************************
  * @file    modbus_slave.h
  * @brief   Modbus RTU 从站（教学夹具）：FC 01/02/03/04/05/06/0F/10 + 异常码
  *
  * 从站地址固定 1（广播 0 只执行不应答）。寄存器表见 docs/tutorials/
  * 09-协议上手_Modbus.md 与工程映射 projects/STM32F411_modbus.modbus.json，
  * **两处必须一致**：面板按映射解释，固件按这里的表应答。
  ******************************************************************************
  */
#ifndef __MODBUS_SLAVE_H__
#define __MODBUS_SLAVE_H__

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

#define MB_UNIT_ID      1u
#define MB_HOLD_N       0x0120u    /* 保持寄存器地址空间（0x0000–0x011F） */
#define MB_COIL_N       8u

/** 调试回显：1 = 每收到一帧就在串口上打一行 `#rx len=N bytes...`。
 *  总线接线阶段用肉眼对帧，验收/教程截图前必须改回 0 —— 它会在总线上说人话。 */
#ifndef MB_DIAG_ECHO
#define MB_DIAG_ECHO    0
#endif

/** 初始化寄存器表（只初始化一次，放在 ud_init 之后、主循环之前） */
void mb_slave_init(void);

/** 处理一整帧（已由 uart_dma 按静默定界切好）。应答由本函数自己发出去。 */
void mb_slave_handle(const uint8_t *req, uint16_t len);

/** 主循环里调用：推进"连发"状态机（TX 双缓冲的演示夹具）。
 *  写寄存器 0x0011 = N 触发，逐帧调用 ud_tx，两块缓冲一块在发、一块在填。 */
void mb_slave_poll(void);

/** 让主循环能读阶段/帧数（心跳日志与寄存器共用同一份事实） */
uint8_t mb_slave_stage(void);
uint32_t mb_slave_frames(void);

/** 总线上是否**见过**帧（含坏帧）。
 *  单口方案的关键：首帧之前 USART1 兼做心跳口，见过帧之后立刻闭嘴，
 *  把总线完整让给 Modbus —— 否则日志字节会混进帧里。 */
uint8_t mb_bus_seen(void);

/** 最近一次总线上有任何字节的时刻（HAL tick）。心跳靠它避开正在收的帧。 */
uint32_t mb_last_activity_ms(void);

#ifdef __cplusplus
}
#endif

#endif /* __MODBUS_SLAVE_H__ */
