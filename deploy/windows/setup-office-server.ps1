<#
 Turns an always-on Windows PC into the ERP server:
   - starts the ERP automatically at boot (no login needed) and restarts it if it ever crashes
   - runs a daily database backup at 02:30 (optionally copied to another folder / drive / OneDrive)
   - stops the PC from sleeping, opens the LAN port in the firewall, prints the office address

 Run PowerShell AS ADMINISTRATOR, from the project folder (e.g. C:\erp):
     powershell -ExecutionPolicy Bypass -File deploy\windows\setup-office-server.ps1
 Options:
     -AppDir "C:\erp"                      project folder (default C:\erp)
     -BackupCopyTo "D:\ERP-Backups"        also copy every backup here (external disk / network share / OneDrive folder)
     -Tunnel                               use when the system is published through Cloudflare Tunnel (trusts proxy headers)
 Close any window where you started the ERP by hand (npm.cmd start) before running this.
#>
#Requires -RunAsAdministrator
param([string]$AppDir = "C:\erp", [string]$BackupCopyTo = "", [switch]$Tunnel)
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

# --- scheduled tasks (run as SYSTEM at boot / daily)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Unregister-ScheduledTask -TaskName "TrigonERP" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "TrigonERP" -Principal $principal -Settings $settings `
  -Action (New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$AppDir\run-server.cmd`"" -WorkingDirectory $AppDir) -Trigger (New-ScheduledTaskTrigger -AtStartup) | Out-Null
Unregister-ScheduledTask -TaskName "TrigonERP-Backup" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "TrigonERP-Backup" -Principal $principal -Settings $settings `
  -Action (New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$AppDir\run-backup.cmd`"" -WorkingDirectory $AppDir) -Trigger (New-ScheduledTaskTrigger -Daily -At 2:30am) | Out-Null

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
Write-Host " Logs: $AppDir\data\server.log   Backups: $AppDir\data\backups"
Write-Host "=============================================================="
