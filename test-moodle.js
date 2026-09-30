// Run: node test-moodle.js
// Covers the Moodle ICS → Google-shape conversion: the timezone shift that the
// dashboard's .substring(0,10) date bucketing depends on, RFC 5545 folding and
// escaping, and the guards around a feed that stops returning a calendar.
// The expected strings below are written for a WITA machine; pin it so the result doesn't depend on where this runs.
process.env.TZ = 'Asia/Makassar';
const assert = require('assert');
const moodle = require('./moodle');

const ORIGIN = 'https://elearn.uc.ac.id';
const URL_WITH_TOKEN =
  `${ORIGIN}/calendar/export_execute.php?userid=12345&authtoken=SECRETTOKEN&preset_what=all&preset_time=recentupcoming`;

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Moodle//NONSGML//EN',
  'METHOD:PUBLISH',
  'BEGIN:VEVENT',
  'UID:101@elearn.uc.ac.id',
  'DTSTART:20260915T010000Z',
  'DTEND:20260915T023000Z',
  'SUMMARY:Struktur Data',
  'DESCRIPTION:Week 3: sorting\\, searching and\\ncomplexity analysis. Bring your lap',
  // Folded mid-word: the CRLF + single space is a marker and is removed whole,
  // so this must re-join as "laptop." with no space introduced or lost.
  ' top.',
  'LOCATION:Lab 4',
  'CATEGORIES:CS201',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:102@elearn.uc.ac.id',
  'DTSTART:20260916T130000',                        // bare wall-clock, no Z
  'DTEND:20260916T130000',                          // zero duration: Moodle's all-day form
  'SUMMARY:Skripsi bimbingan',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:103@elearn.uc.ac.id',
  'DTSTART;VALUE=DATE:20260917',
  'DTEND;VALUE=DATE:20260918',
  'SUMMARY:Hari Raya',
  'CATEGORIES:CS201',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:104@elearn.uc.ac.id',
  'DTSTART:20260914T230000Z',                       // 23:00Z on the 14th = 07:00 on the 15th locally
  'DTEND:20260914T235900Z',
  'SUMMARY:Late submission deadline',
  'CATEGORIES:CS201',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:105@elearn.uc.ac.id',
  'SUMMARY:No DTSTART, unusable',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const byId = (evs, uid) => evs.find(e => e.id === 'moodle-' + uid);

// pure conversion
{
  const { calendars, events } = moodle.build(ICS, ORIGIN);

  // Undated events are skipped, not rendered as ghosts.
  assert.strictEqual(events.length, 4, 'expected 4 usable events, got ' + events.length);

  // 01:00Z → 08:00, eLearn's own (GMT+7) clock, labelled +08:00. The dashboard shows what eLearn's
  // page shows. The leading 10 chars must still be the date on that clock.
  const a = byId(events, '101@elearn.uc.ac.id');
  assert.strictEqual(a.start.dateTime, '2026-09-15T08:00:00+08:00');
  assert.strictEqual(a.end.dateTime, '2026-09-15T09:30:00+08:00');

  // Folding is undone and \n / \, are unescaped.
  assert.ok(a.description.includes('Bring your laptop.'), 'folded line was not re-joined');
  assert.ok(a.description.includes('sorting, searching'), 'escaped comma was not unescaped');
  assert.ok(a.description.includes('\n'), 'escaped newline was not unescaped');
  assert.strictEqual(a.location, 'Lab 4');

  // The timezone trap: 2026-09-14T23:00Z is the 15th in WITA. If this ever reads
  // 2026-09-14, the event lands on the wrong day in every view.
  const d = byId(events, '104@elearn.uc.ac.id');
  assert.strictEqual(d.start.dateTime.slice(0, 10), '2026-09-15',
    'UTC instant was not shifted into the dashboard timezone');

  // Bare wall-clock passes through unchanged; zero duration stays zero.
  const b = byId(events, '102@elearn.uc.ac.id');
  assert.strictEqual(b.start.dateTime, '2026-09-16T13:00:00+08:00');
  assert.strictEqual(b.end.dateTime, b.start.dateTime, 'zero-duration event should keep equal end');

  // All-day events use { date }, which is what the month view tests for.
  const c = byId(events, '103@elearn.uc.ac.id');
  assert.deepStrictEqual(c.start, { date: '2026-09-17' });
  assert.ok(!c.start.dateTime);

  // CATEGORIES → one calendar per course, with 'other' for uncategorised events.
  assert.strictEqual(a._calId, 'moodle:CS201');
  assert.strictEqual(a._calName, 'CS201');
  assert.strictEqual(a._acct, 'moodle');
  assert.strictEqual(b._calId, 'moodle:other');
  assert.strictEqual(b._calName, moodle.SITE_NAME);
  assert.deepStrictEqual(calendars.map(c => c.id), ['moodle:CS201', 'moodle:other']);
  assert.ok(calendars.every(c => /^#[0-9a-f]{6}$/.test(c.color)), 'every course needs a colour');

  // courses.json supplies the readable name, but the shortname stays the id: the
  // per-course toggles and the colour lookup are both keyed on it, so a name added
  // later must not silently reset either.
  const named = moodle.build(ICS, ORIGIN, { CS201: 'Algorithms' });
  assert.strictEqual(byId(named.events, '101@elearn.uc.ac.id')._calName, 'Algorithms');
  assert.strictEqual(byId(named.events, '101@elearn.uc.ac.id')._calId, 'moodle:CS201',
    'a display name must not move the calendar id');
  assert.strictEqual(named.calendars[0].name, 'Algorithms');
  assert.strictEqual(byId(named.events, '102@elearn.uc.ac.id')._calName, moodle.SITE_NAME,
    'uncategorised events keep the site name');

  // Keying on the term-stripped code is what makes the table survive next semester,
  // when Moodle hands back 20262_CS201 for the same course.
  const nextTerm = moodle.build(
    ICS.replace(/CATEGORIES:CS201/g, 'CATEGORIES:20262_CS201'), ORIGIN, { CS201: 'Algorithms' });
  assert.strictEqual(byId(nextTerm.events, '101@elearn.uc.ac.id')._calName, 'Algorithms');

  // Unmapped courses fall back to the shortname rather than rendering blank.
  assert.strictEqual(byId(moodle.build(ICS, ORIGIN).events, '101@elearn.uc.ac.id')._calName, 'CS201');

  // A course Moodle never publishes still gets a calendar, so the Accounts card can
  // show a load the feed is silent about. It must not invent events, and a key that
  // does match a feed course must not duplicate it, in either spelling.
  const roster = moodle.build(ICS, ORIGIN, {
    CS201: 'Algorithms',
    '20261_CS201': 'Algorithms',                    // same course, term prefix kept
    'Statistics A': 'Statistics A',                 // never published, listed anyway
    _readme: 'must never become a course',
  });
  assert.deepStrictEqual(roster.calendars.map(c => c.id),
    ['moodle:CS201', 'moodle:Statistics A', 'moodle:other'], 'roster keys that match must not duplicate');
  assert.deepStrictEqual(roster.calendars.map(c => c.name),
    ['Algorithms', 'Statistics A', moodle.SITE_NAME]);
  assert.ok(roster.calendars.every(c => /^#[0-9a-f]{6}$/.test(c.color)), 'roster courses need a colour too');
  assert.strictEqual(roster.events.length, events.length, 'a roster-only course must not invent events');
  assert.ok(!roster.events.some(e => e._calId === 'moodle:Statistics A'));

  // Ids must be unique and prefixed, or fetchRange's dedupe drops events.
  const ids = events.map(e => e.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id.startsWith('moodle-')));

  // The authtoken must never reach the browser.
  for (const e of events) {
    assert.ok(!e.htmlLink.includes('authtoken'), 'htmlLink leaked the export token');
    assert.ok(e.htmlLink.startsWith(ORIGIN + '/calendar/view.php'), 'htmlLink should point back at Moodle');
  }

  console.log('ok  build/parse (timezone shift, folding, escaping, all-day, zero-duration, colours)');
}

// feed: fetch, filter, and the wrong-content guard
(async () => {
  process.env.MOODLE_ICS_URL = URL_WITH_TOKEN;
  moodle._reset();

  let sentUrl = null;
  globalThis.fetch = async (u) => { sentUrl = u; return { ok: true, text: async () => ICS }; };

  const inRange = await moodle.eventsFor('2026-09-15', '2026-09-15');
  assert.ok(sentUrl.startsWith(ORIGIN), 'must fetch the configured Moodle URL');
  assert.deepStrictEqual(inRange.map(e => e.id).sort(),
    ['moodle-101@elearn.uc.ac.id', 'moodle-104@elearn.uc.ac.id'],
    'range filter should keep only events overlapping the requested day');

  const wide = await moodle.eventsFor('2026-09-01', '2026-09-30');
  assert.strictEqual(wide.length, 4);
  console.log('ok  eventsFor (range filtering, both local dates counted)');

  // Cached: a second call must not hit the network again.
  sentUrl = null;
  await moodle.eventsFor('2026-09-01', '2026-09-30');
  assert.strictEqual(sentUrl, null, 'feed should be cached, not refetched');
  console.log('ok  feed caching');

  // A rotated token returns Moodle's HTML page; that must be an error, not an
  // empty calendar that silently renders no events.
  moodle._reset();
  globalThis.fetch = async () => ({ ok: true, text: async () => '<!DOCTYPE html><title>Error | E-Learning</title>' });
  await assert.rejects(() => moodle.eventsFor('2026-09-15', '2026-09-15'), /did not return a calendar/);
  console.log('ok  non-calendar response is rejected');

  // HTTP failures surface with the status.
  moodle._reset();
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '' });
  await assert.rejects(() => moodle.eventsFor('2026-09-15', '2026-09-15'), /HTTP 500/);
  console.log('ok  upstream HTTP error is reported');

  console.log('\nall moodle tests passed');
})();
