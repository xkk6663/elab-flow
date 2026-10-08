#ifndef OTA_BANK_H
#define OTA_BANK_H

/**
 * @file    ota_bank.h
 * @brief   双槽（A/B Bank）bank 记录管理（OTA_双槽回滚技术方案 §4.1）
 *
 * ★ 单槽零回归：OTA_SLOT_COUNT == 1（芯片 yaml 未声明 slots:）时全部 API
 *   编译为空操作，Boot/Confirm 调用点行为与单槽完全一致。
 *
 * 存储位置：状态扇区（UPGRADE_STATE_ADDR）的【上半段槽位】——
 *   下半段仍归 4B 状态字（ota_upgrade_state），上半段归 20B bank 记录，
 *   两段互不踩踏（ota_flash_store 的状态读写已按半区钳位）。
 *
 * 记录 = 5 个 32 位字，append-only 追加 + CRC32 自校验：
 *   W0 magic 0xA5A5A5B0（与状态字 0xA5A5A5Ax 系列区分）
 *   W1 active(b7:0) | pending(b15:8, 0xFF=无试运行) | trial(b31:16)
 *   W2 槽0 版本 {major, minor, patch, 0}
 *   W3 槽1 版本 {major, minor, patch, 0}
 *   W4 CRC32(W0..W3)
 *
 * 读侧底线（防变砖）：magic/CRC 不合法一律视为"无记录"回落默认
 * （active=槽0 / pending=无）——boot 永远不能因 bank 记录损坏而无法启动。
 */

#include <stdint.h>
#include "ota_common.h"
#include "ota_flash_store.h"

#ifndef OTA_SLOT_COUNT
#define OTA_SLOT_COUNT 1
#endif

#if OTA_SLOT_COUNT > 1

#define OTA_BANK_MAGIC          0xA5A5A5B0UL
#define OTA_BANK_PENDING_NONE   0xFFu
/** 状态区槽位总数的一半 = bank 记录区起点（槽索引） */
#define OTA_BANK_SLOT_BEGIN     (FLASH_STORE_SLOT_COUNT / 2)

typedef struct {
    uint8_t active;             /* 当前 ACTIVE 槽（0/1） */
    uint8_t pending;            /* 试运行槽（0/1），0xFF=无 */
    uint16_t trial;             /* 试运行剩余上电次数 */
    uint8_t ver[2][3];          /* 各槽固件 semver（槽0/槽1） */
} OtaBankRecord;

/** 读最后一条合法记录；无记录/记录损坏 → 填默认值并返回 0 */
uint8_t Bank_Get(OtaBankRecord *out);

/** 追加一条记录（页满 → 擦整个状态扇区后先补写 restore_state 再写记录）。
 *  ★ restore_state：扇区擦除会连状态字一起清掉，调用方必须带上当前状态值。 */
void Bank_Set(const OtaBankRecord *rec, uint32_t restore_state);

/** ACTIVE 槽的 Flash 起始地址（OTA_SLOT0/1_ADDR） */
uint32_t Bank_ActiveAddr(const OtaBankRecord *rec);

/** 槽号 → Flash 起始地址（0/1 之外的槽号返回 0） */
uint32_t Bank_SlotAddr(uint8_t slot);

/** 槽号 → 槽大小（字节） */
uint32_t Bank_SlotSize(uint8_t slot);

#endif /* OTA_SLOT_COUNT > 1 */
#endif /* OTA_BANK_H */
