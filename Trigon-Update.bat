@echo off
rem Trigon ERP - one-click update for the office PC.
rem Put this file in the system folder (the one with server.js, e.g. C:\erp) and double-click it.
rem It backs up the data folder, downloads the latest version from GitHub, installs the exact runtime
rem dependencies from package-lock.json (npm ci --omit=dev) into the new copy BEFORE touching the running
rem system, then replaces the program files (the data folder is never touched), restarts the system and
rem checks that it answers. If any step fails, it stops with an error and a non-zero exit code.
cd /d "%~dp0"
if not exist "server.js" ( echo This file must be inside the Trigon ERP folder, next to server.js. & pause & exit /b 1 )
net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator rights...
  powershell -NoProfile -Command "$p = Start-Process -FilePath '%~f0' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
  exit /b %errorlevel%
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$m = '#' + 'POWERSHELL-BELOW'; $code = ((Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8) -split [regex]::Escape($m), 2)[1]; Set-Location -LiteralPath '%~dp0'; Invoke-Expression $code"
set "RC=%errorlevel%"
echo.
pause
exit /b %RC%

#POWERSHELL-BELOW
$ErrorActionPreference = 'Stop'
$app = (Get-Location).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$url = 'https://github.com/MohanadAyyash/Trigon-ERP-System/archive/refs/heads/claude/construction-management-app-rfq8al.zip'
$failed = $true
try {
  Write-Host '1/6 Backing up the data and program files...'
  if (Test-Path "$app\data") {
    $bk = "$app\data-backup-$stamp"
    robocopy "$app\data" $bk /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Backup failed - nothing was changed.' }
    Write-Host "    saved to $bk"
  } else { Write-Host '    (no data folder here - the data lives where DATA_DIR points)' }

  $pb = "$app\app-backup-$stamp"                                                   # program files too, so any edit made directly on this PC can be recovered
  robocopy $app $pb /E /XD data node_modules .git data-backup-* app-backup-* /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'Program backup failed - nothing was changed.' }
  Write-Host "    program files saved to $pb"
  Get-ChildItem $app -Directory -Filter 'app-backup-*' | Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  Write-Host '2/6 Downloading the latest version...'
  $zip = Join-Path $env:TEMP 'trigon-erp-update.zip'
  $tmp = Join-Path $env:TEMP 'trigon-erp-update'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
  if (-not (Test-Path "$src\server.js") -or -not (Test-Path "$src\package-lock.json")) { throw 'The download does not look right - nothing was changed.' }

  Write-Host '3/6 Installing the runtime dependencies (npm ci --omit=dev)...'
  # into the downloaded copy, from its package-lock.json - the running system is not touched until this has succeeded
  if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js / npm was not found on this PC - nothing was changed. Install Node.js 22 LTS and run this again.' }
  Push-Location $src
  try {
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit code $LASTEXITCODE) - nothing was changed. Check the internet connection to registry.npmjs.org and run this again." }
    & npm.cmd ls --omit=dev --depth=0 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The installed dependencies do not match package-lock.json - nothing was changed.' }
    & node -e "require('jose')"
    if ($LASTEXITCODE -ne 0) { throw 'The jose package could not be loaded after installing - nothing was changed.' }
  } finally { Pop-Location }
  Write-Host '    dependencies installed and verified' -ForegroundColor Green

  Write-Host '4/6 Stopping the system and replacing the program files...'
  $task = Get-ScheduledTask -TaskName 'TrigonERP' -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -TaskName 'TrigonERP' }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
  robocopy $src $app /E /XD data node_modules .git /XF Trigon-Update.bat /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'Copying the new files failed. Your data is safe; run this again.' }
  Write-Host '    application files updated'

  Write-Host '5/6 Putting the installed dependencies in place...'
  # an exact mirror of the freshly installed node_modules: nothing from an earlier install is kept
  robocopy "$src\node_modules" "$app\node_modules" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'Copying the dependencies failed. Your data is safe; run this again.' }
  Push-Location $app
  try { & node -e "require('jose')"; if ($LASTEXITCODE -ne 0) { throw 'The dependencies are not usable in the system folder. Your data is safe; run this again.' } } finally { Pop-Location }
  Write-Host '    dependencies in place'

  Write-Host '6/6 Starting the system...'
  if ($task) { Start-ScheduledTask -TaskName 'TrigonERP' }
  else { Start-Process -FilePath "$app\Trigon-Start.bat" -WorkingDirectory $app -WindowStyle Minimized }
  $ok = $false
  foreach ($i in 1..20) {
    Start-Sleep -Seconds 2
    try { if ((Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/api/status' -TimeoutSec 3).StatusCode -eq 200) { $ok = $true; break } } catch { }
  }
  Write-Host ''
  if ($ok) { Write-Host 'DONE - Trigon ERP is updated and running.' -ForegroundColor Green; $failed = $false }
  else { Write-Host 'UPDATE NOT CONFIRMED - the files and dependencies were updated, but the system has not answered yet. Restart the PC. Your data is safe.' -ForegroundColor Yellow }
} catch {
  Write-Host ''
  Write-Host ('UPDATE FAILED: ' + $_.Exception.Message) -ForegroundColor Red
  # if the system was stopped for the update, start it again (with whatever files are in place) so the office is not left without it
  if ($task -and (Get-ScheduledTask -TaskName 'TrigonERP' -ErrorAction SilentlyContinue).State -ne 'Running') { Start-ScheduledTask -TaskName 'TrigonERP' -ErrorAction SilentlyContinue }
}
if ($failed) { exit 1 } else { exit 0 }
