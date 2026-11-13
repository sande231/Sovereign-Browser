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

receipts.resetForTests();
receipts.setOffline(true);
const offline = receipts.createReceipt({ id: 'offline-test', type: 'ask' });
assert.match(offline.summary, /^Offline: 0 external requests/);
for (let i = 0; i < 3; i++) receipts.addEntry(offline.id, { category: 'blocked', url: 'https://example.com/search?q=SECRET123', resourceType: 'xhr', whatWasSent: 'SECRET123' });
let blocked = receiptById(offline.id);
assert.match(blocked.summary, /· 3 blocked \(offline mode\)/);
assert.equal(blocked.entries.length, 1);
assert.equal(blocked.entries[0].count, 3);
assert.equal(blocked.entries[0].url, 'https://example.com');
assert(!JSON.stringify(receipts.getReceipts()).includes('SECRET123'));
assert(!JSON.stringify(receipts.exportPayload()).includes('SECRET123'));
receipts.addEntry(offline.id, { category: 'other', url: 'https://example.org/' });
assert.match(receiptById(offline.id).summary, /^Offline: 1 external request ·/);
receipts.setOffline(false);
assert.equal(receiptById(offline.id).offline, false);

// Both trim paths count omitted rows, not aggregated attempts.
for (const category of ['other', 'blocked']) {
  const capped = receipts.createReceipt({ id: `capped-${category}` });
  assert.equal(capped.droppedEntries, 0);
  for (let i = 0; i < 125; i++) {
    receipts.addEntry(capped.id, { category, url: `https://host-${i}.example/`, resourceType: 'xhr' });
  }
  assert.equal(receiptById(capped.id).entries.length, 120);
  assert.equal(receiptById(capped.id).droppedEntries, 5);
  assert.equal(receipts.exportPayload().receipts.find(r => r.id === capped.id).droppedEntries, 5);
  if (category === 'blocked') {
    receipts.addEntry(capped.id, { category, url: 'https://host-124.example/', resourceType: 'xhr' });
    assert.equal(receiptById(capped.id).droppedEntries, 5);
  }
}
console.log('privacy-receipt tests passed');

// Sensitive entries never trust caller-provided request text or URL paths.
{
 const store = require('../src/privacy-receipt');
 store.resetForTests();
 const marker = 'SECRETQ-7731';
 const r = store.createReceipt({ id: 'sensitive-test', query: '', chatId: 'chat-a' });
 store.addEntry(r.id, { category: 'sensitive', topic: 'medical', url: 'http://localhost/?q=' + marker, whatWasSent: marker });
 assert.ok(!JSON.stringify(store.getReceipts()).includes(marker), 'S1');
 assert.ok(!JSON.stringify(store.exportPayload()).includes(marker), 'S2');
 assert.equal(store.getReceipt(r.id).entries[0].whatWasSent, 'blocked (sensitive topic: medical) – nothing sent');
 assert.ok(store.getReceipt(r.id).summary.startsWith('Not sent: sensitive topic (medical)'));
 store.createReceipt({ id: 'keep' });
 store.createReceipt({ id: 'override', sensitiveOverride: true });
 store.deleteReceipts(r => r.chatId === 'chat-a' || r.sensitiveOverride);
 assert.deepEqual(store.getReceipts().map(r => r.id), ['keep']);
 const background = store.getOrCreateBackgroundReceipt().id;
 store.setOffline(true);
 const offline = store.addOfflineBlockedEntry({ url: 'https://example.test' }).id;
 store.deleteReceipts(r => r.id === background || r.id === offline);
 assert.ok(store.getOrCreateBackgroundReceipt());
 assert.ok(store.addOfflineBlockedEntry({ url: 'https://example.test' }));
 assert.equal(store.getReceipts().length, 3);
 store.resetForTests();
}

{
 receipts.resetForTests();
 const crisis = receipts.createReceipt({id:'harm-fixture',crisis:true});
 if (receipts.getReceipt(crisis.id).summary !== 'Nothing left this device: support information shown') { console.error('P1'); process.exit(1); }
 const abuse = receipts.createReceipt({id:'abuse-fixture'});
 receipts.addEntry(abuse.id,{category:'sensitive',topic:'abuse or domestic violence',url:'https://example.test/?q=SECRETQ-7731',whatWasSent:'SECRETQ-7731'});
 if (JSON.stringify([receipts.getReceipts(),receipts.exportPayload()]).includes('SECRETQ-7731')) { console.error('P2'); process.exit(1); }
}
