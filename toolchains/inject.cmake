# toolchains/inject.cmake —— 芯片参数"盖章" + 工程自述变量"补齐"
# 挂载方式：cmake -DCMAKE_PROJECT_INCLUDE=<本文件>
# 执行时机：顶层 project() 之后、add_executable / add_subdirectory 之前。
#
# 为什么需要它 —— 实测两种工程各有一个原因：
#   【B 类】工程在 CMakeLists 里 hard include 自带工具链（AT32_TEST line 22）
#          → 把 elab 的 flags/链接脚本重新盖一遍 → 必须在这里"抢回来"
#   【A 类】工程的自述参数寄生在它自己的工具链文件里（STM32_TEST 的
#          cmake/gcc-arm-none-eabi.cmake 定义了 TOOLCHAIN_LINK_LIBRARIES="m"，
#          被 cmake/stm32cubemx/CMakeLists.txt 的 MX_LINK_LIBS 引用）
#          → elab 用 -DCMAKE_TOOLCHAIN_FILE 接管后该变量丢失 → 必须在这里"补回来"

message(STATUS "[elab] inject.cmake active (chip=${ELAB_CHIP}) —— 盖章芯片参数 + 补齐工程自述变量")

# ── 芯片参数 ──────────────────────────────────────────────────────
if(NOT DEFINED ELAB_CPU)
    set(ELAB_CPU "cortex-m4")
endif()
if(NOT DEFINED ELAB_FPU)
    set(ELAB_FPU "soft")
endif()
if(ELAB_FPU STREQUAL "" OR ELAB_FPU STREQUAL "none")
    set(_elab_fpu_flags "")
    set(_elab_fpu_arg "")
else()
    set(_elab_fpu_flags "-mfloat-abi=${ELAB_FPU}")
    set(_elab_fpu_arg "-mfloat-abi=${ELAB_FPU}")
endif()
set(_elab_flags "-mcpu=${ELAB_CPU} ${_elab_fpu_flags}")

# 覆盖 flags（目录作用域；目标在此之后创建即继承）
set(CMAKE_C_FLAGS         "${_elab_flags} -ffunction-sections -fdata-sections -Wall -Wextra -std=gnu11")
set(CMAKE_ASM_FLAGS       "${_elab_flags} -x assembler-with-cpp")
set(CMAKE_C_FLAGS_DEBUG   "-O0 -g3")
set(CMAKE_C_FLAGS_RELEASE "-Os -g0")

# ── 链接参数 ──────────────────────────────────────────────────────
set(_elab_link_flags "")
if(DEFINED ELAB_LD AND NOT ELAB_LD STREQUAL "")
    set(_elab_link_flags "${_elab_flags} -T \"${ELAB_LD}\" -Wl,--gc-sections -Wl,--print-memory-usage --specs=nano.specs")
endif()

# ★ N6 修复：-Wl,-Map 的归属。两种工程各丢一次，原因正好相反：
#   【B 类】AT32 的 CMakeLists line 22 在 project() 之前 include 了自带工具链，
#          其 gcc-arm-none-eabi.cmake line 41 把 -Wl,-Map=${CMAKE_PROJECT_NAME}.map
#          放进 CMAKE_C_LINK_FLAGS；B 类通道下本文件的重写、A 类通道下的
#          unset(CMAKE_C_LINK_FLAGS) 都会让它消失，且无人补回。
#   【A 类】STM32 的工具链只挂在 CMakePresets 的 toolchainFile 上，elab 用
#          -DCMAKE_TOOLCHAIN_FILE 接管后该文件【根本不执行】→ 从未有过 Map；
#          而盖章又是整体覆盖对应变量，也没有它。
#   结论：map 是 elab 对 projects/*.yaml → artifacts.map 的承诺，就该由 elab 盖章。
#   路径由 plan.py 显式传入（-DELAB_MAP_FILE），不从 ${CMAKE_PROJECT_NAME} 反推。
if(DEFINED ELAB_MAP_FILE AND NOT ELAB_MAP_FILE STREQUAL "")
    set(_elab_link_flags "${_elab_link_flags} -Wl,-Map=\"${ELAB_MAP_FILE}\"")
endif()

# ── ★ C33：盖章通道选择（ELAB_LINK_CHANNEL，plan.py 按 build.link_channel 下传）──
#
# 【exe_flags —— 默认，A 类】盖章进 CMAKE_EXE_LINKER_FLAGS + 清空 CMAKE_C_LINK_FLAGS。
#   A 类工程的自带工具链根本不执行，C flags 通道没有遗留值，清空只是防身。
#
# 【c_flags —— B 类 OTA 双镜像工程】盖章进 CMAKE_C_LINK_FLAGS（C/CXX 同步），不动
#   CMAKE_EXE_LINKER_FLAGS。为什么必须换通道 —— bootloader 子目录的双 -T 困局：
#   业务工程的 bootloader/CMakeLists 在 add_subdirectory 时执行
#       string(REPLACE "-T \"${CMAKE_SOURCE_DIR}/AT32F421x8_APP.ld\"" "" CMAKE_C_LINK_FLAGS ...)
#   这道防身只清 C flags 通道。若 elab 把 -T APP.ld 盖在 EXE flags（默认通道），
#   REPLACE 无物可删 → bootloader 链接行 = EXE 盖章的 -T APP.ld + target 自己的
#   -T BOOT.ld = 双 -T → 两个 SECTIONS 合并，.init_array/.data 布局异常，
#   printf 内部跑飞（M1 实测实锤）。改盖 C flags 通道后：
#     - 顶层 APP：elab 盖章整体覆盖工程行内 include 写的那份 → 单 -T（同路径）；
#     - bootloader：REPLACE 从 C flags 里删掉 -T APP.ld（elab 盖的路径与 needle
#       逐字节同形，前提 linker_script 指向工程根的同一个 APP.ld）→ 只剩
#       target 的 -T BOOT.ld，M1 坑在 elab 接管下不复发；
#     - 零改动业务工程（C4）：不依赖也不修改 bootloader 的任何文件。
#   代价（可接受）：bootloader 链接行会继承盖章里除 -T 外的部分
#   （nano.specs / --gc-sections / --print-memory-usage / -Map）。双 -Map 由
#   bootloader 自己的 -Map 后置覆盖，无害；--gc-sections 要求 BOOT.ld 对入口/
#   向量表段有 KEEP（工程自带 BOOT.ld 已满足，APP 侧同一脚本形态实测无恙）。
if(NOT _elab_link_flags STREQUAL "")
    if(DEFINED ELAB_LINK_CHANNEL AND ELAB_LINK_CHANNEL STREQUAL "c_flags")
        set(CMAKE_C_LINK_FLAGS   "${_elab_link_flags}")
        set(CMAKE_CXX_LINK_FLAGS "${_elab_link_flags}")
        # ★ c_flags 通道必须同时清空 EXE 通道：toolchains/gcc.cmake（工具链
        #   文件，project() 之前执行）已经在 CMAKE_EXE_LINKER_FLAGS 盖过一份
        #   同内容的章（gcc.cmake line 65-78）。不清的话链接行出现两份
        #   --specs=nano.specs → gcc driver 报 "attempt to rename spec 'link'
        #   to already defined spec 'nano_link'"（实测 build-failed）。
        #   A 类/exe_flags 通道无此问题——下面的整体覆盖天然清掉了它。
        set(CMAKE_EXE_LINKER_FLAGS "")
        message(STATUS "[elab] 盖章通道 c_flags（C33：B 类 OTA 双镜像，bootloader REPLACE 防身保持生效）")
    else()
        set(CMAKE_EXE_LINKER_FLAGS "${_elab_link_flags}")
        # ★ B 类实测坑：工程自带工具链用的是 CMAKE_C_LINK_FLAGS（AT32 的
        #   gcc-arm-none-eabi.cmake 第 38-43 行），与 CMAKE_EXE_LINKER_FLAGS 是
        #   【不同名的变量】，CMake 会把两份都拼进链接行 → 出现两遍 -mcpu /
        #   两遍 -T / 两遍 --print-memory-usage。若两源参数恰好一致，目前只是
        #   "冗余"；一旦不一致，会出现两个不同 -T（后者生效）= 静默错误。
        #   A 类通道下必须显式清掉工程留下的那一份。
        unset(CMAKE_C_LINK_FLAGS)
        unset(CMAKE_CXX_LINK_FLAGS)
    endif()
endif()

# ── 工程自述变量补齐（A 类）───────────────────────────────────────
# STM32_TEST 的 MX_LINK_LIBS 依赖 ${TOOLCHAIN_LINK_LIBRARIES}，该变量定义在
# 它自己的工具链文件里。elab 接管工具链后需补回，否则 libm 不会参与链接。
if(NOT DEFINED TOOLCHAIN_LINK_LIBRARIES)
    set(TOOLCHAIN_LINK_LIBRARIES "m")
    message(STATUS "[elab] 补齐 TOOLCHAIN_LINK_LIBRARIES=m（工程自述变量，原属其自带工具链文件）")
endif()

# 目录级选项，确保后续 add_subdirectory 也继承
# ★ 实测坑：不能写 add_compile_options(${_elab_flags})——整串会被当成【单个带引号的参数】，
#   gcc 报 "unrecognized -mcpu target: cortex-m4 -mfloat-abi=soft"。必须拆成独立参数。
add_compile_options(-mcpu=${ELAB_CPU} ${_elab_fpu_arg})
