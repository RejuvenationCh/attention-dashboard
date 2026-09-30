// Static file server + Google OAuth (refresh-token)
// + the Moodle (eLearn UC) calendar feed.
// Zero dependencies (Node >= 22.13).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');   // built in since Node 22, no dependency
const moodle = require('./moodle');                // reads/proxies the campus calendar feed
const platform = require('./platform');            // the only OS-specific code
const updater = require('./updater');              // follows new release tags

try { process.loadEnvFile(); } catch { /* no .env yet */ }

// Per-install settings, written by the installer and the settings panel. Gitignored.
// .env still works and wins for the Google client, so an existing setup keeps running.
const CONFIG_FILE = path.join(__dirname, 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 }); }
const config = loadConfig();
if (config.moodleUrl && !process.env.MOODLE_ICS_URL) process.env.MOODLE_ICS_URL = config.moodleUrl;

// The shared Google client. A Desktop-app client's secret is not confidential (Google
// documents installed apps shipping it), so it can be committed in oauth-client.json.
try {
  // Accepts the file exactly as Google's console downloads it ({ installed: {...} }).
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'oauth-client.json'), 'utf8'));
  const c = f.installed || f;
  process.env.GOOGLE_CLIENT_ID ||= c.client_id;
  process.env.GOOGLE_CLIENT_SECRET ||= c.client_secret;
} catch { /* not shipped yet: .env must carry them */ }

const PORT = Number(process.env.PORT) || config.port || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const TASKS_FILE = path.join(__dirname, 'tasks.json');   // legacy, migrated into SQLite on boot
const DB_FILE = path.join(__dirname, 'tasks.db');
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const SCOPES = 'openid email https://www.googleapis.com/auth/calendar';
// localhost and 127.0.0.1 are the same server; either may be in the address bar.
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const badOrigin = req => req.headers.origin && !ORIGINS.has(req.headers.origin);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// ─── Task store (SQLite) ──────────────────────────────────────────
// `seq` preserves list order; `id` is the stable key the frontend uses.
// Column is `description` because `desc` is a SQL keyword.
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS todos (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT UNIQUE NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    link        TEXT,
    deadline    TEXT,
    calEventId  TEXT,
    calAcct     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Columns added after the table first shipped. CREATE TABLE IF NOT EXISTS does nothing to a
// database that already exists, so each is added only when it is missing — running the ALTER
// unconditionally would throw "duplicate column name" on every boot after the first.
const ADDED_COLUMNS = {
  done_at:      'TEXT',     // when it was completed; null while the task is still open
  priority:     'INTEGER',  // 1 = flagged; null rather than 0 so the column stays empty
  snooze_until: 'TEXT',     // YYYY-MM-DD — hidden from the list until this date
  course_event: 'TEXT',     // Moodle event id this task was made for (Course Deadlines card)
  cal_id:       'TEXT',     // which calendar calEventId lives on; null means the account's primary
  repeat:       'TEXT',     // 'weekly' | 'monthly' — ticking it off moves the deadline on instead
};
{
  const have = new Set(db.prepare('PRAGMA table_info(todos)').all().map(c => c.name));
  for (const [col, type] of Object.entries(ADDED_COLUMNS)) {
    if (!have.has(col)) db.exec(`ALTER TABLE todos ADD COLUMN ${col} ${type}`);
  }
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const rowToTodo = r => ({
  id: r.id, title: r.title, desc: r.description, link: r.link,
  deadline: r.deadline, calEventId: r.calEventId, calAcct: r.calAcct,
  doneAt: r.done_at, priority: !!r.priority, snoozeUntil: r.snooze_until,
  courseEventId: r.course_event, calId: r.cal_id, repeat: r.repeat,
});

function listTodos() {
  return db.prepare('SELECT * FROM todos ORDER BY seq').all().map(rowToTodo);
}

const insertTodo = db.prepare(
  `INSERT INTO todos (id, title, description, link, deadline, calEventId, calAcct,
                      done_at, priority, snooze_until, course_event, cal_id, repeat)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function normalise(t) {
  const title = String(t.title ?? '').trim();
  if (!title) return null;
  return [t.id || newId(), title, t.desc ?? null, t.link ?? null,
          t.deadline ?? null, t.calEventId ?? null, t.calAcct ?? null,
          t.doneAt ?? null, t.priority ? 1 : null, t.snoozeUntil ?? null,
          t.courseEventId ?? null, t.calId ?? null, t.repeat ?? null];
}

// Replace the whole list, atomically.
function replaceTodos(todos) {
  const rows = todos.map(normalise).filter(Boolean);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM todos');
    for (const row of rows) insertTodo.run(...row);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return rows.length;
}

function appendTodos(todos) {
  const rows = todos.map(normalise).filter(Boolean);
  if (!rows.length) throw new Error('every task needs a title');
  db.exec('BEGIN');
  try {
    for (const row of rows) insertTodo.run(...row);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return rows.length;
}

// One-time migration from the old tasks.json.
if (fs.existsSync(TASKS_FILE)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    if (Array.isArray(legacy) && legacy.length && db.prepare('SELECT COUNT(*) n FROM todos').get().n === 0) {
      replaceTodos(legacy);
      console.log(`migrated ${legacy.length} task(s) from tasks.json into SQLite`);
    }
    fs.renameSync(TASKS_FILE, TASKS_FILE + '.bak');
  } catch (err) { console.error('[migrate]', err.message); }
}

// ─── Due reminders ────────────────────────────────────────────────
// Checked here rather than in the page so they arrive with the dashboard closed. Every 20
// minutes is one SQLite read and nothing else unless something is due — negligible.
// Delivered by the OS (platform.js), not the browser: a Safari web app on localhost cannot get
// notification permission. Dates are in the machine's own zone, as in public/app.js.
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');
const REMIND_EVERY = 20 * 60 * 1000;

const REMINDER_DEFAULTS = { on: false, aheadDays: 0, reminded: {}, days: [], dayHour: 7, daysSentOn: null,
                            doneDeadlines: [] };   // course deadline ids marked submitted by hand
function loadReminders() {
  try { return { ...REMINDER_DEFAULTS, ...JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')) }; }
  catch { return { ...REMINDER_DEFAULTS }; }
}
function saveReminders(r) { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(r, null, 2)); }

const ymdIn = (d = new Date()) => d.toLocaleDateString('en-CA');
const hourIn = () => new Date().getHours();
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const plusDays = (ymd, n) => new Date(Date.parse(ymd) + n * 86400000).toISOString().slice(0, 10);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dueWord = d => d < 0 ? 'Overdue' : d === 0 ? 'Due today' : `Due in ${d} day${d > 1 ? 's' : ''}`;

// Day reminders ("every Wednesday: wear batik") land once, in the morning: the page only ever
// showed them while it was open, which is too late to be useful.
async function checkDayReminders(r, today) {
  if (r.daysSentOn === today || hourIn() < r.dayHour) return;
  const weekday = new Date(today + 'T12:00:00').getDay();
  const mine = r.days.filter(x => x.day === today || x.day === String(weekday));
  r.daysSentOn = today;
  saveReminders(r);
  if (!mine.length) return;
  await platform.notify(`${WEEKDAYS[weekday]} reminder${mine.length > 1 ? 's' : ''}`, mine.map(x => x.text).join('\n'))
    .catch(err => console.error('[remind]', err.message));
}

// Course deadlines nag on their own: one that was never turned into a task used to be silent.
async function dueCourseDeadlines(r, today) {
  if (!moodle.configured()) return [];
  const linked = new Set(listTodos().filter(t => t.courseEventId && !t.doneAt).map(t => t.courseEventId));
  for (const id of r.doneDeadlines) linked.add(id);   // submitted — nothing left to remind about
  const items = await moodle.eventsFor(today, plusDays(today, Math.max(r.aheadDays, 0)));
  return items
    .filter(e => !linked.has(e.id))   // a linked task already speaks for it
    .map(e => ({ id: e.id, title: (e.summary || 'Course deadline').replace(/ is due$/, ''),
                 deadline: (e.start?.dateTime || e.start?.date || '').slice(0, 10) }))
    .filter(e => e.deadline && daysBetween(today, e.deadline) <= r.aheadDays);
}

// At most one notification per task per day; a task still overdue tomorrow nudges again.
async function checkDueReminders() {
  const r = loadReminders();
  if (!r.on) return;
  const today = ymdIn();
  await checkDayReminders(r, today);

  const due = listTodos().filter(t => !t.doneAt && t.deadline
    && !(t.snoozeUntil && t.snoozeUntil > today)
    && daysBetween(today, t.deadline) <= r.aheadDays)
    .map(t => ({ id: t.id, title: t.title, deadline: t.deadline }));
  let deadlines = [];
  try { deadlines = await dueCourseDeadlines(r, today); }
  catch (err) { console.error('[remind]', err.message); }   // campus outage must not mute tasks
  const all = [...due, ...deadlines];
  const fresh = all.filter(t => r.reminded[t.id] !== today);
  if (!fresh.length) return;

  r.reminded = Object.fromEntries(all.map(t => [t.id, today]));   // rebuilt daily, cannot grow forever
  saveReminders(r);
  const lines = fresh.map(t => `${dueWord(daysBetween(today, t.deadline))}: ${t.title}`);
  platform.notify(fresh.length === 1 ? 'Something needs you' : `${fresh.length} things need you`, lines.slice(0, 5).join('\n'))
    .catch(err => console.error('[remind]', err.message));
}
setInterval(checkDueReminders, REMIND_EVERY).unref();
setTimeout(checkDueReminders, 30000).unref();   // once shortly after boot / wake-up restart

// ─── Token store ──────────────────────────────────────────────────
// tokens.json holds one long-lived refresh token per account. It never leaves
// this machine and is gitignored; access tokens are derived from it on demand.
function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { return {}; }
}
function saveTokens(t) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

const accessCache = new Map();   // email -> { token, exp }

async function accessTokenFor(email, force = false) {
  const cached = accessCache.get(email);
  if (!force && cached && cached.exp > Date.now() + 60000) return cached;

  const refresh = loadTokens()[email]?.refresh_token;
  if (!refresh) throw new Error('account not connected');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(d.error_description || d.error || 'refresh failed');

  const entry = { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  accessCache.set(email, entry);
  return entry;
}

function emailFromIdToken(idToken = '') {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()).email || null;
  } catch { return null; }
}

// ─── Handlers ─────────────────────────────────────────────────────
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Start consent. select_account lets a second account be added;
// consent + offline access is what makes Google issue a refresh token.
// `state` stops another site from feeding us its own code; PKCE binds the code to this server.
const pending = new Map();   // state → { verifier, at }
const b64url = buf => buf.toString('base64url');
function oauthStart(res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    return res.end('<h2>Missing credentials</h2><p>Put the Google client in oauth-client.json (or GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env), then restart the server.</p>');
  }
  for (const [k, v] of pending) if (Date.now() - v.at > 600000) pending.delete(k);
  const state = b64url(crypto.randomBytes(16)), verifier = b64url(crypto.randomBytes(32));
  pending.set(state, { verifier, at: Date.now() });
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  res.writeHead(302, { Location: url });
  res.end();
}

async function oauthCallback(res, query) {
  const fail = msg => {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>Sign-in failed</h2><p>${msg}</p><p><a href="/">Back to dashboard</a></p>`);
  };
  if (query.get('error')) return fail(query.get('error'));
  const started = pending.get(query.get('state'));
  pending.delete(query.get('state'));
  if (!started) return fail('This sign-in was not started here, or took longer than 10 minutes. Try again.');
  const code = query.get('code');
  if (!code) return fail('No authorization code returned.');

  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: started.verifier,
      }),
    });
    const d = await r.json();
    if (!d.access_token) return fail(d.error_description || d.error || 'token exchange failed');

    const email = emailFromIdToken(d.id_token);
    if (!email) return fail('Could not determine the account email.');

    const tokens = loadTokens();
    // Google omits refresh_token on repeat consent; keep the one already stored.
    const refresh_token = d.refresh_token || tokens[email]?.refresh_token;
    if (!refresh_token) return fail('Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and try again.');
    tokens[email] = { refresh_token };
    saveTokens(tokens);
    accessCache.set(email, { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 });

    res.writeHead(302, { Location: '/' });
    res.end();
  } catch (err) {
    fail(err.message);
  }
}

// ─── Router ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/oauth/start') return oauthStart(res);
  if (p === '/oauth/callback') return oauthCallback(res, url.searchParams);

  if (p === '/api/accounts' && req.method === 'GET') {
    const list = Object.keys(loadTokens()).map(email => ({ email, source: 'google' }));
    // The Moodle feed is configured in .env rather than by signing in, so it
    // rides along with the account list the client already fetches at boot.
    if (moodle.configured()) {
      let calendars = [];
      // A campus outage must not take the whole account list down with it —
      // Google accounts would vanish from the dashboard too.
      try { ({ calendars } = await moodle.feed()); }
      catch (err) { console.error('[moodle]', err.message); }
      list.push({ email: moodle.ACCT, source: 'moodle', name: moodle.SITE_NAME, calendars });
    }
    return json(res, 200, list);
  }
  if (p === '/api/accounts' && req.method === 'DELETE') {
    const email = url.searchParams.get('email');
    if (email === moodle.ACCT) return json(res, 400, { error: 'the Moodle feed is set in Settings' });
    const tokens = loadTokens();
    delete tokens[email];
    saveTokens(tokens);
    accessCache.delete(email);
    return json(res, 200, { ok: true });
  }

  // Campus calendar, proxied: the browser cannot fetch the feed itself (Moodle
  // sends no CORS headers) and the authtoken in the URL must stay on this machine.
  if (p === '/api/moodle/events' && req.method === 'GET') {
    const start = url.searchParams.get('start') || '';
    const end   = url.searchParams.get('end') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return json(res, 400, { error: 'start and end must be YYYY-MM-DD' });
    }
    try {
      return json(res, 200, { items: await moodle.eventsFor(start, end) });
    } catch (err) {
      console.error('[moodle]', err.message);
      return json(res, 502, { error: err.message });
    }
  }
  // Due reminders: on/off and how many days ahead. The checking runs here, not in the page.
  if (p === '/api/reminders' && req.method === 'GET') {
    const { on, aheadDays, dayHour, doneDeadlines } = loadReminders();
    return json(res, 200, { on, aheadDays, dayHour, doneDeadlines });
  }
  if (p === '/api/reminders' && req.method === 'PUT') {
    if (badOrigin(req)) return json(res, 403, { error: 'bad origin' });
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'expected application/json' });
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const b = JSON.parse(body);
      const r = loadReminders();
      const turnedOn = b.on === true && !r.on;
      if (typeof b.on === 'boolean') r.on = b.on;
      if (Number.isInteger(b.aheadDays) && b.aheadDays >= 0 && b.aheadDays <= 30) r.aheadDays = b.aheadDays;
      if (Number.isInteger(b.dayHour) && b.dayHour >= 0 && b.dayHour <= 23) r.dayHour = b.dayHour;
      if (Array.isArray(b.doneDeadlines)) {
        r.doneDeadlines = [...new Set(b.doneDeadlines.filter(x => typeof x === 'string' && x.startsWith('moodle-')))].slice(-500);
      }
      // The page owns the day reminders; the server only needs a copy to send them.
      if (Array.isArray(b.days)) {
        r.days = b.days.slice(0, 50)
          .filter(x => x && typeof x.day === 'string' && typeof x.text === 'string' && x.text.trim())
          .map(x => ({ day: x.day.slice(0, 10), text: x.text.trim().slice(0, 200) }));
      }
      saveReminders(r);
      if (turnedOn) {
        await platform.notify('Reminders on', 'You will hear about tasks that are due, even with the dashboard closed.');
        checkDueReminders();
      }
      return json(res, 200, { on: r.on, aheadDays: r.aheadDays, dayHour: r.dayHour, doneDeadlines: r.doneDeadlines });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // Rename an eLearn course (writes courses.json). Same fencing as /api/reveal: it writes a file.
  if (p === '/api/course-name' && req.method === 'POST') {
    if (badOrigin(req)) return json(res, 403, { error: 'bad origin' });
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'expected application/json' });
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { id, name } = JSON.parse(body);
      const course = String(id || '').replace(/^moodle:/, '');
      const clean = String(name || '').trim();
      if (!course || course === 'other' || course.startsWith('_')) throw new Error('unknown course');
      if (!clean || clean.length > 80) throw new Error('name must be 1–80 characters');
      moodle.setName(course, clean);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }
  // Task list in SQLite, so any local tool (or agent) can read/write it.
  if (p === '/api/todos' && req.method === 'GET') {
    return json(res, 200, { todos: listTodos() });
  }
  if (p === '/api/todos' && (req.method === 'PUT' || req.method === 'POST')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body);
      // PUT replaces the whole list; POST appends one task or an array of tasks.
      if (req.method === 'PUT') {
        if (!Array.isArray(parsed)) throw new Error('expected an array');
        replaceTodos(parsed);
      } else {
        appendTodos(Array.isArray(parsed) ? parsed : [parsed]);
      }
      return json(res, 200, { ok: true, todos: listTodos() });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // Reveal a local folder/file in Finder or Explorer. Browsers refuse file:// links from an
  // http:// page, so the click comes here instead.
  //
  // This runs a program on this machine, so it is deliberately fenced in: JSON content
  // type (forces a CORS preflight, which blocks other websites from calling it),
  // same-origin check, path must already exist, and argv form so nothing hits a shell.
  if (p === '/api/reveal' && req.method === 'POST') {
    if (badOrigin(req)) return json(res, 403, { error: 'bad origin' });
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'expected application/json' });
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let target = '';
    try {
      target = String(JSON.parse(body).path || '');
      if (target.startsWith('~')) target = path.join(os.homedir(), target.slice(1));
      if (!path.isAbsolute(target)) throw new Error('path must be absolute');
      const stat = fs.statSync(target);                       // throws if missing
      // Directory: open it. File: reveal it in its parent folder.
      platform.reveal(target, stat.isDirectory());
      return json(res, 200, { ok: true });
    } catch (err) {
      // Show the resolved path: mismatches are usually invisible in Finder
      // (a trailing space, a renamed parent), so naming it saves a lot of guessing.
      return json(res, 400, {
        error: err.code === 'ENOENT' ? `not found: ${target}` : err.message,
      });
    }
  }

  // Native folder picker (Finder's on macOS, WinForms' on Windows; see platform.js).
  // The browser cannot expose a real filesystem path, so the dialog runs here.
  if (p === '/api/pick-folder' && req.method === 'POST') {
    if (badOrigin(req)) return json(res, 403, { error: 'bad origin' });
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'expected application/json' });
    }
    for await (const _ of req) { /* drain */ }
    try {
      let picked = await platform.pickFolder();
      if (picked === null) return json(res, 200, { cancelled: true });
      const home = os.homedir();
      if (picked.startsWith(home + path.sep)) picked = '~' + picked.slice(home.length);   // shorter to read
      return json(res, 200, { path: picked });
    } catch (err) {
      console.error('[pick-folder]', err.message);
      return json(res, 500, { error: 'could not open the folder picker' });
    }
  }

  // What this OS can do, so the page hides buttons that would only fail.
  if (p === '/api/platform' && req.method === 'GET') return json(res, 200, platform.capabilities);

  // Per-install settings. The Moodle URL carries a login token, so it goes in but never comes back out.
  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, { name: config.name || '', moodle: moodle.configured(), update: updater.status });
  }
  if (p === '/api/config' && req.method === 'PUT') {
    if (badOrigin(req)) return json(res, 403, { error: 'bad origin' });
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'expected application/json' });
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const b = JSON.parse(body);
      if (typeof b.name === 'string') config.name = b.name.trim().slice(0, 40);
      if (typeof b.moodleUrl === 'string') {
        const u = b.moodleUrl.trim();
        if (u && !/^https:\/\/[^\s]+$/.test(u)) throw new Error('the Moodle URL must start with https://');
        config.moodleUrl = u;
        process.env.MOODLE_ICS_URL = u;
        moodle._reset();
      }
      saveConfig(config);
      return json(res, 200, { name: config.name || '', moodle: moodle.configured(), update: updater.status });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (p === '/api/token' && req.method === 'GET') {
    try {
      const entry = await accessTokenFor(url.searchParams.get('email'), url.searchParams.get('force') === '1');
      return json(res, 200, entry);
    } catch (err) {
      return json(res, 401, { error: err.message });
    }
  }

  // Static files
  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : decodeURIComponent(p)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    // no-cache: Safari (and its Add-to-Dock web apps) otherwise keeps serving an old
    // index.html beside a new app.js, and the mismatch silently breaks saving.
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});
// Retry a busy port for a while: after an update the old server may still be shutting down.
let tries = 0;
server.on('error', err => {
  if (err.code !== 'EADDRINUSE' || ++tries > 20) throw err;
  setTimeout(() => server.listen(PORT), 1000);
});
server.listen(PORT, () => console.log(`Attention Dashboard v${updater.VERSION} → http://localhost:${PORT}`));
updater.start(config, platform.restart);
