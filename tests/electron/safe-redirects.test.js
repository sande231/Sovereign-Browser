process.env.SOVEREIGN_TEST_NETWORK_MODE ||= 'online'; // Offline mode is tested in offline-mode.test.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, webContents } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-safe-redirects-'));
const downloads = path.join(profile, 'downloads');
fs.mkdirSync(downloads);
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ ai: { autoDownloadModel: false, setupNoticeSeen: true }, downloads: { askWhereToSave: false }, startup: { continueWhereLeftOff: false }, session: { windows: [] } }));
process.env.SOVEREIGN_USER_DATA_DIR = profile;
process.env.SOVEREIGN_TEST_DOWNLOAD_DIR = downloads;
process.env.SOVEREIGN_TEST_DNS = JSON.stringify(Object.fromEntries(['public.test', 'public2.test'].map(host => [host, { address: '93.184.216.34', connect: '127.0.0.1' }])));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP public.test 127.0.0.1, MAP public2.test 127.0.0.1');
const delay = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(fn) { for (let i = 0; i < 200; i++) { const result = await fn(); if (result) return result; await delay(100); } throw Error('Timed out waiting for page'); }
let secret = 0, fullDownloads = 0;
const server = http.createServer((req, res) => {
  const port = server.address().port;
  const redirect = (code, location) => { res.writeHead(code, { location }); res.end(); };
  if (req.url.startsWith('/search?')) {
    const origin = `http://public.test:${port}`;
    const images = new URL(req.url, origin).searchParams.get('categories') === 'images';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: images ? ['redirect-to-loopback', 'img-chain', 'img-flip'].map(name => ({ title: 'redirect image', url: `${origin}/${name}`, img_src: `${origin}/${name}`, thumbnail_src: `${origin}/${name}` })) : [{ url: `${origin}/article`, title: 'History', content: 'HTTP redirect history' }] }));
  }
  else if (req.url === '/secret') { secret++; res.end('secret'); }
  else if (req.url === '/redirect-to-loopback' || (req.url === '/img-flip' && req.method === 'GET' && !req.headers.range)) {
    if (req.url === '/img-flip') fullDownloads++;
    redirect(302, `http://127.0.0.1:${port}/secret`);
  }
  else if (req.url === '/img-chain') redirect(302, `http://public2.test:${port}/img.png`);
  else if (req.url === '/article') redirect(301, `http://public2.test:${port}/article-final`);
  else if (req.url === '/article-final') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<article><p>${'HTTP redirect history explains how web pages move between addresses and preserve source information. '.repeat(12)}</p></article>`); }
  else { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64')); }
});
async function main() {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  require('../../src/main');
  await app.whenReady();
  const chrome = await waitFor(() => webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().includes('index.html')));
  await chrome.executeJavaScript("window.sovereign.newTab('sovereign://ask/')", true);
  const ask = await waitFor(() => webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL() === 'sovereign://ask/'));
  await waitFor(() => ask.executeJavaScript('Boolean(window.sovereign?.media)', true));
  const origin = `http://public.test:${server.address().port}`;
  const invoke = (method, input) => ask.executeJavaScript(`window.sovereign.${method}(${JSON.stringify(input)})`, true);
  await invoke('search.updateSettings', { endpoint: `http://127.0.0.1:${server.address().port}/search` });
  await invoke('search.media', { requestId: 'safe-images', query: 'redirect image', type: 'images' });
  await assert.rejects(invoke('media.preflight', { url: `${origin}/redirect-to-loopback` }), /private-network/);
  assert.equal(secret, 0);
  await invoke('privacy.startActivity', { requestId: 'safe-images', type: 'ask', query: 'images' });
  const image = await invoke('media.preflight', { url: `${origin}/img-chain` });
  assert.equal(image.url, `http://public2.test:${server.address().port}/img.png`);
  let receipts = await invoke('privacy.getReceipts');
  let entries = receipts.flatMap(r => r.entries);
  assert(entries.some(e => e.host.startsWith('public.test:') && e.category === 'image'));
  assert(entries.some(e => e.host.startsWith('public2.test:') && e.whatWasSent.includes('redirect from public.test')));
  await invoke('search.query', { requestId: 'safe-sources', query: 'HTTP redirect history' });
  const sources = await invoke('search.readSources', { requestId: 'safe-sources', question: 'HTTP redirect history', results: [{ url: `${origin}/article`, title: 'History', snippet: 'fallback' }] });
  assert.equal(sources.sources[0].evidenceMode, 'page');
  receipts = await invoke('privacy.getReceipts');
  entries = receipts.flatMap(r => r.entries).filter(e => e.category === 'source-page');
  assert(entries.some(e => e.host.startsWith('public.test:')));
  assert(entries.some(e => e.host.startsWith('public2.test:') && e.whatWasSent.includes('redirect from public.test')));
  await invoke('media.download', { url: `${origin}/img-flip` });
  await delay(2000);
  assert.equal(secret, 0);
  assert.equal(fullDownloads, 1, 'Chromium must attempt the full download before the redirect is blocked');
  assert.deepEqual(fs.readdirSync(downloads), []);
  console.log(JSON.stringify({ ok: true }));
}
main().then(() => { server.close(); app.exit(0); }, error => { console.error(error); server.close(); app.exit(1); });
