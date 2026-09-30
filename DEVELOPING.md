# Developing

Vanilla HTML/CSS/JS and a zero-dependency Node server (`node:sqlite`, Node ≥ 22.13).
`public/` is read from disk on every request; only server-side changes need a restart.

## Releasing an update

Installs only move when there is a new version tag, so committing to `main` is safe:

```bash
npm version patch   # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

Every install picks it up within about 6 hours (`updater.js`). An install with local edits to
tracked files skips the update and says so in Settings. A development checkout should have
`"autoUpdate": false` in its `config.json`.

## Layout

| File | What it is |
|---|---|
| `server.js` | Static files, Google OAuth, tasks API, reminders |
| `platform.js` | Everything OS-specific: reveal, folder picker, notifications, restart |
| `moodle.js` | eLearn ICS feed → Google-Calendar-shaped events (`node test-moodle.js`) |
| `updater.js` | Follows release tags (`node updater.js` self-checks the version compare) |
| `install.sh`, `install.ps1`, `install-port.js` | Installers; the last checks Node and picks the port |
| `oauth-client.json` | Shared Google **Desktop app** client. Its secret is public on purpose: installed apps can't keep one, and a Desktop client accepts `http://localhost:<any port>` unregistered |

Per-install files, all gitignored: `config.json` (port, name, eLearn URL, `autoUpdate`),
`tasks.db*`, `tokens.json`, `reminders.json`, `courses.json`, `dashboard.log`. An optional `.env`
overrides `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MOODLE_ICS_URL` and `PORT`.

The server listens on 127.0.0.1 only and rejects requests whose Host isn't localhost: it mints
Google access tokens (`GET /api/token`), so it must not be reachable from the network or through
DNS rebinding.

## Tasks API

```bash
curl -X POST localhost:3100/api/todos -H 'Content-Type: application/json' \
  -d '{"title":"Edit photos","deadline":"2026-08-05","link":"https://drive.google.com/..."}'
curl -X POST localhost:3100/api/todos -H 'Content-Type: application/json' \
  -d '[{"title":"Buy cables"},{"title":"Send recap","deadline":"2026-08-07"}]'
curl localhost:3100/api/todos
```

`POST` appends one task or an array; `PUT` replaces the whole list. Fields: `title` (required),
`deadline` (`YYYY-MM-DD`), `desc`, `link` (a URL or a local path, which opens via
`POST /api/reveal`). The SQL column for `desc` is `description`, since `desc` is a keyword.

## Auth model

The server runs the OAuth code flow (with `state` and PKCE) and keeps one refresh token per
account in `tokens.json`. The browser only ever gets short-lived access tokens from
`GET /api/token?email=…`. A token that stops working leaves the account listed as
**Signed out** with a Reconnect button.

## Time zones

The app uses the machine's own zone. eLearn times are shown on eLearn's clock (`Asia/Jakarta`)
and labelled with the local offset. The first 10 characters of every stored or fetched
datetime are the local date; bucketing relies on that.
