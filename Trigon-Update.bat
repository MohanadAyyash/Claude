@echo off
rem Trigon ERP - one-click update for the office PC.
rem Put this file in the system folder (the one with server.js, e.g. C:\erp) and double-click it.
rem It backs up the data folder, downloads the latest version from GitHub, replaces the program files
rem (the data folder is never touched), restarts the system and checks that it answers.
cd /d "%~dp0"
if not exist "server.js" ( echo This file must be inside the Trigon ERP folder, next to server.js. & pause & exit /b 1 )
net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$m = '#' + 'POWERSHELL-BELOW'; $code = ((Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8) -split [regex]::Escape($m), 2)[1]; Set-Location -LiteralPath '%~dp0'; Invoke-Expression $code"
echo.
pause
exit /b

#POWERSHELL-BELOW
$ErrorActionPreference = 'Stop'
$app = (Get-Location).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$url = 'https://github.com/MohanadAyyash/Claude/archive/refs/heads/claude/construction-management-app-rfq8al.zip'
try {
  Write-Host '1/4 Backing up the data folder...'
  if (Test-Path "$app\data") {
    $bk = "$app\data-backup-$stamp"
    robocopy "$app\data" $bk /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Backup failed - nothing was changed.' }
    Write-Host "    saved to $bk"
  } else { Write-Host '    (no data folder here - the data lives where DATA_DIR points)' }

  Write-Host '2/4 Downloading the latest version...'
  $zip = Join-Path $env:TEMP 'trigon-erp-update.zip'
  $tmp = Join-Path $env:TEMP 'trigon-erp-update'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
  if (-not (Test-Path "$src\server.js")) { throw 'The download does not look right - nothing was changed.' }

  Write-Host '3/4 Stopping the system and replacing the program files...'
  $task = Get-ScheduledTask -TaskName 'TrigonERP' -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -TaskName 'TrigonERP' }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
  robocopy $src $app /E /XD data node_modules .git /XF Trigon-Update.bat /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'Copying the new files failed. Your data is safe; run this again.' }

  Write-Host '4/4 Starting the system...'
  if ($task) { Start-ScheduledTask -TaskName 'TrigonERP' }
  else { Start-Process -FilePath "$app\Trigon-Start.bat" -WorkingDirectory $app -WindowStyle Minimized }
  $ok = $false
  foreach ($i in 1..20) {
    Start-Sleep -Seconds 2
    try { if ((Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/api/status' -TimeoutSec 3).StatusCode -eq 200) { $ok = $true; break } } catch { }
  }
  Write-Host ''
  if ($ok) { Write-Host 'DONE - Trigon ERP is updated and running.' -ForegroundColor Green }
  else { Write-Host 'Files updated, but the system has not answered yet. Restart the PC. Your data is safe.' -ForegroundColor Yellow }
} catch {
  Write-Host ''
  Write-Host ('Update stopped: ' + $_.Exception.Message) -ForegroundColor Red
}
