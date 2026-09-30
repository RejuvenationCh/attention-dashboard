// Used by install.sh and install.ps1. Checks the Node version (in JS, so neither shell has to
// quote JavaScript), then prints the port to use, saving it to config.json. Keeps an existing
// port so reinstalling never moves the dashboard.
const fs = require('fs'), net = require('net');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node ${process.version} is too old; this needs 22.13 or newer (https://nodejs.org).`);
  process.exit(1);
}

const FILE = __dirname + '/config.json';
let config = {};
try { config = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

// Same address the server binds (127.0.0.1), so "free" here means free for it.
const free = port => new Promise(ok => {
  const s = net.createServer().once('error', () => ok(false))
    .once('listening', () => s.close(() => ok(true))).listen(port, '127.0.0.1');
});

(async () => {
  if (!config.port) {
    let port = 3100;
    while (!(await free(port))) port++;
    config.port = port;
    fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(config.port);
})();
