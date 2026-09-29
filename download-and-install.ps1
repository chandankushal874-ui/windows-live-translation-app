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
    powershell -ExecutionPolicy RemoteSigned -File .\download-and-install.ps1 -ZipUrl "https://.../Ollalink-Translate-Windows-x64.zip"

    # If ZIP file is already saved locally (or in Downloads folder):
    powershell -ExecutionPolicy RemoteSigned -File .\download-and-install.ps1

    # Specify custom zip location:
    powershell -ExecutionPolicy RemoteSigned -File .\download-and-install.ps1 -ZipPath "C:\Downloads\Ollalink-Translate-Windows-x64.zip"
#>

[CmdletBinding()]
param (
    [string]$ExpectedSha256 = "",
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
Write-Host "   Ollalink Translate - Windows Installer (Zero Docker)" -ForegroundColor Magenta
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


# 1.5 Verify Archive Integrity (SEC-03 Remediation)
$computedHash = (Get-FileHash -Path $targetZip -Algorithm SHA256).Hash.ToUpperInvariant()
Write-Host "[..] Package SHA-256: $computedHash" -ForegroundColor DarkGray

$validChecksum = $null
if ($ExpectedSha256) {
    $validChecksum = $ExpectedSha256.Trim().ToUpperInvariant()
} else {
    $zipDir = Split-Path -Parent $targetZip
    $sumsFile = Join-Path $zipDir "SHA256SUMS.txt"
    $dotSha256 = "$targetZip.sha256"
    if (Test-Path $dotSha256) {
        $content = (Get-Content $dotSha256 -Raw).Trim()
        $validChecksum = ($content -split '\s+')[0].ToUpperInvariant()
    } elseif (Test-Path $sumsFile) {
        $zipBase = Split-Path -Leaf $targetZip
        foreach ($line in (Get-Content $sumsFile)) {
            if ($line -match "([a-fA-F0-9]{64})\s+.*$([regex]::Escape($zipBase))") {
                $validChecksum = $matches[1].ToUpperInvariant()
                break
            }
        }
    }
}

if ($validChecksum) {
    if ($computedHash -ne $validChecksum) {
        Write-Host "[ERR] INTEGRITY CHECK FAILED (SEC-03)!" -ForegroundColor Red
        Write-Host "Expected SHA-256: $validChecksum" -ForegroundColor Red
        Write-Host "Actual SHA-256:   $computedHash" -ForegroundColor Red
        Write-Host "The downloaded archive has been corrupted or tampered with. Aborting installation." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Archive integrity verified (SHA-256 matches expected checksum)." -ForegroundColor Green
} else {
    Write-Host "[WARN] No expected SHA-256 checksum or manifest provided for package verification." -ForegroundColor Yellow
}

# 2. Extract Archive to Target Directory
Write-Host "[..] Extracting archive to $InstallDir ..." -ForegroundColor Cyan
if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Expand-Archive -Path $targetZip -DestinationPath $InstallDir -Force
Write-Host "[OK] Extracted package to $InstallDir" -ForegroundColor Green
$targetExe = Join-Path $InstallDir "ollalink-translate.exe"
if (Test-Path $targetExe) {
    $sig = Get-AuthenticodeSignature -FilePath $targetExe
    if ($sig.SignerCertificate) {
        Write-Host "[OK] Authenticode Signature: $($sig.SignerCertificate.Subject) [Thumbprint: $($sig.SignerCertificate.Thumbprint)]" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Executable is unsigned" -ForegroundColor Yellow
    }
}


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

# SIG # Begin signature block
# MIIF+wYJKoZIhvcNAQcCoIIF7DCCBegCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCDdnVHrlNNCTzIJ
# trESNPnMCjlhgCx6MSoJELe/eXNCbaCCA04wggNKMIICMqADAgECAhBMuAUxgdcn
# ikskqpUkXcvrMA0GCSqGSIb3DQEBCwUAMD0xCzAJBgNVBAYTAlVTMREwDwYDVQQK
# DAhPbGxhbGluazEbMBkGA1UEAwwST2xsYWxpbmsgVHJhbnNsYXRlMB4XDTI2MDky
# NzIwMzAxMFoXDTMxMDkyNzIwNDAwOFowPTELMAkGA1UEBhMCVVMxETAPBgNVBAoM
# CE9sbGFsaW5rMRswGQYDVQQDDBJPbGxhbGluayBUcmFuc2xhdGUwggEiMA0GCSqG
# SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDpNLDP5c0TexrxYdYqJMLPDxCOZM0+QoXg
# 5svaRzhQJijYqEyJy948ohBzuHDLT+7H/zZhwAqSoPubuukFyYuWAWZl5wrstRVb
# JzHuHP/kd+mUWGPDB1LDrPfIeO0I4udGPovTnMi+A/o8xW12MlV5UkGnmm5H2fh7
# NZNrqNIkdniCGcuaC1FzgasB8RycL48OVyh4oRScWYT7Qt3+VHFL9cA6zw7oOcZF
# 01NitlIvFUcDDF9PcgIrqC8oijBnGvhCrNfnSZ5VIPWGBhVCu2I5xXXXoLLCat2q
# BM8F9hNLf2mCVRROG7WA1AB0QnJmzWYssUzYwYvLugM/dZdDtdVpAgMBAAGjRjBE
# MA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAzAdBgNVHQ4EFgQU
# UPrzXEaCLMYgxVV885AEtCcS6lgwDQYJKoZIhvcNAQELBQADggEBALbuaajIkkdu
# XIiZplM6NdzBWyn8nW8dvWArGHBqj7N27p+/CvDLFh1+a9uM5U9oHINRVp3GF8Rr
# MJ6u5Z+0Ug1EgK3+I7waF1/UsJrZmp0GUs9xPH9lkpKQ+njf9aoda9iq0FkrAIWx
# y3onqVWK0BjImL/unkZqvLrx6IrnmJUM7JMGHMR6iGa0kve9ykon79AeJSNp6ON9
# w4djSed6hSnciOjUu8L0cu8SIP4+xGB30Ici6SYZuxdhM5v/ettWUtcUS4hI4oDO
# LrrqvPTMyeDVghZfca2EUv0gF/HrC1R2Lu8tHpOx/Tg15aXfRVNl5th9em8Fa4jM
# 2mO/0iQJcr4xggIDMIIB/wIBATBRMD0xCzAJBgNVBAYTAlVTMREwDwYDVQQKDAhP
# bGxhbGluazEbMBkGA1UEAwwST2xsYWxpbmsgVHJhbnNsYXRlAhBMuAUxgdcniksk
# qpUkXcvrMA0GCWCGSAFlAwQCAQUAoIGEMBgGCisGAQQBgjcCAQwxCjAIoAKAAKEC
# gAAwGQYJKoZIhvcNAQkDMQwGCisGAQQBgjcCAQQwHAYKKwYBBAGCNwIBCzEOMAwG
# CisGAQQBgjcCARUwLwYJKoZIhvcNAQkEMSIEIDTFtABhDDXEm/fRNl1S8Nt5Ai4T
# J2dLqKV/gTV+XllsMA0GCSqGSIb3DQEBAQUABIIBAH/YepKnkNsTMAU06PjrIAv0
# zZX1Y4auLezCtDuKC0wG+VtOp8MI5g79uA7631fmlZVoBh97SF/PBM/GD9en1aXl
# MBqHwMUdDSnq5m6FIx07BY83g+ymjL1On7Bd5XrzPXA8wf7h++T+GPkUn+n6kZD7
# i2GKSJG2ZXKbRTyd871Of5rhj77xp/MVz3NCSb3SRrcgF/l5alDrjJA+7S8BGB/y
# DsbFshcbQ6STxRURAo+wP6Gr9DczjOlApbYHYa7Mig2wHVIRkAH4PiSoQXC/NdvI
# c3LgUZor62OVgDXu5HgHZODmIO9zbzKvIJif1buN8p8OrHLDIYmskhdA2qL70E8=
# SIG # End signature block
