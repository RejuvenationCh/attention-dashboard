// Auto-update. A release is a git tag (v1.2.0, made with `npm version`); every install is a
// git clone, so updating is: fetch tags, check out the newest one, restart.
// Skipped when this isn't a clone, when tracked files have local edits (a developer's
// checkout, or someone's own tweaks, which must never be overwritten), or with "autoUpdate": false
// in config.json. Personal data is all gitignored, so a checkout never touches it.
const { execFile } = require('child_process');
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

// The CHANGELOG sections newer than the running version, as written in the release itself.
async function notesFor(tag) {
  try {
    const text = await git('show', `${tag}:CHANGELOG.md`);
    const start = text.indexOf('\n## ');
    const end = text.indexOf(`\n## ${VERSION} `);
    return start < 0 ? '' : text.slice(start + 1, end > start ? end : undefined).trim();
  } catch { return ''; }
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
    const behind = newer(latest, VERSION)
      && !(await git('merge-base', '--is-ancestor', latest, 'HEAD').then(() => true, () => false));
    Object.assign(status, { latest: latest.replace(/^v/, ''), available: behind, checkedAt: new Date().toISOString(), error: null,
                            notes: behind ? await notesFor(latest) : '' });
  } catch (err) {
    status.error = err.message.split('\n')[0];
  }
}

let restartFn = () => process.exit(1);

// Move to the newest release and restart shortly after, so the page can be told first.
// Returns the version it is moving to, or null with status.error saying why not.
async function install() {
  if (!status.available) return null;
  if (await git('status', '--porcelain', '--untracked-files=no')) {
    status.error = `version ${status.latest} is out, but local edits to the app's files block the update`;
    return null;
  }
  try {
    await git('checkout', '--quiet', '--detach', 'v' + status.latest);
  } catch (err) {
    status.error = err.message.split('\n')[0];
    return null;
  }
  console.log(`[update] v${VERSION} → v${status.latest}, restarting`);
  setTimeout(restartFn, 500);
  return status.latest;
}

// Hourly: always check, install only when automatic updates are on. `config` is the live
// object Settings edits, so switching it takes effect without a restart.
// restart: how this OS brings the server back (platform.restart).
function start(config, restart) {
  restartFn = restart;
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

module.exports = { start, check, install, status, newer, VERSION };

if (require.main === module) {   // node updater.js: self-check of the version compare
  const assert = require('assert');
  assert(newer('v1.10.0', '1.9.2'));
  assert(newer('2.0.0', 'v1.99.99'));
  assert(!newer('v1.0.0', '1.0.0'));
  assert(!newer('v1.0.0-beta', '0.1.0'));
  console.log('updater ok');
}
