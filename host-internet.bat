@echo off
title Ollalink Translate - Public Internet Host
cd /d "%~dp0"
echo ========================================================
echo   Launching Ollalink Translate Internet Host...
echo ========================================================
echo.
node scripts/host-internet.js
pause
