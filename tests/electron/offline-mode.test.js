// Offline mode (docs/HANDOFF.md, "Offline mode"). Proves that while Offline no request reaches
// "external" hosts. external.test is mapped to 127.0.0.1 so a leak lands on counting servers here;
// the app's rules treat it as external because the host name is not loopback.
// Phases run as separate Electron processes: main (all layers), webrequest-only, proxy-only,
// and the preference cases (fresh, old, old-again, corrupt).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const phase = (process.argv.find(arg => arg.startsWith('--phase=')) || '--phase=orchestrate').slice(8);
const delay = ms => new Promise(done => setTimeout(done, ms));
const OPEN_EXTERNAL_MESSAGE = "Offline mode is on. Opening another app would leave Sovereign's protection.";

// ---------------------------------------------------------------------------------------------
// Orchestrator (runs under Electron too, but never loads the app).
function runPhase(name, { profile, env = {}, ports }) {
  const childEnv = { ...process.env, ...env, SOVEREIGN_USER_DATA_DIR: profile, OFFLINE_TEST_PORTS: JSON.stringify(ports || {}) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (!('SOVEREIGN_TEST_NETWORK_MODE' in env)) delete childEnv.SOVEREIGN_TEST_NETWORK_MODE;
  if (!('SOVEREIGN_TEST_OFFLINE_LAYERS' in env)) delete childEnv.SOVEREIGN_TEST_OFFLINE_LAYERS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, `--phase=${name}`], { env: childEnv });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const last = stdout.trim().split('\n').filter(line => line.startsWith('{')).pop() || '';
      if (code !== 0 || !last.includes('"ok":true')) {
        reject(new Error(`${name} failed (${code})\n${stdout}\n${stderr.split('\n').filter(l => !/^\[\d+:|Sovereign AI/.test(l)).slice(-40).join('\n')}`));
      } else {
        resolve(JSON.parse(last));
      }
    });
  });
}

function makeProfile(prefs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-offline-'));
  fs.mkdirSync(path.join(dir, 'downloads'));
  if (prefs === 'corrupt') fs.writeFileSync(path.join(dir, 'preferences.json'), 'not json {');
  else if (prefs) fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify(prefs));
  return dir;
}

function basePrefs(extra = {}) {
  return {
    ai: { autoDownloadModel: false, setupNoticeSeen: true, setupCanceled: false },
    downloads: { askWhereToSave: false },
    startup: { continueWhereLeftOff: false },
    session: { windows: [] },
    ...extra
  };
}

async function orchestrate() {
  const results = {};
  const offlinePrefs = ports => basePrefs({
    search: { endpoint: `http://127.0.0.1:${ports.searx}/search` },
    network: { mode: 'offline', choiceMade: true, offlineAllowlist: [] },
    startup: { continueWhereLeftOff: true },
    session: { windows: [{ activeIndex: 0, tabs: [{ url: `http://external.test:${ports.http}/restored`, title: 'Restored' }] }] }
  });
  const servers = await startServers();
  try {
    const ports = servers.ports;
    for (const [name, env] of [['main', {}], ['webrequest', { SOVEREIGN_TEST_OFFLINE_LAYERS: 'webrequest' }], ['proxy', { SOVEREIGN_TEST_OFFLINE_LAYERS: 'proxy' }]]) {
      const profile = makeProfile(offlinePrefs(ports));
      servers.reset();
      try {
        results[name] = await runPhase(name, { profile, env, ports });
      } finally {
        fs.rmSync(profile, { recursive: true, force: true });
      }
    }
    const confirm = makeProfile(basePrefs({ network: { mode: 'online', choiceMade: true } }));
    try { results.confirm = await runPhase('confirm', { profile: confirm, ports }); }
    finally { fs.rmSync(confirm, { recursive: true, force: true }); }
    const fresh = makeProfile(null);
    results.fresh = await runPhase('fresh', { profile: fresh, ports });
    fs.rmSync(fresh, { recursive: true, force: true });
    const old = makeProfile(basePrefs());
    results.old = await runPhase('old', { profile: old, ports });
    const saved = JSON.parse(fs.readFileSync(path.join(old, 'preferences.json'), 'utf8'));
    assert.deepEqual({ mode: saved.network.mode, choiceMade: saved.network.choiceMade }, { mode: 'online', choiceMade: true });
    results.oldAgain = await runPhase('old-again', { profile: old, ports });
    fs.rmSync(old, { recursive: true, force: true });
    const corrupt = makeProfile('corrupt');
    results.corrupt = await runPhase('corrupt', { profile: corrupt, ports });
    fs.rmSync(corrupt, { recursive: true, force: true });
  } finally {
    await servers.close();
  }
  console.log(JSON.stringify({ ok: true, results }));
}

// ---------------------------------------------------------------------------------------------
// Counting servers. Every TCP connection and UDP datagram is counted, so even a failed TLS
// handshake or a refused WebSocket counts as a leak.
async function startServers() {
  const counts = { http: 0, tls: 0, ws: 0, udp: 0, searx: 0, page: 0, wsOpen: 0, wsClosed: 0 };
  const sockets = new Set();
  const track = (server, key) => server.on('connection', socket => {
    counts[key] += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const httpServer = http.createServer((req, res) => {
    if (req.url.startsWith('/slow')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(1024 * 1024 * 50), 'content-disposition': 'attachment; filename="slow.bin"' });
      const timer = setInterval(() => res.write(Buffer.alloc(1024)), 100);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('external');
  });
  track(httpServer, 'http');

  const tlsServer = net.createServer(socket => socket.destroy());
  track(tlsServer, 'tls');

  const wsServer = http.createServer((_req, res) => res.end('ws'));
  wsServer.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    counts.wsOpen += 1;
    let closedOnce = false;
    const markClosed = () => { if (!closedOnce) { closedOnce = true; counts.wsClosed += 1; } };
    // A close frame (opcode 8) from the browser counts as closed; then drop the socket.
    socket.on('data', chunk => { if ((chunk[0] & 0x0f) === 8) { markClosed(); socket.destroy(); } });
    socket.on('close', markClosed);
    socket.on('error', () => {});
  });
  track(wsServer, 'ws');

  const searxServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  track(searxServer, 'searx');

  const pageHtml = ports => `<!doctype html><title>Local page</title><body><p id="text">Local page text for offline tests.</p>
<link rel="preconnect" href="http://external.test:${ports.http}"><link rel="dns-prefetch" href="http://dns-prefetch.external.test">
<a id="ping" href="#x" ping="http://external.test:${ports.http}/ping">ping</a>
<script>
window.results = {};
function probe(sw) {
  fetch('http://external.test:${ports.http}/x?q=SECRET123').then(() => { results.fetch = 'ok'; }, () => { results.fetch = 'blocked'; });
  const img = new Image(); img.onerror = () => { results.img = 'blocked'; }; img.onload = () => { results.img = 'ok'; }; img.src = 'http://external.test:${ports.http}/img.png';
  try { const ws = new WebSocket('ws://external.test:${ports.ws}/'); ws.onopen = () => { results.ws = 'open'; }; ws.onerror = () => { results.ws = 'blocked'; }; } catch { results.ws = 'blocked'; }
  try { navigator.sendBeacon('http://external.test:${ports.http}/beacon', 'x'); } catch {}
  document.getElementById('ping').click();
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${ports.udp}' }, { urls: 'stun:external.test:${ports.udp}' }] });
    pc.createDataChannel('x'); pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => {});
  } catch {}
  // WebTransport bypasses webRequest cancellation; Offline CSP covers the webrequest layer.
  try { if (window.WebTransport && !location.search.includes('wt=0')) new WebTransport('https://external.test:${ports.udp}/').ready.catch(() => {}); } catch {}
  if (sw && navigator.serviceWorker) navigator.serviceWorker.register('/sw.js').then(() => { results.sw = 'registered'; }, error => { results.sw = 'failed: ' + error.message; });
}
if (!location.search.includes('probe=0')) probe(location.search.includes('sw=1'));
</script></body>`;
  const sw = ports => `self.addEventListener('install', event => { event.waitUntil(fetch('http://external.test:${ports.http}/sw').catch(() => {})); self.skipWaiting(); });`;
  let ports = {};
  const pageServer = http.createServer((req, res) => {
    if (req.url.startsWith('/sw.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(sw(ports));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pageHtml(ports));
  });
  track(pageServer, 'page');

  const udp = dgram.createSocket('udp4');
  udp.on('message', () => { counts.udp += 1; });

  const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
  ports = {
    http: await listen(httpServer),
    tls: await listen(tlsServer),
    ws: await listen(wsServer),
    searx: await listen(searxServer),
    page: await listen(pageServer)
  };
  // UDP uses the same port number as TLS is unrelated; pick its own port.
  await new Promise(done => udp.bind(0, '127.0.0.1', done));
  ports.udp = udp.address().port;

  // A tiny control channel so child phases can read and reset counters.
  const control = http.createServer((req, res) => {
    if (req.url === '/reset') for (const key of Object.keys(counts)) counts[key] = 0;
    if (req.url === '/close-sockets') for (const socket of sockets) socket.destroy();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(counts));
  });
  ports.control = await listen(control);

  return {
    ports,
    // Each phase starts from zero on the shared counting servers.
    reset() {
      for (const socket of sockets) socket.destroy();
      for (const key of Object.keys(counts)) counts[key] = 0;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      udp.close();
      await Promise.all([httpServer, tlsServer, wsServer, searxServer, pageServer, control].map(server => new Promise(done => server.close(done))));
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Child phases: load the app with the profile prepared by the orchestrator.
async function child() {
  const ports = JSON.parse(process.env.OFFLINE_TEST_PORTS || '{}');
  const { app, session, webContents } = require('electron');
  process.env.SOVEREIGN_TEST_DOWNLOAD_DIR = path.join(process.env.SOVEREIGN_USER_DATA_DIR, 'downloads');
  process.env.SOVEREIGN_TEST_DNS = JSON.stringify({ 'external.test': { address: '93.184.216.34', connect: '127.0.0.1' } });
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP external.test 127.0.0.1, MAP *.external.test 127.0.0.1');

  // Counters live in the orchestrator; read them over the loopback control port. This request
  // is made from Node in the test, not by the app, so Offline mode does not apply to it.
  const counts = () => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: ports.control, path: '/' }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
  const control = pathName => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: ports.control, path: pathName }, res => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  async function waitFor(fn, label, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  const find = predicate => webContents.getAllWebContents().find(contents => !contents.isDestroyed() && predicate(contents.getURL()));
  const assertNoExternal = async label => {
    const c = await counts();
    assert.deepEqual({ http: c.http, tls: c.tls, ws: c.ws, udp: c.udp, searx: c.searx }, { http: 0, tls: 0, ws: 0, udp: 0, searx: 0 }, `${label}: ${JSON.stringify(c)}`);
  };

  require('../../src/main');
  await app.whenReady();
  const chrome = await waitFor(() => find(url => url.includes('index.html')), 'browser chrome');
  await waitFor(() => chrome.executeJavaScript('Boolean(window.sovereign?.network)', true), 'preload');
  const ui = code => chrome.executeJavaScript(code, true);
  const network = () => ui('window.sovereign.network.getState()');
  const introHidden = () => ui("document.querySelector('#network-intro').hidden");
  const statusText = () => ui("document.querySelector('#status').textContent");
  const openTab = async (url, match = url) => {
    await ui(`window.sovereign.newTab(${JSON.stringify(url)})`);
    return waitFor(() => find(current => current.startsWith(match)), `tab ${url}`);
  };
  const result = { phase };

  if (phase === 'confirm') {
    assert.equal((await ui("window.sovereign.network.setMode('offline')")).mode, 'offline', 'no website tabs: immediate');
    await ui("window.sovereign.network.setMode('online')");
    const website = await openTab(`http://127.0.0.1:${ports.page}/page?wt=0`);
    await waitFor(() => website.executeJavaScript('document.readyState === "complete"'), 'website loaded');
    assert.equal((await ui(`window.sovereign.network.addAllowed('127.0.0.1:${ports.page}')`)).ok, true);
    let reloads = 0;
    website.on('did-start-loading', () => reloads++);
    for (const method of ['setMode', 'dismissIntro']) {
      const response = await ui(`window.sovereign.network.${method}('offline')`);
      assert.equal(response.needsConfirm, true);
      assert.equal(response.ok, false);
      assert.equal(response.tabCount, 1);
      assert.equal(response.message, 'Switching to Offline will reload 1 open website tab. Unsaved text in forms may be lost.');
      assert.equal(response.state.mode, 'online');
      assert.equal((await network()).mode, 'online');
      await delay(250);
      assert.equal(reloads, 0);
    }
    await ui("document.querySelector('#network-mode-toggle').click()");
    await waitFor(() => ui("!document.querySelector('#network-confirm').hidden"), 'confirmation strip');
    await ui("document.querySelector('#network-confirm-cancel').click()");
    assert.equal((await network()).mode, 'online');
    assert.equal(reloads, 0);
    await ui("window.sovereign.network.setMode('offline', { confirmed: true })");
    assert.equal((await network()).mode, 'offline');
    await waitFor(() => reloads > 0, 'confirmed reload');
    console.log(JSON.stringify({ ok: true, ...result }));
    app.quit();
    return;
  }

  if (['fresh', 'old', 'old-again', 'corrupt'].includes(phase)) {
    await delay(1500);
    const state = await network();
    if (phase === 'fresh') {
      assert.equal(state.mode, 'offline');
      assert.equal(await introHidden(), true, 'new install: no question asked');
      await delay(2500);
      const receipts = await ui('window.sovereign.privacy.getReceipts()');
      assert(!receipts.flatMap(r => r.entries).some(e => e.category === 'model-download'), 'no model download while Offline');
      const setup = await ui('window.sovereign.modelSetup.getState()');
      assert.notEqual(setup.status, 'downloading');
    } else if (phase === 'old') {
      assert.equal(state.mode, 'online', 'existing users keep their behaviour');
      assert.equal(await introHidden(), false, 'existing users are asked once');
      await ui("document.querySelector('#network-intro-online').click()");
      await waitFor(introHidden, 'intro hidden after choice');
      assert.equal((await network()).choiceMade, true);
    } else if (phase === 'old-again') {
      assert.equal(state.mode, 'online');
      assert.equal(await introHidden(), true, 'asked only once');
    } else {
      assert.equal(state.mode, 'offline', 'unreadable preferences fail closed');
      assert.equal(await introHidden(), false);
    }
    result.mode = state.mode;
    return result;
  }

  // ---- main / per-layer phases ----
  assert.equal((await network()).mode, 'offline');
  const allLayers = phase === 'main';

  // Session restore: the saved website tab is restored but nothing is fetched.
  await delay(2000);
  await assertNoExternal('session restore');
  const restoredTab = (await ui('window.sovereign.getState()')).tabs.find(tab => tab.url.includes('/restored'));
  assert(restoredTab, 'saved website tab is kept');

  // Tab navigation over HTTP and HTTPS.
  await ui(`window.sovereign.navigate(${JSON.stringify(`http://external.test:${ports.http}/nav?q=SECRET123`)})`);
  await delay(1500);
  if (allLayers) assert.match(await statusText(), /Offline mode is on/);
  await ui(`window.sovereign.navigate(${JSON.stringify(`https://external.test:${ports.tls}/nav`)})`);
  await delay(1500);
  await assertNoExternal('navigation');

  const pageOrigin = `http://127.0.0.1:${ports.page}`;
  if (allLayers) {
    // Default empty allowlist: even the loopback page is blocked.
    await ui(`window.sovereign.navigate(${JSON.stringify(`${pageOrigin}/blocked`)})`);
    await delay(1500);
    assert.equal((await counts()).page, 0, 'loopback page blocked without allowlist');
    assert.match(await statusText(), /isn't on your Offline allowlist/);
    // SearXNG and non-loopback entries are refused; the page entry is accepted.
    const searx = await ui(`window.sovereign.network.addAllowed('127.0.0.1:${ports.searx}')`);
    assert.equal(searx.ok, false);
    assert.match(searx.error, /SearXNG forwards searches/);
    assert.equal((await ui("window.sovereign.network.addAllowed('192.168.1.5:80')")).ok, false);
  }
  // Every phase allowlists the local test page so its subresource probes actually run.
  const added = await ui(`window.sovereign.network.addAllowed('127.0.0.1:${ports.page}')`);
  assert.equal(added.ok, true);
  assert.deepEqual((await network()).offlineAllowlist, [`127.0.0.1:${ports.page}`]);

  // From an allowed loopback page: fetch, image, WebSocket, preconnect, dns-prefetch, ping,
  // beacon, WebRTC STUN, WebTransport and a service worker install fetch.
  const page = await openTab(`${pageOrigin}/page?sw=1${phase === 'webrequest' ? '&wt=0' : ''}`);
  assert.equal(page.getWebRTCIPHandlingPolicy(), 'disable_non_proxied_udp');
  await waitFor(() => page.executeJavaScript('document.readyState === "complete"'), 'local page');
  await delay(4000);
  if (phase !== 'proxy') {
    assert.equal(await page.executeJavaScript('typeof WebTransport'), 'function');
    await page.executeJavaScript(`new WebTransport('https://127.0.0.1:${ports.udp}/').ready.catch(() => {}); void 0`);
    await delay(2000);
    assert.equal((await counts()).udp, 0, 'WebTransport to unallowlisted loopback UDP port sends nothing');
  }
  assert.match(await page.executeJavaScript("fetch('/local-check').then(r => r.text())"), /Local page text/, 'same-origin fetch works with Offline CSP');
  const pageResults = await page.executeJavaScript('window.results');
  result.pageResults = pageResults;
  await assertNoExternal('page subresources');
  assert.equal(pageResults.fetch, 'blocked', 'page probes ran');
  if (allLayers) {
    assert.equal(pageResults.ws, 'blocked');
    assert.match(await page.executeJavaScript("document.querySelector('#text').textContent"), /Local page text/);
  }

  // Downloads.
  page.downloadURL(`http://external.test:${ports.http}/file.bin`);
  await delay(1500);
  await assertNoExternal('download');

  if (!allLayers) {
    return result;
  }

  // localhost still resolves with the DNS layer on (allowlist it and load it).
  await ui(`window.sovereign.network.addAllowed('localhost:${ports.page}')`);
  const localhostPage = await openTab(`http://localhost:${ports.page}/page`, `http://localhost:${ports.page}`);
  await waitFor(() => localhostPage.executeJavaScript('document.readyState === "complete"'), 'localhost page');
  assert.match(await localhostPage.executeJavaScript("document.querySelector('#text')?.textContent || ''"), /Local page text/, 'localhost works while Offline');
  await ui(`window.sovereign.network.removeAllowed('localhost:${ports.page}')`);

  // Main-process exits: search, sources, media, download box, open in another app.
  await ui("window.sovereign.newTab('sovereign://ask/')");
  const ask = await waitFor(() => find(url => url === 'sovereign://ask/'), 'Ask tab');
  await waitFor(() => ask.executeJavaScript('Boolean(window.sovereign?.search)', true), 'ask preload');
  const invoke = (method, input) => ask.executeJavaScript(`window.sovereign.${method}(${JSON.stringify(input)})`, true);
  await invoke('privacy.startActivity', { requestId: 'offline-ask', type: 'ask', query: 'SECRET123 question' });
  await assert.rejects(invoke('search.query', { requestId: 'offline-search', query: 'SECRET123' }), /Offline mode is on/);
  await assert.rejects(invoke('search.readSources', { requestId: 'offline-sources', question: 'SECRET123', results: [{ url: `http://external.test:${ports.http}/a`, title: 'a', snippet: 'b' }] }), /Offline mode is on/);
  await assert.rejects(invoke('media.preflight', { url: `http://external.test:${ports.http}/i.png` }), /Offline mode is on/);
  await assert.rejects(invoke('media.download', { url: `http://external.test:${ports.http}/i.png` }), /Offline mode is on/);
  await assert.rejects(ui(`window.sovereign.downloads.downloadUrl(${JSON.stringify(`http://external.test:${ports.http}/f.bin`)})`), /Offline mode is on/);
  const external = await ui("window.sovereign.openExternal('https://example.com/')");
  assert.deepEqual(external, { ok: false, offline: true, error: OPEN_EXTERNAL_MESSAGE });
  await assertNoExternal('main-process exits');
  assert.equal(await ask.executeJavaScript("document.querySelector('#web-toggle').disabled"), true, 'Search the web disabled');
  assert.equal(await ask.executeJavaScript("document.querySelector('#web-offline-note').hidden"), false);

  // Model download stays off while Offline.
  const setup = await ui('window.sovereign.modelSetup.start()');
  assert.notEqual(setup.status, 'downloading');
  await delay(2000);
  assert.notEqual((await ui('window.sovereign.modelSetup.getState()')).status, 'downloading');

  // Spellchecker dictionary downloads are switched off.
  assert.equal(session.defaultSession.isSpellCheckerEnabled(), false, 'spellchecker off while Offline');
  if (process.platform !== 'darwin') {
    session.defaultSession.setSpellCheckerDictionaryDownloadURL(`http://external.test:${ports.http}/dict/`);
    session.defaultSession.setSpellCheckerLanguages(['fr']);
    await delay(2000);
    await assertNoExternal('spellchecker');
    result.spellcheckDownload = 'tested';
  } else {
    result.spellcheckDownload = 'skipped on macOS: the system spellchecker downloads nothing';
  }

  // Privacy Receipt: "Offline: 0 external requests", blocked attempts listed, no question text.
  const receipts = await ui('window.sovereign.privacy.getReceipts()');
  const offlineReceipts = receipts.filter(r => r.offline);
  assert(offlineReceipts.length > 0);
  for (const receipt of offlineReceipts) assert.match(receipt.summary, /^Offline: 0 external requests/, receipt.summary);
  assert(offlineReceipts.some(r => r.entries.some(e => e.category === 'blocked' && e.whatWasSent.startsWith('blocked (offline mode)'))));
  const blockedEntries = offlineReceipts.flatMap(r => r.entries).filter(e => e.category === 'blocked');
  assert(blockedEntries.every(e => !e.url.includes('/x') && !e.url.includes('?')), 'blocked entries keep the origin only');
  const exported = JSON.stringify(receipts);
  assert(!/SECRET123/.test(exported.replace(/"query":"SECRET123 question"/g, '')), 'question text never stored in blocked entries');
  result.offlineSummary = offlineReceipts[0].summary;

  // Mode switches: a WebSocket and a download opened Online are cut off when going Offline.
  await ui("window.sovereign.network.setMode('online')");
  assert.equal(session.defaultSession.isSpellCheckerEnabled(), true, 'spellchecker restored when Online');
  // Reload Online to discard the Offline document's CSP; suppress automatic probes.
  await page.loadURL(`${pageOrigin}/page?probe=0`);

  await page.executeJavaScript(`window.liveWs = new WebSocket('ws://external.test:${ports.ws}/'); new Promise(done => { liveWs.onopen = () => done(true); liveWs.onerror = () => done(false); })`);
  page.downloadURL(`http://external.test:${ports.http}/slow.bin`);
  await waitFor(async () => (await counts()).wsOpen === 1, 'WebSocket open while Online');
  await waitFor(async () => (await ui('window.sovereign.downloads.getState()')).downloads.some(d => d.state === 'progressing' && d.receivedBytes > 0), 'slow download running');
  // WebRTC baseline: Online, a STUN request to the UDP counter is sent; Offline, none is.
  const stun = `new Promise(done => { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${ports.udp}' }] }); pc.createDataChannel('x'); pc.createOffer().then(o => pc.setLocalDescription(o)); setTimeout(() => { pc.close(); done(true); }, 2500); })`;
  await page.executeJavaScript(stun);
  result.onlineUdp = (await counts()).udp;

  await ui("window.sovereign.network.setMode('offline', { confirmed: true })");
  await waitFor(async () => (await counts()).wsClosed >= 1, 'WebSocket closed when going Offline');
  await waitFor(async () => (await ui('window.sovereign.downloads.getState()')).downloads.some(d => d.status === 'Paused: Offline mode' && d.offlinePaused), 'download paused for Offline mode');
  await control('/close-sockets');
  const before = await counts();
  await page.executeJavaScript(`fetch('http://external.test:${ports.http}/after').catch(() => {})`);
  await delay(1500);
  await page.executeJavaScript(stun);
  const after = await counts();
  assert.equal(after.http, before.http, 'no new connection after going Offline');
  assert.equal(after.udp, before.udp, 'no STUN datagram after going Offline');

  await ui("window.sovereign.network.setMode('online')");
  await page.loadURL(`${pageOrigin}/page?probe=0`);
  const reached = await page.executeJavaScript(`fetch('http://external.test:${ports.http}/online').then(r => r.text(), () => 'failed')`);
  assert.equal(reached, 'external', 'requests work again when Online (the test is not vacuous)');
  assert((await counts()).http > after.http);
  // Online control for the Offline WebTransport case. Runs last: Chromium keeps retransmitting
  // an unanswered QUIC handshake for ~4 s after close(), which would bleed into Offline checks.
  const beforeTransport = (await counts()).udp;
  await page.executeJavaScript(`window.onlineTransport = new WebTransport('https://127.0.0.1:${ports.udp}/'); onlineTransport.ready.catch(() => {}); onlineTransport.closed.catch(() => {}); void 0`);
  await waitFor(async () => (await counts()).udp > beforeTransport, 'Online WebTransport datagram');
  result.onlineWebTransportUdp = (await counts()).udp - beforeTransport;
  assert(result.onlineWebTransportUdp >= 1);
  await page.executeJavaScript('onlineTransport.close(); void 0');
  return result;
}

const isElectronApp = Boolean(process.versions.electron) && process.type === 'browser';
if (!isElectronApp) {
  console.error('Run with Electron: npm run test:electron:offline-mode');
  process.exit(1);
}
const { app } = require('electron');
if (phase === 'orchestrate') {
  app.whenReady().then(orchestrate).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else {
  child().then(result => {
    console.log(JSON.stringify({ ok: true, ...result }));
    app.exit(0);
  }, error => {
    console.error(error);
    app.exit(1);
  });
}
