# Windows installer: checks Node, picks a free port, starts the server hidden at every logon
# (Task Scheduler, not a Service: the folder picker needs a desktop session), and opens it.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File install.ps1
# UNTESTED on real Windows so far. Safe to run again: it keeps an existing port.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Node.js is not installed. Get version 22.13 or newer from https://nodejs.org, then run this again.'; exit 1 }
& $node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'
if ($LASTEXITCODE -ne 0) { Write-Host "Node $(& $node -v) is too old; this needs 22.13 or newer (https://nodejs.org)."; exit 1 }

$port = (& $node install-port.js).Trim()

# ponytail: -WindowStyle Hidden still flashes a console for a moment at logon; a .vbs launcher
# would remove that. Not a background (S4U) task: that has no desktop, so the picker could not open.
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $PSScriptRoot `
              -Argument "-NoProfile -WindowStyle Hidden -Command `"& '$node' server.js *>> dashboard.log`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Attention Dashboard' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Stop-ScheduledTask -TaskName 'Attention Dashboard' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'Attention Dashboard'

$url = "http://localhost:$port"
foreach ($i in 1..20) { try { Invoke-WebRequest "$url/api/platform" -UseBasicParsing | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }
Write-Host "Attention Dashboard is running at $url and will start at every logon."
Write-Host 'In Edge or Chrome: menu -> Apps -> Install this site as an app, for its own window.'
Start-Process $url
