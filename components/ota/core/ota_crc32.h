#ifndef OTA_CRC32_H
#define OTA_CRC32_H

#include <stdint.h>

/**
 * @brief  获取 CRC32 初始值 (用于增量计算)
 * @return 初始 CRC 状态
 */
uint32_t CRC32_Start(void);

/**
 * @brief  增量更新 CRC32 (对同一批数据分多次调用)
 * @param  crc: 当前 CRC 状态 (首次调用前先用 CRC32_Start())
 * @param  data: 本次要处理的数据
 * @param  length: 本次数据的字节数
 * @return 更新后的 CRC 状态
 *
 * @note   所有数据块处理完后，调用 CRC32_Finish() 得到最终结果
 */
uint32_t CRC32_Update(uint32_t crc, const uint8_t *data, uint32_t length);

/**
 * @brief  结束 CRC32 增量计算，返回最终校验值
 * @param  crc: CRC32_Update() 返回的最后状态
 * @return 32位 CRC32 校验码
 */
uint32_t CRC32_Finish(uint32_t crc);

/**
 * @brief  标准 CRC32 纯软件计算 (一步到位)
 * @param  data: 要校验的数据首地址
 * @param  length: 校验的总字节数
 * @return 32位 CRC32 校验码
 *
 * @note   多项式 0x04C11DB7 → 反射后 0xEDB88320
 *         符合标准 CRC-32 (Ethernet / ZIP / PKZIP)
 */
uint32_t Software_CRC32(const uint8_t *data, uint32_t length);

#endif /* OTA_CRC32_H */
