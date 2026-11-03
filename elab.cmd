@echo off
rem elab.cmd -- elab-Flow CLI entry point (Windows cmd / CI)
rem usage: elab.cmd build -p STM32F103C8T6
setlocal
set HERE=%~dp0
if "%ELAB_PYTHON%"=="" (set PY=python) else (set PY=%ELAB_PYTHON%)
set PYTHONPATH=%HERE%services;%PYTHONPATH%
if "%ELAB_ROOT%"=="" set ELAB_ROOT=%HERE:~0,-1%
"%PY%" -m elab %*
exit /b %ERRORLEVEL%
