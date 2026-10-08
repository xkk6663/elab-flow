# ======================================================================
# components/ota/CMakeLists.txt — OTA 组件（elab「一切皆组件」）
#
# 可调变量（父作用域传入）：
#   OTA_PLATFORM       stm32f4 | at32 | stm32f1     （必填）
#   OTA_VARIANT        boot     | app               （默认 boot）
#   OTA_LAYOUT_HEADER  "ota_layout_<chip>.h"        （必填，方案 §3.2 配置面）
#   OTA_CAP_BITMAP     组件位图（可选，v1.2 组件发现；如 0x1）
#
# 产物：
#   ota_core         协议/存储/续传/状态机 + 场景层（按 VARIANT 裁剪源文件）
#   ota_port_<plat>  芯片 HAL 映射（flash/delay/jump/key/printf 或 app_hook）
# ======================================================================

set(OTA_DIR ${CMAKE_CURRENT_SOURCE_DIR})

if(NOT OTA_PLATFORM)
    message(FATAL_ERROR "OTA_PLATFORM 未设置（stm32f4|at32|stm32f1）")
endif()
if(NOT OTA_LAYOUT_HEADER)
    message(FATAL_ERROR "OTA_LAYOUT_HEADER 未设置（如 ota_layout_f411.h，见方案 §3.2）")
endif()
if(NOT OTA_VARIANT)
    set(OTA_VARIANT boot)
endif()

# ── core：唯一真源（芯片无关）────────────────────────────────────
set(OTA_CORE_SOURCES
    core/ota_protocol.c
    core/ota_flash_store.c
    core/ota_offset.c
    core/ota_upgrade_state.c
    core/ota_crc32.c
    core/ota_transport.c
    core/ota_cap.c             # v1.2 组件发现（可选编入，未初始化时 0x15 走 NAK）
    core/ota_bank.c            # ★ 双槽 bank 记录（单槽芯片内部全剔除，零代码）
    core/ota_confirm.c         # ★ 双槽 app 侧确认（单槽 = 空操作，零回归）
)

if(OTA_VARIANT STREQUAL "boot")
    list(APPEND OTA_CORE_SOURCES core/ota_boot_flow.c)     # boot 状态机场景层
endif()

add_library(ota_core STATIC ${OTA_CORE_SOURCES})
target_include_directories(ota_core PUBLIC
    ${OTA_DIR}/core
    ${OTA_DIR}/port/${OTA_PLATFORM}
)
# 布局常量由 port 布局头提供（§3.2 配置面改造，core 功能代码零改动）
target_compile_definitions(ota_core PUBLIC OTA_LAYOUT_HEADER="${OTA_LAYOUT_HEADER}")
if(DEFINED OTA_CAP_BITMAP)
    target_compile_definitions(ota_core PUBLIC OTA_CAP_BITMAP=${OTA_CAP_BITMAP})
endif()

# ── port：芯片 HAL 映射（只准调芯片 SDK 与组件 core，§3.5 规则 #3）──
set(OTA_PORT_BOOT_SOURCES
    port/${OTA_PLATFORM}/ota_flash_hal.c
    port/${OTA_PLATFORM}/ota_delay.c
    port/${OTA_PLATFORM}/ota_jump.c
    port/${OTA_PLATFORM}/ota_key.c
    port/${OTA_PLATFORM}/ota_printf.c
)
set(OTA_PORT_APP_SOURCES
    port/${OTA_PLATFORM}/ota_app_hook.c     # '!'×5 + 停机回调位 + 可选发现应答
    port/${OTA_PLATFORM}/ota_delay.c        # hook 2s 排空延时复用
    port/${OTA_PLATFORM}/ota_flash_hal.c    # UPGRADE_SetState 写状态槽必需
)

if(OTA_VARIANT STREQUAL "boot")
    set(OTA_PORT_SOURCES ${OTA_PORT_BOOT_SOURCES})
else()
    set(OTA_PORT_SOURCES ${OTA_PORT_APP_SOURCES})
endif()

add_library(ota_port_${OTA_PLATFORM} STATIC ${OTA_PORT_SOURCES})
target_include_directories(ota_port_${OTA_PLATFORM} PUBLIC
    ${OTA_DIR}/port/${OTA_PLATFORM}
)
target_link_libraries(ota_port_${OTA_PLATFORM} PUBLIC ota_core)

# ★ printf 重定向契约：强制拉入 ota_printf.o（含强 _write/fputc 覆盖 syscalls 弱符号）。
#   静态库成员按需拉取 —— boot_flow.c 只调 printf（libc），不会引用本成员，
#   不显式 -u 时链接器会用 libc 弱桩（printf 静默无输出，f411_boot 实测）。
if(OTA_PLATFORM STREQUAL "stm32f1")
    target_link_options(ota_port_${OTA_PLATFORM} INTERFACE "-Wl,--undefined=fputc")
else()
    target_link_options(ota_port_${OTA_PLATFORM} INTERFACE "-Wl,--undefined=__io_putchar")
endif()
