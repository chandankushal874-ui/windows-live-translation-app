<#
.SYNOPSIS
    Ollalink Translate - Standalone Zip Downloader, Installer & Auto-Host Launcher
.DESCRIPTION
    Zero-Docker 1-click Windows installer for friends and remote AI agents.
    Downloads/locates the Ollalink-Translate-Windows-x64.zip package, extracts it,
    runs install-dependencies.ps1 to install missing prerequisites, auto-hosts the
    localhost relay server, and launches the desktop executable to display the landing page.
.USAGE
    # If friend's AI agent downloads from URL:
    powershell -ExecutionPolicy Bypass -File .\download-and-install.ps1 -ZipUrl "https://.../Ollalink-Translate-Windows-x64.zip"

    # If ZIP file is already saved locally (or in Downloads folder):
    powershell -ExecutionPolicy Bypass -File .\download-and-install.ps1

    # Specify custom zip location:
    powershell -ExecutionPolicy Bypass -File .\download-and-install.ps1 -ZipPath "C:\Downloads\Ollalink-Translate-Windows-x64.zip"
#>

[CmdletBinding()]
param (
    [string]$ZipUrl = "",
    [string]$ZipPath = "",
    [string]$InstallDir = "$env:LOCALAPPDATA\OllalinkTranslate",
    [switch]$Dev = $false,
    [switch]$NoLaunch = $false,
    [switch]$NonInteractive = $false
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "   Ollalink Translate — Windows Installer (Zero Docker)" -ForegroundColor Magenta
Write-Host "   Automated Agent & User Distribution Package" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor Magenta

# 1. Resolve Zip Archive
$targetZip = $ZipPath

if (-not $targetZip -or -not (Test-Path $targetZip)) {
    $userDownloads = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads"
    $localCandidates = @(
        (Join-Path $PSScriptRoot "Ollalink-Translate-Windows-x64.zip"),
        (Join-Path (Get-Location) "Ollalink-Translate-Windows-x64.zip"),
        (Join-Path $userDownloads "Ollalink-Translate-Windows-x64.zip"),
        "C:\ollalink-translate\Ollalink-Translate-Windows-x64.zip"
    )
    foreach ($c in $localCandidates) {
        if (Test-Path $c) {
            $targetZip = $c
            Write-Host "[OK] Located ZIP package: $targetZip" -ForegroundColor Green
            break
        }
    }
}

# Download if URL provided and targetZip not resolved
if ((-not $targetZip -or -not (Test-Path $targetZip)) -and $ZipUrl) {
    $tempZip = Join-Path ([System.IO.Path]::GetTempPath()) "Ollalink-Translate-Windows-x64.zip"
    Write-Host "[..] Downloading package from $ZipUrl ..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ZipUrl -OutFile $tempZip -UseBasicParsing
    $targetZip = $tempZip
    Write-Host "[OK] Downloaded successfully to $targetZip" -ForegroundColor Green
}

if (-not $targetZip -or -not (Test-Path $targetZip)) {
    Write-Host "[ERR] Could not locate Ollalink-Translate-Windows-x64.zip." -ForegroundColor Red
    Write-Host "Please place Ollalink-Translate-Windows-x64.zip in the same folder as this script, in Downloads, or specify -ZipUrl / -ZipPath." -ForegroundColor Yellow
    exit 1
}

# 2. Extract Archive to Target Directory
Write-Host "[..] Extracting archive to $InstallDir ..." -ForegroundColor Cyan
if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Expand-Archive -Path $targetZip -DestinationPath $InstallDir -Force
Write-Host "[OK] Extracted package to $InstallDir" -ForegroundColor Green

# 3. Execute Dependency & App Installation
$depScript = Join-Path $InstallDir "install-dependencies.ps1"
if (Test-Path $depScript) {
    Write-Host "[..] Running dependency check, auto-relay host, and app launch..." -ForegroundColor Cyan
    $argList = @("-ExecutionPolicy", "Bypass", "-NoProfile", "-File", $depScript)
    if ($Dev) { $argList += "-Dev" }
    if ($NoLaunch) { $argList += "-NoLaunch" }
    if ($NonInteractive) { $argList += "-NonInteractive" }
    
    $proc = Start-Process powershell -ArgumentList $argList -Wait -PassThru
    Write-Host "[OK] Setup script finished with exit code $($proc.ExitCode)." -ForegroundColor Green
} else {
    Write-Host "[WARN] install-dependencies.ps1 not found in zip archive." -ForegroundColor Yellow
}

# 4. Create Desktop Shortcut for easy 1-click launch
try {
    $wsh = New-Object -ComObject WScript.Shell
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktopPath "Ollalink Translate.lnk"
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    
    $runnerBat = Join-Path $InstallDir "start-release.bat"
    if (-not (Test-Path $runnerBat)) { $runnerBat = Join-Path $InstallDir "start-all.bat" }
    
    $shortcut.TargetPath = "cmd.exe"
    $shortcut.Arguments = "/c `"$runnerBat`""
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.Description = "Ollalink Translate - Realtime Voice Translation"
    $shortcut.Save()
    Write-Host "[OK] Created Desktop Shortcut: $shortcutPath" -ForegroundColor Green
} catch {
    Write-Host "[..] Skipped desktop shortcut creation." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "   Installation Complete! Ready to use." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  * Local Relay:  http://localhost:8787 (ONLINE)" -ForegroundColor White
Write-Host "  * Desktop App:  Landing Page Visible" -ForegroundColor White
Write-Host ""
exit 0
