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
if(DEFINED ELAB_LD AND NOT ELAB_LD STREQUAL "")
    set(CMAKE_EXE_LINKER_FLAGS "${_elab_flags} -T \"${ELAB_LD}\" -Wl,--gc-sections -Wl,--print-memory-usage --specs=nano.specs")
endif()

# ★ B 类实测坑：工程自带工具链用的是 CMAKE_C_LINK_FLAGS（AT32 的 gcc-arm-none-eabi.cmake
#   第 38-43 行），与 elab 用的 CMAKE_EXE_LINKER_FLAGS 是【不同名的变量】，CMake 会把两份
#   都拼进链接行 → 出现两遍 -mcpu / 两遍 -T / 两遍 --print-memory-usage。
#   若两源参数恰好一致，目前只是"冗余"；一旦不一致，会出现两个不同 -T（后者生效）= 静默错误。
#   故必须显式清掉工程留下的那一份。
unset(CMAKE_C_LINK_FLAGS)
unset(CMAKE_CXX_LINK_FLAGS)

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
