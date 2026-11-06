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
const localOnly = receipts.createReceipt({
  id: 'local-ask-1',
  type: 'ask',
  label: 'Ask AI',
  query: 'local question',
  localOnly: true
});

assert.equal(localOnly.entries.length, 0);
assert.equal(localOnly.summary, 'Nothing left this device: answer generated locally');
assert.equal(localOnly.cloudAi.ok, true);

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

receipts.resetForTests();
const askBefore = receipts.createReceipt({ id: 'ask-before-permission', type: 'ask', label: 'Ask AI', query: 'q' });
receipts.addPermissionEntry({ origin: 'https://webcamtests.com', name: 'camera', decision: 'allowed once by you' });
receipts.addPermissionEntry({ origin: 'https://api.openai.com', name: 'location', decision: 'denied by you', embeddedIn: 'https://news.example' });
receipts.addPermissionEntry({ origin: 'Sovereign', name: 'notifications', decision: "denied automatically: Sovereign's own pages need no website permissions" });
const permissionReceipt = receiptById(receipts.PERMISSION_RECEIPT_ID);
assert.equal(permissionReceipt.type, 'permissions');
assert.equal(permissionReceipt.label, 'Website permissions');
assert.equal(permissionReceipt.entries.length, 3);
assert.ok(permissionReceipt.entries.every(entry => entry.category === 'permission' && entry.method === 'PERMISSION'));
assert.deepEqual(permissionReceipt.entries.map(entry => entry.host), ['webcamtests.com', 'api.openai.com', 'sovereign']);
assert.equal(permissionReceipt.entries[0].whatWasSent, 'Permission request: camera – allowed once by you');
assert.match(permissionReceipt.entries[1].whatWasSent, /\(embedded in https:\/\/news\.example\)$/);
assert.equal(permissionReceipt.summary, 'Website permission requests: 3 (1 allowed)');
assert.equal(permissionReceipt.cloudAi.ok, true, 'a permission request from a cloud-AI site is not a cloud-AI call');
assert.equal(receiptById(askBefore.id).entries.length, 0, 'permission entries never land in other receipts');
assert.equal(receipts.getReceipts().filter(receipt => receipt.type === 'permissions').length, 1, 'one permissions receipt per run');

console.log('privacy-receipt tests passed');
