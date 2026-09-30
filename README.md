# Attention Dashboard

One page for your day: your Google Calendar events, your tasks and your eLearn (Moodle)
deadlines, side by side. It runs on your own computer, and your tasks and sign-ins never
leave it.

- **Schedule** for today and the next few days, with free time between events
- **Tasks** with deadlines, snoozing, repeats and links to files or folders
- **Course deadlines** from eLearn, soonest first
- **Reminders** for things that are due, even with the dashboard closed
- A **month view**, and replies to calendar invitations

Works on macOS and Windows 10/11.

## Install

You need two free tools first: **Node.js** (version 22.13 or newer) and **git**.

### macOS

1. Install Node.js from [nodejs.org](https://nodejs.org) (the LTS button), or run
   `brew install node` if you use Homebrew.
2. Open **Terminal** and run these three lines. If macOS offers to install the "command line
   developer tools" for git, click Install, then run them again.

   ```bash
   git clone https://github.com/RejuvenationCh/attention-dashboard.git
   cd attention-dashboard
   ./install.sh
   ```

The dashboard opens in your browser. For its own window and Dock icon: in Safari, choose
**File → Add to Dock**.

### Windows

1. Open **PowerShell** and install the tools:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```

2. Close PowerShell, open a **new** PowerShell window, and run:

   ```powershell
   git clone https://github.com/RejuvenationCh/attention-dashboard.git
   cd attention-dashboard
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

The dashboard opens in your browser. For its own window: in Edge, open the **⋯** menu →
**Apps → Install this site as an app**.

> The Windows version is new and has not been tested much yet. If something goes wrong,
> please send the error along with the file `dashboard.log` from the `attention-dashboard`
> folder.

After installing, the dashboard starts on its own every time you log in. There is nothing to
keep open.

## First-time setup

### 1. Connect Google Calendar

Click **Connect Google Calendar** and sign in. Google will say **"Google hasn't verified this
app"**. That is expected for a small app like this one: click **Advanced**, then the
**Go to … (unsafe)** link at the bottom. You only see it once per account.

You can connect more than one Google account. Tick or untick calendars in the Accounts card
to show or hide them.

### 2. Your name

Open **Settings** (the gear at the top right) and fill in **Your name** for the greeting.

### 3. eLearn deadlines (optional)

1. On eLearn, open **Calendar → Export calendar**.
2. Choose which events to include, and pick the widest time period on offer (a custom range
   if you have one). "Recent and upcoming" only covers about two months either way, so
   deadlines further out would be missing.
3. Click **Get URL for subscription** and copy the whole link.
4. In the dashboard's **Settings**, paste it into **eLearn calendar**.

Each course shows up as its own calendar. eLearn only gives a course code
(`20261_IMT01303305-A`), so click the **pencil** next to a course to give it a proper name.

A course only appears once it has at least one assignment or quiz with a due date.

The export link works like a password to your eLearn calendar. It is stored only on your
computer and never shown again.

## Reminders

Click the **bell** in the Tasks card, next to the sort menu, to turn on reminders for tasks and
deadlines. **Settings → Remind me** sets how many days ahead.

- **macOS:** notifications arrive from **Script Editor**. If none appear, allow Script Editor in
  **System Settings → Notifications**.
- **Windows:** notifications arrive from **Windows PowerShell**. If none appear, check
  **Settings → System → Notifications**.

## Updates

The dashboard updates itself: it checks for a new version every few hours and restarts into
it. Your tasks, sign-ins and settings are kept. **Settings** shows the version you have.

## Your data

Everything stays in the `attention-dashboard` folder on your computer: tasks, Google sign-ins
and settings. Only your own computer can open the dashboard; other devices on the same Wi-Fi
cannot. To move to another computer, copy these files from the folder: `tasks.db`,
`tokens.json`, `config.json` and `courses.json`.

## Troubleshooting

- **Where is it?** Open `http://localhost:3100` in your browser. The exact number is in
  `config.json` in the folder (`"port"`).
- **It doesn't open.** Run the install step again; it is safe to repeat. If it still fails,
  `dashboard.log` in the folder says why.
- **A Google account says "Signed out".** Click **Reconnect** next to it.

## Uninstall

**macOS**, in Terminal:

```bash
launchctl bootout gui/$UID/com.attention-dashboard
rm ~/Library/LaunchAgents/com.attention-dashboard.plist
```

**Windows:** open **Task Scheduler**, delete the task **Attention Dashboard**, then restart.

Then delete the `attention-dashboard` folder.
