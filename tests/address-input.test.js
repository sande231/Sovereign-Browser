const assert = require('node:assert/strict');
const { classifyAddressInput, looksLikeHostAddress } = require('../src/address-input');

const urls = [
  ['example.com', 'https://example.com/'],
  ['example.com:8080', 'https://example.com:8080/'],
  ['example.com:8080/path?q=1#x', 'https://example.com:8080/path?q=1#x'],
  ['example.com?q=1', 'https://example.com/?q=1'],
  ['wikipedia.org', 'https://wikipedia.org/'],
  ['sub.domain.co.uk/page', 'https://sub.domain.co.uk/page'],
  ['xn--bcher-kva.example', 'https://xn--bcher-kva.example/'],
  ['localhost', 'http://localhost/'],
  ['localhost:3000', 'http://localhost:3000/'],
  ['LOCALHOST:3000/api', 'http://localhost:3000/api'],
  ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
  ['192.168.1.1', 'http://192.168.1.1/'],
  ['[::1]:3000', 'http://[::1]:3000/'],
  ['https://example.com', 'https://example.com/'],
  ['HTTPS://Example.com/Path', 'https://example.com/Path'],
  ['http://localhost:3000/a b', 'http://localhost:3000/a%20b'],
  ['  https://example.com/x  ', 'https://example.com/x']
];
for (const [input, url] of urls) {
  const result = classifyAddressInput(input);
  assert.notEqual(result.kind, 'search', input);
  assert.deepEqual(result, { kind: 'url', url }, input);
}
const searches = [
  ...['Python: list comprehension', 'Note:buy milk', 'C++: templates', 're:invent',
    'foo:bar', 'what is example.com', '3.11.2', 'e.g.', 'user@example.com', 'hello']
    .map(input => [input, input]),
  ['history   of tea', 'history of tea'],
  ['?example.com', 'example.com'],
  ['word '.repeat(80), 'word '.repeat(80).trim().slice(0, 300)]
];
for (const [input, question] of searches) {
  assert.deepEqual(classifyAddressInput(input), { kind: 'search', question, mode: 'search' }, input);
}
for (const input of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)',
  'mailto:a@example.com', 'view-source:example.com',
  ...['about', 'blob', 'chrome', 'chrome-extension', 'data', 'devtools', 'ftp', 'intent',
    'magnet', 'sms', 'tel', 'ws', 'wss'].map(scheme => `${scheme}:example`),
  'custom://example', 'JAVASCRIPT:alert(1)']) {
  assert.deepEqual(classifyAddressInput(input), {
    kind: 'error', error: 'Sovereign only opens http and https websites.'
  }, input);
}
for (const input of ['https://', 'localhost:99999', '999.1.1.1']) {
  const result = classifyAddressInput(input);
  assert.equal(result.kind, 'error', input);
  assert.ok(result.error, input);
}
for (const input of ['', '   ', '?', '?   ']) {
  assert.deepEqual(classifyAddressInput(input), {
    kind: 'error', error: 'Enter a website address or search question.'
  }, input);
}
assert.deepEqual(classifyAddressInput('sovereign://settings'), {
  kind: 'internal', url: 'sovereign://settings/'
});
for (const input of ['Python:', '3.11.2', 'user@example.com']) {
  assert.equal(looksLikeHostAddress(input), false, input);
}
console.log('Address input tests passed.');
