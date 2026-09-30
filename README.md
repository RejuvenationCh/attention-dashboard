# Attention Dashboard

A personal calendar/todo dashboard, self-hosted on localhost. Vanilla HTML/CSS/JS,
zero npm dependencies (Node ≥ 22.13).

## Install (for anyone)

Needs [Node.js](https://nodejs.org) 22.13+ and git.

**macOS** (Terminal). `brew install node` if you have Homebrew; git comes with the Command Line
Tools, which macOS offers to install the first time you run `git`.

```bash
git clone https://github.com/RejuvenationCh/attention-dashboard.git
cd attention-dashboard
./install.sh
```

**Windows 10/11** (PowerShell). Install the tools, then open a *new* PowerShell window so it
finds them:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

```powershell
git clone https://github.com/RejuvenationCh/attention-dashboard.git
cd attention-dashboard
powershell -ExecutionPolicy Bypass -File install.ps1
```

The Windows side has not been run on a real Windows machine yet; if something fails, the
output and `dashboard.log` in that folder say why.

The installer picks a free port, starts the dashboard at every login and opens it. Only this
computer can reach it; nothing is exposed to the network. For its own window: Safari → File →
Add to Dock (macOS), or Edge → ⋯ → Apps → Install this site as an app (Windows). Then: **Connect Google Calendar**, and put your name and eLearn calendar URL in
**Settings**. Google shows "Google hasn't verified this app" once: Advanced → Continue.

Your tasks, sign-ins and settings stay on your computer (all gitignored). The dashboard updates
itself: every few hours it checks for a newer release and restarts into it. Settings shows the
version. To turn that off, add `"autoUpdate": false` to `config.json`.

To remove it (macOS): `launchctl bootout gui/$UID/com.attention-dashboard`, delete
`~/Library/LaunchAgents/com.attention-dashboard.plist`, then the folder. On Windows, delete the
"Attention Dashboard" task in Task Scheduler, then the folder.

## Releasing an update

Commit to `main` as usual; installs only move when there is a new version tag:

```bash
npm version patch   # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

Every install picks it up within about 6 hours. One with local edits to tracked files skips the
update and says so in Settings.

## Reference

Everything below is detail for whoever works on the code. The examples use port 3000; an
installed copy uses the port in `config.json`.

### Files that stay on your computer

All gitignored: `config.json` (port, name, eLearn URL, `autoUpdate`), `tasks.db*` (tasks),
`tokens.json` (Google sign-ins), `reminders.json`, `courses.json` (course names), `dashboard.log`.
`.env` is optional and overrides `config.json` and `oauth-client.json` (see `.env.example`).

### Google client

`oauth-client.json` is a shared **Desktop app** OAuth client, committed on purpose: Google treats
an installed app's secret as non-confidential, and a Desktop client accepts
`http://localhost:<any port>` without registering it. Its consent screen is **In production**, so
refresh tokens don't expire after 7 days; being unverified only means the one-time warning
screen. To use your own client instead, create a Desktop client with the Calendar API enabled
and set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`. Sign-ins made with one client
don't carry over to another, so reconnect the accounts after switching.

### eLearn (Moodle) calendar

In Moodle: **Calendar → Export calendar** → pick the events and time range →
**Get URL for subscription**. Paste that whole URL into **Settings → eLearn calendar**
(or `.env` as `MOODLE_ICS_URL=…`). It already carries your `userid` and `authtoken`, so treat
it as a password: it is stored in the gitignored `config.json`, and the server never sends it
to the browser, only the parsed events. Clear the field to switch the feed off.

**Set the export's time range to a wide custom span, not the default.** Moodle's
"recent and upcoming" preset covers roughly 60 days either side of today and
silently drops everything further out — a whole course's worth of deadlines can
sit past that line and never appear. The URL should use
`preset_time=custom&timefrom=…&timeto=…` (currently 2025-01-01 → 2030-01-01).
The card filters to the next year on its own, so the export range only has to be
a superset of it; widening it costs nothing, since Moodle only emits events for
activities that have a date.

Each course becomes its own toggleable calendar, coloured from a fixed palette and
named via `courses.json` (below); anything uncategorised lands in an "eLearn UC"
bucket. It appears as its own account in the Accounts card, with no disconnect
button (it is set in Settings, not by signing in).

**Only courses with at least one dated activity appear.** Moodle creates a calendar
event for an assignment or quiz only when that activity carries a date, so a course
whose work is handed in during class — or whose due dates were never set — publishes
nothing at all and cannot be shown, whatever the export URL says. The exporter's
`preset_what` makes no difference: `all`, `courses`, and an explicit `courses[]=<id>`
all return the same events, while `categories` and `groups` return none. If a course
you expect is missing, check in Moodle that its activities actually have due dates —
and either way, list it in `courses.json` so it still shows up (below).

### Course names and the course roster

The feed carries only the course **shortname** (`20261_IMT01303305-A`). Moodle's ICS
has no fullname field, and every page that would show one sits behind the campus
login, so the readable name cannot be fetched. Put it in **`courses.json`** at the
project root:

```json
{ "20261_IMT01303305-A": "Name as it appears in Moodle",
  "IMT01303306-A":       "…or with the term prefix left off" }
```

Keys may be the full shortname or the term-stripped code — the `<term>_` prefix
changes every semester, so the stripped form is the one that lasts. Unmapped courses
fall back to showing the shortname. The file is re-read on every feed refresh (at most
every 10 minutes), so editing it needs no restart, unlike `.env`. The shortname stays
the calendar's internal id either way, so adding a name never disturbs the per-course
toggles or colours.

The same file doubles as your **course roster**, which is the only way to see a course
the feed cannot tell you about. Because a course's existence reaches the dashboard
only through its own events, a course with no dated activity is invisible — so list it
here with its name as both key and value:

```json
{ "Statistics A": "Statistics A" }
```

It then appears as a toggle in the Accounts card with nothing due, ready for the day
it does publish. Keys beginning with `_` are ignored, so `_readme` is safe. Roster
courses carry no events, so **Course Deadlines is unaffected** — that card stays
purely "what's due", and a course shows up there only when it actually has something.
When a listed course starts publishing, move its name onto the shortname the feed
reports, or you will see it twice.

Read-only and one-way: nothing is ever written back to campus, and the
dashboard's RSVP/delete actions never apply to these events.

Coursework also appears in the **Course Deadlines** card in the left column, below
Tasks: the next year of assignments and exams from the course calendars, soonest
first, each row tagged with its course and time remaining. It is deliberately
campus-only — folding every Google calendar in made it a second copy of the
timetable (418 of 509 rows were recurring class meetings already drawn on the
schedule and week cards). It honours the same per-course toggles as the Accounts
card, and shows nothing when no campus feed is configured.

The list scrolls inside the card once the term fills up. Hovering a row reveals two
actions: **pin** (★) keeps a deadline at the top of the list, and **add to Google
Calendar** copies it to the first connected account's own calendar as
`📌 Deadline: <name>`, 9am on the due date with a 24-hour reminder. Pins are a
display preference and live in `localStorage`
(`chris-dashboard-pinned-deadlines-v1`), beside the hidden-calendar set.

Adding to the calendar is the only thing this card writes, and it writes to Google,
never to campus. The toast's Undo deletes the event it just created.

The browser cannot fetch the feed itself — Moodle sends no CORS headers and the
`authtoken` must stay on this machine — so the server proxies it at
`GET /api/moodle/events?start=YYYY-MM-DD&end=YYYY-MM-DD` (dates inclusive, local).
It refetches upstream at most every 10 minutes and serves the last good copy if
campus is down; a failure returns 502 with the reason and leaves the rest of the
dashboard working.

**Time zones:** the dashboard uses the computer's own time zone. eLearn deadlines are
shown on eLearn's own clock (`Asia/Jakarta`, UTC+7), so "due 23:59" reads 23:59 as it does
on eLearn's page; east of Jakarta that is slightly early, the safe direction to be wrong in.

## Tasks API

Tasks live in **`tasks.db`** (SQLite, via Node's built-in `node:sqlite` — no
dependency). The browser reads/writes them over HTTP, so anything else on this Mac
can add tasks too.

```bash
# Add one task
curl -X POST localhost:3000/api/todos -H 'Content-Type: application/json' \
  -d '{"title":"Edit TE photos","deadline":"2026-08-05","link":"https://drive.google.com/..."}'

# Add several at once
curl -X POST localhost:3000/api/todos -H 'Content-Type: application/json' \
  -d '[{"title":"Buy cables"},{"title":"Send recap","deadline":"2026-08-07"}]'

curl localhost:3000/api/todos                     # read all
curl -X PUT localhost:3000/api/todos -d '[]' -H 'Content-Type: application/json'   # replace all
```

Fields: `title` (required), `deadline` (`YYYY-MM-DD`), `desc`, `link`. Ids are
generated server-side. Hit Reload in the dashboard to see externally added tasks.

`link` takes either a URL or a **local path** (`/Users/...` or `~/Movies/...`).
Paths render as an "Open folder" button that reveals the item in Finder via
`POST /api/reveal` — browsers block `file://` links from an `http://` page, hence
the server hop. That endpoint only accepts same-origin JSON requests and paths that
already exist, and never passes anything through a shell.

The database is also readable directly, which is handy for scripts and agents:

```bash
sqlite3 tasks.db "select title, deadline from todos order by seq;"
sqlite3 tasks.db "insert into todos (id, title, deadline) values (hex(randomblob(6)), 'Call the vendor', '2026-08-09');"
```

Column note: the SQL column is `description` (JSON field `desc`), because `desc` is
a SQL keyword. Writes through the API are transactional.

### Adding a task from anywhere (F3, macOS + Hammerspoon, optional)

`public/add-task.html` is bound to **F3** in Hammerspoon, and it is the dashboard's own
**New Task modal** — the same markup and the same `style.css`, served by this server, so
there is nothing to keep in step with the dashboard: it *is* the dashboard's form. Title,
description, link or folder (with Browse), deadline, and the Google Calendar reminder all
behave as they do on the page, and it posts to the same `POST /api/todos`.

It appends where the dashboard's modal replaces: this page `POST`s the one task, the
dashboard `PUT`s its whole list back. Append cannot drop a task if the server's copy has
moved on, which is worth the small divergence for a panel whose whole job is capturing a
thought mid-something-else.

The Hammerspoon window is exactly the modal and nothing else — 520 wide, 491 tall, no
title bar, sitting flush with the bottom of the screen the pointer is on, as the modal
does on the dashboard. It is opened over whatever you are doing and is deliberately not
resizable; re-measure the page and update `openTaskPrompt()` if the form gains a field.

F3 is a toggle: it opens the panel, and pressing it again takes the panel down, as do
Cancel, the X, Escape, and a click on the dimmed area around the card. There is no
window close button — a title bar is the one piece of chrome the modal does not have.
It fires in **both** keyboard modes, which is a deliberate reversal. It used to be bound
only in media mode, on the reasoning that in function-key mode F3 is a function key and
has to reach the app — it is the debug key in Minecraft and a find key in plenty of
editors. But `fnModeActive` is set true at the top of `init.lua`, so every reload quietly
put F3 back behind a gate that had to be reopened by hand with ⌃⌥Z; the gate cost more
than it protected against. To put it back, make the F3 branch in `buildFkeyTap()` read
`keyCode == F3 and not fnModeActive`.

## Auth model

The server performs the OAuth code flow and stores one **refresh token** per account
in `tokens.json` (gitignored, mode 600). The browser never sees a refresh token and
never prompts for sign-in after the first consent: it asks `GET /api/token?email=…`
and the server mints a fresh access token as needed. The OAuth client secret never
reaches the browser.

The Moodle feed sits outside this model: it has no OAuth and no token store, just
the credential embedded in the export URL, kept by the server and never sent to the browser.

When a refresh token stops working, the account stays listed in the Accounts card
marked **Signed out**, with a Reconnect button, instead of silently disappearing —
which is what a revoked token used to look like. Reconnecting runs the normal
consent flow.
