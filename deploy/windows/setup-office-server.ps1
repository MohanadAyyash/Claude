<#
 Turns an always-on Windows PC into the ERP server:
   - starts the ERP automatically at boot (no login needed) and restarts it if it ever crashes
   - runs a daily database backup at 02:30 (optionally copied to another folder / drive / OneDrive)
   - runs the daily data-integrity check at 03:00 (OPS.md; reports problems to GitHub when .env has GITHUB_REPORT_TOKEN)
   - stops the PC from sleeping, opens the LAN port in the firewall, prints the office address

 Run PowerShell AS ADMINISTRATOR, from the project folder (e.g. C:\erp):
     powershell -ExecutionPolicy Bypass -File deploy\windows\setup-office-server.ps1
 Options:
     -AppDir "C:\erp"                      project folder (default C:\erp)
     -BackupCopyTo "D:\ERP-Backups"        also copy every backup here (external disk / network share / OneDrive folder)
     -Tunnel                               use when the system is published through Cloudflare Tunnel (trusts proxy headers)
     -RunAs "PC-NAME\user"                 Windows account that runs the server (default: the user signed in now). Not SYSTEM: Edge cannot make PDFs there
 Close any window where you started the ERP by hand (npm.cmd start) before running this.
#>
#Requires -RunAsAdministrator
param([string]$AppDir = "C:\erp", [string]$BackupCopyTo = "", [switch]$Tunnel, [string]$RunAs = "")
$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $AppDir "server.js"))) { throw "server.js was not found in $AppDir. Pass -AppDir with the project folder." }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js is not installed (https://nodejs.org, version 22.5 or newer)." }
Write-Host "Using Node: $node"

# --- one-time secret needed to create the very first admin account (harmless if the admin already exists)
$tokenFile = Join-Path $AppDir "data\setup-token.txt"
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir "data") | Out-Null
if (-not (Test-Path $tokenFile)) { Set-Content -Path $tokenFile -Value (-join ((48..57) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })) }
$token = (Get-Content $tokenFile -Raw).Trim()

# --- launcher: restarts the server automatically if the process ever exits
$proxyLine = if ($Tunnel) { "set TRUST_PROXY=1" } else { "rem (no proxy headers: LAN only)" }
$run = @"
@echo off
cd /d "$AppDir"
set SETUP_TOKEN=$token
$proxyLine
:loop
"$node" --no-warnings server.js >> "$AppDir\data\server.log" 2>&1
timeout /t 5 /nobreak >nul
goto loop
"@
Set-Content -Path (Join-Path $AppDir "run-server.cmd") -Value $run -Encoding ASCII

# --- backup launcher (+ optional copy to a second location)
$copy = if ($BackupCopyTo) { "robocopy `"$AppDir\data\backups`" `"$BackupCopyTo`" erp-*.db /NFL /NDL /NJH /NJS /NP >nul" } else { "rem (no copy target configured)" }
$bk = @"
@echo off
cd /d "$AppDir"
"$node" --no-warnings scripts\backup.js >> "$AppDir\data\backup.log" 2>&1
$copy
"@
Set-Content -Path (Join-Path $AppDir "run-backup.cmd") -Value $bk -Encoding ASCII

# --- daily integrity check (reads only; GITHUB_REPORT_TOKEN / GITHUB_REPORT_REPO are read from .env next to server.js)
$chk = @"
@echo off
cd /d "$AppDir"
"$node" --no-warnings scripts\daily-check.js >> "$AppDir\data\daily-check.log" 2>&1
"@
Set-Content -Path (Join-Path $AppDir "run-check.cmd") -Value $chk -Encoding ASCII

# --- scheduled tasks (at boot / daily)
# Backup and daily check run as SYSTEM. The server itself runs as the signed-in Windows user (S4U: still starts at boot with nobody signed in,
# no password is stored): Microsoft Edge does not run under the SYSTEM account, so every PDF timed out when the server ran as SYSTEM.
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
if (-not $RunAs) { $RunAs = (Get-CimInstance Win32_ComputerSystem).UserName }
if (-not $RunAs) { $RunAs = "$env:USERDOMAIN\$env:USERNAME" }
$serverPrincipal = New-ScheduledTaskPrincipal -UserId $RunAs -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
# re-run on an installed PC: stop the running server first, otherwise the old process (old account) keeps the port and the new task cannot start
Stop-ScheduledTask -TaskName "TrigonERP" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName "TrigonERP" -Confirm:$false -ErrorAction SilentlyContinue
$serverAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$AppDir\run-server.cmd`"" -WorkingDirectory $AppDir
$pdfNote = ""
try {
  Register-ScheduledTask -TaskName "TrigonERP" -Principal $serverPrincipal -Settings $settings -Action $serverAction -Trigger (New-ScheduledTaskTrigger -AtStartup) | Out-Null
} catch {
  Write-Warning "Could not register the server task for user $RunAs ($($_.Exception.Message)). Falling back to the SYSTEM account."
  Register-ScheduledTask -TaskName "TrigonERP" -Principal $principal -Settings $settings -Action $serverAction -Trigger (New-ScheduledTaskTrigger -AtStartup) | Out-Null
  $RunAs = "SYSTEM"; $pdfNote = " WARNING: PDF export does not work under SYSTEM with Microsoft Edge. Re-run with -RunAs `"PC-NAME\user`"."
}
Unregister-ScheduledTask -TaskName "TrigonERP-Backup" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "TrigonERP-Backup" -Principal $principal -Settings $settings `
  -Action (New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$AppDir\run-backup.cmd`"" -WorkingDirectory $AppDir) -Trigger (New-ScheduledTaskTrigger -Daily -At 2:30am) | Out-Null
Unregister-ScheduledTask -TaskName "TrigonERP-Check" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "TrigonERP-Check" -Principal $principal -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable) `
  -Action (New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$AppDir\run-check.cmd`"" -WorkingDirectory $AppDir) -Trigger (New-ScheduledTaskTrigger -Daily -At 3:00am) | Out-Null

# --- keep the PC awake, allow LAN access to the ERP port
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /change disk-timeout-ac 0 | Out-Null
if (-not (Get-NetFirewallRule -DisplayName "Trigon ERP (office network)" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "Trigon ERP (office network)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private, Domain -Action Allow | Out-Null
}

Start-ScheduledTask -TaskName "TrigonERP"
Start-Sleep -Seconds 4
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -ExpandProperty IPAddress

Write-Host ""
Write-Host "=============================================================="
Write-Host " Done. The ERP now starts with Windows and restarts if it stops."
Write-Host " Office address(es):"; $ips | ForEach-Object { Write-Host "     http://${_}:3000" }
Write-Host " First-time admin setup token (only needed once, on a brand-new database):"
Write-Host "     $token"
Write-Host " The server runs as: $RunAs.$pdfNote"
Write-Host " Logs: $AppDir\data\server.log   Backups: $AppDir\data\backups   Daily check: $AppDir\data\daily-check.log"
Write-Host "=============================================================="
