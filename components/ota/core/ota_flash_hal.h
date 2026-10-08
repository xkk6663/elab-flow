#ifndef OTA_FLASH_HAL_H
#define OTA_FLASH_HAL_H

#include <stdint.h>

/**
 * @file    ota_flash_hal.h
 * @brief   Flash 底层操作平台无关接口（移植层）
 *
 * 供 ota_flash_store.c 调用，屏蔽具体芯片 Flash 控制器差异。
 * 各平台在 ota/port/<platform>/ 下实现本接口：
 *   - STM32: 直接封装 FLASH_Unlock / FLASH_ProgramWord / FLASH_ErasePage ...
 *   - AT32 : 封装 flash_unlock / flash_word_program / flash_sector_erase ...
 */

/** @brief 解锁 Flash 写保护（编程/擦除前必须调用） */
void OtaFlashHal_Unlock(void);

/** @brief 锁定 Flash 写保护（编程/擦除完成后调用） */
void OtaFlashHal_Lock(void);

/**
 * @brief 清除 Flash 操作标志位（EOP / PGERR / WRPRTERR 等）
 *
 * 擦除/编程前调用，避免历史错误标志导致后续操作被拒。
 */
void OtaFlashHal_ClearFlags(void);

/**
 * @brief 擦除一页/扇区
 * @param  page_addr 页起始地址（必须按页/扇区对齐）
 */
void OtaFlashHal_ErasePage(uint32_t page_addr);

/**
 * @brief 写入一个 32 位字
 * @param  addr  目标地址（按字对齐）
 * @param  data  待写入数据
 */
void OtaFlashHal_ProgramWord(uint32_t addr, uint32_t data);

/* ------------------------------------------------------------------
 * ★ 平台化新增（方案 §3.2 改造 #3）—— 区间擦除 + 批量编程
 *
 * 两种擦除语义（★ 2026-10-08 实弹教训，两者不可混用）：
 *
 * EraseRange（续传语义）：擦除 [start, end) 覆盖的擦除单元，start 自动
 *   **向上对齐**到所在擦除单元的下一个边界——断点续传场景下 start 所在
 *   单元的前段已写入有效数据，**所在单元不动**。
 *
 * EraseRangeFull（整片语义）：擦除 [start, end) 覆盖的全部擦除单元，
 *   start **向下对齐**——start 所在单元一并擦除。新升级/换镜像必须用
 *   本语义：向上对齐会把目标区【第一个单元】漏掉不擦（F411 实弹实锤：
 *   S4 未擦 → 劫持的 0xFFFFFFFF 向量编程成按位与空操作 → 坏固件变好固件
 *   → 回滚验收假失败）。
 *
 * WritePacket 语义：从 addr 起连续编程 words 个 32 位字（批量，含解锁/上锁）。
 * ------------------------------------------------------------------ */
void OtaFlashHal_EraseRange(uint32_t start, uint32_t end);
void OtaFlashHal_EraseRangeFull(uint32_t start, uint32_t end);
void OtaFlashHal_WritePacket(uint32_t addr, const uint32_t *data, uint32_t words);

#endif /* OTA_FLASH_HAL_H */
