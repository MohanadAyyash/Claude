@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "S=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $l=$w.CreateShortcut('%S%\Trigon ERP.lnk'); $l.TargetPath='%~dp0Trigon-Start.bat'; $l.WorkingDirectory='%~dp0'; $l.WindowStyle=7; $l.Save(); $d=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Trigon ERP.lnk'); $d.TargetPath='%~dp0Trigon-Start.bat'; $d.WorkingDirectory='%~dp0'; $d.Save()"
echo Done: a "Trigon ERP" icon is on your Desktop and the app will start when you sign in to Windows.
pause
