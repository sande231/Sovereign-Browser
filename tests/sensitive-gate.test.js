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
 // Task 1c: every crisis gate handles harm, even offline and with override.
 for (const isOffline of [false, true]) {
  offline = isOffline;
  for (const query of ['I want to hurt someone', 'I want to kill myself']) {
   const previous = calls;
   const result = await run(query, { override: true });
   assert.ok(result.level === 'crisis' && calls === previous, 'G14');
   assert.ok((await context.handleMediaSearch(event, {query, override:true})).level === 'crisis' && calls === previous, 'G15');
   vm.runInContext(body('handleReadSources'), context);
   assert.ok((await context.handleReadSources(event, {question:query, override:true})).level === 'crisis', 'G20');
  }
 }
 offline = false;
 const previous = calls;
 await run('my husband hits me, call me at 415-555-0134', {override:true});
 assert.ok(calls === previous + 1 && !sent.includes('415') && sent.includes('hits me'), 'G21');
 await run('my husband hits me '+marker);
 assert.ok(!JSON.stringify([activity, receipts.exportPayload()]).includes(marker), 'G22');
 const uiSource = fs.readFileSync(require.resolve('../src/sensitive-ui'), 'utf8');
 assert.ok(uiSource.includes('crisisReply') && uiSource.includes("level === 'crisis'"), 'G23');
 const guard = require('../src/sensitive-guard');
 for (const [id, text] of [['G16',searchSource],['G17',askSource],['G18',askSource],['G19',askSource]]) {
  assert.ok(guard.classifyQuestion('I want to hurt someone').level === 'crisis' && text.includes('classifyQuestion'), id);
 }
 // Execute the actual IPC save handler with a fake disk; inspect booleans only.
 let saveHandler, writes = 0;
 const saveContext = vm.createContext({ sensitiveGuard:guard, chatSenderTab(){}, aiSettings:{saveChatsOnDevice:true},
  chatStore:()=>({save(){writes++;}}), broadcastSavedChats:()=>({chats:[]}), pendingChatConsents:new Map(),
  ipcMain:{handle(_name, handler){saveHandler=handler;}} });
 vm.runInContext(source.slice(source.indexOf("ipcMain.handle('chats:save'"), source.indexOf("ipcMain.handle('chats:delete'")), saveContext);
 for (const content of ['I want to kill myself','I want to hurt someone','my husband hits me']) {
  const result = saveHandler(event,{id:'consent-fixture',messages:[{role:'user',content}]});
  assert.ok(result?.needsConsent === true && writes === 0, 'G24');
 }
 for (const content of [guard.CRISIS_REPLY,guard.HARM_REPLY]) assert.ok(saveHandler(event,{id:'consent-fixture',messages:[{role:'assistant',content}]}).needsConsent && writes === 0,'G25');
 saveHandler(event,{id:'consent-fixture',saveConsent:true,messages:[{role:'user',content:'my husband hits me'}]});
 assert.ok(writes === 1,'G26');
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
 // Run the editor itself with a small local DOM fixture, including recovery.
 class Element {
  constructor(tag) { this.tag=tag; this.style={}; this.children=[]; this.events={}; this.textContent=''; this.value=''; this.disabled=false; }
  append(...children) { this.children.push(...children); }
  setAttribute() {} focus() {} remove() {}
  addEventListener(name, callback) { this.events[name]=callback; }
  querySelector(selector) { return this.children.find(child=>child.className?.split(' ').includes(selector.slice(1))) || this.children.map(child=>child.querySelector(selector)).find(Boolean); }
 }
 for (const ask of [false,true]) {
  let sends=0, crises=0;
  const window={SovereignSensitiveGuard:guard};
  vm.runInNewContext(uiSource,{window,document:{createElement:tag=>new Element(tag)}});
  const container=new Element('div');
  window.SovereignSensitiveUI.render(container,{question:'my husband hits me',result:guard.classifyQuestion('my husband hits me'),send(){sends++;},...(ask?{onCrisis(){crises++;}}:{})});
  container.querySelector('.sensitive-anyway').events.click();
  const input=container.querySelector('.sensitive-query'), preview=container.querySelector('.sensitive-preview'), send=container.querySelector('.sensitive-send');
  for (const [question,reply] of [['I want to kill myself',guard.CRISIS_REPLY],['I want to hurt someone',guard.HARM_REPLY],['I want to kill myself and my ex',guard.CRISIS_REPLY]]) {
   input.value=question; input.events.input(); send.events.click();
   assert.ok(preview.textContent===reply && send.disabled && sends===0, 'G27');
  }
  input.value='ordinary fixture'; input.events.input();
  assert.ok(preview.textContent==='ordinary fixture' && send.disabled===ask && (ask ? crises>0 : crises===0), 'G28');
 }
 // Main owns pending choices after the renderer closes. No disk or sockets here.
 const {EventEmitter}=require('node:events');
 const handlers={}, pending=new Map(); let removed=[], deletedReceipts=0;
 const owner=new EventEmitter(); owner.id=101;
 const lifecycle=vm.createContext({pendingChatConsents:pending,consentWatchers:new WeakSet(),
  chatSenderTab(){}, chatStore:()=>({remove(id){removed.push(id);}}), privacyReceipts:{deleteReceipts(){deletedReceipts++;}}, broadcastSavedChats(){},
  ipcMain:{handle(name,fn){handlers[name]=fn;}}});
 vm.runInContext(body('discardPendingChat')+'\n'+source.slice(source.indexOf("ipcMain.handle('chats:pending-consent'"),source.indexOf('let legacyRemovalsInFlight')),lifecycle);
 handlers['chats:pending-consent']({sender:owner},'pending-fixture');
 owner.emit('destroyed');
 assert.ok(removed.includes('pending-fixture') && deletedReceipts===1 && pending.size===0,'G29');
 const other=new EventEmitter(); other.id=102;
 handlers['chats:pending-consent']({sender:other},'pending-reload');
 other.emit('did-start-navigation',{},'sovereign://ask/',false,true);
 assert.ok(removed.includes('pending-reload') && pending.size===0,'G30');
 const consentSource=body('renderSaveConsent',askSource);
 assert.ok(consentSource.includes("Save this chat? Anyone using this computer could see it.") && consentSource.includes(" Don't save will also remove the earlier part of this chat from this device."),'G31');
 before(body('answerQuestion',askSource), 'requireSaveConsent(classification)', 'ensureModelReady', 'G32');
 assert.ok(body('newChat',askSource).includes('declineChatSave') && source.includes('for (const id of pendingChatConsents.keys()) discardPendingChat(id)'), 'G33');
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
 for (const category of ['self-harm','harm-to-others','abuse']) { modelOutput=category; assert.ok(await modelContext.strictModelFlag('fixture') === '', 'M8'); }
 hang=true; assert.ok(await modelContext.strictModelFlag('fixture') === '' && stops >= 1, 'M6');
 console.log('sensitive-gate tests passed');
}
main().catch(error => { console.error(/^[GM]\d+$/.test(error.message) ? error.message : 'G0'); process.exitCode = 1; });
