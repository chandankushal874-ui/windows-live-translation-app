@echo off
title Ollalink Translate - Windows Dependency Installer
echo ========================================================
echo   Ollalink Translate - Dependency Setup Launcher
echo ========================================================
echo.
echo Launching PowerShell with ExecutionPolicy RemoteSigned...
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0install-dependencies.ps1" %*
pause
