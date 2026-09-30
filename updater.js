// Auto-update. A release is a git tag (v1.2.0, made with `npm version`); every install is a
// git clone, so updating is: fetch tags, check out the newest one, restart.
// Skipped when this isn't a clone, when tracked files have local edits (a developer's
// checkout, or someone's own tweaks, which must never be overwritten), or with "autoUpdate": false
// in config.json. Personal data is all gitignored, so a checkout never touches it.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const VERSION = require('./package.json').version;
const CHECK_EVERY = 3600 * 1000;   // one small git fetch, so hourly costs nothing

const git = (...args) => new Promise((ok, fail) =>
  execFile('git', args, { cwd: DIR, timeout: 60000 }, (err, out) => err ? fail(err) : ok(out.trim())));

// '1.10.0' > '1.9.2'. Tags that aren't plain x.y.z are ignored.
const parse = v => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
function newer(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// available: a newer release that this copy does not already contain. notes: what changed
// since the running version, from that release's CHANGELOG.md.
const status = { version: VERSION, latest: VERSION, available: false, notes: '', checkedAt: null, error: null, enabled: true };

// The CHANGELOG sections newer than `since` (newest first, as the file is written). With no
// `since`, only the newest section.
function changelogSince(text, since) {
  const start = text.indexOf('\n## ');
  if (start < 0) return '';
  let end = since ? text.indexOf(`\n## ${since} `) : text.indexOf('\n## ', start + 1);
  if (end <= start) end = since ? text.length : end;
  return text.slice(start + 1, end < 0 ? undefined : end).trim();
}

// What an available release adds, from that release's own CHANGELOG.
async function notesFor(tag) {
  try { return changelogSince(await git('show', `${tag}:CHANGELOG.md`), VERSION); } catch { return ''; }
}

// Look, don't touch: fetch the tags and record whether there is something to install.
async function check() {
  if (!fs.existsSync(path.join(DIR, '.git'))) { status.error = 'not a git clone, so updates are manual'; return; }
  try {
    await git('fetch', '--tags', '--quiet', 'origin');
    const tags = (await git('tag', '--list', 'v*')).split('\n').filter(parse);
    const latest = tags.reduce((best, t) => newer(t, best) ? t : best, 'v' + VERSION);
    // A copy that already contains the release (a development checkout on main) is not behind,
    // whatever package.json says; checking the tag out would move it backwards.
    // A version that failed to start before (the watchdog went back from it) is not offered again.
    const behind = newer(latest, VERSION) && latest.slice(1) !== status.skipVersion
      && !(await git('merge-base', '--is-ancestor', latest, 'HEAD').then(() => true, () => false));
    Object.assign(status, { latest: latest.replace(/^v/, ''), available: behind, checkedAt: new Date().toISOString(), error: null,
                            notes: behind ? await notesFor(latest) : '' });
  } catch (err) {
    status.error = err.message.split('\n')[0];
  }
}

let restartFn = () => process.exit(1);
let serverPort = 0;
const ROLLBACK_FILE = path.join(DIR, 'update-rollback.json');

// Runs as its own process, started by the version being replaced, because a new version that
// crashes on start never runs any of its own code. It waits up to 90 s for the new version to
// answer; if it doesn't, it checks the previous version back out and leaves a note for it.
// On macOS the LaunchAgent is still restarting the crashed server, so the next attempt finds the
// old code; on Windows nothing restarts it, so the watchdog starts it.
// ponytail: only catches "never answers"; a new version that starts but misbehaves stays.
const WATCHDOG = `
const { execFileSync, spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const { AD_DIR: dir, AD_PORT: port, AD_FROM: from, AD_FROM_VERSION: fromVersion, AD_TO: to } = process.env;
const want = to.slice(1), until = Date.now() + 90000;
(async () => {
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const c = await (await fetch('http://127.0.0.1:' + port + '/api/config')).json();
      if (c.update && c.update.version === want) return;
    } catch {}
  }
  execFileSync('git', ['checkout', '--quiet', '--detach', from], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'update-rollback.json'),
    JSON.stringify({ failed: want, restored: fromVersion, at: new Date().toISOString() }));
  if (process.platform === 'win32') {
    const log = fs.openSync(path.join(dir, 'dashboard.log'), 'a');
    spawn(process.execPath, ['server.js'], { cwd: dir, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  }
})();`;

// Move to the newest release and restart shortly after, so the page can be told first.
// Returns the version it is moving to, or null with status.error saying why not.
async function install() {
  if (!status.available) return null;
  if (await git('status', '--porcelain', '--untracked-files=no')) {
    status.error = `version ${status.latest} is out, but local edits to the app's files block the update`;
    return null;
  }
  const from = (await git('rev-parse', 'HEAD')), to = 'v' + status.latest;
  try {
    await git('checkout', '--quiet', '--detach', to);
  } catch (err) {
    status.error = err.message.split('\n')[0];
    return null;
  }
  if (serverPort) {
    spawn(process.execPath, ['-e', WATCHDOG], {
      cwd: DIR, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, AD_DIR: DIR, AD_PORT: String(serverPort), AD_FROM: from, AD_FROM_VERSION: VERSION, AD_TO: to },
    }).unref();
  }
  console.log(`[update] v${VERSION} → ${to}, restarting`);
  setTimeout(restartFn, 500);
  return status.latest;
}

// Hourly: always check, install only when automatic updates are on. `config` is the live
// object Settings edits, so switching it takes effect without a restart.
// restart: how this OS brings the server back (platform.restart). save: writes config.json.
function start(config, restart, port, save) {
  restartFn = restart;
  serverPort = port;
  // A note from the watchdog: the last update never started, and this is the version it went
  // back to. Remembered in config so automatic updates skip that version for good.
  try {
    const rb = JSON.parse(fs.readFileSync(ROLLBACK_FILE, 'utf8'));
    fs.unlinkSync(ROLLBACK_FILE);
    config.rolledBack = rb;
    config.skipVersion = rb.failed;
    save();
    console.error(`[update] ${rb.failed} did not start; back on ${rb.restored}`);
  } catch { /* no rollback happened */ }
  // Running a version past the one that failed: that episode is over.
  if (config.skipVersion && newer(VERSION, config.skipVersion)) {
    delete config.skipVersion; delete config.rolledBack; save();
  }
  status.rolledBack = config.rolledBack || null;
  status.skipVersion = config.skipVersion || null;
  const run = async () => {
    status.enabled = config.autoUpdate !== false;
    await check();
    if (status.available && status.enabled) await install();
    if (status.error) console.error('[update]', status.error);
  };
  status.enabled = config.autoUpdate !== false;
  setTimeout(run, 60000).unref();   // not during boot: the page is loading then
  setInterval(run, CHECK_EVERY).unref();
}

module.exports = { start, check, install, status, newer, changelogSince, VERSION };

if (require.main === module) {   // node updater.js: self-check of the version compare
  const assert = require('assert');
  assert(newer('v1.10.0', '1.9.2'));
  assert(newer('2.0.0', 'v1.99.99'));
  assert(!newer('v1.0.0', '1.0.0'));
  assert(!newer('v1.0.0-beta', '0.1.0'));
  const log = '# Changelog\n\nintro\n\n## 1.2.0 (x)\n\n- c\n\n## 1.1.0 (x)\n\n- b\n\n## 1.0.0 (x)\n\n- a\n';
  assert.strictEqual(changelogSince(log, '1.0.0'), '## 1.2.0 (x)\n\n- c\n\n## 1.1.0 (x)\n\n- b');
  assert.strictEqual(changelogSince(log, null), '## 1.2.0 (x)\n\n- c');
  assert.strictEqual(changelogSince(log, '0.9.0'), log.slice(log.indexOf('## 1.2.0')).trim());
  console.log('updater ok');
}
