// The only OS-specific code in the app. macOS is the tested path; the Windows branches
// are unverified until someone runs them on Windows.
// Everything goes through execFile with argv, never a shell, so no path or title is parsed.
// PowerShell scripts go in as -EncodedCommand (base64 UTF-16), which sidesteps Windows'
// command-line quoting entirely, and print UTF-8 so non-English folder names survive.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OS = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'other';

function powershell(script, opts, cb) {
  const encoded = Buffer.from('[Console]::OutputEncoding = [Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64');
  return execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
    { windowsHide: true, encoding: 'utf8', ...opts }, cb);
}

// Directory: open it. File: select it in its parent folder.
function reveal(target, isDir) {
  if (OS === 'mac') return execFile('open', isDir ? [target] : ['-R', target], err => err && console.error('[reveal]', err.message));
  // explorer.exe exits 1 even on success, so its error is never a failure. It parses its own
  // command line and wants /select,"C:\a b\c" exactly, so the quoting is done here (a Windows
  // path cannot contain a quote). normalize turns C:/x into C:\x, which explorer requires.
  if (OS === 'windows') {
    const p = `"${path.normalize(target)}"`;
    return execFile('explorer.exe', [isDir ? p : '/select,' + p], { windowsVerbatimArguments: true }, () => {});
  }
  execFile('xdg-open', [target], err => err && console.error('[reveal]', err.message));
}

// Resolves to a path, or null when the user cancels.
function pickFolder() {
  return new Promise((resolve, reject) => {
    if (OS === 'mac') {
      return execFile('osascript', [
        '-e', 'activate',
        '-e', 'POSIX path of (choose folder with prompt "Choose a folder for this task")',
      ], { timeout: 180000 }, (err, stdout, stderr) => {
        // -128 is the user pressing Cancel.
        if (err) return /-128/.test((stderr || '') + err.message) ? resolve(null) : reject(new Error((stderr || err.message).trim()));
        resolve(stdout.trim().replace(/\/+$/, ''));
      });
    }
    if (OS === 'windows') {
      // STA (set in powershell()) is required or the dialog fails opaquely; the TopMost owner
      // keeps it in front of the browser.
      const ps = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose a folder for this task'
$d.ShowNewFolderButton = $false
if ($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true})) -eq 'OK') { $d.SelectedPath } else { exit 2 }`;
      return powershell(ps, { timeout: 180000 }, (err, stdout) => {
        if (err) return err.code === 2 ? resolve(null) : reject(err);
        resolve(stdout.trim().replace(/[\\/]+$/, ''));
      });
    }
    reject(new Error('no folder picker on this platform'));
  });
}

// Title and body travel as argv (mac) or environment variables (Windows), never as script text.
function notify(title, body) {
  title = String(title).slice(0, 120); body = String(body).slice(0, 500);
  return new Promise((resolve, reject) => {
    const done = err => err ? reject(err) : resolve();
    if (OS === 'mac') {
      return execFile('osascript', [
        '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run',
        title, body,
      ], { timeout: 10000 }, done);
    }
    if (OS === 'windows') {
      // ponytail: borrows PowerShell's app id so no registration is needed; toasts show as "Windows PowerShell".
      const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode($env:AD_TITLE)) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:AD_BODY)) > $null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
      return powershell(ps, { timeout: 15000, env: { ...process.env, AD_TITLE: title, AD_BODY: body } }, done);
    }
    reject(new Error('no notifications on this platform'));
  });
}

// Come back up after an update. The macOS LaunchAgent restarts the server only when it exits
// with an error (KeepAlive SuccessfulExit=false), so exit 1 asks for a restart and exit 0,
// from stop(), stays down. Windows' scheduled task never restarts it, so start the new server
// first; it retries its port until this one has let go (see listen in server.js).
function restart() {
  if (OS === 'windows') {
    const log = fs.openSync(path.join(__dirname, 'dashboard.log'), 'a');
    spawn(process.execPath, process.argv.slice(1), { cwd: __dirname, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
    process.exit(0);
  }
  process.exit(1);
}

// "Stop dashboard" in Settings: down until the next login, or start.command / start.cmd.
function stop() { process.exit(0); }

// Shown in toasts so the hint matches the OS that is actually delivering the banner.
const notifyHint = OS === 'mac' ? 'No banner? Allow "Script Editor" in System Settings → Notifications.'
  : OS === 'windows' ? 'No banner? Check Windows Settings → System → Notifications.' : '';

const capabilities = { os: OS, canReveal: true, canPickFolder: OS !== 'other', canNotify: OS !== 'other', notifyHint };

module.exports = { OS, reveal, pickFolder, notify, restart, stop, capabilities };
