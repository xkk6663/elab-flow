@echo off
rem ============================================================
rem  elab cockpit - one-click desktop launcher
rem  1) start the cockpit server (minimized console) if not up
rem  2) open the default browser on the UI
rem  Idempotent: clicking again just opens one more browser tab.
rem  Env overrides: ELAB_PYTHON (python used), COCKPIT_PORT (8333)
rem ============================================================
setlocal
set "HERE=%~dp0"
cd /d "%HERE%"
rem System32 first: shield MSYS / GitBash shims from PATH
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
if "%ELAB_PYTHON%"=="" (set "PY=python") else (set "PY=%ELAB_PYTHON%")
set "PORT=%COCKPIT_PORT%"
if "%PORT%"=="" set "PORT=8333"
set "URL=http://127.0.0.1:%PORT%/"

rem -- bare TCP probe (no curl/http client; immune to proxy/TUN) --
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',%PORT%); exit 0}catch{exit 1}finally{$c.Close()}"
if %ERRORLEVEL%==0 goto open

rem -- not running: spawn a minimized server console with a log --
rem PYTHONUTF8: redirected stdout would otherwise use the ANSI codepage (GBK on
rem zh-CN) and crash the server banner on checkmark characters (real incident).
rem PYTHONUNBUFFERED: the redirected log stays empty while buffered - useless
rem for diagnosis exactly when you need it.
set "PYTHONUTF8=1"
set "PYTHONUNBUFFERED=1"
set "PYTHONPATH=%HERE%;%PYTHONPATH%"
if "%ELAB_ROOT%"=="" set "ELAB_ROOT=%HERE:~0,-1%"
set "LOG=%TEMP%\elab-cockpit.log"
start "elab cockpit" /MIN cmd /c ""%PY%" -m cockpit.server --port %PORT% > "%LOG%" 2>&1"

rem -- wait for the port (up to ~20s) --
set /a TRIES=0
:wait
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',%PORT%); exit 0}catch{exit 1}finally{$c.Close()}"
if %ERRORLEVEL%==0 goto open
set /a TRIES+=1
if %TRIES% GEQ 40 (
  echo [elab cockpit] server did not come up on port %PORT% within 20s.
  echo [elab cockpit] log: %LOG%
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait

:open
rem -- open the UI as a standalone app window: Edge --app has no address bar
rem -- and gets its own taskbar icon (feels like a native app, zero dependency).
rem -- Falls back to the default browser when Edge is not installed.
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL%
) else (
  start "" "%URL%"
)
endlocal
exit /b 0
