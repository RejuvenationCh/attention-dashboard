# Turning a localhost project into a Mac app

How the Attention Dashboard is set up: a Node server that starts at login and keeps running, plus a
Dock icon that opens it in its own window with no browser chrome. Same recipe works for any project
that serves a web page on a port.

Placeholders used below:

| Placeholder | Example |
|---|---|
| `<name>` | `attention-dashboard` |
| `<Label>` | `com.chris.attention-dashboard` |
| `<dir>` | `/Users/rejuvenation/Data C (General)/Projects/Personal/Attention Dashboard` |
| `<port>` | `3000` |

## 1. Keep the server running (LaunchAgent)

`launchd` starts it at login and restarts it if it crashes — no terminal left open.

Save as `~/Library/LaunchAgents/<Label>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string><Label></string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string><dir></string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/<name>.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/<name>.log</string>
</dict>
</plist>
```

Notes:

- Use the **absolute** path to the runtime (`which node` — Homebrew on Apple Silicon is
  `/opt/homebrew/bin/node`). launchd has a bare PATH; `node` alone will not resolve.
- `WorkingDirectory` is what makes relative paths (`server.js`, `./data.db`, `.env`) work.
- Spaces in the path are fine inside the XML; no escaping needed.
- Anything the process prints goes to the log file. Nothing rotates it — truncate it if it grows.

Commands:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/<Label>.plist   # install + start (first time)
launchctl kickstart -k gui/$UID/<Label>                             # restart, e.g. after editing server code
launchctl bootout gui/$UID/<Label>                                  # stop and disable until next login
launchctl print gui/$UID/<Label> | head -20                         # state, last exit code, PID
tail -f /tmp/<name>.log                                             # logs
```

## 2. Give it a Dock icon (Safari web app)

1. Open `http://localhost:<port>` in Safari.
2. **File → Add to Dock…**, name it, confirm.
3. It becomes a real app in `~/Applications/<Name>.app` with its own icon, window and Dock entry.

It picks up `<link rel="icon">` from the page, so set a favicon (an SVG works) before adding it.

What differs from a normal tab:

- No address bar. Reload is ⌘R; there is no ⌘⌥R hard reload, so see the caching note below.
- It has its own storage: `localStorage` set in Safari proper is **not** shared with the web app.
- It appears in **System Settings → Notifications** under its own name, separate from Safari.
- Quit it from the Dock (right-click → Quit) to fully restart it; ⌘R only reloads the page.

## 3. Serve with no-cache while developing

Safari caches aggressively and a web app has no hard-reload shortcut. Mixing a stale `index.html`
with fresh JS breaks things in ways that look like real bugs. Send this on every static response:

```js
res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
```

`no-cache` still lets the browser store the file, it just has to revalidate — fine on localhost.

## 4. Notifications without asking the browser

A Safari web app on `http://localhost` can't reliably get Web Notification permission, and once
it's denied there is no way back. Post them from the server instead, through AppleScript:

```js
const { execFile } = require('child_process');

// argv form: nothing in title/body is ever parsed as AppleScript
function notifyMac(title, body) {
  return new Promise((ok, fail) => execFile('osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e', 'end run',
    String(title).slice(0, 120), String(body).slice(0, 500),
  ], { timeout: 10000 }, err => err ? fail(err) : ok()));
}
```

- Banners appear under **Script Editor** in System Settings → Notifications; allow it there once.
- Because the server sends them, they work with the app closed — put the timer in the server, not
  in the page.

## 5. Fencing local API endpoints

Any page on the machine can call your server, so gate anything that touches the filesystem or
runs a command:

```js
const origin = req.headers.origin;
if (origin && origin !== `http://localhost:${PORT}`) return json(res, 403, { error: 'bad origin' });
if (!(req.headers['content-type'] || '').includes('application/json')) {
  return json(res, 415, { error: 'expected application/json' });
}
```

Requiring JSON forces a CORS preflight, which a random website can't get past. Pass user input as
**argv** to `execFile`, never through a shell string.

## 6. Checking on it

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN            # who owns the port
ps -o pid,etime,rss,command -p <pid>          # uptime and memory (RSS in KB)
```

Activity Monitor's "Memory" column for the Dock app aggregates all its WebKit processes and counts
compressed memory, so it reads several times higher than the page actually uses. A few hundred MB
for a long-open web app window is normal; the Node server itself should stay tens of MB.

Port already taken? Some apps squat on common ports (Adobe's CEP helper listens on 3000). Pick
something less popular, e.g. 3100+.

## 7. Removing it

```bash
launchctl bootout gui/$UID/<Label>
rm ~/Library/LaunchAgents/<Label>.plist
rm -rf ~/Applications/<Name>.app          # the Dock app
```
