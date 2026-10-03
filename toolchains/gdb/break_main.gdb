# toolchains/gdb/break_main.gdb —— 由 `elab debug -x` 加载
# 作用：连接后停在 main 入口，交给人继续单步/查寄存器。
# 用法：elab debug -p at32_test --run
#
# 前置（由 elab debug 在 -x 之前注入）：
#   target extended-remote localhost:3333
#   monitor reset halt
#   load

set pagination off
set confirm off
set print pretty on
set print elements 0

# 先打断点，再让目标从复位跑起来 → 停在 main
break main
monitor reset init
continue

printf "\n[elab] 已停在 main 入口。常用命令：\n"
printf "        bt            调用栈\n"
printf "        info regs    寄存器\n"
printf "        n / s         单步（跨过 / 进入）\n"
printf "        c             继续\n"
printf "        monitor reset halt   重新复位停下\n\n"
