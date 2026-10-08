#ifndef OTA_BOOT_FLOW_H
#define OTA_BOOT_FLOW_H

#include <stdint.h>
#include "ota_common.h"

/**
 * @file    ota_boot_flow.h
 * @brief   Bootloader 升级流程场景层（芯片无关，从源工程 User/boot.c 提升）
 *
 * 与源工程 boot.c 的对应关系：
 *   OtaBootFlow_Init()      ≙ Protocol_Parser_Init + 全局态清零（main.c 里的 G_* 变量收编为内部态）
 *   OtaBootFlow_CheckState() ≙ Boot_CheckState()（五状态机 + 2s 窗口，日志关键字逐字保留）
 *   OtaBootFlow_ProcessRX()  ≙ Boot_ProcessRX()（解帧 → 组包 → 满 128B 写 Flash → ACK）
 *
 * 依赖的 port 接口（由 CMake 按 VARIANT=boot 链接对应 port 提供）：
 *   OtaJump_ToApp()        （port/ota_jump.c，芯片相关跳转）
 *   OtaKey_IsPressed()     （port/ota_key.c，触发按键）
 *   OtaDelay_Ms()          （port/ota_delay.c）
 *   OtaFlashHal_EraseRange()（port/ota_flash_hal.c，§方案 3.3 新原语）
 *   g_Transport            （serial 组件 / Transport 抽象）
 *
 * 日志：直接用 <stdio.h> printf，重定向由工程侧提供（boot 工程 main.c 把
 * _write/fputc 指向 g_Transport->write）。所有日志关键字与源工程逐字一致
 * —— elab monitor 的 boot 判据依赖它们。
 */

/** 初始化内部态与帧解析器（main 初始化 Transport 后调用） */
void OtaBootFlow_Init(void);

/** 读升级状态并执行对应启动流程（含 STATE_RUNNING 2s 触发窗口） */
void OtaBootFlow_CheckState(void);

/** 主循环体：读 Transport 喂解析器 → 数据帧写 Flash → 命令帧分发（含扩展命令） */
void OtaBootFlow_ProcessRX(void);

/** 便捷循环：CheckState 后无限 ProcessRX（main.c 一行调用） */
void OtaBootFlow_Run(void);

#endif /* OTA_BOOT_FLOW_H */
