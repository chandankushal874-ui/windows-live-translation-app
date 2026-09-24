@echo off
title Ollalink Translate Release Launcher
echo ========================================================
echo   Ollalink Translate - Release Runner
echo ========================================================
echo.
echo [1/2] Starting Node.js Relay Server (Port 8787)...
start "Ollalink Relay Server" cmd /c "cd /d "%~dp0server" && npm start"

echo [2/2] Waiting for relay to become ready...
timeout /t 2 /nobreak >nul

echo.
echo Launching Compiled Ollalink Translate Desktop App...
if exist "%~dp0ollalink-translate.exe" (
    start "" "%~dp0ollalink-translate.exe"
) else (
    start "" "%~dp0app\src-tauri\target\release\ollalink-translate.exe"
)
