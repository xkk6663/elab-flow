@echo off
rem elab —— elab-Flow 命令行入口（Windows cmd / CI .cmd 版）
rem 用法：  elab.cmd build -p stm32_test
setlocal
set HERE=%~dp0
if "%ELAB_PYTHON%"=="" (set PY=python) else (set PY=%ELAB_PYTHON%)
set PYTHONPATH=%HERE%services;%PYTHONPATH%
if "%ELAB_ROOT%"=="" set ELAB_ROOT=%HERE:~0,-1%
"%PY%" -m elab %*
exit /b %ERRORLEVEL%
