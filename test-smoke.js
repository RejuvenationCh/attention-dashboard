// Run: node test-smoke.js   (part of npm test)
// Starts a real server from a copy of the app in a temp folder, with no data and no .env,
// the way a fresh install starts, and checks the endpoints every page load depends on.
// Catches the release that crashes on boot or breaks the task store before friends get it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const APP = ['server.js', 'moodle.js', 'platform.js', 'updater.js', 'package.json', 'CHANGELOG.md', 'public'];

const freePort = () => new Promise(ok => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-smoke-'));
  for (const f of APP) fs.cpSync(path.join(__dirname, f), path.join(dir, f), { recursive: true });
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, autoUpdate: false }));
  fs.writeFileSync(path.join(dir, 'dashboard.log'), '[token] someone@example.com failed: ?authtoken=abc123&x=1 ya29.secretvalue\n');

  let log = '';
  const server = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: '' } });
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const J = { 'Content-Type': 'application/json', Origin: base };
  const get = p => fetch(base + p).then(async r => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }));
  const send = (method, p, body, headers = J) => fetch(base + p, { method, headers, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

  try {
    for (let i = 0; ; i++) {
      try { await fetch(base + '/api/platform'); break; }
      catch { if (i > 50) throw new Error('server did not start:\n' + log); await new Promise(r => setTimeout(r, 100)); }
    }

    const page = await get('/');
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes('app.js'), 'index.html is served');
    for (const f of ['/app.js', '/style.css', '/appearance.js', '/add-task.html']) {
      assert.strictEqual((await get(f)).status, 200, f + ' is served');
    }

    const config = await get('/api/config');
    assert.strictEqual(config.body.update.version, require('./package.json').version);
    assert.deepStrictEqual((await get('/api/accounts')).body, []);
    assert.deepStrictEqual((await get('/api/todos')).body.todos, []);

    // Task store: add, replace, read back.
    let r = await send('POST', '/api/todos', [{ title: 'Smoke A', deadline: '2026-10-20' }, { title: 'Smoke B' }]);
    assert.strictEqual(r.body.todos.length, 2);
    r = await send('PUT', '/api/todos', [{ ...r.body.todos[0], title: 'Smoke A edited',
      tags: ['#school', 'school', ' urgent '], subtasks: [{ text: 'Outline', done: true }, { text: '' }, { text: 'Draft' }] }]);
    assert.deepStrictEqual(r.body.todos.map(t => t.title), ['Smoke A edited']);
    assert.deepStrictEqual(r.body.todos[0].tags, ['school', 'urgent'], 'tags cleaned and de-duplicated');
    assert.deepStrictEqual(r.body.todos[0].subtasks, [{ text: 'Outline', done: true }, { text: 'Draft', done: false }]);

    // Backup and restore round trip, and a non-backup is refused.
    const backup = (await get('/api/backup')).body;
    assert.strictEqual(backup.app, 'attention-dashboard');
    await send('PUT', '/api/todos', []);
    assert.strictEqual((await send('POST', '/api/restore', backup)).body.tasks, 1);
    assert.strictEqual((await get('/api/todos')).body.todos[0].title, 'Smoke A edited');
    assert.strictEqual((await send('POST', '/api/restore', { hello: 1 })).status, 400);

    // The fences: another site's Origin, and a foreign Host (DNS rebinding).
    assert.strictEqual((await send('PUT', '/api/config', { name: 'x' }, { ...J, Origin: 'http://evil.example' })).status, 403);
    const rebound = await new Promise(ok => {
      const s = net.connect(port, '127.0.0.1', () => s.end(`GET /api/todos HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`));
      let out = ''; s.on('data', d => { out += d; }); s.on('end', () => ok(out));
    });
    assert.ok(rebound.startsWith('HTTP/1.1 403'), 'foreign Host is refused');

    // Diagnostics: a readable report with the private parts blanked.
    const diag = await get('/api/diagnostics');
    assert.ok(diag.body.includes('Version: '), 'diagnostics report');
    for (const leak of ['someone@example.com', 'abc123', 'ya29.secretvalue']) assert.ok(!diag.body.includes(leak), 'diagnostics hides ' + leak);

    // A daily backup is written on start, in the same format Restore reads.
    const daily = fs.readdirSync(path.join(dir, 'backups'));
    assert.strictEqual(daily.length, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'backups', daily[0]), 'utf8')).app, 'attention-dashboard');

    // Settings round trip.
    assert.strictEqual((await send('PUT', '/api/config', { name: 'Smoke' })).body.name, 'Smoke');

    console.log('smoke test passed');
  } finally {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error(err.message); process.exit(1); });
