@echo off
rem ============================================================
rem  elab cockpit - one-click desktop launcher
rem  1) start the cockpit server (hidden pythonw) if not up
rem  2) open the UI as an Edge --app window (falls back to browser)
rem  Idempotent: clicking again just opens one more window.
rem  Env overrides: ELAB_PYTHON (python used), COCKPIT_PORT (8333)
rem
rem  ASCII-ONLY RULE (real incident, 2026-10-08): cmd.exe parses
rem  .cmd files with the ANSI codepage (GBK on zh-CN). UTF-8
rem  Chinese comments desynchronize the byte stream (multi-byte
rem  sequences swallow the following byte, even a line's CR),
rem  lines get spliced and cmd executes garbage fragments ->
rem  the window "flash-crashes" on double-click. Never put
rem  non-ASCII into this file. (A Python dry-runner cannot
rem  reproduce this - it does not emulate cmd byte parsing.)
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

rem -- `cockpit.cmd stop`: kill the hidden server (pythonw has no
rem    window to close, so it needs a way to stop) --
if /i "%~1"=="stop" (
  powershell -NoProfile -Command "$l=netstat -ano | Select-String ':%PORT% .*LISTENING';if($l){$p=($l[0] -split '\s+')[-1];Stop-Process -Id $p -Force;Write-Host ('[cockpit] stopped pid='+$p)}else{Write-Host '[cockpit] not running'}"
  endlocal & exit /b 0
)

rem -- bare TCP probe (no curl/http client; immune to proxy/TUN) --
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',%PORT%); exit 0}catch{exit 1}finally{$c.Close()}"
if %ERRORLEVEL%==0 goto open

rem -- not running: spawn a HIDDEN server (pythonw = no console
rem    window at all; a /MIN console window IS the server's life -
rem    one accidental click on its X kills it, page won't open).
rem    PYTHONUTF8: redirected stdout would otherwise use the ANSI
rem    codepage and crash the banner on checkmark characters.
rem    PYTHONUNBUFFERED: buffered redirected log stays empty -
rem    useless exactly when you need it. --
set "PYTHONUTF8=1"
set "PYTHONUNBUFFERED=1"
set "PYTHONPATH=%HERE%;%PYTHONPATH%"
if "%ELAB_ROOT%"=="" set "ELAB_ROOT=%HERE:~0,-1%"
set "LOG=%TEMP%\elab-cockpit.log"
rem -- derive windowless interpreter: full path python.exe ->
rem    pythonw.exe; bare name python -> pythonw --
set "PYW=%PY%"
if /i "%PYW:~-10%"=="python.exe" set "PYW=%PYW:~0,-10%pythonw.exe"
if /i "%PY%"=="python" set "PYW=pythonw"
if /i "%PY%"=="python3" set "PYW=pythonw"
rem -- existence check: full path via `if exist`, bare name via
rem    `where` (if exist does not search PATH) --
set "PYW_OK="
echo %PYW% | findstr /i "\\" >nul
if not errorlevel 1 (
  if exist "%PYW%" set "PYW_OK=1"
) else (
  where %PYW% >nul 2>&1 && set "PYW_OK=1"
)
if defined PYW_OK (
  rem windowless + self-written log (--logfile, line-buffered utf-8)
  start "" "%PYW%" -m cockpit.server --port %PORT% --logfile "%LOG%"
) else (
  rem fallback: last-resort minimized console (can be closed by X!)
  start "elab cockpit" /MIN cmd /c ""%PY%" -m cockpit.server --port %PORT% > "%LOG%" 2>&1"
)

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
rem -- open the UI as a standalone app window: Edge --app has no
rem    address bar and gets its own taskbar icon (feels like a
rem    native app, zero dependency). --
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL%
) else (
  start "" "%URL%"
)
endlocal
exit /b 0
