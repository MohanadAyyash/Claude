@echo off
rem Trigon ERP - one-click update for the office PC.
rem Put this file in the system folder (the one with server.js, e.g. C:\erp) and double-click it.
rem 1. backs up the data folder; 2. downloads the latest version from GitHub; then runs scripts\update.js FROM THE DOWNLOAD:
rem 3. installs the exact runtime dependencies (npm ci --omit=dev) into a staging copy - nothing live changes if this fails;
rem 4-5. stops the system and swaps the program files and node_modules in by renaming (the previous ones go to app-backup-...);
rem 6. starts the new version and checks that it answers. If anything after the stop fails, the previous program files and
rem node_modules are moved back, checked byte for byte, and the previous version is started again. The data folder is never
rem touched. Exit code 0 = updated, 1 = not updated (the message says whether the previous version was restored).
rem This file replaces itself with the new version after this window closes (scripts\update-finish.js).
cd /d "%~dp0"
if not exist "server.js" ( echo This file must be inside the Trigon ERP folder, next to server.js. & pause & exit /b 1 )
set "TRIGON_OUTER_PID="
if /i "%~1"=="--outer" set "TRIGON_OUTER_PID=%~2"
net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator rights...
  powershell -NoProfile -Command "$o = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId; $p = Start-Process -FilePath '%~f0' -ArgumentList ('--outer ' + $o) -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
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
$branch = 'claude/construction-management-app-rfq8al'
# for testing a branch before it is merged (same repository only): set TRIGON_UPDATE_BRANCH=<branch name>
if ($env:TRIGON_UPDATE_BRANCH) { if ($env:TRIGON_UPDATE_BRANCH -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$' -or $env:TRIGON_UPDATE_BRANCH -match '\.\.') { Write-Host 'TRIGON_UPDATE_BRANCH is not a valid branch name - nothing was changed.' -ForegroundColor Red; exit 1 }; $branch = $env:TRIGON_UPDATE_BRANCH; Write-Host "Testing branch: $branch" -ForegroundColor Yellow }
$url = 'https://github.com/MohanadAyyash/Trigon-ERP-System/archive/refs/heads/' + $branch + '.zip'
$rc = 1
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js / npm was not found on this PC - nothing was changed. Install Node.js 22 LTS and run this again.' }

  Write-Host '1/6 Backing up the data...'
  if (Test-Path "$app\data") {
    $bk = "$app\data-backup-$stamp"
    robocopy "$app\data" $bk /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Backup failed - nothing was changed.' }
    Write-Host "    saved to $bk"
  } else { Write-Host '    (no data folder here - the data lives where DATA_DIR points)' }

  Write-Host '2/6 Downloading the latest version...'
  $zip = Join-Path $env:TEMP 'trigon-erp-update.zip'
  $tmp = Join-Path $env:TEMP 'trigon-erp-update'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
  if (-not (Test-Path "$src\server.js") -or -not (Test-Path "$src\package-lock.json") -or -not (Test-Path "$src\scripts\update.js")) { throw 'The download does not look right - nothing was changed.' }

  # the cmd.exe windows running this file: the updater replaces itself only after they have closed
  $pids = @((Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId)
  if ($env:TRIGON_OUTER_PID -match '^\d+$') { $pids += [int]$env:TRIGON_OUTER_PID }
  & node --no-warnings "$src\scripts\update.js" --app "$app" --src "$src" --wait-pid ($pids -join ',')
  $rc = $LASTEXITCODE
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
} catch {
  Write-Host ''
  Write-Host ('UPDATE FAILED: ' + $_.Exception.Message) -ForegroundColor Red
  $rc = 1
}
if ($rc -eq 0) { exit 0 } else { exit 1 }
