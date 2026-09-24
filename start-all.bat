@echo off
title Ollalink Translate Launcher
echo ========================================================
echo   Ollalink Translate — 1:1 Voice Translation App
echo ========================================================
echo.
echo [1/2] Starting Node.js Relay Server (Port 8787)...
start "Ollalink Relay Server" cmd /c "cd /d "%~dp0server" && npm start"

echo [2/2] Waiting for relay to become ready...
timeout /t 2 /nobreak >nul

echo.
echo Launching Tauri Desktop Dev App...
cd /d "%~dp0app"
npm run tauri dev