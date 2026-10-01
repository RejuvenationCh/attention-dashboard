@echo off
rem Double-click to install on Windows. A .ps1 opens in Notepad when double-clicked and is
rem blocked by the default script policy, so this runs install.ps1 the way it needs, then
rem waits so any error stays on screen.
cd /d "%~dp0"
where node >nul 2>&1 || (
  echo Node.js is not installed. Install it with:  winget install OpenJS.NodeJS.LTS
  echo Then close this window and double-click install.cmd again.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
if errorlevel 1 (echo Something went wrong. Copy the text above and send it to whoever is helping you.) else (echo Done. You can close this window.)
pause
