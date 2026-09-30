// Run: npm run release -- patch   (or minor, major)
// Publishes a version to every install, so it stops before tagging anything when:
// the tree has uncommitted changes, this isn't main, any test fails, or CHANGELOG.md has no
// section for the new version (the what's-new card and the update notes are read from it).
const { execFileSync } = require('child_process');
const fs = require('fs');

const bump = process.argv[2];
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: __dirname, encoding: 'utf8', ...opts });
const stop = msg => { console.error('Not released: ' + msg); process.exit(1); };

if (!['patch', 'minor', 'major'].includes(bump)) stop('say which part to bump: npm run release -- patch | minor | major');
if (run('git', ['status', '--porcelain']).trim()) stop('commit or stash your changes first');
if (run('git', ['branch', '--show-current']).trim() !== 'main') stop('releases are made from main');

const [a, b, c] = require('./package.json').version.split('.').map(Number);
const next = bump === 'major' ? `${a + 1}.0.0` : bump === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
if (!fs.readFileSync(__dirname + '/CHANGELOG.md', 'utf8').includes(`\n## ${next} `)) {
  stop(`CHANGELOG.md has no "## ${next} (date)" section`);
}

try { run('npm', ['test'], { stdio: 'inherit' }); } catch { stop('tests failed'); }

run('npm', ['version', next, '-m', 'Release %s'], { stdio: 'inherit' });
run('git', ['push', 'origin', 'main', '--follow-tags'], { stdio: 'inherit' });
console.log(`Released ${next}. Installs pick it up within the hour.`);
