# Attention Dashboard — Windows Port

## Goal

A personal calendar + task dashboard that runs on `localhost`, reads Google
Calendar across multiple accounts, stores tasks in SQLite, and writes a daily
AI briefing. A working macOS version exists; this is a port of it.

**Not a rewrite.** The macOS build is ~2,250 lines of vanilla HTML/CSS/JS plus a
zero-dependency Node server. Exactly **four places** are platform-specific.
Everything else runs unchanged on Windows.

---

## Stack (do not change)

- **Node ≥ 24** (needs `node:sqlite`, built in — no npm packages at all)
- Vanilla HTML/CSS/JS. No framework, no bundler, no TypeScript, no build step.
- `node:http` server, ~350 lines, serving static files + a small JSON API.
- SQLite via `node:sqlite` for tasks. `tokens.json` for OAuth refresh tokens.

```
attention-dashboard/
├── server.js          # static files + OAuth + Gemini proxy + tasks API
├── package.json       # no dependencies; "start": "node server.js"
├── .env               # secrets (gitignored)
├── .env.example
├── .gitignore         # .env, tokens.json, tasks.db*
├── tasks.db           # created on first run
└── public/
    ├── index.html
    ├── app.js
    ├── style.css
    └── logo.svg
```

---

## The four platform-specific changes

Everything below is the complete list. Nothing else needs touching.

### 1. Reveal a folder in the file manager

macOS uses `open`. Windows uses `explorer.exe`.

```js
// server.js — inside POST /api/reveal
// macOS: execFile('open', stat.isDirectory() ? [target] : ['-R', target], cb)
execFile('explorer.exe', stat.isDirectory() ? [target] : ['/select,' + target], () => {
  // explorer.exe exits 1 even on success — never treat its exit code as failure
});
```

> Gotcha: `explorer.exe` returns exit code 1 on success. If you check `err`
> you will report a failure on every working call.

### 2. Native folder picker

macOS uses `osascript … choose folder`. Windows uses PowerShell.

```js
// server.js — inside POST /api/pick-folder
const ps = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose a folder for this task'
$d.ShowNewFolderButton = $false
if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 2 }`;

execFile('powershell.exe',
  ['-NoProfile', '-STA', '-Command', ps],
  { timeout: 180000 },
  (err, stdout) => {
    if (err) {
      if (err.code === 2) return json(res, 200, { cancelled: true });  // user pressed Cancel
      return json(res, 500, { error: 'could not open the folder picker' });
    }
    json(res, 200, { path: stdout.trim() });
  });
```

> `-STA` is required. WinForms dialogs will not open in the default MTA
> apartment and you get an opaque failure.
>
> The dialog may open **behind** the browser window. If that is a problem,
> add `$d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true}))`.

### 3. Path handling

The dashboard lets a task's `link` field hold a URL **or** a local path. The
detector must learn Windows path shapes:

```js
// public/app.js
// macOS: /^(~|\/)/
function isLocalPath(v = '') { return /^(~|\/|[A-Za-z]:[\\/]|\\\\)/.test(v.trim()); }
```

That covers `C:\Users\…`, `C:/Users/…`, UNC `\\server\share`, and the `~`
shorthand (keep `~` — the server expands it via `os.homedir()`, which works
on Windows and keeps stored paths short and readable).

Keep the "shorten to `~`" step in `/api/pick-folder` — it makes
`C:\Users\yourname\Videos` display as `~\Videos`.

### 4. Autostart at login

macOS uses a LaunchAgent plist. On Windows pick **one**:

**Simplest — Startup folder.** Press `Win+R`, run `shell:startup`, drop in a
shortcut to:

```
"C:\Program Files\nodejs\node.exe" "C:\path\to\attention-dashboard\server.js"
```

Set the shortcut's *Start in* to the project folder, and *Run* to `Minimized`.
A console window still flashes on login.

**No console window — Task Scheduler.** Create Task → trigger *At log on* →
action `node.exe` with argument `server.js` → *Start in* the project folder →
tick **Run whether user is logged on or not** is NOT needed; instead tick
*Hidden*. This also restarts cleanly.

> Do not use a Windows Service (NSSM etc). The folder picker needs a desktop
> session to show a dialog; a service has none.

---

## Setup

### Google Cloud Console (identical to macOS)

1. Create a project → enable **Google Calendar API**.
2. **OAuth consent screen**: External. Add each Google account as a **Test user**.
3. **Credentials → OAuth client ID → Web application**:
   - Authorized redirect URI: `http://localhost:3000/oauth/callback`
4. Put the **Client ID and Client secret** in `.env`.
5. Publish the app to **In production**. In *Testing* status Google expires
   refresh tokens after 7 days, meaning a re-login every week. Production keeps
   them alive; the app stays unverified, which only means a one-time
   "Google hasn't verified this app" screen.

### Gemini

Key from https://aistudio.google.com/apikey → `.env`.

Use model `gemini-flash-latest`, **not** `gemini-2.0-flash` — the latter has no
free-tier quota any more and returns 429 with `limit: 0`. The `-latest` alias
tracks whichever flash model is currently free.

### `.env`

```
GEMINI_API_KEY=...
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

### Timezone

The macOS build hardcodes `Asia/Makassar` and literal `+08:00` offsets in date
construction. Change **both**:

- `const TZ = 'Asia/Makassar'` in `public/app.js`
- every `'+08:00'` string literal (used to build day boundaries)

Indonesia has no DST so a fixed offset was safe. **If the target timezone
observes DST, the fixed offsets are wrong twice a year** — replace them with
`Intl.DateTimeFormat` based boundaries or accept the two broken days.

---

## Architecture

### Auth: server-side refresh tokens

Browser-side Google sign-in (GIS implicit flow) issues 1-hour access tokens
with **no refresh token**, so the user gets a login prompt almost every time
they open the app. Do not use it.

Instead the **server** runs the OAuth authorization-code flow with
`access_type=offline&prompt=consent select_account`, stores one refresh token
per account in `tokens.json` (mode 600), and mints access tokens on demand:

```
GET  /oauth/start        → 302 to Google consent
GET  /oauth/callback     → exchange code, store refresh token, 302 to /
GET  /api/accounts       → [{ email }]
DELETE /api/accounts?email=…
GET  /api/token?email=…&force=1 → { token, exp }
```

Account identity comes from the `id_token`'s `email` claim. The browser never
sees a refresh token, the client secret, or the Gemini key.

Scope: `openid email https://www.googleapis.com/auth/calendar`. The full
`calendar` scope (not `calendar.events`) is required to *list* which calendars
an account has.

### Calendars: discovered, never hardcoded

At sign-in, call `calendarList` per account and keep the calendars where
`selected !== false`. Never hardcode calendar IDs — an ID belonging to account
A is invisible to account B and returns 404 for every request.

Each event is tagged `_calId`, `_calName`, `_acct`. Every API call routes
through the token of the account that owns that calendar. This matters most for
RSVP: replying to an invite must use the invited account, or Google cannot find
"you" among the attendees.

**The Calendar API returns `{ items: [...] }`.** If you are porting from any
MCP-wrapper version, that wrapper returned `{ events: [...] }`. This is the
single easiest place to introduce a silent "no events, no error" bug.

Always pass `singleEvents=true` so recurring events expand into instances.

### Tasks: SQLite

```sql
CREATE TABLE IF NOT EXISTS todos (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- list order
  id          TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,        -- named `description`, not `desc` (reserved word)
  link        TEXT,        -- URL or local path
  deadline    TEXT,        -- YYYY-MM-DD
  calEventId  TEXT,
  calAcct     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`PRAGMA journal_mode = WAL`, and wrap multi-row writes in a transaction.

```
GET  /api/todos            → { todos: [...] }
PUT  /api/todos            → replace the whole list (body: array)
POST /api/todos            → append one task or an array
```

This is what lets an agent or script add tasks:

```
curl -X POST localhost:3000/api/todos -H "Content-Type: application/json" ^
  -d "{\"title\":\"Edit photos\",\"deadline\":\"2026-08-05\"}"
```

> `sqlite3.exe` is not installed on Windows by default. The HTTP API is the
> portable path; do not build workflows that assume the CLI exists.

### Briefing: cached per day

`POST /api/briefing { prompt }` → server calls Gemini → `{ text }`.

The client caches the result in `localStorage` stamped with the local date and
only calls the API on the first load of a new day, or when the user clicks the
regenerate button. Reloads and calendar toggles must **not** regenerate — that
was an explicit requirement. On failure show a static fallback line and cache
nothing, so the next load retries.

Keep the prompt verbatim; it is tuned to produce two sentences with no
"Good morning" preamble.

### Local-command endpoints are a security boundary

`/api/reveal` and `/api/pick-folder` run programs on the machine. Both must:

- reject any `Origin` header other than `http://localhost:3000`
- require `Content-Type: application/json` (forces a CORS preflight, which
  blocks other websites from calling them)
- require an absolute path that already exists (`fs.statSync`)
- pass arguments as an **argv array**, never through a shell

Never add permissive CORS headers to this server.

---

## Features

**Header** — logo, Today/Month nav, last-refreshed time, reload.

**Accounts card** — connected accounts, "Add account", and a checkbox per
calendar with its Google colour. Toggling hides a calendar everywhere at once
and skips fetching it. The toggle is keyed **per account + calendar**, so a
calendar shared with two accounts can be hidden under one — that is the usual
source of duplicate events.

**Hero** — greeting by time of day, full date, live clock, next-event
countdown (skips anything within 30 min), and a day-progress donut spanning
07:00–22:00.

**Day Briefing** — two AI sentences, cached per day, manual regenerate icon.

**Tasks** — add / edit / remove, deadline chips colour-coded (blue distant,
amber ≤3 days, rose overdue), optional description, and a link that is either
a URL ("Open link") or a local path ("Open folder" → reveals in the file
manager, with a Browse button that opens the native picker). Completing a task
removes it with a 10-second undo.

**Schedule** — a timeline for today / tomorrow / the day after, with a NOW
marker, per-calendar colour bars, free blocks of 45 min+ interleaved into
today, and a delete button on events **you created** (`creator.self === true`;
never on events you were merely invited to).

**Week Ahead** — days 3–6 with event titles and a five-segment busyness bar.

**Month modal** — Monday-first grid with a **Compact / Expanded** toggle.
Compact shows coloured dots; Expanded shows event titles in the cells like a
real calendar app. Choice persists. Fetched months are cached.

**RSVP card** — pending invitations with Accept/Decline. Hidden when empty.

**Undo toast** — shared component with a shrinking progress bar. The API call
fires only *after* the toast expires, so Undo means the request never happens.
No Undo button on plain error toasts.

---

## Gotchas that cost real time

**Optimistic UI is intentional.** RSVP and both delete paths update the screen
before the network call and roll back on failure. Do not "fix" this by awaiting.

**Token expiry.** Access tokens last ~1h and the dashboard stays open all day.
Wrap every Calendar call so a 401 fetches a fresh token from the server and
retries once.

**No auto-refresh.** Reload is manual, deliberately. Do not add a polling
interval; several calendars are fetched per reload.

**Trailing spaces in paths.** macOS allows them and Finder hides them, so a
blanket `.trim()` on a path silently breaks it. Windows forbids trailing
spaces in names, so this specific bug cannot occur — but still do not trim
paths, only URLs.

**`backdrop-filter` is expensive.** Blurring a dozen always-visible cards made
the renderer hold a compositing buffer per card and pushed memory into the
gigabytes. Use it only where content genuinely scrolls underneath: the header,
sticky bars, the dock, toasts and modals. Cards sitting on a flat gradient
should use a slightly more opaque fill instead — it looks the same.

**Do not seed or re-insert tasks from source.** An earlier version had a
`PATCH_TODOS` array that re-added hardcoded tasks on every load; a deleted task
kept coming back. Storage is the only source of truth.

---

## Out of scope

No build step, no framework, no user accounts, no server-side database beyond
SQLite, no service worker or PWA manifest, no dark mode, no cloud sync, no
exposing the server beyond localhost.
