# ======================================================================
# components/components.cmake — 组件注册入口（被业务工程 include）
#
# 用法（业务工程 CMakeLists，方案 §3.4）：
#   include(${ELAB_ROOT}/components/components.cmake)
#   elab_use_component(<target> serial PLATFORM stm32f4)
#   elab_use_component(<target> ota    VARIANT boot PLATFORM stm32f4
#                       LAYOUT_HEADER ota_layout_f411.h CAP_BITMAP 0x3)
#
# ★ 能力位图单一数据源（§6.1 硬约束 #6）：
#   MCU 侧 ota_cap.c / 上位机 capabilities.json 均从本注册表派生，
#   禁止各自硬编码。bit0=ota, bit1=serial（bit2+ 预留）。
# ======================================================================

# ELAB_ROOT 自举：被 include 时 CMAKE_CURRENT_LIST_DIR 即 components/
if(NOT ELAB_ROOT)
    get_filename_component(ELAB_ROOT "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
endif()

# ── 组件注册表（新增组件在此登记三行）────────────────────────────
#   ELAB_COMP_CAP_<name>   能力位（1<<n），与 ota_cap.h / capabilities.json 对齐
#   ELAB_COMP_DEP_<name>   依赖组件列表（接入时自动递归 elab_use_component）
#   ELAB_COMP_BOARD_<name> boot 变体才需要的依赖（app 变体不接）
set(ELAB_COMP_CAP_ota      1)          # bit0
set(ELAB_COMP_CAP_serial   2)          # bit1
set(ELAB_COMP_DEP_ota      "")         # 默认无依赖
set(ELAB_COMP_BOARD_ota    "serial")   # ★ 仅 boot 变体依赖 serial（OTA 实例）
set(ELAB_COMP_DEP_serial   "")

set(ELAB_COMPONENTS ota serial)

# ── capabilities.json（上位机能力位图翻译，M0 产出）──────────────
# configure 阶段生成到 components/capabilities.json（入库文件即最新产物，
# 便于 diff 审查与 host 端打包）
function(_elab_generate_capabilities_json)
    set(_cap_json "{\n  \"//\": \"由 components/components.cmake configure 生成（单一数据源），勿手改\",\n  \"version\": 1,\n  \"bits\": {\n")
    set(_first TRUE)
    foreach(_comp IN LISTS ELAB_COMPONENTS)
        if(NOT _first)
            string(APPEND _cap_json ",\n")
        endif()
        set(_first FALSE)
        string(APPEND _cap_json "    \"${_comp}\": ${ELAB_COMP_CAP_${_comp}}")
    endforeach()
    string(APPEND _cap_json "\n  }\n}\n")
    file(WRITE "${ELAB_ROOT}/components/capabilities.json" "${_cap_json}")
endfunction()
_elab_generate_capabilities_json()

# ── elab_use_component(<target> <name> [VARIANT boot|app]
#                       [PLATFORM <plat>] [LAYOUT_HEADER <h>] [CAP_BITMAP <n>])
# 语义（方案 §3.4）：
#   1. add_subdirectory(components/<name>)
#   2. target_link_libraries(<target> <name>_port_<plat> ...)，并传导 PUBLIC 头
#   3. ota 组件按 VARIANT 选源（boot 含状态机/app 含 hook，见其 CMakeLists）
#   4. DEPENDS 声明的组件自动递归接入（boot 变体才需要 ota→serial）
function(elab_use_component target name)
    cmake_parse_arguments(COMP "" "VARIANT;PLATFORM;LAYOUT_HEADER;CAP_BITMAP" "" ${ARGN})

    if(NOT COMP_PLATFORM)
        message(FATAL_ERROR "elab_use_component(${name}): PLATFORM 必填（stm32f4|at32|stm32f1）")
    endif()

    # ---- ota 特有参数 → 子目录变量 ----
    if(name STREQUAL "ota")
        set(OTA_PLATFORM ${COMP_PLATFORM} PARENT_SCOPE)     # 兄弟目录也能看到
        set(OTA_PLATFORM ${COMP_PLATFORM})
        if(COMP_VARIANT)
            set(OTA_VARIANT ${COMP_VARIANT})
        endif()
        if(COMP_LAYOUT_HEADER)
            set(OTA_LAYOUT_HEADER ${COMP_LAYOUT_HEADER})
        endif()
        if(COMP_CAP_BITMAP)
            set(OTA_CAP_BITMAP ${COMP_CAP_BITMAP})
        endif()
    elseif(name STREQUAL "serial")
        set(SERIAL_PLATFORM ${COMP_PLATFORM})
        set(SERIAL_PLATFORM ${COMP_PLATFORM} PARENT_SCOPE)
    endif()

    # ---- 依赖递归（先接依赖再接自己，保证 target 已存在）----
    set(_deps ${ELAB_COMP_DEP_${name}})
    if(name STREQUAL "ota" AND (NOT COMP_VARIANT OR COMP_VARIANT STREQUAL "boot"))
        set(_deps ${_deps} ${ELAB_COMP_BOARD_ota})          # boot 变体才接 serial
    endif()
    foreach(_dep IN LISTS _deps)
        if(NOT TARGET ${_dep}_port_${COMP_PLATFORM} AND NOT TARGET ${_dep}_core)
            elab_use_component(${target} ${_dep} PLATFORM ${COMP_PLATFORM})
        endif()
    endforeach()

    # ---- add_subdirectory + 链接 ----
    # ★ 用 plain 签名：业务工程（CubeMX 生成）常以 plain 调用 target_link_libraries，
    #   同一 target 不允许 keyword/plain 混用。
    # ★ start/end-group 包裹：core 与 port 符号互相引用（app_hook → upgrade_state
    #   → flash_store → flash_hal），静态库线性扫描解不开环（f411 APP 实测
    #   undefined reference）—— group 让 ld 迭代解析。
    add_subdirectory(${ELAB_ROOT}/components/${name}
                     ${CMAKE_BINARY_DIR}/components/${name})
    target_link_libraries(${target} -Wl,--start-group)
    if(TARGET ${name}_core)
        target_link_libraries(${target} ${name}_core)
    endif()
    target_link_libraries(${target} ${name}_port_${COMP_PLATFORM})
    target_link_libraries(${target} -Wl,--end-group)

    # ---- 芯片 SDK include / define 传导 ----
    # 组件只 include 芯片 SDK（stm32f4xx_hal.h 等），路径与器件宏
    # （STM32F411xE 等）由业务工程持有。传导来源两路：
    #   ① 业务 target 自身 INCLUDE_DIRECTORIES / COMPILE_DEFINITIONS；
    #   ② 其链接目标（CubeMX 生成的 stm32cubemx 接口库等）的
    #      INTERFACE_INCLUDE_DIRECTORIES / INTERFACE_COMPILE_DEFINITIONS。
    # ★ 约定：业务工程先完成 include/define/链接声明再调 elab_use_component。
    set(_proj_incs "")
    set(_proj_defs "")
    get_target_property(_d ${target} INCLUDE_DIRECTORIES)
    if(_d)
        list(APPEND _proj_incs ${_d})
    endif()
    get_target_property(_d ${target} COMPILE_DEFINITIONS)
    if(_d)
        list(APPEND _proj_defs ${_d})
    endif()
    get_target_property(_links ${target} LINK_LIBRARIES)
    if(_links)
        foreach(_lk IN LISTS _links)
            if(TARGET ${_lk})
                get_target_property(_d ${_lk} INTERFACE_INCLUDE_DIRECTORIES)
                if(_d)
                    list(APPEND _proj_incs ${_d})
                endif()
                get_target_property(_d ${_lk} INTERFACE_COMPILE_DEFINITIONS)
                if(_d)
                    list(APPEND _proj_defs ${_d})
                endif()
            endif()
        endforeach()
    endif()
    foreach(_ct ${name}_core ${name}_port_${COMP_PLATFORM})
        if(TARGET ${_ct})
            if(_proj_incs)
                target_include_directories(${_ct} PUBLIC ${_proj_incs})
            endif()
            if(_proj_defs)
                target_compile_definitions(${_ct} PUBLIC ${_proj_defs})
            endif()
        endif()
    endforeach()
endfunction()
