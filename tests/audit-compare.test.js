const assert = require('node:assert/strict');
const {
  compareHosts,
  hostMatchesCloudAi,
  normalizeHost,
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

console.log('audit-compare tests passed');
