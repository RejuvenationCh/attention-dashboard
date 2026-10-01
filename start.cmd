@echo off
rem Double-click to start the dashboard (after "Stop dashboard", or if it did not start at logon).
rem Says what it is doing. If the background task cannot bring the server up, it runs the
rem server in this window instead, so the dashboard works and any error is shown here.
cd /d "%~dp0"
title Attention Dashboard
echo Starting Attention Dashboard...

where node >nul 2>&1 || (
  echo Node.js is not installed. Install it with:  winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
if not exist config.json (
  echo Not installed yet. Running the installer...
  call "%~dp0install.cmd"
  exit /b
)

set PORT=3100
for /f %%p in ('node -p "require('./config.json').port"') do set PORT=%%p
set URL=http://localhost:%PORT%
rem Checks use 127.0.0.1: Windows tries localhost as ::1 first and waits ~2 s on a refusal.
set CHECK=http://127.0.0.1:%PORT%/api/platform

curl -s -o nul "%CHECK%" && goto open

echo Asking Windows to start it in the background...
schtasks /run /tn "Attention Dashboard" >nul 2>&1 || echo   (the background task is missing; double-click install.cmd to set it up)
set N=0
:wait
curl -s -o nul "%CHECK%" && goto open
set /a N+=1
if %N% geq 15 goto foreground
<nul set /p =.
timeout /t 1 /nobreak >nul
goto wait

:open
echo.
echo Running at %URL%
rem The app window from the installer's shortcut, or a browser tab when there is none.
set LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Attention Dashboard.lnk
if exist "%LNK%" (start "" "%LNK%") else (start "" "%URL%")
exit /b 0

:foreground
echo.
echo The background task did not start it.
if exist dashboard.log (
  echo Last lines of dashboard.log:
  powershell -NoProfile -Command "Get-Content dashboard.log -Tail 15"
)
echo.
echo Starting it in this window instead. Keep this window open while you use the dashboard.
echo If an error appears below, copy it and send it to whoever is helping you.
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process '%URL%'"
node server.js
echo.
echo The dashboard stopped.
pause
