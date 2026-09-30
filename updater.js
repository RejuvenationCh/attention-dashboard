// Auto-update. A release is a git tag (v1.2.0, made with `npm version`); every install is a
// git clone, so updating is: fetch tags, check out the newest one, restart.
// Skipped when this isn't a clone, when tracked files have local edits (a developer's
// checkout, or someone's own tweaks — never overwrite them), or with "autoUpdate": false
// in config.json. Personal data is all gitignored, so a checkout never touches it.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const VERSION = require('./package.json').version;
const CHECK_EVERY = 6 * 3600 * 1000;

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

const status = { version: VERSION, latest: VERSION, checkedAt: null, error: null, enabled: false };

// Returns the tag it moved to, or null when there is nothing to do.
async function check() {
  if (!fs.existsSync(path.join(DIR, '.git'))) { status.error = 'not a git clone, so updates are manual'; return null; }
  try {
    await git('fetch', '--tags', '--quiet', 'origin');
    const tags = (await git('tag', '--list', 'v*')).split('\n').filter(parse);
    const latest = tags.reduce((best, t) => newer(t, best) ? t : best, 'v' + VERSION);
    Object.assign(status, { latest: latest.replace(/^v/, ''), checkedAt: new Date().toISOString(), error: null });
    if (!newer(latest, VERSION)) return null;
    if (await git('status', '--porcelain', '--untracked-files=no')) {
      status.error = `v${status.latest} is out, but local edits block the update`;
      return null;
    }
    await git('checkout', '--quiet', '--detach', latest);
    return latest;
  } catch (err) {
    status.error = err.message.split('\n')[0];
    return null;
  }
}

// restart: how this OS brings the server back (platform.restart).
function start(config, restart) {
  if (config.autoUpdate === false) return;
  status.enabled = true;
  const run = async () => {
    const tag = await check();
    if (tag) { console.log(`[update] v${VERSION} → ${tag}, restarting`); restart(); }
    else if (status.error) console.error('[update]', status.error);
  };
  setTimeout(run, 60000).unref();   // not during boot: the page is loading then
  setInterval(run, CHECK_EVERY).unref();
}

module.exports = { start, status, newer, VERSION };

if (require.main === module) {   // node updater.js: self-check of the version compare
  const assert = require('assert');
  assert(newer('v1.10.0', '1.9.2'));
  assert(newer('2.0.0', 'v1.99.99'));
  assert(!newer('v1.0.0', '1.0.0'));
  assert(!newer('v1.0.0-beta', '0.1.0'));
  console.log('updater ok');
}
