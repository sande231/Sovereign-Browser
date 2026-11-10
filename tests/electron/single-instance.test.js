const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BaseWindow, webContents } = require('electron');

const phase = (process.argv.find(arg => arg.startsWith('--phase=')) || '--phase=orchestrate').slice(8);
const chromeContents = () => webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && contents.getURL().includes('index.html'));
async function waitFor(predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for chrome/second-instance');
}
function runPhase(nextPhase, profile) {
  const env = { ...process.env, SOVEREIGN_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SOVEREIGN_DATASET_BATCH;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, `--phase=${nextPhase}`], { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, nextPhase === 'primary' ? 90000 : 30000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${nextPhase} failed: ${code}/${signal}\n${stdout}\n${stderr}`));
      else resolve(stdout);
    });
  });
}
function makeProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-single-instance-'));
  fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({
    ai: { autoDownloadModel: false, setupNoticeSeen: true, setupCanceled: false },
    search: {}, downloads: {}, bookmarks: [],
    startup: { continueWhereLeftOff: false }, session: { windows: [] }
  }));
  return dir;
}
async function run() {
  if (phase === 'orchestrate') {
    const profile = makeProfile();
    try {
      const output = await runPhase('primary', profile);
      assert.match(output, /"ok":true/);
      console.log(output);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
    return;
  }
  let secondInstances = 0;
  app.on('second-instance', () => { secondInstances++; });
  require('../../src/main.js');
  await app.whenReady();
  await waitFor(() => chromeContents().length > 0);
  if (phase === 'secondary') throw new Error('Same-profile secondary unexpectedly created chrome');
  if (phase === 'different') {
    console.log('DIFFERENT_PROFILE_STARTED');
    return;
  }
  assert.equal(chromeContents().length, 1);
  const window = BaseWindow.getAllWindows().find(win => win.contentView.children.some(view => view.webContents === chromeContents()[0]));
  assert.ok(window, 'Chrome belongs to a live browser window');
  let focusCalls = 0;
  const originalFocus = window.focus;
  window.focus = function (...args) { focusCalls++; return originalFocus.apply(this, args); };
  const output = await runPhase('secondary', process.env.SOVEREIGN_USER_DATA_DIR);
  assert.match(output, /Sovereign is already running with this profile/);
  await waitFor(() => secondInstances === 1 && focusCalls > 0);
  assert.equal(secondInstances, 1);
  assert.equal(focusCalls, 1);
  assert.equal(chromeContents().length, 1);
  const otherProfile = makeProfile();
  try {
    assert.match(await runPhase('different', otherProfile), /DIFFERENT_PROFILE_STARTED/);
  } finally {
    fs.rmSync(otherProfile, { recursive: true, force: true });
  }
  assert.equal(secondInstances, 1);
  assert.equal(chromeContents().length, 1);
  console.log(JSON.stringify({ ok: true, secondInstances, focusCalls, chromeWindows: chromeContents().length, differentProfileStarted: true }));
}
run().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
