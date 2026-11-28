process.env.SOVEREIGN_TEST_NETWORK_MODE = 'online';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, webContents, BrowserWindow } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-navigation-guards-'));
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
  ai: { autoDownloadModel: false, setupNoticeSeen: true },
  startup: { continueWhereLeftOff: false }, session: { windows: [] }
}));
process.env.SOVEREIGN_USER_DATA_DIR = profile;
const appRoot = path.resolve(__dirname, '../..');
const requests = new Map();
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  requests.set(pathname, (requests.get(pathname) || 0) + 1);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Unexpected navigation</title>');
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label) {
  for (let i = 0; i < 200; i++) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function page(predicate, label) {
  const contents = await waitFor(() => webContents.getAllWebContents()
    .find(w => !w.isDestroyed() && predicate(w.getURL())), label);
  await waitFor(() => !contents.isLoadingMainFrame(), `${label} load`);
  await waitFor(() => contents.executeJavaScript('Boolean(document.body && window.sovereign)'), `${label} ready`);
  return contents;
}
async function main() {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  require('../../src/main.js');
  await app.whenReady();
  const toolbar = await page(url => url.endsWith('/index.html'), 'toolbar');
  const windows = [];
  function probe() {
    const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(appRoot, 'src/preload.js'), contextIsolation: true, sandbox: false } });
    windows.push(win);
    return win;
  }
  const external = probe();
  await external.loadURL(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await external.webContents.executeJavaScript('typeof window.sovereign'), 'undefined');
  const internal = probe();
  await internal.loadURL('sovereign://ask/');
  assert.notEqual(await internal.webContents.executeJavaScript('typeof window.sovereign'), 'undefined');
  const add = "window.sovereign.network.addAllowed('127.0.0.1:9')";
  const privacy = "window.sovereign.privacy.updateSettings({sensitiveTopics:'strict'})";
  await assert.rejects(internal.webContents.executeJavaScript(add), /isn't allowed/);
  assert(!JSON.stringify(await toolbar.executeJavaScript('window.sovereign.network.getState()')).includes('127.0.0.1:9'));
  await assert.rejects(toolbar.executeJavaScript(add), /isn't allowed/);
  await assert.rejects(toolbar.executeJavaScript(privacy), /isn't allowed/);
  await toolbar.executeJavaScript('window.sovereign.openSettings()', true);
  const settings = await page(url => url.startsWith('sovereign://settings/'), 'settings');
  assert.equal((await settings.executeJavaScript(add)).ok, true);
  assert.equal((await settings.executeJavaScript("window.sovereign.network.removeAllowed('127.0.0.1:9')")).ok, true);
  await settings.executeJavaScript(privacy);
  await toolbar.executeJavaScript('window.sovereign.toggleSidebar()', true);
  const sidebar = await page(url => url === 'sovereign://ask/sidebar.html', 'sidebar');
  await sidebar.executeJavaScript('window.sovereign.getState()');
  for (const win of windows) win.destroy();
  server.close();
  console.log(JSON.stringify({ ok: true, cases: 5 }));
  app.exit(0);
}
main().catch(error => { console.error(error); app.exit(1); });
