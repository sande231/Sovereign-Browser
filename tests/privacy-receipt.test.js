const assert = require('node:assert/strict');
const receipts = require('../src/privacy-receipt');

function receiptById(id) {
  return receipts.getReceipts().find(receipt => receipt.id === id);
}

receipts.resetForTests();

const search = receipts.createReceipt({
  id: 'search-1',
  type: 'search',
  label: 'Search',
  query: 'alpha question'
});
const ask = receipts.createReceipt({
  id: 'ask-1',
  type: 'ask',
  label: 'Ask AI',
  query: 'beta question'
});

receipts.addEntry(search.id, {
  category: 'search',
  method: 'GET',
  url: 'http://127.0.0.1:8080/search?q=alpha',
  whatWasSent: 'Search query: alpha question'
});
receipts.addEntry(ask.id, {
  category: 'source-page',
  method: 'GET',
  url: 'https://example.org/source',
  whatWasSent: 'page fetch - no query or AI output sent'
});
receipts.addEntry(ask.id, {
  category: 'image',
  method: 'HEAD',
  url: 'https://images.example/photo.jpg',
  whatWasSent: 'media validation request - no query, prompt, or AI output sent'
});

assert.equal(receiptById(search.id).entries.length, 1);
assert.equal(receiptById(ask.id).entries.length, 2);
assert.equal(receiptById(search.id).entries[0].host, '127.0.0.1:8080');
assert.equal(receiptById(ask.id).entries[0].category, 'source-page');
assert.equal(receiptById(ask.id).entries[1].category, 'image');

receipts.addEntry(ask.id, {
  category: 'other',
  method: 'POST',
  url: 'https://api.openai.com/v1/responses',
  whatWasSent: 'test request metadata only'
});
assert.equal(receiptById(ask.id).cloudAi.ok, false);
assert.deepEqual(receiptById(ask.id).cloudAi.hosts, ['api.openai.com']);

receipts.addEntry(search.id, {
  category: 'unexpected-category',
  method: 'GET',
  url: 'https://unknown.example/resource',
  whatWasSent: 'trusted app/AI request - no body logged'
});
const unknownEntry = receiptById(search.id).entries.at(-1);
assert.equal(unknownEntry.category, 'other');
assert.equal(unknownEntry.host, 'unknown.example');

const background = receipts.addBackgroundEntry({
  category: 'model-download',
  method: 'GET',
  url: 'https://model-cdn.example/file.bin',
  whatWasSent: 'model/runtime file request - no page content, prompt, or AI output sent'
});
assert.equal(background.type, 'background');
assert.match(background.summary, /Background/);
assert.equal(background.entries.at(-1).category, 'model-download');

for (let index = 0; index < 25; index += 1) {
  receipts.createReceipt({
    id: `limit-${index}`,
    type: 'search',
    query: `query ${index}`
  });
}

const allReceipts = receipts.getReceipts();
assert.equal(allReceipts.length, 20);
assert.equal(Boolean(receiptById('limit-24')), true);
assert.equal(Boolean(receiptById('search-1')), false);

const payload = receipts.exportPayload({ appVersion: 'test-version' });
assert.equal(payload.appVersion, 'test-version');
assert.equal(Array.isArray(payload.cloudAiHosts), true);
assert.equal(payload.receipts.length, 20);
assert.equal(payload.ignoredSchemes.includes('sovereign:'), true);

console.log('privacy-receipt tests passed');
