const assert = require('node:assert/strict');
const {
  MAX_ALLOWLIST, SEARXNG_ALLOWLIST_ERROR, isLoopbackHost, parseAllowlistEntry,
  normalizeAllowlist, offlineConnectSrc, offlineDecision, initialNetworkState, createNetworkMode
} = require('../src/network-mode');

const connectSrcCases = [
  ['http://localhost:3000/path?q=private', [], 'connect-src http://localhost:3000 ws://localhost:3000'],
  ['https://localhost:443/path', [], 'connect-src https://localhost wss://localhost'],
  ['http://localhost:80/', [], 'connect-src http://localhost ws://localhost'],
  ['https://[::1]:8443/', ['[::1]:8000', 'localhost:80'], 'connect-src https://[::1]:8443 wss://[::1]:8443 http://[::1]:8000 https://[::1]:8000 ws://[::1]:8000 wss://[::1]:8000 http://localhost:80 https://localhost:80 ws://localhost:80 wss://localhost:80']
];
for (const [url, entries, expected] of connectSrcCases) {
  assert.equal(offlineConnectSrc(url, entries), expected, url);
}

const allowed = reason => ({ allow: true, reason });
const blocked = reason => ({ allow: false, reason });
const allowlist = ['127.0.0.1:3000', 'localhost:5173', '[::1]:8000', 'foo.localhost:80'];

// Internal URLs and local files need no allowlist entry.
const defaultCases = [
  ['sovereign://ask/', allowed('internal')],
  ['file:///tmp/a.pdf', allowed('local-file')],
  ['data:text/plain,x', allowed('internal')],
  ['blob:https://example.com/id', allowed('internal')],
  ['about:blank', allowed('internal')],
  ['devtools://devtools/', allowed('internal')],
  ['chrome://network-error/', allowed('internal')],
  ['chrome-error://chromewebdata/', allowed('internal')],
  ['http://127.0.0.1:3000/', blocked('local-not-allowed')],
  ['ws://localhost:5173/', blocked('local-not-allowed')],
  ['http://[::1]:8000/', blocked('local-not-allowed')]
];
for (const [input, expected] of defaultCases) {
  assert.deepEqual(offlineDecision(input), expected, `default: ${input}`);
}

const allowlistCases = [
  ['http://127.0.0.1:3000/x', allowed('allowlisted')],
  ['ws://localhost:5173/', allowed('allowlisted')],
  ['http://[::1]:8000/', allowed('allowlisted')],
  ['http://foo.localhost/', allowed('allowlisted')],
  ['https://127.0.0.1:3000/', allowed('allowlisted')],
  ['wss://localhost:5173/', allowed('allowlisted')],
  ['http://127.0.0.1:3001/', blocked('local-not-allowed')],
  ['http://localhost:3000/', blocked('local-not-allowed')],
  ['https://127.0.0.1/', blocked('local-not-allowed')]
];
for (const [input, expected] of allowlistCases) {
  assert.deepEqual(offlineDecision(input, { allowlist }), expected, `allowlist: ${input}`);
}

const alwaysBlockedCases = [
  ['https://example.com/', blocked('external')],
  ['wss://example.com/', blocked('external')],
  ['http://192.168.1.10/', blocked('external')],
  ['http://10.0.0.1/', blocked('external')],
  ['http://0.0.0.0/', blocked('external')],
  ['http://[::ffff:127.0.0.1]/', blocked('external')],
  ['file://server/share/x', blocked('external')],
  ['ftp://127.0.0.1/', blocked('external')],
  ['not a url', blocked('external')],
  ['http://foo.nip.io/', blocked('external')]
];
for (const [input, expected] of alwaysBlockedCases) {
  assert.deepEqual(offlineDecision(input), expected, `default: ${input}`);
  assert.deepEqual(offlineDecision(input, { allowlist }), expected, `allowlist: ${input}`);
}
for (const [input, expected] of [
  ['127.0.0.1:8080', blocked('blocked-local-service')],
  ['http://127.0.0.1:8080', blocked('blocked-local-service')]
]) {
  assert.deepEqual(offlineDecision('http://127.0.0.1:8080/search?q=x', {
    allowlist: [...allowlist, '127.0.0.1:8080'], blockedOrigins: [input]
  }), expected, `blocked origin: ${input}`);
}

const loopbackCases = [
  ['localhost', true],
  ['LOCALHOST', true],
  ['foo.localhost', true],
  ['127.0.0.1', true],
  ['127.255.1.2', true],
  ['::1', true],
  ['[::1]', true],
  ['0.0.0.0', false],
  ['::ffff:127.0.0.1', false],
  ['192.168.1.1', false],
  ['10.0.0.1', false],
  ['172.16.0.1', false],
  ['foo.nip.io', false],
  ['127.999.0.1', false]
];
for (const [input, expected] of loopbackCases) {
  assert.equal(isLoopbackHost(input), expected, input);
}

const acceptedEntries = [
  ['127.0.0.1:3000', '127.0.0.1:3000'],
  ['LOCALHOST:5173', 'localhost:5173'],
  ['[::1]:8000', '[::1]:8000']
];
for (const [input, expected] of acceptedEntries) {
  assert.deepEqual(parseAllowlistEntry(input), { ok: true, entry: expected }, input);
}
const formatError = 'Enter an address as host:port, for example 127.0.0.1:3000.';
const portError = 'The port must be between 1 and 65535.';
const auditError = "The audit proxy forwards requests, so it can't be allowed in Offline mode.";
const blockedHostPorts = [
  '127.0.0.1:8080',
  { entry: 'localhost:9090', error: auditError }
];
const rejectedEntries = [
  ['192.168.1.5:80', 'Only addresses on this computer can be allowed.'],
  ['example.com:80', 'Only addresses on this computer can be allowed.'],
  ['127.0.0.1', formatError],
  ['http://127.0.0.1:3000', formatError],
  ['127.0.0.1:0', portError],
  ['127.0.0.1:70000', portError],
  ['127.0.0.1:8080', SEARXNG_ALLOWLIST_ERROR],
  ['LOCALHOST:9090', auditError]
];
for (const [input, expected] of rejectedEntries) {
  assert.deepEqual(parseAllowlistEntry(input, { blockedHostPorts }), { ok: false, error: expected }, input);
}

assert.equal(MAX_ALLOWLIST, 20);
const normalizeCases = [
  [['bad', '192.168.1.5:80', 'LOCALHOST:80', 'localhost:80', '[::1]:8000', '127.0.0.1:0'], ['localhost:80', '[::1]:8000']],
  [Array.from({ length: 30 }, (_, i) => `localhost:${i + 1}`), Array.from({ length: 20 }, (_, i) => `localhost:${i + 1}`)],
  [['127.0.0.1:8080', 'localhost:9090', 'LOCALHOST:5173'], ['localhost:5173']]
];
for (const [input, expected] of normalizeCases) {
  assert.deepEqual(normalizeAllowlist(input, { blockedHostPorts }), expected);
}

const initialStateCases = [
  [{ prefsFileExisted: false }, { mode: 'offline', choiceMade: true }],
  [{ prefsFileExisted: true, parsed: {} }, { mode: 'online', choiceMade: false }],
  [{ prefsFileExisted: true, parsed: { network: { mode: 'offline', choiceMade: true } } }, { mode: 'offline', choiceMade: true }],
  [{ prefsFileExisted: true, parsed: null }, { mode: 'offline', choiceMade: false }]
];
for (const [input, expected] of initialStateCases) {
  assert.deepEqual(initialNetworkState(input), expected);
}

const changes = [];
const mode = createNetworkMode({ initial: 'offline', onChange: (next, previous) => changes.push([next, previous]) });
const modeCases = [
  ['offline', { changed: false, changes: [] }],
  ['online', { changed: true, changes: [['online', 'offline']] }],
  ['online', { changed: false, changes: [['online', 'offline']] }],
  ['offline', { changed: true, changes: [['online', 'offline'], ['offline', 'online']] }],
  ['offline', { changed: false, changes: [['online', 'offline'], ['offline', 'online']] }]
];
for (const [input, expected] of modeCases) {
  assert.equal(mode.set(input), expected.changed, input);
  assert.equal(mode.mode, input);
  assert.equal(mode.isOffline(), input === 'offline');
  assert.deepEqual(changes, expected.changes);
  if (input === 'offline') {
    assert.throws(() => mode.assertOnline('search'), {
      message: 'Offline mode is on.', code: 'OFFLINE_MODE', purpose: 'search'
    });
  } else {
    assert.doesNotThrow(() => mode.assertOnline('search'));
  }
}

console.log('network-mode tests passed');
