// Used by install.sh and install.ps1: prints the port to use, saving it to config.json.
// Keeps an existing port so reinstalling never moves the dashboard.
const fs = require('fs'), net = require('net');
const FILE = __dirname + '/config.json';
let config = {};
try { config = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

const free = port => new Promise(ok => {
  const s = net.createServer().once('error', () => ok(false))
    .once('listening', () => s.close(() => ok(true))).listen(port);
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
