// Static file server + Google OAuth (refresh-token) + Gemini briefing proxy.
// Zero dependencies (Node >= 20.12).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');   // built in since Node 22, no dependency

try { process.loadEnvFile(); } catch { /* no .env yet */ }

const PORT = 3000;
const PUBLIC = path.join(__dirname, 'public');
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const TASKS_FILE = path.join(__dirname, 'tasks.json');   // legacy, migrated into SQLite on boot
const DB_FILE = path.join(__dirname, 'tasks.db');
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const SCOPES = 'openid email https://www.googleapis.com/auth/calendar';
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

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const rowToTodo = r => ({
  id: r.id, title: r.title, desc: r.description, link: r.link,
  deadline: r.deadline, calEventId: r.calEventId, calAcct: r.calAcct,
});

function listTodos() {
  return db.prepare('SELECT * FROM todos ORDER BY seq').all().map(rowToTodo);
}

const insertTodo = db.prepare(
  `INSERT INTO todos (id, title, description, link, deadline, calEventId, calAcct)
   VALUES (?, ?, ?, ?, ?, ?, ?)`);

function normalise(t) {
  const title = String(t.title ?? '').trim();
  if (!title) return null;
  return [t.id || newId(), title, t.desc ?? null, t.link ?? null,
          t.deadline ?? null, t.calEventId ?? null, t.calAcct ?? null];
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
function oauthStart(res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    return res.end('<h2>Missing credentials</h2><p>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart the server.</p>');
  }
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
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

async function briefing(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { prompt } = JSON.parse(body);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('bad prompt');
    const r = await fetch(
      // gemini-2.0-flash lost its free-tier quota; the -latest alias tracks the current free model
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=' +
        process.env.GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt.slice(0, 8000) }] }] }),
      }
    );
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(data.error?.message || 'empty response');
    json(res, 200, { text });
  } catch (err) {
    console.error('[briefing]', process.env.GEMINI_API_KEY ? err.message : 'GEMINI_API_KEY not set — check .env and restart');
    json(res, 502, { error: 'briefing failed' });
  }
}

// ─── Router ───────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/oauth/start') return oauthStart(res);
  if (p === '/oauth/callback') return oauthCallback(res, url.searchParams);
  if (p === '/api/briefing' && req.method === 'POST') return briefing(req, res);

  if (p === '/api/accounts' && req.method === 'GET') {
    return json(res, 200, Object.keys(loadTokens()).map(email => ({ email })));
  }
  if (p === '/api/accounts' && req.method === 'DELETE') {
    const email = url.searchParams.get('email');
    const tokens = loadTokens();
    delete tokens[email];
    saveTokens(tokens);
    accessCache.delete(email);
    return json(res, 200, { ok: true });
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

  // Reveal a local folder/file in Finder. Browsers refuse file:// links from an
  // http:// page, so the click comes here instead.
  //
  // This runs `open` on this Mac, so it is deliberately fenced in: JSON content
  // type (forces a CORS preflight, which blocks other websites from calling it),
  // same-origin check, path must already exist, and argv form so nothing hits a shell.
  if (p === '/api/reveal' && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://localhost:${PORT}`) return json(res, 403, { error: 'bad origin' });
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
      execFile('open', stat.isDirectory() ? [target] : ['-R', target], err => {
        if (err) console.error('[reveal]', err.message);
      });
      return json(res, 200, { ok: true });
    } catch (err) {
      // Show the resolved path: mismatches are usually invisible in Finder
      // (a trailing space, a renamed parent), so naming it saves a lot of guessing.
      return json(res, 400, {
        error: err.code === 'ENOENT' ? `not found: ${target}` : err.message,
      });
    }
  }

  // Native macOS folder picker (supports search, favourites, typing a path with ⌘⇧G).
  // The browser cannot expose a real filesystem path, so the dialog runs here.
  if (p === '/api/pick-folder' && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://localhost:${PORT}`) return json(res, 403, { error: 'bad origin' });
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'expected application/json' });
    }
    for await (const _ of req) { /* drain */ }
    return execFile('osascript', [
      '-e', 'activate',
      '-e', 'POSIX path of (choose folder with prompt "Choose a folder for this task")',
    ], { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        // -128 is the user pressing Cancel, which is not an error worth reporting.
        if (/-128/.test(stderr || '') || /-128/.test(err.message)) return json(res, 200, { cancelled: true });
        console.error('[pick-folder]', (stderr || err.message).trim());
        return json(res, 500, { error: 'could not open the folder picker' });
      }
      let picked = stdout.trim().replace(/\/+$/, '');           // drop trailing slash
      const home = os.homedir();
      if (picked.startsWith(home + '/')) picked = '~' + picked.slice(home.length);   // shorter to read
      json(res, 200, { path: picked });
    });
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`Attention Dashboard → http://localhost:${PORT}`));
