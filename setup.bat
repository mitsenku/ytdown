@echo off
set PYTHONUNBUFFERED=1
title YT-DLP Web Interface - Setup and Launch
color 0B

echo.
echo  ============================================
echo    YT-DLP Web Interface - Setup and Launch
echo  ============================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python is not installed or not in PATH.
    echo  Please install Python 3.8+ from https://www.python.org
    pause
    exit /b 1
)
echo  [OK] Python found

:: Check pip via python -m pip (works even when pip.exe is not on PATH)
python -m pip --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] pip is not available.
    echo  Try: python -m ensurepip --upgrade
    pause
    exit /b 1
)
echo  [OK] pip found

:: Check FFmpeg (optional but recommended, check local paths first)
if exist "%~dp0ffmpeg-master-latest-win64-gpl\bin" (
    set "PATH=%~dp0ffmpeg-master-latest-win64-gpl\bin;%PATH%"
) else if exist "%~dp0ffmpeg\bin" (
    set "PATH=%~dp0ffmpeg\bin;%PATH%"
)

ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo  [WARN] FFmpeg is not installed.
    echo         HD video merging and audio conversion may not work.
    echo         Install from: https://ffmpeg.org/download.html
    echo.
) else (
    echo  [OK] FFmpeg found
)

:: Install Python dependencies
echo.
echo  Installing Python dependencies...
python -m pip install -r backend\requirements.txt
if errorlevel 1 (
    echo  [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)
echo  [OK] Dependencies installed

:: Create downloads directory
if not exist "downloads" mkdir downloads

:: Launch server
echo.
echo  ============================================
echo    Starting server at http://localhost:5000
echo  ============================================
echo.
echo  Press Ctrl+C to stop the server.
echo.

:: Open browser after a short delay
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5000"

:: Start Flask
cd backend
python app.py
