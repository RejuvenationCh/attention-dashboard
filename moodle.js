// Moodle (eLearn UC) calendar feed → events shaped like Google Calendar's.
//
// Moodle's export endpoint (calendar/export_execute.php) authenticates on
// userid+authtoken alone — it sets NO_MOODLE_COOKIES — so this server can pull
// it directly with no session. It emits one VEVENT per occurrence (repeat
// instances are already separate rows in Moodle's DB) and writes no VTIMEZONE
// and no TZID, which is why the parser below is small. See
// MOODLE_405_STABLE/calendar/export_execute.php.
//
// The browser can never fetch this itself: no CORS headers, and the authtoken
// must not leave this machine.
const fs = require('node:fs');

const FEED_TTL = 10 * 60 * 1000;      // refetch at most every 10 min
const FAIL_TTL = 60 * 1000;           // don't retry-storm a campus that is down

const SITE_NAME = 'eLearn UC';
const ACCT = 'moodle';                // pseudo-account id; also the _acct on events

// Moodle's ICS carries only the course *shortname* ("20261_IMT01303305-A") — there
// is no fullname field, and every page that would show one is behind the campus
// login, so the readable name cannot be fetched. It comes from courses.json at the
// project root instead: a shortname → name table. A file rather than a .env entry
// because it is a mapping, not a secret. Lookups accept the full shortname or the
// term-stripped code ("IMT01303305-A") — the "<term>_" prefix changes every
// semester, so the stripped form is what survives. Unmapped courses show the
// shortname, which is what the card did before the table existed.
const NAMES_PATH = __dirname + '/courses.json';

function readNames() {
  try { return JSON.parse(fs.readFileSync(NAMES_PATH, 'utf8')); } catch { return {}; }
}

const displayName = (course, names) =>
  names[course] || names[course.replace(/^\d+_/, '')] || course;

// The dashboard's own timezone (see `TZ` in public/app.js). Indonesia has no
// DST, so a fixed offset matches every other date calculation in the app.
// ponytail: fixed offset — swap for Intl.DateTimeFormat boundaries if this ever
// runs somewhere that observes DST.
const APP_OFFSET = '+08:00';
const APP_OFFSET_MS = 8 * 3600 * 1000;

// Per-course colours. Moodle exports none, so courses get one each in a stable
// order; `calendars[].color` is what evColor() reads.
const PALETTE = ['#3b82f6', '#7c3aed', '#0d9488', '#e11d48', '#d97706', '#0891b2', '#65a30d', '#c026d3'];

const configured = () => !!process.env.MOODLE_ICS_URL;

// 2026-09-15T01:00:00Z → 2026-09-15T09:00:00+08:00.
// The first 10 characters must be the *local* date: renderTlEvent, loadEvents'
// byDate bucketing and getFreeBlocks all slice or startsWith on them.
//
// The feed's clock is shifted to eLearn's own, Jakarta time (GMT+7), before being labelled +08:00.
// So "due 23:59" reads 23:59 here, the same as on eLearn's page, instead of 00:59 the next day.
// That lands every deadline one hour *before* its real cutoff — the safe direction to be wrong in.
const ELEARN_OFFSET_MS = 7 * 3600 * 1000;
function toAppIso(ms) {
  return new Date(ms + ELEARN_OFFSET_MS).toISOString().slice(0, 19) + APP_OFFSET;
}

// RFC 5545 escaping, in a single pass so "\\n" (a literal backslash then n)
// is not mistaken for a newline.
function unescapeText(v = '') {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// Unfold, then split into one object per VEVENT.
// A property line is NAME(;PARAM=VALUE)*:VALUE.
function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);   // folding: CRLF + space/tab
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...paramParts] = line.slice(0, i).split(';');
    const params = {};
    for (const part of paramParts) {
      const eq = part.indexOf('=');
      if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
    }
    cur[name.toUpperCase()] = { value: line.slice(i + 1), params };
  }
  return events;
}

// → { date: 'YYYY-MM-DD' } for all-day, or { dateTime: '…+08:00' } for timed.
function parseDt(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  if (/^\d{8}$/.test(v)) return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, Y, M, D, h, mi, s, z] = m;
  // Trailing Z is an absolute instant, so shift it into the dashboard's zone.
  // Without one Moodle is giving wall-clock time; take it at face value.
  return {
    dateTime: z ? toAppIso(Date.UTC(+Y, +M - 1, +D, +h, +mi, +s))
                : `${Y}-${M}-${D}T${h}:${mi}:${s}${APP_OFFSET}`,
  };
}

const startKey = e => (e.start.dateTime || e.start.date).slice(0, 10);

// Build the calendar list and the events, both in Google Calendar's shape so
// the frontend needs no special cases.
// `names` is injected rather than read here so the conversion stays a pure
// function of its input — test-moodle.js exercises it with its own table.
function build(text, origin, names = {}) {
  const raw = parseIcs(text);
  const courses = new Set();
  const events = [];

  for (const ev of raw) {
    const uid = ev.UID?.value?.trim();
    const start = parseDt(ev.DTSTART);
    if (!uid || !start) continue;                       // unusable — skip rather than render a ghost
    // Moodle writes zero-duration events as DTSTART == DTEND (it has no all-day
    // representation), so an equal end is normal, not a bug.
    const end = parseDt(ev.DTEND) || start;

    // CATEGORIES is the course shortname; site-wide and personal events have none.
    const course = unescapeText((ev.CATEGORIES?.value || '').split(',')[0]).trim() || 'other';
    courses.add(course);

    const epoch = Math.floor(new Date(start.date || start.dateTime).getTime() / 1000);
    events.push({
      id: 'moodle-' + uid,                              // prefixed: never collide with a Google event id
      summary: unescapeText(ev.SUMMARY?.value) || '(No title)',
      description: unescapeText(ev.DESCRIPTION?.value) || null,
      location: unescapeText(ev.LOCATION?.value) || null,
      start,
      end,
      status: 'confirmed',
      // Token-free deep link back into Moodle, built from the feed's own origin.
      htmlLink: `${origin}/calendar/view.php?view=day&time=${epoch}`,
      // The id stays the raw shortname: it is the localStorage key behind the
      // per-course toggles and the colour lookup, so it must not move when a
      // display name is added. Only _calName is for reading.
      _calId: 'moodle:' + course,
      _calName: course === 'other' ? SITE_NAME : displayName(course, names),
      _acct: ACCT,
    });
  }

  // Every key in courses.json is a course you are enrolled in, so the ones the feed
  // never mentions still get a calendar. Moodle emits nothing for a course with no
  // dated activity, and that silence is the only way it could have told us the course
  // exists — so the roster has to come from the file. The payoff is that the Accounts
  // card shows the whole load and the toggle is already in place the day the course
  // produces something. These carry no events, so the Course Deadlines card is
  // unaffected and stays purely "what's due".
  const stem = c => c.replace(/^\d+_/, '');          // 20261_CS201 and CS201 are one course
  const published = new Set([...courses].map(stem)); // what the feed told us about
  for (const key of Object.keys(names)) {
    if (key.startsWith('_') || courses.has(key) || published.has(stem(key))) continue;
    courses.add(key);
  }

  const calendars = [...courses].sort().map((course, i) => ({
    id: 'moodle:' + course,
    name: course === 'other' ? SITE_NAME : displayName(course, names),
    color: PALETTE[i % PALETTE.length],
  }));

  return { calendars, events };
}

let cache = { at: 0, failedAt: 0, data: null };

async function feed() {
  if (cache.data && Date.now() - cache.at < FEED_TTL) return cache.data;
  if (!cache.data && Date.now() - cache.failedAt < FAIL_TTL) throw new Error(cache.err || 'feed unavailable');

  const url = process.env.MOODLE_ICS_URL;
  if (!url) throw new Error('MOODLE_ICS_URL is not set');

  let text;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Moodle returned HTTP ${r.status}`);
    text = await r.text();
  } catch (err) {
    cache = { ...cache, failedAt: Date.now(), err: err.message };
    if (cache.data) { console.error('[moodle] serving cached feed —', err.message); return cache.data; }
    throw err;
  }

  // A rotated token (or a password change) gets an HTML login/error page back,
  // which would otherwise parse as "a calendar with no events".
  if (!text.includes('BEGIN:VCALENDAR')) {
    const msg = 'Moodle did not return a calendar — re-copy the export URL into .env';
    cache = { ...cache, failedAt: Date.now(), err: msg };
    if (cache.data) { console.error('[moodle] serving cached feed —', msg); return cache.data; }
    throw new Error(msg);
  }

  // Re-read courses.json on every refresh, so an edit lands within FEED_TTL
  // without a restart — unlike .env, which process.loadEnvFile freezes at boot.
  // text + origin are kept so a rename can rebuild without refetching the feed.
  const origin = new URL(url).origin;
  cache = { at: Date.now(), failedAt: 0, text, origin, data: build(text, origin, readNames()) };
  return cache.data;
}

// Events overlapping [startYmd, endYmd], both inclusive.
async function eventsFor(startYmd, endYmd) {
  const { events } = await feed();
  return events.filter(e => {
    const end = (e.end.dateTime || e.end.date || startKey(e)).slice(0, 10);
    return startKey(e) <= endYmd && end >= startYmd;
  });
}

// Rename a course from the dashboard. Edits whichever key already names it (full or
// term-stripped), so a hand-written entry is updated rather than shadowed.
function setName(course, name) {
  const names = readNames();
  const stem = c => c.replace(/^\d+_/, '');
  const key = Object.keys(names).find(k => !k.startsWith('_') && stem(k) === stem(course)) || course;
  names[key] = name;
  fs.writeFileSync(NAMES_PATH, JSON.stringify(names, null, 2) + '\n');
  if (cache.text) cache.data = build(cache.text, cache.origin, names);
}

// Drop the cache. Used by test-moodle.js and handy when checking a new URL by hand.
function _reset() { cache = { at: 0, failedAt: 0, data: null }; }

module.exports = { configured, feed, eventsFor, parseIcs, build, setName, _reset, SITE_NAME, ACCT };
