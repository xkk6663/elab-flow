# toolchains/gcc.cmake —— 工具链适配层（L2）· 通用 GCC 工具链文件
# 由 elab 驱动，参数来自 elab.host.yaml（主机）+ chips/*.yaml（芯片）。
# 作用：替代每个芯片手写一份的 gcc-arm-none-eabi.cmake。
#
# 【试验版】仅覆盖接入 AT32_TEST 所需的最小子集。

set(CMAKE_SYSTEM_NAME               Generic)
set(CMAKE_SYSTEM_PROCESSOR          arm)
set(CMAKE_TRY_COMPILE_TARGET_TYPE   STATIC_LIBRARY)   # 跳过 target 链接自检

# ── 交叉编译器路径（来自 elab.host.yaml，命令行注入）──────────────
if(NOT DEFINED ELAB_ARM_GCC_ROOT OR ELAB_ARM_GCC_ROOT STREQUAL "")
    set(ELAB_ARM_GCC_ROOT "C:/DevEnv/GNU-tools-for-STM32")
    message(STATUS "[elab] ELAB_ARM_GCC_ROOT 未注入，回落默认值")
endif()

if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Windows")
    set(_elab_exe ".exe")
else()
    set(_elab_exe "")
endif()
set(_elab_bin "${ELAB_ARM_GCC_ROOT}/bin")
message(STATUS "[elab] toolchain root = ${ELAB_ARM_GCC_ROOT}")

set(CMAKE_C_COMPILER   "${_elab_bin}/arm-none-eabi-gcc${_elab_exe}")
set(CMAKE_ASM_COMPILER "${_elab_bin}/arm-none-eabi-gcc${_elab_exe}")
set(CMAKE_CXX_COMPILER "${_elab_bin}/arm-none-eabi-gcc${_elab_exe}")
set(CMAKE_OBJCOPY      "${_elab_bin}/arm-none-eabi-objcopy${_elab_exe}")
set(CMAKE_SIZE         "${_elab_bin}/arm-none-eabi-size${_elab_exe}")

# 产物统一加 .elf 后缀（elab 的通用约定，对所有芯片一致）
# ★ 实测发现：这是"A 类工程静默丢约定"的一个典型——STM32_TEST 自带的
#   cmake/gcc-arm-none-eabi.cmake 第 18-20 行设了 CMAKE_EXECUTABLE_SUFFIX_*=."elf"，
#   elab 接管工具链后若不带，产物会变成无后缀的 `TEST`，构建"成功"但
#   projects/*.yaml 的 artifacts.elf 指向的文件不存在 → 后续 flash 找不到文件。
set(CMAKE_EXECUTABLE_SUFFIX_ASM ".elf")
set(CMAKE_EXECUTABLE_SUFFIX_C   ".elf")
set(CMAKE_EXECUTABLE_SUFFIX_CXX ".elf")

# ── 芯片相关 flag（来自 chips/*.yaml）─────────────────────────────
# 本文件对【所有芯片】通用：差异化只由 ELAB_CPU / ELAB_FPU 两个值驱动。
# 试验版从 -DELAB_* 读；正式版由 elab 解析 YAML 后注入。
if(NOT DEFINED ELAB_CPU)
    set(ELAB_CPU "cortex-m4")
endif()
if(NOT DEFINED ELAB_FPU)
    set(ELAB_FPU "soft")
endif()

# FPU 支持三种取值：soft / hard / none
#   none → 完全不产出 -mfloat-abi（Cortex-M3 等无 FPU 内核，如 STM32F103）
if(ELAB_FPU STREQUAL "" OR ELAB_FPU STREQUAL "none")
    set(_elab_fpu_flags "")
else()
    set(_elab_fpu_flags "-mfloat-abi=${ELAB_FPU}")
endif()

set(_elab_target_flags "-mcpu=${ELAB_CPU} ${_elab_fpu_flags}")
set(CMAKE_C_FLAGS          "${_elab_target_flags} -ffunction-sections -fdata-sections -Wall -Wextra -std=gnu11")
set(CMAKE_ASM_FLAGS        "${_elab_target_flags} -x assembler-with-cpp")
set(CMAKE_C_FLAGS_DEBUG    "-O0 -g3")
set(CMAKE_C_FLAGS_RELEASE  "-Os -g0")

if(DEFINED ELAB_LD AND NOT ELAB_LD STREQUAL "")
    set(CMAKE_EXE_LINKER_FLAGS "${_elab_target_flags} -T \"${ELAB_LD}\" -Wl,--gc-sections -Wl,--print-memory-usage --specs=nano.specs")
endif()
