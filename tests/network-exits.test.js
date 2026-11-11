const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createNetworkMode } = require('../src/network-mode');
const source = fs.readFileSync(require.resolve('../src/main'), 'utf8');
// Extract named top-level function bodies; the exit allowlist is deliberately narrow.
function body(name) {
  let start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}
for (const name of ['safeFetchResolve', 'gatedSafeFetch', 'makeReceiptFetch', 'fetchForDownloadPreflight', 'openExternalOnline']) assert.match(body(name), /assertOnline/, name);
let remaining = source;
for (const name of ['safeFetchResolve', 'gatedSafeFetch', 'makeReceiptFetch', 'fetchForDownloadPreflight', 'openExternalOnline', 'setupInternalProtocol']) remaining = remaining.replace(body(name), '');
assert(!/\b(?:net\.fetch|\w+\.fetch|http\.request|https\.request|dns\.lookup|shell\.openExternal)\s*\(/.test(remaining), 'Ungated main-process exit');
// downloadURL relies on the per-session layer-1 guard, installed for future sessions too.
assert.match(body('setupNetworkMonitorForSession'), /offlineDecision|networkDecision/);
assert.match(source, /session-created/);
for (const name of ['SOVEREIGN_AUDIT_PROXY', 'SOVEREIGN_TEST_NETWORK_MODE', 'SOVEREIGN_TEST_OFFLINE_LAYERS']) {
  assert(!source.includes(`process.env.${name}`));
  assert(source.includes(`testHook('${name}'`));
}
for (const file of fs.readdirSync('src').filter(file => file.endsWith('.js'))) {
  const text = fs.readFileSync(`src/${file}`, 'utf8');
  for (const match of text.matchAll(/autoUpdater|update-electron-app|crashReporter/g)) assert.match(text.slice(Math.max(0, match.index - 250), match.index + 250), /assertOnline/, file);
}
// Exercise the actual response listener, including case-insensitive CSP preservation.
let headersListener;
const headerContext = {
  networkMode: createNetworkMode({ initial: 'offline' }),
  offlineLayerOn: () => true,
  offlineConnectSrc: require('../src/network-mode').offlineConnectSrc,
  networkSettings: { offlineAllowlist: [] },
  ses: { webRequest: {
    onCompleted() {}, onErrorOccurred() {}, onBeforeRedirect() {}, onBeforeRequest() {},
    onHeadersReceived(listener) { headersListener = listener; }
  } }
};
vm.runInNewContext(`${body('setupNetworkMonitorForSession')}\nsetupNetworkMonitorForSession(ses);`, headerContext);
assert.equal(typeof headersListener, 'function');
for (const key of ['Content-Security-Policy', 'content-security-policy', 'CONTENT-SECURITY-POLICY']) {
  const headers = { [key]: ["default-src 'self'"], Other: ['keep'] };
  headersListener({ url: 'http://localhost:3000/', responseHeaders: headers }, result => {
    assert.deepEqual(Array.from(result.responseHeaders[key]), ["default-src 'self'", 'connect-src http://localhost:3000 ws://localhost:3000']);
    assert.deepEqual(result.responseHeaders.Other, ['keep']);
    assert.equal(Object.keys(result.responseHeaders).length, 2);
  });
}
headersListener({ url: 'https://localhost/', responseHeaders: {} }, result => {
  assert.deepEqual(Array.from(result.responseHeaders['Content-Security-Policy']), ['connect-src https://localhost wss://localhost']);
});
for (const [mode, layer, url] of [['online', true, 'https://localhost/'], ['offline', false, 'https://localhost/'], ['offline', true, 'file:///tmp/a.html']]) {
  headerContext.networkMode.set(mode);
  headerContext.offlineLayerOn = () => layer;
  headersListener({ url, responseHeaders: {} }, result => assert.equal(JSON.stringify(result), '{}'));
}
// The confirmation count and reload share the same set, including allowlisted pages.
const reloaded = [];
const tab = (url, destroyed = false) => ({ view: { webContents: {
  isDestroyed: () => destroyed, getURL: () => url, reload: () => reloaded.push(url)
} } });
const reloadContext = { windows: new Map([[1, { tabs: new Map([
  [1, tab('https://example.com/')], [2, tab('http://localhost:3000/')],
  [3, tab('file:///tmp/a.html')], [4, tab('https://gone.test/', true)]
]) }]]) };
vm.createContext(reloadContext);
vm.runInContext(`${body('webTabsForOfflineReload')}\n${body('offlineReloadTabCount')}\n${body('reloadWebTabsForOffline')}\nthis.count = offlineReloadTabCount(); reloadWebTabsForOffline();`, reloadContext);
assert.equal(reloadContext.count, 2);
assert.deepEqual(reloaded, ['https://example.com/', 'http://localhost:3000/']);

// Execute the actual wrappers with counting fakes: no resolver or transport is entered.
let calls = 0;
const context = { networkMode: createNetworkMode({ initial: 'offline' }), dns: { lookup() { calls++; } }, safeFetch() { calls++; }, testDns: {}, app: { isPackaged: true } };
vm.createContext(context);
vm.runInContext(`${body('safeFetchResolve')}\n${body('gatedSafeFetch')}\nthis.resolve = safeFetchResolve; this.fetch = gatedSafeFetch;`, context);
(async () => {
  await assert.rejects(() => context.resolve('external.test', {}), { code: 'OFFLINE_MODE' });
  await assert.rejects(() => context.fetch('http://external.test/', {}), { code: 'OFFLINE_MODE' });
  assert.equal(calls, 0);
  console.log('network-exits tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
