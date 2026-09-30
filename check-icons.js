// Run: node check-icons.js
// The icon font is loaded with only the icons the UI uses (icon_names= in index.html and
// add-task.html), which makes it 20 KB instead of 2.3 MB. An icon missing from that list
// renders as its name in plain text, so this fails when the code uses one that isn't listed.
const fs = require('fs');
const files = ['public/index.html', 'public/add-task.html', 'public/app.js'];
const src = files.map(f => fs.readFileSync(__dirname + '/' + f, 'utf8')).join('\n');

// Only places an icon name can actually land: literal <span class="msym">name</span>, the
// quoted choices inside <span class="msym">${ ... }</span>, a `const icon = ...` that feeds one,
// and .msym textContent assignments. Reading every quoted word on an msym line mistook
// classList.remove('open') for an icon.
const used = new Set();
const quoted = expr => [...expr.matchAll(/'([a-z][a-z0-9_]*)'/g)].map(m => m[1]);
for (const m of src.matchAll(/msym[^"]*">([a-z0-9_]+)</g)) used.add(m[1]);
for (const m of src.matchAll(/msym[^"]*">\$\{([^}]*)\}/g)) quoted(m[1]).forEach(i => used.add(i));
for (const m of src.matchAll(/const icon = ([^;]+);/g)) quoted(m[1]).forEach(i => used.add(i));
for (const m of src.matchAll(/\.msym'\)\.textContent\s*=\s*([^;]+);/g)) quoted(m[1]).forEach(i => used.add(i));

let bad = false;
for (const f of ['public/index.html', 'public/add-task.html']) {
  const list = new Set((fs.readFileSync(__dirname + '/' + f, 'utf8').match(/icon_names=([a-z0-9_,]+)/) || [])[1]?.split(',') || []);
  const missing = [...used].filter(i => !list.has(i));
  if (missing.length) { bad = true; console.error(`${f} is missing icons: ${missing.join(',')}`); }
}
if (bad) process.exit(1);
console.log(`icons ok (${used.size} used)`);
