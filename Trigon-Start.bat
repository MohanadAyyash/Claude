@echo off
chcp 65001 >nul
title Trigon ERP
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Installing it now ^(one time only^)...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Done. Close this window and double-click Trigon-Start.bat again.
  pause
  exit /b
)

rem this PC only; nothing is exposed to the network
set HOST=127.0.0.1
set PORT=3000

rem daily backup when the app starts
node --no-warnings scripts\backup.js >nul 2>nul

start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
echo Trigon ERP is running at http://localhost:3000
echo Keep this window open while you work. Close it to stop the app.
:loop
node --no-warnings server.js
echo The app stopped. Restarting in 5 seconds... ^(close this window to quit^)
timeout /t 5 /nobreak >nul
goto loop
