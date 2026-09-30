// Run: node check-icons.js
// The icon font is loaded with only the icons the UI uses (icon_names= in index.html and
// add-task.html), which makes it 20 KB instead of 2.3 MB. An icon missing from that list
// renders as its name in plain text, so this fails when the code uses one that isn't listed.
const fs = require('fs');
const files = ['public/index.html', 'public/add-task.html', 'public/app.js'];
const src = files.map(f => fs.readFileSync(__dirname + '/' + f, 'utf8')).join('\n');

const used = new Set();
for (const m of src.matchAll(/msym[^"]*">([a-z0-9_]+)</g)) used.add(m[1]);
for (const line of src.split('\n')) {
  if (!line.includes('msym')) continue;
  for (const m of line.matchAll(/'([a-z][a-z0-9_]{2,})'/g)) used.add(m[1]);
}
for (const m of src.matchAll(/const icon = ([^;]+);/g)) for (const q of m[1].matchAll(/'([a-z_]+)'/g)) used.add(q[1]);
['monthly', 'weekly', 'smooth'].forEach(w => used.delete(w));   // quoted values on msym lines, not icons

let bad = false;
for (const f of ['public/index.html', 'public/add-task.html']) {
  const list = new Set((fs.readFileSync(__dirname + '/' + f, 'utf8').match(/icon_names=([a-z0-9_,]+)/) || [])[1]?.split(',') || []);
  const missing = [...used].filter(i => !list.has(i));
  if (missing.length) { bad = true; console.error(`${f} is missing icons: ${missing.join(',')}`); }
}
if (bad) process.exit(1);
console.log(`icons ok (${used.size} used)`);
