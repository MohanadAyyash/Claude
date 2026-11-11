@echo off
rem Trigon ERP - restore the database from a backup (office PC).
rem Put this file in the system folder (the one with server.js, e.g. C:\erp) and double-click it.
rem It stops the system, lets you choose a backup, checks that the backup is healthy, keeps the current
rem database aside (erp-before-restore-...) and starts the system again.
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
$bk = Join-Path $app 'data\backups'
try {
  $files = @(Get-ChildItem -Path $bk -Filter 'erp-*.db' -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  if ($files.Count -eq 0) { throw "No backups found in $bk" }
  Write-Host 'Backups (newest first):'
  for ($i = 0; $i -lt [Math]::Min($files.Count, 30); $i++) { Write-Host ("  {0,2}) {1}   {2:N0} KB" -f ($i + 1), $files[$i].Name, ($files[$i].Length / 1KB)) }
  $n = Read-Host 'Number of the backup to restore (Enter = cancel)'
  if (-not $n) { Write-Host 'Cancelled. Nothing was changed.'; return }
  $pick = $files[[int]$n - 1]
  if (-not $pick) { throw 'No such backup.' }
  $sure = Read-Host ("Restore {0}? Everything entered after that backup will be replaced. Type YES" -f $pick.Name)
  if ($sure -ne 'YES') { Write-Host 'Cancelled. Nothing was changed.'; return }

  Write-Host '1/3 Stopping the system...'
  $task = Get-ScheduledTask -TaskName 'TrigonERP' -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -TaskName 'TrigonERP' }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2

  Write-Host '2/3 Restoring...'
  & node --no-warnings scripts\restore.js $pick.FullName
  $failed = $LASTEXITCODE -ne 0

  Write-Host '3/3 Starting the system...'
  if ($task) { Start-ScheduledTask -TaskName 'TrigonERP' }
  else { Start-Process -FilePath "$app\Trigon-Start.bat" -WorkingDirectory $app -WindowStyle Minimized }
  if ($failed) { throw 'The restore did not run - the database was left as it was.' }
  Write-Host 'Done. Open the system and check the data.'
} catch {
  Write-Host ''
  Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
}
