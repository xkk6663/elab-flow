# examples/ESP32S31_Wave —— 串口 / TCP / UDP 三链路波形演示工程
# 工具链由工程自带 ESP-IDF 提供；elab 内核不 import、不绑定任何命令。
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(esp32s31_wave)
