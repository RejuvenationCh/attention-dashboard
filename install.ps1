# Windows installer: checks Node, picks a free port, starts the server hidden at every logon
# (Task Scheduler, not a Service: the folder picker needs a desktop session), and opens it.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File install.ps1
# Written for Windows PowerShell 5.1 (built into Windows 10/11). Safe to run again: it keeps
# an existing port. UNTESTED on real Windows so far.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host 'Node.js is not installed. Install it with:  winget install OpenJS.NodeJS.LTS'
  Write-Host 'then open a NEW PowerShell window and run this again.'
  exit 1
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'Note: git is missing, so the dashboard cannot update itself (winget install Git.Git).'
}

# Checks the Node version, then prints the port (first free from 3100 up, or the saved one).
$port = & $node install-port.js
if ($LASTEXITCODE -ne 0) { exit 1 }
$port = "$port".Trim()

# conhost --headless runs the console app with no window at all, not even a flash at logon.
# cmd /c is only there to append the output to dashboard.log.
$task    = 'Attention Dashboard'
$action  = New-ScheduledTaskAction -Execute 'conhost.exe' -WorkingDirectory $PSScriptRoot `
             -Argument "--headless cmd.exe /c `"`"$node`" server.js >> dashboard.log 2>&1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

# A reinstall replaces a running server. Whatever listens on this install's port is its old
# server (the task's, or one a self-update started outside the task), so stop exactly that.
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName $task

$url = "http://localhost:$port"
$up = $false
foreach ($i in 1..30) {
  try { Invoke-WebRequest "$url/api/platform" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break }
  catch { Start-Sleep -Milliseconds 500 }
}
if (-not $up) { Write-Host "The server did not start. See dashboard.log in $PSScriptRoot"; exit 1 }
Write-Host "Attention Dashboard is running at $url and will start at every logon."
Write-Host 'For its own window: open it in Edge, then ... menu > Apps > Install this site as an app.'
Start-Process $url
