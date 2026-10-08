cmake_minimum_required(VERSION 3.22)

# ======================================================================
# F411CEU6_BOOT —— Bootloader 薄工程（方案 §4，archetype A：elab -D 全接管）
#
# 无 CubeMX：startup（复用 APP 的）+ BOOT.ld(32K) + 薄 main.c + 组件。
# 业务源只有 main.c（SystemClock_Config 与 APP 逐段一致）；
# 升级流程 100% 在 components/ota（VARIANT=boot）。
#
# CPU 旗标 / 链接脚本 / nano.specs 由 elab toolchains 下传（gcc.cmake + inject.cmake）；
# ELAB_LD 未定义时（脱离 elab 独立构建）回落到本目录 BOOT.ld。
# ======================================================================

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS TRUE)

# elab-flow 仓库根（components.cmake 自举兜底用）
get_filename_component(ELAB_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)

set(CMAKE_PROJECT_NAME f411_boot)
project(${CMAKE_PROJECT_NAME})
enable_language(C ASM)

# APP 工程根（HAL 驱动单一真源，不拷贝）
set(APP_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../STM32F411CEU6)

add_executable(${CMAKE_PROJECT_NAME}
    ${CMAKE_CURRENT_SOURCE_DIR}/main.c
    ${CMAKE_CURRENT_SOURCE_DIR}/startup_stm32f411xe.s
    # HAL 最小集：boot 只用 Init/RCC/Cortex/GPIO/Flash/PWR
    ${APP_ROOT}/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal.c
    ${APP_ROOT}/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_cortex.c
    ${APP_ROOT}/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_rcc.c
    ${APP_ROOT}/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_rcc_ex.c
    ${APP_ROOT}/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_gpio.c
    ${APP_ROOT}/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_flash.c
    ${APP_ROOT}/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_flash_ex.c
    ${APP_ROOT}/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_pwr.c
    ${APP_ROOT}/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_pwr_ex.c
    ${APP_ROOT}/Core/Src/system_stm32f4xx.c      # SystemCoreClock / AHBPrescTable
    ${APP_ROOT}/Core/Src/syscalls.c              # newlib stubs（_write 由组件强符号覆盖）
)

target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE
    ${APP_ROOT}/Core/Inc
    ${APP_ROOT}/Drivers/STM32F4xx_HAL_Driver/Inc
    ${APP_ROOT}/Drivers/CMSIS/Device/ST/STM32F4xx/Include
    ${APP_ROOT}/Drivers/CMSIS/Include
)

target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE
    USE_HAL_DRIVER
    STM32F411xE
)

# 独立构建兜底：elab 接管时 inject.cmake 会以 -DELAB_LD 下传链接脚本
if(NOT DEFINED ELAB_LD)
    target_link_options(${CMAKE_PROJECT_NAME} PRIVATE
        -T ${CMAKE_CURRENT_SOURCE_DIR}/BOOT.ld
        -Wl,--gc-sections
        --specs=nano.specs
    )
endif()

# ── 组件接入（方案 §3.4）────────────────────────────────────────
# serial：Transport_USART1（boot 收发）
# ota   ：VARIANT=boot（状态机场景层；serial 依赖自动递归）
# 位图 0x3 = ota(bit0) + serial(bit1) —— BOOT 同时具备两者
include(${ELAB_ROOT}/components/components.cmake)
elab_use_component(${CMAKE_PROJECT_NAME} ota VARIANT boot PLATFORM stm32f4
                   LAYOUT_HEADER ota_layout_f411.h CAP_BITMAP 0x3)
