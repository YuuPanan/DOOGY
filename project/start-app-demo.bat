@echo off
setlocal DisableDelayedExpansion
call "%~dp0start.bat" app-demo
exit /b %errorlevel%
