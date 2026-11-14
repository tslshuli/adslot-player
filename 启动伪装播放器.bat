@echo off
cd /d "%~dp0"
title Ad Player

where node >nul 2>nul
if errorlevel 1 goto usemanaged
set "NODE=node"
goto run

:usemanaged
set "NODE=C:\Users\EDY\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

:run
start "" "http://127.0.0.1:8848/"
"%NODE%" live-server.js
echo.
echo Server stopped.
pause >nul
