# Plan: make the dashboard something other people can run

**Goal.** Someone else — on macOS or Windows — clones this, runs one installer, and gets their own
dashboard: their own tasks database, their own Google accounts, their own Moodle feed, their own
settings. Not a shared server with logins; one instance per person, per machine.

**Not in scope.** The Hammerspoon F3 panel (macOS-only, optional — see `QUICK-PANEL-SETUP.md`).
Multi-user on one server — see §9.

This is written to be picked up cold. Phases are ordered; each says what can be verified on this
machine and what cannot.

---

## 1. What blocks it today

| Thing | Where | Count |
|---|---|---|
| `Asia/Makassar` and literal `+08:00` offsets | app.js (20), moodle.js (4), server.js (2), add-task.html (3) | 29 spots |
| "Chris" in the greeting | app.js | 2 |
| `chris-dashboard-*` localStorage keys | app.js | 14 keys |
| Per-user files living in the repo | tasks.db, tokens.json, reminders.json, courses.json | 4 |
| Google OAuth client is a *Web application* type | .env + Cloud Console | see §2 |
| macOS-only shell calls | reveal, folder picker, notify | 3 |
| Hardcoded port 3000 | server.js, OAuth redirect URI | — |
| Log path `/tmp/attention-dashboard.log` | LaunchAgent | — |

Not blockers, worth knowing: **no npm dependencies and no build step**, so "install" is genuinely
"copy the folder, run node". Node 22+ required, for built-in `node:sqlite`.

---

## 2. Prerequisite: one Google client for everyone

Done once, by hand, in Google Cloud Console. Everything in §5 depends on it.

**Create an OAuth client of type "Desktop app"** in the existing project (keep the Web application
client until the switch is proven, then retire it).

Why the type matters:

- **A Desktop app client accepts any loopback port.** `http://127.0.0.1:<anything>` needs no
  pre-registration, so each install picks a free port and sign-in still works. The current Web
  application client requires every redirect URI to be registered in advance, which is the *only*
  real reason each person would otherwise need their own Cloud project.
- **Its client secret is not confidential.** Google documents installed-app secrets as shippable
  inside the app, since anyone can extract them anyway. So the id and secret can travel with the
  project, and friends never see the Console.

**Publishing status: In production.** It already is — the README notes the switch, made because
Testing mode expires refresh tokens after 7 days. Keep it there. Friends get one "Google hasn't
verified this app" screen (Advanced → Continue), once, and then a normal sign-in. Their tokens live
in *their* `tokens.json` on *their* machine; nothing routes through you.

Limits to be aware of:

- Unverified production apps have a user cap in the low hundreds. Fine for friends; not publishing.
- Removing the warning means Google's verification review: homepage, privacy policy, a domain you
  own, demo video. Not worth it at this scale.
- Quotas are per project and shared by everyone using your client. Calendar's default ceiling is
  far above a handful of dashboards.

**Unverified from here:** the project's current client type and publishing status — check the
Console. Google's console wording and caps change; read the current page rather than this file.

Server-side change once the client exists: the redirect URI is built from the configured port
(§4) and uses `127.0.0.1`, not `localhost`, since that is what loopback clients expect.

---

## 3. Phase 1 — platform layer, and kill the fork

`windows-port/reference/` is a **stale copy** of the app: its `app.js` is 1,160 lines against
today's ~2,400. Two copies will diverge again within a week of anyone touching either. One
codebase, branching at runtime.

**Delete** `windows-port/reference/`. **Keep** `windows-port/plan.md` — its Windows snippets are
good and its gotchas were hard-won.

New `platform.js`, chosen once from `process.platform`, exporting four functions. `server.js` stops
calling `execFile` directly.

| Function | macOS | Windows |
|---|---|---|
| `reveal(path)` | `open` / `open -R` | `explorer.exe /select,` |
| `pickFolder()` | `osascript … choose folder` | PowerShell `FolderBrowserDialog` |
| `notify(title, body)` | `osascript display notification` | unresolved — see §6 |
| `autostart()` | LaunchAgent plist | Task Scheduler, at logon, hidden |

Traps already documented in `windows-port/plan.md` — do not rediscover them:

- `explorer.exe` **exits 1 on success**. Treating its exit code as failure reports an error on
  every working call.
- The PowerShell dialog needs `-STA`; in the default apartment it fails opaquely.
- The dialog can open *behind* the browser window; a `TopMost` owner form fixes it.
- Not a Windows Service (NSSM etc). The folder picker needs a desktop session; a service has none.

Also in this phase:

- `isLocalPath` must learn Windows shapes: `/^(~|\/|[A-Za-z]:[\\/]|\\\\)/`. It exists in **both**
  `public/app.js` and `public/add-task.html`.
- Keep the `~` shorthand. `os.homedir()` works on Windows and keeps stored paths short.
- Log path from `os.tmpdir()`, not `/tmp`.
- No literal `/` in paths the server builds; `path.join` throughout.
- New `GET /api/platform` → `{ os, canReveal, canPickFolder, canNotify }`. The client hides the
  Browse button and folder links where they would not work, instead of failing on click.

**Verifiable here:** that macOS behaviour is unchanged. **Not verifiable here:** every Windows
branch.

---

## 4. Phase 2 — config, data directory, timezone

**`config.json`** (gitignored, written by setup): `name`, `timezone`, `port`.

**`data/`** holds tasks.db, tokens.json, reminders.json, courses.json. Overridable with `DATA_DIR`.
Two wins: `git pull` never touches anyone's data, and a second instance is just a second data dir.
One-time migration on this machine: move the four files on first boot of the new version.

**Timezone** is the bulk of the work and the part that needs care. Those 29 spots are not just
display: date bucketing, free-block maths, the Moodle conversion and the `startsWith(ymd)` filters
all lean on the literal offset. Replace with the configured zone via `Intl`, keeping the existing
rule that the first 10 characters of a stored datetime are the *local* date.

Deliberate exception to preserve: Moodle times are shifted to eLearn's own clock (GMT+7) on
purpose, so a deadline reads as it does on eLearn's page. That is a per-feed setting, not the app
zone — name it something like `feedTimezone`, defaulting to the app zone for anyone without a
campus feed.

**localStorage keys** namespaced per instance, so two dashboards in one browser don't share
settings. **Greeting** from `config.name`.

**Verifiable here:** all of it. Test by running with a different timezone in config and checking
the timeline, free blocks, month grid and deadline dates.

---

## 5. Phase 3 — first-run setup

With §2 done, this is small. A `/setup` page when `config.json` is missing:

- Name, timezone (default from `Intl.DateTimeFormat().resolvedOptions().timeZone`), port.
- Moodle export URL, optional, with the same explanation the README has.
- Google: a **Connect** button. No client id, no secret, no Console — the shipped Desktop client
  handles it, and the redirect URI is derived from the chosen port.

It writes `config.json`, then hands over to the normal dashboard.

`courses.json` starts empty and fills in as they rename courses in the UI.

**Verifiable here** apart from one thing: proving the consent flow works for *another* Google
account needs a second account.

---

## 6. Phase 4 — notifications on Windows

Listed separately because it needs a decision and a Windows machine.

macOS reminders are sent by the server through `osascript`, which is why they arrive with the
dashboard closed. Windows has no zero-dependency equivalent worth shipping untested:

- **WinRT toasts through PowerShell** — correct, but means hand-rolling toast XML and registering
  an app id.
- **BurntToast** — a PowerShell module, i.e. the first dependency this project would carry.
- **NotifyIcon balloon tips** — deprecated, vanish without reaching the Action Center.

Worth knowing: **on Windows the browser route works**. Chrome and Edge installed-as-app on
localhost can get Notification permission — the thing Safari refuses, which is why the server-side
sender exists at all. So:

- macOS: server-sent, works with the app closed. Unchanged.
- Windows, app open: the browser Notification API. The page already had this code before it was
  replaced; recover it from git history rather than rewriting.
- Windows, app closed: one of the three options above. Decide with the friend — it may not matter.

---

## 7. Phase 5 — installing

- `install.sh` (macOS): check Node ≥ 22, pick a free port, write the LaunchAgent from a template,
  start it, open `/setup`.
- `install.ps1` (Windows): same, with a hidden Task Scheduler at-logon task.
- App window: Safari **Add to Dock** on macOS; Edge/Chrome **Install this site as an app** on
  Windows. Same page either way.
- README rewritten for someone who is not you. `LOCAL-APP-SETUP.md` already covers the macOS
  service and window setup and can be folded in.

Port note: something else may already own 3000 — Adobe's CEP helper does on this machine. The
installer picks a free port and writes it to config. With the Desktop OAuth client from §2, no
redirect URI has to be registered for it.

---

## 8. Order, and who verifies what

| # | Phase | Verified how |
|---|---|---|
| 0 | Desktop OAuth client, production status (§2) | In the Console, by you |
| 1 | Platform layer + delete the fork | macOS here; Windows branches unverified |
| 2 | Config + data dir + timezone | Fully here |
| 3 | Setup page | Here, except a second Google account |
| 4 | Installers | macOS here; `install.ps1` unverified |
| 5 | Windows notifications | Needs the Windows machine |

Everything Windows-specific can be written from `windows-port/plan.md` but **not run** here. The
friend confirms the picker, `explorer.exe` and Task Scheduler on the real machine.

---

## 9. Explicitly out of scope

"One server, several people logging in" is a different project: accounts and sessions, every query
scoped to a user id, OAuth tokens per user, HTTPS, and the reveal/folder-picker endpoints deleted
outright — they run commands on the *host* machine, which stops being acceptable the moment the
host is not the only user. Avoid unless a shared instance is genuinely what is wanted.
