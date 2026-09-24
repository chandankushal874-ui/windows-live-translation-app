@echo off
title Ollalink Translate - Windows Dependency Installer
echo ========================================================
echo   Ollalink Translate - Dependency Setup Launcher
echo ========================================================
echo.
echo Launching PowerShell with ExecutionPolicy Bypass...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-dependencies.ps1" %*
pause
