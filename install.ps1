# Windows installer: checks Node, picks a free port, starts the server hidden at every logon
# (Task Scheduler, not a Service: the folder picker needs a desktop session), and opens it.
# Run by double-clicking install.cmd. Written for Windows PowerShell 5.1 (built into Windows
# 10/11). Safe to run again: it keeps an existing port. It says what it is doing at each step.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's own progress bar is just noise here
Set-Location $PSScriptRoot

function Step($n, $text) { Write-Host -NoNewline "[$n/5] $text... " }
function Ok($text = 'done') { Write-Host $text -ForegroundColor Green }
function Fail($text) { Write-Host 'failed' -ForegroundColor Red; Write-Host $text; exit 1 }

Write-Host ''
Write-Host 'Installing Attention Dashboard' -ForegroundColor Cyan
Write-Host ''

Step 1 'Checking Node.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'Node.js is not installed. Run:  winget install OpenJS.NodeJS.LTS  then try again in a NEW window.' }
Ok (& $node -v)

Step 2 'Checking git'
if (Get-Command git -ErrorAction SilentlyContinue) { Ok }
else { Write-Host 'missing' -ForegroundColor Yellow; Write-Host '      The dashboard works, but cannot update itself. Run:  winget install Git.Git' }

# Also checks the Node version, then prints the port (first free from 3100 up, or the saved one).
Step 3 'Choosing a port'
$port = & $node install-port.js
if ($LASTEXITCODE -ne 0) { Fail 'See the message above.' }
$port = "$port".Trim()
Ok $port

# conhost --headless runs node with no window at all, not even a flash at logon. The server
# writes dashboard.log itself on Windows, so no cmd redirection (and its quoting) is needed.
Step 4 'Setting it to start when you log in'
$task    = 'Attention Dashboard'
try {
  $action  = New-ScheduledTaskAction -Execute 'conhost.exe' -WorkingDirectory $PSScriptRoot `
               -Argument "--headless `"$node`" server.js"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Ok
} catch { Fail "Windows refused to create the startup task: $($_.Exception.Message)" }

# A reinstall replaces a running server. Whatever listens on this install's port is its old
# server (the task's, or one a self-update started outside the task), so stop exactly that.
Step 5 'Starting the dashboard'
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName $task

$url = "http://localhost:$port"
$up = $false
foreach ($i in 1..30) {
  try { Invoke-WebRequest "$url/api/platform" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break }
  catch { Write-Host -NoNewline '.'; Start-Sleep -Milliseconds 500 }
}
if (-not $up) {
  Write-Host ' failed' -ForegroundColor Red
  if (Test-Path dashboard.log) { Write-Host 'Last lines of dashboard.log:'; Get-Content dashboard.log -Tail 15 }
  Write-Host ''
  Write-Host 'It is installed, but the background start did not work. Double-click start.cmd to run'
  Write-Host 'it in a window instead, and send whoever is helping you what both windows show.'
  exit 1
}
Ok ' running'

Write-Host ''
Write-Host "All set. Attention Dashboard is at $url and starts by itself every time you log in." -ForegroundColor Green
Write-Host 'Opening it in your browser now. For its own window: in Edge, ... menu > Apps > Install this site as an app.'
Start-Process $url
