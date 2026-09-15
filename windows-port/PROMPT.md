# The prompt

Put `plan.md`, `DESIGN.md` and `reference/` in an empty folder on the Windows
machine, open Claude Code there, and paste everything between the lines.

Fill in the two `<…>` placeholders first.

---

Build me a personal calendar and task dashboard that runs on localhost.

`plan.md` is the spec and `DESIGN.md` is the visual spec — read both fully
before writing anything. `reference/` holds the working macOS build of this
same app: treat it as the source of truth for layout, styling and behaviour.
Port it rather than reimplementing it. Only four things are genuinely
platform-specific, and `plan.md` lists them with the Windows code.

My setup: Windows, Node `<paste the output of: node -v>`, timezone `<e.g.
Asia/Jakarta, UTC+7>`.

Constraints, all from the plan: vanilla HTML/CSS/JS, no framework, no build
step, and zero npm dependencies — `node:http` and `node:sqlite` are built in.
Nothing from the "Out of scope" section.

Work in these stages and stop after each so I can check it:

1. `server.js`, `package.json`, `.env.example`, `.gitignore`, plus the tasks
   API (`GET`/`PUT`/`POST /api/todos`) on SQLite. Verify with curl.
2. Frontend shell: layout, tokens, cards, tasks working against that API.
   Calendar areas can sit in their empty states.
3. OAuth: `/oauth/start`, `/oauth/callback`, `/api/accounts`, `/api/token`.
   **Stop here and walk me through the Google Cloud Console setup** — I'll
   create the OAuth client and the Gemini key myself and paste them into `.env`.
4. Calendar UI: schedule timeline, week ahead, month modal with the
   compact/expanded toggle, RSVP card, countdown, per-calendar visibility
   toggles.
5. Briefing proxy plus the once-per-day cache.
6. Windows-specific: `/api/reveal`, `/api/pick-folder`, autostart at login.

Hold to these — each one cost real time on the macOS build:

- Use my timezone, not `Asia/Makassar`, and change both `TZ` and the hardcoded
  `+08:00` date-boundary offsets. If my timezone observes DST, say so before
  you write it — the fixed-offset approach silently breaks twice a year.
- The Google Calendar API returns `{ items }`, not `{ events }`.
- Never hardcode calendar IDs. Discover them per account via `calendarList`,
  and route every request through the token of the account that owns that
  calendar.
- `/api/reveal` and `/api/pick-folder` execute programs on my machine. Apply
  every guard in the plan — same-origin check, JSON content type, path must
  already exist, arguments as an argv array and never a shell string — and
  show me each guard actually rejecting a bad request.
- `explorer.exe` exits with code 1 even on success; don't treat that as failure.
- The PowerShell folder dialog needs `-STA` or it won't open.
- No auto-refresh, and don't regenerate the briefing on reload or on a
  calendar toggle. Once a day, or when I click regenerate.
- Storage is the only source of truth for tasks. Never seed or re-insert tasks
  from source code.

Verify your own work as you go — curl the endpoints, open the page, read the
console. Show me real output rather than asking me to check. At the end of each
stage tell me what you verified and what you deliberately skipped.

---

If you don't have the `reference/` folder, delete the sentence about it — the
plan alone is enough to build from, it just becomes a build rather than a port.
