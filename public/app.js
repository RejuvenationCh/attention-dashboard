const TZ = 'Asia/Makassar';
// OAuth now lives entirely on the server (see server.js); credentials are in .env.

// ─── Google auth — multi-account, server-held refresh tokens ──────
// The server owns the long-lived refresh token per account and mints short-lived
// access tokens on demand, so this page never has to prompt for sign-in again.
// Google accounts carry an access token and are fetched from this page. The
// Moodle one has no token at all — the server owns that feed and its authtoken —
// so anything that calls Google has to filter these apart.
let accounts = [];        // [{ email, name?, source?, token?, exp, calendars: [{ id, name, color }] }]
const googleAccounts = () => accounts.filter(a => a.source !== 'moodle');
const moodleAccounts = () => accounts.filter(a => a.source === 'moodle');

// Falls back to a Google account: only those can be written to or RSVP'd.
function acctOf(email) { return accounts.find(a => a.email === email) || googleAccounts()[0]; }

// ─── Which calendars are shown ────────────────────────────────────
// Keyed by account + calendar, so the same shared calendar can be visible under
// one account and hidden under the other (that is the usual source of duplicates).
// Only hidden ones are stored, so newly added calendars default to visible.
const CAL_HIDDEN_KEY = 'chris-dashboard-hidden-calendars-v1';
let hiddenCals = new Set();
try { hiddenCals = new Set(JSON.parse(localStorage.getItem(CAL_HIDDEN_KEY)) || []); } catch {}

const calKey = (email, calId) => `${email}::${calId}`;
const isCalShown = (email, calId) => !hiddenCals.has(calKey(email, calId));
function shownCalendars(acct) { return acct.calendars.filter(c => isCalShown(acct.email, c.id)); }
function totalCalendars() { return accounts.reduce((n, a) => n + shownCalendars(a).length, 0); }

function toggleCal(ai, ci) {
  const acct = accounts[ai];
  const cal = acct?.calendars[ci];
  if (!cal) return;
  const k = calKey(acct.email, cal.id);
  hiddenCals.has(k) ? hiddenCals.delete(k) : hiddenCals.add(k);
  localStorage.setItem(CAL_HIDDEN_KEY, JSON.stringify([...hiddenCals]));
  monthCache = { key: null, byDate: null };      // cached month data is now stale
  renderAccounts();
  reload();
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
  return r.json();
}

async function fetchToken(email, force = false) {
  return api(`/api/token?email=${encodeURIComponent(email)}${force ? '&force=1' : ''}`);
}

// Connected accounts whose stored token no longer works (consent revoked, or the
// refresh token expired while the app was in "Testing" publishing status).
let failedAccounts = [];

// Silent on every load: ask the server for a fresh token per connected account.
async function restoreAccounts() {
  let list = [];
  try { list = await api('/api/accounts'); } catch {}
  failedAccounts = [];
  for (const entry of list) {
    // Moodle arrives with its calendars attached and nothing to sign in to.
    if (entry.source === 'moodle') {
      accounts.push({ email: entry.email, name: entry.name, source: 'moodle', calendars: entry.calendars || [] });
      continue;
    }
    try {
      const { token, exp } = await fetchToken(entry.email);
      const { list: calendars } = await listCalendars(token);
      accounts.push({ email: entry.email, token, exp, calendars });
    } catch (err) {
      // This used to be a bare `catch {}`: a signed-out account silently vanished
      // from the dashboard and you only noticed by the events going missing.
      failedAccounts.push({ email: entry.email, error: err.message });
    }
  }
  renderAccounts();
  // Always via reload(): it owns the disconnected branch, and calling
  // showDisconnected() straight from here skipped the cards that branch fills.
  reload();
}

// Consent happens once per account, in a normal page redirect.
function addAccount() { window.location.href = '/oauth/start'; }

async function removeAccount(email) {
  await fetch(`/api/accounts?email=${encodeURIComponent(email)}`, { method: 'DELETE' }).catch(() => {});
  accounts = accounts.filter(a => a.email !== email);
  renderAccounts();
  // Always via reload(): it owns the disconnected branch, and calling
  // showDisconnected() straight from here skipped the cards that branch fills.
  reload();
}

async function listCalendars(token) {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=50',
    { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`Could not list calendars (${res.status}${detail ? ' · ' + detail : ''})`);
  }
  const items = (await res.json()).items || [];
  return {
    primaryEmail: items.find(c => c.primary)?.id || 'unknown account',
    list: items
      .filter(c => c.selected !== false && !c.deleted)   // mirror what's ticked in Google Calendar
      .slice(0, MAX_CALENDARS)
      .map(c => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor })),
  };
}

// Calendar API fetch for one account, with a silent-refresh retry on 401
// (tokens die after ~1h and this dashboard stays open all day).
async function gcal(pathAndQuery, init = {}, acct = googleAccounts()[0]) {
  if (!acct) throw new Error('No account connected');
  const call = () => fetch('https://www.googleapis.com/calendar/v3' + pathAndQuery, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: 'Bearer ' + acct.token },
  });
  let res = await call();
  if (res.status === 401) {
    const cred = await fetchToken(acct.email, true);   // server refreshes it
    acct.token = cred.token;
    acct.exp = cred.exp;
    res = await call();
  }
  return res;
}

function showDisconnected() {
  ['event-count','week-count'].forEach(id => document.getElementById(id).textContent = '–');
  // Say which it is: an account that needs reconnecting is a different problem
  // from having never connected one.
  ['event-list','week-list'].forEach(id =>
    document.getElementById(id).innerHTML = `<div class="empty">${
      failedAccounts.length
        ? 'Signed out — reconnect your Google account in Accounts'
        : 'Connect a Google account to load events'}</div>`);
  document.getElementById('cd-days').textContent = '–';
  document.getElementById('cd-name').textContent = 'Not connected';
  document.getElementById('cd-sub').textContent = '–';
  document.getElementById('briefing-text').textContent = 'Waiting for calendar connection.';
}

function renderAccounts() {
  const el = document.getElementById('accounts-list');
  if (!accounts.length && !failedAccounts.length) {
    el.innerHTML = `<div class="acct-empty">No account connected yet.</div>
      <button class="btn-primary" onclick="addAccount()">Connect Google Calendar</button>`;
    return;
  }
  el.innerHTML = accounts.map((a, ai) => {
    const shown = shownCalendars(a).length;
    const isMoodle = a.source === 'moodle';
    return `
    <div class="acct-block">
      <div class="acct-row">
        <span class="acct-dot${isMoodle ? ' moodle' : ''}"></span>
        <div class="acct-body">
          <div class="acct-email">${escape(a.name || a.email)}</div>
          <div class="acct-meta">${shown} of ${a.calendars.length} calendar${a.calendars.length === 1 ? '' : 's'} shown</div>
        </div>
        ${isMoodle ? '' : `<button class="acct-remove" onclick="removeAccount('${escape(a.email)}')" title="Disconnect"><span class="msym">close</span></button>`}
      </div>
      <div class="cal-list">
        ${a.calendars.map((c, ci) => `
          <label class="cal-item">
            <input type="checkbox" ${isCalShown(a.email, c.id) ? 'checked' : ''} onchange="toggleCal(${ai}, ${ci})">
            <span class="cal-swatch" style="background:${c.color || '#94a3b8'}"></span>
            <span class="cal-name" title="${escape(c.name)}">${escape(c.name)}</span>
          </label>`).join('')}
      </div>
    </div>`;
  // Accounts the server still has a record of but whose token no longer works.
  // They stay listed, flagged, with the one action that fixes them.
  }).join('') + failedAccounts.map(f => `
    <div class="acct-block acct-failed">
      <div class="acct-row">
        <span class="acct-dot off"></span>
        <div class="acct-body">
          <div class="acct-email">${escape(f.email)}</div>
          <div class="acct-meta">Signed out — its calendars are not loading</div>
        </div>
        <button class="acct-reconnect" onclick="addAccount()">Reconnect</button>
      </div>
    </div>`).join('')
  // Moodle alone still needs a way to add Google; the empty state above only
  // covers having no accounts at all. A failed account shows its own button.
  + (googleAccounts().length || failedAccounts.length ? '' :
    `<button class="btn-primary acct-add" onclick="addAccount()">Connect Google Calendar</button>`);
}

// ─── Utilities ────────────────────────────────────────────────────
function formatTime(dt) {
  if (!dt) return 'All day';
  return new Date(dt).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone: TZ });
}
function msToTime(ms) { return formatTime(new Date(ms).toISOString()); }
function isHappening(s, e) { const n = Date.now(); return new Date(s) <= n && new Date(e) >= n; }
function getDateKey(offset = 0) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}
function dayLabel(offset) {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-ID', { weekday:'long', day:'numeric', month:'short', timeZone: TZ });
}
function escape(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatDur(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}
// "Today" / "Tomorrow" / "Mon, 3 Aug" for an event's start
function relDayLabel(ymd) {
  if (ymd === getDateKey(0)) return 'Today';
  if (ymd === getDateKey(1)) return 'Tomorrow';
  return new Date(ymd + 'T12:00:00+08:00').toLocaleDateString('en-ID', { weekday:'short', day:'numeric', month:'short', timeZone: TZ });
}

// ─── Greeting + date header ───────────────────────────────────────
function setGreeting() {
  const h = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }));
  const part = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
  document.getElementById('greet-line').textContent = `Good ${part}, Chris.`;
}
document.getElementById('date-line').textContent =
  new Date().toLocaleDateString('en-ID', { weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone: TZ });

// ─── Calendars ────────────────────────────────────────────────────
// Calendars are discovered per account at sign-in, so the dashboard follows
// whichever accounts you connect instead of hardcoded IDs. The cap keeps the
// per-reload request count sane (the original budget was 4 calendars).
const MAX_CALENDARS = 10;
const WRITE_CAL = 'primary';   // deadline events land on the owning account's own calendar

// Per-calendar failures from the last fetchRange, surfaced instead of silently swallowed.
let _calErrors = [];

// `errors` defaults to the shared banner list, but a caller fetching a different
// range concurrently (the deadlines card) passes its own so the two don't clobber
// each other — and so one failure isn't reported twice.
async function fetchRange(startYmd, endYmd, errors = _calErrors) {
  const params = new URLSearchParams({
    timeMin: startYmd + 'T00:00:00+08:00',
    timeMax: endYmd + 'T23:59:59+08:00',
    singleEvents: 'true',   // expand recurring events, as the MCP tool did implicitly
    orderBy: 'startTime',
    maxResults: '50',
  });
  errors.length = 0;
  // Every Google calendar of every connected account, each with its own token.
  const google = googleAccounts().flatMap(acct => shownCalendars(acct).map(cal =>
    gcal(`/calendars/${encodeURIComponent(cal.id)}/events?${params}`, {}, acct)
      .then(async r => {
        if (r.ok) return r.json();
        let detail = '';
        try { detail = (await r.json()).error?.message || ''; } catch {}
        throw new Error(`${r.status}${detail ? ' · ' + detail : ''}`);
      })
      // Raw Calendar API returns { items }, not the MCP wrapper's { events }.
      .then(data => (data.items || []).map(e => ({ ...e, _calId: cal.id, _calName: cal.name, _acct: acct.email })))
      .catch(err => { errors.push(`${cal.name} (${acct.email}) — ${err.message}`); return []; })
  ));
  // Moodle is one request for the whole range rather than one per course: the
  // courses only exist after the server has parsed the feed, and each event comes
  // back tagged with its course, so hiding one is a filter here.
  const moodle = moodleAccounts().map(acct =>
    api(`/api/moodle/events?start=${startYmd}&end=${endYmd}`)
      .then(data => (data.items || []).filter(e => isCalShown(acct.email, e._calId)))
      .catch(err => { errors.push(`${acct.name || acct.email} — ${err.message}`); return []; })
  );
  const all = (await Promise.all([...google, ...moodle])).flat().sort((a,b) =>
    (a.start?.dateTime||a.start?.date||'').localeCompare(b.start?.dateTime||b.start?.date||'')
  );
  const seen = new Set();
  return all.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
}

// ─── Calendar API write helpers ───────────────────────────────────
// Writes go to the first connected account's own calendar.
async function createDeadlineEvent(title, deadline) {
  const acct = googleAccounts()[0];
  if (!acct) throw new Error('No Google account connected');
  const res = await gcal(`/calendars/${encodeURIComponent(WRITE_CAL)}/events?sendUpdates=none`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: `📌 Deadline: ${title}`,
      start: { dateTime: deadline + 'T09:00:00+08:00', timeZone: TZ },
      end:   { dateTime: deadline + 'T09:30:00+08:00', timeZone: TZ },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 1440 }] },
    }),
  }, acct);
  if (!res.ok) throw new Error('create failed');
  return { id: (await res.json()).id || null, acct: acct.email };
}

// Best-effort: 204 = deleted, 410 = already gone. Both fine, never throws.
function deleteCalendarEvent(eventId, acctEmail) {
  return gcal(`/calendars/${encodeURIComponent(WRITE_CAL)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
    { method: 'DELETE' }, acctOf(acctEmail)).catch(() => {});
}

// The API has no "respond" endpoint: patch your own attendee record,
// sending the FULL attendees array so nobody else gets dropped.
async function respondToEvent(e, status) {
  const acct = acctOf(e._acct);   // must be the account that was invited
  const base = `/calendars/${encodeURIComponent(e._calId)}/events/${encodeURIComponent(e.id)}`;
  const res = await gcal(base, {}, acct);
  if (!res.ok) throw new Error('get failed');
  const ev = await res.json();
  const attendees = ev.attendees || [];
  const me = attendees.find(a => a.self === true);
  if (!me) throw new Error('no self attendee');
  me.responseStatus = status;
  const patch = await gcal(base + '?sendUpdates=all', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attendees }),
  }, acct);
  if (!patch.ok) throw new Error('patch failed');
}

// ─── Free time blocks ─────────────────────────────────────────────
function getFreeBlocks(events, ymd) {
  const now = Date.now();
  const dayEnd = new Date(ymd + 'T22:00:00+08:00').getTime();
  const dayStart = new Date(ymd + 'T06:00:00+08:00').getTime();
  const cursor0 = Math.max(now, dayStart);
  if (cursor0 >= dayEnd) return [];

  const MIN = 45 * 60000;
  const timed = events
    .filter(e => e.start?.dateTime && e.start.dateTime.startsWith(ymd))
    .sort((a,b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));

  const blocks = [];
  let cursor = cursor0;

  for (const e of timed) {
    const s = new Date(e.start.dateTime).getTime();
    const en = new Date(e.end?.dateTime || e.start.dateTime).getTime();
    if (s > cursor + MIN) blocks.push({ from: cursor, to: s });
    if (en > cursor) cursor = en;
  }
  if (dayEnd > cursor + MIN) blocks.push({ from: cursor, to: dayEnd });
  return blocks.filter(b => b.to > now && b.to > b.from);
}

// ─── Busyness bar ─────────────────────────────────────────────────
function busynessBar(count) {
  const max = 5, n = Math.min(count, max);
  const color = count === 0 ? null : count <= 2 ? '#4ade80' : count <= 4 ? '#facc15' : '#f87171';
  let html = '<span class="busy-bar">';
  for (let i = 0; i < max; i++)
    html += `<span class="busy-seg"${i < n && color ? ` style="background:${color}"` : ''}></span>`;
  return html + '</span>';
}

// ─── Clock ────────────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById('clock-time').textContent =
      now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone: TZ });
    document.getElementById('clock-day').textContent =
      now.toLocaleDateString('en-ID', { weekday:'long', timeZone: TZ }) + ' · WITA';
  }
  tick();
  setInterval(tick, 1000);
}

// ─── Day progress donut (7 AM – 10 PM) ────────────────────────────
function updateDayProgress() {
  const now = new Date();
  const ymd = now.toLocaleDateString('en-CA', { timeZone: TZ });
  const dayStart = new Date(ymd + 'T07:00:00+08:00').getTime();
  const dayEnd   = new Date(ymd + 'T22:00:00+08:00').getTime();
  const pct = Math.min(100, Math.max(0, (now.getTime() - dayStart) / (dayEnd - dayStart) * 100));
  document.getElementById('day-donut').style.strokeDashoffset = (283 * (1 - pct / 100)).toFixed(1);
  document.getElementById('day-pct').textContent = Math.round(pct);
}

// ─── AI Day Briefing (via local /api/briefing proxy) ──────────────
// Cached per WITA day: Gemini is called once per day, not on every reload.
const BRIEFING_KEY = 'chris-dashboard-briefing-v1';
let _briefArgs = [[], []];   // last events passed to loadBriefing, for manual regeneration

function briefingCachedToday() {
  try { return JSON.parse(localStorage.getItem(BRIEFING_KEY))?.day === getDateKey(0); }
  catch { return false; }
}

function regenBriefing() {
  localStorage.removeItem(BRIEFING_KEY);
  document.getElementById('briefing-text').innerHTML = '<span class="spinner"></span> Generating briefing…';
  loadBriefing(..._briefArgs);
}

async function loadBriefing(todayEvents, tomorrowEvents) {
  const el = document.getElementById('briefing-text');
  const today = getDateKey(0);
  try {
    const cached = JSON.parse(localStorage.getItem(BRIEFING_KEY));
    if (cached?.day === today && cached.text) { el.textContent = cached.text; return; }
  } catch {}

  const fmt = evs => evs.length === 0 ? 'nothing scheduled'
    : evs.map(e => `${formatTime(e.start?.dateTime)} ${e.summary || '(No title)'}`).join(', ');
  const todayStr    = fmt(todayEvents);
  const tomorrowStr = fmt(tomorrowEvents);
  const prompt = `Write exactly 2 short, friendly sentences briefing Chris on his day. Be warm and specific. Do NOT start with "Good morning", "Here's", or "Based on". Just dive straight in. Mention what stands out today and anything to keep in mind for tomorrow. Today's schedule: ${todayStr}. Tomorrow: ${tomorrowStr}.`;
  try {
    const r = await fetch('/api/briefing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!r.ok) throw new Error('proxy error');
    const { text, stale, at } = await r.json();
    if (stale) {
      // The server kept the last good answer while Gemini was busy. Showing it with a stamp
      // beats an apology — it is still today's schedule it was written about — but it must not
      // be passed off as fresh, and it must not be cached as if it were.
      const when = at ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
      el.textContent = `${text} (Written earlier${when ? ' at ' + when : ''} — Gemini is busy right now.)`;
      return;
    }
    el.textContent = text;
    localStorage.setItem(BRIEFING_KEY, JSON.stringify({ day: today, text }));
  } catch(err) {
    // Not cached, so the next reload tries the API again.
    el.textContent = 'Briefing unavailable. Check the schedule below.';
  }
}

// ─── Countdown ────────────────────────────────────────────────────
function renderCountdown(events) {
  const now = Date.now();
  const next = events.find(e => {
    const s = new Date(e.start?.dateTime || e.start?.date + 'T00:00:00+08:00').getTime();
    return s > now + 30 * 60000;
  });
  if (!next) {
    document.getElementById('cd-days').textContent = '–';
    document.getElementById('cd-name').textContent = 'Nothing upcoming';
    document.getElementById('cd-sub').textContent  = "you're all clear";
    return;
  }
  const start = new Date(next.start?.dateTime || next.start?.date + 'T00:00:00+08:00');
  const diffMs = start.getTime() - now;
  const diffH  = diffMs / 3600000;
  const diffD  = Math.floor(diffH / 24);
  let timeStr, subStr;
  if (diffH < 1)       { timeStr = Math.round(diffMs / 60000) + ' min'; subStr = 'very soon'; }
  else if (diffH < 24) { timeStr = Math.round(diffH) + 'h'; subStr = 'Today ' + formatTime(next.start?.dateTime); }
  else if (diffD === 1){ timeStr = '1 day'; subStr = 'Tomorrow ' + formatTime(next.start?.dateTime); }
  else                 { timeStr = diffD + ' days'; subStr = start.toLocaleDateString('en-ID', { weekday:'short', day:'numeric', month:'short', timeZone: TZ }) + ' ' + formatTime(next.start?.dateTime); }
  document.getElementById('cd-days').textContent = timeStr;
  document.getElementById('cd-name').textContent = next.summary || '(No title)';
  document.getElementById('cd-sub').textContent  = subStr;
}

// ─── RSVP ─────────────────────────────────────────────────────────
let _rsvpEvents = [];
let _rsvpGroups = [];   // the last render's grouping; the group buttons index into this

function inviteTimeLabel(e) {
  if (e.start?.dateTime) {
    const ymd = e.start.dateTime.substring(0, 10);
    const range = formatTime(e.start.dateTime) + (e.end?.dateTime ? ' - ' + formatTime(e.end.dateTime) : '');
    return `${relDayLabel(ymd)}, ${range}`;
  }
  if (e.start?.date) return `${relDayLabel(e.start.date)}, all day`;
  return '';
}

// Two occurrences belong to the same series when Google says so. The calendar query runs with
// singleEvents:'true', so recurring events arrive expanded into instances that still carry
// recurringEventId, and every instance of a series shares an iCalUID. Neither field was read
// anywhere before this — they ride along untouched in the payload — so folding a series back
// into one row needs no server change and no new API field.
function seriesKey(e) {
  return e.recurringEventId || e.iCalUID || ('title:' + (e.summary || ''));
}

function renderRsvp(events) {
  _rsvpEvents = events;
  const card = document.getElementById('rsvp-card');
  if (!events.length) { card.style.display='none'; return; }
  card.style.display = '';

  // Fold repeated occurrences of one series into a single row. Before this, five dates of the
  // same weekly invite were five identical rows: the one genuinely different invite sat buried
  // in the middle of them, and answering the series meant five separate clicks.
  const groups = [];
  const byKey  = new Map();
  events.forEach((e, i) => {
    const k = seriesKey(e);
    let g = byKey.get(k);
    if (!g) { g = { key: k, idx: [], events: [] }; byKey.set(k, g); groups.push(g); }
    g.idx.push(i);
    g.events.push(e);
  });
  _rsvpGroups = groups;

  // The badge counts decisions rather than rows: a collapsed series is one thing to answer.
  document.getElementById('rsvp-count').textContent = groups.length;
  document.getElementById('rsvp-list').innerHTML = groups
    .map((g, gi) => g.idx.length === 1 ? inviteRow(g.events[0], g.idx[0]) : inviteGroupRow(g, gi))
    .join('');
}

// The original single-invite markup, unchanged. Group instances use it verbatim, so a
// per-occurrence Decline/Accept behaves exactly as it always did.
function inviteRow(e, i) {
  return `
    <div class="invite">
      <div class="invite-inner">
        <div class="invite-avatar">${escape((e._calName || '?')[0])}</div>
        <div class="invite-body">
          <div class="invite-title"><a href="${escape(e.htmlLink||'#')}" target="_blank">${escape(e.summary||'(No title)')}</a></div>
          <div class="invite-time">${inviteTimeLabel(e)}</div>
          <div class="invite-meta">${escape(e._calName)}${acctTag(e)}${e.location?' · '+escape(e.location):''}</div>
          <div class="invite-btns" id="rsvp-btns-${i}">
            <button class="btn-decline" onclick="rsvpRespond(${i},'declined')">Decline</button>
            <button class="btn-accept" onclick="rsvpRespond(${i},'accepted')">Accept</button>
          </div>
        </div>
      </div>
    </div>`;
}

function inviteGroupRow(g, gi) {
  const first = g.events[0];   // the list arrives ordered by startTime, so this is the next one
  const n     = g.events.length;
  const days  = new Set(g.events.map(e => (e.start?.dateTime || e.start?.date || '').substring(0, 10))).size;
  const unit  = days > 1 ? 'dates' : 'invites';
  // The instances stay reachable, just folded away: a series is usually answered as a whole,
  // but one occurrence can still be declined on its own without leaving the card.
  const instances = g.idx.map((i, k) => `
          <div class="invite-instance">
            <span class="invite-instance-when">${inviteTimeLabel(g.events[k])}</span>
            <div class="invite-btns" id="rsvp-btns-${i}">
              <button class="btn-decline" onclick="rsvpRespond(${i},'declined')">Decline</button>
              <button class="btn-accept" onclick="rsvpRespond(${i},'accepted')">Accept</button>
            </div>
          </div>`).join('');
  return `
    <div class="invite invite-group">
      <div class="invite-inner">
        <div class="invite-avatar">${escape((first._calName || '?')[0])}</div>
        <div class="invite-body">
          <div class="invite-title">
            <a href="${escape(first.htmlLink||'#')}" target="_blank">${escape(first.summary||'(No title)')}</a>
            <span class="count-chip">${n} ${unit}</span>
          </div>
          <div class="invite-time">Next: ${inviteTimeLabel(first)}</div>
          <div class="invite-meta">${escape(first._calName)}${acctTag(first)}${first.location?' · '+escape(first.location):''}</div>
          <div class="invite-btns" id="rsvp-gbtns-${gi}">
            <button class="btn-decline" onclick="rsvpRespondGroup(${gi},'declined')">Decline all</button>
            <button class="btn-accept" onclick="rsvpRespondGroup(${gi},'accepted')">Accept all</button>
          </div>
          <button class="text-btn invite-toggle" id="rsvp-gtog-${gi}" aria-expanded="false"
                  onclick="toggleInviteGroup(${gi})">Show all ${n} ${unit}</button>
        </div>
      </div>
      <div class="invite-instances" id="rsvp-glist-${gi}" hidden>${instances}
      </div>
    </div>`;
}

function toggleInviteGroup(gi) {
  const list = document.getElementById(`rsvp-glist-${gi}`);
  const btn  = document.getElementById(`rsvp-gtog-${gi}`);
  if (!list) return;
  const opening = list.hasAttribute('hidden');
  if (opening) list.removeAttribute('hidden'); else list.setAttribute('hidden', '');
  if (btn) {
    btn.setAttribute('aria-expanded', String(opening));
    btn.textContent = opening ? 'Hide dates' : `Show all ${_rsvpGroups[gi]?.events.length ?? ''} dates`;
  }
}

// Answering a whole series. Deliberately not a loop over rsvpRespond(): that one removes its
// event by index, and once the first removal lands every later index points at the wrong
// event. This keys on the event objects instead.
function rsvpRespondGroup(gi, status) {
  const g = _rsvpGroups[gi];
  if (!g) return;
  const btnsEl = document.getElementById(`rsvp-gbtns-${gi}`);
  if (!btnsEl) return;
  const origHTML = btnsEl.innerHTML;
  const label = status === 'accepted' ? '✓ Accepted' : '✕ Declined';
  btnsEl.innerHTML = `<span class="rsvp-done ${status}">${label}</span>`;

  const mine = new Set(g.events);
  const undo = () => {
    clearTimeout(pendingTimer);
    btnsEl.innerHTML = origHTML;
    hideToast();
  };

  const pendingTimer = setTimeout(async () => {
    hideToast();
    _rsvpEvents = _rsvpEvents.filter(e => !mine.has(e));   // optimistic, as the single path is
    renderRsvp(_rsvpEvents);
    const results = await Promise.allSettled(g.events.map(e => respondToEvent(e, status)));
    if (results.some(r => r.status === 'rejected')) {
      _rsvpEvents.push(...g.events);
      renderRsvp(_rsvpEvents);
      showToast('Failed to respond — invites restored', null, 5);
    }
  }, 5000);

  showToast(`RSVP: ${label} (${g.events.length})`, undo, 5);
}

function rsvpRespond(idx, status) {
  const e = _rsvpEvents[idx];
  if (!e) return;
  const btnsEl = document.getElementById(`rsvp-btns-${idx}`);
  if (!btnsEl) return;
  const origHTML = btnsEl.innerHTML;

  const label = status === 'accepted' ? '✓ Accepted' : '✕ Declined';
  btnsEl.innerHTML = `<span class="rsvp-done ${status}">${label}</span>`;

  const undo = () => {
    clearTimeout(pendingTimer);
    btnsEl.innerHTML = origHTML;
    hideToast();
  };

  let pendingTimer = setTimeout(() => {
    hideToast();
    // Remove immediately (optimistic)
    _rsvpEvents = _rsvpEvents.filter((_, i) => i !== idx);
    renderRsvp(_rsvpEvents);
    // Fire API in background — restore + notify if it fails
    respondToEvent(e, status).catch(() => {
      _rsvpEvents.push(e);
      renderRsvp(_rsvpEvents);
      showToast(`Failed to respond — "${escape(e.summary||'event')}" restored`, null, 5);
    });
  }, 5000);

  showToast(`RSVP: ${label}`, undo, 5);
}

// ─── Timeline events ──────────────────────────────────────────────
function calDot(calId) {
  const opts = ['dot-blue','dot-violet','dot-teal','dot-rose','dot-amber'];
  let h = 0; for (let i = 0; i < calId.length; i++) h = (h * 31 + calId.charCodeAt(i)) % opts.length;
  return opts[h];
}
function dotColor(cls) {
  const map = { 'dot-blue':'#3b82f6','dot-violet':'#7c3aed','dot-teal':'#0d9488','dot-rose':'#e11d48','dot-amber':'#d97706' };
  return map[cls] || '#94a3b8';
}
// Google's own colour for the calendar, falling back to the hashed palette.
function evColor(e) {
  for (const a of accounts) {
    const hit = a.calendars.find(c => c.id === e._calId);
    if (hit?.color) return hit.color;
  }
  return dotColor(calDot(e._calId));
}

// Only worth showing which inbox an event came from once there are two.
function acctTag(e) {
  return accounts.length > 1 && e._acct ? ` <span class="acct-badge">${escape(e._acct)}</span>` : '';
}

// ─── Deleting your own calendar events ────────────────────────────
// Google flags the signed-in user on the event: `creator.self` means you added it.
// Anything you were merely invited to stays undeletable — decline it instead.
function canDeleteEvent(e) {
  return e.creator?.self === true || e.organizer?.self === true;
}

// Rendered events are registered by key, so handlers never have to escape ids.
let _evRegistry = {};
let _evSeq = 0;

async function deleteCalendarEventById(e) {
  const res = await gcal(
    `/calendars/${encodeURIComponent(e._calId)}/events/${encodeURIComponent(e.id)}?sendUpdates=all`,
    { method: 'DELETE' }, acctOf(e._acct));
  if (!res.ok && res.status !== 410) throw new Error('HTTP ' + res.status);   // 410 = already gone
}

// Optimistic, with the same undo window as RSVP: the API call only fires once
// the toast expires, so Undo means nothing ever left this machine.
function deleteEvent(key) {
  const e = _evRegistry[key];
  const el = document.getElementById(key);
  if (!e || !el) return;
  const name = e.summary || '(No title)';
  el.style.display = 'none';

  let timer;
  const undo = () => { clearTimeout(timer); el.style.display = ''; hideToast(); };
  timer = setTimeout(async () => {
    hideToast();
    try {
      await deleteCalendarEventById(e);
    } catch {
      el.style.display = '';
      showToast(`Couldn't delete "${name.length > 24 ? name.slice(0,24)+'…' : name}"`, null, 5);
    }
  }, 5000);

  showToast(`Deleted "${name.length > 24 ? name.slice(0,24)+'…' : name}"`, undo, 5);
}

function renderTlEvent(e, isToday) {
  const start = e.start?.dateTime || e.start?.date;
  const end   = e.end?.dateTime   || e.end?.date;
  const now_  = isToday && start && end && isHappening(start, end);
  const needsRsvp = e.attendees?.some(a => a.self && a.responseStatus === 'needsAction');
  // MCP wrapper exposed conferenceUrl; the raw API uses hangoutLink / conferenceData
  const meetUrl = e.hangoutLink
    || e.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri
    || null;
  const title = escape(e.summary || '(No title)') + (needsRsvp ? ' (pending RSVP)' : '');
  const key = 'ev' + (_evSeq++);
  _evRegistry[key] = e;
  return `
  <div class="tl-event" id="${key}">
    <div class="tl-time${now_ ? ' now' : ''}">${formatTime(e.start?.dateTime)}</div>
    <div class="tl-card${now_ ? ' current' : ''}${needsRsvp ? ' ghost' : ''}">
      ${needsRsvp ? '' : `<div class="bar" style="background:${evColor(e)}"></div>`}
      ${canDeleteEvent(e) ? `<button class="ev-del" onclick="event.stopPropagation(); deleteEvent('${key}')" title="Delete from Google Calendar"><span class="msym">close</span></button>` : ''}
      <div class="tl-title"><a href="${escape(e.htmlLink||'#')}" target="_blank">${title}</a></div>
      <div class="tl-meta">
        ${escape(e._calName)}${acctTag(e)}${e.location?' · '+escape(e.location):''}
        ${meetUrl?` · <span class="msym">videocam</span> <a href="${escape(meetUrl)}" target="_blank">Join Meet</a>`:''}
      </div>
    </div>
  </div>`;
}

function renderFreeBlock(from, to) {
  return `
  <div class="tl-event">
    <div class="tl-time">${msToTime(from)}</div>
    <div class="tl-card ghost">
      <div class="tl-title">${formatDur(to - from)} free</div>
    </div>
  </div>`;
}

const NOW_LINE = '<div class="now-line"><div class="now-line-bar"></div><div class="now-tag">NOW</div></div>';

// One day's event stack; today gets interleaved free blocks + a NOW line.
function renderDayRows(ymd, dayEvents, isToday) {
  if (!dayEvents.length && !isToday) return '<div class="tl-empty">No scheduled events</div>';

  const freeBlocks = isToday ? getFreeBlocks(dayEvents, ymd) : [];
  const items = [
    ...dayEvents.map(e => ({ type:'event', t: new Date(e.start?.dateTime||e.start?.date+'T00:00:00+08:00').getTime(), e })),
    ...freeBlocks.map(b => ({ type:'free', t: b.from, from: b.from, to: b.to })),
  ].sort((a, b) => a.t - b.t);

  if (!items.length) return '<div class="tl-empty">No scheduled events</div>';

  const parts = items.map(item =>
    item.type === 'event' ? renderTlEvent(item.e, isToday) : renderFreeBlock(item.from, item.to)
  );

  if (isToday) {
    const now = Date.now();
    let idx = items.findIndex(it => it.t > now);
    if (idx === -1) idx = items.length;
    parts.splice(idx, 0, NOW_LINE);
  }
  return `<div class="tl-events">${parts.join('')}</div>`;
}

// ─── Load Events ──────────────────────────────────────────────────
async function loadEvents() {
  _evRegistry = {};   // fresh render, drop the previous keys
  const events = await fetchRange(getDateKey(0), getDateKey(6));
  renderCountdown(events);

  const rsvp = events.filter(e => e.attendees?.some(a => a.self && a.responseStatus === 'needsAction'));
  renderRsvp(rsvp);

  // Group by date
  const byDate = {};
  for (const e of events) {
    const key = (e.start?.dateTime || e.start?.date || '').substring(0,10);
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(e);
  }

  const warnEl = document.getElementById('cal-warn');
  if (_calErrors.length) {
    warnEl.style.display = '';
    warnEl.innerHTML = `<strong>${_calErrors.length} of ${totalCalendars()} calendars failed to load</strong>`
      + _calErrors.map(m => `<div>${escape(m)}</div>`).join('');
  } else {
    warnEl.style.display = 'none';
  }

  // Timeline: today, tomorrow, day after
  const detailDays = [0,1,2].map(getDateKey);
  const detailEvents = detailDays.flatMap(d => byDate[d] || []);
  document.getElementById('event-count').textContent = detailEvents.length;

  document.getElementById('event-list').innerHTML = `
    <div class="timeline">
      ${detailDays.map((ymd, i) => `
        <div class="tl-day">
          <div class="tl-day-dot${i===0?'':' dim'}"></div>
          <h3 class="${i===0?'':'dim'}">${dayLabel(i)}</h3>
          ${renderDayRows(ymd, byDate[ymd] || [], i === 0)}
        </div>`).join('')}
    </div>`;

  // Week ahead (days 3–6)
  const weekDates = [3,4,5,6].map(getDateKey);
  const weekEvents = weekDates.flatMap(d => byDate[d] || []);
  document.getElementById('week-count').textContent = weekEvents.length + ' event' + (weekEvents.length !== 1 ? 's' : '');

  document.getElementById('week-list').innerHTML = `<div class="week-rows">${weekDates.map(ymd => {
    const dayEv = byDate[ymd] || [];
    const count = dayEv.length;
    const hasRsvp = dayEv.some(e => e.attendees?.some(a => a.self && a.responseStatus === 'needsAction'));
    const d = new Date(ymd + 'T12:00:00+08:00');
    const dow = d.toLocaleDateString('en-ID', { weekday:'short', timeZone: TZ });
    const dm  = d.toLocaleDateString('en-ID', { day:'numeric', month:'short', timeZone: TZ });
    return `
      <div class="week-row">
        <div class="week-when"><div class="week-dow">${dow}</div><div class="week-date">${dm}</div></div>
        <div class="week-card${count===0?' empty-day':''}">
          ${count === 0
            ? '<div class="week-none">Nothing scheduled</div>'
            : dayEv.map(e => `
                <div class="week-ev">
                  <span class="week-dot" style="background:${evColor(e)}"></span>
                  <span class="t">${escape(e.summary||'(No title)')}</span>
                </div>`).join('') + `
              <div class="week-foot">
                ${busynessBar(count)}
                <span class="week-n">${count} event${count>1?'s':''}</span>
                ${hasRsvp?'<span class="week-rsvp">RSVP</span>':''}
              </div>`
          }
        </div>
      </div>`;
  }).join('')}</div>`;

  // AI briefing (async, non-blocking)
  _briefArgs = [byDate[getDateKey(0)] || [], byDate[getDateKey(1)] || []];
  loadBriefing(..._briefArgs);
}

// ─── Month view ───────────────────────────────────────────────────
let monthCursor = new Date();        // tracks which month is shown (day-of-month irrelevant)
let monthCache  = { key: null, byDate: null };
let selectedDay = null;

function ymdLocal(y, m, d) {          // m is 0-indexed
  return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

// Compact = dots only; expanded = event titles in the cell, like Calendar.app.
const MONTH_VIEW_KEY = 'chris-dashboard-month-view';
const MAX_CHIPS = 4;
let monthView = localStorage.getItem(MONTH_VIEW_KEY) || 'compact';

function setMonthView(v) {
  monthView = v;
  localStorage.setItem(MONTH_VIEW_KEY, v);
  applyMonthViewUI();
  loadMonth();                       // served from cache, no refetch
}
function applyMonthViewUI() {
  document.querySelector('.month-modal').classList.toggle('expanded', monthView === 'expanded');
  document.querySelectorAll('#month-view-toggle button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === monthView));
}

// One event chip: all-day events get a solid bar, timed ones a coloured edge.
function monthChip(e) {
  const allDay = !e.start?.dateTime;
  const time = allDay ? '' : `<span class="mev-time">${formatTime(e.start.dateTime)}</span>`;
  return `<span class="mev${allDay ? ' allday' : ''}" style="--c:${evColor(e)}" title="${escape(e.summary || '(No title)')}">${time}${escape(e.summary || '(No title)')}</span>`;
}

// The header's segmented control is a real toggle now. "Today" used to be a <button> with
// no handler at all — it wore .active, sat next to a working "Month", and did nothing, which
// reads as "you are already on this view" rather than "this view does not exist". Month is a
// modal over this same page, so the pair is a real either/or: Today is the page itself.
function setNavActive(which) {
  document.getElementById('nav-today').classList.toggle('active', which === 'today');
  document.getElementById('nav-month').classList.toggle('active', which === 'month');
}

function goToday() {
  closeMonth();   // already puts the header back to "Today"
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openMonth() {
  monthCursor = new Date();
  selectedDay = null;
  document.getElementById('month-overlay').classList.add('open');
  document.getElementById('month-day-detail').style.display = 'none';
  setNavActive('month');
  applyMonthViewUI();
  renderMonthDow();
  loadMonth();
}
function closeMonth() {
  document.getElementById('month-overlay').classList.remove('open');
  setNavActive('today');
}
function shiftMonth(delta) {
  monthCursor.setMonth(monthCursor.getMonth() + delta);
  selectedDay = null;
  document.getElementById('month-day-detail').style.display = 'none';
  loadMonth();
}
function renderMonthDow() {
  const dows = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  document.getElementById('month-dow-row').innerHTML =
    dows.map(d => `<div class="month-dow">${d}</div>`).join('');
}

async function loadMonth() {
  const y = monthCursor.getFullYear();
  const m = monthCursor.getMonth(); // 0-indexed
  const monthKey = `${y}-${m}`;
  const label = monthCursor.toLocaleDateString('en-ID', { month:'long', year:'numeric', timeZone: TZ });
  document.getElementById('month-nav-label').textContent = label;

  const grid = document.getElementById('month-grid');
  grid.innerHTML = '<div class="loading month-loading"><span class="spinner"></span></div>';

  const lastDate = new Date(y, m + 1, 0).getDate();
  const startYmd = ymdLocal(y, m, 1);
  const endYmd   = ymdLocal(y, m, lastDate);

  let byDate;
  if (monthCache.key === monthKey) {
    byDate = monthCache.byDate;
  } else {
    const events = await fetchRange(startYmd, endYmd).catch(() => []);
    byDate = {};
    for (const e of events) {
      const key = (e.start?.dateTime || e.start?.date || '').substring(0,10);
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(e);
    }
    monthCache = { key: monthKey, byDate };
  }

  // Monday-first offset for first-of-month
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // 0 = Monday
  const todayYmd = getDateKey(0);

  let html = '';
  for (let i = 0; i < firstDow; i++) html += '<div class="month-cell empty"></div>';

  for (let d = 1; d <= lastDate; d++) {
    const ymd = ymdLocal(y, m, d);
    const dayEvents = byDate[ymd] || [];
    const isToday = ymd === todayYmd;
    const isPast = ymd < todayYmd;
    const inner = monthView === 'expanded'
      ? `<div class="month-events">${
          dayEvents.slice(0, MAX_CHIPS).map(monthChip).join('')
        }${
          dayEvents.length > MAX_CHIPS ? `<span class="mev-more">+${dayEvents.length - MAX_CHIPS} more</span>` : ''
        }</div>`
      : `<div class="month-dots">${dayEvents.slice(0, 6).map(e => `<span class="month-dot" style="background:${evColor(e)}"></span>`).join('')}</div>`;
    html += `
      <div class="month-cell${isToday?' today':''}${isPast?' past':''}${selectedDay===ymd?' selected':''}" onclick="selectDay('${ymd}')">
        <span class="dnum">${d}</span>
        ${inner}
      </div>`;
  }
  grid.innerHTML = html;

  if (selectedDay && byDate[selectedDay]) showDayDetail(selectedDay, byDate[selectedDay]);
}

function selectDay(ymd) {
  selectedDay = ymd;
  const dayEvents = monthCache.byDate?.[ymd] || [];
  loadMonth().then(() => showDayDetail(ymd, dayEvents));
}

function showDayDetail(ymd, dayEvents) {
  const panel = document.getElementById('month-day-detail');
  panel.style.display = '';
  document.getElementById('month-day-detail-title').textContent =
    new Date(ymd + 'T12:00:00+08:00').toLocaleDateString('en-ID', { weekday:'long', day:'numeric', month:'long', timeZone: TZ });
  const body = document.getElementById('month-day-detail-body');
  body.innerHTML = dayEvents.length
    ? `<div class="timeline"><div class="tl-events">${dayEvents.map(e => renderTlEvent(e, false)).join('')}</div></div>`
    : '<div class="empty" style="padding:8px 0">Nothing scheduled</div>';
}

// ─── To Do ────────────────────────────────────────────────────────
const TODO_KEY = 'chris-dashboard-todos-v1';

// Tasks live in tasks.json on the server, so they survive a browser change and
// can be added from outside the UI. localStorage is kept as an offline mirror.
let _todos = [];

function getTodos() { return _todos; }

function putTodos(todos) {
  _todos = todos;
  localStorage.setItem(TODO_KEY, JSON.stringify(todos));   // mirror
  // .catch() alone was not enough: it fires only when the request itself rejects, so a
  // 500 from the server resolved the promise, showed nothing, and left an optimistically
  // redrawn list that silently reverted on the next load. Checking res.ok is what makes a
  // failed write visible.
  fetch('/api/todos', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(todos),
  })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); })
    .catch(() => showToast('Could not save tasks to the server', null, 5));
}

// Pull the authoritative list. If the server has nothing yet, adopt whatever this
// browser still holds (first run after the move to server storage).
async function loadTodos() {
  let local = [];
  try { local = JSON.parse(localStorage.getItem(TODO_KEY)) || []; } catch {}
  try {
    const { todos } = await api('/api/todos');
    if (todos?.length) { _todos = todos; return; }
    if (local.length) putTodos(local); else _todos = [];
  } catch {
    _todos = local;   // server unreachable — fall back to the mirror
  }
}

function daysUntil(ymd) {
  if (!ymd) return null;
  const todayYmd = getDateKey(0);
  return Math.round((new Date(ymd + 'T12:00:00+08:00') - new Date(todayYmd + 'T12:00:00+08:00')) / 86400000);
}

// A local folder/file path rather than a URL, e.g. /Users/… or ~/Downloads
function isLocalPath(v = '') { return /^(~|\/)/.test(v.trim()); }

// Trailing spaces are legal in macOS filenames and Finder hides them, so a blanket
// .trim() silently breaks paths like "…/Day 5 ". Only URLs get trimmed both ends.
function cleanLink(v = '') {
  if (!v.trim()) return null;
  return isLocalPath(v)
    ? v.replace(/^\s+/, '').replace(/[\r\n\t]+$/, '')
    : v.trim();
}

// Native folder picker, run by the server — the browser cannot expose a real path.
async function pickFolder() {
  const btn = document.getElementById('browse-btn');
  const errEl = document.getElementById('todo-modal-err');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Choosing…';
  try {
    const r = await fetch('/api/pick-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'picker failed');
    if (d.path) {
      document.getElementById('todo-modal-link').value = d.path;
      errEl.textContent = '';
    }
  } catch (err) {
    errEl.textContent = 'Could not open the folder picker.';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="msym">folder_open</span> Browse';
  }
}

// Opening Finder has to go through the server; browsers block file:// from http://.
async function revealTodoPath(id) {
  const t = getTodos().find(x => x.id === id);
  if (!t?.link) return;
  try {
    const r = await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: t.link }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'could not open');
  } catch (err) {
    showToast(`Couldn't open folder — ${err.message}`, null, 5);
  }
}

function dueChip(ymd) {
  if (!ymd) return '';
  const days = daysUntil(ymd);
  const label = new Date(ymd + 'T12:00:00+08:00').toLocaleDateString('en-ID', { day:'numeric', month:'short', timeZone: TZ });
  const cls  = days < 0 ? 'overdue' : days <= 3 ? 'soon' : '';
  const icon = days < 0 ? 'warning' : 'event';
  const hint = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Due today' : `${days}d left`;
  return `<span class="due-chip ${cls}" title="${hint}"><span class="msym">${icon}</span> ${label}</span>`;
}

// ─── Task list: search, sort, snooze and completed ────────────────
// These are view settings — what you are looking at, not what the task is — so they live in
// localStorage beside the other display preferences. The three fields that do belong to the
// task itself (doneAt, priority, snoozeUntil) go to SQLite.
const TASK_VIEW_KEY = 'chris-dashboard-task-view-v1';
let _taskView = { q: '', sort: 'manual', showDone: false };
try { _taskView = { ..._taskView, ...(JSON.parse(localStorage.getItem(TASK_VIEW_KEY)) || {}) }; } catch {}
const saveTaskView = () => localStorage.setItem(TASK_VIEW_KEY, JSON.stringify(_taskView));

function onTodoSearch(v) { _taskView.q = v; saveTaskView(); renderTodos(); }
function onTodoSort(v)   { _taskView.sort = v; saveTaskView(); renderTodos(); }

// Snoozing hides a task until the day it names, and then it comes back on its own. That is
// the difference between snoozing something and losing it.
function isSnoozed(t) { return !!t.snoozeUntil && daysUntil(t.snoozeUntil) > 0; }

let _snoozeMenuFor = null;

function toggleSnoozeMenu(id, event) {
  if (event) event.stopPropagation();
  _snoozeMenuFor = _snoozeMenuFor === id ? null : id;
  renderTodos();
}

function snoozeTodo(id, days) {
  const todos = getTodos();
  const t = todos.find(x => x.id === id);
  if (!t) return;
  t.snoozeUntil = getDateKey(days);
  _snoozeMenuFor = null;
  putTodos(todos);
  renderTodos();
  showToast(`"${shortTitle(t.title)}" back on ${t.snoozeUntil}`, () => wakeTodo(id), 6);
}

function wakeTodo(id) {
  const todos = getTodos();
  const t = todos.find(x => x.id === id);
  if (!t) return;
  delete t.snoozeUntil;
  putTodos(todos);
  renderTodos();
}

function togglePriority(id) {
  const todos = getTodos();
  const t = todos.find(x => x.id === id);
  if (!t) return;
  t.priority = !t.priority;
  putTodos(todos);
  renderTodos();
}

const shortTitle = (s, n = 28) => (s.length > n ? s.slice(0, n) + '…' : s);

function toggleDoneSection() { _taskView.showDone = !_taskView.showDone; saveTaskView(); renderTodos(); }

let _clearTimer = null;

function clearCompleted() {
  const all  = getTodos();
  const done = all.filter(t => t.doneAt);
  if (!done.length) return;
  putTodos(all.filter(t => !t.doneAt));
  renderTodos();
  showToast(`Cleared ${done.length} completed`, () => {
    clearTimeout(_clearTimer);          // or it fires after the undo and deletes their events
    putTodos(all);                      // the captured array, so the original order comes back
    renderTodos();
  }, 10);
  // Clearing really is the end of the road for these, so their reminder events go too — but
  // only once the undo window has closed.
  clearTimeout(_clearTimer);
  _clearTimer = setTimeout(() => {
    done.forEach(t => t.calEventId && deleteCalendarEvent(t.calEventId, t.calAcct));
  }, 10000);
}

// "3 days ago" reads better than a timestamp for something you are scanning.
function doneAgo(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function sortTodos(list) {
  const flag = t => (t.priority ? 1 : 0);
  const byDeadline = (a, b) => (a.deadline || '9999-99-99').localeCompare(b.deadline || '9999-99-99');
  const copy = list.slice();
  // "By deadline" is taken literally and ignores flags — choosing it is asking for date order.
  if (_taskView.sort === 'deadline') return copy.sort(byDeadline);
  if (_taskView.sort === 'priority') return copy.sort((a, b) => flag(b) - flag(a) || byDeadline(a, b));
  // Manual keeps the stored order, with flagged tasks riding to the top: a flag that did not
  // move the task would be decoration rather than priority.
  return copy.sort((a, b) => flag(b) - flag(a));
}

function renderTodos() {
  const all     = getTodos();
  const open    = all.filter(t => !t.doneAt && !isSnoozed(t));
  const snoozed = all.filter(t => !t.doneAt && isSnoozed(t));
  const done    = all.filter(t => t.doneAt);

  document.getElementById('todo-count').textContent = open.length;
  renderDueStrip(open);

  const q = _taskView.q.trim().toLowerCase();
  const hit = t => !q || t.title.toLowerCase().includes(q) || (t.desc || '').toLowerCase().includes(q);
  const shown = sortTodos(open.filter(hit));

  const linkHtml = t => !t.link ? '' : `<div class="task-link">${
    isLocalPath(t.link)
      ? `<button class="link-btn" onclick="revealTodoPath('${t.id}')" title="${escape(t.link)}"><span class="msym">folder_open</span> Open folder</button>`
      : `<a href="${escape(t.link)}" target="_blank"><span class="msym">link</span> Open link</a>`
  }</div>`;

  const metaFor = (t, overdue) => {
    const days = daysUntil(t.deadline);
    const base = !t.deadline ? 'No deadline'
      : days === 0 ? 'Due today!'
      : days < 0   ? `Overdue by ${Math.abs(days)} day${Math.abs(days)>1?'s':''}`
      : `${days} day${days>1?'s':''} left`;
    return `${base}${t.calEventId?` · <span class="cal-tag">on calendar</span>`:''}`;
  };

  const item = t => {
    const days = daysUntil(t.deadline);
    const overdue = days !== null && days < 0;
    return `
    <div class="task-row${overdue?' urgent':''}${t.priority?' flagged':''}">
      <button class="task-check${overdue?' overdue':''}" onclick="toggleTodoDone('${t.id}')" title="Mark done"></button>
      <div class="task-main">
        <div class="task-title">${escape(t.title)}</div>
        <div class="task-meta">${metaFor(t, overdue)}</div>
        ${t.desc?`<div class="task-desc">${escape(t.desc)}</div>`:''}
        ${linkHtml(t)}
      </div>
      ${dueChip(t.deadline)}
      <div class="task-actions">
        <button class="flag-btn${t.priority?' on':''}" onclick="togglePriority('${t.id}')" title="${t.priority?'Not a priority':'Mark as priority'}"><span class="msym">${t.priority?'flag':'outlined_flag'}</span></button>
        <button onclick="toggleSnoozeMenu('${t.id}',event)" title="Snooze"><span class="msym">schedule</span></button>
        <button onclick="openEditModal('${t.id}')" title="Edit"><span class="msym">edit</span></button>
        <button onclick="removeTodo('${t.id}')" title="Remove"><span class="msym">close</span></button>
      </div>
    </div>
    ${_snoozeMenuFor === t.id ? `
    <div class="snooze-menu">
      <span class="snooze-label">Snooze until</span>
      <button onclick="snoozeTodo('${t.id}',1)">Tomorrow</button>
      <button onclick="snoozeTodo('${t.id}',3)">3 days</button>
      <button onclick="snoozeTodo('${t.id}',7)">Next week</button>
      <button class="snooze-cancel" onclick="toggleSnoozeMenu('${t.id}')">Cancel</button>
    </div>` : ''}`;
  };

  const snoozedItem = t => `
    <div class="task-row snoozed">
      <span class="msym snooze-icon">schedule</span>
      <div class="task-main">
        <div class="task-title">${escape(t.title)}</div>
        <div class="task-meta">Hidden until ${escape(t.snoozeUntil)} · ${daysUntil(t.snoozeUntil)} day${daysUntil(t.snoozeUntil)>1?'s':''}</div>
      </div>
      <div class="task-actions">
        <button onclick="wakeTodo('${t.id}')" title="Bring back now"><span class="msym">undo</span></button>
        <button onclick="removeTodo('${t.id}')" title="Remove"><span class="msym">close</span></button>
      </div>
    </div>`;

  const doneItem = t => `
    <div class="task-row completed">
      <button class="task-check checked" onclick="toggleTodoDone('${t.id}')" title="Reopen"></button>
      <div class="task-main">
        <div class="task-title">${escape(t.title)}</div>
        <div class="task-meta">Completed ${doneAgo(t.doneAt)}</div>
      </div>
      <div class="task-actions">
        <button onclick="removeTodo('${t.id}')" title="Delete"><span class="msym">close</span></button>
      </div>
    </div>`;

  const parts = [];
  if (shown.length) {
    parts.push(`<div class="task-list">${shown.map(item).join('')}</div>`);
  } else if (q) {
    // Naming the query is what stops an empty card reading as "you have no tasks".
    parts.push(`<div class="empty">Nothing matches “${escape(_taskView.q.trim())}”.</div>`);
  } else {
    parts.push('<div class="empty">No tasks 🎉</div>');
  }

  if (snoozed.length) {
    parts.push(`<div class="task-sub">Snoozed <span class="count-chip neutral">${snoozed.length}</span></div>
      <div class="task-list">${snoozed.map(snoozedItem).join('')}</div>`);
  }

  if (done.length) {
    parts.push(`
      <div class="task-sub task-sub-toggle" onclick="toggleDoneSection()">
        <span class="msym">${_taskView.showDone ? 'expand_less' : 'expand_more'}</span>
        Completed <span class="count-chip neutral">${done.length}</span>
        ${_taskView.showDone ? `<button class="text-btn" onclick="event.stopPropagation();clearCompleted()">Clear</button>` : ''}
      </div>
      ${_taskView.showDone ? `<div class="task-list done-list">${done.map(doneItem).join('')}</div>` : ''}`);
  }

  document.getElementById('todo-list').innerHTML = parts.join('');
}

// The one alert that works with no permission and no setup. The reminders below can only
// speak when the page is open anyway, so this is what actually stops a date being missed.
function renderDueStrip(open) {
  const el = document.getElementById('todo-due');
  if (!el) return;
  const overdue = open.filter(t => t.deadline && daysUntil(t.deadline) < 0).length;
  const today   = open.filter(t => t.deadline && daysUntil(t.deadline) === 0).length;
  el.innerHTML = (!overdue && !today) ? '' : `
    <div class="due-strip">
      ${overdue ? `<span class="due-flag overdue"><span class="msym">warning</span> ${overdue} overdue</span>` : ''}
      ${today   ? `<span class="due-flag today"><span class="msym">schedule</span> ${today} due today</span>` : ''}
    </div>`;
}

// ─── Course deadlines (read-only, from the campus feed) ───────────
// Campus only. Pulling in every Google calendar as well made this a second copy
// of the timetable — 418 of 509 rows were recurring class meetings that the
// schedule and week cards already draw.
const DEADLINE_DAYS = 365;

// Pinned deadlines, by event id. A display preference like the hidden-calendar
// set, so it lives beside it in localStorage rather than in tasks.db.
const DEADLINE_PIN_KEY = 'chris-dashboard-pinned-deadlines-v1';
let pinnedDeadlines = new Set();
try { pinnedDeadlines = new Set(JSON.parse(localStorage.getItem(DEADLINE_PIN_KEY)) || []); } catch {}

let _deadlines = [];      // as loaded
let _deadlineRows = [];   // sorted the way the DOM draws them, so an index in a
                          // handler always resolves to the row you clicked

async function loadDeadlines() {
  const items = [];
  for (const acct of moodleAccounts()) {
    const data = await api(`/api/moodle/events?start=${getDateKey(0)}&end=${getDateKey(DEADLINE_DAYS)}`);
    items.push(...(data.items || []).filter(e => isCalShown(acct.email, e._calId)));
  }
  const startOf = e => e.start?.dateTime || e.start?.date || '';
  return items.filter(e => startOf(e));
}

function deadlineRow(e, i) {
  const ymd = (e.start?.dateTime || e.start?.date || '').slice(0, 10);
  const days = daysUntil(ymd);
  const overdue = days !== null && days < 0;
  const isPinned = pinnedDeadlines.has(e.id);
  const left = days === null ? '' : overdue ? `Overdue by ${Math.abs(days)} day${Math.abs(days) > 1 ? 's' : ''}`
    : days === 0 ? 'Due today' : `${days} day${days > 1 ? 's' : ''} left`;
  return `
  <div class="task-row${overdue ? ' urgent' : ''}${isPinned ? ' pinned' : ''}">
    <div class="task-main">
      <div class="task-title">${escape(e.summary || '(No title)')}</div>
      <div class="task-meta course-meta">
        <span class="cal-swatch" style="background:${evColor(e)}"></span>
        <span>${escape(e._calName || '')}${left ? ' · ' + left : ''}</span>
      </div>
    </div>
    ${dueChip(ymd)}
    <div class="task-actions">
      <button onclick="toggleDeadlinePin(${i})" title="${isPinned ? 'Unpin' : 'Pin to top'}"
        ><span class="msym">${isPinned ? 'star' : 'star_border'}</span></button>
      <button onclick="addDeadlineToCalendar(${i})" title="Add to Google Calendar"
        ><span class="msym">calendar_add_on</span></button>
    </div>
  </div>`;
}

// Pinned first, then soonest. Sorting happens at draw time so a pin re-sorts
// without another round-trip.
function drawDeadlineRows() {
  const list = document.getElementById('deadline-list');
  _deadlineRows = _deadlines.slice().sort((a, b) => {
    const pa = pinnedDeadlines.has(a.id) ? 0 : 1, pb = pinnedDeadlines.has(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const sa = a.start?.dateTime || a.start?.date || '', sb = b.start?.dateTime || b.start?.date || '';
    return sa.localeCompare(sb);
  });
  list.innerHTML = _deadlineRows.length
    ? `<div class="task-list">${_deadlineRows.map(deadlineRow).join('')}</div>`
    : '<div class="empty">Nothing due from your courses.</div>';
}

function toggleDeadlinePin(i) {
  const e = _deadlineRows[i];
  if (!e) return;
  pinnedDeadlines.has(e.id) ? pinnedDeadlines.delete(e.id) : pinnedDeadlines.add(e.id);
  localStorage.setItem(DEADLINE_PIN_KEY, JSON.stringify([...pinnedDeadlines]));
  drawDeadlineRows();
}

// Reuses the same write the todo modal uses, including the undo path, so a
// mis-click never leaves a stray event behind.
async function addDeadlineToCalendar(i) {
  const e = _deadlineRows[i];
  if (!e) return;
  const ymd = (e.start?.dateTime || e.start?.date || '').slice(0, 10);
  const name = e.summary || 'Course deadline';
  const short = name.length > 28 ? name.slice(0, 28) + '…' : name;
  try {
    const { id, acct } = await createDeadlineEvent(name, ymd);
    showToast(`Added "${short}" to your calendar`, () => {
      deleteCalendarEvent(id, acct);
      showToast('Removed from calendar', null, 4);
    }, 8);
  } catch (err) {
    showToast(`Couldn't add to calendar — ${err.message}`, null, 6);
  }
}

async function renderDeadlines() {
  const list = document.getElementById('deadline-list');
  const count = document.getElementById('deadline-count');
  if (!moodleAccounts().length) {
    count.textContent = '0';
    list.innerHTML = '<div class="empty">No campus calendar connected.</div>';
    return;
  }
  try {
    _deadlines = await loadDeadlines();
    count.textContent = _deadlines.length;
    drawDeadlineRows();
  } catch (err) {
    count.textContent = '!';
    list.innerHTML = `<div class="error">Could not load deadlines: ${escape(err.message)}</div>`;
  }
}

// Completing a task keeps it. It used to delete it outright, which is exactly why nothing
// could ever be shown as completed afterwards — the record was gone. This also marks it done
// rather than throwing it away, so the checkbox reopens.
//
// The linked calendar event is deliberately left alone: ticking a checkbox should not quietly
// delete something off your calendar. Deleting the task still cleans the event up, which is
// where that was always meant to happen.
function toggleTodoDone(id) {
  const todos = getTodos();
  const t = todos.find(x => x.id === id);
  if (!t) return;
  const wasDone = !!t.doneAt;
  t.doneAt = wasDone ? null : new Date().toISOString();
  putTodos(todos);
  renderTodos();
  showToast(`"${shortTitle(t.title)}" ${wasDone ? 'reopened' : 'completed'}`,
    () => toggleTodoDone(id), 6);
}

let _undoStack = null;
let _undoTimer = null;

function removeTodo(id, verb = 'removed') {
  const todos = getTodos();
  const idx = todos.findIndex(x => x.id === id);
  if (idx === -1) return;
  const t = todos[idx];

  todos.splice(idx, 1);
  putTodos(todos);
  renderTodos();

  // Save for undo
  _undoStack = { todo: t, index: idx };
  showToast(`"${t.title.length > 28 ? t.title.slice(0,28)+'…' : t.title}" ${verb}`, undoRemove, 10);

  // After the undo window, commit the deletion (delete cal event if any)
  const myToast = _toastSeq;
  clearTimeout(_undoTimer);
  _undoTimer = setTimeout(() => {
    if (_undoStack?.todo?.calEventId) {
      deleteCalendarEvent(_undoStack.todo.calEventId, _undoStack.todo.calAcct);
    }
    _undoStack = null;
    if (_toastSeq === myToast) hideToast();   // a newer toast owns the bar by now
  }, 10000);
}

function undoRemove() {
  if (!_undoStack) return;
  clearTimeout(_undoTimer);
  const todos = getTodos();
  todos.splice(_undoStack.index, 0, _undoStack.todo);
  putTodos(todos);
  renderTodos();
  _undoStack = null;
  hideToast();
}

let _toastUndoFn = null;
function handleToastUndo() { if (_toastUndoFn) _toastUndoFn(); }

// Bumped by every toast so a delayed timer can tell whether the bar it meant to clear is
// still the one on screen. With several actions now raising toasts, a stale 10s timer hiding
// a newer message (and its Undo) stopped being hypothetical.
let _toastSeq = 0;

function showToast(msg, undoFn, sec = 10) {
  _toastSeq++;
  _toastUndoFn = undoFn;
  document.getElementById('toast-msg').textContent = msg;
  // Plain notices (errors) get no Undo button — it would do nothing.
  document.querySelector('.toast-undo').style.display = undoFn ? '' : 'none';
  const bar = document.getElementById('toast-bar');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  document.getElementById('toast').classList.add('show');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = `width ${sec}s linear`;
    bar.style.width = '0%';
  }));
}
function hideToast() {
  document.getElementById('toast').classList.remove('show');
  _toastUndoFn = null;
}

// ─── Add / Edit Todo Modal ─────────────────────────────────────────
let _saving = false;
let _editingId = null;

function _openModal(heading, saveLabel, title='', desc='', link='', deadline='', calChecked=false) {
  _saving = false;
  document.getElementById('todo-modal-heading').textContent  = heading;
  document.getElementById('todo-modal-title').value          = title;
  document.getElementById('todo-modal-desc').value           = desc || '';
  document.getElementById('todo-modal-link').value           = link || '';
  document.getElementById('todo-modal-deadline').value       = deadline || '';
  document.getElementById('todo-modal-cal').checked          = calChecked;
  document.getElementById('todo-modal-err').textContent      = '';
  document.getElementById('todo-save-btn').textContent       = saveLabel;
  document.getElementById('todo-overlay').classList.add('open');
  setTimeout(() => document.getElementById('todo-modal-title').focus(), 80);
}

function openTodoModal() {
  _editingId = null;
  _openModal('New Task', 'Save Task');
}

function openEditModal(id) {
  const t = getTodos().find(x => x.id === id);
  if (!t) return;
  _editingId = id;
  _openModal('Edit Task', 'Update Task', t.title, t.desc, t.link, t.deadline, !!t.calEventId);
}

function closeTodoModal() {
  document.getElementById('todo-overlay').classList.remove('open');
  _saving = false;
  _editingId = null;
}

async function saveTodo() {
  if (_saving) return;
  const title    = document.getElementById('todo-modal-title').value.trim();
  const desc     = document.getElementById('todo-modal-desc').value.trim() || null;
  const link     = cleanLink(document.getElementById('todo-modal-link').value);
  const deadline = document.getElementById('todo-modal-deadline').value || null;
  const addCal   = document.getElementById('todo-modal-cal').checked && !!deadline;
  const errEl    = document.getElementById('todo-modal-err');
  const btn      = document.getElementById('todo-save-btn');

  if (!title) { errEl.textContent = 'Please enter a task title.'; return; }
  errEl.textContent = '';
  _saving = true;
  btn.textContent = 'Saving…';

  const todos = getTodos();

  if (_editingId) {
    // ── Edit existing ──
    const t = todos.find(x => x.id === _editingId);
    if (t) {
      t.title    = title;
      t.desc     = desc;
      t.link     = link;
      t.deadline = deadline;
      // If cal was checked but no event yet, create one
      if (addCal && !t.calEventId && deadline) {
        try {
          const ev = await createDeadlineEvent(title, deadline);
          t.calEventId = ev.id;
          t.calAcct = ev.acct;
        } catch(e) { errEl.textContent = 'Calendar error — other changes saved.'; }
      }
    }
    putTodos(todos);
    renderTodos();
    closeTodoModal();
    return;
  }

  // ── Add new ──
  let calEventId = null, calAcct = null;
  if (addCal) {
    try {
      const ev = await createDeadlineEvent(title, deadline);
      calEventId = ev.id;
      calAcct = ev.acct;
    } catch(e) { errEl.textContent = 'Calendar error — task saved without it.'; }
  }

  todos.push({ id: Date.now().toString(), title, desc, link, deadline, calEventId, calAcct, done: false });
  putTodos(todos);
  renderTodos();
  closeTodoModal();
}

// ─── Loading states ───────────────────────────────────────────────
function setLoading() {
  ['event-count','week-count'].forEach(id => document.getElementById(id).innerHTML='<span class="spinner"></span>');
  ['event-list','week-list'].forEach(id => document.getElementById(id).innerHTML='<div class="loading"><span class="spinner"></span></div>');
  document.getElementById('rsvp-card').style.display='none';
  document.getElementById('cd-days').innerHTML='<span class="spinner"></span>';
  document.getElementById('cd-name').textContent='–';
  document.getElementById('cd-sub').textContent='–';
  // Only show the spinner when a briefing will actually be generated; a cached
  // one for today stays on screen untouched.
  if (!briefingCachedToday()) {
    document.getElementById('briefing-text').innerHTML='<span class="spinner"></span> Generating briefing…';
  }
  document.querySelectorAll('.reload-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
}

function setDone() {
  document.getElementById('refreshed-at').textContent =
    new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:TZ});
  document.querySelectorAll('.reload-btn').forEach(b => { b.disabled = false; b.style.opacity = '1'; });
}

// ─── Reload ───────────────────────────────────────────────────────
async function reload() {
  if (!accounts.length) {
    showDisconnected();
    // Campus is a separate feed with its own empty state, so it renders either way.
    renderDeadlines();
    return;
  }
  setLoading();
  await Promise.allSettled([
    // Picks up tasks added from outside the UI (e.g. an agent posting to /api/todos)
    loadTodos().then(renderTodos),
    loadEvents().catch(err => {
      document.getElementById('event-list').innerHTML=`<div class="error">Could not load events: ${escape(err.message)}</div>`;
      document.getElementById('event-count').textContent='!';
    }),
    renderDeadlines(),   // handles its own errors, so one bad feed can't sink the rest
  ]);
  setDone();
}

// ─── Due reminders ────────────────────────────────────────────────
// Opt-in, and deliberately so: the permission prompt is the consent, so nothing here can
// start firing banners at you without a click. An unasked-for notification is the quickest
// way to get every notification switched off.
const REMIND_KEY  = 'chris-dashboard-reminders-v1';
const REMINDED_KEY = 'chris-dashboard-reminded-v1';
const remindersSupported = () => typeof Notification !== 'undefined';
const remindersMuted = () => localStorage.getItem(REMIND_KEY) === 'off';
const remindersOn = () => remindersSupported() && Notification.permission === 'granted' && !remindersMuted();

let _reminded = {};
try { _reminded = JSON.parse(localStorage.getItem(REMINDED_KEY)) || {}; } catch {}

function paintReminderBtn() {
  const btn = document.getElementById('reminder-btn');
  if (!btn) return;
  const on = remindersOn();
  btn.classList.toggle('on', on);
  btn.querySelector('.msym').textContent = on ? 'notifications_active' : 'notifications_none';
  btn.title = !remindersSupported() ? 'This browser cannot show notifications'
    : on ? 'Reminders on — click to mute'
    : 'Remind me about tasks that are due';
}

async function toggleReminders() {
  if (!remindersSupported()) { showToast('This browser cannot show notifications', null, 5); return; }
  if (remindersOn()) {
    // Muting only stops this page reminding. The permission itself belongs to the browser,
    // so pretending we can hand it back would be a lie.
    localStorage.setItem(REMIND_KEY, 'off');
    paintReminderBtn();
    showToast('Reminders muted', null, 4);
    return;
  }
  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { showToast('Reminders need notification permission', null, 5); return; }
  }
  localStorage.setItem(REMIND_KEY, 'on');
  paintReminderBtn();
  showToast('Reminders on — you will hear about tasks due today', null, 4);
  checkDueReminders();
}

// At most one notification per task per day. The marker is a date rather than a flag so that
// a task still sitting overdue tomorrow nudges again, which is the whole point of it.
function checkDueReminders() {
  if (!remindersOn()) return;
  const today = getDateKey(0);
  const due = getTodos().filter(t => !t.doneAt && t.deadline && !isSnoozed(t) && daysUntil(t.deadline) <= 0);
  const fresh = due.filter(t => _reminded[t.id] !== today);
  if (!fresh.length) return;

  const next = {};
  due.forEach(t => { next[t.id] = today; });
  _reminded = next;                      // rebuilt from today's due list, so it cannot grow forever
  localStorage.setItem(REMINDED_KEY, JSON.stringify(_reminded));

  const lines = fresh.map(t => `${daysUntil(t.deadline) < 0 ? 'Overdue' : 'Due today'}: ${t.title}`);
  try {
    new Notification(fresh.length === 1 ? 'A task needs you' : `${fresh.length} tasks need you`,
      { body: lines.slice(0, 5).join('\n'), tag: 'attention-dashboard-' + today });
  } catch { /* some platforms refuse construction outright — the due strip still shows it */ }
}

// ─── Find a time (Google free/busy) ───────────────────────────────
// freeBusy is the only way to see anyone else's calendar, and it is narrow by design: busy
// intervals and nothing else — no titles, no locations — and only for calendars shared with
// this account or made public. Someone who has shared nothing comes back with an empty busy
// list, which is indistinguishable from a free day, so the panel says so rather than drawing
// a confident empty week.
const AVAIL_KEY = 'chris-dashboard-avail-people-v1';
let _availPeople = [];
try { _availPeople = JSON.parse(localStorage.getItem(AVAIL_KEY)) || []; } catch {}
const saveAvailPeople = () => localStorage.setItem(AVAIL_KEY, JSON.stringify(_availPeople));

const DAY_START = 8, DAY_END = 22;   // the window worth planning in, not the whole 24h

function openAvailability() {
  document.getElementById('avail-overlay').classList.add('open');
  renderAvailPeople();
  if (_availPeople.length) loadAvailability();
}

function closeAvailability() {
  document.getElementById('avail-overlay').classList.remove('open');
}

function addAvailPerson() {
  const el = document.getElementById('avail-email');
  const email = el.value.trim();
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('That does not look like an email address', null, 5);
    return;
  }
  if (!_availPeople.includes(email)) { _availPeople.push(email); saveAvailPeople(); }
  el.value = '';
  renderAvailPeople();
  loadAvailability();
}

// By index, not by address: an address can legally contain a quote, which would break out of
// the onclick attribute it was being interpolated into.
function removeAvailPerson(i) {
  _availPeople.splice(i, 1);
  saveAvailPeople();
  renderAvailPeople();
  if (_availPeople.length) loadAvailability();
  else setAvailResults('<div class="empty">Add someone to compare calendars.</div>');
}

function renderAvailPeople() {
  document.getElementById('avail-people').innerHTML = _availPeople.map((e, i) => `
    <span class="avail-chip">${escape(e)}
      <button onclick="removeAvailPerson(${i})" title="Remove"><span class="msym">close</span></button>
    </span>`).join('');
}

const setAvailResults = html => { document.getElementById('avail-results').innerHTML = html; };

async function loadAvailability() {
  if (!_availPeople.length) return;
  const days = Number(document.getElementById('avail-days').value);
  const mins = Number(document.getElementById('avail-mins').value);
  setAvailResults('<div class="loading"><span class="spinner"></span></div>');
  try {
    if (!googleAccounts().length) throw new Error('no Google account is connected');
    const timeMin = new Date(getDateKey(0) + 'T00:00:00+08:00').toISOString();
    const timeMax = new Date(getDateKey(days) + 'T23:59:59+08:00').toISOString();
    // 'primary' is this account's own calendar, so the answer accounts for you as well —
    // otherwise the "free" slots would be free only for everyone else.
    const items = [{ id: 'primary' }, ..._availPeople.map(id => ({ id }))];
    const r = await gcal('/freeBusy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin, timeMax, items }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    renderAvail(await r.json(), days, mins);
  } catch (err) {
    setAvailResults(`<div class="error">Could not check calendars: ${escape(err.message)}</div>`);
  }
}

const hm = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });

function renderAvail(data, days, mins) {
  const cals = data.calendars || {};
  // Google reports an unreadable calendar as an error entry rather than an empty day, so a
  // typo or an unshared calendar can be named instead of silently reading as "free".
  const failed = Object.entries(cals)
    .filter(([, c]) => (c.errors || []).length)
    .map(([id]) => (id === 'primary' ? 'your own calendar' : id));

  const busy = [];
  for (const c of Object.values(cals)) {
    for (const b of (c.busy || [])) busy.push([new Date(b.start), new Date(b.end)]);
  }

  const rows = [];
  for (let i = 0; i < days; i++) {
    const ymd = getDateKey(i);
    const wStart = new Date(ymd + `T${String(DAY_START).padStart(2,'0')}:00:00+08:00`);
    const wEnd   = new Date(ymd + `T${String(DAY_END).padStart(2,'0')}:00:00+08:00`);

    const blocks = busy
      .filter(([s, e]) => e > wStart && s < wEnd)
      .map(([s, e]) => [new Date(Math.max(s, wStart)), new Date(Math.min(e, wEnd))])
      .sort((a, b) => a[0] - b[0]);

    // Merge overlapping blocks first: two people busy 09:00–10:00 and 09:30–11:00 are busy
    // 09:00–11:00 between them, and treating those as separate would invent a free gap.
    const merged = [];
    for (const b of blocks) {
      const last = merged[merged.length - 1];
      if (last && b[0] <= last[1]) last[1] = new Date(Math.max(last[1], b[1]));
      else merged.push([b[0], b[1]]);
    }

    const gaps = [];
    let cursor = wStart;
    for (const [s, e] of merged) {
      if (s - cursor >= mins * 60000) gaps.push([cursor, s]);
      cursor = new Date(Math.max(cursor, e));
    }
    if (wEnd - cursor >= mins * 60000) gaps.push([cursor, wEnd]);

    rows.push({ ymd, merged, gaps, wStart, wEnd });
  }

  const pct = (wStart, wEnd, d) => ((d - wStart) / (wEnd - wStart)) * 100;
  const dayLabel = ymd => new Date(ymd + 'T12:00:00+08:00')
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });

  const html = rows.map(r => {
    const bars = r.merged.map(([s, e]) =>
      `<span class="avail-busy" style="left:${pct(r.wStart, r.wEnd, s)}%;width:${pct(r.wStart, r.wEnd, e) - pct(r.wStart, r.wEnd, s)}%"></span>`).join('');
    const best = r.gaps[0];
    const bestBar = best
      ? `<span class="avail-best" style="left:${pct(r.wStart, r.wEnd, best[0])}%;width:${pct(r.wStart, r.wEnd, best[1]) - pct(r.wStart, r.wEnd, best[0])}%"></span>` : '';
    const slots = r.gaps.length
      ? r.gaps.slice(0, 3).map(([s, e]) => `<span class="avail-slot">${hm(s)}–${hm(e)}</span>`).join('')
      : '<span class="avail-none">No gap that long</span>';
    return `
      <div class="avail-day">
        <div class="avail-day-head"><span>${dayLabel(r.ymd)}</span>${r.gaps.length ? `<span class="avail-count">${r.gaps.length} gap${r.gaps.length>1?'s':''}</span>` : ''}</div>
        <div class="avail-track" title="Busy between ${DAY_START}:00 and ${DAY_END}:00">${bars}${bestBar}</div>
        <div class="avail-slots">${slots}</div>
      </div>`;
  }).join('');

  const legend = `
    <div class="avail-legend">
      <span><i class="avail-swatch busy"></i> busy</span>
      <span><i class="avail-swatch best"></i> best gap</span>
      <span class="avail-window">${DAY_START}:00–${DAY_END}:00</span>
    </div>`;

  setAvailResults(
    (failed.length ? `<div class="avail-warn"><span class="msym">warning</span>
      Not shared with you, so treated as free: ${failed.map(escape).join(', ')}.</div>` : '')
    + legend + `<div class="avail-days">${html}</div>`);
}

// ─── Init ─────────────────────────────────────────────────────────
setGreeting();
startClock();
updateDayProgress();
setInterval(updateDayProgress, 60000);
loadTodos().then(renderTodos);
restoreAccounts();

// Reflect what was stored last visit into the controls, and start the reminder loop. Set
// once here rather than inside renderTodos — writing to a focused input on every keystroke
// would fight the caret.
document.getElementById('todo-search').value = _taskView.q;
document.getElementById('todo-sort').value = _taskView.sort;
if (_taskView.q) document.getElementById('todo-search').focus();
paintReminderBtn();
checkDueReminders();
setInterval(checkDueReminders, 5 * 60 * 1000);
