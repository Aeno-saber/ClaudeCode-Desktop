@echo off
rem ============================================================
rem  Claude Desktop launcher
rem
rem  Reuses the Electron already installed on this machine
rem  (43.4.0, bundled with dsh-desktop). No `npm install` needed --
rem  Huorong real-time protection drags that download out to 20-40 min.
rem
rem  Usage:  start.cmd          normal launch
rem          start.cmd --dev    also open DevTools
rem
rem  NOTE: keep this file pure ASCII. cmd.exe reads .cmd using the OEM
rem  codepage (936 here), so UTF-8 Chinese text renders as garbage.
rem ============================================================
setlocal
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

rem Some shells export this; it would start Electron in pure-Node mode (no window).
set "ELECTRON_RUN_AS_NODE="

set "ELECTRON_EXE="
if exist "D:\app\ds harness\dsh-desktop\node_modules\electron\dist\electron.exe" (
  set "ELECTRON_EXE=D:\app\ds harness\dsh-desktop\node_modules\electron\dist\electron.exe"
)

rem Fallback: scan D:\app for any electron dist, newest first.
if not defined ELECTRON_EXE (
  for /f "delims=" %%d in ('dir /b /ad /o-d "D:\app" 2^>nul') do (
    if not defined ELECTRON_EXE if exist "D:\app\%%d\node_modules\electron\dist\electron.exe" (
      set "ELECTRON_EXE=D:\app\%%d\node_modules\electron\dist\electron.exe"
    )
  )
)

if not defined ELECTRON_EXE (
  echo [claude] electron.exe not found.
  echo [claude] expected: D:\app\ds harness\dsh-desktop\node_modules\electron\dist\electron.exe
  echo [claude] or any    D:\app\*\node_modules\electron\dist\electron.exe
  pause
  exit /b 9009
)

if not exist "%APPDIR%\main.js" (
  echo [claude] wrong app dir, main.js not found: %APPDIR%
  pause
  exit /b 9009
)

echo [claude] electron: %ELECTRON_EXE%
echo [claude] appdir  : %APPDIR%
start "" "%ELECTRON_EXE%" "%APPDIR%" %*
endlocal
