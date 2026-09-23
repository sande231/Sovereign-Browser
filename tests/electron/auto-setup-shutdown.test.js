const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-auto-setup-profile-'));
process.env.SOVEREIGN_USER_DATA_DIR = profile;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for condition.');
}

function liveContents() {
  return webContents.getAllWebContents().filter(contents => !contents.isDestroyed());
}

function contentsByUrl(part) {
  return liveContents().find(contents => contents.getURL().includes(part));
}

async function main() {
  const server = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Browsing During Setup</title><main>Browsing stayed usable.</main>');
  });

  require('../../src/main.js');
  await app.whenReady();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  const setupStarted = await waitFor(async () => {
    const state = await chrome.executeJavaScript('window.sovereign.modelSetup.getState()', true);
    return ['checking', 'downloading', 'ready', 'error'].includes(state.status) ? state : null;
  });

  await chrome.executeJavaScript(`window.sovereign.newTab('http://127.0.0.1:${server.address().port}/during-setup')`, true);
  const page = await waitFor(() => contentsByUrl('/during-setup'));
  const title = await waitFor(async () => {
    const value = await page.executeJavaScript('document.title', true);
    return value === 'Browsing During Setup' ? value : null;
  });

  console.log(JSON.stringify({
    profile,
    setupStarted: {
      status: setupStarted.status,
      autoDownloadModel: setupStarted.settings?.autoDownloadModel,
      cached: setupStarted.cached
    },
    browsingDuringSetupTitle: title,
    quittingWithSetupActive: true
  }, null, 2));

  server.close();
  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
