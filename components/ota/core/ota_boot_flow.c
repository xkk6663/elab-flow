/**
 * @file    ota_boot_flow.c
 * @brief   Bootloader 升级流程场景层（芯片无关，从源工程 User/boot.c 提升）
 *
 * ★ 移植纪律：流程/时序/日志关键字与源工程 boot.c 逐段对应，不增删状态。
 *   与源工程的差异只有三类（均为"配置面"，见移植方案 §3.2）：
 *   ① 擦除改走 OtaFlashHal_EraseRange(start, end)（F4 扇区对齐语义在 port 内实现）
 *   ② 芯片相关 Jump_ToApp 抽到 port 的 OtaJump_ToApp(app_addr)
 *   ③ G_* 全局变量收编为本文件内部静态态
 *
 * ★★ 双槽 A/B Bank 扩展（OTA_双槽回滚技术方案 §4，全部 #if OTA_SLOT_COUNT > 1）：
 *   - 单槽芯片（芯片 yaml 无 slots:）所有双槽分支编译剔除，行为与回归基准逐字一致；
 *   - 传输目标 = INACTIVE 槽（ACTIVE 全程不动 = 回滚资本），boot 自选、协议零改动；
 *   - 完成时：active 翻转到新槽 + pending=新槽 + trial=3 → 复位；
 *   - 试运行 boot：trial 先减并落盘、再跳（时序红线，§4.2）；耗尽 → ROLLBACK 回老槽；
 *   - metadata type 0x02（§9.2）：新固件 semver 下发 + 防回滚（只管写坏的方向）。
 */

#include <stdio.h>
#include "ota_boot_flow.h"
#include "ota_protocol.h"
#include "ota_flash_store.h"
#include "ota_offset.h"
#include "ota_upgrade_state.h"
#include "ota_crc32.h"
#include "ota_transport.h"
#include "ota_flash_hal.h"
#include "ota_boot_port.h"      /* OtaJump_ToApp / OtaKey_IsPressed / OtaDelay_Ms / OtaSystemReset */
#include "ota_bank.h"           /* OTA_SLOT_COUNT 缺省 1；双槽 API 自带条件编译 */

/* ============================================================
 * 内部态（源工程 main.c 的 G_* 全局，此处收编）
 * ============================================================ */

static uint8_t  s_RxBuffer[PACKET_SIZE];
static uint16_t s_RxCounter;
static uint32_t s_RunningCRC;
static uint32_t s_FlashWriteOffset;
/* M5.3：主机下发的预期 CRC（元数据帧 seq=0xFF 携带）。0 = 未下发（legacy
   语义：完成时不比对，维持源工程无条件 SUCCESS 行为——AT32 老板子零回归）。 */
static uint32_t s_ExpectedCRC;

/* ★ 双槽态（单槽编译剔除） */
#if OTA_SLOT_COUNT > 1
static OtaBankRecord s_BankRec;     /* 上电 Bank_Get 读一次，全程同步维护 */
static uint8_t  s_TargetSlot;       /* 本次传输目标槽（INACTIVE 槽） */
static uint8_t  s_IncomingVer[3];   /* metadata type 0x02 下发的新固件 semver */
static uint8_t  s_HaveIncomingVer;
#endif

static FrameParser s_Parser;

/* ============================================================
 * 目标区寻址（单槽 = APP 区宏；双槽 = 目标槽地址/大小）
 * ============================================================ */

static uint32_t Target_Addr(void)
{
#if OTA_SLOT_COUNT > 1
    return Bank_SlotAddr(s_TargetSlot);
#else
    return APP_START_ADDRESS;
#endif
}

static uint32_t Target_Size(void)
{
#if OTA_SLOT_COUNT > 1
    return Bank_SlotSize(s_TargetSlot);
#else
    return APP_SIZE;
#endif
}

/**
 * ★ 双槽 §4.2：跳转目标运行时化。
 * 单槽 = APP_START_ADDRESS（编译期常量，行为不变）；
 * 双槽 = bank 记录的 ACTIVE 槽地址。
 */
static uint32_t ota_app_start(void)
{
#if OTA_SLOT_COUNT > 1
    Bank_Get(&s_BankRec);           /* 读侧自带损坏回落（active=槽0） */
    return Bank_ActiveAddr(&s_BankRec);
#else
    return APP_START_ADDRESS;
#endif
}

#if OTA_SLOT_COUNT > 1
/** semver 3B 比较：-1/0/1（防回滚判据用，方案 §9.2） */
static int ota_ver_cmp(const uint8_t *a, const uint8_t *b)
{
    for (int i = 0; i < 3; i++) {
        if (a[i] != b[i]) {
            return (a[i] < b[i]) ? -1 : 1;
        }
    }
    return 0;
}

/**
 * ★ 双槽 §4.2 试运行决策（不返回）：
 *   trial 先减一并落盘 → trial>0 跳 pending 槽；trial==0 → ROLLBACK 回老槽。
 *   ★ 时序红线：必须先递减落盘、再跳转。若先跳后记，坏固件挂死在早期时
 *   计数器永远不减 → 死循环在坏固件里 = 变砖。
 */
static void Boot_HandlePendingJump(OtaBankRecord *rec)
{
    if (rec->trial > 0) {
        rec->trial--;
    }
    Bank_Set(rec, STATE_RUNNING);               /* 先减后落盘 */

    if (rec->trial == 0) {
        uint8_t failed = rec->pending;
        rec->active  = (uint8_t)(1u - failed);  /* 回老槽（INACTIVE 槽全程未动） */
        rec->pending = OTA_BANK_PENDING_NONE;
        rec->trial   = 0;
        Bank_Set(rec, STATE_RUNNING);           /* 回滚记录落盘 */
        printf("\r\n=== ROLLBACK: bank%u failed trial, back to bank%u ===\r\n",
               failed, rec->active);
        printf("Rolling back, jumping to bank%u...\r\n", rec->active);
        OtaJump_ToApp(Bank_SlotAddr(rec->active));
        while (1) { /* 不可达 */ }
    }

    printf("\r\n=== Trial boot: bank%u trial=%u, jumping... ===\r\n",
           rec->pending, rec->trial);
    OtaJump_ToApp(Bank_SlotAddr(rec->pending));
    while (1) { /* 不可达 */ }
}
#endif /* OTA_SLOT_COUNT > 1 */

/* ============================================================
 * 启动流程
 * ============================================================ */

void OtaBootFlow_Init(void)
{
    s_RxCounter = 0;
    s_RunningCRC = 0;
    s_FlashWriteOffset = 0;
    Protocol_Parser_Init(&s_Parser);
#if OTA_SLOT_COUNT > 1
    s_HaveIncomingVer = 0;
#endif
}

static void Boot_EraseAppAndReset(void)
{
#if OTA_SLOT_COUNT > 1
    /* 双槽：只擦 INACTIVE 槽（ACTIVE 槽全程不动 = 回滚资本），无缝覆盖 app 区 */
    s_TargetSlot = (uint8_t)(1u - s_BankRec.active);
    printf("Erase target bank%u @0x%08lX (%luK)...\r\n",
           s_TargetSlot, (unsigned long)Bank_SlotAddr(s_TargetSlot),
           (unsigned long)(Bank_SlotSize(s_TargetSlot) / 1024));
    /* ★ 整片语义（EraseRangeFull）：start 所在擦除单元一并擦除。
       2026-10-08 实弹教训：原走向上对齐的 EraseRange，目标槽第一个单元
       （S4，含 Reset 向量）永不擦 → 0xFFFFFFFF 劫持按位与空操作 → 坏固件复活。 */
    OtaFlashHal_EraseRangeFull(Bank_SlotAddr(s_TargetSlot),
                               Bank_SlotAddr(s_TargetSlot) + Bank_SlotSize(s_TargetSlot));
#else
    /* 源工程：My_Flash_Erase(APP_START_ADDRESS, APP_PAGE_COUNT) —— 整片语义：
       擦除 [APP_START, APP_START+APP_SIZE) 覆盖的全部擦除单元（含起始单元） */
    OtaFlashHal_EraseRangeFull(APP_START_ADDRESS, APP_START_ADDRESS + APP_SIZE);
#endif
    OFFSET_Init();
    UPGRADE_SetState(STATE_UPGRADING);
#if OTA_SLOT_COUNT > 1
    /* 落传输意图（真正 trial=3 在完成时写；Bank_Set 擦扇区时恢复 UPGRADING 状态字） */
    s_BankRec.pending = s_TargetSlot;
    s_BankRec.trial = 0;
    Bank_Set(&s_BankRec, STATE_UPGRADING);
    s_HaveIncomingVer = 0;
#endif
    s_RunningCRC = CRC32_Start();
    s_ExpectedCRC = 0;  /* 新一轮升级：预期 CRC 由主机重发（元数据帧） */
}

void OtaBootFlow_CheckState(void)
{
    UpgradeState state = UPGRADE_GetState();
    printf("\r\n=== Bootloader Start ===\r\n");
    printf("Current upgrade state: 0x%08lX\r\n", (unsigned long)state);

#if OTA_SLOT_COUNT > 1
    /* bank 记录读侧底线（§4.1）：损坏/无记录 → 默认 active=槽0，永不无法启动 */
    Bank_Get(&s_BankRec);
    s_TargetSlot = (s_BankRec.pending != OTA_BANK_PENDING_NONE)
                 ? s_BankRec.pending                       /* 续传沿用传输目标槽 */
                 : (uint8_t)(1u - s_BankRec.active);
    printf("Bank: active=%u pending=0x%02X trial=%u\r\n",
           s_BankRec.active, s_BankRec.pending, s_BankRec.trial);
#endif

    /* 清空 DMA 环形缓冲区，防止残留数据（如升级后的 'U' 字符）误触发升级 */
    uint8_t dummy;
    while (g_Transport->available() > 0) {
        g_Transport->read(&dummy);
    }

    switch (state) {

    case STATE_UPGRADE_READY:
        /* APP 请求升级：一次性擦除目标区，避免接收中阻塞 */
        printf("\r\n=== Upgrade requested. Erasing APP flash (%d pages)... ===\r\n",
               (int)(Target_Size() / 1024));
        Boot_EraseAppAndReset();
        printf("Erase done, ready to receive firmware.\r\n");
        break;

    case STATE_UPGRADE_SUCCESS:
#if OTA_SLOT_COUNT > 1
        /* 双槽：bank 已在完成时落盘（active=新槽,pending=新槽,trial=3）。
           本分支只兜"掉电落在 SUCCESS 状态字"的边缘态（此时 pending 可能
           还没写 → 回落跳 active 槽 = 老固件，安全）。 */
        printf("\r\n=== Upgrade verified OK ===\r\n");
        UPGRADE_SetState(STATE_RUNNING);
        if (s_BankRec.pending != OTA_BANK_PENDING_NONE) {
            Boot_HandlePendingJump(&s_BankRec);     /* 不返回 */
        }
        OtaJump_ToApp(ota_app_start());
#else
        /* 上次升级校验通过，跳转 APP */
        printf("\r\n=== Upgrade verified OK. Jumping to APP... ===\r\n");
        UPGRADE_SetState(STATE_RUNNING);
        OtaJump_ToApp(ota_app_start());
#endif
        break;

    case STATE_CRC_FAIL:
        printf("\r\n=== WARNING: Previous upgrade CRC failed! ===\r\n");
        printf("Press KEY or send \"!!!!!\" to retry upgrade...\r\n");
        while (1) {
            uint8_t detected = OtaKey_IsPressed();
            if (!detected && g_Transport->available() > 0) {
                uint8_t byte;
                g_Transport->read(&byte);
                detected = (byte == '!');
            }
            if (detected) {
                printf("Signal detected, erasing and restarting upgrade...\r\n");
                Boot_EraseAppAndReset();
                s_FlashWriteOffset = 0;
                break;
            }
        }
        break;

    case STATE_UPGRADING: {
        /* 断电续传：读已完成的页数，重算 CRC，擦除剩余区（F4 扇区对齐） */
        uint16_t done_pages;
        uint32_t done_bytes;
#if OTA_SLOT_COUNT > 1
        uint8_t rec_bank = 0xFF;
        done_pages = OFFSET_GetAt(&rec_bank);
        if (rec_bank != s_TargetSlot) {
            /* §4.4：offset 记录的 bank 与本次目标槽不符 → 宁全量重传不写穿 */
            done_pages = 0;
        }
#else
        done_pages = OFFSET_Get();
#endif
        done_bytes = (uint32_t)done_pages * 1024;

        if (done_pages > 0 && done_bytes <= Target_Size()) {
            printf("\r\n=== Resuming from page %u (%lu bytes already written) ===\r\n",
                   (unsigned)done_pages, (unsigned long)done_bytes);
            s_RunningCRC = CRC32_Start();
            s_RunningCRC = CRC32_Update(s_RunningCRC,
                                        (const uint8_t *)Target_Addr(), done_bytes);
            /* 擦除起点向上对齐到擦除单元边界（port 内实现）——
               done_bytes 所在单元的已写前段不能被抹掉 */
            OtaFlashHal_EraseRange(Target_Addr() + done_bytes,
                                   Target_Addr() + Target_Size());
            s_FlashWriteOffset = done_bytes;
        } else {
            printf("\r\n=== No valid resume point, starting fresh... ===\r\n");
            Boot_EraseAppAndReset();
        }
        break;
    }

    case STATE_RUNNING:
#if OTA_SLOT_COUNT > 1
        if (s_BankRec.pending != OTA_BANK_PENDING_NONE) {
            /* 试运行（§4.2）：立即先减后跳，不走 2s 升级窗口 */
            Boot_HandlePendingJump(&s_BankRec);     /* 不返回 */
        }
#endif
        printf("\r\n=== Bootloader Ready ===\r\n");
        printf("Press KEY or send \"!!!!!\" within 2s to enter upgrade mode...\r\n");
        for (int i = 0; i < 20; i++) {             /* 2 秒窗口，等待主机发 !!!!! */
            OtaDelay_Ms(100);

            uint8_t detected = OtaKey_IsPressed();
            if (!detected && g_Transport->available() > 0) {
                uint8_t byte;
                /* 清空 RX 缓冲区，直到遇到 '!' 或帧头 0xAA */
                while (g_Transport->available() > 0) {
                    g_Transport->read(&byte);
                    if (byte == '!' || byte == 0xAA) {
                        detected = 1;
                        break;
                    }
                }
            }

            if (detected) {
                printf("Signal detected, entering upgrade mode...\r\n");
                Boot_EraseAppAndReset();
                s_FlashWriteOffset = 0;
                /* 丢弃触发信号之后的残留字节 */
                {
                    uint8_t dummy;
                    while (g_Transport->available() > 0) {
                        g_Transport->read(&dummy);
                    }
                }
                break;
            }
        }
        printf("No upgrade request, jumping to APP...\r\n");
        OtaJump_ToApp(ota_app_start());
        break;
    default:
        /* ★ elab 健壮性补丁（场景层，非 core 功能改动）：
           工厂烧录场景下状态扇区可能残留非 0xFF 垃圾（f411 实测 0x08008000
           有脏数据），FlashStore_Read 只认「非 0xFF 即有效」→ 垃圾值透传，
           switch 落空 → 永不跳 APP。源工程隐含假设状态页干净（default=
           STATE_RUNNING），这里对齐该意图：擦净状态页 → 写 RUNNING → 跳转。 */
        printf("Invalid state 0x%08lX, resetting to RUNNING...\r\n",
               (unsigned long)state);
        OtaFlashHal_Unlock();
        OtaFlashHal_ClearFlags();
        OtaFlashHal_ErasePage(UPGRADE_STATE_ADDR);
        OtaFlashHal_Lock();
        UPGRADE_SetState(STATE_RUNNING);
        printf("\r\n=== Bootloader Ready ===\r\n");
        printf("Press KEY or send \"!!!!!\" within 2s to enter upgrade mode...\r\n");
        /* 与 STATE_RUNNING 相同的 2s 窗口（复用下方逻辑不值得重复代码）：
           直接落穿会破坏 switch 结构，故在窗口前提前跳转 ——
           工厂首启无升级请求是唯一常态。 */
        OtaJump_ToApp(ota_app_start());
        break;
    }

    /* 初始化帧解析器，准备主循环收包（Jump_To_App 路径不会到达这里） */
    Protocol_Parser_Init(&s_Parser);
}

/* ============================================================
 * 主循环：协议解帧 → 提取载荷 → 满包写 Flash
 * ============================================================ */

void OtaBootFlow_ProcessRX(void)
{
    uint8_t byte;
    while (g_Transport->read(&byte)) {

        uint8_t result = Protocol_Parser_Feed(&s_Parser, byte);

        if (result == FRAME_CRC_ERROR) {
            /* CRC 校验失败 → 通知主机重传 */
            uint8_t pages = (uint8_t)(s_FlashWriteOffset / 1024);
            uint8_t param[3] = {1, s_Parser.seq, pages};  /* STATUS=1(ERR), SEQ, PAGES */
            Protocol_SendAck(g_Transport, RSP_ACK, param, 3);
            Protocol_Parser_Init(&s_Parser);
            continue;
        }

        if (result == FRAME_TYPE_DATA) {
            uint8_t frame_len = s_Parser.len;       /* 先保存帧信息，再复位 */
            uint8_t frame_seq = s_Parser.seq;       /* 帧序号用于 ACK */

            /* ── 元数据帧（seq=0xFF 保留，正常数据帧永不占用 0xFF）──────
             * type 0x01（M5.3）：[0x01][预期 CRC32 4B LE] —— 不写 flash、
             *   不推进 RunningCRC，CRC_FAIL 才有判据。
             * type 0x02（双槽 §9.2）：[0x02][镜像CRC32 4B][maj][min][pat]
             *   [build LE32] —— 新固件版本 + 防回滚判据。 */
            if (frame_seq == 0xFF) {
                uint8_t meta_ok = 0;
                uint32_t expect = 0;
                if (frame_len == 5 && s_Parser.data[0] == 0x01) {
                    expect = (uint32_t)s_Parser.data[1]
                           | ((uint32_t)s_Parser.data[2] << 8)
                           | ((uint32_t)s_Parser.data[3] << 16)
                           | ((uint32_t)s_Parser.data[4] << 24);
                    s_ExpectedCRC = expect;
                    meta_ok = 1;
                    printf("META EXPECTED_CRC: 0x%08lX\r\n",
                           (unsigned long)s_ExpectedCRC);
                }
#if OTA_SLOT_COUNT > 1
                else if (frame_len == 12 && s_Parser.data[0] == 0x02) {
                    uint8_t new_ver[3];
                    new_ver[0] = s_Parser.data[5];
                    new_ver[1] = s_Parser.data[6];
                    new_ver[2] = s_Parser.data[7];
                    /* 防回滚（§9.2）：只管写坏的方向 —— 新镜像 version <
                       ACTIVE 槽版本 → 拒收（active 版本未知 0.0.0 时放行）。
                       跑的方向不管：回滚落旧槽不受限。 */
                    const uint8_t *act = s_BankRec.ver[s_BankRec.active];
                    if ((act[0] | act[1] | act[2]) != 0 &&
                        ota_ver_cmp(new_ver, act) < 0) {
                        printf("META VERSION REJECT: %u.%u.%u < active %u.%u.%u\r\n",
                               new_ver[0], new_ver[1], new_ver[2],
                               act[0], act[1], act[2]);
                    } else {
                        s_IncomingVer[0] = new_ver[0];
                        s_IncomingVer[1] = new_ver[1];
                        s_IncomingVer[2] = new_ver[2];
                        s_HaveIncomingVer = 1;
                        meta_ok = 1;
                        printf("META VERSION: %u.%u.%u build %lu\r\n",
                               new_ver[0], new_ver[1], new_ver[2],
                               (unsigned long)(
                                   (uint32_t)s_Parser.data[8]
                                 | ((uint32_t)s_Parser.data[9] << 8)
                                 | ((uint32_t)s_Parser.data[10] << 16)
                                 | ((uint32_t)s_Parser.data[11] << 24)));
                    }
                }
#endif
                Protocol_Parser_Init(&s_Parser);
                {
                    uint8_t pages = (uint8_t)(s_FlashWriteOffset / 1024);
                    uint8_t ack_param[3] = { meta_ok ? 0 : 1, 0xFF, pages };
                    Protocol_SendAck(g_Transport, RSP_ACK, ack_param, 3);
                }
                continue;
            }

            Protocol_Parser_Init(&s_Parser);        /* 复位解析器，下一帧 SOF 从 IDLE 开始 */

            /* 提取数据帧的载荷，逐字节拷贝到组包缓冲区 */
            for (uint8_t i = 0; i < frame_len; i++) {
                s_RxBuffer[s_RxCounter++] = s_Parser.data[i];

                if (s_RxCounter >= PACKET_SIZE) {
                    /* 满一包 → 写 Flash */
                    uint32_t currentAddr = Target_Addr() + s_FlashWriteOffset;

                    s_RunningCRC = CRC32_Update(s_RunningCRC, s_RxBuffer, PACKET_SIZE);

                    OtaFlashHal_WritePacket(currentAddr, (const uint32_t *)s_RxBuffer,
                                            PACKET_SIZE / 4);
                    s_FlashWriteOffset += PACKET_SIZE;

                    /* 每写完一页 (1024 字节) 记录偏移，用于断电续传 */
                    if (s_FlashWriteOffset % 1024 == 0) {
#if OTA_SLOT_COUNT > 1
                        OFFSET_SaveAt((uint16_t)(s_FlashWriteOffset / 1024), s_TargetSlot);
#else
                        OFFSET_Save((uint16_t)(s_FlashWriteOffset / 1024));
#endif
                    }

                    printf("Addr 0x%08lX | RUN_CRC 0x%08lX | RBUF %u\r\n",
                           (unsigned long)currentAddr,
                           (unsigned long)s_RunningCRC,
                           (unsigned)g_Transport->available());

                    s_RxCounter = 0;
                }
            }

            /* 回 ACK = {STATUS(0=OK), SEQ, PAGES} */
            {
                uint8_t ack_pages = (uint8_t)(s_FlashWriteOffset / 1024);
                uint8_t ack_param[3] = {0, frame_seq, ack_pages};
                Protocol_SendAck(g_Transport, RSP_ACK, ack_param, 3);
            }

            /* 最后一帧（载荷不足 128 字节）或零长度帧（结束标记）→ 自动结束升级 */
            if (frame_len < PACKET_SIZE) {
                if (s_RxCounter > 0) {
                    /* 残余数据补 0xFF 写满一包 */
                    while (s_RxCounter < PACKET_SIZE) {
                        s_RxBuffer[s_RxCounter++] = 0xFF;
                    }
                    uint32_t currentAddr = Target_Addr() + s_FlashWriteOffset;
                    s_RunningCRC = CRC32_Update(s_RunningCRC, s_RxBuffer, PACKET_SIZE);
                    OtaFlashHal_WritePacket(currentAddr, (const uint32_t *)s_RxBuffer,
                                            PACKET_SIZE / 4);
                    s_FlashWriteOffset += PACKET_SIZE;
                    s_RxCounter = 0;
                }

                s_RunningCRC = CRC32_Finish(s_RunningCRC);
                /* ── M5.3：预期 CRC 比对（主机经元数据帧下发）────────
                 * 不匹配 → STATE_CRC_FAIL + 复位：重启后 CheckState 命中
                 * CRC_FAIL 分支（WARNING + 等 '!' 重升）。未下发（=0，
                 * legacy 主机）保持源工程无条件 SUCCESS——零回归。 */
                if (s_ExpectedCRC != 0 && s_RunningCRC != s_ExpectedCRC) {
                    printf("\r\n=== CRC mismatch! expected 0x%08lX, got 0x%08lX ===\r\n",
                           (unsigned long)s_ExpectedCRC, (unsigned long)s_RunningCRC);
                    UPGRADE_SetState(STATE_CRC_FAIL);
                    OFFSET_Init();  /* 清偏移：重升从 0 开始（CRC_FAIL 分支还会整片擦除） */
                    printf("State=CRC_FAIL. Press KEY or send \"!\" to retry upgrade.\r\n");
                    printf("Resetting...\r\n");
                    OtaDelay_Ms(50);            /* 排空 UART，避免打印被复位截断 */
                    OtaSystemReset();
                    while (1) { /* 不可达 */ }
                }
                printf("\r\n=== Upgrade complete. Final CRC: 0x%08lX ===\r\n",
                       (unsigned long)s_RunningCRC);
                OFFSET_Init();      /* 清空偏移记录，下次升级从头开始 */
#if OTA_SLOT_COUNT > 1
                /* ── 双槽完成（§4.2）：SUCCESS 状态字作掉电检查点 →
                 * bank{active=新槽, pending=新槽, trial=3} → RUNNING → 复位。
                 * 复位后 boot 命中 pending 分支：trial 3→2 先减后跳 = 试运行第 1 次。 */
                UPGRADE_SetState(STATE_UPGRADE_SUCCESS);
                s_BankRec.active  = s_TargetSlot;
                s_BankRec.pending = s_TargetSlot;
                s_BankRec.trial   = 3;
                if (s_HaveIncomingVer) {
                    s_BankRec.ver[s_TargetSlot][0] = s_IncomingVer[0];
                    s_BankRec.ver[s_TargetSlot][1] = s_IncomingVer[1];
                    s_BankRec.ver[s_TargetSlot][2] = s_IncomingVer[2];
                }
                Bank_Set(&s_BankRec, STATE_UPGRADE_SUCCESS);
                UPGRADE_SetState(STATE_RUNNING);
                printf("Bank: active=%u pending=%u trial=3 (trial run)\r\n",
                       s_BankRec.active, s_BankRec.pending);
                printf("Reset to run APP (trial)...\r\n");
                OtaDelay_Ms(50);            /* 排空 UART，避免打印被复位截断 */
                OtaSystemReset();
                while (1) { /* 不可达 */ }
#else
                UPGRADE_SetState(STATE_UPGRADE_SUCCESS);
                printf("Reset to run APP.\r\n");
                while (1);  /* 防止后续串口噪声意外冲写 Flash */
#endif
            }

        } else if (result == FRAME_TYPE_CMD) {
            if (s_Parser.cmd == CMD_QUERY_OFFSET) {
                /* 查询当前写入页数 */
                uint16_t pages = OFFSET_Get();
                uint8_t param[2] = { (uint8_t)(pages & 0xFF), (uint8_t)((pages >> 8) & 0xFF) };
                printf("CMD_QUERY_OFFSET: %u pages\r\n", (unsigned)pages);
                Protocol_SendAck(g_Transport, RSP_OFFSET, param, 2);

            } else if (s_Parser.cmd == CMD_QUERY_STATE) {
                /* 查询当前升级状态 */
                UpgradeState st = UPGRADE_GetState();
                uint8_t param[4] = {
                    (uint8_t)(st & 0xFF),
                    (uint8_t)((st >> 8) & 0xFF),
                    (uint8_t)((st >> 16) & 0xFF),
                    (uint8_t)((st >> 24) & 0xFF)
                };
                printf("CMD_QUERY_STATE: 0x%08lX\r\n", (unsigned long)st);
                Protocol_SendAck(g_Transport, RSP_STATE, param, 4);

            } else if (s_Parser.cmd == CMD_RESET_UPGRADE) {
                /* 重置升级：清空偏移、擦除目标区、从头开始 */
                printf("\r\n=== CMD_RESET_UPGRADE: Restarting from scratch ===\r\n");
                Boot_EraseAppAndReset();
                s_FlashWriteOffset = 0;
                s_RxCounter = 0;
                {
                    uint8_t ack_param[3] = {0, 0, 0};  /* STATUS=OK, SEQ=0, PAGES=0 */
                    Protocol_SendAck(g_Transport, RSP_ACK, ack_param, 3);
                }
                printf("Erase done, ready to receive firmware.\r\n");

#if defined(OTA_VER_MAJOR)
            } else if (s_Parser.cmd == CMD_QUERY_VERSION) {
                /* ★ 双槽方案 §9.2：版本查询（7B：maj/min/patch + build LE32）。
                   仅当工程声明 version（gen 头注入 OTA_VER_*）时编译本命令；
                   未声明版本 → 命令不存在 → 走 NAK，协议面零变化。 */
                uint8_t param[7];
#if defined(OTA_VER_BUILD)
                uint32_t build_no = OTA_VER_BUILD;
#else
                uint32_t build_no = 0;
#endif
                param[0] = OTA_VER_MAJOR;
                param[1] = OTA_VER_MINOR;
                param[2] = OTA_VER_PATCH;
                param[3] = (uint8_t)(build_no & 0xFF);
                param[4] = (uint8_t)((build_no >> 8) & 0xFF);
                param[5] = (uint8_t)((build_no >> 16) & 0xFF);
                param[6] = (uint8_t)((build_no >> 24) & 0xFF);
                printf("CMD_QUERY_VERSION: %u.%u.%u build %lu\r\n",
                       OTA_VER_MAJOR, OTA_VER_MINOR, OTA_VER_PATCH,
                       (unsigned long)build_no);
                Protocol_SendAck(g_Transport, RSP_VERSION, param, 7);
#endif /* OTA_VER_MAJOR */

            } else if (!OtaProtocol_DispatchExt(g_Transport, &s_Parser)) {
                /* 未知命令 → 回复 NAK + 未知的命令字（扩展命令未注册时同样走这里） */
                Protocol_SendAck(g_Transport, RSP_NAK, &s_Parser.cmd, 1);
            }

            Protocol_Parser_Init(&s_Parser);
        }
    }
}

void OtaBootFlow_Run(void)
{
    OtaBootFlow_CheckState();
    while (1) {
        OtaBootFlow_ProcessRX();
    }
}
