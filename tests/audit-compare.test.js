const assert = require('node:assert/strict');
const {
  captureLabel,
  compareHosts,
  hostMatchesCloudAi,
  isBareIp,
  isLoopbackHost,
  normalizeHost,
  parseArgs,
  readNetworkHosts,
  readReceiptHosts
} = require('../scripts/audit-compare');

assert.equal(normalizeHost('HTTPS://Example.COM:443/path'), 'example.com');
assert.equal(normalizeHost('www.News.Example:8443'), 'news.example');
assert.equal(hostMatchesCloudAi('api.openai.com'), 'api.openai.com');
assert.equal(hostMatchesCloudAi('proxy.api.openai.com'), 'api.openai.com');

const networkHosts = readNetworkHosts(`
Example.com
missing.example:443
api.openai.com
`);

const receiptHosts = readReceiptHosts({
  receipts: [
    {
      entries: [
        { host: 'example.com' },
        { host: 'receipt-only.example:8080' },
        { url: 'https://api.openai.com/v1/responses' }
      ]
    }
  ]
});

const result = compareHosts(networkHosts, receiptHosts);
assert.deepEqual(result.matched, ['api.openai.com', 'example.com']);
assert.deepEqual(result.missingFromReceipt, ['missing.example']);
assert.deepEqual(result.receiptOnly, ['receipt-only.example']);
assert.deepEqual(result.cloudAiHosts, ['api.openai.com']);
assert.match(result.verdict, /^REVIEW:/);

const pass = compareHosts(new Set(['example.com']), new Set(['example.com']));
assert.equal(pass.verdict, 'PASS: no uncaptured hosts and no cloud-AI hosts');

// Local capture mode: bare IPs are flagged, loopback is dropped.
assert.equal(normalizeHost('[2606:4700::1]:443'), '2606:4700::1');
assert.equal(isBareIp('93.184.215.14'), true);
assert.equal(isBareIp('2606:4700::1'), true);
assert.equal(isBareIp('example.com'), false);
for (const host of ['127.0.0.1', '127.0.0.9:8090', '[::1]:9', 'localhost', 'kiwix.localhost', '::ffff:127.0.0.1']) {
  assert.equal(isLoopbackHost(host), true, host);
}
for (const host of ['128.0.0.1', 'example.com', '2606:4700::1', '127.example.com']) {
  assert.equal(isLoopbackHost(host), false, host);
}

const localCapture = readNetworkHosts(`
spaceplace.nasa.gov
127.0.0.1
::1
203.0.113.7
2001:db8::5
`);
assert.deepEqual([...localCapture].sort(), ['2001:db8::5', '203.0.113.7', 'spaceplace.nasa.gov']);

const withBareIps = compareHosts(localCapture, new Set(['spaceplace.nasa.gov', '127.0.0.1']));
assert.deepEqual(withBareIps.matched, ['spaceplace.nasa.gov']);
assert.deepEqual(withBareIps.bareIps, ['2001:db8::5', '203.0.113.7']);
assert.deepEqual(withBareIps.missingFromReceipt, []);
assert.deepEqual(withBareIps.receiptOnly, ['127.0.0.1']);
assert.equal(withBareIps.verdict, 'REVIEW: 2 bare IPs in network capture with no hostname (check by hand)');

// A bare IP the receipt itself names is a match, not a flag.
const namedIp = compareHosts(new Set(['203.0.113.7']), new Set(['203.0.113.7']));
assert.deepEqual(namedIp.bareIps, []);
assert.match(namedIp.verdict, /^PASS:/);

// PLAN §12: bare IPs keep their port; dns:<server> is accepted only for the Mac's own nameservers.
assert.equal(captureLabel('203.0.113.7:80'), '203.0.113.7:80');
assert.equal(captureLabel('[2600:1F13::5]:443'), '[2600:1f13::5]:443');
assert.equal(captureLabel('2001:db8::5'), '2001:db8::5', 'old lines without a port still work');
assert.equal(captureLabel('DNS:2001:558:FEED::1'), 'dns:2001:558:feed::1');
assert.equal(captureLabel('Example.com:443'), 'example.com');

const portCapture = readNetworkHosts(`
spaceplace.nasa.gov
[2600:1f13::5]:80
203.0.113.7:443
dns:2001:558:feed::1
dns:2001:558:feed::2
dns:9.9.9.9
dns:127.0.0.1
dns:::1
[::1]:9
`);
assert.deepEqual([...portCapture].sort(), [
  '203.0.113.7:443', '[2600:1f13::5]:80',
  'dns:2001:558:feed::1', 'dns:2001:558:feed::2', 'dns:9.9.9.9',
  'spaceplace.nasa.gov'
].sort(), 'loopback DNS and loopback IP:port dropped');

const nameservers = ['2001:558:feed::1', '[2001:558:FEED::2]', 'fe80::1%en0', '75.75.75.75'];
const dnsResult = compareHosts(portCapture, new Set(['spaceplace.nasa.gov', '203.0.113.7']), { nameservers });
assert.deepEqual(dnsResult.matched, ['203.0.113.7', 'spaceplace.nasa.gov'], 'IP:port matches a receipt IP');
assert.deepEqual(dnsResult.bareIps, ['[2600:1f13::5]:80'], 'port shown for a manual check');
assert.deepEqual(dnsResult.dnsSystem, ['dns:2001:558:feed::1', 'dns:2001:558:feed::2']);
assert.deepEqual(dnsResult.dnsOther, ['dns:9.9.9.9']);
assert.deepEqual(dnsResult.missingFromReceipt, []);
assert.deepEqual(dnsResult.receiptOnly, [], 'dns: lines never count as hosts');
assert.equal(dnsResult.verdict, 'REVIEW: 1 bare IP in network capture with no hostname (check by hand); 1 DNS server in network capture that is not a system nameserver (check by hand)');

const dnsPass = compareHosts(readNetworkHosts('example.com\ndns:75.75.75.75\n'), new Set(['example.com']), { nameservers });
assert.deepEqual(dnsPass.dnsSystem, ['dns:75.75.75.75']);
assert.match(dnsPass.verdict, /^PASS:/, 'system nameserver lookups alone do not cause review');

const noList = compareHosts(readNetworkHosts('dns:75.75.75.75\n'), new Set());
assert.deepEqual(noList.dnsOther, ['dns:75.75.75.75'], 'without --nameservers every dns: line is checked by hand');
assert.match(noList.verdict, /^REVIEW: 1 DNS server/);

assert.deepEqual(parseArgs(['a.txt', '--nameservers', '1.1.1.1, 2001:db8::1', 'b.json']),
  { networkPath: 'a.txt', receiptPath: 'b.json', nameservers: ['1.1.1.1', '2001:db8::1'] });
assert.deepEqual(parseArgs(['a.txt', 'b.json']).nameservers, []);

console.log('audit-compare tests passed');
