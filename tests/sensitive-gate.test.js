const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/main'), 'utf8');
function body(name, text = source) {
 let start = text.indexOf(`function ${name}(`);
 assert.ok(start >= 0, name);
 if (text.slice(start - 6, start) === 'async ') start -= 6;
 return text.slice(start, text.indexOf('\n}', start) + 2);
}
async function main() {
 const askSource = fs.readFileSync(require.resolve('../src/ask'), 'utf8');
 const searchSource = fs.readFileSync(require.resolve('../src/search'), 'utf8');
 const before = (text, first, second, id) => assert.ok(text.indexOf(first) >= 0 && text.indexOf(first) < text.indexOf(second), id);
 before(body('handleSearchQuery'), 'crisis', 'refuseWebWhileOffline', 'G14');
 before(body('handleMediaSearch'), 'crisis', 'refuseWebWhileOffline', 'G15');
 before(body('runSearch', searchSource), 'classifyQuestion', 'networkOffline', 'G16');
 before(body('submitQuestion', askSource), 'crisis', "item.status === 'extracting'", 'G17');
 before(body('runInlineMediaSearch', askSource), 'crisis', 'networkOffline', 'G18');
 before(body('retryLast', askSource), 'crisis', 'needsReprocess', 'G19');
 before(body('handleReadSources'), 'crisis', 'refuseWebWhileOffline', 'G20');
 const receipts = require('../src/privacy-receipt'); receipts.resetForTests();
 let calls = 0, sent = '', activity = [], offline = false;
 const context = vm.createContext({
  sensitiveGuard: require('../src/sensitive-guard'), privacySettings: { sensitiveTopics: 'strict' },
  privacyReceipts: receipts, searchSettings: { endpoint: 'http://localhost:8080/' },
  assignPrivacyReceiptToSender() {}, findTabBySender: () => ({ tab: { kind: 'ask' } }),
  datasetWindow: null, activeSearchRequests: new Map(), allowedSearchRequests: new Map(),
  rememberAllowedSearch() {}, normalizeSearxngEndpoint: value => value,
  refuseWebWhileOffline() { if (offline) throw new Error('G11'); }, AbortController, URL,
  requestActivityEntry: value => value, pushSearchActivity: value => activity.push(value),
  searchActivityEvents: [], makeReceiptFetch() {}, recordSearxngForwardingSafely() {},
  searchSearxng: async input => { calls++; sent = input.query; return { query: sent, results: [] }; }
 });
 vm.runInContext([body('sensitiveGate'), body('handleSearchQuery')].join('\n'), context);
 const event = { sender: { id: 7 } };
 const marker = 'SECRETQ-7731';
 const run = (query, extra = {}) => context.handleSearchQuery(event, { query, requestId: 'gate-' + Math.random(), ...extra });
 const refusal = await run('I have a fever ' + marker);
 assert.ok(refusal.sensitive && calls === 0, 'G1');
 assert.ok(!JSON.stringify([activity, receipts.exportPayload()]).includes(marker), 'G2');
 await run('I have a fever call 415-555-0134', { override: true });
 assert.ok(calls === 1 && sent === 'I have a fever call', 'G3');
 await run('I want to kill myself', { override: true });
 assert.ok(calls === 1, 'G4');
 const strict = await run('symptoms of type 2 diabetes', { strictness: 'standard' });
 assert.ok(strict.sensitive && calls === 1, 'G5');
 offline = true;
 const crisis = await run('I want to kill myself ' + marker);
 assert.ok(crisis.sensitive && crisis.level === 'crisis' && calls === 1, 'G11');
 vm.runInContext(body('handleMediaSearch'), context);
 const mediaCrisis = await context.handleMediaSearch(event, { query: 'I want to kill myself ' + marker, requestId: 'media-crisis' });
 assert.ok(mediaCrisis.sensitive && mediaCrisis.level === 'crisis' && calls === 1, 'G12');
 assert.ok(!JSON.stringify(receipts.exportPayload()).includes(marker), 'G13');
 offline = false;
 // Source grants are sender-scoped, URL-scoped, expiring and consumed.
 let reads = 0;
 context.privacyReceiptIdForSender = () => '';
 context.readSourcePages = async () => { reads++; return { sources: [] }; };
 vm.runInContext(body('handleReadSources'), context);
 const sourceInput = { requestId:'source', question:'fixture', results:[{url:'https://example.test/source'}] };
 const blockedRead = async id => {
  let blocked = false; try { await context.handleReadSources(event, sourceInput); } catch { blocked = true; }
  assert.ok(blocked && reads === 0, id);
 };
 await blockedRead('G6');
 context.allowedSearchRequests.set('source', {senderId:8, expires:Date.now()+10000, urls:new Set(['https://example.test/source'])});
 await blockedRead('G7');
 context.allowedSearchRequests.set('source', {senderId:7, expires:0, urls:new Set(['https://example.test/source'])});
 await blockedRead('G8');
 context.allowedSearchRequests.set('source', {senderId:7, expires:Date.now()+10000, urls:new Set(['https://example.test/other'])});
 await blockedRead('G9');
 context.allowedSearchRequests.set('source', {senderId:7, expires:Date.now()+10000, urls:new Set(['https://example.test/source'])});
 await context.handleReadSources(event, sourceInput);
 assert.ok(reads === 1 && !context.allowedSearchRequests.has('source'), 'G10');
 // Exercise the production Strict check without loading a model or any network.
 let modelCalls=0, stops=0, modelOutput='medical', hang=false;
 const modelContext = vm.createContext({
  privacySettings:{sensitiveTopics:'strict'}, engineLoaded:false, sensitiveModelPending:null,
  window:{SovereignSensitiveGuard:require('../src/sensitive-guard')},
  setTimeout: (callback, ms) => { assert.ok(ms === 4000, 'M7'); if (hang) { queueMicrotask(callback); return null; } return setTimeout(callback, ms); }, clearTimeout,
  getEngineApi:()=>({summarize:async (_messages,chunk)=>{modelCalls++; if(hang) return new Promise(()=>{}); chunk(modelOutput);}, stop:async()=>{stops++;}})
 });
 vm.runInContext(body('strictModelFlag', fs.readFileSync(require.resolve('../src/ask'),'utf8')), modelContext);
 assert.ok(await modelContext.strictModelFlag('fixture') === '' && modelCalls === 0, 'M1');
 modelContext.engineLoaded=true;
 assert.ok(await modelContext.strictModelFlag('fixture') === 'medical' && modelCalls === 1, 'M2');
 modelContext.privacySettings.sensitiveTopics='standard';
 assert.ok(await modelContext.strictModelFlag('fixture') === '' && modelCalls === 1, 'M3');
 modelContext.privacySettings.sensitiveTopics='strict'; modelOutput='crisis';
 assert.ok(await modelContext.strictModelFlag('fixture') === '', 'M4');
 modelOutput='medical explanation'; assert.ok(await modelContext.strictModelFlag('fixture') === '', 'M5');
 hang=true; assert.ok(await modelContext.strictModelFlag('fixture') === '' && stops >= 1, 'M6');
 console.log('sensitive-gate tests passed');
}
main().catch(error => { console.error(/^[GM]\d+$/.test(error.message) ? error.message : 'sensitive-gate failed'); process.exitCode = 1; });
