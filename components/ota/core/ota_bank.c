/**
 * @file    ota_bank.c
 * @brief   双槽 bank 记录存储（OTA_双槽回滚技术方案 §4.1，实现见头文件注释）
 *
 * 追加策略：bank 区内找【连续 5 个空槽】写入一条记录；找不到 → 擦整个
 * 状态扇区 → 先补写状态字（restore_state，落回下半段槽 0）→ 再写记录。
 * 读策略：从区尾向前扫 magic，逐条 CRC32 校验，取最后一条合法记录。
 * 掉电半途的残记录（只写了一半 5 词）→ CRC 必不过 → 自动跳过，天然自愈。
 */

#include "ota_bank.h"

#if OTA_SLOT_COUNT > 1

#include "ota_crc32.h"
#include "ota_flash_hal.h"

#define OTA_BANK_WORDS  5   /* magic + flags + ver0 + ver1 + crc32 */

/* ── 内部：读第 i 个槽的词 ─────────────────────────────────────── */
static uint32_t bank_word(uint32_t i)
{
    return *(const volatile uint32_t *)(UPGRADE_STATE_ADDR
                                        + (OTA_BANK_SLOT_BEGIN + i) * 4);
}

/* 区内槽位数 */
#define OTA_BANK_SLOT_NUM   (FLASH_STORE_SLOT_COUNT - OTA_BANK_SLOT_BEGIN)

uint8_t Bank_Get(OtaBankRecord *out)
{
    /* 默认值：无记录 = 单槽语义的自然延伸（ACTIVE=槽0，无试运行） */
    out->active  = 0;
    out->pending = OTA_BANK_PENDING_NONE;
    out->trial   = 0;
    out->ver[0][0] = out->ver[0][1] = out->ver[0][2] = 0;
    out->ver[1][0] = out->ver[1][1] = out->ver[1][2] = 0;

    /* 从区尾向前扫：magic 命中且 5 词齐 → CRC 校验 → 取最后一条合法记录 */
    for (int32_t i = (int32_t)OTA_BANK_SLOT_NUM - OTA_BANK_WORDS; i >= 0; i--) {
        if (bank_word((uint32_t)i) != OTA_BANK_MAGIC) {
            continue;
        }
        uint32_t w[OTA_BANK_WORDS];
        for (uint32_t k = 0; k < OTA_BANK_WORDS; k++) {
            w[k] = bank_word((uint32_t)i + k);
        }
        if (Software_CRC32((const uint8_t *)w, OTA_BANK_WORDS * 4 - 4) != w[4]) {
            continue;       /* 半途掉电的残记录 / 损坏 → 跳过继续向前 */
        }
        out->active  = (uint8_t)(w[1] & 0xFF);
        out->pending = (uint8_t)((w[1] >> 8) & 0xFF);
        out->trial   = (uint16_t)((w[1] >> 16) & 0xFFFF);
        out->ver[0][0] = (uint8_t)(w[2] & 0xFF);
        out->ver[0][1] = (uint8_t)((w[2] >> 8) & 0xFF);
        out->ver[0][2] = (uint8_t)((w[2] >> 16) & 0xFF);
        out->ver[1][0] = (uint8_t)(w[3] & 0xFF);
        out->ver[1][1] = (uint8_t)((w[3] >> 8) & 0xFF);
        out->ver[1][2] = (uint8_t)((w[3] >> 16) & 0xFF);
        if (out->active >= OTA_SLOT_COUNT) {
            out->active = 0;    /* 越界槽号按损坏处理（回落槽0） */
        }
        return 1;
    }
    return 0;
}

void Bank_Set(const OtaBankRecord *rec, uint32_t restore_state)
{
    uint32_t w[OTA_BANK_WORDS];
    w[0] = OTA_BANK_MAGIC;
    w[1] = (uint32_t)(rec->active & 0xFF)
         | ((uint32_t)(rec->pending & 0xFF) << 8)
         | ((uint32_t)(rec->trial & 0xFFFF) << 16);
    w[2] = (uint32_t)rec->ver[0][0]
         | ((uint32_t)rec->ver[0][1] << 8)
         | ((uint32_t)rec->ver[0][2] << 16);
    w[3] = (uint32_t)rec->ver[1][0]
         | ((uint32_t)rec->ver[1][1] << 8)
         | ((uint32_t)rec->ver[1][2] << 16);
    uint32_t crc = Software_CRC32((const uint8_t *)w, OTA_BANK_WORDS * 4 - 4);
    w[4] = crc;

    /* 找连续 5 个空槽 */
    uint32_t base = OTA_BANK_SLOT_NUM;  /* 找不到 = 区满 */
    for (uint32_t i = 0; i + OTA_BANK_WORDS <= OTA_BANK_SLOT_NUM; i++) {
        uint8_t free_run = 1;
        for (uint32_t k = 0; k < OTA_BANK_WORDS; k++) {
            if (bank_word(i + k) != 0xFFFFFFFF) {
                free_run = 0;
                i += k;             /* 跳过这段非空区，避免 O(n²) */
                break;
            }
        }
        if (free_run) {
            base = i;
            break;
        }
    }

    OtaFlashHal_Unlock();
    if (base == OTA_BANK_SLOT_NUM) {
        /* 区满 → 擦整个状态扇区（状态字 + bank 记录一起清）→
           先补写状态字（下半段槽 0），再从头写本记录 */
        OtaFlashHal_ClearFlags();
        OtaFlashHal_ErasePage(UPGRADE_STATE_ADDR);
        OtaFlashHal_ProgramWord(UPGRADE_STATE_ADDR, restore_state);
        base = 0;
    }
    for (uint32_t k = 0; k < OTA_BANK_WORDS; k++) {
        OtaFlashHal_ProgramWord(
            UPGRADE_STATE_ADDR + (OTA_BANK_SLOT_BEGIN + base + k) * 4, w[k]);
    }
    OtaFlashHal_Lock();
}

uint32_t Bank_SlotAddr(uint8_t slot)
{
    return (slot == 0) ? OTA_SLOT0_ADDR : (slot == 1) ? OTA_SLOT1_ADDR : 0;
}

uint32_t Bank_SlotSize(uint8_t slot)
{
    return (slot == 0) ? OTA_SLOT0_SIZE : (slot == 1) ? OTA_SLOT1_SIZE : 0;
}

uint32_t Bank_ActiveAddr(const OtaBankRecord *rec)
{
    return Bank_SlotAddr(rec->active);
}

#endif /* OTA_SLOT_COUNT > 1 */
