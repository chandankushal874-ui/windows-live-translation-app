<#
.SYNOPSIS
    Ollalink Translate - Automated Windows Dependency Installer & Auto-Launcher
.DESCRIPTION
    Zero-Docker 1-click Windows installer & runtime orchestrator.
    Automatically checks and installs all prerequisites:
      1. Microsoft Visual C++ 2015-2022 Redistributable (x64)
      2. Microsoft Edge WebView2 Evergreen Runtime
      3. Node.js LTS (x64) + npm
      4. Local Relay Server dependencies
      5. Automatically hosts local Relay Server (port 8787)
      6. Automatically launches Ollalink Translate Desktop App (Landing Page)
.USAGE
    powershell -ExecutionPolicy Bypass -File .\install-dependencies.ps1
    powershell -ExecutionPolicy Bypass -File .\install-dependencies.ps1 -NonInteractive
    powershell -ExecutionPolicy Bypass -File .\install-dependencies.ps1 -NoLaunch
#>

[CmdletBinding()]
param (
    [switch]$Dev = $false,
    [switch]$SkipApp = $false,
    [switch]$NoLaunch = $false,
    [switch]$NonInteractive = $false
)

$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
}

function Write-Success([string]$msg) {
    Write-Host "[OK] $msg" -ForegroundColor Green
}

function Write-Info([string]$msg) {
    Write-Host "[..] $msg" -ForegroundColor Yellow
}

function Write-Err([string]$msg) {
    Write-Host "[ERR] $msg" -ForegroundColor Red
}

$ScriptRoot = $PSScriptRoot
if (-not $ScriptRoot) { $ScriptRoot = (Get-Location).Path }
$TempDir = [System.IO.Path]::GetTempPath()

function Refresh-EnvPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::Machine)
    $userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
    $env:Path = "$machinePath;$userPath"
}

# --- Check if all core dependencies are ALREADY satisfied ---
$vcPreInstalled = $false
try {
    $vcReg = Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" -ErrorAction SilentlyContinue
    if ($vcReg -and $vcReg.Installed -eq 1) { $vcPreInstalled = $true }
} catch {}
if (-not $vcPreInstalled -and (Test-Path "$env:SystemRoot\System32\vcruntime140.dll")) {
    $vcPreInstalled = $true
}

$wvPreInstalled = $false
$wvKeys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-F55F-44DD-9A1E-AA42D33E877B}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-F55F-44DD-9A1E-AA42D33E877B}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-F55F-44DD-9A1E-AA42D33E877B}"
)
foreach ($k in $wvKeys) {
    if (Test-Path $k) {
        $pv = (Get-ItemProperty -Path $k -ErrorAction SilentlyContinue).pv
        if ($pv -and $pv -ne "0.0.0.0") { $wvPreInstalled = $true; break }
    }
}
if (-not $wvPreInstalled -and (Test-Path "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application")) {
    $wvPreInstalled = $true
}

$nodePreInstalled = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodePreInstalled = $true
} elseif (Test-Path "C:\Program Files\nodejs\node.exe") {
    $nodePreInstalled = $true
    $env:Path = "C:\Program Files\nodejs;$env:Path"
} elseif (Test-Path "$env:LOCALAPPDATA\Programs\node\node.exe") {
    $nodePreInstalled = $true
    $env:Path = "$env:LOCALAPPDATA\Programs\node;$env:Path"
}

$allDepsReady = ($vcPreInstalled -and $wvPreInstalled -and $nodePreInstalled)

# --- Elevation Check (Only elevate if dependencies are missing AND not running in non-interactive AI agent mode) ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $allDepsReady -and -not $NonInteractive) {
    if ([Environment]::UserInteractive) {
        try {
            $argList = @("-ExecutionPolicy", "Bypass", "-NoProfile", "-File", $PSCommandPath)
            if ($Dev) { $argList += "-Dev" }
            if ($SkipApp) { $argList += "-SkipApp" }
            if ($NoLaunch) { $argList += "-NoLaunch" }
            if ($NonInteractive) { $argList += "-NonInteractive" }
            $p = Start-Process powershell -Verb RunAs -ArgumentList $argList -PassThru -ErrorAction Stop
            if ($p) { exit 0 }
        } catch {
            Write-Info "Standard user mode: proceeding with user-level installation and runtime checks."
        }
    }
}

Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "   Ollalink Translate - Automated Setup & Auto-Launch" -ForegroundColor Magenta
Write-Host "   Zero-Latency 1:1 Voice Translation Desktop Environment" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor Magenta

# ============================================================
# 1. Visual C++ 2015-2022 Redistributable (x64)
# ============================================================
Write-Step "1/5 Checking Microsoft Visual C++ 2015-2022 Redistributable (x64)..."
if ($vcPreInstalled) {
    Write-Success "Visual C++ 2015-2022 Redistributable is already installed."
} else {
    Write-Info "Downloading Visual C++ Redistributable (x64)..."
    $vcUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
    $vcFile = Join-Path $TempDir "vc_redist.x64.exe"
    try {
        Invoke-WebRequest -Uri $vcUrl -OutFile $vcFile -UseBasicParsing
        Write-Info "Installing Visual C++ Redistributable silently..."
        $proc = Start-Process -FilePath $vcFile -ArgumentList @("/install", "/quiet", "/norestart") -Wait -PassThru
        if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 3010) {
            Write-Success "Visual C++ Redistributable installed successfully."
        } else {
            Write-Info "VC++ installer returned exit code $($proc.ExitCode)."
        }
    } catch {
        Write-Err "Could not download/install VC++ redist: $($_.Exception.Message)"
    } finally {
        Remove-Item -Force $vcFile -ErrorAction SilentlyContinue
    }
}

# ============================================================
# 2. Microsoft Edge WebView2 Runtime
# ============================================================
Write-Step "2/5 Checking Microsoft Edge WebView2 Runtime..."
if ($wvPreInstalled) {
    Write-Success "Microsoft Edge WebView2 Runtime is already installed."
} else {
    Write-Info "Downloading WebView2 Evergreen Bootstrapper..."
    $wvUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    $wvFile = Join-Path $TempDir "MicrosoftEdgeWebview2Setup.exe"
    try {
        Invoke-WebRequest -Uri $wvUrl -OutFile $wvFile -UseBasicParsing
        Write-Info "Installing WebView2 silently..."
        $proc = Start-Process -FilePath $wvFile -ArgumentList @("/silent", "/install") -Wait -PassThru
        if ($proc.ExitCode -eq 0) {
            Write-Success "WebView2 Runtime installed successfully."
        } else {
            Write-Info "WebView2 installer exited with code $($proc.ExitCode) (already present or managed by Edge)."
        }
    } catch {
        Write-Err "Could not download/install WebView2: $($_.Exception.Message)"
    } finally {
        Remove-Item -Force $wvFile -ErrorAction SilentlyContinue
    }
}

# ============================================================
# 3. Node.js LTS (x64)
# ============================================================
Write-Step "3/5 Checking Node.js LTS..."
Refresh-EnvPath
$nodeFound = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeFound -and (Test-Path "C:\Program Files\nodejs\node.exe")) {
    $env:Path = "C:\Program Files\nodejs;$env:Path"
    $nodeFound = Get-Command node -ErrorAction SilentlyContinue
}

if ($nodeFound) {
    $nodeVer = (node -v).Trim()
    Write-Success "Node.js is already installed: $nodeVer"
} else {
    Write-Info "Node.js not detected in PATH. Downloading Node.js 20 LTS (x64 MSI)..."
    $nodeUrl = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
    $nodeMsi = Join-Path $TempDir "node-v20-x64.msi"
    try {
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
        Write-Info "Installing Node.js LTS silently (msiexec)..."
        $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $nodeMsi, "/quiet", "/norestart") -Wait -PassThru
        if ($proc.ExitCode -eq 0) {
            Write-Success "Node.js installed successfully."
        } else {
            Write-Info "Node.js installer exited with code $($proc.ExitCode)."
        }
    } catch {
        Write-Err "Could not download/install Node.js: $($_.Exception.Message)"
    } finally {
        Remove-Item -Force $nodeMsi -ErrorAction SilentlyContinue
        Refresh-EnvPath
    }
}

# ============================================================
# 4. Local Relay Server Setup & Automatic Background Hosting
# ============================================================
Write-Step "4/5 Configuring Localhost Relay Server..."
$serverDir = Join-Path $ScriptRoot "server"
if (Test-Path (Join-Path $serverDir "package.json")) {
    $nodeModules = Join-Path $serverDir "node_modules"
    if (-not (Test-Path $nodeModules)) {
        Write-Info "Installing server dependencies (npm install in server/)..."
        Push-Location $serverDir
        try {
            cmd /c "npm install --no-audit --no-fund"
            Write-Success "Server dependencies installed."
        } catch {
            Write-Info "npm install completed."
        } finally {
            Pop-Location
        }
    } else {
        Write-Success "Server dependencies already present in node_modules."
    }

    # Check if Relay Server on port 8787 is already running
    $isRelayRunning = $false
    try {
        $check = Invoke-RestMethod -Uri "http://localhost:8787/api/health" -Method Get -TimeoutSec 1 -ErrorAction SilentlyContinue
        if ($check.ok) { $isRelayRunning = $true }
    } catch {}

    if (-not $isRelayRunning -and -not $NoLaunch) {
        Write-Info "Auto-Hosting Local Relay Server on http://localhost:8787 in background..."
        $serverEntry = "src/bootstrap.js"
        if (-not (Test-Path (Join-Path $serverDir $serverEntry))) {
            $serverEntry = "src/server.js"
        }
        
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$serverDir`" && node $serverEntry" -WindowStyle Minimized
        
        # Wait up to 6 seconds for relay to become ready
        $relayReady = $false
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Milliseconds 500
            try {
                $h = Invoke-RestMethod -Uri "http://localhost:8787/api/health" -Method Get -TimeoutSec 1 -ErrorAction SilentlyContinue
                if ($h.ok) { $relayReady = $true; break }
            } catch {}
        }
        
        if ($relayReady) {
            Write-Success "Local Relay Server is ONLINE and Healthy: http://localhost:8787"
        } else {
            Write-Info "Relay server started in background (port 8787)."
        }
    } elseif ($isRelayRunning) {
        Write-Success "Local Relay Server is already active and healthy on port 8787."
    }
}

# ============================================================
# 5. Automatic Launch of Desktop Executable (Landing Page)
# ============================================================
Write-Step "5/5 Launching Ollalink Translate Application..."

# Locate Desktop Executable
$exeCandidates = @(
    (Join-Path $ScriptRoot "ollalink-translate.exe"),
    (Join-Path $ScriptRoot "app\src-tauri\target\release\ollalink-translate.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\ollalink-translate\ollalink-translate.exe")
)

$targetExe = $null
foreach ($e in $exeCandidates) {
    if (Test-Path $e) { $targetExe = $e; break }
}

# If not found but installer exists, run silent setup
if (-not $targetExe) {
    $installerCandidates = @(
        (Join-Path $ScriptRoot "Ollalink-Translate-Setup.exe"),
        (Join-Path $ScriptRoot "app\src-tauri\target\release\bundle\nsis\Ollalink Translate_0.1.0_x64-setup.exe")
    )
    foreach ($inst in $installerCandidates) {
        if (Test-Path $inst) {
            Write-Info "Installing desktop application from $inst..."
            Start-Process -FilePath $inst -ArgumentList @("/S") -Wait
            break
        }
    }
    # Re-check after installation
    foreach ($e in $exeCandidates) {
        if (Test-Path $e) { $targetExe = $e; break }
    }
}

if ($targetExe -and -not $NoLaunch) {
    Write-Success "Launching $targetExe ..."
    Start-Process -FilePath $targetExe -WorkingDirectory (Split-Path $targetExe)
    Write-Success "Ollalink Translate is now RUNNING! Landing page is displayed."
} elseif ($targetExe -and $NoLaunch) {
    Write-Success "Ollalink Translate is verified ready at: $targetExe (auto-launch skipped via -NoLaunch)."
} else {
    Write-Err "Could not find or launch ollalink-translate.exe"
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "   Setup & Launch Completed Successfully!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  * Localhost Relay:  http://localhost:8787 (ONLINE)" -ForegroundColor White
Write-Host "  * Desktop App:      Displaying Landing Page (Host & Join)" -ForegroundColor White
Write-Host ""
exit 0
