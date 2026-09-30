// Quick add: "essay due fri 5pm #school !" → a task. Pure, so test-quickadd.js runs it in Node.
// Understands, anywhere in the line:
//   dates   today · tomorrow/tmr · mon…sun (the next one) · next week · in 3 days · 20/10 · 20/10/2026 · 20 oct · oct 20
//   times   5pm · 5:30pm · 17:00 · 17.30   (used for the calendar reminder; tasks keep a date)
//   #tags · ! for priority · every week / weekly / every month / monthly
// Whatever is left is the title, minus a dangling "due", "by", "on" or "at".
(function (root) {
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const plus = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const monthOf = w => MONTHS.indexOf(w.slice(0, 3).toLowerCase());
  // A date with no year is the next one: "5 jan" in December means next January.
  const dayMonth = (today, day, month, year) => {
    let d = new Date(year ?? today.getFullYear(), month, day);
    if (d.getMonth() !== month) return null;
    if (year === undefined && d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) d = new Date(today.getFullYear() + 1, month, day);
    return d;
  };

  function parseQuickAdd(text, today = new Date()) {
    let s = ` ${text} `;
    const out = { title: '', deadline: null, time: null, tags: [], priority: false, repeat: null };
    const take = (re, fn) => { s = s.replace(re, (...m) => { const keep = fn(...m); return keep === false ? m[0] : ' '; }); };

    take(/\s#([\p{L}\p{N}_-]+)/gu, (_, t) => { out.tags.push(t); });
    take(/\s!(?=\s)/g, () => { out.priority = true; });
    take(/\s(every\s+week|weekly)(?=\s)/gi, () => { out.repeat = 'weekly'; });
    take(/\s(every\s+month|monthly)(?=\s)/gi, () => { out.repeat = 'monthly'; });

    // Times before dates, so "17.30" is not read as a day and month.
    take(/\s(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)(?=\s)/gi, (_, h, m, ap) => {
      let hour = Number(h) % 12 + (ap.toLowerCase() === 'pm' ? 12 : 0);
      if (Number(h) > 12) return false;
      out.time = `${pad(hour)}:${m || '00'}`;
    });
    take(/\s(?:at\s+)?([01]?\d|2[0-3])[:.]([0-5]\d)(?=\s)/g, (_, h, m) => { if (!out.time) out.time = `${pad(h)}:${m}`; else return false; });

    const setDate = d => { if (!d || out.deadline) return false; out.deadline = ymd(d); };
    take(/\s(today)(?=\s)/gi, () => setDate(today));
    take(/\s(tomorrow|tmr|tmrw)(?=\s)/gi, () => setDate(plus(today, 1)));
    take(/\snext\s+week(?=\s)/gi, () => setDate(plus(today, 7)));
    take(/\sin\s+(\d{1,3})\s+days?(?=\s)/gi, (_, n) => setDate(plus(today, Number(n))));
    take(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?=\s)/g, (_, d, m, y) => setDate(dayMonth(today, Number(d), Number(m) - 1, y ? Number(y) : undefined)));
    take(/\s(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?(?=\s)/gi, (_, d, mon, y) =>
      monthOf(mon) < 0 ? false : setDate(dayMonth(today, Number(d), monthOf(mon), y ? Number(y) : undefined)));
    take(/\s([a-z]{3,9})\s+(\d{1,2})(?:\s+(\d{4}))?(?=\s)/gi, (_, mon, d, y) =>
      monthOf(mon) < 0 ? false : setDate(dayMonth(today, Number(d), monthOf(mon), y ? Number(y) : undefined)));
    take(/\s(?:next\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?(?=\s)/gi, (_, w) => {
      const target = DAYS.indexOf(w.slice(0, 3).toLowerCase());
      const ahead = (target - today.getDay() + 7) % 7 || 7;   // "fri" on a Friday means next Friday
      return setDate(plus(today, ahead));
    });

    out.title = s.replace(/\s+/g, ' ').trim().replace(/\s+(due|by|on|at)$/i, '').replace(/^(due|by)\s+/i, '').trim();
    return out;
  }

  if (typeof module !== 'undefined') module.exports = { parseQuickAdd };
  else root.parseQuickAdd = parseQuickAdd;
})(typeof window !== 'undefined' ? window : globalThis);
