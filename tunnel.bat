@echo off
title YT-DLP Web Interface - Cloudflare Tunnel
color 0A

echo.
echo  ======================================================
echo    YT-DLP Web Interface — Instant Public Tunnel
echo  ======================================================
echo.
echo  This script creates a secure public HTTPS URL for your
echo  local YT-DLP web interface using Cloudflare Tunnel.
echo.
echo  - Runs on your local PC (ZERO YouTube login blocks!)
echo  - Accessible from anywhere in the world on phone/PC
echo.

:: Check if cloudflared is installed
where cloudflared >nul 2>&1
if errorlevel 1 (
    echo  cloudflared is not found in PATH.
    echo  Downloading portable cloudflared.exe...
    echo.
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe'"
    if errorlevel 1 (
        echo  [ERROR] Failed to download cloudflared.
        echo  Please download manually from: https://github.com/cloudflare/cloudflared/releases
        pause
        exit /b 1
    )
    set "CLOUDFLARED_CMD=.\cloudflared.exe"
) else (
    set "CLOUDFLARED_CMD=cloudflared"
)

echo.
echo  ======================================================
echo    Starting Cloudflare Tunnel on port 8939...
echo  ======================================================
echo.
echo  Look for the URL ending with '.trycloudflare.com' below:
echo.

%CLOUDFLARED_CMD% tunnel --url http://localhost:8939

pause
