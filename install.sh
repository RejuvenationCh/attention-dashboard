#!/bin/bash
# macOS installer: checks Node, picks a free port, keeps the server running at login
# (LaunchAgent), and opens the dashboard. Safe to run again: it keeps an existing port.
set -euo pipefail
cd "$(dirname "$0")"
DIR="$PWD"
LABEL=com.attention-dashboard
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

step() { printf '[%s/5] %s... ' "$1" "$2"; }
ok() { printf '\033[32m%s\033[0m\n' "${1:-done}"; }
fail() { printf '\033[31mfailed\033[0m\n%s\n' "$1"; exit 1; }

printf '\n\033[36mInstalling Attention Dashboard\033[0m\n\n'

step 1 "Checking Node.js"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node.js is not installed. Get version 22.13 or newer from https://nodejs.org, then run this again."
ok "$("$NODE" -v)"

step 2 "Checking git"
if command -v git >/dev/null; then ok; else printf 'missing\n      The dashboard works, but cannot update itself.\n'; fi

# Also checks the Node version, then picks the first free port from 3100 up (3000 is often
# taken), unless config.json already has one.
step 3 "Choosing a port"
PORT="$("$NODE" install-port.js)" || fail "See the message above."
ok "$PORT"

step 4 "Setting it to start when you log in"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>server.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$DIR/dashboard.log</string>
  <key>StandardErrorPath</key><string>$DIR/dashboard.log</string>
</dict>
</plist>
PL
# Registering again right after removing the old job can fail ("Bootstrap failed: 5") while
# launchd is still tearing it down, so retry for a few seconds.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
for i in 1 2 3 4 5; do
  launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null && break
  [ "$i" = 5 ] && fail "macOS would not register the background job. Try again in a minute."
  sleep 1
done
ok

step 5 "Starting the dashboard"
URL="http://localhost:$PORT"
up=
for _ in $(seq 30); do curl -fs "$URL/api/platform" >/dev/null && { up=1; break; }; printf '.'; sleep 0.5; done
[ -n "$up" ] || fail "It did not start. Last lines of $DIR/dashboard.log:
$(tail -15 "$DIR/dashboard.log" 2>/dev/null)"
ok " running"

printf '\n\033[32mAll set. Attention Dashboard is at %s and starts by itself every time you log in.\033[0m\n' "$URL"
echo "Opening it in your browser now. In Safari, File → Add to Dock gives it its own window."
open "$URL"
