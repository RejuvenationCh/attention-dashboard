#!/bin/bash
# Double-click to start the dashboard after "Stop dashboard" in Settings (macOS).
# Not installed yet? Runs the installer instead.
cd "$(dirname "$0")"
LABEL=com.attention-dashboard
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[ -f "$PLIST" ] || exec ./install.sh

# Still registered (stopped from Settings): kickstart. Unregistered (bootout): register again.
launchctl kickstart "gui/$UID/$LABEL" 2>/dev/null || launchctl bootstrap "gui/$UID" "$PLIST"

PORT="$(node -p "require('./config.json').port" 2>/dev/null || echo 3100)"
URL="http://localhost:$PORT"
for _ in $(seq 20); do curl -fs "$URL/api/platform" >/dev/null && break; sleep 0.5; done
open "$URL"
echo "Attention Dashboard is running at $URL. You can close this window."
