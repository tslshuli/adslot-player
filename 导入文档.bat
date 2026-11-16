@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Import Documents

set "PY=C:\Users\EDY\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" tools\import-doc.py %*

echo.
echo 刷新页面后，新文档会出现在正文轮换里。
pause >nul
