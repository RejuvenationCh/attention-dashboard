// Saved preferences were stored under "chris-dashboard-*" before 1.5. Copy each to its new
// "attention-*" name once, before anything below reads them, so nobody loses their setup.
try {
  const old = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('chris-dashboard-')) old.push(k);
  }
  for (const k of old) {
    const renamed = 'attention-' + k.slice('chris-dashboard-'.length);
    if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(k));
  }
} catch { /* storage blocked: nothing to migrate */ }

// The machine's own zone: one dashboard per person, so where it runs is where they are.
// A date-time string with no offset ("2026-09-15T12:00:00") parses as local time in this zone.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TZ_LABEL = { 'Asia/Jakarta': 'WIB', 'Asia/Pontianak': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' }[TZ]
  || new Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts().find(p => p.type === 'timeZoneName').value;
// OAuth now lives entirely on the server (see server.js); credentials are in .env.

// Google auth: multi-account, server-held refresh tokens
// The server owns the long-lived refresh token per account and mints short-lived
// access tokens on demand, so this page never has to prompt for sign-in again.
// Google accounts carry an access token and are fetched from this page. The
// Moodle one has no token at all (the server owns that feed and its authtoken),
// so anything that calls Google has to filter these apart.
let accounts = [];        // [{ email, name?, source?, token?, exp, calendars: [{ id, name, color }] }]
const googleAccounts = () => accounts.filter(a => a.source !== 'moodle');
const moodleAccounts = () => accounts.filter(a => a.source === 'moodle');

// Falls back to a Google account: only those can be written to or RSVP'd.
function acctOf(email) { return accounts.find(a => a.email === email) || googleAccounts()[0]; }

// Which calendars are shown
// Keyed by account + calendar, so the same shared calendar can be visible under
// one account and hidden under the other (that is the usual source of duplicates).
// Only hidden ones are stored, so newly added calendars default to visible.
const CAL_HIDDEN_KEY = 'attention-hidden-calendars-v1';
let hiddenCals = new Set();
try { hiddenCals = new Set(JSON.parse(localStorage.getItem(CAL_HIDDEN_KEY)) || []); } catch {}

const calKey = (email, calId) => `${email}::${calId}`;

// A type per Google calendar (Class, Work, ...), set in the Accounts card and used to filter
// Search Calendar. A display preference like the hidden set, so it lives in localStorage.
// eLearn courses get none: they are all courses, so a tag on each would say nothing.
const CAL_TYPES = ['Class', 'Work', 'Personal', 'Family', 'Other'];
const CAL_TYPE_KEY = 'attention-calendar-types-v1';
let calTypes = {};
try { calTypes = JSON.parse(localStorage.getItem(CAL_TYPE_KEY)) || {}; } catch {}
const calTypeOf = (email, calId) =>
  String(calId).startsWith('moodle:') ? '' : calTypes[calKey(email, calId)] || '';
function setCalType(ai, ci, type) {
  const a = accounts[ai], c = a.calendars[ci];
  calTypes[calKey(a.email, c.id)] = type;
  try { localStorage.setItem(CAL_TYPE_KEY, JSON.stringify(calTypes)); } catch {}
  renderAccounts();
  renderUpcoming();
}
const calTypeSelect = (a, c, ai, ci) => {
  const t = calTypeOf(a.email, c.id);
  return `<select class="cal-type${t ? '' : ' unset'}" title="Calendar type" onchange="setCalType(${ai}, ${ci}, this.value)">
    <option value=""${t ? '' : ' selected'}>${t ? 'No type' : '+ Type'}</option>
    ${CAL_TYPES.map(x => `<option${x === t ? ' selected' : ''}>${x}</option>`).join('')}
  </select>`;
};

// Calendars that do not block your time (a deadline calendar is a list of dates, not meetings).
// Display state like the hidden set, so it lives in localStorage too.
const CAL_FREE_KEY = 'attention-nonbusy-calendars-v1';
let freeCals = new Set();
try { freeCals = new Set(JSON.parse(localStorage.getItem(CAL_FREE_KEY)) || []); } catch {}
const blocksTime = (email, calId) => !freeCals.has(calKey(email, calId));

function toggleCalBusy(ai, ci) {
  const acct = accounts[ai], cal = acct.calendars[ci];
  const k = calKey(acct.email, cal.id);
  freeCals.has(k) ? freeCals.delete(k) : freeCals.add(k);
  localStorage.setItem(CAL_FREE_KEY, JSON.stringify([...freeCals]));
  renderAccounts();
  loadEvents();   // the free blocks are what this changes
}
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
  // Rebuilt from scratch: this also runs again after the eLearn link changes in Settings,
  // and appending to the old list showed every account twice.
  accounts = [];
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
      .map(c => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor, access: c.accessRole })),
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
        ? 'Signed out. Reconnect your Google account in Accounts'
        : 'Connect Google Calendar to see your schedule here'}</div>`);
  // Search Calendar has its own list; left alone it spins forever with nothing to load.
  _upcoming = [];
  document.getElementById('upcoming-count').textContent = '–';
  document.getElementById('upcoming-cal-btn').hidden = true;
  document.getElementById('upcoming-list').innerHTML = `<div class="empty">${
    failedAccounts.length ? 'Signed out. Reconnect your Google account in Accounts' : 'Connect Google Calendar to search it here'}</div>`;
  document.getElementById('cd-days').textContent = '–';
  document.getElementById('cd-name').textContent = 'No calendar yet';
  document.getElementById('cd-sub').textContent = '–';
}

function renderAccounts() {
  _accountsLoaded = true;
  renderWelcome();
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
            ${isMoodle ? '' : calTypeSelect(a, c, ai, ci)}
            ${isMoodle && c.id !== 'moodle:other' ? `<button class="cal-rename" title="Rename" onclick="event.preventDefault(); renameCourse(${ai}, ${ci})"><span class="msym">edit</span></button>` : ''}
            <button class="cal-busy${blocksTime(a.email, c.id) ? '' : ' off'}" onclick="event.preventDefault(); toggleCalBusy(${ai}, ${ci})"
              title="${blocksTime(a.email, c.id) ? 'Blocks your free time. Click to ignore' : 'Ignored when working out free time'}"
              ><span class="msym">${blocksTime(a.email, c.id) ? 'event_busy' : 'event_available'}</span></button>
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
          <div class="acct-meta">Signed out, so its calendars are not loading</div>
        </div>
        <button class="acct-reconnect" onclick="addAccount()">Reconnect</button>
      </div>
    </div>`).join('')
  // Moodle alone still needs a way to add Google; the empty state above only
  // covers having no accounts at all. A failed account shows its own button.
  + (googleAccounts().length || failedAccounts.length ? '' :
    `<button class="btn-primary acct-add" onclick="addAccount()">Connect Google Calendar</button>`);
}

// Moodle only gives course codes, so names live in courses.json on the server.
async function renameCourse(ai, ci) {
  const c = accounts[ai].calendars[ci];
  const name = prompt(`Name for ${c.id.replace(/^moodle:/, '')}`, c.name)?.trim();
  if (!name || name === c.name) return;
  try {
    await api('/api/course-name', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id, name }),
    });
  } catch (err) { showToast(`Could not rename: ${err.message}`, null, 5); return; }
  c.name = name;
  renderAccounts();
  reload();   // events carry the course name too
}

// Utilities
// Every clock time on the page goes through here, so Settings → Appearance → Clock reaches all.
const clockOpts = (seconds = false) => window.appearance.read().clock === '12'
  ? { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: true, timeZone: TZ }
  : { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false, timeZone: TZ };
const clockTime = (d, seconds) => new Date(d).toLocaleTimeString(window.appearance.read().clock === '12' ? 'en-US' : 'en-GB', clockOpts(seconds));
function formatTime(dt) {
  if (!dt) return 'All day';
  return clockTime(dt);
}
// The schedule's narrow time column: "6pm", "7:30am" in 12-hour mode, as usual in 24-hour.
function clockShort(dt) {
  if (window.appearance.read().clock !== '12') return clockTime(dt);
  const d = new Date(dt), h = Number(d.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }));
  const m = d.toLocaleString('en-GB', { minute: '2-digit', timeZone: TZ }).padStart(2, '0');
  return `${h % 12 || 12}${m === '00' ? '' : ':' + m}${h < 12 ? 'am' : 'pm'}`;
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
  return new Date(ymd + 'T12:00:00').toLocaleDateString('en-ID', { weekday:'short', day:'numeric', month:'short', timeZone: TZ });
}

// Greeting + date header
function setGreeting() {
  const h = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }));
  const part = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
  document.getElementById('greet-line').textContent = `Good ${part}${_profile.name ? ', ' + _profile.name : ''}.`;
}

// Per-install profile and platform
// Both live on the server: the name and eLearn URL in config.json, what the OS can do in platform.js.
let _profile = { name: '', moodle: false };
let _platform = { canPickFolder: true, notifyHint: '' };
async function loadProfile() {
  [_profile, _platform] = await Promise.all([api('/api/config'), api('/api/platform')]).catch(() => [_profile, _platform]);
  document.body.classList.toggle('no-picker', !_platform.canPickFolder);
  _profileLoaded = true;
  setGreeting();
  renderWelcome();
  renderWhatsNew();
}
async function saveProfile(change) {
  try {
    _profile = await api('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
  } catch (err) { showToast(`Could not save: ${err.message}`, null, 6); return; }
  setGreeting();
  paintProfile();
  renderWelcome();
  if ('moodleUrl' in change) restoreAccounts();   // the eLearn calendars appear or vanish
}

// Get started: the three things a new install needs, ticked off as they happen. Waits for both
// the profile and the accounts to load, so a set-up dashboard never flashes it.
const WELCOME_KEY = 'attention-welcome-dismissed-v1';
let _profileLoaded = false, _accountsLoaded = false;
function renderWelcome() {
  const card = document.getElementById('welcome-card');
  let dismissed = false;
  try { dismissed = localStorage.getItem(WELCOME_KEY) === '1'; } catch {}
  const steps = [
    { done: googleAccounts().length > 0 || failedAccounts.length > 0, title: 'Connect Google Calendar',
      hint: 'Your events and free time, and reminders for deadlines.', action: 'addAccount()', label: 'Connect' },
    { done: !!_profile.name, title: 'Add your name', hint: 'For the greeting.',
      action: "openSettingsAt('settings-name')", label: 'Add' },
    { done: !!_profile.moodle, title: 'Add your eLearn calendar (optional)', hint: 'Course deadlines, soonest first.',
      action: "openSettingsAt('settings-moodle')", label: 'Add' },
  ];
  card.hidden = dismissed || !_profileLoaded || !_accountsLoaded || steps.every(s => s.done);
  if (card.hidden) return;
  card.innerHTML = `
    <div class="welcome-head">
      <h2 class="card-h2">Get started</h2>
      <button class="icon-btn" onclick="dismissWelcome()" title="Hide"><span class="msym">close</span></button>
    </div>
    ${steps.map(s => `
      <div class="welcome-step${s.done ? ' done' : ''}">
        <span class="msym">${s.done ? 'check_circle' : 'radio_button_unchecked'}</span>
        <div class="welcome-text"><div class="welcome-title">${s.title}</div><div class="welcome-hint">${s.hint}</div></div>
        ${s.done ? '' : `<button class="todo-btn todo-btn-primary" onclick="${s.action}">${s.label}</button>`}
      </div>`).join('')}`;
}
function dismissWelcome() {
  try { localStorage.setItem(WELCOME_KEY, '1'); } catch {}
  renderWelcome();
}
function openSettingsAt(id) {
  openSettings();
  const el = document.getElementById(id);
  el.scrollIntoView({ block: 'center' });
  el.focus();
}
// Settings → Appearance. appearance.js applies it; this only mirrors it into the controls.
function paintAppearance() {
  const a = window.appearance.read();
  document.getElementById('settings-theme').value = a.theme;
  document.getElementById('settings-accent').value = a.accent;
  document.getElementById('settings-reduce').checked = !!a.reduce;
  document.getElementById('settings-size').value = String(a.size);
  document.getElementById('settings-compact').checked = !!a.compact;
  document.getElementById('settings-clock').value = a.clock;
  document.querySelectorAll('[data-card]').forEach(c => { c.checked = !(a.hide || []).includes(c.dataset.card); });
}
function appearanceChanged() {
  const clockWas = window.appearance.read().clock;
  window.appearance.save({
    theme: document.getElementById('settings-theme').value,
    accent: document.getElementById('settings-accent').value,
    reduce: document.getElementById('settings-reduce').checked,
    size: document.getElementById('settings-size').value,
    compact: document.getElementById('settings-compact').checked,
    clock: document.getElementById('settings-clock').value,
    hide: [...document.querySelectorAll('[data-card]')].filter(c => !c.checked).map(c => c.dataset.card),
  });
  // Times are written into the cards as they render, so a new clock format needs a redraw.
  if (window.appearance.read().clock !== clockWas) { reload(); paintSettings(); }
}

// Settings: the version line, what's new in an available update, and the Install button.
function paintUpdate() {
  const u = _profile.update;
  if (!u) return;
  document.getElementById('settings-autoupdate').checked = u.enabled;
  const rb = u.rolledBack;
  document.getElementById('settings-version').textContent = `Version ${u.version}. ` + (
    rb && !u.available ? `Version ${rb.failed} did not start, so the dashboard went back to ${rb.restored}. It will wait for the next version.`
    : u.error ? u.error + '.'
    : u.available ? `Version ${u.latest} is available.`
    : u.checkedAt ? 'Up to date.' : '');
  const install = document.getElementById('install-btn');
  install.hidden = !u.available;
  install.textContent = `Install ${u.latest}`;
  const notes = document.getElementById('update-notes');
  notes.hidden = !(u.available && u.notes);
  if (!notes.hidden) notes.innerHTML = changelogHtml(u.notes);
}

// CHANGELOG markdown, just the parts it uses: "## 1.2.0 (date)" headings and "- " items.
function changelogHtml(md) {
  const inline = t => escape(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '$1');
  return md.split(/\n(?=## |- )/).map(block => block.startsWith('## ')
    ? `<h4>What's new in ${inline(block.slice(3).split('\n')[0])}</h4>`
    : block.startsWith('- ') ? `<ul><li>${inline(block.slice(2).replace(/\s*\n\s*/g, ' '))}</li></ul>` : '').join('');
}

// Settings → Copy diagnostics: a text report to paste to whoever is helping. The server blanks
// emails and tokens. If the clipboard is refused, it downloads as a file instead.
async function copyDiagnostics() {
  let text;
  try { text = await (await fetch('/api/diagnostics')).text(); }
  catch (err) { showToast(`Could not collect diagnostics: ${err.message}`, null, 6); return; }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Diagnostics copied. Paste them in a message to whoever is helping you.', null, 7);
  } catch {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'attention-diagnostics.txt';
    a.click();
    showToast('Saved as attention-diagnostics.txt. Send that file to whoever is helping you.', null, 7);
  }
}

// Settings → Your data. The server's part (tasks, reminders, course names, name) plus this
// browser's preferences, in one file. Skipped: the change-tracking snapshots, which rebuild
// themselves, the local copy of the tasks (the server's list is the real one), and the
// one-time cards.
const BACKUP_SKIP = /^attention-(event-snapshot|todos-v1|welcome|whatsnew)/;
async function downloadBackup() {
  try {
    const backup = await api('/api/backup');
    backup.prefs = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('attention-') && !BACKUP_SKIP.test(k)) backup.prefs[k] = localStorage.getItem(k);
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    a.download = `attention-backup-${getDateKey(0)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast(`Backup saved: ${backup.tasks.length} task${backup.tasks.length === 1 ? '' : 's'}`, null, 5);
  } catch (err) { showToast(`Could not make a backup: ${err.message}`, null, 6); }
}
async function restoreBackup(file) {
  if (!file) return;
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { showToast('That file is not a backup.', null, 6); return; }
  if (backup.app !== 'attention-dashboard' || !Array.isArray(backup.tasks)) { showToast('That file is not an Attention Dashboard backup.', null, 6); return; }
  if (!confirm(`Restore the backup from ${(backup.exportedAt || '').slice(0, 10) || 'this file'}? It replaces your current tasks (${backup.tasks.length} in the backup).`)) return;
  try {
    await api('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
    for (const [k, v] of Object.entries(backup.prefs || {})) {
      if (k.startsWith('attention-') && !BACKUP_SKIP.test(k) && typeof v === 'string') localStorage.setItem(k, v);
    }
  } catch (err) { showToast(`Could not restore: ${err.message}`, null, 7); return; }
  localStorage.removeItem('attention-todos-v1');   // the server's list is the restored one now
  alert('Backup restored. Google sign-ins and the eLearn link are not in backups: reconnect Google, and paste the eLearn link in Settings if you use it.');
  location.reload();
}

// Once per update: what changed, so an automatic update is not a silent one.
const WHATSNEW_KEY = 'attention-whatsnew-seen-v1';
function renderWhatsNew() {
  const w = _profile.update?.whatsNew, card = document.getElementById('whatsnew-card');
  let seen = '';
  try { seen = localStorage.getItem(WHATSNEW_KEY) || ''; } catch {}
  card.hidden = !w?.notes || seen === w.version;
  if (card.hidden) return;
  card.innerHTML = `
    <div class="welcome-head">
      <h2 class="card-h2">Updated to version ${escape(w.version)}</h2>
      <button class="icon-btn" onclick="dismissWhatsNew()" title="Hide"><span class="msym">close</span></button>
    </div>
    <div class="update-notes whatsnew-notes">${changelogHtml(w.notes)}</div>
    <button class="text-btn" onclick="dismissWhatsNew()">Got it</button>`;
}
function dismissWhatsNew() {
  try { localStorage.setItem(WHATSNEW_KEY, _profile.update?.whatsNew?.version || ''); } catch {}
  renderWhatsNew();
}

// Check now instead of waiting for the hourly check. Only looks; Install is a separate step.
async function checkForUpdates() {
  const btn = document.getElementById('update-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    _profile.update = await api('/api/update/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    paintUpdate();
    const u = _profile.update;
    if (u.error) showToast(`Could not check for updates: ${u.error}`, null, 6);
    else if (!u.available) showToast(`You have the latest version (${u.version})`, null, 5);
  } catch (err) {
    showToast(`Could not check for updates: ${err.message}`, null, 6);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for updates';
  }
}

// Installing restarts the server, so wait for the new version to answer, then reload onto it.
async function installUpdate() {
  const btn = document.getElementById('install-btn');
  btn.disabled = true;
  btn.textContent = 'Installing…';
  try {
    const r = await api('/api/update/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.updatingTo) {
      _profile.update = r;
      paintUpdate();
      showToast(`Could not install: ${r.error || 'nothing to install'}`, null, 7);
      return;
    }
    showToast(`Installing version ${r.updatingTo}. The page reloads when it is ready.`, null, 30);
    for (let i = 0; i < 60; i++) {
      await new Promise(ok => setTimeout(ok, 1000));
      const c = await api('/api/config').catch(() => null);
      if (c?.update?.version === r.updatingTo) { location.reload(); return; }
    }
    showToast('The update is taking a while. Reload the page in a minute.', null, 8);
  } catch (err) {
    showToast(`Could not install: ${err.message}`, null, 6);
  } finally {
    btn.disabled = false;
    paintUpdate();
  }
}

async function stopDashboard() {
  if (!confirm('Stop the dashboard? It starts again the next time you log in, or when you open the start file in its folder.')) return;
  try {
    await api('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch (err) { showToast(`Could not stop it: ${err.message}`, null, 6); return; }
  // The clock and refresh timers would keep firing at elements that are about to be gone.
  // ponytail: browsers number timers upward, so clearing up to the newest id stops them all;
  // swap for tracked ids if a browser ever stops numbering them that way.
  const newest = setTimeout(() => {}, 0);
  for (let id = 1; id <= newest; id++) { clearTimeout(id); clearInterval(id); }
  const start = _platform.os === 'windows' ? 'start.cmd' : 'start.command';
  document.body.innerHTML = `<div class="stopped-page"><h1>Dashboard stopped</h1>
    <p>It starts again the next time you log in. To start it now, double-click <b>${start}</b>
    in the attention-dashboard folder.</p></div>`;
}

function paintProfile() {
  document.getElementById('settings-name').value = _profile.name;
  const m = document.getElementById('settings-moodle');
  m.value = '';   // never sent back: it carries a login token
  paintUpdate();
  m.placeholder = _profile.moodle ? 'Connected (paste to replace)' : 'https://elearn.uc.ac.id/calendar/export_execute.php?…';
}
document.getElementById('date-line').textContent =
  new Date().toLocaleDateString('en-ID', { weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone: TZ });

// Calendars
// Calendars are discovered per account at sign-in, so the dashboard follows
// whichever accounts you connect instead of hardcoded IDs. The cap keeps the
// per-reload request count sane (the original budget was 4 calendars).
const MAX_CALENDARS = 10;
const WRITE_CAL = 'primary';   // deadline events land on the owning account's own calendar

// Per-calendar failures from the last fetchRange, surfaced instead of silently swallowed.
let _calErrors = [];

// `errors` defaults to the shared banner list, but a caller fetching a different
// range concurrently (the deadlines card) passes its own so the two don't clobber
// each other, and so one failure isn't reported twice.
async function fetchRange(startYmd, endYmd, errors = _calErrors, maxResults = 50) {
  const params = new URLSearchParams({
    timeMin: new Date(startYmd + 'T00:00:00').toISOString(),
    timeMax: new Date(endYmd + 'T23:59:59').toISOString(),
    singleEvents: 'true',   // expand recurring events, as the MCP tool did implicitly
    orderBy: 'startTime',
    timeZone: TZ,           // returned dateTimes carry our offset, so their first 10 chars are the local date
    maxResults: String(maxResults),
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
      .catch(err => { errors.push(`${cal.name} (${acct.email}): ${err.message}`); return []; })
  ));
  // Moodle is one request for the whole range rather than one per course: the
  // courses only exist after the server has parsed the feed, and each event comes
  // back tagged with its course, so hiding one is a filter here.
  const moodle = moodleAccounts().map(acct =>
    api(`/api/moodle/events?start=${startYmd}&end=${endYmd}`)
      .then(data => (data.items || []).filter(e => isCalShown(acct.email, e._calId)))
      .catch(err => { errors.push(`${acct.name || acct.email}: ${err.message}`); return []; })
  );
  const all = (await Promise.all([...google, ...moodle])).flat().sort((a,b) =>
    (a.start?.dateTime||a.start?.date||'').localeCompare(b.start?.dateTime||b.start?.date||'')
  );
  const seen = new Set();
  return all.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
}

// Calendar API write helpers
// Which calendar deadline reminders are written to (Settings). Falls back to the first
// connected account's own calendar, which is where they always went before the setting existed.
const writableCalendars = () => googleAccounts().flatMap(a =>
  a.calendars.filter(c => c.access === 'owner' || c.access === 'writer').map(c => ({ acct: a, cal: c })));

function writeTarget() {
  const [email, calId] = String(_settings.writeCal || '').split('::');
  const acct = googleAccounts().find(a => a.email === email);
  return acct && calId ? { acct, calId } : { acct: googleAccounts()[0], calId: WRITE_CAL };
}

// End of a timed deadline event; capped at 23:59 so it never spills into the next day.
function plusMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
const plusHalfHour = hhmm => plusMinutes(hhmm, 30);
const plusDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

// The event title, from Settings → Deadline events. `title` is what the title always was ("Course:
// task" for course work); a template that names {course} gets the task and course separately.
// A placeholder with nothing to fill it takes its separator with it: no "Deadline: : Essay".
function deadlineEventTitle(title, { task, course } = {}) {
  const tpl = (_settings.deadlineTitle || '').trim() || SETTINGS_DEFAULTS.deadlineTitle;
  const split = tpl.includes('{course}');
  const out = tpl.replaceAll('{task}', split ? (task ?? title) : title).replaceAll('{course}', split ? (course || '') : '');
  return out.replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s+/g, ' ').replace(/^[\s:·|–-]+|[\s:·|–-]+$/g, '').replace(/([:·|–-])\s*([:·|–-])/g, '$2').trim() || title;
}

// `time` is the deadline's own due time when it has one (eLearn gives "…is due 00:59"); only a
// task with a bare date falls back to the hour set in Settings. `extra` shapes the event from
// Settings: the task and course for the title template, and notes and links for the description.
async function createDeadlineEvent(title, deadline, time = _settings.deadlineTime, extra = {}) {
  const { acct, calId } = writeTarget();
  if (!acct) throw new Error('No Google account connected');
  const len = _settings.deadlineLength;
  const when = len === 'allday'
    ? { start: { date: deadline }, end: { date: plusDays(deadline, 1) } }
    : { start: { dateTime: `${deadline}T${time}:00`, timeZone: TZ },
        end:   { dateTime: `${deadline}T${plusMinutes(time, Number(len) || 30)}:00`, timeZone: TZ } };
  const details = _settings.deadlineDetails
    ? [extra.notes, ...linksOf({ link: extra.link }).map(l => l.url)].filter(Boolean).join('\n\n') : '';
  const res = await gcal(`/calendars/${encodeURIComponent(calId)}/events?sendUpdates=none`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: deadlineEventTitle(title, extra),
      ...when,
      ...(_settings.deadlineColor ? { colorId: _settings.deadlineColor } : {}),
      ...(details ? { description: details } : {}),
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: _settings.deadlineWarn }] },
    }),
  }, acct);
  if (!res.ok) throw new Error('create failed');
  return { id: (await res.json()).id || null, acct: acct.email, calId };
}

// Best-effort: 204 = deleted, 410 = already gone. Both fine, never throws.
// calId is stored per task: the setting may point somewhere else by the time it is deleted.
function deleteCalendarEvent(eventId, acctEmail, calId = WRITE_CAL) {
  return gcal(`/calendars/${encodeURIComponent(calId || WRITE_CAL)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
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

// Free time blocks
function getFreeBlocks(events, ymd) {
  const now = Date.now();
  const dayEnd = new Date(ymd + 'T22:00:00').getTime();
  const dayStart = new Date(ymd + 'T06:00:00').getTime();
  const cursor0 = Math.max(now, dayStart);
  if (cursor0 >= dayEnd) return [];

  const MIN = 45 * 60000;
  const timed = events
    .filter(e => e.start?.dateTime && e.start.dateTime.startsWith(ymd) && blocksTime(e._acct, e._calId))
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

// Busyness bar
function busynessBar(count) {
  const max = 5, n = Math.min(count, max);
  const color = count === 0 ? null : count <= 2 ? '#4ade80' : count <= 4 ? '#facc15' : '#f87171';
  let html = '<span class="busy-bar">';
  for (let i = 0; i < max; i++)
    html += `<span class="busy-seg"${i < n && color ? ` style="background:${color}"` : ''}></span>`;
  return html + '</span>';
}

// Clock
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById('clock-time').textContent =
      clockTime(now, true);
    // 12-hour: AM/PM set smaller after the seconds, so the tile does not cut it off.
    const t = document.getElementById('clock-time');
    t.innerHTML = t.textContent.replace(/\s?(AM|PM)$/i, '<small class="clock-ampm">$1</small>');
    document.getElementById('clock-day').textContent =
      now.toLocaleDateString('en-ID', { weekday:'long', timeZone: TZ }) + ' · ' + TZ_LABEL;
  }
  tick();
  setInterval(tick, 1000);
}

// Day progress donut (7 AM – 10 PM)
function updateDayProgress() {
  const now = new Date();
  const ymd = now.toLocaleDateString('en-CA', { timeZone: TZ });
  const dayStart = new Date(ymd + `T${String(_settings.dayStart).padStart(2, '0')}:00:00`).getTime();
  const dayEnd   = new Date(ymd + `T${String(_settings.dayEnd).padStart(2, '0')}:00:00`).getTime();
  const pct = Math.min(100, Math.max(0, (now.getTime() - dayStart) / (dayEnd - dayStart) * 100));
  document.getElementById('day-donut').style.strokeDashoffset = (283 * (1 - pct / 100)).toFixed(1);
  document.getElementById('day-pct').textContent = Math.round(pct);
}

// Countdown
function renderCountdown(events) {
  const now = Date.now();
  const next = events.find(e => {
    const s = new Date(e.start?.dateTime || e.start?.date + 'T00:00:00').getTime();
    return s > now + 30 * 60000;
  });
  if (!next) {
    document.getElementById('cd-days').textContent = '–';
    document.getElementById('cd-name').textContent = 'Nothing upcoming';
    document.getElementById('cd-sub').textContent  = "you're all clear";
    return;
  }
  const start = new Date(next.start?.dateTime || next.start?.date + 'T00:00:00');
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

// RSVP
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
// anywhere before this (they ride along untouched in the payload), so folding a series back
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
  const label = status === 'accepted' ? 'Accepted' : 'Declined';
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
      showToast('Could not respond. The invites are back', null, 5);
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

  const label = status === 'accepted' ? 'Accepted' : 'Declined';
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
    // Fire API in background; restore and notify if it fails
    respondToEvent(e, status).catch(() => {
      _rsvpEvents.push(e);
      renderRsvp(_rsvpEvents);
      showToast(`Could not respond. "${escape(e.summary||'event')}" is back`, null, 5);
    });
  }, 5000);

  showToast(`RSVP: ${label}`, undo, 5);
}

// Timeline events
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

// Deleting your own calendar events
// Google flags the signed-in user on the event: `creator.self` means you added it.
// Anything you were merely invited to stays undeletable. Decline it instead.
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
    <div class="tl-time${now_ ? ' now' : ''}">${e.start?.dateTime ? clockShort(e.start.dateTime) : 'All day'}${
      e.start?.dateTime && e.end?.dateTime ? `<span class="tl-end">${clockShort(e.end.dateTime)}</span>` : ''}</div>
    ${now_ ? '<div class="tl-nowbar"></div>' : ''}
    <div class="tl-card${now_ ? ' current' : ''}${needsRsvp ? ' ghost' : ''}">
      ${now_ ? `<div class="tl-now" data-s="${start}" data-e="${end}"></div>` : ''}
      ${needsRsvp ? '' : `<div class="bar" style="background:${evColor(e)}"></div>`}
      ${canDeleteEvent(e) ? `<button class="ev-del" onclick="event.stopPropagation(); deleteEvent('${key}')" title="Delete from Google Calendar"><span class="msym">close</span></button>` : ''}
      <div class="tl-title"><a href="${escape(e.htmlLink||'#')}" target="_blank">${title}</a></div>
      <div class="tl-meta">
        ${now_ ? `<span class="tl-live">on now · until ${formatTime(end)}</span> · ` : ''}${escape(e._calName)}${acctTag(e)}${e.location?' · '+escape(e.location):''}
        ${meetUrl?` · <span class="msym">videocam</span> <a href="${escape(meetUrl)}" target="_blank">Join Meet</a>`:''}
      </div>
    </div>
  </div>`;
}

function renderFreeBlock(from, to) {
  return `
  <div class="tl-event">
    <div class="tl-time">${clockShort(from)}</div>
    <div class="tl-card ghost">
      <div class="tl-title">${formatDur(to - from)} free</div>
    </div>
  </div>`;
}

// Moves the in-card line as the clock does, so it stays right between refreshes.
function tickNowLines() {
  for (const el of document.querySelectorAll('.tl-now')) {
    const s = Date.parse(el.dataset.s), e = Date.parse(el.dataset.e), now = Date.now();
    if (!(e > s)) continue;
    // Height, not offset: the marker runs down the card's own edge, where it crosses no text.
    const frac = Math.min(1, Math.max(0, (now - s) / (e - s)));
    el.style.height = `${frac * 100}%`;
    // The rule runs at the same height across the row, but is painted before the card, so it
    // shows in the margins and passes behind the card rather than over its text.
    const card = el.closest('.tl-card'), bar = card?.parentElement.querySelector('.tl-nowbar');
    if (bar) bar.style.top = `${card.offsetTop + card.offsetHeight * frac}px`;
  }
}

// Card heights change with the window, and the rule is positioned in pixels against them.
addEventListener('resize', tickNowLines);

// When nothing is running the line falls between two cards, and carries the real time so it is
// never read as the start of the card below it.
const nowLine = () => `<div class="now-line"><div class="now-line-bar"></div><div class="now-tag">NOW ${
  clockTime(new Date())}</div></div>`;

// One day's event stack; today gets interleaved free blocks + a NOW line.
function renderDayRows(ymd, dayEvents, isToday) {
  if (!dayEvents.length && !isToday) return '<div class="tl-empty">Nothing scheduled</div>';

  const freeBlocks = isToday ? getFreeBlocks(dayEvents, ymd) : [];
  const items = [
    ...dayEvents.map(e => ({ type:'event', t: new Date(e.start?.dateTime||e.start?.date+'T00:00:00').getTime(), e })),
    ...freeBlocks.map(b => ({ type:'free', t: b.from, from: b.from, to: b.to })),
  ].sort((a, b) => a.t - b.t);

  if (!items.length) return '<div class="tl-empty">Nothing scheduled</div>';

  const parts = items.map(item =>
    item.type === 'event' ? renderTlEvent(item.e, isToday) : renderFreeBlock(item.from, item.to)
  );

  // Nothing running: the line goes between two cards. Something running: it is drawn through
  // that card instead (see .tl-now), the way a calendar grid does it.
  if (isToday && !items.some(it => it.type === 'event' && it.e.start?.dateTime
      && isHappening(it.e.start.dateTime, it.e.end?.dateTime || it.e.start.dateTime))) {
    const now = Date.now();
    // An event you are in the middle of belongs below the line, whole, rather than being left
    // above it as if it were over.
    let idx = items.findIndex(it => it.t > now
      || (it.type === 'event' && it.e.start?.dateTime && isHappening(it.e.start.dateTime, it.e.end?.dateTime || it.e.start.dateTime)));
    if (idx === -1) idx = items.length;
    parts.splice(idx, 0, nowLine());
  }
  setTimeout(tickNowLines);   // after this HTML is in the DOM
  return `<div class="tl-events">${parts.join('')}</div>`;
}

// Load Events
// `shared` is reload()'s one fetch for this card and Search Calendar, which covers this week
// and more; only the week is kept here.
async function loadEvents(shared) {
  const week = getDateKey(6);
  const events = shared
    ? (await shared).filter(e => (e.start?.dateTime || e.start?.date || '').slice(0, 10) <= week)
    : await fetchRange(getDateKey(0), week);
  renderCountdown(events);

  const rsvp = events.filter(e => e.attendees?.some(a => a.self && a.responseStatus === 'needsAction'));
  renderRsvp(rsvp);

  // Campus events are tracked by the deadlines card over its whole year, so they stay out
  // of this one. Otherwise every Moodle change would be announced twice. A partial fetch
  // would read as mass deletion, so a load with errors is not compared at all.
  if (!_calErrors.length) {
    trackChanges('week', events.filter(e => !e.id.startsWith('moodle-')), getDateKey(0), getDateKey(6));
  }

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
    // A whole feed failing (eLearn down) reports its courses as 0, so never "1 of 0".
    const total = Math.max(totalCalendars(), _calErrors.length);
    warnEl.innerHTML = `<strong>${_calErrors.length} of ${total} calendar${total === 1 ? '' : 's'} failed to load</strong>`
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
  document.getElementById('week-count').textContent = weekEvents.length;

  document.getElementById('week-list').innerHTML = `<div class="week-rows">${weekDates.map(ymd => {
    const dayEv = byDate[ymd] || [];
    const count = dayEv.length;
    const hasRsvp = dayEv.some(e => e.attendees?.some(a => a.self && a.responseStatus === 'needsAction'));
    const d = new Date(ymd + 'T12:00:00');
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
}

// Search Calendar
// The schedule cards cover a week and are grouped by day; this one is the flat, searchable
// list for "when was that meeting again".
const UPCOMING_KEY = 'attention-event-view-v1';
let _upcoming = [];
let _upErrors = [];
let _upView = { q: '', days: '30', type: '' };
// Calendars kept out of this card only. The schedule and month view still show them.
const EVENT_HIDDEN_KEY = 'attention-event-hidden-calendars-v1';
let eventHiddenCals = new Set();
try { eventHiddenCals = new Set(JSON.parse(localStorage.getItem(EVENT_HIDDEN_KEY)) || []); } catch {}
const inEventList = (email, calId) => !eventHiddenCals.has(calKey(email, calId));

function toggleUpcomingCals() {
  const el = document.getElementById('upcoming-cal-list');
  el.hidden = !el.hidden;
}

function toggleUpcomingCal(k) {
  eventHiddenCals.has(k) ? eventHiddenCals.delete(k) : eventHiddenCals.add(k);
  localStorage.setItem(EVENT_HIDDEN_KEY, JSON.stringify([...eventHiddenCals]));
  renderUpcoming();
}

function setUpcomingCals(only) {
  const all = accounts.flatMap(a => shownCalendars(a).map(c => calKey(a.email, c.id)));
  eventHiddenCals = new Set(only ? all : []);
  localStorage.setItem(EVENT_HIDDEN_KEY, JSON.stringify([...eventHiddenCals]));
  renderUpcoming();
}
try { _upView = { ..._upView, ...(JSON.parse(localStorage.getItem(UPCOMING_KEY)) || {}) }; } catch {}
const saveUpView = () => localStorage.setItem(UPCOMING_KEY, JSON.stringify(_upView));

function onUpcomingSearch(v) { _upView.q = v; saveUpView(); renderUpcoming(); }
function onUpcomingRange(v)  { _upView.days = v; saveUpView(); loadUpcoming(); }
function onUpcomingType(t)   { _upView.type = t; saveUpView(); renderUpcoming(); }

async function loadUpcoming(shared) {
  const list = document.getElementById('upcoming-list');
  list.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  try {
    // 250 rather than the timeline's 50: a term's worth of classes overruns a small page.
    _upcoming = await (shared || fetchRange(getDateKey(0), getDateKey(Number(_upView.days) || 30), _upErrors, 250));
  } catch (err) {
    list.innerHTML = `<div class="error">Could not load your calendar: ${escape(err.message)}</div>`;
    return;
  }
  renderUpcoming();
}

function renderUpcoming() {
  const cals = accounts.flatMap(a => shownCalendars(a).map(c => ({ a, c, k: calKey(a.email, c.id) })));
  const off = cals.filter(x => !inEventList(x.a.email, x.c.id)).length;
  document.getElementById('upcoming-cal-btn').hidden = !cals.length;
  document.getElementById('upcoming-cal-btn').textContent =
    off ? `Calendars · ${cals.length - off}/${cals.length}` : 'All calendars';
  document.getElementById('upcoming-cal-list').innerHTML = cals.map(({ a, c, k }) => `
    <label class="cal-item">
      <input type="checkbox" ${inEventList(a.email, c.id) ? 'checked' : ''} onchange="toggleUpcomingCal('${escape(k)}')">
      <span class="cal-swatch" style="background:${c.color || '#94a3b8'}"></span>
      <span class="cal-name" title="${escape(c.name)}">${escape(c.name)}</span>
    </label>`).join('')
    + `<div class="cal-pick-actions">
         <button class="text-btn" onclick="setUpcomingCals(false)">Select all</button>
         <button class="text-btn" onclick="setUpcomingCals(true)">Clear all</button>
       </div>`;
  document.getElementById('upcoming-search').value = _upView.q;
  document.getElementById('upcoming-range').value = _upView.days;

  // Type pills, only for types some shown calendar actually has.
  const types = CAL_TYPES.filter(t => cals.some(x => calTypeOf(x.a.email, x.c.id) === t));
  if (!types.includes(_upView.type)) _upView.type = '';
  const pills = document.getElementById('upcoming-types');
  pills.hidden = !types.length;
  pills.innerHTML = ['', ...types].map(t =>
    `<button class="type-pill${t === _upView.type ? ' on' : ''}" onclick="onUpcomingType('${t}')">${t || 'All'}</button>`).join('');

  const q = _upView.q.trim().toLowerCase();
  const rows = _upcoming.filter(e => inEventList(e._acct, e._calId)
    && (!_upView.type || calTypeOf(e._acct, e._calId) === _upView.type)
    && (!q || `${e.summary || ''} ${e.location || ''} ${e._calName || ''}`.toLowerCase().includes(q)));

  document.getElementById('upcoming-count').textContent = rows.length;
  document.getElementById('upcoming-list').innerHTML = rows.length
    ? `<div class="task-list">${rows.map(upcomingRow).join('')}</div>`
    : `<div class="empty">${q || _upView.type ? 'Nothing matches that.' : off === cals.length ? 'Every calendar is switched off.' : 'Nothing scheduled.'}</div>`;
}

function upcomingRow(e) {
  const start = e.start?.dateTime || e.start?.date || '';
  const ymd = start.slice(0, 10);
  const key = 'ev' + (_evSeq++);
  _evRegistry[key] = e;
  return `
  <div class="task-row" id="${key}">
    <div class="task-main">
      <div class="task-title"><a href="${escape(e.htmlLink || '#')}" target="_blank">${escape(e.summary || '(No title)')}</a></div>
      <div class="task-meta course-meta">
        <span class="cal-swatch" style="background:${evColor(e)}"></span>
        <span>${relDayLabel(ymd)}${e.start?.dateTime ? ' · ' + formatTime(e.start.dateTime) : ' · all day'} · ${escape(e._calName || '')}</span>
        ${calTypeOf(e._acct, e._calId) ? `<span class="cal-type-tag">${calTypeOf(e._acct, e._calId)}</span>` : ''}
      </div>
    </div>
    <div class="task-actions">
      ${canDeleteEvent(e) ? `<button onclick="deleteEvent('${key}')" title="Delete from Google Calendar"><span class="msym">close</span></button>` : ''}
    </div>
  </div>`;
}

// Month view
let monthCursor = new Date();        // tracks which month is shown (day-of-month irrelevant)
let monthCache  = { key: null, byDate: null };
let selectedDay = null;

function ymdLocal(y, m, d) {          // m is 0-indexed
  return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

// Compact = dots only; expanded = event titles in the cell, like Calendar.app.
const MONTH_VIEW_KEY = 'attention-month-view';
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
// no handler at all: it wore .active, sat next to a working "Month", and did nothing, which
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
  const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dows = Array.from({ length: 7 }, (_, i) => names[(_settings.weekStartsOn + i) % 7]);
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

  // Offset of the 1st within the week, which depends on which day the week starts.
  const firstDow = (new Date(y, m, 1).getDay() - _settings.weekStartsOn + 7) % 7;
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
    new Date(ymd + 'T12:00:00').toLocaleDateString('en-ID', { weekday:'long', day:'numeric', month:'long', timeZone: TZ });
  const body = document.getElementById('month-day-detail-body');
  body.innerHTML = dayEvents.length
    ? `<div class="timeline"><div class="tl-events">${dayEvents.map(e => renderTlEvent(e, false)).join('')}</div></div>`
    : '<div class="empty" style="padding:8px 0">Nothing scheduled</div>';
}

// To Do
const TODO_KEY = 'attention-todos-v1';

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
    _todos = local;   // server unreachable: fall back to the mirror
  }
}

function daysUntil(ymd) {
  if (!ymd) return null;
  const todayYmd = getDateKey(0);
  return Math.round((new Date(ymd + 'T12:00:00') - new Date(todayYmd + 'T12:00:00')) / 86400000);
}

// A local folder/file path rather than a URL, e.g. /Users/… or ~/Downloads
// ~, / (macOS), C:\ or C:/ (Windows), \\server\share (UNC).
function isLocalPath(v = '') { return /^(~|\/|[A-Za-z]:[\\/]|\\\\)/.test(v.trim()); }

// Trailing spaces are legal in macOS filenames and Finder hides them, so a blanket
// .trim() silently breaks paths like "…/Day 5 ". Only URLs get trimmed both ends.
// A task can carry several links. They share the `link` column, one per line, so no schema
// change was needed and every task saved before this still reads as a list of one.
// A line may carry a name first, tab-separated: "Brief\thttps://…". A tab cannot be typed into
// these fields, so it never collides with a real URL or path, and unnamed lines read as before.
// cleanLink on the target, not trim: a folder path's trailing space is part of its name.
function linksOf(t) {
  return String(t?.link || '').split('\n').map(line => {
    const tab = line.indexOf('\t');
    return { title: tab < 0 ? '' : line.slice(0, tab).trim(), url: cleanLink(tab < 0 ? line : line.slice(tab + 1)) };
  }).filter(l => l.url);
}
const linkLine = l => l.title ? `${l.title.replace(/[\t\n]/g, ' ')}\t${l.url}` : l.url;

function addLinkRow(link = {}, focus = false) {
  const row = document.createElement('div');
  row.className = 'input-row link-row';
  row.innerHTML = `
    <input class="todo-input todo-link-name" type="text" placeholder="Name (optional)">
    <input class="todo-input todo-link-input" type="text" placeholder="https://drive.google.com/… or a folder on this computer">
    <button type="button" class="browse-btn" onclick="pickFolder(this)" title="Choose a folder on this computer"><span class="msym">folder_open</span> Browse</button>
    <button type="button" class="icon-btn link-remove" onclick="removeLinkRow(this)" title="Remove this link"><span class="msym">close</span></button>`;
  row.querySelector('.todo-link-name').value = link.title || '';
  row.querySelector('.todo-link-input').value = link.url || '';
  document.getElementById('todo-modal-links').appendChild(row);
  if (focus) row.querySelector('.todo-link-name').focus();
}

// The last row is cleared rather than removed, so there is always one field to type into.
function removeLinkRow(btn) {
  const box = document.getElementById('todo-modal-links');
  if (box.children.length > 1) btn.closest('.link-row').remove();
  else btn.closest('.link-row').querySelectorAll('input').forEach(i => { i.value = ''; });
}

function setModalLinks(links) {
  document.getElementById('todo-modal-links').innerHTML = '';
  (links.length ? links : [{}]).forEach(l => addLinkRow(l));
}
const getModalLinks = () => [...document.querySelectorAll('.link-row')].map(r => ({
  title: r.querySelector('.todo-link-name').value.trim(),
  url: cleanLink(r.querySelector('.todo-link-input').value),
})).filter(l => l.url);

function cleanLink(v = '') {
  if (!v.trim()) return null;
  return isLocalPath(v)
    ? v.replace(/^\s+/, '').replace(/[\r\n\t]+$/, '')
    : v.trim();
}

// Native folder picker, run by the server; the browser cannot expose a real path.
async function pickFolder(btn) {
  const input = btn.closest('.link-row').querySelector('.todo-link-input');
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
      input.value = d.path;
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
async function revealTodoPath(id, i = 0) {
  const path = linksOf(getTodos().find(x => x.id === id))[i]?.url;
  if (!path) return;
  try {
    const r = await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'could not open');
  } catch (err) {
    showToast(`Couldn't open folder: ${err.message}`, null, 5);
  }
}

function dueChip(ymd) {
  if (!ymd) return '';
  const days = daysUntil(ymd);
  const label = new Date(ymd + 'T12:00:00').toLocaleDateString('en-ID', { day:'numeric', month:'short', timeZone: TZ });
  const cls  = days < 0 ? 'overdue' : days <= 3 ? 'soon' : '';
  const icon = days < 0 ? 'warning' : 'event';
  const hint = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Due today' : `${days}d left`;
  return `<span class="due-chip ${cls}" title="${hint}"><span class="msym">${icon}</span> ${label}</span>`;
}

// Settings
// Every knob in one blob. The defaults are what the dashboard hard-coded before this panel
// existed, so a browser that has never opened it behaves exactly as it always did.
const SETTINGS_KEY = 'attention-settings-v1';
const SETTINGS_DEFAULTS = {
  remindAheadDays: 0,   // 0 = only once the deadline is today; 3 = a nudge three days out
  snoozeDays: [1, 3, 7],
  dayStart: 7,          // what the progress ring measures, not the whole 24 hours
  dayEnd: 22,
  defaultSort: 'manual',
  writeCal: '',         // '' = the first account's own calendar, as it worked before the setting
  autoTaskDeadlines: false,
  dayReminderHour: 7,   // when the server sends that day's reminders
  nowLineAlpha: 0.09,   // how strong the current-time rule is; 0 hides it
  newTaskCal: true,     // what a New Task starts with; each is still per-task in the window
  newTaskDeadline: '',  // '' | days from today as a string ('0' = today)
  newTaskRepeat: '',
  deadlineTime: '09:00',   // when a deadline reminder sits on the calendar
  deadlineWarn: 1440,      // minutes before that Google pops its reminder
  deadlineTitle: 'Deadline: {task}',   // {task}; {course} for the course on its own
  deadlineLength: '30',    // minutes as a string, or 'allday'
  deadlineColor: '',       // '' = the calendar's own colour, '1'..'11' = Google's event colours
  deadlineDetails: true,   // put the task's notes and links in the event
  weekStartsOn: 1,      // 0 = Sunday, 1 = Monday
};
let _settings = { ...SETTINGS_DEFAULTS };
try { _settings = { ..._settings, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; } catch {}
const saveSettings = () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings));
  // The server does the reminding, so it needs the one setting that shapes it.
  putReminders({ aheadDays: _settings.remindAheadDays, dayHour: _settings.dayReminderHour }).catch(() => {});
};

// "Tomorrow" beats "1 day", and 7 is the one everybody means by next week.
const snoozeLabel = d => d === 1 ? 'Tomorrow' : d === 7 ? 'Next week' : `${d} day${d > 1 ? 's' : ''}`;
const hourLabel = h => window.appearance.read().clock === '12' ? `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}` : `${String(h).padStart(2, '0')}:00`;

function openSettings() {
  paintSettings();
  paintProfile();
  paintAppearance();
  renderDayReminderSettings();
  document.getElementById('settings-overlay').classList.add('open');
}
const closeSettings = () => document.getElementById('settings-overlay').classList.remove('open');

function paintSettings() {
  document.getElementById('settings-remind').value = _settings.remindAheadDays;
  document.getElementById('settings-snooze').value = _settings.snoozeDays.join(', ');
  document.getElementById('settings-day-start').value = _settings.dayStart;
  document.getElementById('settings-day-end').value = _settings.dayEnd;
  document.getElementById('settings-sort').value = _settings.defaultSort;
  document.getElementById('settings-week').value = String(_settings.weekStartsOn);
  const wc = document.getElementById('settings-writecal');
  wc.innerHTML = '<option value="">Default (first account)</option>'
    + writableCalendars().map(({ acct, cal }) =>
        `<option value="${escape(calKey(acct.email, cal.id))}">${escape(cal.name)} (${escape(acct.email)})</option>`).join('');
  wc.value = writableCalendars().some(({ acct, cal }) => calKey(acct.email, cal.id) === _settings.writeCal)
    ? _settings.writeCal : '';
  document.getElementById('settings-autotask').checked = _settings.autoTaskDeadlines;
  document.getElementById('settings-dayhour').value = _settings.dayReminderHour;
  const dt = document.getElementById('settings-deadlinetime');
  dt.innerHTML = Array.from({ length: 48 }, (_, i) => {
    const hhmm = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
    return `<option value="${hhmm}">${hhmm}</option>`;
  }).join('');
  dt.value = _settings.deadlineTime;
  document.getElementById('settings-deadlinewarn').value = String(_settings.deadlineWarn);
  document.getElementById('settings-dltitle').value = _settings.deadlineTitle;
  document.getElementById('settings-dllength').value = String(_settings.deadlineLength);
  document.getElementById('settings-dlcolor').value = _settings.deadlineColor;
  document.getElementById('settings-dldetails').checked = _settings.deadlineDetails;
  previewDeadlineTitle();
  document.getElementById('settings-newcal').checked = _settings.newTaskCal;
  document.getElementById('settings-newdeadline').value = _settings.newTaskDeadline;
  document.getElementById('settings-newrepeat').value = _settings.newTaskRepeat;
  document.getElementById('settings-nowline').value = Math.round(_settings.nowLineAlpha * 100);
  document.getElementById('settings-nowline-val').textContent = `${Math.round(_settings.nowLineAlpha * 100)}%`;
  document.getElementById('donut-wrap').setAttribute('title',
    `Day progress, ${hourLabel(_settings.dayStart)} to ${hourLabel(_settings.dayEnd)}`);
}

// Read every control back, validate, persist. A field that will not parse keeps its previous
// value rather than becoming NaN: a half-typed number should not quietly wreck a setting.
// What the title template makes of an example, for both a task and a course deadline.
function previewDeadlineTitle() {
  const tpl = document.getElementById('settings-dltitle').value;
  const was = _settings.deadlineTitle;
  _settings.deadlineTitle = tpl;
  document.getElementById('settings-dltitle-preview').textContent =
    `${deadlineEventTitle('Essay')} · ${deadlineEventTitle('Calculus A: Quiz 2', { task: 'Quiz 2', course: 'Calculus A' })}`;
  _settings.deadlineTitle = was;
}
function settingsChanged() {
  const num = (id, lo, hi, fallback) => {
    const v = Math.round(Number(document.getElementById(id).value));
    return Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
  };
  const dayStart = num('settings-day-start', 0, 23, _settings.dayStart);
  const dayEnd   = num('settings-day-end', 1, 24, _settings.dayEnd);
  if (dayEnd <= dayStart) {
    showToast('The day has to end after it starts', null, 5);
    paintSettings();
    return;
  }
  const snooze = document.getElementById('settings-snooze').value
    .split(',').map(s => Math.round(Number(s.trim())))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 365).slice(0, 4);

  _settings = {
    remindAheadDays: num('settings-remind', 0, 30, _settings.remindAheadDays),
    snoozeDays: snooze.length ? snooze : _settings.snoozeDays,
    dayStart, dayEnd,
    defaultSort: document.getElementById('settings-sort').value,
    weekStartsOn: Number(document.getElementById('settings-week').value) === 0 ? 0 : 1,
    writeCal: document.getElementById('settings-writecal').value,
    autoTaskDeadlines: document.getElementById('settings-autotask').checked,
    dayReminderHour: num('settings-dayhour', 0, 23, _settings.dayReminderHour),
    nowLineAlpha: num('settings-nowline', 0, 40, _settings.nowLineAlpha * 100) / 100,
    deadlineTime: document.getElementById('settings-deadlinetime').value || _settings.deadlineTime,
    deadlineWarn: Number(document.getElementById('settings-deadlinewarn').value),
    deadlineTitle: document.getElementById('settings-dltitle').value.trim() || SETTINGS_DEFAULTS.deadlineTitle,
    deadlineLength: document.getElementById('settings-dllength').value,
    deadlineColor: document.getElementById('settings-dlcolor').value,
    deadlineDetails: document.getElementById('settings-dldetails').checked,
    newTaskCal: document.getElementById('settings-newcal').checked,
    newTaskDeadline: document.getElementById('settings-newdeadline').value,
    newTaskRepeat: document.getElementById('settings-newrepeat').value,
  };
  saveSettings();
  adoptDefaultSort();
  applySettings();
  paintSettings();
  showToast('Settings saved', null, 3);
}

// Dragging shows the change straight away; the value is only stored on release (onchange).
function previewNowLine(v) {
  document.getElementById('settings-nowline-val').textContent = `${v}%`;
  document.documentElement.style.setProperty('--nowline-alpha', String(v / 100));
}

function resetSettings() {
  _settings = { ...SETTINGS_DEFAULTS };
  saveSettings();
  adoptDefaultSort();
  applySettings();
  paintSettings();
  showToast('Settings back to defaults', null, 3);
}

// Choosing a default sort and seeing the list not move reads as the setting having failed to
// save, so the current view adopts it too rather than waiting for the next visit.
function adoptDefaultSort() {
  _taskView.sort = _settings.defaultSort;
  saveTaskView();
  document.getElementById('todo-sort').value = _settings.defaultSort;
}

// Just redo everything a setting feeds. It is cheap enough that tracking dependencies would cost
// more than it saves.
function applySettings() {
  document.documentElement.style.setProperty('--nowline-alpha', String(_settings.nowLineAlpha));
  updateDayProgress();
  renderTodos();
  renderMonthDow();
  if (document.getElementById('month-overlay').classList.contains('open')) loadMonth();
}

// Task list: search, sort, snooze and completed
// These are view settings (what you are looking at, not what the task is), so they live in
// localStorage beside the other display preferences. The three fields that do belong to the
// task itself (doneAt, priority, snoozeUntil) go to SQLite.
const TASK_VIEW_KEY = 'attention-task-view-v1';
let _taskView = { q: '', sort: _settings.defaultSort, tab: 'todo', tag: '' };
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

// To do / Done. Finished tasks get their own tab instead of a section under the open ones.
function setTaskTab(tab) { _taskView.tab = tab; saveTaskView(); renderTodos(); }
function setTaskTag(tag) { _taskView.tag = _taskView.tag === tag ? '' : tag; saveTaskView(); renderTodos(); }

// Steps: shown folded as "2/5 steps" on the row; which rows are unfolded is not worth saving.
const _openSteps = new Set();
function toggleStepsOpen(id) { _openSteps.has(id) ? _openSteps.delete(id) : _openSteps.add(id); renderTodos(); }
function toggleStep(id, i) {
  const todos = getTodos();
  const t = todos.find(x => x.id === id);
  if (!t?.subtasks?.[i]) return;
  t.subtasks[i].done = !t.subtasks[i].done;
  putTodos(todos);
  renderTodos();
}

// Quick add (quickadd.js does the reading). Uses the same calendar default as the New Task window.
function previewQuickAdd(v) {
  const el = document.getElementById('quick-add-preview');
  const q = v.trim() ? parseQuickAdd(v) : null;
  if (!q || (!q.deadline && !q.time && !q.tags.length && !q.priority && !q.repeat)) { el.textContent = ''; return; }
  el.textContent = '→ ' + [q.title || '(no title yet)', q.deadline && whenLabel(q.deadline), q.time,
    q.repeat && (q.repeat === 'weekly' ? 'every week' : 'every month'), ...q.tags.map(t => '#' + t),
    q.priority && 'priority'].filter(Boolean).join(' · ');
}
async function quickAdd(input) {
  const q = parseQuickAdd(input.value);
  if (!q.title) { showToast('Type what the task is, then Enter.', null, 4); return; }
  const todo = { id: Date.now().toString(), title: q.title, deadline: q.deadline, tags: q.tags,
                 priority: q.priority, repeat: q.repeat, subtasks: [], done: false };
  input.value = '';
  previewQuickAdd('');
  if (q.deadline && _settings.newTaskCal && googleAccounts().length) {
    try {
      const ev = await createDeadlineEvent(q.title, q.deadline, q.time || _settings.deadlineTime, { task: q.title });
      Object.assign(todo, { calEventId: ev.id, calAcct: ev.acct, calId: ev.calId });
    } catch (e) { showToast(`Task added, but the calendar reminder failed: ${e.message}`, null, 7); }
  }
  const todos = getTodos();
  todos.push(todo);
  putTodos(todos);
  if (_taskView.tab !== 'todo') _taskView.tab = 'todo';
  renderTodos();
  showToast(`Added "${shortTitle(q.title)}"${q.deadline ? `, due ${whenLabel(q.deadline)}` : ''}`, () => removeTodo(todo.id), 6);
}

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
  // Clearing really is the end of the road for these, so their reminder events go too, but
  // only once the undo window has closed.
  clearTimeout(_clearTimer);
  _clearTimer = setTimeout(() => {
    done.forEach(t => t.calEventId && deleteCalendarEvent(t.calEventId, t.calAcct, t.calId));
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
  // "By deadline" is taken literally and ignores flags: choosing it is asking for date order.
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

  const onDone = _taskView.tab === 'done';
  document.getElementById('tab-todo').classList.toggle('active', !onDone);
  document.getElementById('tab-done').classList.toggle('active', onDone);
  document.getElementById('tab-done').textContent = done.length ? `Done ${done.length}` : 'Done';
  document.getElementById('quick-add-wrap').hidden = onDone;
  document.getElementById('todo-sort').hidden = onDone;

  // Tag filter: the tags used in the tab being looked at.
  const tagsHere = [...new Set((onDone ? done : [...open, ...snoozed]).flatMap(t => t.tags || []))].sort((a, b) => a.localeCompare(b));
  if (_taskView.tag && !tagsHere.includes(_taskView.tag)) _taskView.tag = '';
  const pills = document.getElementById('todo-tags');
  pills.hidden = !tagsHere.length;
  pills.innerHTML = ['', ...tagsHere].map(t =>
    `<button class="type-pill${t === _taskView.tag ? ' on' : ''}" onclick="setTaskTag('${escape(t)}')">${t ? '#' + escape(t) : 'All'}</button>`).join('');

  const q = _taskView.q.trim().toLowerCase();
  const hit = t => (!_taskView.tag || (t.tags || []).includes(_taskView.tag)) && (!q
    || t.title.toLowerCase().includes(q) || (t.desc || '').toLowerCase().includes(q)
    || (t.tags || []).some(g => g.toLowerCase().includes(q.replace(/^#/, ''))));
  const shown = sortTodos(open.filter(hit));

  // One chip per link. With several, "Open link" three times says nothing, so each is named by
  // its host or folder; a lone link keeps the old wording.
  const linkLabel = ({ title, url: l }, many) => {
    if (title) return title;
    if (!many) return isLocalPath(l) ? 'Open folder' : 'Open link';
    if (isLocalPath(l)) return l.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || l;
    try { return new URL(l).hostname.replace(/^www\./, ''); } catch { return l; }
  };
  const linkHtml = t => {
    const links = linksOf(t);
    if (!links.length) return '';
    return `<div class="task-link">${links.map((l, i) => isLocalPath(l.url)
      ? `<button class="link-btn" onclick="revealTodoPath('${t.id}', ${i})" title="${escape(l.url)}"><span class="msym">folder_open</span> ${escape(linkLabel(l, links.length > 1))}</button>`
      : `<a href="${escape(l.url)}" target="_blank" title="${escape(l.url)}"><span class="msym">link</span> ${escape(linkLabel(l, links.length > 1))}</a>`
    ).join('')}</div>`;
  };

  const metaFor = (t, overdue) => {
    const days = daysUntil(t.deadline);
    const base = !t.deadline ? 'No deadline'
      : days === 0 ? 'Due today!'
      : days < 0   ? `Overdue by ${Math.abs(days)} day${Math.abs(days)>1?'s':''}`
      : `${days} day${days>1?'s':''} left`;
    const course = t.courseEventId && _deadlines.find(e => e.id === t.courseEventId);
    const rep = t.repeat ? ` · <span class="repeat-tag"><span class="msym">repeat</span>${t.repeat === 'monthly' ? 'monthly' : 'weekly'}</span>` : '';
    return `${base}${rep}${t.calEventId?` · <span class="cal-tag">on calendar</span>`:''}${course
      ? ` · <span class="course-tag"><span class="cal-swatch" style="background:${evColor(course)}"></span>${escape(course._calName || '')}</span>` : ''}${stepsTag(t)}${tagChips(t)}`;
  };
  const tagChips = t => (t.tags || []).map(g => ` <button class="task-tag" onclick="setTaskTag('${escape(g)}')">#${escape(g)}</button>`).join('');
  const stepsTag = t => {
    const list = t.subtasks || [];
    if (!list.length) return '';
    const n = list.filter(s => s.done).length;
    return ` · <button class="steps-tag${n === list.length ? ' all' : ''}" onclick="toggleStepsOpen('${t.id}')">${n}/${list.length} steps</button>`;
  };
  const stepsList = t => !(t.subtasks || []).length || !_openSteps.has(t.id) ? '' : `
    <div class="task-steps">${t.subtasks.map((s, i) => `
      <label class="task-step${s.done ? ' done' : ''}"><input type="checkbox" ${s.done ? 'checked' : ''} onchange="toggleStep('${t.id}', ${i})"> ${escape(s.text)}</label>`).join('')}
    </div>`;

  // Manual order is the only order you can rearrange; dragging inside a sorted or filtered list
  // would move rows that are not next to each other in the stored list.
  const dragOK = _taskView.sort === 'manual' && !q;
  const item = t => {
    const days = daysUntil(t.deadline);
    const overdue = days !== null && days < 0;
    return `
    <div class="task-row${overdue?' urgent':''}${t.priority?' flagged':''}${dragOK?' draggable':''}"${dragOK
      ? ` draggable="true" ondragstart="taskDragStart('${t.id}',event)" ondragover="taskDragOver(event)" ondrop="taskDrop('${t.id}',event)" ondragend="taskDragEnd()"` : ''}>
      <button class="task-check${overdue?' overdue':''}" onclick="toggleTodoDone('${t.id}')" title="Mark done"></button>
      <div class="task-main">
        <div class="task-title">${escape(t.title)}</div>
        <div class="task-meta">${metaFor(t, overdue)}</div>
        ${stepsList(t)}
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
      ${_settings.snoozeDays.map(d =>
        `<button onclick="snoozeTodo('${t.id}',${d})">${snoozeLabel(d)}</button>`).join('')}
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
        <div class="task-meta">Completed ${doneAgo(t.doneAt)}${(t.subtasks || []).length ? ` · ${t.subtasks.length} steps` : ''}${tagChips(t)}</div>
      </div>
      <div class="task-actions">
        <button onclick="removeTodo('${t.id}')" title="Delete"><span class="msym">close</span></button>
      </div>
    </div>`;

  const parts = [];
  if (onDone) {
    document.getElementById('todo-list').innerHTML = doneView(done.filter(hit), doneItem, done.length);
    return;
  }
  if (shown.length) {
    parts.push(`<div class="task-list">${shown.map(item).join('')}</div>`);
  } else if (q) {
    // Naming the query is what stops an empty card reading as "you have no tasks".
    parts.push(`<div class="empty">Nothing matches “${escape(_taskView.q.trim())}”.</div>`);
  } else {
    parts.push('<div class="empty">No tasks</div>');
  }

  if (snoozed.length) {
    parts.push(`<div class="task-sub">Snoozed <span class="count-chip neutral">${snoozed.length}</span></div>
      <div class="task-list">${snoozed.map(snoozedItem).join('')}</div>`);
  }

  document.getElementById('todo-list').innerHTML = parts.join('');
  if (_deadlines.length) drawDeadlineRows();
}

// The Done tab: newest first, grouped by when they were finished, with a count for the week.
function doneView(list, row, total) {
  if (!total) return '<div class="empty">Nothing finished yet. Ticked-off tasks land here.</div>';
  if (!list.length) return '<div class="empty">Nothing matches.</div>';
  const age = t => Math.floor((new Date(getDateKey(0) + 'T00:00:00') - new Date(new Date(t.doneAt).toLocaleDateString('en-CA') + 'T00:00:00')) / 86400000);
  const groups = [['Today', a => a <= 0], ['Yesterday', a => a === 1], ['This week', a => a < 7],
                  ['Last week', a => a < 14], ['Earlier', () => true]];
  const sorted = list.slice().sort((a, b) => b.doneAt.localeCompare(a.doneAt));
  const buckets = groups.map(([name]) => [name, []]);
  for (const t of sorted) buckets[groups.findIndex(([, fits]) => fits(age(t)))][1].push(t);
  const week = sorted.filter(t => age(t) < 7).length;
  return `<div class="done-summary">${week} finished in the last 7 days
      <button class="text-btn" onclick="clearCompleted()">Clear all</button></div>`
    + buckets.filter(([, items]) => items.length).map(([name, items]) =>
      `<div class="task-sub">${name} <span class="count-chip neutral">${items.length}</span></div>
       <div class="task-list done-list">${items.map(row).join('')}</div>`).join('');
}

// The one alert that works with no permission and no setup. The reminders below can only
// speak when the page is open anyway, so this is what actually stops a date being missed.
let _dragId = null;
function taskDragStart(id, ev) { _dragId = id; ev.dataTransfer.effectAllowed = 'move'; }
function taskDragOver(ev) { if (_dragId) ev.preventDefault(); }
function taskDragEnd() { _dragId = null; }
function taskDrop(id, ev) {
  ev.preventDefault();
  if (!_dragId || _dragId === id) return;
  const todos = getTodos();
  const from = todos.findIndex(t => t.id === _dragId), to = todos.findIndex(t => t.id === id);
  _dragId = null;
  if (from < 0 || to < 0) return;
  todos.splice(to, 0, ...todos.splice(from, 1));
  putTodos(todos);
  renderTodos();
}

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

// Course deadlines (read-only, from the campus feed)
// Campus only. Pulling in every Google calendar as well made this a second copy
// of the timetable: 418 of 509 rows were recurring class meetings that the
// schedule and week cards already draw.
const DEADLINE_DAYS = 365;

// Pinned deadlines, by event id. A display preference like the hidden-calendar
// set, so it lives beside it in localStorage rather than in tasks.db.
const DEADLINE_PIN_KEY = 'attention-pinned-deadlines-v1';
let pinnedDeadlines = new Set();
try { pinnedDeadlines = new Set(JSON.parse(localStorage.getItem(DEADLINE_PIN_KEY)) || []); } catch {}

// Deadlines already written to the calendar. The fetched events answer this for anything inside
// the Search Calendar range, but a deadline months out is past it, so each add is also remembered
// here, which is what stops a second click duplicating one.
const DEADLINE_ADDED_KEY = 'attention-deadlines-on-calendar-v1';
let addedDeadlines = new Set();
try { addedDeadlines = new Set(JSON.parse(localStorage.getItem(DEADLINE_ADDED_KEY)) || []); } catch {}
const rememberAdded = () => localStorage.setItem(DEADLINE_ADDED_KEY, JSON.stringify([...addedDeadlines]));

// What createDeadlineEvent writes: the course name is in the title too, because on a calendar
// "AFL 1 is due" on its own does not say which subject it belongs to.
const deadlineEventName = e => `${e._calName ? e._calName + ': ' : ''}${e.summary || 'Course deadline'}`;

function deadlineOnCalendar(e) {
  if (addedDeadlines.has(e.id)) return true;
  const ymd = deadlineYmd(e);
  // The second form is what was written before the course name was added, and is still a duplicate.
  // Events written by older versions start with a pin emoji and put an em dash (\u2014) after the
  // course name, so those count as duplicates too.
  const titles = [deadlineEventName(e), e.summary || 'Course deadline', e._calName ? `${e._calName} \u2014 ${e.summary || 'Course deadline'}` : null].filter(Boolean);
  const want = titles.flatMap(t => [`Deadline: ${t}`, `\u{1F4CC} Deadline: ${t}`]);
  // And whatever the title template in Settings makes of it now.
  want.push(deadlineEventTitle(deadlineEventName(e), { task: e.summary || 'Course deadline', course: e._calName }));
  return _upcoming.some(g => !String(g.id).startsWith('moodle-')
    && (g.start?.dateTime || g.start?.date || '').slice(0, 10) === ymd
    && want.includes(g.summary || ''));
}

// Course deadlines marked as handed in. eLearn's calendar feed carries no submission status, so
// this is by hand, kept on the server so its reminders stop for them too.
let submittedDeadlines = new Set();
const isDeadlineDone = e => submittedDeadlines.has(e.id)
  || getTodos().some(t => t.courseEventId === e.id && t.doneAt);

function toggleSubmitted(i) {
  const e = _deadlineRows[i];
  if (!e) return;
  const was = submittedDeadlines.has(e.id);
  was ? submittedDeadlines.delete(e.id) : submittedDeadlines.add(e.id);
  drawDeadlineRows();
  putReminders({ doneDeadlines: [...submittedDeadlines] })
    .catch(() => showToast('Could not save that to the server', null, 5));
  showToast(`"${shortTitle(deadlineTitle(e))}" ${was ? 'marked not submitted' : 'marked submitted'}`, () => toggleSubmitted(_deadlineRows.indexOf(e)), 6);
}

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
  const task = getTodos().find(t => t.courseEventId === e.id);
  const onCal = deadlineOnCalendar(e);
  const left = days === null ? '' : overdue ? `Overdue by ${Math.abs(days)} day${Math.abs(days) > 1 ? 's' : ''}`
    : days === 0 ? 'Due today' : `${days} day${days > 1 ? 's' : ''} left`;
  return `
  <div class="task-row${isDeadlineDone(e) ? ' completed' : overdue ? ' urgent' : ''}${isPinned ? ' pinned' : ''}">
    <div class="task-main">
      <div class="task-title">${escape(e.summary || '(No title)')}</div>
      <div class="task-meta course-meta">
        <span class="cal-swatch" style="background:${evColor(e)}"></span>
        <span>${escape(e._calName || '')}${left ? ' · ' + left : ''}</span>
        ${submittedDeadlines.has(e.id) ? '<span class="cal-tag">· submitted</span>'
          : task ? `<span class="cal-tag">· ${task.doneAt ? 'task done' : 'in tasks'}</span>` : ''}
      </div>
    </div>
    ${dueChip(ymd)}
    <div class="task-actions">
      <button onclick="toggleSubmitted(${i})" title="${submittedDeadlines.has(e.id) ? 'Mark not submitted' : 'Mark submitted'}"
        ><span class="msym">${submittedDeadlines.has(e.id) ? 'check_circle' : 'task'}</span></button>
      <button onclick="toggleDeadlinePin(${i})" title="${isPinned ? 'Unpin' : 'Pin to top'}"
        ><span class="msym">${isPinned ? 'star' : 'star_border'}</span></button>
      <button onclick="deadlineTask(${i})" title="${task ? 'Edit linked task' : 'Add to Tasks'}"
        ><span class="msym">${task ? 'task_alt' : 'add_task'}</span></button>
      <button onclick="addDeadlineToCalendar(${i})" ${onCal ? 'disabled' : ''}
        title="${onCal ? 'Already on your calendar' : 'Add to Google Calendar'}"
        ><span class="msym">${onCal ? 'event_available' : 'calendar_add_on'}</span></button>
    </div>
  </div>`;
}

// Pinned first, then soonest. Sorting happens at draw time so a pin re-sorts
// without another round-trip.
function drawDeadlineRows() {
  const list = document.getElementById('deadline-list');
  // Ticking a linked task re-renders the task list, which redraws these rows, so the count
  // belongs here rather than in the loader, or it would stay stale until the next refresh.
  document.getElementById('deadline-count').textContent =
    _deadlines.filter(e => !isDeadlineDone(e)).length;
  // Anything whose linked task is ticked off sinks to the bottom: it is still due, but it is
  // not what the card is for any more.
  const doneRank = e => isDeadlineDone(e) ? 1 : 0;
  _deadlineRows = _deadlines.slice().sort((a, b) => {
    const da = doneRank(a), db = doneRank(b);
    if (da !== db) return da - db;
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
  if (!googleAccounts().length) { showToast('Connect a Google account first, then add deadlines to its calendar', null, 6); return; }
  if (deadlineOnCalendar(e)) { showToast('That deadline is already on your calendar', null, 4); return; }
  const ymd = (e.start?.dateTime || e.start?.date || '').slice(0, 10);
  const name = deadlineEventName(e);
  const short = name.length > 28 ? name.slice(0, 28) + '…' : name;
  try {
    const { id, acct, calId } = await createDeadlineEvent(name, ymd, deadlineHhmm(e) || _settings.deadlineTime,
      { task: e.summary || 'Course deadline', course: e._calName, link: e.htmlLink });
    addedDeadlines.add(e.id);
    rememberAdded();
    drawDeadlineRows();
    showToast(`Added "${short}" to your calendar`, () => {
      deleteCalendarEvent(id, acct, calId);
      addedDeadlines.delete(e.id);
      rememberAdded();
      drawDeadlineRows();
      showToast('Removed from calendar', null, 4);
    }, 8);
  } catch (err) {
    showToast(`Couldn't add to calendar: ${err.message}`, null, 6);
  }
}

// Moodle titles read "AFL 1 is due"; the course chip already says whose it is.
const deadlineTitle = e => (e.summary || 'Course deadline').replace(/ is due$/, '');
const deadlineYmd = e => (e.start?.dateTime || e.start?.date || '').slice(0, 10);
const deadlineHhmm = e => e.start?.dateTime ? formatTime(e.start.dateTime) : null;

function deadlineTask(i) {
  const e = _deadlineRows[i];
  if (!e) return;
  const linked = getTodos().find(t => t.courseEventId === e.id);
  if (linked) return openEditModal(linked.id);
  const id = Date.now().toString();
  const title = deadlineTitle(e);
  putTodos([...getTodos(), { id, title, desc: null, link: e.htmlLink ? linkLine({ title: 'eLearn', url: e.htmlLink }) : null, deadline: deadlineYmd(e), courseEventId: e.id }]);
  renderTodos();
  showToast(`Added "${shortTitle(title)}" to Tasks`, () => {
    putTodos(getTodos().filter(t => t.id !== id));
    renderTodos();
    hideToast();
  }, 6);
}

// A linked, still-open task follows its deadline when the course moves it.
function syncLinkedDeadlines() {
  const todos = getTodos();
  let changed = false;
  for (const t of todos) {
    const e = !t.doneAt && t.courseEventId && _deadlines.find(e => e.id === t.courseEventId);
    if (e && deadlineYmd(e) && t.deadline !== deadlineYmd(e)) { t.deadline = deadlineYmd(e); changed = true; }
  }
  if (changed) putTodos(todos);
  renderTodos();
}

function onCourseLinkChange(id) {
  const e = _deadlines.find(e => e.id === id);
  if (!e) return;
  const title = document.getElementById('todo-modal-title');
  if (!title.value.trim()) title.value = deadlineTitle(e);
  document.getElementById('todo-modal-deadline').value = deadlineText(deadlineYmd(e));
  paintDeadlinePreview();
  if (!getModalLinks().length && e.htmlLink) setModalLinks([{ title: 'eLearn', url: e.htmlLink }]);
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
    trackChanges('moodle', _deadlines, getDateKey(0), getDateKey(DEADLINE_DAYS));
    drawDeadlineRows();
    syncLinkedDeadlines();
  } catch (err) {
    count.textContent = '!';
    list.innerHTML = `<div class="error">Could not load deadlines: ${escape(err.message)}</div>`;
  }
}

// Completing a task keeps it. It used to delete it outright, which is exactly why nothing
// could ever be shown as completed afterwards: the record was gone. This also marks it done
// rather than throwing it away, so the checkbox reopens.
//
// The linked calendar event is deliberately left alone: ticking a checkbox should not quietly
// delete something off your calendar. Deleting the task still cleans the event up, which is
// where that was always meant to happen.
// The next date of a repeating task, counted from its deadline (or today if it has none), so a
// weekly task ticked off late still lands on its usual day rather than drifting.
function nextRepeat(ymd, repeat) {
  const base = new Date((ymd || getDateKey(0)) + 'T12:00:00Z');
  const day = base.getUTCDate();   // kept, so the 31st does not decay into the 28th
  do {
    if (repeat !== 'monthly') { base.setUTCDate(base.getUTCDate() + 7); continue; }
    base.setUTCDate(1);
    base.setUTCMonth(base.getUTCMonth() + 1);
    const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    base.setUTCDate(Math.min(day, last));   // a month without a 31st gets its last day
  } while (base.toISOString().slice(0, 10) < getDateKey(0));
  return base.toISOString().slice(0, 10);
}

function toggleTodoDone(id) {
  const todos = getTodos();
  const t = todos.find(x => x.id === id);
  if (!t) return;
  if (t.repeat && !t.doneAt) {
    const was = t.deadline;
    t.deadline = nextRepeat(t.deadline, t.repeat);
    t.snoozeUntil = null;
    const steps = t.subtasks;
    t.subtasks = (steps || []).map(s => ({ ...s, done: false }));   // the next round starts fresh
    putTodos(todos);
    renderTodos();
    showToast(`"${shortTitle(t.title)}" done. Next one on ${whenLabel(t.deadline)}`,
      () => { t.deadline = was; t.subtasks = steps; putTodos(getTodos()); renderTodos(); hideToast(); }, 6);
    return;
  }
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
      deleteCalendarEvent(_undoStack.todo.calEventId, _undoStack.todo.calAcct, _undoStack.todo.calId);
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
let _toastHideTimer = null;

function showToast(msg, undoFn, sec = 10) {
  _toastSeq++;
  _toastUndoFn = undoFn;
  document.getElementById('toast-msg').textContent = msg;
  // Plain notices (errors) get no Undo button, since it would do nothing.
  document.querySelector('.toast-undo').style.display = undoFn ? '' : 'none';
  const bar = document.getElementById('toast-bar');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  document.getElementById('toast').classList.add('show');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = `width ${sec}s linear`;
    bar.style.width = '0%';
  }));
  // The bar only drew the countdown; nothing ever ended it, so every toast without its own
  // timer stayed up for good. Guarded by the sequence number so a newer toast is not cut short.
  const mine = _toastSeq;
  clearTimeout(_toastHideTimer);
  _toastHideTimer = setTimeout(() => { if (_toastSeq === mine) hideToast(); }, sec * 1000);
}
function hideToast() {
  document.getElementById('toast').classList.remove('show');
  _toastUndoFn = null;
}

// Add / Edit Todo Modal
let _saving = false;
let _editingId = null;

// Steps being edited in the task window; saved with the task.
let _modalSteps = [];
function paintModalSteps() {
  document.getElementById('todo-modal-steps').innerHTML = _modalSteps.map((s, i) => `
    <div class="step-row">
      <input type="checkbox" ${s.done ? 'checked' : ''} onchange="_modalSteps[${i}].done = this.checked">
      <input class="todo-input step-text" value="${escape(s.text)}" oninput="_modalSteps[${i}].text = this.value">
      <button type="button" class="icon-btn" onclick="_modalSteps.splice(${i}, 1); paintModalSteps()" title="Remove step"><span class="msym">close</span></button>
    </div>`).join('');
}
function addModalStep(text) {
  if (!text.trim()) return;
  _modalSteps.push({ text: text.trim(), done: false });
  paintModalSteps();
}
const allTags = () => [...new Set(getTodos().flatMap(t => t.tags || []))].sort((a, b) => a.localeCompare(b));
const parseTags = v => [...new Set(v.split(/[,\s]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean))];

function _openModal(heading, saveLabel, title='', desc='', link='', deadline='', calChecked=false, courseEventId=null, repeat='', tags=[], steps=[]) {
  _saving = false;
  _modalSteps = steps.map(s => ({ ...s }));
  paintModalSteps();
  document.getElementById('todo-modal-step').value = '';
  document.getElementById('todo-modal-tags').value = tags.join(', ');
  document.getElementById('todo-tag-list').innerHTML = allTags().map(t => `<option value="${escape(t)}">`).join('');
  document.getElementById('todo-modal-heading').textContent  = heading;
  document.getElementById('todo-modal-title').value          = title;
  document.getElementById('todo-modal-desc').value           = desc || '';
  setModalLinks(linksOf({ link }));
  document.getElementById('todo-modal-deadline').value       = deadlineText(deadline);
  paintDeadlinePreview();
  // Nowhere to write a reminder without a Google account, so say so instead of failing on save.
  const canCal = googleAccounts().length > 0;
  document.getElementById('todo-modal-cal').checked          = calChecked && canCal;
  document.getElementById('todo-modal-cal').disabled         = !canCal;
  document.getElementById('todo-modal-cal-label').textContent = canCal
    ? 'Add deadline reminder to Google Calendar'
    : 'Connect a Google account to add deadline reminders';
  document.getElementById('todo-modal-repeat').value         = repeat || '';
  // A deadline that has left the feed (past, or the course dropped it) keeps its link.
  const opts = _deadlines.slice().sort((a, b) => deadlineYmd(a).localeCompare(deadlineYmd(b)))
    .map(e => [e.id, `${e._calName || 'Course'} · ${deadlineTitle(e)} · ${relDayLabel(deadlineYmd(e))}`]);
  if (courseEventId && !opts.some(([id]) => id === courseEventId)) opts.unshift([courseEventId, 'Linked deadline (no longer in the feed)']);
  const sel = document.getElementById('todo-modal-course');
  sel.innerHTML = '<option value="">None</option>'
    + opts.map(([id, label]) => `<option value="${escape(id)}">${escape(label)}</option>`).join('');
  sel.value = courseEventId || '';
  document.getElementById('todo-modal-err').textContent      = '';
  document.getElementById('todo-save-btn').textContent       = saveLabel;
  document.getElementById('todo-overlay').classList.add('open');
  setTimeout(() => document.getElementById('todo-modal-title').focus(), 80);
}

// A typed deadline instead of <input type="date">: Safari's date field shows this month and year
// in grey as a mere hint, so typing only the day saved nothing. Whatever is left out is filled
// from today, rolling forward if that date has already passed ("5" on the 17th is next month's 5th).
// Returns YYYY-MM-DD, '' for empty, or null when it is not a real date.
function parseDeadline(v) {
  v = String(v || '').trim();
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})(?:\s*[\/.\- ]\s*(\d{1,2})(?:\s*[\/.\- ]\s*(\d{2}|\d{4}))?)?$/);
  if (!m) return null;
  const today = getDateKey(0);
  let [y, mo] = today.split('-').map(Number);
  const d = Number(m[1]);
  if (m[2]) mo = Number(m[2]);
  if (m[3]) y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const ymd = () => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const real = () => { const dt = new Date(Date.UTC(y, mo - 1, d)); return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d; };
  if (!m[3] && m[2] && ymd() < today) y++;
  // Day only: the next month that has that day ("31" in September is 31 October).
  for (let i = 0; !m[2] && i < 3 && (!real() || ymd() < today); i++) {
    if (++mo > 12) { mo = 1; y++; }
  }
  return real() ? ymd() : null;
}
const deadlineText = ymd => ymd ? ymd.split('-').reverse().map(Number).join('/') : '';

function paintDeadlinePreview() {
  const ymd = parseDeadline(document.getElementById('todo-modal-deadline').value);
  const el = document.getElementById('todo-modal-deadline-preview');
  el.classList.toggle('bad', ymd === null);
  el.textContent = ymd === null ? 'Not a date. Try 20, 20/9 or 20/9/2026'
    : ymd ? `${whenLabel(ymd)} ${ymd.slice(0, 4)} · ${daysUntil(ymd) === 0 ? 'today' : daysUntil(ymd) === 1 ? 'tomorrow' : `in ${daysUntil(ymd)} days`}`
    : '';
}

function openTodoModal() {
  _editingId = null;
  // Everything here comes from Settings → New task defaults; the calendar tick does nothing
  // unless a deadline is actually set (see saveTodo).
  const days = _settings.newTaskDeadline;
  _openModal('New Task', 'Save Task', '', '', '',
    days === '' ? '' : getDateKey(Number(days)), _settings.newTaskCal, null, _settings.newTaskRepeat);
}

function openEditModal(id) {
  const t = getTodos().find(x => x.id === id);
  if (!t) return;
  _editingId = id;
  _openModal('Edit Task', 'Update Task', t.title, t.desc, t.link, t.deadline, !!t.calEventId, t.courseEventId, t.repeat, t.tags || [], t.subtasks || []);
}

function closeTodoModal() {
  document.getElementById('todo-overlay').classList.remove('open');
  _saving = false;
  _editingId = null;
}

// A task made from a course deadline carries that course's name, and its real due time.
const courseOf = id => (id && _deadlines.find(e => e.id === id)) || null;
function calendarTitleFor(title, courseEventId) {
  const course = courseOf(courseEventId);
  return course?._calName ? `${course._calName}: ${title}` : title;
}
const eventExtra = (title, courseEventId, notes, link) => ({ task: title, course: courseOf(courseEventId)?._calName, notes, link });
const calendarTimeFor = courseEventId =>
  deadlineHhmm(courseOf(courseEventId) || {}) || _settings.deadlineTime;

async function saveTodo() {
  if (_saving) return;
  const title    = document.getElementById('todo-modal-title').value.trim();
  const desc     = document.getElementById('todo-modal-desc').value.trim() || null;
  const link     = getModalLinks().map(linkLine).join('\n') || null;
  const parsed   = parseDeadline(document.getElementById('todo-modal-deadline').value);
  const deadline = parsed || null;
  const courseEventId = document.getElementById('todo-modal-course').value || null;
  const repeat = document.getElementById('todo-modal-repeat').value || null;
  const tags = parseTags(document.getElementById('todo-modal-tags').value);
  const pending = document.getElementById('todo-modal-step').value.trim();   // typed but not Entered
  const subtasks = [..._modalSteps, ...(pending ? [{ text: pending, done: false }] : [])]
    .map(s => ({ text: s.text.trim(), done: !!s.done })).filter(s => s.text);
  const addCal   = document.getElementById('todo-modal-cal').checked && !!deadline;
  const errEl    = document.getElementById('todo-modal-err');
  const btn      = document.getElementById('todo-save-btn');

  if (!title) { errEl.textContent = 'Please enter a task title.'; return; }
  if (parsed === null) { errEl.textContent = 'The deadline is not a date. Try 20, 20/9 or 20/9/2026.'; return; }
  errEl.textContent = '';
  _saving = true;
  btn.textContent = 'Saving…';

  const todos = getTodos();

  if (_editingId) {
    // Edit existing
    const t = todos.find(x => x.id === _editingId);
    if (t) {
      t.title    = title;
      t.desc     = desc;
      t.link     = link;
      t.deadline = deadline;
      t.courseEventId = courseEventId;
      t.repeat = repeat;
      t.tags = tags;
      t.subtasks = subtasks;
      // If cal was checked but no event yet, create one
      if (addCal && !t.calEventId && deadline) {
        try {
          const ev = await createDeadlineEvent(calendarTitleFor(title, courseEventId), deadline, calendarTimeFor(courseEventId), eventExtra(title, courseEventId, desc, link));
          t.calEventId = ev.id;
          t.calAcct = ev.acct;
          t.calId = ev.calId;
        } catch(e) { showToast(`Changes saved, but the calendar reminder failed: ${e.message}`, null, 7); }
      }
    }
    putTodos(todos);
    renderTodos();
    closeTodoModal();
    return;
  }

  // Add new
  let calEventId = null, calAcct = null, calId = null;
  if (addCal) {
    try {
      const ev = await createDeadlineEvent(calendarTitleFor(title, courseEventId), deadline, calendarTimeFor(courseEventId), eventExtra(title, courseEventId, desc, link));
      calEventId = ev.id;
      calAcct = ev.acct;
      calId = ev.calId;
    } catch(e) { showToast(`Task saved, but the calendar reminder failed: ${e.message}`, null, 7); }
  }

  todos.push({ id: Date.now().toString(), title, desc, link, deadline, calEventId, calAcct, calId, courseEventId, repeat, tags, subtasks, done: false });
  putTodos(todos);
  renderTodos();
  closeTodoModal();
}

// Loading states
function setLoading() {
  ['event-count','week-count'].forEach(id => document.getElementById(id).innerHTML='<span class="spinner"></span>');
  ['event-list','week-list'].forEach(id => document.getElementById(id).innerHTML='<div class="loading"><span class="spinner"></span></div>');
  document.getElementById('rsvp-card').style.display='none';
  document.getElementById('cd-days').innerHTML='<span class="spinner"></span>';
  document.getElementById('cd-name').textContent='–';
  document.getElementById('cd-sub').textContent='–';
  document.querySelectorAll('.reload-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
}

function setDone() {
  document.getElementById('refreshed-at').textContent =
    clockTime(new Date());
  document.querySelectorAll('.reload-btn').forEach(b => { b.disabled = false; b.style.opacity = '1'; });
}

// Reload
async function reload() {
  if (!accounts.length) {
    showDisconnected();
    // Campus is a separate feed with its own empty state, so it renders either way.
    renderDeadlines();
    return;
  }
  setLoading();
  _evRegistry = {};   // fresh render, drop the previous keys (shared by every card that lists events)
  // One request per calendar for both the week and Search Calendar: its range (7 to 90 days)
  // always includes the week, so fetching them separately asked Google twice for the same days.
  const shared = fetchRange(getDateKey(0), getDateKey(Math.max(6, Number(_upView.days) || 30)), _calErrors, 250);
  await Promise.allSettled([
    loadUpcoming(shared),
    // Picks up tasks added from outside the UI (e.g. an agent posting to /api/todos)
    loadTodos().then(renderTodos),
    loadEvents(shared).catch(err => {
      document.getElementById('event-list').innerHTML=`<div class="error">Could not load your calendar: ${escape(err.message)}</div>`;
      document.getElementById('event-count').textContent='!';
    }),
    renderDeadlines(),   // handles its own errors, so one bad feed can't sink the rest
  ]);
  setDone();
}

// Due reminders
// Opt-in: nothing fires until the bell is clicked. The server does the checking every 20
// minutes and posts macOS notifications, so they arrive with the dashboard closed.
const REMIND_KEY = 'attention-reminders-v1';   // legacy page-side switch, migrated below
let _remindersOn = false;

function putReminders(prefs) {
  return api('/api/reminders', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prefs),
  });
}

async function loadReminders() {
  try {
    let r = await api('/api/reminders');
    // Turned on back when the page did the checking: carry it over once.
    if (!r.on && localStorage.getItem(REMIND_KEY) === 'on') r = await putReminders({ on: true, aheadDays: _settings.remindAheadDays });
    localStorage.removeItem(REMIND_KEY);
    _remindersOn = r.on;
    submittedDeadlines = new Set(r.doneDeadlines || []);
    if (_deadlines.length) drawDeadlineRows();
    paintReminderBtn();
    // First load after a restart: hand the server the reminders and hour it cannot read itself.
    putReminders({ days: _dayReminders, dayHour: _settings.dayReminderHour, aheadDays: _settings.remindAheadDays }).catch(() => {});
  } catch { /* server unreachable: the button just stays off */ }
}

function paintReminderBtn() {
  const btn = document.getElementById('reminder-btn');
  if (!btn) return;
  btn.classList.toggle('on', _remindersOn);
  btn.querySelector('.msym').textContent = _remindersOn ? 'notifications_active' : 'notifications_none';
  btn.title = _remindersOn ? 'Reminders on. Click to mute' : 'Remind me about tasks that are due';
}

async function toggleReminders() {
  try {
    const r = await putReminders({ on: !_remindersOn, aheadDays: _settings.remindAheadDays });
    _remindersOn = r.on;
  } catch (err) { showToast(`Could not change reminders: ${err.message}`, null, 6); return; }
  paintReminderBtn();
  showToast(_remindersOn
    ? `Reminders on, even with the dashboard closed. ${_platform.notifyHint}`
    : 'Reminders muted', null, _remindersOn ? 10 : 4);
}

// Notifications
// Calendars give no "what changed" feed that covers Moodle too, so each load is compared with
// the previous one's snapshot. Kept in localStorage: it only means anything to this browser.
const NOTIF_KEY = 'attention-notifications-v1';
const SNAP_KEY  = 'attention-event-snapshot-v1-';
const MAX_NOTIFS = 100;
let _notifs = [];
try { _notifs = JSON.parse(localStorage.getItem(NOTIF_KEY)) || []; } catch {}
const saveNotifs = () => localStorage.setItem(NOTIF_KEY, JSON.stringify(_notifs));

// Absolute rather than "Tomorrow": the notification outlives the day it was written.
function whenLabel(t) {
  const allDay = t.length <= 10;
  return new Date(allDay ? t + 'T12:00:00' : t)
    .toLocaleDateString('en-ID', { weekday:'short', day:'numeric', month:'short', timeZone: TZ })
    + (allDay ? '' : ' ' + formatTime(t));
}

function agoLabel(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : doneAgo(iso);
}

// ponytail: capped at 50 events per calendar by fetchRange; a calendar busier than that in
// the window can report phantom adds/removals at the cut. Raise maxResults if that happens.
function trackChanges(scope, events, startYmd, endYmd) {
  const cals = accounts.flatMap(a => shownCalendars(a).map(c => calKey(a.email, c.id)));
  const ev = {};
  for (const e of events) {
    ev[e.id] = { s: e.summary || '(No title)', t: e.start?.dateTime || e.start?.date || '', c: calKey(e._acct, e._calId) };
  }
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(SNAP_KEY + scope)); } catch {}
  localStorage.setItem(SNAP_KEY + scope, JSON.stringify({ end: endYmd, cals, ev }));
  if (!prev) return;   // first look: everything would be "added", which tells you nothing

  const oldCals = new Set(prev.cals), nowCals = new Set(cals);
  const found = [];
  for (const [id, n] of Object.entries(ev)) {
    const o = prev.ev[id];
    if (!o) {
      // Unseen is not the same as new: the window slid forward onto it, or its calendar
      // was only just switched on.
      if (n.t.slice(0, 10) <= prev.end && oldCals.has(n.c)) found.push({ kind: 'added', title: n.s, detail: whenLabel(n.t), eventId: id });
    } else if (o.t !== n.t) {
      found.push({ kind: 'updated', title: n.s, detail: `Moved from ${whenLabel(o.t)} to ${whenLabel(n.t)}` });
    } else if (o.s !== n.s) {
      found.push({ kind: 'updated', title: n.s, detail: `Renamed from "${o.s}"` });
    }
  }
  for (const [id, o] of Object.entries(prev.ev)) {
    const ymd = o.t.slice(0, 10);
    // Likewise gone is not deleted: it may have slid out of the window or been hidden.
    if (!ev[id] && ymd >= startYmd && ymd <= endYmd && nowCals.has(o.c)) {
      found.push({ kind: 'removed', title: o.s, detail: whenLabel(o.t) });
    }
  }
  if (scope === 'moodle' && _settings.autoTaskDeadlines) autoTaskDeadlines(found);
  if (!found.length) return;
  const at = new Date().toISOString();
  _notifs = [...found.map(f => ({ ...f, id: at + Math.random().toString(36).slice(2, 7), at, read: false })), ..._notifs]
    .slice(0, MAX_NOTIFS);
  saveNotifs();
  renderNotifs();
}

// Optional (Settings): a deadline the course only just posted becomes a task by itself.
function autoTaskDeadlines(found) {
  const added = found.filter(f => f.kind === 'added' && f.eventId);
  if (!added.length) return;
  const todos = getTodos();
  const fresh = added.filter(f => !todos.some(t => t.courseEventId === f.eventId));
  if (!fresh.length) return;
  for (const f of fresh) {
    const e = _deadlines.find(e => e.id === f.eventId);
    todos.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: deadlineTitle(e || { summary: f.title }),
                 desc: null, link: e?.htmlLink ? linkLine({ title: 'eLearn', url: e.htmlLink }) : null, deadline: e ? deadlineYmd(e) : null, courseEventId: f.eventId });
  }
  putTodos(todos);
  renderTodos();
  showToast(`${fresh.length} new course deadline${fresh.length > 1 ? 's' : ''} added to Tasks`, null, 6);
}

function renderNotifs() {
  const unread = _notifs.filter(n => !n.read).length;
  document.querySelectorAll('.notif-badge').forEach(b => {
    b.textContent = unread > 99 ? '99+' : unread;
    b.hidden = !unread;
  });
  document.getElementById('notif-list').innerHTML = _notifs.length
    ? _notifs.map(n => `
      <div class="notif-row${n.read ? ' read' : ''}">
        <span class="notif-kind ${n.kind}">${n.kind}</span>
        <div class="notif-main">
          <div class="notif-title">${escape(n.title)}</div>
          <div class="notif-detail">${escape(n.detail)} · ${agoLabel(n.at)}</div>
        </div>
        ${n.read ? '' : `<button class="icon-btn" title="Mark read" onclick="markNotifRead('${n.id}')"><span class="msym">check</span></button>`}
      </div>`).join('')
    : '<div class="empty">Nothing new. Added, moved and removed events show up here.</div>';
}

function toggleNotifs() {
  const panel = document.getElementById('notif-panel');
  if (panel.classList.toggle('open')) renderNotifs();   // refreshes the "5m ago" labels
}
// Click anywhere else closes it, like any other dropdown.
document.addEventListener('click', e => {
  // composedPath, not target.closest: "mark read" re-renders the list, detaching the clicked button.
  const inside = e.composedPath().some(el => el.id === 'notif-panel' || el.classList?.contains('notif-btn'));
  if (!inside) document.getElementById('notif-panel').classList.remove('open');
});

function markNotifRead(id) {
  const n = _notifs.find(n => n.id === id);
  if (n) n.read = true;
  saveNotifs(); renderNotifs();
}
function markAllNotifsRead() { _notifs.forEach(n => { n.read = true; }); saveNotifs(); renderNotifs(); }
function clearReadNotifs()   { _notifs = _notifs.filter(n => !n.read); saveNotifs(); renderNotifs(); }

// Day reminders
// `day` is a weekday "0"–"6" (every week) or a YYYY-MM-DD (once).
const DAY_REMINDERS_KEY = 'attention-day-reminders-v1';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let _dayReminders = [];
try { _dayReminders = JSON.parse(localStorage.getItem(DAY_REMINDERS_KEY)) || []; } catch {}
_dayReminders = _dayReminders.filter(r => r.day.length === 1 || r.day >= getDateKey(0));   // drop past one-offs
const saveDayReminders = () => {
  localStorage.setItem(DAY_REMINDERS_KEY, JSON.stringify(_dayReminders));
  putReminders({ days: _dayReminders }).catch(() => {});   // the server sends them in the morning
};

const weekdayOf = ymd => new Date(ymd + 'T12:00:00').getDay();
const remindersFor = ymd => _dayReminders.filter(r => r.day === ymd || r.day === String(weekdayOf(ymd)));
const reminderDayLabel = day => day.length === 1 ? `Every ${WEEKDAYS[day]}` : whenLabel(day);

function renderDayStrip() {
  const today = remindersFor(getDateKey(0)), tomorrow = remindersFor(getDateKey(1));
  const el = document.getElementById('day-strip');
  el.hidden = !today.length && !tomorrow.length;
  el.innerHTML = `<span class="msym">push_pin</span>`
    + (today.length ? `<strong>${WEEKDAYS[weekdayOf(getDateKey(0))]}</strong>`
        + today.map(r => `<span class="day-chip">${escape(r.text)}</span>`).join('') : '')
    + (tomorrow.length ? `<span class="day-strip-next">Tomorrow</span>`
        + tomorrow.map(r => `<span class="day-chip next">${escape(r.text)}</span>`).join('') : '');
}

function renderDayReminderSettings() {
  document.getElementById('dr-list').innerHTML = _dayReminders.length
    ? _dayReminders.map(r => `
      <div class="dr-row">
        <span class="dr-day">${reminderDayLabel(r.day)}</span>
        <span class="dr-text">${escape(r.text)}</span>
        <button class="icon-btn" title="Delete reminder" onclick="removeDayReminder('${r.id}')"><span class="msym">close</span></button>
      </div>`).join('')
    : '<div class="settings-hint">No reminders yet.</div>';
}

function addDayReminder() {
  const sel = document.getElementById('dr-day').value;
  const day = sel === 'date' ? document.getElementById('dr-date').value : sel;
  const textEl = document.getElementById('dr-text');
  const text = textEl.value.trim();
  if (!text) { textEl.focus(); return; }
  if (!day) { showToast('Pick a date for the reminder', null, 4); return; }
  if (day.length > 1 && day < getDateKey(0)) { showToast('That date has already passed', null, 4); return; }
  _dayReminders.push({ id: Date.now().toString(36), day, text });
  saveDayReminders();
  textEl.value = '';
  renderDayReminderSettings();
  renderDayStrip();
}

function removeDayReminder(id) {
  _dayReminders = _dayReminders.filter(r => r.id !== id);
  saveDayReminders();
  renderDayReminderSettings();
  renderDayStrip();
}

// Keyboard shortcuts (? lists them). Off while typing in a field, so N and / stay letters;
// Esc works everywhere and closes the topmost thing that is open.
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const open = id => document.getElementById(id).classList.contains('open');
  const close = id => document.getElementById(id).classList.remove('open');
  if (e.key === 'Escape') {
    if (open('keys-overlay')) close('keys-overlay');
    else if (open('todo-overlay')) closeTodoModal();
    else if (open('settings-overlay')) closeSettings();
    else if (open('month-overlay')) closeMonth();
    else if (open('notif-panel')) toggleNotifs();
    else return;
    e.preventDefault();
    return;
  }
  const t = e.target;
  if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
  if (['todo-overlay', 'settings-overlay', 'keys-overlay'].some(open)) return;
  const act = {
    n: () => openTodoModal(),
    q: () => { goToday(); if (_taskView.tab !== 'todo') setTaskTab('todo'); const f = document.getElementById('quick-add'); f.scrollIntoView({ block: 'center' }); f.focus(); },
    '/': () => { goToday(); const s = document.getElementById('todo-search'); s.scrollIntoView({ block: 'center' }); s.focus(); },
    t: () => goToday(),
    m: () => open('month-overlay') ? closeMonth() : openMonth(),
    ',': () => openSettings(),
    r: () => reload(),
    '?': () => document.getElementById('keys-overlay').classList.add('open'),
  }[e.key.toLowerCase()];
  if (!act) return;
  e.preventDefault();
  act();
});

// Init
setGreeting();
loadProfile();
startClock();
updateDayProgress();
setInterval(() => { updateDayProgress(); tickNowLines(); }, 60000);
loadTodos().then(renderTodos);
restoreAccounts();

// Reflect what was stored last visit into the controls, and start the reminder loop. Set
// once here rather than inside renderTodos: writing to a focused input on every keystroke
// would fight the caret.
document.getElementById('todo-search').value = _taskView.q;
document.getElementById('todo-sort').value = _taskView.sort;
if (_taskView.q) document.getElementById('todo-search').focus();
paintReminderBtn();
document.documentElement.style.setProperty('--nowline-alpha', String(_settings.nowLineAlpha));
renderNotifs();
renderDayStrip();
setInterval(renderDayStrip, 60000);          // rolls over at midnight
setInterval(reload, 10 * 60 * 1000);         // so calendar changes reach the notifications unasked
paintSettings();          // reflects the stored window onto the donut's tooltip
loadReminders();
