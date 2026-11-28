const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const appRoot = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(extraEnv, args, expected, exitCode, quiet = false) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-switch-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const name of Object.keys(env)) if (name.startsWith('SOVEREIGN_')) delete env[name];
  Object.assign(env, extraEnv, { SOVEREIGN_USER_DATA_DIR: profile });
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ ai: { autoDownloadModel: false, setupNoticeSeen: true } }));
  let output = '', exited = false, code, error;
  const child = spawn(process.execPath, [appRoot, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.on('error', value => { error = value; });
  child.on('close', value => { exited = true; code = value; });
  try {
    const start = Date.now();
    while (Date.now() - start < (quiet ? 8000 : 20000)) {
      if (error) throw error;
      if (quiet ? /app.*ready/i.test(output) : expected.every(pattern => pattern.test(output)) && (exitCode === undefined || exited)) break;
      if (exited) break;
      await delay(50);
    }
    if (quiet) {
      assert(!exited, `App exited early: ${output}`);
      assert(!/^.*\[Sovereign\].*$/m.test(output), output);
    } else {
      for (const pattern of expected) assert.match(output, pattern);
      if (exitCode !== undefined) { assert(exited, 'Child did not exit within 20 seconds'); assert.equal(code, exitCode, output); }
    }
  } finally {
    if (!exited) { child.kill('SIGTERM'); const start = Date.now(); while (!exited && Date.now() - start < 3000) await delay(50); }
    if (!exited) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)); }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
async function main() {
  await run({ SOVEREIGN_PERMISSION_TEST_ANSWER: 'allow', SOVEREIGN_TEST_DNS: '{}' }, [], [/\[Sovereign\]/, /ignored/i, /SOVEREIGN_PERMISSION_TEST_ANSWER/, /SOVEREIGN_TEST_DNS/]);
  await run({}, ['--ignore-certificate-errors'], [/ignore-certificate-errors/], 1);
  await run({}, ['--host-resolver-rules=MAP example.com 127.0.0.1'], [/host-resolver-rules/], 1);
  await run({}, ['--proxy-server=127.0.0.1:9'], [/\[Sovereign\]/, /proxy-server/]);
  await run({ SOVEREIGN_AUDIT_PROXY: '127.0.0.1:9' }, [], [/\[Sovereign\]/, /audit proxy/i, /127\.0\.0\.1:9/]);
  await run({}, [], [], undefined, true);
  console.log(JSON.stringify({ ok: true, cases: 6 }));
  app.exit(0);
}
main().catch(error => { console.error(error); app.exit(1); });
