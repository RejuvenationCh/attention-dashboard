@echo off
rem Double-click to start the dashboard after "Stop dashboard" in Settings (Windows).
rem Not installed yet? Runs the installer instead.
cd /d "%~dp0"
schtasks /query /tn "Attention Dashboard" >nul 2>&1 || (powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 & exit /b)

set PORT=3100
for /f %%p in ('node -p "require('./config.json').port"') do set PORT=%%p
set URL=http://localhost:%PORT%

rem Already running (never stopped, or an update restarted it): just open it.
curl -s -o nul "%URL%/api/platform" || schtasks /run /tn "Attention Dashboard" >nul

set N=0
:wait
curl -s -o nul "%URL%/api/platform" && goto open
set /a N+=1
if %N% geq 20 goto open
timeout /t 1 /nobreak >nul
goto wait

:open
start "" "%URL%"
