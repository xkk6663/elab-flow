#include "ota_crc32.h"

/**
 * @brief  获取 CRC32 初始值 (用于增量计算)
 * @return 初始 CRC 状态
 */
uint32_t CRC32_Start(void)
{
    return 0xFFFFFFFF;
}

/**
 * @brief  增量更新 CRC32 (对同一批数据分多次调用)
 * @param  crc: 当前 CRC 状态 (首次调用前先用 CRC32_Start())
 * @param  data: 本次要处理的数据
 * @param  length: 本次数据的字节数
 * @return 更新后的 CRC 状态
 */
uint32_t CRC32_Update(uint32_t crc, const uint8_t *data, uint32_t length)
{
    for (uint32_t i = 0; i < length; i++)
    {
        crc ^= data[i];

        for (int j = 0; j < 8; j++)
        {
            if (crc & 1)
            {
                crc = (crc >> 1) ^ 0xEDB88320;
            }
            else
            {
                crc >>= 1;
            }
        }
    }

    return crc;
}

/**
 * @brief  结束 CRC32 增量计算，返回最终校验值
 * @param  crc: CRC32_Update() 返回的最后状态
 * @return 32位 CRC32 校验码
 */
uint32_t CRC32_Finish(uint32_t crc)
{
    return crc ^ 0xFFFFFFFF;
}

/**
 * @brief  标准 CRC32 纯软件计算 (一步到位)
 * @param  data: 要校验的数据首地址
 * @param  length: 校验的总字节数
 * @return 32位 CRC32 校验码
 */
uint32_t Software_CRC32(const uint8_t *data, uint32_t length)
{
    return CRC32_Finish(CRC32_Update(CRC32_Start(), data, length));
}
