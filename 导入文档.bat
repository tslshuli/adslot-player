@echo off
setlocal
cd /d "%~dp0"
title Import Documents
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"

if "%~1"=="" (
    echo.
    echo   Drag .docx / .xlsx / .pptx files onto this .bat icon.
    echo   They will be converted into docs\ and join the rotation.
    echo.
    pause
    exit /b 0
)

set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if exist "%PY%" goto run

where python >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [ERROR] Python not found.
    echo   Edit this .bat and set PY to your python.exe path.
    echo.
    pause
    exit /b 1
)
set "PY=python"

:run
"%PY%" tools\import-doc.py %*
echo.
echo   Finished. Refresh the page to see new documents.
echo.
pause
