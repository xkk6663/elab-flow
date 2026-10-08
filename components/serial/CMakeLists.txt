# ======================================================================
# components/serial/CMakeLists.txt — 串口组件（一切皆组件：serial 独立成件）
#
# 可调变量（父作用域传入）：
#   SERIAL_PLATFORM    stm32f4 | at32 | stm32f1     （必填）
#
# 产物：
#   serial_port_<plat> STATIC（Transport_USART1 实例 + GPIO/USART/DMA 配置）
#
# 依赖说明：Transport 类型来自 ota/core/ota_transport.h（方案 §3.1 裁决：
#   抽象留 ota core，实现来自 serial；依赖方向 ota(boot) → serial 实例）。
# ======================================================================

set(SERIAL_DIR ${CMAKE_CURRENT_SOURCE_DIR})

if(NOT SERIAL_PLATFORM)
    message(FATAL_ERROR "SERIAL_PLATFORM 未设置（stm32f4|at32|stm32f1）")
endif()

add_library(serial_port_${SERIAL_PLATFORM} STATIC
    port/${SERIAL_PLATFORM}/serial_usart1_dma.c
)
# 平台线束选择宏（serial_config.h 按 -DSERIAL_PLAT_* 分支）
if(SERIAL_PLATFORM STREQUAL "stm32f4")
    set(SERIAL_PLAT_MACRO SERIAL_PLAT_STM32F4)
elseif(SERIAL_PLATFORM STREQUAL "at32")
    set(SERIAL_PLAT_MACRO SERIAL_PLAT_AT32)
elseif(SERIAL_PLATFORM STREQUAL "stm32f1")
    set(SERIAL_PLAT_MACRO SERIAL_PLAT_STM32F1)
endif()
target_compile_definitions(serial_port_${SERIAL_PLATFORM} PUBLIC ${SERIAL_PLAT_MACRO})
target_include_directories(serial_port_${SERIAL_PLATFORM} PUBLIC
    ${SERIAL_DIR}/core
    ${SERIAL_DIR}/port/${SERIAL_PLATFORM}
    ${SERIAL_DIR}/../ota/core        # Transport 抽象头（类型来源）
)
