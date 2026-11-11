process.env.SOVEREIGN_TEST_NETWORK_MODE ||= 'online'; // Offline mode is tested in offline-mode.test.js.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, webContents } = require('electron');

// Answer every website permission prompt with "Allow once" so the test can prove that
// only prompted permissions are granted, and that Sovereign's own pages never are.
process.env.SOVEREIGN_PERMISSION_TEST_ANSWER = 'allow';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-permissions-profile-'));
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
  ai: { autoDownloadModel: false, setupNoticeSeen: true, setupCanceled: false, saveChatsOnDevice: false },
  search: {},
  downloads: {},
  bookmarks: [],
  startup: { continueWhereLeftOff: false },
  session: { windows: [] }
}, null, 2));
process.env.SOVEREIGN_USER_DATA_DIR = profile;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 20000) {
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

function contentsByUrl(part) {
  return webContents.getAllWebContents().find(contents => !contents.isDestroyed() && contents.getURL().includes(part));
}

function expect(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
  }
}

async function main() {
  const server = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Permission Test Page</title><p>permissions</p>');
  });

  require('../../src/main.js');
  const privacyReceipts = require('../../src/privacy-receipt');
  await app.whenReady();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await chrome.executeJavaScript(`window.sovereign.newTab(${JSON.stringify(`${origin}/permission-page`)})`, true);
  const page = await waitFor(() => contentsByUrl('/permission-page'));
  await waitFor(() => page.executeJavaScript("document.title === 'Permission Test Page'", true));

  const webNotification = await page.executeJavaScript('Notification.requestPermission()', true);
  expect(webNotification === 'granted', 'A website should get notifications only through the Allow once prompt', webNotification);

  const queried = await page.executeJavaScript("navigator.permissions.query({ name: 'notifications' }).then(status => status.state)", true);
  expect(queried !== 'granted', 'Allow once must not be remembered by permission status checks', queried);

  const geoState = await page.executeJavaScript("navigator.permissions.query({ name: 'geolocation' }).then(status => status.state)", true);
  expect(geoState !== 'granted', 'Location must not report granted without a prompt', geoState);

  const screenCapture = await page.executeJavaScript(`
    navigator.mediaDevices.getDisplayMedia({ video: true })
      .then(() => 'granted')
      .catch(error => 'rejected:' + error.name)
  `, true);
  expect(screenCapture.startsWith('rejected:'), 'Screen capture must always be denied', screenCapture);

  const internalNotification = await chrome.executeJavaScript('Notification.requestPermission()', true);
  expect(internalNotification === 'denied', "Sovereign's own pages must be denied without a prompt", internalNotification);

  const receipt = await waitFor(() => privacyReceipts.getReceipts().find(item => item.id === privacyReceipts.PERMISSION_RECEIPT_ID));
  const entries = receipt.entries.map(entry => `${entry.host} | ${entry.whatWasSent}`);
  expect(entries.some(entry => entry.startsWith(`127.0.0.1:${server.address().port} | Permission request: notifications – allowed once by you`)), 'Allowed request is in the receipt', entries);
  expect(entries.some(entry => entry.includes('screen capture – denied automatically: not supported in Sovereign')), 'Screen capture denial is in the receipt', entries);
  expect(entries.some(entry => entry.startsWith("sovereign | Permission request: notifications – denied automatically: Sovereign's own pages")), 'Internal-page denial is in the receipt', entries);
  expect(!entries.some(entry => entry.includes('camera or microphone')), 'Screen capture must not be shown to the user as a camera or microphone prompt', entries);
  expect(receipt.cloudAi.ok, 'Permission entries never flag cloud AI', receipt.cloudAi);

  console.log(JSON.stringify({ ok: true, webNotification, queried, geoState, screenCapture, internalNotification, entries }, null, 2));
  server.close();
  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
