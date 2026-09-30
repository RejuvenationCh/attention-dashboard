#!/bin/bash
# macOS installer: checks Node, picks a free port, keeps the server running at login
# (LaunchAgent), and opens the dashboard. Safe to run again: it keeps an existing port.
set -euo pipefail
cd "$(dirname "$0")"
DIR="$PWD"
LABEL=com.attention-dashboard
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js is not installed. Get version 22.13 or newer from https://nodejs.org, then run this again."; exit 1; }
command -v git >/dev/null || echo "Note: git is missing, so the dashboard cannot update itself."

# Checks the Node version, then picks the first free port from 3100 up (3000 is often taken),
# unless config.json already has one.
PORT="$("$NODE" install-port.js)"

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

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

URL="http://localhost:$PORT"
for _ in $(seq 20); do curl -fs "$URL/api/platform" >/dev/null && break; sleep 0.5; done
echo "Attention Dashboard is running at $URL and will start at every login."
echo "In Safari: File → Add to Dock… gives it its own window. Logs: $DIR/dashboard.log"
open "$URL"
