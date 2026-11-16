@echo off
cd /d "%~dp0"
title Ad Player

where node >nul 2>nul
if errorlevel 1 goto usemanaged
set "NODE=node"
goto run

:usemanaged
set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

:run
rem open with a random param so the browser reloads the newest page
start "" "http://127.0.0.1:8848/?v=%RANDOM%%RANDOM%"
"%NODE%" live-server.js
echo.
echo Server stopped.
pause >nul
