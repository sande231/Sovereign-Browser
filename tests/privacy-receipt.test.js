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

// SearXNG forwarding disclosure.
receipts.resetForTests();
const webSearch = receipts.createReceipt({ id: 'fwd-search', type: 'search', label: 'Search', query: 'history of tea' });
receipts.addEntry(webSearch.id, {
  category: 'search',
  method: 'GET',
  url: 'http://127.0.0.1:8080/search?q=history+of+tea&format=json',
  whatWasSent: 'Search query: history of tea'
});
assert.equal(receiptById(webSearch.id).summary,
  'Query sent to 127.0.0.1:8080 (SearXNG), which forwarded it to upstream search engines (names not reported)',
  'before SearXNG answers, the receipt still says the query is forwarded');
receipts.recordSearxngForwarding(webSearch.id, {
  url: 'http://127.0.0.1:8080/search',
  engines: ['startpage', 'duckduckgo', 'bing', 'duckduckgo']
});
assert.equal(receiptById(webSearch.id).summary,
  'Query sent to 127.0.0.1:8080 (SearXNG), which forwarded it to: bing, duckduckgo, startpage');
assert.equal(receiptById(webSearch.id).entries.length, 1, 'no new rows: the existing SearXNG row is annotated');
assert.equal(receiptById(webSearch.id).entries[0].whatWasSent,
  'Search query: history of tea – SearXNG forwarded it to: bing, duckduckgo, startpage (engines SearXNG reported; engines that returned nothing are not listed)');
assert.deepEqual(receiptById(webSearch.id).forwarding, { '127.0.0.1:8080': ['bing', 'duckduckgo', 'startpage'] });

// A second query in the same receipt (for example after Retry) combines the names.
receipts.addEntry(webSearch.id, { category: 'search', method: 'GET', url: 'http://127.0.0.1:8080/search?q=tea', whatWasSent: 'Search query: tea' });
receipts.recordSearxngForwarding(webSearch.id, { url: 'http://127.0.0.1:8080/search', engines: ['wikipedia'] });
assert.equal(receiptById(webSearch.id).summary,
  'Query sent to 127.0.0.1:8080 (SearXNG), which forwarded it to: bing, duckduckgo, startpage, wikipedia');
assert.match(receiptById(webSearch.id).entries[1].whatWasSent, /^Search query: tea – SearXNG forwarded it to: wikipedia \(/);
assert.equal(receiptById(webSearch.id).entries[0].whatWasSent.match(/forwarded it to/g).length, 1, 'each row is annotated once');

// Empty engine list: plain fallback wording, in summary and row.
const emptyList = receipts.createReceipt({ id: 'fwd-empty', type: 'ask', label: 'Ask AI web retrieval', query: 'q' });
receipts.addEntry(emptyList.id, { category: 'search', method: 'GET', url: 'http://192.168.1.10:8080/search?q=q', whatWasSent: 'Search query: q' });
receipts.recordSearxngForwarding(emptyList.id, { url: 'http://192.168.1.10:8080/search', engines: [] });
assert.equal(receiptById(emptyList.id).summary,
  'Query sent to 192.168.1.10:8080 (SearXNG), which forwarded it to upstream search engines (names not reported) · AI generated locally');
assert.equal(receiptById(emptyList.id).entries[0].whatWasSent,
  'Search query: q – SearXNG forwarded it to upstream search engines (names not reported)');

// Image search: the SearXNG query is a search entry; image hosts stay separate.
const imageSearch = receipts.createReceipt({ id: 'fwd-images', type: 'ask', label: 'Media image retrieval', query: 'Mount Everest' });
receipts.addEntry(imageSearch.id, { category: 'search', method: 'GET', url: 'http://127.0.0.1:8080/search?q=Mount+Everest&categories=images', whatWasSent: 'Image search query: Mount Everest' });
receipts.addEntry(imageSearch.id, { category: 'image', method: 'HEAD', url: 'https://upload.wikimedia.org/e.jpg', whatWasSent: 'media validation request' });
receipts.recordSearxngForwarding(imageSearch.id, { url: 'http://127.0.0.1:8080/search', engines: ['flickr', 'duckduckgo images', 'pexels'] });
assert.equal(receiptById(imageSearch.id).summary,
  'Query sent to 127.0.0.1:8080 (SearXNG), which forwarded it to: duckduckgo images, flickr, pexels · Image/media hosts contacted: upload.wikimedia.org · AI generated locally');

// Long lists are shortened in the text; engine names never count as cloud AI hosts.
const longList = receipts.createReceipt({ id: 'fwd-long', type: 'search', label: 'Search', query: 'q' });
receipts.addEntry(longList.id, { category: 'search', method: 'GET', url: 'http://127.0.0.1:8080/search?q=q', whatWasSent: 'Search query: q' });
receipts.recordSearxngForwarding(longList.id, {
  url: 'http://127.0.0.1:8080/search',
  engines: [...Array.from({ length: 30 }, (_, index) => `engine-${String(index).padStart(2, '0')}`), 'api.openai.com']
});
assert.match(receiptById(longList.id).summary, /: api.openai.com, engine-00, .*, engine-23 and 6 more$/);
assert.equal(receiptById(longList.id).cloudAi.ok, true);

// Unknown receipt ids and junk input are ignored without throwing.
assert.equal(receipts.recordSearxngForwarding('no-such-receipt', { url: 'http://127.0.0.1:8080/search', engines: ['bing'] }), null);
assert.doesNotThrow(() => receipts.recordSearxngForwarding(webSearch.id, { url: 'not a url', engines: 'bing' }));

// Local-only answers are unaffected.
const localStill = receipts.createReceipt({ id: 'fwd-local', type: 'ask', label: 'Ask AI', query: 'q', localOnly: true });
assert.equal(receiptById(localStill.id).summary, 'Nothing left this device: answer generated locally');

console.log('privacy-receipt tests passed');
