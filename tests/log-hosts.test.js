// Runs the Python unit tests for scripts/log-hosts.py (the mitmproxy addon).
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const result = spawnSync('python3', ['-I', path.join(__dirname, 'log_hosts_test.py')], { encoding: 'utf8' });
if (result.error) {
  console.error(`log-hosts tests need python3: ${result.error.message}`);
  process.exit(1);
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status === 0 ? 0 : 1);
