@echo off
rem QQ Agent launcher (desktop app, no npm window)
rem NOTE: keep this file ASCII-only. cmd parses .bat in GBK on Chinese
rem Windows; UTF-8 Chinese comments swallow the newline and break parsing.
setlocal
set "EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%EXE%" (
  echo.
  echo [ERROR] Electron runtime not found:
  echo   %EXE%
  echo.
  echo This package looks incomplete. Please re-extract the zip with
  echo 7-Zip or WinRAR - some tools and cloud-sync clients drop large
  echo .exe files, and some antivirus software quarantines them.
  echo.
  pause
  exit /b 1
)
start "" "%EXE%" "%~dp0."
