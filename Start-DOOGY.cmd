@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-DOOGY.ps1" %*
set "DOOGY_EXIT=%errorlevel%"
if not "%DOOGY_EXIT%"=="0" pause
exit /b %DOOGY_EXIT%
