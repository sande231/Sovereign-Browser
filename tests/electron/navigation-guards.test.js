process.env.SOVEREIGN_TEST_NETWORK_MODE = 'online';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, webContents } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-navigation-guards-'));
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
  ai: { autoDownloadModel: false, setupNoticeSeen: true },
  startup: { continueWhereLeftOff: false }, session: { windows: [] }
}));
process.env.SOVEREIGN_USER_DATA_DIR = profile;
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
async function drops(contents, selector, url, expected) {
  const result = await contents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) throw new Error('Missing drop target: ' + ${JSON.stringify(selector)});
    return ['dragover', 'drop'].map(type => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/uri-list', ${JSON.stringify(url)});
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    });
  })()`);
  assert.deepEqual(result, [expected, expected], `${selector}: dragover/drop cancellation`);
}
async function main() {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  require('../../src/main');
  await app.whenReady();
  const toolbar = await page(url => url.endsWith('/index.html'), 'toolbar');
  await toolbar.executeJavaScript('window.sovereign.toggleSidebar()', true);
  const sidebar = await page(url => url === 'sovereign://ask/sidebar.html', 'sidebar');
  const setup = await page(url => url === 'sovereign://ask/model-setup.html', 'model setup');
  await toolbar.executeJavaScript('window.sovereign.openSettings()', true);
  const internal = await page(url => url.startsWith('sovereign://settings/'), 'settings internal tab');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const checked = [];
  for (const [name, contents, hasDropGuard] of [
    ['toolbar', toolbar, true], ['sidebar', sidebar, true],
    ['model-setup', setup, true], ['internal', internal, false]
  ]) {
    const originalURL = contents.getURL();
    const navPath = `/nav-${name}`;
    await contents.executeJavaScript(`location.href = ${JSON.stringify(origin + navPath)}`);
    await delay(1000);
    assert.equal(contents.getURL(), originalURL, `${name}: navigation changed URL`);
    assert.equal(requests.get(navPath) || 0, 0, `${name}: navigation reached server`);
    const openPath = `/open-${name}`;
    assert.equal(await contents.executeJavaScript(`window.open(${JSON.stringify(origin + openPath)}) === null`), true, `${name}: popup must return null`);
    await delay(1000);
    assert(!webContents.getAllWebContents().some(w => !w.isDestroyed() && w.getURL() === origin + openPath), `${name}: popup webContents exists`);
    assert.equal(requests.get(openPath) || 0, 0, `${name}: popup reached server`);
    if (hasDropGuard) await drops(contents, 'body', `${origin}/drop-${name}`, true);
    if (name === 'toolbar') {
      for (const selector of ['#address', '#find-input']) await drops(contents, selector, `${origin}/drop-${name}`, false);
    }
    checked.push({ name, navigation: true, popup: true, drops: hasDropGuard ? 'passed' : 'skipped: internal page unchanged' });
  }
  console.log(JSON.stringify({ ok: true, checked, requests: Object.fromEntries(requests) }));
  server.close();
  app.exit(0);
}
main().catch(error => { console.error(error); app.exit(1); });
